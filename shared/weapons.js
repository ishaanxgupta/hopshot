// Shared, deterministic weapon rules. The client runs this for prediction, the server
// runs the same code as the authority. Pure ESM, no DOM/Node APIs, no Math.random.
// Owned by the orchestrator.

import { BTN } from './constants.js';

export const SWITCH_TICKS = 18;

// spread / adsSpread are cone half-angles in radians. Ticks are 1/60 s.
export const WEAPONS = [
  {
    id: 0, key: 'rifle', name: 'Rifle', auto: true,
    fireIntervalTicks: 6, damage: 24, headMult: 1.6, pellets: 1,
    magSize: 30, reloadTicks: 96, spread: 0.014, adsSpread: 0.003,
    range: 250, adsFov: 55, speedMult: 1.0, adsSpeedMult: 0.7,
  },
  {
    id: 1, key: 'scout', name: 'Scout', auto: false,
    fireIntervalTicks: 54, damage: 80, headMult: 2.0, pellets: 1,
    magSize: 5, reloadTicks: 132, spread: 0.07, adsSpread: 0.0,
    range: 400, adsFov: 22, speedMult: 0.95, adsSpeedMult: 0.5,
  },
  {
    id: 2, key: 'shotgun', name: 'Shotgun', auto: false,
    fireIntervalTicks: 42, damage: 14, headMult: 1.25, pellets: 8,
    magSize: 6, reloadTicks: 108, spread: 0.075, adsSpread: 0.06,
    range: 45, adsFov: 65, speedMult: 1.05, adsSpeedMult: 0.8,
  },
];

export function createWeaponState() {
  return resetWeaponState({ weapon: 0, ammo: [0, 0, 0], cooldown: 0, reload: 0, fireHeld: false });
}

export function resetWeaponState(ws) {
  ws.weapon = 0;
  for (let i = 0; i < WEAPONS.length; i++) ws.ammo[i] = WEAPONS[i].magSize;
  ws.cooldown = 0;
  ws.reload = 0;
  ws.fireHeld = false;
  return ws;
}

export function copyWeaponState(dst, src) {
  dst.weapon = src.weapon;
  for (let i = 0; i < WEAPONS.length; i++) dst.ammo[i] = src.ammo[i];
  dst.cooldown = src.cooldown;
  dst.reload = src.reload;
  dst.fireHeld = src.fireHeld;
  return dst;
}

// Advance one tick. cmd = { seq, buttons, yaw, pitch, weapon }.
// Returns true if a shot was fired on this tick (caller then does the hitscan).
export function stepWeapon(ws, cmd) {
  const fire = (cmd.buttons & BTN.FIRE) !== 0;
  let fired = false;

  if (cmd.weapon !== ws.weapon && cmd.weapon >= 0 && cmd.weapon < WEAPONS.length) {
    ws.weapon = cmd.weapon;
    ws.reload = 0;
    ws.cooldown = SWITCH_TICKS;
  }
  const w = WEAPONS[ws.weapon];

  if (ws.cooldown > 0) ws.cooldown--;

  if (ws.reload > 0) {
    ws.reload--;
    if (ws.reload === 0) ws.ammo[ws.weapon] = w.magSize;
  } else if ((cmd.buttons & BTN.RELOAD) !== 0 && ws.ammo[ws.weapon] < w.magSize) {
    ws.reload = w.reloadTicks;
  } else if (fire && ws.cooldown === 0 && (w.auto || !ws.fireHeld)) {
    if (ws.ammo[ws.weapon] > 0) {
      ws.ammo[ws.weapon]--;
      ws.cooldown = w.fireIntervalTicks;
      fired = true;
      if (ws.ammo[ws.weapon] === 0) ws.reload = w.reloadTicks;
    } else {
      ws.reload = w.reloadTicks;
    }
  }

  ws.fireHeld = fire;
  return fired;
}

// Spread cone half-angle for a shot fired with this cmd.
export function shotSpread(weaponId, buttons) {
  const w = WEAPONS[weaponId];
  return (buttons & BTN.ADS) !== 0 ? w.adsSpread : w.spread;
}

// Deterministic unit direction for pellet `pellet` of the shot fired on cmd `seq`.
// Client and server get the same answer, so predicted tracers match server hits.
// Writes into out[0..2] and returns out.
export function shotDir(out, yaw, pitch, spread, seq, pellet) {
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  const sp = Math.sin(pitch), cp = Math.cos(pitch);
  // forward, right, up basis (yaw 0 looks down -Z, +yaw turns left, +pitch looks up)
  const fx = -sy * cp, fy = sp, fz = -cy * cp;
  const rx = cy, rz = -sy;
  const ux = sy * sp, uy = cp, uz = cy * sp;

  let a = 0, b = 0;
  if (spread > 0) {
    let s = (Math.imul(seq | 0, 0x9E3779B1) ^ Math.imul((pellet | 0) + 1, 0x85EBCA6B)) >>> 0;
    const r1 = rand(s); s = (s + 0x6D2B79F5) >>> 0;
    const r2 = rand(s);
    const rad = Math.sqrt(r1) * Math.tan(spread);
    const ang = r2 * Math.PI * 2;
    a = Math.cos(ang) * rad;
    b = Math.sin(ang) * rad;
  }
  let dx = fx + rx * a + ux * b;
  let dy = fy + uy * b;
  let dz = fz + rz * a + uz * b;
  const inv = 1 / Math.hypot(dx, dy, dz);
  out[0] = dx * inv; out[1] = dy * inv; out[2] = dz * inv;
  return out;
}

function rand(seed) {
  let t = (seed + 0x6D2B79F5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Fixed-size binary form of the weapon state (used inside snapshots for reconciliation).
export const WSTATE_BYTES = 7;

export function writeWeaponState(view, offset, ws) {
  view.setUint8(offset, ws.weapon);
  view.setUint8(offset + 1, ws.ammo[0]);
  view.setUint8(offset + 2, ws.ammo[1]);
  view.setUint8(offset + 3, ws.ammo[2]);
  view.setUint8(offset + 4, ws.cooldown);
  view.setUint8(offset + 5, ws.reload);
  view.setUint8(offset + 6, ws.fireHeld ? 1 : 0);
  return offset + WSTATE_BYTES;
}

export function readWeaponState(view, offset, ws) {
  ws.weapon = view.getUint8(offset);
  ws.ammo[0] = view.getUint8(offset + 1);
  ws.ammo[1] = view.getUint8(offset + 2);
  ws.ammo[2] = view.getUint8(offset + 3);
  ws.cooldown = view.getUint8(offset + 4);
  ws.reload = view.getUint8(offset + 5);
  ws.fireHeld = view.getUint8(offset + 6) !== 0;
  return offset + WSTATE_BYTES;
}
