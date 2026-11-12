#!/usr/bin/env node
// Unit checks for shared/weapons.js (+ the loadout parts of shared/protocol.js).
// Plain Node asserts:  node tools/weapons.test.js

import assert from 'node:assert/strict';
import { BTN } from '../shared/constants.js';
import {
  GUNS, ATTACHMENTS, SLOT_COUNT, ATT_COUNT, MAX_ATTACHMENTS, DEFAULT_LOADOUT_CODE, DEFAULT_KIT, WEAPONS,
  sanitizeLoadout, encodeLoadout, decodeLoadout, sanitizeLoadoutCode, sanitizeMask, popcount6, listToMask, maskToList,
  toggleAttachment, canAddAttachment, effectiveStats, getKit, damageAt, falloffAt, ttkMs, shotsToKill,
  createWeaponState, resetWeaponState, copyWeaponState, sameWeaponState, stepWeapon, moveSpeedMult, aimFraction,
  WSTATE_BYTES, writeWeaponState, readWeaponState, displayStats, compareStats, STAT_KEYS, attachmentText,
  writeLoadout, readLoadout, shotDir,
} from '../shared/weapons.js';
import {
  encodeJoin, encodeSetLoadout, parseLoadoutCode, encodeSnapshot, decodeSnapshot, PROTOCOL_VERSION,
} from '../shared/protocol.js';
import { createPlayerState } from '../shared/physics.js';

let passes = 0, failures = 0;
function test(name, fn) {
  try { fn(); passes++; console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`); }
}
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const legalMasks = [];
for (let m = 0; m < 64; m++) if (popcount6(m) <= MAX_ATTACHMENTS) legalMasks.push(m);

test('tables: six guns (2 per slot, ids = slot*2+variant), six attachments with unique areas, strings present', () => {
  assert.equal(GUNS.length, 6);
  GUNS.forEach((g, i) => {
    assert.equal(g.id, i); assert.equal(g.slot * 2 + g.variant, i);
    for (const k of ['name', 'key', 'desc', 'pro', 'con', 'blurb']) assert.ok(typeof g[k] === 'string' && g[k].length > 2, `${g.key}.${k}`);
  });
  assert.equal(ATTACHMENTS.length, ATT_COUNT);
  assert.equal(new Set(ATTACHMENTS.map((a) => a.area)).size, ATT_COUNT);
  for (const a of ATTACHMENTS) for (const cls of ['assault', 'sniper', 'shotgun']) {
    const t = attachmentText(a.id, cls);
    assert.ok(t.pro.length > 3 && t.con.length > 3 && t.name === a.name, `${a.key}/${cls} text`);
  }
  assert.equal(WEAPONS.length, SLOT_COUNT);
  assert.deepEqual(WEAPONS.map((w) => w.key), ['rifle', 'scout', 'shotgun']);
});

test('sanitizeLoadout: drops unknown ids, enforces the 3 limit, keeps guns in their slot, accepts keys / variants / codes', () => {
  assert.deepEqual(sanitizeLoadout(null), decodeLoadout(DEFAULT_LOADOUT_CODE));
  assert.deepEqual(sanitizeLoadout('junk'), decodeLoadout(DEFAULT_LOADOUT_CODE));
  const l = sanitizeLoadout({ slots: [
    { gun: 'vireo', att: ['optic', 'nope', 99, 'heavy', 'barrel', 'stock'] },   // 4 valid -> first 3
    { gun: 5, att: 0xff },                                                    // shotgun in sniper slot -> kestrel; mask trimmed
    { gun: 1, attachments: [5, 5, 'quick', 1] },                              // bare variant 1 -> squall; dupes dropped
  ] });
  assert.equal(l.slots[0].gun, 1);
  assert.deepEqual(maskToList(l.slots[0].att), [0, 2, 3]);
  assert.equal(l.slots[1].gun, 2);
  assert.equal(popcount6(l.slots[1].att), 3);
  assert.equal(l.slots[2].gun, 5);
  assert.deepEqual(maskToList(l.slots[2].att), [1, 5]);
  for (let m = 0; m < 256; m++) { const s = sanitizeMask(m); assert.ok(popcount6(s) <= 3 && (s & ~63) === 0); }
  assert.equal(listToMask(['optic', 'optic', 'extmag']), 3);
  // toggle respects the limit
  let m = 0;
  for (const k of [0, 1, 2, 3]) m = toggleAttachment(m, k);
  assert.equal(m, 0b0111);
  assert.equal(canAddAttachment(m, 4), false); assert.equal(canAddAttachment(m, 1), true);
  assert.equal(toggleAttachment(m, 1), 0b0101);
  assert.deepEqual(sanitizeLoadout(encodeLoadout(l)), l);
});

test('loadout encoding: 3 bytes, exact round trip for every legal per-slot choice, garbage decodes to something legal', () => {
  for (let s = 0; s < SLOT_COUNT; s++) for (const v of [0, 1]) for (const m of legalMasks) {
    const slots = [{ gun: 0, att: 0 }, { gun: 2, att: 0 }, { gun: 4, att: 0 }];
    slots[s] = { gun: s * 2 + v, att: m };
    const code = encodeLoadout({ slots });
    assert.ok(Number.isInteger(code) && code >= 0 && code < (1 << 24));
    assert.deepEqual(decodeLoadout(code).slots, slots);
    assert.equal(sanitizeLoadoutCode(code), code);
    const dv = new DataView(new ArrayBuffer(3));
    writeLoadout(dv, 0, code);
    assert.equal(readLoadout(dv, 0), code);
  }
  const r = rng(3);
  for (let i = 0; i < 20000; i++) {
    const c = Math.floor(r() * 0x1000000);
    const l = decodeLoadout(c);
    l.slots.forEach((e, s) => { assert.equal(GUNS[e.gun].slot, s); assert.ok(popcount6(e.att) <= 3); });
    assert.equal(decodeLoadout(encodeLoadout(l)).slots.length, 3);
  }
  for (const bad of [-1, 1.5, 2 ** 24, NaN, '7', null]) assert.deepEqual(decodeLoadout(bad), decodeLoadout(0));
  assert.equal(parseLoadoutCode('x', 42), 42);
  assert.equal(parseLoadoutCode(0xffffff, 0), sanitizeLoadoutCode(0xffffff));
  assert.equal(JSON.parse(encodeJoin('a', 'r', undefined, 0x020103)).lo, sanitizeLoadoutCode(0x020103));
  assert.equal(JSON.parse(encodeJoin('a')).lo, undefined);
  assert.deepEqual(JSON.parse(encodeSetLoadout(0x0b)), { t: 'loadout', lo: 0x0b });
  assert.equal(PROTOCOL_VERSION, 4);   // v4: modes / teams / lobby (loadout encoding unchanged since v3)
});

test('effective stats: cached + frozen; bare = base; every attachment\'s gain and cost are real on every gun', () => {
  const dir = { // field: +1 = attachment raises it, -1 lowers it (gain, cost)
    optic: [['adsFov', -1], ['adsTicks', +1], ['adsMoveMult', -1]],
    extmag: [['magSize', +1], ['reloadTicks', +1]],
    heavy: [['damage', +1], ['fireTicks', +1]],
    barrel: [['falloffStart', +1], ['falloffEnd', +1], ['hipSpread', -1], ['moveMult', -1]],
    stock: [['moveMult', +1], ['adsTicks', -1], ['hipSpread', +1]],
    quick: [['reloadTicks', -1], ['swapTicks', -1], ['magSize', -1]],
  };
  for (const g of GUNS) {
    const bare = effectiveStats(g.id, 0);
    assert.ok(Object.isFrozen(bare) && effectiveStats(g.id, 0) === bare);
    for (const k of Object.keys(g)) assert.equal(bare[k], g[k], `${g.key}.${k}`);
    for (const a of ATTACHMENTS) {
      const e = effectiveStats(g.id, 1 << a.id);
      for (const [f, s] of dir[a.key]) assert.ok(Math.sign(e[f] - bare[f]) === s, `${g.key}+${a.key}: ${f} ${bare[f]} -> ${e[f]}`);
      // optic always tightens (or perfects) aimed spread; stock always loosens it
      if (a.key === 'optic') assert.ok(e.adsSpread < bare.adsSpread);
      if (a.key === 'stock') assert.ok(e.adsSpread > bare.adsSpread);
    }
    for (const m of legalMasks) {
      const e = effectiveStats(g.id, m);
      for (const f of ['fireTicks', 'swapTicks', 'adsTicks', 'magSize']) assert.ok(Number.isInteger(e[f]) && e[f] >= 1 && e[f] <= 255, `${g.key}/${m} ${f}=${e[f]}`);
      assert.ok(Number.isInteger(e.reloadTicks) && e.reloadTicks <= 65535 && e.kick <= 255 && e.heatMax <= 255);
      const d = displayStats(g.id, m);
      for (const k of STAT_KEYS) assert.ok(Number.isInteger(d.ratings[k]) && d.ratings[k] >= 0 && d.ratings[k] <= 100, `${g.key}/${m} ${k}`);
      assert.ok(typeof d.values.damage === 'string');
    }
  }
  const c = compareStats(0, 0, 0, 1 << 1);
  assert.ok(c.magazine.delta > 0 && c.reload.delta < 0, 'extmag: magazine up, reload down in the UI comparison');
});

test('gun identities: light sniper 2 body / 1 head, heavy sniper 1 body at full health, auto shotgun loses badly at range', () => {
  const k = effectiveStats(2, 0), h = effectiveStats(3, 0), sq = effectiveStats(5, 0), pump = effectiveStats(4, 0);
  for (let d = 1; d <= 150; d += 1) {
    assert.equal(shotsToKill(k, d, false), 2, `kestrel body at ${d} m`);
    assert.equal(shotsToKill(k, d, true), 1, `kestrel head at ${d} m`);
  }
  for (let d = 1; d <= 60; d++) assert.equal(shotsToKill(h, d, false), 1, `halberd body at ${d} m`);
  const hh = effectiveStats(3, 1 << 2);   // heavy rounds: one-shot at any range
  for (let d = 1; d <= 400; d += 3) assert.equal(shotsToKill(hh, d, false), 1, `heavy halberd at ${d} m`);
  assert.ok(ttkMs(sq, 15) > 4 * ttkMs(sq, 5), 'squall at 15 m is far slower than at 5 m');
  assert.ok(sq.auto && sq.magSize >= 20 && sq.adsSpread > 0.9 * sq.hipSpread, 'squall is a full-auto hip-fire hose');
  assert.equal(shotsToKill(pump, 2, false), 1, 'breaker one-shots point blank');
  assert.ok(falloffAt(pump, 30) < 0.25 && damageAt(sq, 30) < 0.2 * damageAt(sq, 3));
  // assault rifles: maul hits harder, vireo fires faster
  assert.ok(GUNS[0].damage > GUNS[1].damage && GUNS[0].fireTicks > GUNS[1].fireTicks && GUNS[0].kick > GUNS[1].kick);
});

test('weapon state: fixed size, exact round trip, kit-driven mags / swap / aim / heat, deterministic', () => {
  const r = rng(11);
  const dv = new DataView(new ArrayBuffer(WSTATE_BYTES + 5));
  for (let trial = 0; trial < 40; trial++) {
    const code = encodeLoadout({ slots: [0, 1, 2].map((s) => ({ gun: s * 2 + (r() < 0.5 ? 0 : 1), att: legalMasks[Math.floor(r() * legalMasks.length)] })) });
    const kit = getKit(code);
    assert.equal(getKit(code), kit);
    const a = createWeaponState(kit), b = createWeaponState(kit), t = createWeaponState(kit);
    for (let s = 0; s < 3; s++) assert.equal(a.ammo[s], kit.slots[s].magSize);
    const cmd = { seq: 0, buttons: 0, yaw: 0, pitch: 0, weapon: 0 };
    let shots = 0, switched = 0;
    for (let i = 0; i < 2000; i++) {
      cmd.seq = i + 1;
      if (r() < 0.05) cmd.buttons = (r() < 0.6 ? BTN.FIRE : 0) | (r() < 0.4 ? BTN.ADS : 0) | (r() < 0.03 ? BTN.RELOAD : 0);
      if (r() < 0.01) cmd.weapon = Math.floor(r() * 3);
      const prevW = a.weapon;
      const fa = stepWeapon(a, cmd, kit), fb = stepWeapon(b, cmd, kit);
      assert.equal(fa, fb); assert.ok(sameWeaponState(a, b));
      if (fa) { shots++; assert.ok(a.spread >= 0 && a.spread < 0.5); }
      if (a.weapon !== prevW) { switched++; assert.equal(a.cooldown, kit.slots[a.weapon].swapTicks - 1); assert.equal(a.aim, (cmd.buttons & BTN.ADS) ? 1 : 0); }
      const e = kit.slots[a.weapon];
      assert.ok(a.aim <= e.adsTicks && a.heat <= Math.max(e.heatMax, 0) && a.ammo[a.weapon] <= e.magSize);
      const m = moveSpeedMult(kit, a);
      const f = aimFraction(kit, a);
      assert.ok(Math.abs(m - e.moveMult * (1 + (e.adsMoveMult - 1) * f)) < 1e-12);
      assert.equal(writeWeaponState(dv, 2, a), 2 + WSTATE_BYTES);
      assert.equal(readWeaponState(dv, 2, t), 2 + WSTATE_BYTES);
      assert.ok(sameWeaponState(a, t), `round trip at ${i}`);
      // replay from the deserialised state stays identical
      const u = copyWeaponState(createWeaponState(kit), t);
      const c2 = { ...cmd, seq: cmd.seq + 1 };
      stepWeapon(u, c2, kit); stepWeapon(copyWeaponState(t, a), c2, kit);
      assert.ok(sameWeaponState(u, t));
      copyWeaponState(t, a);
    }
    assert.ok(shots > 0 && switched >= 0);
  }
  // full aim reached after exactly adsTicks ticks, ADS speed then = moveMult * adsMoveMult
  const kit = getKit(encodeLoadout({ slots: [{ gun: 1, att: 1 }, { gun: 3, att: 0 }, { gun: 5, att: 0 }] }));
  const ws = createWeaponState(kit);
  const e = kit.slots[0];
  for (let i = 0; i < e.adsTicks; i++) stepWeapon(ws, { seq: i, buttons: BTN.ADS, yaw: 0, pitch: 0, weapon: 0 }, kit);
  assert.equal(aimFraction(kit, ws), 1);
  assert.ok(Math.abs(moveSpeedMult(kit, ws) - e.moveMult * e.adsMoveMult) < 1e-12);
  resetWeaponState(ws, DEFAULT_KIT);
  assert.equal(ws.ammo[0], DEFAULT_KIT.slots[0].magSize);
  // shotDir unchanged (determinism of the existing spread function)
  const o = shotDir([0, 0, 0], 0.3, -0.1, 0.05, 1234, 3);
  assert.ok(Math.abs(Math.hypot(o[0], o[1], o[2]) - 1) < 1e-12);
});

test('protocol: snapshot carries the gun in hand (player entries + shots), v3 weapon state in the self block', () => {
  const ws = createWeaponState(getKit(0x030303));
  ws.weapon = 2; ws.reload = 300; ws.aim = 7; ws.heat = 9; ws.ammo[2] = 4;
  const snap = {
    tick: 10, ackSeq: 5,
    you: { id: 1, alive: true, health: 100, respawnTicks: 0, state: createPlayerState(), weapon: ws },
    players: [0, 1, 2, 3, 4, 5].map((g) => ({ id: 2 + g, x: 1, y: 2, z: 3, yaw: 0, pitch: 0, alive: true, crouching: false, sliding: false,
      onGround: true, ads: false, reloading: false, weapon: GUNS[g].slot, gun: g, health: 100 - g })),
    shots: [0, 1, 2, 3, 4, 5].map((g) => ({ shooter: 2 + g, weapon: GUNS[g].slot, gun: g, kind: 2, victim: 0, x: 0, y: 0, z: 0, normal: null })),
  };
  const d = decodeSnapshot(encodeSnapshot(snap));
  assert.ok(d);
  d.players.forEach((p, i) => { assert.equal(p.gun, i); assert.equal(p.weapon, GUNS[i].slot); assert.equal(p.health, 100 - i); });
  d.shots.forEach((s, i) => { assert.equal(s.gun, i); assert.equal(s.weapon, GUNS[i].slot); });
  assert.ok(sameWeaponState(d.you.weapon, ws));
  assert.equal(decodeSnapshot(encodeSnapshot(snap).subarray(0, 40)), null, 'truncated snapshot rejected');
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
