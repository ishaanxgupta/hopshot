// Hopshot shared player physics. Pure ESM, deterministic, allocation-free in the hot path.
// The server (authority) and the browser (prediction + reconciliation replay) run the exact
// same stepPlayer, so every value that influences a future step lives in the state object.
//
// Determinism / serialisation choice:
//   At the end of every stepPlayer all float fields (x y z vx vy vz) are rounded to float32
//   with Math.fround, and every other field is a small integer or boolean. writeState stores
//   floats as float32, so write -> read is EXACT and a client that rewinds to a server state and
//   replays the same cmds lands on bit-identical results (same JS engine maths assumed; the
//   per-step float32 rounding also absorbs most last-bit libm differences between engines).
//   World boxes are rounded to float32 too, so resting on a box top is an exact float32 value.
//
// Collision: the player is an AABB (PLAYER.halfWidth, height / crouchHeight) swept one axis at a
// time against world AABBs (continuous per-axis sweeps: no tunnelling at any speed, and no
// catching on seams between coplanar boxes because faces that only touch never block).
// Boxes come from a uniform XZ grid; each step gathers the nearby boxes once into a scratch list.
//
// Movement (see MOVE below): Quake-style ground/air acceleration, auto-hop while jump is held,
// crouch-slide with a one-time boost. Slide-hop from the player's side: run, jump, release crouch
// in the air, press crouch just before landing -> you land into a boosted slide; press (or keep
// holding) jump right away to hop out with the momentum. Repeat to build speed up to MOVE.maxSpeed.

import { DT, PLAYER, BTN } from './constants.js';

export const MOVE = {
  runSpeed: 7.0,               // m/s, standing ground wish speed (x the caller's speedMult argument)
  crouchSpeed: 3.5,            // m/s, crouch-walk wish speed
  groundAccel: 12,             // Quake accel factor (1/s): reaches run speed in ~0.1 s
  groundFriction: 10,          // 1/s, strong ground friction (also bleeds off excess speed fast)
  stopSpeed: 2.5,              // m/s, friction acts as if at least this fast -> crisp full stop
  gravity: 25,                 // m/s^2
  jumpSpeed: 8.0,              // m/s initial vertical speed -> apex 1.28 m, 0.64 s airtime
  maxFallSpeed: 40,            // m/s terminal fall speed
  airAccel: 12,                // Quake air accel factor (1/s)
  airWishCap: 0.6,             // m/s, air wish-speed cap: strafing bends and slightly gains speed
  airControlAccel: 4,          // accel factor (1/s) for air control BELOW run speed: lets you get
                               // moving while hopping from a standstill; never exceeds run speed
  maxSpeed: 17,                // m/s, hard horizontal speed cap (ground, slide and air)
  slideMinSpeed: 5.0,          // m/s, horizontal speed needed to start a slide
  slideStopSpeed: 4.0,         // m/s, a slide below this turns into a crouch-walk
  slideBoost: 1.25,            // one-time horizontal speed multiplier when a slide starts
  slideBoostCooldownTicks: 90, // 1.5 s before a slide can boost again on the ground (<= 255)
  slideLandGraceTicks: 6,      // 0.1 s after landing in which a jump-armed boost is still valid
  slideFrictionStart: 0.25,    // 1/s, slide friction right after the boost
  slideFrictionEnd: 3.0,       // 1/s, slide friction once the ramp is over
  slideRampTicks: 48,          // 0.8 s friction ramp from start to end (counted from the boost)
  slideSteerAccel: 2.0,        // Quake accel factor for steering while sliding (turn only, no gain)
  stepHeight: 0.35,            // m, ledges up to this are stepped onto (and snapped down from)
  crouchTicks: 6,              // 0.1 s eye-height transition between standing and crouched
};

// Internal tolerances (not tunables).
const EPS = 1e-4;            // contact tolerance: overlaps thinner than this are "touching"
const GROUND_PROBE = 0.01;   // m, airborne ground snap distance
const CELL = 4;              // m, spatial grid cell size (XZ)

// ---------------------------------------------------------------------------------------------
// World

export function createWorld(map) {
  const src = (map && map.boxes) || [];
  const n = src.length;
  const boxes = new Float32Array(n * 6);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const b = src[i], o = i * 6;
    for (let a = 0; a < 3; a++) {
      const lo = Math.min(b.min[a], b.max[a]), hi = Math.max(b.min[a], b.max[a]);
      boxes[o + a] = lo; boxes[o + 3 + a] = hi;
    }
    minX = Math.min(minX, boxes[o]); maxX = Math.max(maxX, boxes[o + 3]);
    minZ = Math.min(minZ, boxes[o + 2]); maxZ = Math.max(maxZ, boxes[o + 5]);
  }
  if (map && map.bounds) {
    minX = Math.min(minX, map.bounds.min[0]); maxX = Math.max(maxX, map.bounds.max[0]);
    minZ = Math.min(minZ, map.bounds.min[2]); maxZ = Math.max(maxZ, map.bounds.max[2]);
  }
  if (!(minX <= maxX)) { minX = minZ = -1; maxX = maxZ = 1; }
  const gx0 = Math.floor(minX) - 1, gz0 = Math.floor(minZ) - 1;
  const nx = Math.max(1, Math.ceil((maxX + 1 - gx0) / CELL));
  const nz = Math.max(1, Math.ceil((maxZ + 1 - gz0) / CELL));

  const cellStart = new Int32Array(nx * nz + 1);
  const range = (b, o) => {
    const cx0 = clampI(Math.floor((b[o] - gx0) / CELL), 0, nx - 1);
    const cx1 = clampI(Math.floor((b[o + 3] - gx0) / CELL), 0, nx - 1);
    const cz0 = clampI(Math.floor((b[o + 2] - gz0) / CELL), 0, nz - 1);
    const cz1 = clampI(Math.floor((b[o + 5] - gz0) / CELL), 0, nz - 1);
    return [cx0, cx1, cz0, cz1];
  };
  for (let i = 0; i < n; i++) {
    const [cx0, cx1, cz0, cz1] = range(boxes, i * 6);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) cellStart[cz * nx + cx + 1]++;
  }
  for (let c = 0; c < nx * nz; c++) cellStart[c + 1] += cellStart[c];
  const cellItems = new Int32Array(cellStart[nx * nz]);
  const fill = cellStart.slice(0, nx * nz);
  for (let i = 0; i < n; i++) {
    const [cx0, cx1, cz0, cz1] = range(boxes, i * 6);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) cellItems[fill[cz * nx + cx]++] = i;
  }

  return {
    boxCount: n,
    boxes,                       // Float32Array [minx miny minz maxx maxy maxz] * n
    gx0, gz0, nx, nz, cell: CELL,
    cellStart, cellItems,
    stamp: new Uint32Array(n),   // dedupe marks for multi-cell boxes
    stampId: 0,
    cb: new Float64Array(n * 6), // gathered candidate boxes for the current step
    nCand: 0,
    P: new Float64Array(3),      // scratch position during a step
    hit: false,                  // result flag of the last sweep
    bx: false, bz: false,        // blocked flags of the last horizontal move
  };
}

function clampI(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function nextStamp(W) {
  W.stampId = (W.stampId + 1) >>> 0;
  if (W.stampId === 0) { W.stamp.fill(0); W.stampId = 1; }
  return W.stampId;
}

// Collect every box overlapping a region around the player into W.cb (constant margins, so the
// region always covers everything a single step can reach).
const GATHER_XZ = 1.0;
function gather(W, x, y, z) {
  const hw = PLAYER.halfWidth, M = MOVE;
  const mx = M.maxSpeed * DT + hw + GATHER_XZ;
  const x0 = x - mx, x1 = x + mx, z0 = z - mx, z1 = z + mx;
  const y0 = y - M.maxFallSpeed * DT - M.stepHeight - 1.0;
  const y1 = y + PLAYER.height + M.jumpSpeed * DT + M.stepHeight + 1.0;
  const nx = W.nx, cs = W.cell;
  const cx0 = clampI(Math.floor((x0 - W.gx0) / cs), 0, nx - 1);
  const cx1 = clampI(Math.floor((x1 - W.gx0) / cs), 0, nx - 1);
  const cz0 = clampI(Math.floor((z0 - W.gz0) / cs), 0, W.nz - 1);
  const cz1 = clampI(Math.floor((z1 - W.gz0) / cs), 0, W.nz - 1);
  const st = nextStamp(W), stamp = W.stamp, B = W.boxes, cb = W.cb, cs0 = W.cellStart, items = W.cellItems;
  let n = 0;
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = cz * nx + cx;
      for (let k = cs0[c], e = cs0[c + 1]; k < e; k++) {
        const bi = items[k];
        if (stamp[bi] === st) continue;
        stamp[bi] = st;
        const o = bi * 6;
        if (B[o] > x1 || B[o + 3] < x0 || B[o + 1] > y1 || B[o + 4] < y0 || B[o + 2] > z1 || B[o + 5] < z0) continue;
        const d = n * 6;
        cb[d] = B[o]; cb[d + 1] = B[o + 1]; cb[d + 2] = B[o + 2];
        cb[d + 3] = B[o + 3]; cb[d + 4] = B[o + 4]; cb[d + 5] = B[o + 5];
        n++;
      }
    }
  }
  W.nCand = n;
}

// Sweep the player box (feet at W.P, height h) along one axis by d. Stops at the first contact.
// Boxes that merely touch on the other axes (overlap <= EPS) are ignored -> seam-free sliding.
// A box penetrated by < EPS ahead of us pushes us back to exact contact. Returns distance moved.
function sweep(W, axis, d, h) {
  const P = W.P, cb = W.cb, n = W.nCand, hw = PLAYER.halfWidth;
  const mn0 = P[0] - hw, mx0 = P[0] + hw, mn1 = P[1], mx1 = P[1] + h, mn2 = P[2] - hw, mx2 = P[2] + hw;
  let allowed = d, hit = false;
  if (axis === 0) {
    for (let i = 0, o = 0; i < n; i++, o += 6) {
      if (cb[o + 4] - mn1 <= EPS || mx1 - cb[o + 1] <= EPS || cb[o + 5] - mn2 <= EPS || mx2 - cb[o + 2] <= EPS) continue;
      if (d > 0) { const dist = cb[o] - mx0; if (dist >= -EPS && dist <= allowed) { allowed = dist; hit = true; } }
      else { const dist = cb[o + 3] - mn0; if (dist <= EPS && dist >= allowed) { allowed = dist; hit = true; } }
    }
  } else if (axis === 1) {
    for (let i = 0, o = 0; i < n; i++, o += 6) {
      if (cb[o + 3] - mn0 <= EPS || mx0 - cb[o] <= EPS || cb[o + 5] - mn2 <= EPS || mx2 - cb[o + 2] <= EPS) continue;
      if (d > 0) { const dist = cb[o + 1] - mx1; if (dist >= -EPS && dist <= allowed) { allowed = dist; hit = true; } }
      else { const dist = cb[o + 4] - mn1; if (dist <= EPS && dist >= allowed) { allowed = dist; hit = true; } }
    }
  } else {
    for (let i = 0, o = 0; i < n; i++, o += 6) {
      if (cb[o + 3] - mn0 <= EPS || mx0 - cb[o] <= EPS || cb[o + 4] - mn1 <= EPS || mx1 - cb[o + 1] <= EPS) continue;
      if (d > 0) { const dist = cb[o + 2] - mx2; if (dist >= -EPS && dist <= allowed) { allowed = dist; hit = true; } }
      else { const dist = cb[o + 5] - mn2; if (dist <= EPS && dist >= allowed) { allowed = dist; hit = true; } }
    }
  }
  P[axis] += allowed;
  W.hit = hit;
  return allowed;
}

// Horizontal move, larger axis first. Sets W.bx / W.bz when an axis was blocked.
function slideXZ(W, dx, dz, h) {
  let bx = false, bz = false;
  if (Math.abs(dx) >= Math.abs(dz)) {
    if (dx !== 0) { sweep(W, 0, dx, h); bx = W.hit; }
    if (dz !== 0) { sweep(W, 2, dz, h); bz = W.hit; }
  } else {
    if (dz !== 0) { sweep(W, 2, dz, h); bz = W.hit; }
    if (dx !== 0) { sweep(W, 0, dx, h); bx = W.hit; }
  }
  W.bx = bx; W.bz = bz;
}

// Horizontal move with Quake-style step-up: if blocked while grounded, retry lifted by
// stepHeight, then settle back down; keep whichever went further horizontally.
function moveHorizontal(W, dx, dz, h, canStep) {
  const P = W.P;
  const x0 = P[0], y0 = P[1], z0 = P[2];
  slideXZ(W, dx, dz, h);
  if (!canStep || !(W.bx || W.bz)) return;
  const ax = P[0], ay = P[1], az = P[2], abx = W.bx, abz = W.bz;
  P[0] = x0; P[1] = y0; P[2] = z0;
  const lift = sweep(W, 1, MOVE.stepHeight, h);
  if (lift > 1e-3) {
    slideXZ(W, dx, dz, h);
    const bbx = W.bx, bbz = W.bz;
    sweep(W, 1, -lift, h);
    const landed = W.hit;
    const da = (ax - x0) * (ax - x0) + (az - z0) * (az - z0);
    const db = (P[0] - x0) * (P[0] - x0) + (P[2] - z0) * (P[2] - z0);
    if (landed && db > da + 1e-8) { W.bx = bbx; W.bz = bbz; return; }
  }
  P[0] = ax; P[1] = ay; P[2] = az; W.bx = abx; W.bz = abz;
}

// Push the player out of any box it overlaps by more than EPS (spawned in geometry etc.).
function depenetrate(W, h) {
  const P = W.P, cb = W.cb, n = W.nCand, hw = PLAYER.halfWidth;
  for (let iter = 0; iter < 4; iter++) {
    let found = false;
    for (let i = 0, o = 0; i < n; i++, o += 6) {
      const mn0 = P[0] - hw, mx0 = P[0] + hw, mn1 = P[1], mx1 = P[1] + h, mn2 = P[2] - hw, mx2 = P[2] + hw;
      if (cb[o + 3] - mn0 <= EPS || mx0 - cb[o] <= EPS || cb[o + 4] - mn1 <= EPS || mx1 - cb[o + 1] <= EPS ||
          cb[o + 5] - mn2 <= EPS || mx2 - cb[o + 2] <= EPS) continue;
      found = true;
      const up = cb[o + 4] - mn1;
      if (up <= MOVE.stepHeight + EPS) { P[1] += up; continue; }
      let best = up, axis = 1, sign = 1;
      const down = mx1 - cb[o + 1]; if (down < best) { best = down; axis = 1; sign = -1; }
      const px = cb[o + 3] - mn0; if (px < best) { best = px; axis = 0; sign = 1; }
      const nxp = mx0 - cb[o]; if (nxp < best) { best = nxp; axis = 0; sign = -1; }
      const pz = cb[o + 5] - mn2; if (pz < best) { best = pz; axis = 2; sign = 1; }
      const nzp = mx2 - cb[o + 2]; if (nzp < best) { best = nzp; axis = 2; sign = -1; }
      P[axis] += sign * best;
    }
    if (!found) break;
  }
}

// True if the standing box fits at W.P (nothing in the band between crouch and stand height).
function canStand(W) {
  const P = W.P, cb = W.cb, n = W.nCand, hw = PLAYER.halfWidth;
  const mn0 = P[0] - hw, mx0 = P[0] + hw, mn1 = P[1] + PLAYER.crouchHeight - EPS, mx1 = P[1] + PLAYER.height;
  const mn2 = P[2] - hw, mx2 = P[2] + hw;
  for (let i = 0, o = 0; i < n; i++, o += 6) {
    if (cb[o + 3] - mn0 <= EPS || mx0 - cb[o] <= EPS || cb[o + 4] - mn1 <= EPS || mx1 - cb[o + 1] <= EPS ||
        cb[o + 5] - mn2 <= EPS || mx2 - cb[o + 2] <= EPS) continue;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Player state

export function createPlayerState() {
  return {
    x: 0, y: 0, z: 0,          // feet centre (float32 values)
    vx: 0, vy: 0, vz: 0,       // velocity m/s (float32 values)
    onGround: false,
    crouching: false,          // collision box is crouchHeight tall
    sliding: false,
    hopArmed: false,           // jumped and released crouch in the air -> next slide may boost
    jumpedAir: false,          // currently airborne because of a jump
    slideTicks: 0,             // ticks since the last slide boost (saturates at 255)
    slideCooldown: 0,          // ticks until a ground slide may boost again
    groundTicks: 0,            // ticks on the ground since landing (saturates at 255)
    crouchTicks: 0,            // 0..MOVE.crouchTicks, eye-height crouch transition
  };
}

export function copyState(dst, src) {
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
  dst.vx = src.vx; dst.vy = src.vy; dst.vz = src.vz;
  dst.onGround = src.onGround; dst.crouching = src.crouching; dst.sliding = src.sliding;
  dst.hopArmed = src.hopArmed; dst.jumpedAir = src.jumpedAir;
  dst.slideTicks = src.slideTicks; dst.slideCooldown = src.slideCooldown;
  dst.groundTicks = src.groundTicks; dst.crouchTicks = src.crouchTicks;
  return dst;
}

export function spawnState(s, x, y, z) {
  s.x = Math.fround(x); s.y = Math.fround(y); s.z = Math.fround(z);
  s.vx = 0; s.vy = 0; s.vz = 0;
  s.onGround = false; s.crouching = false; s.sliding = false;
  s.hopArmed = false; s.jumpedAir = false;
  s.slideTicks = 255; s.slideCooldown = 0; s.groundTicks = 255; s.crouchTicks = 0;
  return s;
}

export function hitboxHeight(s) {
  return s.crouching ? PLAYER.crouchHeight : PLAYER.height;
}

export function eyeHeight(s) {
  let t = s.crouchTicks / MOVE.crouchTicks;
  if (t > 1) t = 1;
  t = t * t * (3 - 2 * t);
  return PLAYER.eyeHeight + (PLAYER.crouchEyeHeight - PLAYER.eyeHeight) * t;
}

// ---------------------------------------------------------------------------------------------
// Step

/**
 * speedMult: movement speed multiplier from the caller (gun in hand + attachments + aim; see
 * weapons.moveSpeedMult). Server and client must pass the same value for the same cmd.
 * Omitted / invalid -> 1.
 */
export function stepPlayer(s, cmd, W, speedMult = 1) {
  const M = MOVE;
  const buttons = cmd.buttons | 0;
  const crouchHeld = (buttons & BTN.CROUCH) !== 0;
  const jumpHeld = (buttons & BTN.JUMP) !== 0;
  let yaw = +cmd.yaw;
  if (!Number.isFinite(yaw)) yaw = 0;
  let mult = +speedMult;
  if (!(mult > 0 && mult < 4)) mult = 1;   // also catches NaN / undefined

  const P = W.P;
  P[0] = s.x; P[1] = s.y; P[2] = s.z;
  gather(W, s.x, s.y, s.z);
  depenetrate(W, s.crouching ? PLAYER.crouchHeight : PLAYER.height);

  // Crouch: shrinking is always possible; standing up needs headroom.
  if (crouchHeld) s.crouching = true;
  else if (s.crouching && canStand(W)) s.crouching = false;
  if (s.crouching) { if (s.crouchTicks < M.crouchTicks) s.crouchTicks++; }
  else if (s.crouchTicks > 0) s.crouchTicks--;

  // Wish direction from buttons + yaw (yaw 0 looks down -Z, right = (cos, 0, -sin)).
  const fwd = ((buttons & BTN.FORWARD) ? 1 : 0) - ((buttons & BTN.BACK) ? 1 : 0);
  const side = ((buttons & BTN.RIGHT) ? 1 : 0) - ((buttons & BTN.LEFT) ? 1 : 0);
  let wx = 0, wz = 0;
  if (fwd !== 0 || side !== 0) {
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    wx = -sy * fwd + cy * side;
    wz = -cy * fwd - sy * side;
    const inv = 1 / Math.sqrt(wx * wx + wz * wz);
    wx *= inv; wz *= inv;
  }
  const hasWish = fwd !== 0 || side !== 0;

  let vx = s.vx, vy = s.vy, vz = s.vz;
  const wasOnGround = s.onGround;
  let hs = Math.sqrt(vx * vx + vz * vz);

  // Slide end / start.
  if (s.sliding && (!crouchHeld || !s.crouching || !s.onGround || hs < M.slideStopSpeed)) s.sliding = false;
  if (!s.sliding && s.onGround && s.crouching && crouchHeld && hs >= M.slideMinSpeed) {
    s.sliding = true;
    if (s.hopArmed || s.slideCooldown === 0) {
      let f = M.slideBoost;
      if (hs * f > M.maxSpeed) f = M.maxSpeed / hs;
      if (f > 1) { vx *= f; vz *= f; hs *= f; }
      s.slideTicks = 0;
      s.slideCooldown = M.slideBoostCooldownTicks > 255 ? 255 : M.slideBoostCooldownTicks;
      s.hopArmed = false;
    }
  }

  // Jump (auto-hop while held). Jumping before friction keeps all momentum.
  let jumped = false;
  if (s.onGround && jumpHeld) {
    vy = M.jumpSpeed;
    s.onGround = false; s.sliding = false;
    s.jumpedAir = true; s.hopArmed = false;
    jumped = true;
  }

  if (s.onGround) {
    vy = 0;
    if (s.sliding) {
      // Low friction that ramps up since the boost.
      const r = s.slideTicks >= M.slideRampTicks ? 1 : s.slideTicks / M.slideRampTicks;
      const fr = M.slideFrictionStart + (M.slideFrictionEnd - M.slideFrictionStart) * r;
      let k = 1 - fr * DT; if (k < 0) k = 0;
      vx *= k; vz *= k;
      // Limited steering: may turn or brake, never gain.
      if (hasWish) {
        const sp0 = Math.sqrt(vx * vx + vz * vz);
        const ws = M.runSpeed * mult;
        const cur = vx * wx + vz * wz;
        const add = ws - cur;
        if (add > 0) {
          let acc = M.slideSteerAccel * ws * DT; if (acc > add) acc = add;
          vx += acc * wx; vz += acc * wz;
          const sp1 = Math.sqrt(vx * vx + vz * vz);
          if (sp1 > sp0 && sp1 > 0) { const k2 = sp0 / sp1; vx *= k2; vz *= k2; }
        }
      }
    } else {
      // Friction.
      const sp = Math.sqrt(vx * vx + vz * vz);
      if (sp > 0) {
        const ctrl = sp < M.stopSpeed ? M.stopSpeed : sp;
        let ns = sp - ctrl * M.groundFriction * DT;
        if (ns < 0) ns = 0;
        const k = ns / sp; vx *= k; vz *= k;
      }
      // Accelerate; ground accel can never push you above the wish speed.
      if (hasWish) {
        const ws = (s.crouching ? M.crouchSpeed : M.runSpeed) * mult;
        const s0 = Math.sqrt(vx * vx + vz * vz);
        const cur = vx * wx + vz * wz;
        const add = ws - cur;
        if (add > 0) {
          let acc = M.groundAccel * ws * DT; if (acc > add) acc = add;
          vx += acc * wx; vz += acc * wz;
          const s1 = Math.sqrt(vx * vx + vz * vz);
          const lim = s0 > ws ? s0 : ws;
          if (s1 > lim) { const k = lim / s1; vx *= k; vz *= k; }
        }
      }
    }
  } else if (hasWish) {
    const ws = M.runSpeed * mult;
    // Air control: while slower than run speed, accelerate towards the wish direction (capped at
    // run speed) so holding jump from a standstill still gets you moving.
    const s0 = Math.sqrt(vx * vx + vz * vz);
    if (s0 < ws) {
      const cur0 = vx * wx + vz * wz;
      const add0 = ws - cur0;
      if (add0 > 0) {
        let acc = M.airControlAccel * ws * DT; if (acc > add0) acc = add0;
        vx += acc * wx; vz += acc * wz;
        const s1 = Math.sqrt(vx * vx + vz * vz);
        if (s1 > ws) { const k = ws / s1; vx *= k; vz *= k; }
      }
    }
    // Quake air acceleration: small wish cap, high accel -> strafing bends + slight gain.
    const cur = vx * wx + vz * wz;
    const add = (ws < M.airWishCap ? ws : M.airWishCap) - cur;
    if (add > 0) {
      let acc = M.airAccel * ws * DT; if (acc > add) acc = add;
      vx += acc * wx; vz += acc * wz;
    }
  }

  // Hard horizontal cap.
  hs = Math.sqrt(vx * vx + vz * vz);
  if (hs > M.maxSpeed) { const k = M.maxSpeed / hs; vx *= k; vz *= k; }

  // Move.
  const h = s.crouching ? PLAYER.crouchHeight : PLAYER.height;
  const canStep = wasOnGround && !jumped;
  if (vx !== 0 || vz !== 0) {
    moveHorizontal(W, vx * DT, vz * DT, h, canStep);
    if (W.bx) vx = 0;
    if (W.bz) vz = 0;
  }

  let onGround = s.onGround;
  if (!onGround) {
    // Velocity Verlet for constant gravity (exact apex).
    vy -= M.gravity * DT * 0.5;
    sweep(W, 1, vy * DT, h);
    if (W.hit) {
      if (vy < 0) onGround = true;
      vy = 0;
    } else {
      vy -= M.gravity * DT * 0.5;
      if (vy < -M.maxFallSpeed) vy = -M.maxFallSpeed;
    }
  }
  // Ground categorisation: snap down stairs if we were grounded, else only a tiny probe.
  if (vy <= 0) {
    const probe = canStep ? M.stepHeight : GROUND_PROBE;
    const y0 = P[1];
    sweep(W, 1, -probe, h);
    if (W.hit) { onGround = true; vy = 0; }
    else { P[1] = y0; onGround = false; }
  } else {
    onGround = false;
  }

  // Flags and timers.
  if (onGround) {
    if (!wasOnGround || jumped) { s.groundTicks = 0; s.jumpedAir = false; }
    else if (s.groundTicks < 255) s.groundTicks++;
    if (s.groundTicks > M.slideLandGraceTicks) s.hopArmed = false;
  } else {
    s.sliding = false;
    if (s.jumpedAir && !crouchHeld) s.hopArmed = true;
  }
  s.onGround = onGround;
  if (s.slideTicks < 255) s.slideTicks++;
  if (s.slideCooldown > 0) s.slideCooldown--;

  s.x = Math.fround(P[0]); s.y = Math.fround(P[1]); s.z = Math.fround(P[2]);
  s.vx = Math.fround(vx); s.vy = Math.fround(vy); s.vz = Math.fround(vz);
  return s;
}

// ---------------------------------------------------------------------------------------------
// Serialisation: 6 x float32 + flags + 4 x uint8 = 29 bytes, little-endian. Exact round trip.

export const STATE_BYTES = 29;

export function writeState(view, offset, s) {
  view.setFloat32(offset, s.x, true);
  view.setFloat32(offset + 4, s.y, true);
  view.setFloat32(offset + 8, s.z, true);
  view.setFloat32(offset + 12, s.vx, true);
  view.setFloat32(offset + 16, s.vy, true);
  view.setFloat32(offset + 20, s.vz, true);
  view.setUint8(offset + 24,
    (s.onGround ? 1 : 0) | (s.crouching ? 2 : 0) | (s.sliding ? 4 : 0) |
    (s.hopArmed ? 8 : 0) | (s.jumpedAir ? 16 : 0));
  view.setUint8(offset + 25, s.slideTicks);
  view.setUint8(offset + 26, s.slideCooldown);
  view.setUint8(offset + 27, s.groundTicks);
  view.setUint8(offset + 28, s.crouchTicks);
  return offset + STATE_BYTES;
}

export function readState(view, offset, s) {
  s.x = view.getFloat32(offset, true);
  s.y = view.getFloat32(offset + 4, true);
  s.z = view.getFloat32(offset + 8, true);
  s.vx = view.getFloat32(offset + 12, true);
  s.vy = view.getFloat32(offset + 16, true);
  s.vz = view.getFloat32(offset + 20, true);
  const f = view.getUint8(offset + 24);
  s.onGround = (f & 1) !== 0; s.crouching = (f & 2) !== 0; s.sliding = (f & 4) !== 0;
  s.hopArmed = (f & 8) !== 0; s.jumpedAir = (f & 16) !== 0;
  s.slideTicks = view.getUint8(offset + 25);
  s.slideCooldown = view.getUint8(offset + 26);
  s.groundTicks = view.getUint8(offset + 27);
  s.crouchTicks = view.getUint8(offset + 28);
  return offset + STATE_BYTES;
}

// ---------------------------------------------------------------------------------------------
// Raycasts

// Ray (unit direction) vs world. Walks the XZ grid with a DDA and slab-tests the boxes in each
// cell. Returns the distance to the first solid (0 if the origin is inside one) or Infinity.
// outNormal (optional [3]) receives the hit face normal.
export function raycastWorld(W, ox, oy, oz, dx, dy, dz, maxDist, outNormal) {
  const cs = W.cell, gx0 = W.gx0, gz0 = W.gz0, nx = W.nx, nz = W.nz;
  const gx1 = gx0 + nx * cs, gz1 = gz0 + nz * cs;
  let tmin = 0, tmax = maxDist;
  if (dx !== 0) {
    let t1 = (gx0 - ox) / dx, t2 = (gx1 - ox) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
  } else if (ox < gx0 || ox > gx1) return Infinity;
  if (dz !== 0) {
    let t1 = (gz0 - oz) / dz, t2 = (gz1 - oz) / dz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2;
  } else if (oz < gz0 || oz > gz1) return Infinity;
  if (!(tmin <= tmax)) return Infinity;

  let ix = clampI(Math.floor((ox + dx * tmin - gx0) / cs), 0, nx - 1);
  let iz = clampI(Math.floor((oz + dz * tmin - gz0) / cs), 0, nz - 1);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0, stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  let tMaxX = dx > 0 ? (gx0 + (ix + 1) * cs - ox) / dx : dx < 0 ? (gx0 + ix * cs - ox) / dx : Infinity;
  let tMaxZ = dz > 0 ? (gz0 + (iz + 1) * cs - oz) / dz : dz < 0 ? (gz0 + iz * cs - oz) / dz : Infinity;
  const tdx = dx !== 0 ? cs / Math.abs(dx) : Infinity, tdz = dz !== 0 ? cs / Math.abs(dz) : Infinity;

  const st = nextStamp(W), stamp = W.stamp, B = W.boxes, cs0 = W.cellStart, items = W.cellItems;
  let best = Infinity, bestAxis = -2;
  for (;;) {
    const c = iz * nx + ix;
    for (let k = cs0[c], e = cs0[c + 1]; k < e; k++) {
      const bi = items[k];
      if (stamp[bi] === st) continue;
      stamp[bi] = st;
      const o = bi * 6;
      let tn = -Infinity, tf = Infinity, ax = -1;
      if (dx !== 0) {
        let t1 = (B[o] - ox) / dx, t2 = (B[o + 3] - ox) / dx;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > tn) { tn = t1; ax = 0; } if (t2 < tf) tf = t2;
      } else if (ox < B[o] || ox > B[o + 3]) continue;
      if (dy !== 0) {
        let t1 = (B[o + 1] - oy) / dy, t2 = (B[o + 4] - oy) / dy;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > tn) { tn = t1; ax = 1; } if (t2 < tf) tf = t2;
      } else if (oy < B[o + 1] || oy > B[o + 4]) continue;
      if (dz !== 0) {
        let t1 = (B[o + 2] - oz) / dz, t2 = (B[o + 5] - oz) / dz;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > tn) { tn = t1; ax = 2; } if (t2 < tf) tf = t2;
      } else if (oz < B[o + 2] || oz > B[o + 5]) continue;
      if (tn > tf || tf < 0) continue;
      const t = tn < 0 ? 0 : tn;
      if (t < best) { best = t; bestAxis = tn < 0 ? -1 : ax; }
    }
    const tExit = tMaxX < tMaxZ ? tMaxX : tMaxZ;
    if (best <= tExit || tExit > tmax) break;
    if (tMaxX < tMaxZ) { ix += stepX; if (ix < 0 || ix >= nx) break; tMaxX += tdx; }
    else { iz += stepZ; if (iz < 0 || iz >= nz) break; tMaxZ += tdz; }
  }
  if (!(best <= maxDist)) return Infinity;
  if (outNormal) {
    outNormal[0] = 0; outNormal[1] = 0; outNormal[2] = 0;
    if (bestAxis === 0) outNormal[0] = dx > 0 ? -1 : 1;
    else if (bestAxis === 1) outNormal[1] = dy > 0 ? -1 : 1;
    else if (bestAxis === 2) outNormal[2] = dz > 0 ? -1 : 1;
    else { outNormal[0] = -dx; outNormal[1] = -dy; outNormal[2] = -dz; }
  }
  return best;
}

// Ray (unit direction) vs one player box with feet at (px, py, pz) and the given height.
// Returns null or { t, head } where head = the hit point is in the top PLAYER.headSize.
export function raycastPlayer(ox, oy, oz, dx, dy, dz, px, py, pz, height, maxDist) {
  const hw = PLAYER.halfWidth;
  let tn = -Infinity, tf = Infinity;
  if (dx !== 0) {
    let t1 = (px - hw - ox) / dx, t2 = (px + hw - ox) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tn) tn = t1; if (t2 < tf) tf = t2;
  } else if (ox < px - hw || ox > px + hw) return null;
  if (dy !== 0) {
    let t1 = (py - oy) / dy, t2 = (py + height - oy) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tn) tn = t1; if (t2 < tf) tf = t2;
  } else if (oy < py || oy > py + height) return null;
  if (dz !== 0) {
    let t1 = (pz - hw - oz) / dz, t2 = (pz + hw - oz) / dz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tn) tn = t1; if (t2 < tf) tf = t2;
  } else if (oz < pz - hw || oz > pz + hw) return null;
  if (tn > tf || tf < 0) return null;
  const t = tn < 0 ? 0 : tn;
  if (t > maxDist) return null;
  return { t, head: oy + dy * t >= py + height - PLAYER.headSize };
}
