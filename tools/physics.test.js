// Physics tests for shared/physics.js. Plain Node, no framework:  node tools/physics.test.js
// Prints PASS/FAIL per test and exits non-zero if anything failed.

import {
  MOVE, createWorld, createPlayerState, copyState, spawnState, stepPlayer, eyeHeight, hitboxHeight,
  STATE_BYTES, writeState, readState, raycastWorld, raycastPlayer,
} from '../shared/physics.js';
import { BTN, PLAYER, DT } from '../shared/constants.js';
import { MAP } from '../shared/map.js';

// ---------------------------------------------------------------------------------------------
// Harness

let failures = 0, passes = 0;
const notes = [];
function test(name, fn) {
  notes.length = 0;
  try {
    fn();
    passes++;
    console.log(`PASS  ${name}${notes.length ? '  (' + notes.join(', ') + ')' : ''}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function note(s) { notes.push(s); }
const f2 = (v) => v.toFixed(2);

// Deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function box(x0, y0, z0, x1, y1, z1) { return { min: [x0, y0, z0], max: [x1, y1, z1], color: 0 }; }
function mapOf(boxes, extra = 40) {
  return { name: 'fixture', boxes, spawns: [], bounds: { min: [-extra, -2, -extra], max: [extra, 60, extra] }, killY: -50 };
}
const FLOOR = () => box(-40, -1, -40, 40, 0, 40);

function cmd(buttons = 0, yaw = 0, weapon = 0) { return { seq: 0, buttons, yaw, pitch: 0, weapon }; }
function hs(s) { return Math.hypot(s.vx, s.vz); }
function spawned(world, x, y, z, settle = 5) {
  const s = spawnState(createPlayerState(), x, y, z);
  const c = cmd();
  for (let i = 0; i < settle; i++) stepPlayer(s, c, world);
  return s;
}
function run(s, world, c, n, each) {
  for (let i = 0; i < n; i++) { stepPlayer(s, c, world); if (each) each(s, i); }
  return s;
}
const buf = new DataView(new ArrayBuffer(STATE_BYTES * 2));
function bytesOf(s) {
  writeState(buf, 0, s);
  return Array.from(new Uint8Array(buf.buffer, 0, STATE_BYTES)).join(',');
}
function sameState(a, b) {
  for (const k of Object.keys(a)) if (!Object.is(a[k], b[k])) return k;
  return null;
}
// Max penetration of a player box into any map box (0 when clear).
function penetration(map, s) {
  const hw = PLAYER.halfWidth, h = hitboxHeight(s);
  let worst = 0;
  for (const b of map.boxes) {
    const ox = Math.min(s.x + hw, b.max[0]) - Math.max(s.x - hw, b.min[0]);
    const oy = Math.min(s.y + h, b.max[1]) - Math.max(s.y, b.min[1]);
    const oz = Math.min(s.z + hw, b.max[2]) - Math.max(s.z - hw, b.min[2]);
    if (ox > 0 && oy > 0 && oz > 0) worst = Math.max(worst, Math.min(ox, oy, oz));
  }
  return worst;
}
// Random but plausible input stream (bot-like).
function randomInput(r, c, state) {
  if (r() < 0.05) {
    let b = 0;
    if (r() < 0.8) b |= BTN.FORWARD; else if (r() < 0.3) b |= BTN.BACK;
    if (r() < 0.3) b |= BTN.LEFT; else if (r() < 0.3) b |= BTN.RIGHT;
    if (r() < 0.25) b |= BTN.JUMP;
    if (r() < 0.2) b |= BTN.CROUCH;
    if (r() < 0.1) b |= BTN.ADS;
    state.b = b;
    state.turn = (r() - 0.5) * 0.15;
    c.weapon = r() < 0.05 ? (r() * 3) | 0 : c.weapon;
  }
  c.buttons = state.b;
  c.yaw += state.turn;
  c.seq++;
}

const world = createWorld(MAP);

// ---------------------------------------------------------------------------------------------
// Determinism and serialisation

test('determinism: two runs of the same cmds are bit-identical (current map)', () => {
  for (let p = 0; p < 6; p++) {
    const sp = MAP.spawns[p % MAP.spawns.length].pos;
    const a = spawnState(createPlayerState(), sp[0], sp[1], sp[2]);
    const b = spawnState(createPlayerState(), sp[0], sp[1], sp[2]);
    const ra = rng(100 + p), rb = rng(100 + p);
    const ca = cmd(), cb = cmd(), ia = {}, ib = {};
    const w2 = createWorld(MAP); // separate world instance: scratch state must not matter
    for (let i = 0; i < 3000; i++) {
      randomInput(ra, ca, ia); randomInput(rb, cb, ib);
      const ma = 0.8 + 0.1 * ca.weapon + ((ca.buttons & BTN.ADS) ? -0.3 : 0), mb = 0.8 + 0.1 * cb.weapon + ((cb.buttons & BTN.ADS) ? -0.3 : 0);
      stepPlayer(a, ca, world, ma); stepPlayer(b, cb, w2, mb);
      const k = sameState(a, b);
      assert(k === null, `diverged at tick ${i} on field ${k}`);
    }
  }
});

test('serialisation: write/read round trip is exact, floats are float32 after every step', () => {
  const r = rng(7), c = cmd(), inp = {};
  const sp = MAP.spawns[0].pos;
  const s = spawnState(createPlayerState(), sp[0], sp[1], sp[2]);
  const t = createPlayerState();
  const dv = new DataView(new ArrayBuffer(STATE_BYTES + 8));
  for (let i = 0; i < 4000; i++) {
    randomInput(r, c, inp);
    stepPlayer(s, c, world);
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz']) assert(Math.fround(s[k]) === s[k], `${k} not float32`);
    const end = writeState(dv, 3, s);
    assert(end === 3 + STATE_BYTES, 'writeState offset');
    assert(readState(dv, 3, t) === 3 + STATE_BYTES, 'readState offset');
    const k = sameState(s, t);
    assert(k === null, `field ${k} differs after round trip at tick ${i}`);
  }
  const u = copyState(createPlayerState(), s);
  assert(sameState(s, u) === null, 'copyState');
  note(`STATE_BYTES=${STATE_BYTES}`);
});

test('reconciliation: replay from a deserialised server state equals the server exactly', () => {
  const r = rng(99), inp = {};
  const sp = MAP.spawns[3].pos;
  const server = spawnState(createPlayerState(), sp[0], sp[1], sp[2]);
  const cmds = [];
  const c = cmd();
  for (let i = 0; i < 2400; i++) { randomInput(r, c, inp); cmds.push({ ...c }); }
  const dv = new DataView(new ArrayBuffer(STATE_BYTES));
  const client = createPlayerState();
  const clientWorld = createWorld(MAP);
  let checks = 0;
  for (let i = 0; i < cmds.length; i++) {
    stepPlayer(server, cmds[i], world);
    if (i % 2 === 0 && i + 15 < cmds.length) {
      // client receives the server state at tick i, replays the next 15 cmds
      writeState(dv, 0, server);
      readState(dv, 0, client);
      const shadow = copyState(createPlayerState(), server);
      for (let j = 1; j <= 15; j++) { stepPlayer(client, cmds[i + j], clientWorld); stepPlayer(shadow, cmds[i + j], world); }
      const k = sameState(client, shadow);
      assert(k === null, `replay diverged on ${k} at tick ${i}`);
      checks++;
    }
  }
  note(`${checks} replays of 15 cmds`);
});

// ---------------------------------------------------------------------------------------------
// Collision robustness

test('resting: no drift over 10 s idle (floor, odd-height ledges, box edges, crouched)', () => {
  const fx = mapOf([FLOOR(), box(2, 0, 2, 4, 0.3, 4), box(-4, 0, 2, -2, 1.7, 4), box(0, 0, -6, 3, 0.1, -3), box(3, 0, -6, 6, 0.15, -3)]);
  const w = createWorld(fx);
  const spots = [[0, 0, 0], [3, 0.3, 3], [4.3, 0.3, 3], [-2.1, 1.7, 3], [3, 0.15, -4.5], [0.12, 0, 7], [-3.5, 1.8, 3.9]];
  for (const [x, y, z] of spots) {
    for (const crouch of [0, BTN.CROUCH]) {
      const s = spawned(w, x, y, z, 30);
      run(s, w, cmd(crouch), 10);
      const ref = copyState(createPlayerState(), s);
      run(s, w, cmd(crouch), 600, (st, i) => {
        assert(st.onGround, `not on ground at ${x},${y},${z} tick ${i}`);
        assert(st.x === ref.x && st.y === ref.y && st.z === ref.z, `drift at ${x},${y},${z}: ${st.x},${st.y},${st.z}`);
        assert(st.vx === 0 && st.vy === 0 && st.vz === 0, 'velocity at rest');
      });
    }
  }
  // all spawns of the current map
  for (const sp of MAP.spawns) {
    const s = spawned(world, sp.pos[0], sp.pos[1], sp.pos[2], 30);
    const ref = copyState(createPlayerState(), s);
    run(s, world, cmd(), 600);
    assert(s.onGround && s.x === ref.x && s.y === ref.y && s.z === ref.z, `spawn ${sp.pos} drifted`);
    assert(Math.abs(s.y - sp.pos[1]) < 0.36, `spawn ${sp.pos} settled at y=${s.y}`);
  }
  note(`${spots.length * 2} fixture spots + ${MAP.spawns.length} map spawns`);
});

test('no tunnelling: cap-speed runs into 2 cm walls, 40 m/s falls onto 2 cm slabs', () => {
  const fx = mapOf([FLOOR(), box(5, 0, -39, 5.02, 3, 39), box(-20, 5, -20, 20, 5.02, -10)]);
  const w = createWorld(fx);
  let n = 0;
  for (let k = 0; k < 40; k++) {
    const z = -15 + k * 0.77;
    for (const yawOff of [0, 0.3, -0.6, 1.2]) {
      const s = spawned(w, 0, 0, z);
      const yaw = -Math.PI / 2 + yawOff; // facing +X
      s.vx = MOVE.maxSpeed * Math.cos(yawOff); s.vz = MOVE.maxSpeed * Math.sin(-yawOff);
      run(s, w, cmd(BTN.FORWARD | (k % 2 ? BTN.JUMP : 0) | (k % 3 ? BTN.CROUCH : 0), yaw), 120, (st) => {
        assert(st.x + PLAYER.halfWidth <= 5 + 1e-3, `tunnelled: x=${st.x}`);
      });
      n++;
    }
  }
  for (let k = 0; k < 20; k++) {
    const s = spawnState(createPlayerState(), -10 + k, 30 + k * 0.137, -15);
    s.vy = -MOVE.maxFallSpeed;
    run(s, w, cmd(), 200, (st) => assert(st.y >= 5.02 - 1e-3, `fell through slab: y=${st.y}`));
    assert(s.onGround && Math.abs(s.y - Math.fround(5.02)) < 1e-6, 'landed on slab');
    n++;
  }
  note(`${n} runs`);
});

test('step-up: 0.30/0.35 m ledges climbed at walk/slide speed, 0.36/0.40 m blocked', () => {
  for (const [h, ok] of [[0.3, true], [0.35, true], [0.36, false], [0.4, false]]) {
    for (const speedy of [false, true]) {
      const w = createWorld(mapOf([FLOOR(), box(3, 0, -5, 30, h, 5)]));
      const s = spawned(w, 0, 0, 0);
      if (speedy) s.vx = 15;
      run(s, w, cmd(BTN.FORWARD, -Math.PI / 2), 90);
      if (ok) assert(s.x > 5 && Math.abs(s.y - Math.fround(h)) < 1e-6 && s.onGround, `did not step ${h} (x=${s.x}, y=${s.y})`);
      else assert(s.x + PLAYER.halfWidth <= 3 + 1e-3 && s.y === 0, `stepped ${h} (x=${s.x}, y=${s.y})`);
    }
  }
});

test('stairs: up and down 0.3 m steps without leaving the ground', () => {
  const boxes = [FLOOR()];
  for (let i = 0; i < 6; i++) boxes.push(box(2 + i, 0, -3, 30 - i, 0.3 * (i + 1), 3));
  const w = createWorld(mapOf(boxes));
  const s = spawned(w, 0, 0, 0);
  let airTicks = 0, maxY = 0;
  run(s, w, cmd(BTN.FORWARD, -Math.PI / 2), 300, (st) => { if (!st.onGround) airTicks++; maxY = Math.max(maxY, st.y); });
  assert(Math.abs(maxY - Math.fround(1.8)) < 1e-6, `top not reached: ${maxY}`);
  assert(s.x > 30 && s.y === 0, `did not come down: x=${s.x} y=${s.y}`);
  assert(airTicks === 0, `airborne for ${airTicks} ticks on stairs`);
});

test('ceilings: head bump cancels upward speed, cannot stand under 1.5 m roof', () => {
  const w = createWorld(mapOf([FLOOR(), box(-3, 2.4, -3, 3, 3, 3), box(6, 1.5, -3, 12, 2, 3)]));
  // head bump
  const s = spawned(w, 0, 0, 0);
  let maxY = 0, bumped = false;
  run(s, w, cmd(BTN.JUMP), 30, (st) => { maxY = Math.max(maxY, st.y); if (st.y > 0.5 && st.vy === 0 && !st.onGround) bumped = true; });
  assert(maxY <= 2.4 - PLAYER.height + 1e-4, `head went through ceiling: ${maxY}`);
  assert(maxY >= 0.6 - 1e-3 - 0.0001 && bumped, `no clean bump (maxY=${maxY})`);
  // crouch under low roof, release crouch -> stays crouched, walk out -> stands
  const c = spawned(w, 4, 0, 0);
  run(c, w, cmd(BTN.CROUCH | BTN.FORWARD, -Math.PI / 2), 100);
  assert(c.x > 6.5 && c.x < 11.5 && c.crouching, `not under roof crouched (x=${c.x})`);
  run(c, w, cmd(0), 30);
  assert(c.crouching && c.y === 0, 'stood up under the roof');
  assert(hitboxHeight(c) === PLAYER.crouchHeight, 'hitbox height crouched');
  run(c, w, cmd(BTN.FORWARD, -Math.PI / 2), 120);
  assert(c.x > 12.5 && !c.crouching && hitboxHeight(c) === PLAYER.height, `did not stand after leaving (x=${c.x})`);
  assert(Math.abs(eyeHeight(c) - PLAYER.eyeHeight) < 1e-9, 'eye height back to standing');
  // crouched jump under the roof does not lift you into it
  const d = spawned(w, 9, 0, 0);
  run(d, w, cmd(BTN.CROUCH), 10);
  run(d, w, cmd(BTN.CROUCH | BTN.JUMP), 60, (st) => assert(st.y + PLAYER.crouchHeight <= 1.5 + 1e-3, 'crouch-jump into roof'));
});

test('seams: tiled floor and segmented walls never catch (walk, slide, wall-hug)', () => {
  const boxes = [];
  for (let i = -20; i < 20; i++) for (let j = -20; j < 20; j++) boxes.push(box(i, -1, j, i + 1, 0, j + 1));
  for (let j = -20; j < 20; j++) boxes.push(box(10, 0, j, 11, 3, j + 1)); // wall at x=10 from 1 m segments
  for (let j = -20; j < 20; j += 2) boxes.push(box(-12, 0, j, -11, 3, j + 2));
  const fx = mapOf(boxes);
  const w = createWorld(fx);
  // run diagonally into the segmented wall and along it
  const s = spawned(w, 8, 0, 15);
  let minAlong = Infinity;
  run(s, w, cmd(BTN.FORWARD | BTN.RIGHT, 0), 150, (st, i) => {
    assert(st.y === 0 && st.onGround, `left floor at tick ${i}: y=${st.y}`);
    assert(st.x + PLAYER.halfWidth <= 10 + 1e-3, 'into wall');
    if (i > 40) minAlong = Math.min(minAlong, -st.vz);
  });
  assert(Math.abs(s.x + PLAYER.halfWidth - 10) < 1e-3, 'not hugging the wall');
  assert(minAlong > 4.9, `caught on a seam (min speed along wall ${minAlong})`); // 7 * cos(45deg)
  // high-speed slides in many directions across tile seams
  for (let a = 0; a < 16; a++) {
    const yaw = a * Math.PI / 8 + 0.01;
    const t = spawned(w, -3, 0, 0);
    t.vx = -Math.sin(yaw) * 12; t.vz = -Math.cos(yaw) * 12;
    let prev = hs(t);
    run(t, w, cmd(BTN.CROUCH | BTN.FORWARD, yaw), 30, (st) => {
      assert(st.y === 0 && st.onGround, 'slide left floor');
      const v = hs(st);
      assert(v <= prev + 1e-3 || st.sliding, 'speed jump');
      if (v < prev - 1.5) throw new Error(`slide caught on seam (${prev} -> ${v})`);
      prev = v;
    });
  }
  note(`min along-wall speed ${f2(minAlong)} m/s`);
});

test('corners: pushing into a corner is jitter-free and penetration-free', () => {
  const w = createWorld(mapOf([FLOOR(), box(5, 0, -10, 6, 3, 10), box(-10, 0, -6, 10, 3, -5), box(-10, 0, 5, -2, 0.3, 6)]));
  const s = spawned(w, 0, 0, 0);
  const yaw = Math.PI * 1.75; // forward = (+x, -z) diagonal into the corner
  run(s, w, cmd(BTN.FORWARD, yaw), 120);
  const ref = copyState(createPlayerState(), s);
  run(s, w, cmd(BTN.FORWARD, yaw), 300, (st) => {
    assert(st.x === ref.x && st.y === ref.y && st.z === ref.z, `jitter ${st.x} ${st.z}`);
  });
  assert(Math.abs(s.x - (5 - PLAYER.halfWidth)) < 1e-4 && Math.abs(s.z - (-5 + PLAYER.halfWidth)) < 1e-4, 'not in corner');
  for (const yawJ of [0.1, 0.5, 1.0, 1.4]) {
    const t = spawned(w, 0, 0, 0);
    run(t, w, cmd(BTN.FORWARD | BTN.JUMP | BTN.RIGHT, Math.PI * 1.5 + yawJ), 400,
      (st) => assert(penetration({ boxes: [box(5, 0, -10, 6, 3, 10), box(-10, 0, -6, 10, 3, -5)] }, st) < 1e-3, 'penetration'));
  }
});

test('depenetration: spawned slightly inside floor / wall / under a ledge gets pushed out', () => {
  const fx = mapOf([FLOOR(), box(3, 0, -5, 4, 3, 5), box(-5, 0, -5, -3, 0.3, 5)]);
  const w = createWorld(fx);
  for (const [x, y, z] of [[0, -0.2, 0], [2.75, 0, 0], [3.2, 0, 0], [-3.1, 0, 0], [-3.3, 0.1, 1], [0, -0.01, 0]]) {
    const s = spawnState(createPlayerState(), x, y, z);
    run(s, w, cmd(), 3);
    assert(penetration(fx, s) < 1e-3, `still inside at ${x},${y},${z}: ${s.x},${s.y},${s.z}`);
    run(s, w, cmd(), 60);
    assert(s.onGround && penetration(fx, s) < 1e-3, `not settled at ${x},${y},${z}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Movement feel

const OPEN = createWorld(mapOf([box(-500, -1, -500, 500, 0, 500)], 500));

test('ground: snappy accel/stop, plain running never exceeds run speed', () => {
  const s = spawned(OPEN, 0, 0, 0);
  let t90 = -1;
  run(s, OPEN, cmd(BTN.FORWARD), 60, (st, i) => { if (t90 < 0 && hs(st) >= 0.9 * MOVE.runSpeed) t90 = i + 1; });
  assert(Math.abs(hs(s) - MOVE.runSpeed) < 1e-4, `run speed ${hs(s)}`);
  let tStop = -1;
  run(s, OPEN, cmd(0), 60, (st, i) => { if (tStop < 0 && hs(st) === 0) tStop = i + 1; });
  assert(t90 > 0 && t90 * DT <= 0.15, `accel too slow: ${t90} ticks`);
  assert(tStop > 0 && tStop * DT <= 0.25, `stop too slow: ${tStop} ticks`);
  // random strafing and turning on the ground for 20 s
  const r = rng(5);
  const c = cmd(BTN.FORWARD);
  let maxV = 0;
  for (let i = 0; i < 1200; i++) {
    if (i % 7 === 0) c.buttons = [BTN.FORWARD, BTN.FORWARD | BTN.LEFT, BTN.FORWARD | BTN.RIGHT, BTN.LEFT, BTN.RIGHT, BTN.BACK | BTN.LEFT][(r() * 6) | 0];
    c.yaw += (r() - 0.5) * 0.4;
    stepPlayer(s, c, OPEN);
    maxV = Math.max(maxV, hs(s));
  }
  assert(maxV <= MOVE.runSpeed + 1e-4, `plain running reached ${maxV}`);
  // crouch-walk and scout ADS caps
  const k = spawned(OPEN, 0, 0, 0);
  run(k, OPEN, cmd(BTN.CROUCH | BTN.FORWARD | BTN.LEFT), 120);
  assert(Math.abs(hs(k) - MOVE.crouchSpeed) < 1e-4 && !k.sliding, `crouch walk ${hs(k)}`);
  // the speed multiplier comes from the caller (weapons.moveSpeedMult); cmd.weapon is ignored
  const a = spawned(OPEN, 0, 0, 0);
  for (let i = 0; i < 120; i++) stepPlayer(a, cmd(BTN.FORWARD | BTN.ADS, 0, 1), OPEN, 0.95 * 0.5);
  assert(Math.abs(hs(a) - MOVE.runSpeed * 0.95 * 0.5) < 1e-4, `aimed sniper speed ${hs(a)}`);
  const b = spawned(OPEN, 0, 0, 0);
  run(b, OPEN, cmd(BTN.FORWARD | BTN.ADS, 0, 1), 120);
  assert(Math.abs(hs(b) - MOVE.runSpeed) < 1e-4, `default multiplier must be 1 (${hs(b)})`);
  for (const bad of [NaN, -1, 0, Infinity, 'x']) {
    const c = spawned(OPEN, 0, 0, 0);
    for (let i = 0; i < 60; i++) stepPlayer(c, cmd(BTN.FORWARD), OPEN, bad);
    assert(Math.abs(hs(c) - MOVE.runSpeed) < 1e-4, `invalid multiplier ${bad} must act as 1 (${hs(c)})`);
  }
  const f = spawned(OPEN, 0, 0, 0);
  for (let i = 0; i < 120; i++) stepPlayer(f, cmd(BTN.FORWARD), OPEN, 1.1);
  assert(Math.abs(hs(f) - MOVE.runSpeed * 1.1) < 1e-4, `fast multiplier ${hs(f)}`);
  note(`90% run speed in ${t90} ticks, full stop in ${tStop} ticks`);
});

test('jump: apex 1.2-1.4 m, holding jump auto-hops, air keeps horizontal speed', () => {
  const s = spawned(OPEN, 0, 0, 0);
  let apex = 0, jumps = 0, wasG = true;
  run(s, OPEN, cmd(BTN.JUMP), 300, (st) => {
    apex = Math.max(apex, st.y);
    if (wasG && !st.onGround) jumps++;
    wasG = st.onGround;
  });
  assert(apex >= 1.2 && apex <= 1.4, `apex ${apex}`);
  assert(jumps >= 7, `auto-hop: only ${jumps} jumps in 5 s`);
  // horizontal speed preserved while airborne with W held (no gain, no loss)
  const t = spawned(OPEN, 0, 0, 0);
  t.vx = 0; t.vz = -11;
  stepPlayer(t, cmd(BTN.JUMP | BTN.FORWARD), OPEN);
  const v0 = hs(t);
  run(t, OPEN, cmd(BTN.FORWARD), 30, (st) => assert(Math.abs(hs(st) - v0) < 1e-5, 'air speed changed'));
  note(`apex ${apex.toFixed(3)} m, ${jumps} hops in 5 s`);
});

test('air strafe: turning with strafe key bends the path and gains a little speed', () => {
  const s = spawnState(createPlayerState(), 0, 50, 0);
  s.vz = -10;
  const c = cmd(BTN.RIGHT);
  const h0 = Math.atan2(-s.vx, -s.vz);
  run(s, OPEN, c, 36, (st) => { c.yaw = Math.atan2(-st.vx, -st.vz); });
  const turned = Math.abs(Math.atan2(-s.vx, -s.vz) - h0);
  const v = hs(s);
  assert(v > 10.3 && v < 12, `strafe gain ${v}`);
  assert(turned > 0.5, `turn ${turned} rad`);
  // strafe held without turning: speed is bounded and does not run away
  const u = spawnState(createPlayerState(), 0, 50, 0);
  u.vz = -10;
  run(u, OPEN, cmd(BTN.RIGHT), 36);
  assert(hs(u) < 10.5, `no-turn strafe gained ${hs(u)}`);
  note(`0.6 s: ${f2(v)} m/s, turned ${(turned * 180 / Math.PI).toFixed(0)} deg`);
});

// Scripted slide-hop: hold W + jump (auto-hop); release crouch in the air, press it from
// `crouchBefore` ticks before the expected landing. Returns per-landing speeds.
// slideTicks counts ticks since the last slide boost; it is 1 right after a boost tick.
function boosted(s) { return s.slideTicks === 1; }
function slideHopRun(hops, opts = {}) {
  const s = spawned(OPEN, 0, 0, 0);
  run(s, OPEN, cmd(BTN.FORWARD), 60);
  const speeds = [];
  let maxV = 0, airT = 0, wasGround = true;
  const c = cmd(BTN.FORWARD | BTN.JUMP);
  for (let i = 0; i < hops * 40 + 40 && speeds.length < hops; i++) {
    // crouch on the ground tick (land crouched) and late in the air; released right after the hop
    const crouch = s.onGround || airT >= (opts.crouchFrom ?? 30);
    c.buttons = BTN.FORWARD | BTN.JUMP | (crouch ? BTN.CROUCH : 0);
    stepPlayer(s, c, OPEN);
    if (boosted(s)) speeds.push(hs(s));
    airT = s.onGround ? 0 : airT + 1;
    maxV = Math.max(maxV, hs(s));
    wasGround = s.onGround;
  }
  return { speeds, maxV, s };
}

test('slide-hop: each hop gains noticeably, speed is hard-capped', () => {
  const { speeds, maxV } = slideHopRun(8);
  assert(speeds.length >= 5, `only ${speeds.length} boosted hops: ${speeds.map(f2)}`);
  assert(speeds[0] >= MOVE.runSpeed * 1.2, `first hop gain too small: ${speeds[0]}`);
  for (let i = 1; i < speeds.length; i++) {
    if (speeds[i - 1] < MOVE.maxSpeed - 0.01) assert(speeds[i] > speeds[i - 1] + 1.0, `hop ${i} gain too small: ${speeds.map(f2)}`);
  }
  assert(maxV <= MOVE.maxSpeed + 1e-4, `cap exceeded: ${maxV}`);
  assert(speeds[speeds.length - 1] >= MOVE.maxSpeed - 0.05, `cap not reached: ${speeds.map(f2)}`);
  note(`hop speeds ${speeds.map(f2).join(' > ')}`);
});

test('slide-hop: holding crouch+jump the whole time only boosts on the cooldown', () => {
  const s = spawned(OPEN, 0, 0, 0);
  run(s, OPEN, cmd(BTN.FORWARD), 60);
  let boosts = 0;
  const ticks = 600;
  run(s, OPEN, cmd(BTN.FORWARD | BTN.JUMP | BTN.CROUCH), 0);
  for (let i = 0; i < ticks; i++) {
    stepPlayer(s, cmd(BTN.FORWARD | BTN.JUMP | BTN.CROUCH), OPEN);
    if (boosted(s)) boosts++;
  }
  const allowed = Math.ceil(ticks / MOVE.slideBoostCooldownTicks) + 1;
  assert(boosts <= allowed, `${boosts} boosts in ${ticks} ticks (allowed ${allowed})`);
  note(`${boosts} boosts in 10 s, final ${f2(hs(s))} m/s`);
});

test('slide: on flat ground it decays smoothly and ends; crouch spam cannot re-boost', () => {
  const s = spawned(OPEN, 0, 0, 0);
  run(s, OPEN, cmd(BTN.FORWARD), 60);
  stepPlayer(s, cmd(BTN.FORWARD | BTN.CROUCH), OPEN);
  assert(s.sliding && Math.abs(hs(s) - Math.min(MOVE.maxSpeed, MOVE.runSpeed * MOVE.slideBoost)) < 0.2, `slide start ${hs(s)}`);
  const peak = hs(s);
  let prev = peak, ticks = 0;
  while (s.sliding && ticks < 600) {
    stepPlayer(s, cmd(BTN.FORWARD | BTN.CROUCH), OPEN);
    assert(hs(s) <= prev + 1e-5, 'slide sped up on flat ground');
    prev = hs(s); ticks++;
  }
  assert(!s.sliding && ticks * DT < 2.0 && ticks * DT > 0.4, `slide lasted ${ticks * DT} s`);
  note(`slide ${f2(peak)} m/s -> ended after ${(ticks * DT).toFixed(2)} s`);
  // spam crouch on flat ground for 6 s
  const t = spawned(OPEN, 0, 0, 0);
  run(t, OPEN, cmd(BTN.FORWARD), 60);
  let boosts = 0, maxV = 0;
  const c = cmd(BTN.FORWARD);
  for (let i = 0; i < 360; i++) {
    c.buttons = BTN.FORWARD | ((i % 8) < 5 ? BTN.CROUCH : 0);
    stepPlayer(t, c, OPEN);
    if (boosted(t)) boosts++;
    maxV = Math.max(maxV, hs(t));
  }
  assert(boosts <= Math.ceil(360 / MOVE.slideBoostCooldownTicks), `${boosts} boosts from crouch spam`);
  assert(maxV <= MOVE.runSpeed * MOVE.slideBoost + 1e-3, `crouch spam reached ${maxV}`);
  // a slide does not boost again when restarted without a jump inside the cooldown
  const u = spawned(OPEN, 0, 0, 0);
  run(u, OPEN, cmd(BTN.FORWARD), 60);
  run(u, OPEN, cmd(BTN.FORWARD | BTN.CROUCH), 3);
  const v1 = hs(u);
  run(u, OPEN, cmd(BTN.FORWARD), 1);
  stepPlayer(u, cmd(BTN.FORWARD | BTN.CROUCH), OPEN);
  assert(hs(u) <= v1 + 1e-6, 're-boosted inside cooldown');
  note(`crouch spam: ${boosts} boosts in 6 s, max ${f2(maxV)} m/s`);
});

test('slide: landing crouched starts a slide, jumping out keeps momentum', () => {
  const s = spawned(OPEN, 0, 0, 0);
  run(s, OPEN, cmd(BTN.FORWARD), 60);
  stepPlayer(s, cmd(BTN.FORWARD | BTN.JUMP), OPEN);
  while (!s.onGround) stepPlayer(s, cmd(BTN.FORWARD | BTN.CROUCH), OPEN);
  stepPlayer(s, cmd(BTN.FORWARD | BTN.CROUCH), OPEN);
  assert(s.sliding, 'no slide on crouched landing');
  run(s, OPEN, cmd(BTN.FORWARD | BTN.CROUCH), 10);
  const v = hs(s);
  stepPlayer(s, cmd(BTN.FORWARD | BTN.CROUCH | BTN.JUMP), OPEN);
  assert(!s.onGround && !s.sliding && Math.abs(hs(s) - v) < 0.05, `jump lost momentum ${v} -> ${hs(s)}`);
});

// ---------------------------------------------------------------------------------------------
// Raycasts

function bruteRay(map, ox, oy, oz, dx, dy, dz, maxDist) {
  let best = Infinity;
  for (const b of map.boxes) {
    let tn = -Infinity, tf = Infinity;
    const o = [ox, oy, oz], d = [dx, dy, dz];
    let miss = false;
    for (let a = 0; a < 3; a++) {
      const lo = Math.fround(Math.min(b.min[a], b.max[a])), hi = Math.fround(Math.max(b.min[a], b.max[a]));
      if (d[a] === 0) { if (o[a] < lo || o[a] > hi) miss = true; continue; }
      let t1 = (lo - o[a]) / d[a], t2 = (hi - o[a]) / d[a];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tn = Math.max(tn, t1); tf = Math.min(tf, t2);
    }
    if (miss || tn > tf || tf < 0) continue;
    best = Math.min(best, Math.max(0, tn));
  }
  return best <= maxDist ? best : Infinity;
}

test('raycastWorld: fixture distances + normals, matches brute force on 30k random rays', () => {
  const fx = mapOf([FLOOR(), box(5, 0, -1, 6, 3, 1), box(-2, 2, -2, 2, 2.5, 2)]);
  const w = createWorld(fx);
  const n = [0, 0, 0];
  let t = raycastWorld(w, 0, 1, 0, 1, 0, 0, 100, n);
  assert(Math.abs(t - 5) < 1e-6 && n[0] === -1 && n[1] === 0, `wall hit ${t} ${n}`);
  t = raycastWorld(w, 0, 1, 0, 0, -1, 0, 100, n);
  assert(Math.abs(t - 1) < 1e-6 && n[1] === 1, `floor hit ${t} ${n}`);
  t = raycastWorld(w, 0, 1, 0, 0, 1, 0, 100, n);
  assert(Math.abs(t - 1) < 1e-6 && n[1] === -1, `ceiling hit ${t} ${n}`);
  assert(raycastWorld(w, 0, 1, 0, 1, 0, 0, 4.9) === Infinity, 'maxDist');
  assert(raycastWorld(w, 0, 10, 0, 0, 1, 0, 100) === Infinity, 'miss into sky');
  t = raycastWorld(w, -300, 1, 0.5, 1, 0, 0, 1000, n); // from outside the grid
  assert(Math.abs(t - 305) < 1e-6 && n[0] === -1, `outside origin ${t}`);
  t = raycastWorld(w, 5.5, 1, 0, 1, 0, 0, 100, n);
  assert(t === 0, 'origin inside box -> 0');
  let checked = 0;
  for (const [map, wd] of [[MAP, world], [fx, w]]) {
    const r = rng(1234);
    const b = map.bounds;
    for (let i = 0; i < 15000; i++) {
      const ox = b.min[0] + r() * (b.max[0] - b.min[0]), oy = r() * 8, oz = b.min[2] + r() * (b.max[2] - b.min[2]);
      let dx = r() - 0.5, dy = (r() - 0.6) * 0.6, dz = r() - 0.5;
      if (i % 50 === 0) { dx = 0; dz = 0; dy = -1; }
      if (i % 37 === 0) dy = 0;
      if (i % 41 === 0) dx = 0;
      const L = Math.hypot(dx, dy, dz); dx /= L; dy /= L; dz /= L;
      const md = i % 3 === 0 ? 30 : 400;
      const a = raycastWorld(wd, ox, oy, oz, dx, dy, dz, md, n);
      const e = bruteRay(map, ox, oy, oz, dx, dy, dz, md);
      assert(a === e || Math.abs(a - e) < 1e-6, `ray ${i} mismatch: grid ${a} vs brute ${e}`);
      checked++;
    }
  }
  note(`${checked} rays`);
});

test('raycastPlayer: body, head zone, crouched height, misses and maxDist', () => {
  const px = 0, py = 0, pz = -10, H = PLAYER.height, C = PLAYER.crouchHeight;
  let h = raycastPlayer(0, 1.0, 0, 0, 0, -1, px, py, pz, H, 100);
  assert(h && Math.abs(h.t - (10 - PLAYER.halfWidth)) < 1e-9 && !h.head, 'body hit');
  h = raycastPlayer(0, 1.6, 0, 0, 0, -1, px, py, pz, H, 100);
  assert(h && h.head, 'head hit standing');
  h = raycastPlayer(0, H - PLAYER.headSize - 0.01, 0, 0, 0, -1, px, py, pz, H, 100);
  assert(h && !h.head, 'just below head zone');
  assert(raycastPlayer(0, 1.6, 0, 0, 0, -1, px, py, pz, C, 100) === null, 'crouched: 1.6 m passes overhead');
  h = raycastPlayer(0, 0.9, 0, 0, 0, -1, px, py, pz, C, 100);
  assert(h && h.head, 'crouched head zone');
  h = raycastPlayer(0, 0.5, 0, 0, 0, -1, px, py, pz, C, 100);
  assert(h && !h.head, 'crouched body');
  assert(raycastPlayer(0, 1.0, 0, 0, 0, 1, px, py, pz, H, 100) === null, 'behind');
  assert(raycastPlayer(0.5, 1.0, 0, 0, 0, -1, px, py, pz, H, 100) === null, 'beside');
  assert(raycastPlayer(0, 1.0, 0, 0, 0, -1, px, py, pz, H, 9) === null, 'maxDist');
  // diagonal from above into the top face -> head
  const d = [0, -Math.SQRT1_2, -Math.SQRT1_2];
  h = raycastPlayer(0, 11.79, 0, d[0], d[1], d[2], px, py, pz, H, 100);
  assert(h && h.head, 'top face hit is a headshot');
  // eye of a shooter standing inside the target
  h = raycastPlayer(0, 1.0, -10, 0, 0, -1, px, py, pz, H, 100);
  assert(h && h.t === 0, 'origin inside');
});

// ---------------------------------------------------------------------------------------------
// Current map: robustness + benchmark

test('current map: 20 random bots x 60 s never penetrate geometry or produce NaN', () => {
  let maxPen = 0, maxV = 0;
  for (let p = 0; p < 20; p++) {
    const sp = MAP.spawns[p % MAP.spawns.length];
    const s = spawnState(createPlayerState(), sp.pos[0], sp.pos[1], sp.pos[2]);
    const r = rng(500 + p), c = cmd(0, sp.yaw), inp = {};
    for (let i = 0; i < 3600; i++) {
      randomInput(r, c, inp);
      stepPlayer(s, c, world);
      if (i % 3 === 0) maxPen = Math.max(maxPen, penetration(MAP, s));
      maxV = Math.max(maxV, hs(s));
      assert(Number.isFinite(s.x + s.y + s.z + s.vx + s.vy + s.vz), 'NaN');
      assert(s.y > MAP.killY, `fell out of the map at ${s.x},${s.y},${s.z}`);
    }
  }
  assert(maxPen < 1e-3, `penetration ${maxPen}`);
  assert(maxV <= MOVE.maxSpeed + 1e-4, `speed ${maxV}`);
  note(`${MAP.boxes.length} boxes, grid ${world.nx}x${world.nz}, max penetration ${maxPen.toExponential(1)}`);
});

test('benchmark: stepPlayer on the current map', () => {
  const N = 20, T = 6000;
  const players = [], cmds = [], rs = [], inps = [];
  for (let p = 0; p < N; p++) {
    const sp = MAP.spawns[p % MAP.spawns.length];
    players.push(spawnState(createPlayerState(), sp.pos[0], sp.pos[1], sp.pos[2]));
    cmds.push(cmd(0, sp.yaw)); rs.push(rng(900 + p)); inps.push({});
  }
  // pre-generate inputs so only stepPlayer is timed
  const stream = [];
  for (let i = 0; i < T; i++) for (let p = 0; p < N; p++) { randomInput(rs[p], cmds[p], inps[p]); stream.push({ ...cmds[p] }); }
  for (let i = 0; i < 600; i++) for (let p = 0; p < N; p++) stepPlayer(players[p], stream[i * N + p], world); // warm-up
  const t0 = process.hrtime.bigint();
  for (let i = 600; i < T; i++) for (let p = 0; p < N; p++) stepPlayer(players[p], stream[i * N + p], world);
  const t1 = process.hrtime.bigint();
  const us = Number(t1 - t0) / 1000 / ((T - 600) * N);
  // raycasts
  const r = rng(77), out = [0, 0, 0];
  const rays = [];
  for (let i = 0; i < 20000; i++) {
    let dx = r() - 0.5, dy = (r() - 0.6) * 0.4, dz = r() - 0.5; const L = Math.hypot(dx, dy, dz);
    rays.push([(r() - 0.5) * 60, 1 + r() * 2, (r() - 0.5) * 60, dx / L, dy / L, dz / L]);
  }
  const t2 = process.hrtime.bigint();
  let sink = 0;
  for (let k = 0; k < 5; k++) for (const q of rays) { const d = raycastWorld(world, q[0], q[1], q[2], q[3], q[4], q[5], 250, out); if (d < 1e9) sink += d; }
  const t3 = process.hrtime.bigint();
  const usRay = Number(t3 - t2) / 1000 / (rays.length * 5);
  console.log(`      stepPlayer: ${us.toFixed(2)} us/step (${N} players, ${T - 600} ticks, ${MAP.boxes.length} boxes); raycastWorld: ${usRay.toFixed(2)} us/ray`);
  assert(us < 20, `too slow: ${us} us`);
  note(`${us.toFixed(2)} us/step, ${usRay.toFixed(2)} us/ray, sink ${sink > 0}`);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
