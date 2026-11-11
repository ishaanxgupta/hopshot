// Hopshot input: pointer lock, key/mouse map, sensitivity, and the per-tick cmd sampling.
// Also exports createAutopilot(), a synthetic player used by ?autoplay=1 and by the headless
// test (tools/client.test.js). Nothing here touches the DOM at module load, so the file can be
// imported in Node; only createInput() needs a browser.
//
// Controls: WASD move, Space jump, Shift or C crouch/slide, LMB fire, RMB ADS, R reload,
// 1/2/3 + wheel weapon, Tab scoreboard (held), Esc menu (releases pointer lock).

import { BTN, PITCH_LIMIT } from '../shared/constants.js';
import { WEAPONS } from '../shared/weapons.js';
import { raycastWorld, eyeHeight } from '../shared/physics.js';

const TWO_PI = Math.PI * 2;
export const RAD_PER_PIXEL = 0.0022;   // x sensitivity setting

export function wrapAngle(a) {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

const KEYMAP = {
  KeyW: BTN.FORWARD, ArrowUp: BTN.FORWARD,
  KeyS: BTN.BACK, ArrowDown: BTN.BACK,
  KeyA: BTN.LEFT, ArrowLeft: BTN.LEFT,
  KeyD: BTN.RIGHT, ArrowRight: BTN.RIGHT,
  Space: BTN.JUMP,
  ShiftLeft: BTN.CROUCH, ShiftRight: BTN.CROUCH, KeyC: BTN.CROUCH, ControlLeft: BTN.CROUCH,
  KeyR: BTN.RELOAD,
};

function isTyping(e) {
  const t = e && e.target;
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/**
 * Browser input. opts = { onLockChange(locked), onScoreboard(held), onEscape() }.
 * The owner sets `input.enabled` (game input accepted) and `input.adsScale` (sensitivity
 * multiplier while aiming). yaw/pitch are updated on every mousemove (render rate).
 */
export function createInput(canvas, opts = {}) {
  const st = {
    enabled: false,
    locked: false,
    sensitivity: 1,
    adsScale: 1,
    yaw: 0,
    pitch: 0,
    weapon: 0,
    held: 0,          // buttons currently held
    latched: 0,       // buttons pressed since the last sample (so a quick tap is never missed)
    scoreboard: false,
  };
  let lastWheel = 0;

  function setWeapon(w) {
    st.weapon = ((w % WEAPONS.length) + WEAPONS.length) % WEAPONS.length;
  }

  function press(bit) { st.held |= bit; st.latched |= bit; }
  function release(bit) { st.held &= ~bit; }
  function clear() { st.held = 0; st.latched = 0; }

  function onKeyDown(e) {
    if (e.code === 'Tab') {             // never let Tab move focus
      e.preventDefault();
      if (!isTyping(e) && !st.scoreboard) { st.scoreboard = true; opts.onScoreboard && opts.onScoreboard(true); }
      return;
    }
    if (isTyping(e)) return;
    if (e.code === 'Escape' && !st.locked) { opts.onEscape && opts.onEscape(); return; }
    if (!st.enabled) return;
    const bit = KEYMAP[e.code];
    if (bit) { press(bit); e.preventDefault(); return; }
    if (e.repeat) return;
    if (e.code === 'Digit1' || e.code === 'Numpad1') setWeapon(0);
    else if (e.code === 'Digit2' || e.code === 'Numpad2') setWeapon(1);
    else if (e.code === 'Digit3' || e.code === 'Numpad3') setWeapon(2);
    else if (e.code === 'KeyQ') setWeapon(st.weapon - 1);
  }
  function onKeyUp(e) {
    if (e.code === 'Tab') {
      e.preventDefault();
      if (st.scoreboard) { st.scoreboard = false; opts.onScoreboard && opts.onScoreboard(false); }
      return;
    }
    const bit = KEYMAP[e.code];
    if (bit) release(bit);
  }
  function onMouseMove(e) {
    if (!st.locked || !st.enabled) return;
    let mx = e.movementX || 0, my = e.movementY || 0;
    // some browsers emit one huge bogus delta right after locking
    if (Math.abs(mx) > 600 || Math.abs(my) > 600) return;
    const k = RAD_PER_PIXEL * st.sensitivity * st.adsScale;
    st.yaw = wrapAngle(st.yaw - mx * k);
    st.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, st.pitch - my * k));
  }
  function onMouseDown(e) {
    if (!st.enabled || !st.locked) return;
    if (e.button === 0) press(BTN.FIRE);
    else if (e.button === 2) press(BTN.ADS);
    e.preventDefault();
  }
  function onMouseUp(e) {
    if (e.button === 0) release(BTN.FIRE);
    else if (e.button === 2) release(BTN.ADS);
  }
  function onWheel(e) {
    if (!st.enabled || !st.locked) return;
    e.preventDefault();
    const t = performance.now();
    if (t - lastWheel < 90 || Math.abs(e.deltaY) < 1) return;
    lastWheel = t;
    setWeapon(st.weapon + (e.deltaY > 0 ? 1 : -1));
  }
  function onLockChange() {
    const locked = document.pointerLockElement === canvas;
    if (locked === st.locked) return;
    st.locked = locked;
    if (!locked) clear();
    opts.onLockChange && opts.onLockChange(locked);
  }
  function onBlur() {
    clear();
    if (st.scoreboard) { st.scoreboard = false; opts.onScoreboard && opts.onScoreboard(false); }
  }

  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('keyup', onKeyUp, { capture: true });
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', onLockChange);
  document.addEventListener('pointerlockerror', () => { opts.onLockError && opts.onLockError(); });
  window.addEventListener('blur', onBlur);

  /** Ask for pointer lock (must be called from a user gesture). Resolves to true/false. */
  async function requestLock() {
    if (document.pointerLockElement === canvas) return true;
    if (!canvas.requestPointerLock) return false;
    try {
      const r = canvas.requestPointerLock();
      if (r && typeof r.then === 'function') await r;
      return true;
    } catch {
      return false;
    }
  }
  function exitLock() { if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock(); }

  /** Buttons for this tick (held | tapped since last sample); clears the tap latch. */
  function sampleButtons() {
    const b = st.enabled ? (st.held | st.latched) : 0;
    st.latched = 0;
    return b;
  }

  return {
    get state() { return st; },
    get yaw() { return st.yaw; }, set yaw(v) { st.yaw = wrapAngle(+v || 0); },
    get pitch() { return st.pitch; }, set pitch(v) { st.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, +v || 0)); },
    get weapon() { return st.weapon; }, set weapon(v) { setWeapon(v | 0); },
    get enabled() { return st.enabled; }, set enabled(v) { st.enabled = !!v; if (!v) clear(); },
    get locked() { return st.locked; },
    get sensitivity() { return st.sensitivity; }, set sensitivity(v) { st.sensitivity = +v > 0 ? +v : 1; },
    get adsScale() { return st.adsScale; }, set adsScale(v) { st.adsScale = +v > 0 ? +v : 1; },
    get held() { return st.held; },
    sampleButtons, requestLock, exitLock, clear,
  };
}

// ------------------------------------------------------------------------------- autopilot

/** Small deterministic PRNG (mulberry32) so autopilot runs are reproducible per seed. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthetic player: wanders with slide-hops, avoids walls, turns toward and shoots at the
 * nearest visible enemy. One update() per sim tick:
 *   ctx = { world, self (physics state), alive, remotes: [{ id, x, y, z, alive, crouching }],
 *           ammo, magSize, weapon }
 *   -> { buttons, yaw, pitch, weapon }   (reused object)
 */
export function createAutopilot(opts = {}) {
  const rnd = prng(opts.seed || 12345);
  const out = { buttons: 0, yaw: opts.yaw || 0, pitch: 0, weapon: 0, target: 0 };
  let tick = 0;
  let wanderYaw = out.yaw, nextWander = 0;
  let target = null, targetId = 0, nextScan = 0, strafe = 1, nextStrafe = 0;
  let nextWeapon = 600 + Math.floor(rnd() * 600);
  let blockedTicks = 0;
  let firePulse = false;
  const nrm = [0, 0, 0];
  const turnRate = opts.turnRate || 0.16;   // rad per tick

  function visible(world, ex, ey, ez, r) {
    const tx = r.x, ty = r.y + (r.crouching ? 0.7 : 1.2), tz = r.z;
    const dx = tx - ex, dy = ty - ey, dz = tz - ez;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 0.5 || d > 70) return 0;
    const hit = raycastWorld(world, ex, ey, ez, dx / d, dy / d, dz / d, d, null);
    return hit >= d - 0.3 ? d : 0;
  }

  function approach(cur, goal, step) {
    const d = wrapAngle(goal - cur);
    return wrapAngle(cur + (d > step ? step : d < -step ? -step : d));
  }

  function setYaw(v) { out.yaw = wrapAngle(v); wanderYaw = out.yaw; }

  function update(ctx) {
    tick++;
    const s = ctx.self, world = ctx.world;
    let b = 0;
    if (!ctx.alive) { out.buttons = 0; target = null; return out; }
    const ex = s.x, ey = s.y + eyeHeight(s), ez = s.z;

    // target selection
    if (tick >= nextScan) {
      nextScan = tick + 6;
      target = null; targetId = 0;
      let best = 1e9;
      const list = ctx.remotes || [];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!r.alive) continue;
        const d = visible(world, ex, ey, ez, r);
        if (d > 0 && d < best) { best = d; target = r; targetId = r.id; }
      }
    }
    if (target && (!target.alive || target.id !== targetId)) target = null;

    if (tick >= nextWeapon) { nextWeapon = tick + 900 + Math.floor(rnd() * 900); out.weapon = Math.floor(rnd() * WEAPONS.length); }

    if (target) {
      const tx = target.x - ex, ty = target.y + (target.crouching ? 0.75 : 1.25) - ey, tz = target.z - ez;
      const h = Math.hypot(tx, tz);
      const wantYaw = Math.atan2(-tx, -tz);
      const wantPitch = Math.atan2(ty, h);
      out.yaw = approach(out.yaw, wantYaw, turnRate);
      out.pitch += Math.max(-turnRate, Math.min(turnRate, wantPitch - out.pitch));
      const aimErr = Math.abs(wrapAngle(wantYaw - out.yaw)) + Math.abs(wantPitch - out.pitch);
      if (aimErr < 0.06) {
        const w = WEAPONS[ctx.weapon | 0] || WEAPONS[0];
        firePulse = w.auto ? true : !firePulse;          // semi-autos need a release between shots
        if (firePulse) b |= BTN.FIRE;
        if (h > 18) b |= BTN.ADS;
      }
      if (tick >= nextStrafe) { strafe = rnd() < 0.5 ? -1 : 1; nextStrafe = tick + 30 + Math.floor(rnd() * 50); }
      b |= strafe > 0 ? BTN.RIGHT : BTN.LEFT;
      if (h > 14) b |= BTN.FORWARD;
      if (h < 5) b |= BTN.BACK;
      wanderYaw = out.yaw;
    } else {
      // wander + wall avoidance
      if (tick >= nextWander) {
        nextWander = tick + 90 + Math.floor(rnd() * 150);
        wanderYaw = wrapAngle(wanderYaw + (rnd() - 0.5) * 2.2);
      }
      const fx = -Math.sin(out.yaw), fz = -Math.cos(out.yaw);
      const look = 2.2 + Math.hypot(s.vx, s.vz) * 0.25;
      const knee = raycastWorld(world, ex, s.y + 0.6, ez, fx, 0, fz, look, nrm);
      const chest = raycastWorld(world, ex, s.y + 1.3, ez, fx, 0, fz, look, nrm);
      if (knee < look || chest < look) {
        blockedTicks++;
        // turn toward whichever side is more open
        const lx = -Math.sin(out.yaw + 1.2), lz = -Math.cos(out.yaw + 1.2);
        const rx = -Math.sin(out.yaw - 1.2), rz = -Math.cos(out.yaw - 1.2);
        const dl = raycastWorld(world, ex, s.y + 1.0, ez, lx, 0, lz, 15, null);
        const dr = raycastWorld(world, ex, s.y + 1.0, ez, rx, 0, rz, 15, null);
        wanderYaw = wrapAngle(out.yaw + (dl > dr ? 1.3 : -1.3) + (blockedTicks > 60 ? Math.PI * 0.5 : 0));
        if (blockedTicks > 60) blockedTicks = 0;
      } else blockedTicks = 0;
      out.yaw = approach(out.yaw, wanderYaw, turnRate * 0.6);
      out.pitch += (0 - out.pitch) * 0.1;
      b |= BTN.FORWARD;
      if (ctx.magSize && ctx.ammo < ctx.magSize * 0.4 && (tick % 120) === 0) b |= BTN.RELOAD;
    }

    // slide-hop: hold jump (auto-hop), release crouch while rising, hold crouch while falling
    // so every landing becomes a boosted slide that the held jump immediately hops out of.
    // Air control is weak, so only start hopping once running speed is reached on the ground.
    const hs = Math.hypot(s.vx, s.vz);
    if (!s.onGround || s.sliding || hs > 6.2) b |= BTN.JUMP;
    // crouch while falling and on the landing tick (-> boosted slide), released while rising
    if (hs > 5 && ((!s.onGround && s.vy < -1.5) || (s.onGround && s.crouching))) b |= BTN.CROUCH;
    if (s.sliding) b |= BTN.CROUCH;

    out.buttons = b;
    out.target = targetId;
    return out;
  }

  return { update, setYaw, get out() { return out; } };
}

