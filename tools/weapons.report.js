#!/usr/bin/env node
// Weapon balance report: node tools/weapons.report.js [--trials 300] [--all] [--gun maul]
//
// For each gun bare and a few representative builds prints:
//   perfect TTK (every pellet hits) at 5/15/30/60 m, body and head;
//   practical TTK: the real stepWeapon + shotDir cone (aim, bloom, pellets, falloff, reloads)
//   fired at a standing target, averaged over many shot seeds, fully aimed (ADS) and from the hip;
//   effective range, mag dump time, reload, move speed, aim / swap time.
// Then a dominance sweep over every legal build (bare, 1, 2 and 3 attachments) per gun: which
// 3-attachment builds are Pareto-optimal on (practical TTK at 4 ranges, hip TTK close, move
// speed, aim time, reload, mag, swap) and whether any build beats every other one.
//
// The target is a standing player (PLAYER box) straight ahead; the aim point is the chest
// (body) or the centre of the head zone (head). Damage accrues exactly like the server
// (per pellet: damageAt(distance) x headMult on head hits).

import { BTN, PLAYER } from '../shared/constants.js';
import { raycastPlayer } from '../shared/physics.js';
import {
  GUNS, ATTACHMENTS, getKit, effectiveStats, createWeaponState, resetWeaponState, stepWeapon, shotDir,
  damageAt, ttkMs, effectiveRange, displayStats, popcount6, maskToList,
} from '../shared/weapons.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const TRIALS = parseInt(opt('trials', '300'), 10);
const ONLY = opt('gun', '');
const ALL = args.includes('--all');
const DISTS = [5, 15, 30, 60];
const EYE = PLAYER.eyeHeight;

function kitFor(gid, mask) {
  const g = GUNS[gid];
  const slots = [{ gun: 0, att: 0 }, { gun: 2, att: 0 }, { gun: 4, att: 0 }];
  slots[g.slot] = { gun: gid, att: mask };
  return getKit({ slots });
}

const dir = [0, 0, 0];
/** Mean practical TTK (ms) at distance d. Infinity entries (no kill in 6 s) count as 6000 ms. */
function practical(gid, mask, d, head, ads, trials = TRIALS) {
  const kit = kitFor(gid, mask);
  const slot = GUNS[gid].slot;
  const eff = kit.slots[slot];
  const ws = createWeaponState(kit);
  const aimY = head ? PLAYER.height - PLAYER.headSize / 2 : 1.2;
  const pitch = Math.atan2(aimY - EYE, d);
  const cmd = { seq: 0, buttons: 0, yaw: 0, pitch, weapon: slot };
  let sum = 0, fails = 0;
  for (let t = 0; t < trials; t++) {
    resetWeaponState(ws, kit);
    ws.weapon = slot;
    ws.aim = ads ? eff.adsTicks : 0;
    let hp = 100, tick = 0, first = -1;
    const base = 1000 + t * 7919;
    for (; tick < 360 && hp > 0; tick++) {
      const pull = eff.auto ? true : (ws.cooldown <= 1 && !ws.fireHeld);
      cmd.seq = base + tick;
      cmd.buttons = (pull ? BTN.FIRE : 0) | (ads ? BTN.ADS : 0);
      if (!stepWeapon(ws, cmd, kit)) continue;
      if (first < 0) first = tick;
      for (let p = 0; p < eff.pellets; p++) {
        shotDir(dir, 0, pitch, ws.spread, cmd.seq, p);
        const h = raycastPlayer(0, EYE, 0, dir[0], dir[1], dir[2], 0, 0, -d, PLAYER.height, eff.range);
        if (h) hp -= damageAt(eff, h.t, h.head);
      }
    }
    if (hp > 0) { fails++; sum += 6000; } else sum += (tick - 1 - first) * 1000 / 60;
  }
  return { ms: sum / trials, fail: fails / trials };
}

const pad = (s, n) => String(s).padStart(n);
const ms = (v) => (Number.isFinite(v) ? (v >= 6000 ? '  --' : String(Math.round(v))) : '  --');
const buildName = (mask) => (mask === 0 ? 'bare' : maskToList(mask).map((i) => ATTACHMENTS[i].key).join('+'));
const maskOf = (...keys) => keys.reduce((m, k) => m | (1 << ATTACHMENTS.findIndex((a) => a.key === k)), 0);

// representative builds per gun (bare is always included)
const BUILDS = {
  maul: [maskOf('optic', 'barrel', 'heavy'), maskOf('extmag', 'heavy'), maskOf('stock', 'quick')],
  vireo: [maskOf('stock', 'quick', 'extmag'), maskOf('optic', 'barrel'), maskOf('heavy', 'barrel', 'extmag')],
  kestrel: [maskOf('optic', 'stock'), maskOf('stock', 'quick'), maskOf('heavy', 'barrel', 'extmag')],
  halberd: [maskOf('optic', 'extmag'), maskOf('stock', 'quick'), maskOf('heavy', 'barrel', 'optic')],
  breaker: [maskOf('barrel', 'heavy'), maskOf('optic', 'barrel'), maskOf('stock', 'quick', 'extmag')],
  squall: [maskOf('extmag', 'stock'), maskOf('barrel', 'heavy'), maskOf('optic', 'barrel', 'heavy')],
};

function header() {
  console.log('build'.padEnd(30) +
    ' | perfect body 5/15/30/60    | perfect head 5/15/30/60    | aimed body 5/15/30/60      | aimed10 | aimed head 15/30 | hip body 5/10/15 ' +
    '| eff.rng | dump s | rld s | move m/s | aim ms | swap ms | mag');
}
function row(gid, mask) {
  const e = effectiveStats(gid, mask);
  const pb = DISTS.map((d) => ms(ttkMs(e, d, false)));
  const ph = DISTS.map((d) => ms(ttkMs(e, d, true)));
  const ab = DISTS.map((d) => ms(practical(gid, mask, d, false, true).ms));
  const ah = [15, 30].map((d) => ms(practical(gid, mask, d, true, true).ms));
  const hb = [5, 10, 15].map((d) => ms(practical(gid, mask, d, false, false).ms));
  const a10 = ms(practical(gid, mask, 10, false, true).ms);
  const rng = effectiveRange(e);
  console.log(`${(e.name + ' ' + buildName(mask)).padEnd(30)} | ${pb.map((v) => pad(v, 5)).join(' ')}    | ${ph.map((v) => pad(v, 5)).join(' ')}    | ` +
    `${ab.map((v) => pad(v, 5)).join(' ')}    | ${pad(a10, 7)} | ${ah.map((v) => pad(v, 5)).join(' ')}      | ${hb.map((v) => pad(v, 5)).join(' ')}   ` +
    `| ${pad(rng >= 120 ? '120+' : rng.toFixed(1), 7)} | ${pad(((e.magSize - 1) * e.fireTicks / 60).toFixed(2), 6)} | ${pad((e.reloadTicks / 60).toFixed(2), 5)} ` +
    `| ${pad((7 * e.moveMult).toFixed(2), 4)}/${(7 * e.moveMult * e.adsMoveMult).toFixed(2).padEnd(4)}| ${pad(Math.round(e.adsTicks * 1000 / 60), 6)} | ${pad(Math.round(e.swapTicks * 1000 / 60), 7)} | ${pad(e.magSize, 3)}`);
}

console.log(`Hopshot weapon balance report (${TRIALS} seeded trials per practical cell; ms; "--" = no kill in 6 s)\n`);
header();
for (const g of GUNS) {
  if (ONLY && g.key !== ONLY) continue;
  console.log('-'.repeat(200));
  row(g.id, 0);
  for (const m of BUILDS[g.key] || []) row(g.id, m);
}

// ------------------------------------------------------------------ dominance sweep
console.log('\nDominance sweep (all builds with <= 3 attachments; 3-attachment builds compared with each other):');
const allMasks = [];
for (let m = 0; m < 64; m++) if (popcount6(m) <= 3) allMasks.push(m);
for (const g of GUNS) {
  if (ONLY && g.key !== ONLY) continue;
  const vecs = [];
  for (const m of allMasks) {
    if (popcount6(m) !== 3 && !ALL) continue;
    const e = effectiveStats(g.id, m);
    const t = Math.max(40, TRIALS >> 2);
    // lower is better for every entry (speed and mag negated)
    const v = [
      ...DISTS.map((d) => Math.round(practical(g.id, m, d, false, true, t).ms / 10)),
      Math.round(practical(g.id, m, 5, false, false, t).ms / 10),
      -Math.round(e.moveMult * 100), -Math.round(e.moveMult * e.adsMoveMult * 100), e.adsTicks, e.reloadTicks, -e.magSize, e.swapTicks,
    ];
    vecs.push({ m, v });
  }
  const dominates = (a, b) => a.v.every((x, i) => x <= b.v[i]) && a.v.some((x, i) => x < b.v[i]);
  const optimal = vecs.filter((a) => !vecs.some((b) => b !== a && dominates(b, a)));
  const king = vecs.find((a) => vecs.every((b) => b === a || dominates(a, b)));
  // best-in-category: which build wins each combat metric
  const best = (i) => {
    const lo = Math.min(...vecs.map((x) => x.v[i]));
    const w = vecs.filter((x) => x.v[i] === lo);
    return w.length > 3 ? `${w.length} tied` : w.map((x) => buildName(x.m)).join(' | ');
  };
  const cats = ['ttk5', 'ttk15', 'ttk30', 'ttk60', 'hip5', 'move', 'adsMove', 'aim', 'reload', 'mag', 'swap'];
  console.log(`  ${g.name.padEnd(8)} ${optimal.length}/${vecs.length} builds Pareto-optimal; build that beats all others: ${king ? buildName(king.m) : 'none'}`);
  console.log('           best per metric: ' + cats.map((c, i) => `${c}=${best(i)}`).join(', '));
}

// ------------------------------------------------------------------ UI ratings
console.log('\nUI ratings (displayStats, bare):');
console.log('gun'.padEnd(10) + ['damage', 'fireRate', 'range', 'accuracy', 'mobility', 'handling', 'magazine', 'reload'].map((k) => k.padStart(9)).join(''));
for (const g of GUNS) {
  const r = displayStats(g.id, 0).ratings;
  console.log(g.name.padEnd(10) + Object.values(r).map((v) => String(v).padStart(9)).join(''));
}
