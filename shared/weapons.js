// Shared, deterministic weapon + loadout rules. The client runs this for prediction, the server
// runs the same code as the authority. Pure ESM, no DOM/Node APIs, no Math.random.
//
// ============================================================================================
// MODEL
//   A player carries three weapon SLOTS (0 assault, 1 sniper, 2 shotgun; cmd.weapon / ws.weapon
//   is the slot). Each slot holds one of two GUNS (variant 0 = gun A, 1 = gun B), so there are
//   six guns: gun id = slot * 2 + variant. Each gun mounts up to MAX_ATTACHMENTS (3) of the six
//   ATTACHMENTS (one per area), stored as a 6-bit mask (bit i = attachment id i).
//
//   loadout (canonical form, what sanitizeLoadout returns):
//     { slots: [ { gun: 0|1, att: mask }, { gun: 2|3, att: mask }, { gun: 4|5, att: mask } ] }
//   loadout code (wire / storage form): one byte per slot, variant | att << 1, slot 0 lowest:
//     code = b0 | b1 << 8 | b2 << 16   (a 21-bit integer; encodeLoadout / decodeLoadout)
//
//   kit = getKit(code | loadout): the resolved, cached, frozen per-life rules object
//     { code, loadout, guns: [id,id,id], variants: [v,v,v], masks: [m,m,m], slots: [eff,eff,eff] }
//   eff = effectiveStats(gunId, mask): the gun's stats with its attachments applied (cached).
//
// SIMULATION (client prediction and server, once per cmd, in this order):
//   const mult = moveSpeedMult(kit, ws);          // BEFORE stepWeapon (uses the pre-step aim)
//   stepPlayer(state, cmd, world, mult);
//   if (stepWeapon(ws, cmd, kit)) {               // fired: ws.spread holds this shot's cone
//     const eff = kit.slots[ws.weapon];
//     for (let p = 0; p < eff.pellets; p++)
//       shotDir(out, cmd.yaw, cmd.pitch, ws.spread, cmd.seq, p);  ... hitscan up to eff.range,
//       damage per pellet = damageAt(eff, distance) * (head ? eff.headMult : 1)
//   }
//   The weapon state is fixed-size (WSTATE_BYTES) and holds everything stepWeapon reads.
//   ADS is not instant: ws.aim counts up to eff.adsTicks while BTN.ADS is held (down twice as
//   fast when released); spread and ADS movement speed blend by aimFraction. Sustained fire
//   builds ws.heat (eff.kick per shot, -eff.heatDecay per tick, capped), which widens the
//   cone by eff.bloom rad per unit (assault rifles only).
// ============================================================================================

import { BTN } from './constants.js';

export const SLOT_COUNT = 3;
export const MAX_ATTACHMENTS = 3;
export const ATT_COUNT = 6;
export const ATT_MASK_ALL = (1 << ATT_COUNT) - 1;
export const SLOT_CLASSES = ['assault', 'sniper', 'shotgun'];
export const SLOT_NAMES = ['Assault', 'Sniper', 'Shotgun'];
/** Legacy per-slot sound / HUD keys (audio.play names). */
export const SLOT_KEYS = ['rifle', 'scout', 'shotgun'];

// ------------------------------------------------------------------------------- guns
// Ticks are 1/60 s, spreads are cone half-angles in radians, distances in metres.
//   damage         per pellet, before falloff;  headMult for the top PLAYER.headSize
//   fireTicks      ticks between shots;  auto: holding fire keeps shooting
//   swapTicks      ticks after switching TO this gun before it can fire
//   adsTicks       ticks to reach full aim
//   hipSpread / adsSpread  cone at aim 0 / full aim (blended by aim fraction)
//   kick / heatDecay / heatMax / bloom   recoil bloom (see header)
//   range          hitscan length;  falloffStart / falloffEnd / falloffMin: damage multiplier is
//                  1 up to start, falls linearly to falloffMin at end, stays there beyond
//   moveMult       movement speed multiplier while carried;  adsMoveMult extra factor at full aim
//   adsFov         camera FOV (degrees) at full aim
export const GUNS = [
  {
    id: 0, slot: 0, variant: 0, cls: 'assault', key: 'maul', name: 'Maul',
    blurb: 'Hard-hitting battle rifle. Slower cycle, heavy kick.',
    desc: 'A heavy assault rifle with big rounds. Four body hits drop a full-health target, and the damage holds up well at mid range - but the recoil climbs fast, so fire it in bursts.',
    pro: 'High damage per hit that holds up at mid range',
    con: 'Strong recoil bloom in long sprays, slower to handle',
    auto: true, damage: 28, headMult: 1.6, pellets: 1, fireTicks: 7, magSize: 25, reloadTicks: 140,
    swapTicks: 20, adsTicks: 13, hipSpread: 0.035, adsSpread: 0.005, kick: 10, heatDecay: 1, heatMax: 30, bloom: 0.0008,
    range: 250, falloffStart: 25, falloffEnd: 60, falloffMin: 0.72,
    moveMult: 0.95, adsMoveMult: 0.65, adsFov: 54,
  },
  {
    id: 1, slot: 0, variant: 1, cls: 'assault', key: 'vireo', name: 'Vireo',
    blurb: 'Light, fast-firing, accurate carbine.',
    desc: 'A light rifle with a fast cycle and almost no climb. Melts targets up close while you keep moving, but every bullet hits softly and damage drops off sooner.',
    pro: 'Fast fire rate, laser-steady, quick to aim and move',
    con: 'Low damage per hit, falls off at range',
    auto: true, damage: 21, headMult: 1.5, pellets: 1, fireTicks: 5, magSize: 32, reloadTicks: 112,
    swapTicks: 16, adsTicks: 10, hipSpread: 0.025, adsSpread: 0.004, kick: 6, heatDecay: 1, heatMax: 20, bloom: 0.0006,
    range: 250, falloffStart: 18, falloffEnd: 45, falloffMin: 0.6,
    moveMult: 1.0, adsMoveMult: 0.75, adsFov: 58,
  },
  {
    id: 2, slot: 1, variant: 0, cls: 'sniper', key: 'kestrel', name: 'Kestrel',
    blurb: 'Light bolt-action. Two to the body, one to the head.',
    desc: 'A nimble bolt-action rifle that comes up to the eye fast. Two body hits or a single headshot kill at any distance.',
    pro: 'Quick to aim, one-shot headshots, light to carry',
    con: 'Needs two body hits, slow bolt between shots',
    auto: false, damage: 55, headMult: 2.0, pellets: 1, fireTicks: 50, magSize: 5, reloadTicks: 125,
    swapTicks: 22, adsTicks: 14, hipSpread: 0.06, adsSpread: 0.0015, kick: 0, heatDecay: 1, heatMax: 0, bloom: 0,
    range: 400, falloffStart: 60, falloffEnd: 150, falloffMin: 0.92,
    moveMult: 0.96, adsMoveMult: 0.5, adsFov: 26,
  },
  {
    id: 3, slot: 1, variant: 1, cls: 'sniper', key: 'halberd', name: 'Halberd',
    blurb: 'Heavy rifle. One body shot kills - if you can land it.',
    desc: 'A huge, loud anti-materiel rifle. One hit to the body kills a full-health target out to long range, but it is slow to aim, slow to cycle, slow to reload and slows you down.',
    pro: 'One-shot body kills at full health',
    con: 'Slow in every other way: aim, bolt, reload, swap and movement',
    auto: false, damage: 105, headMult: 1.5, pellets: 1, fireTicks: 84, magSize: 3, reloadTicks: 200,
    swapTicks: 40, adsTicks: 26, hipSpread: 0.11, adsSpread: 0.001, kick: 0, heatDecay: 1, heatMax: 0, bloom: 0,
    range: 400, falloffStart: 45, falloffEnd: 110, falloffMin: 0.83,
    moveMult: 0.86, adsMoveMult: 0.38, adsFov: 18,
  },
  {
    id: 4, slot: 2, variant: 0, cls: 'shotgun', key: 'breaker', name: 'Breaker',
    blurb: 'Pump shotgun. One big blast up close.',
    desc: 'A pump-action shotgun. A clean hit at arm\'s length kills in one blast; miss and you wait for the pump.',
    pro: 'One-shot kills at point-blank range',
    con: 'Slow pump between shots, useless past a few metres',
    auto: false, damage: 12, headMult: 1.25, pellets: 9, fireTicks: 48, magSize: 6, reloadTicks: 130,
    swapTicks: 20, adsTicks: 10, hipSpread: 0.075, adsSpread: 0.06, kick: 0, heatDecay: 1, heatMax: 0, bloom: 0,
    range: 50, falloffStart: 2.5, falloffEnd: 22, falloffMin: 0.2,
    moveMult: 1.02, adsMoveMult: 0.78, adsFov: 66,
  },
  {
    id: 5, slot: 2, variant: 1, cls: 'shotgun', key: 'squall', name: 'Squall',
    blurb: 'Full-auto shotgun. A close-range hose.',
    desc: 'A drum-fed automatic shotgun built for hip fire. Hold the trigger and keep moving - but past a few metres the pellets scatter and hit like pebbles.',
    pro: 'Full auto, big magazine, fastest movement, forgiving up close',
    con: 'Loses badly at range, aiming barely tightens it',
    auto: true, damage: 7, headMult: 1.25, pellets: 6, fireTicks: 9, magSize: 20, reloadTicks: 150,
    swapTicks: 18, adsTicks: 8, hipSpread: 0.08, adsSpread: 0.074, kick: 0, heatDecay: 1, heatMax: 0, bloom: 0,
    range: 35, falloffStart: 5, falloffEnd: 16, falloffMin: 0.15,
    moveMult: 1.06, adsMoveMult: 0.85, adsFov: 70,
  },
];
for (const g of GUNS) Object.freeze(g);
Object.freeze(GUNS);
export const GUN_COUNT = GUNS.length;

/** Gun id for (slot, variant). */
export function gunId(slot, variant) { return slot * 2 + (variant & 1); }

// ------------------------------------------------------------------------------- attachments
// mods[cls] = { mul: { field: factor }, add: { field: delta }, pro, con }. Multipliers are
// applied first, then additions; integer fields are rounded once at the end.
export const ATTACHMENTS = [
  {
    id: 0, key: 'optic', area: 'sight', name: 'Prism Optic',
    desc: 'A magnified sight.', pro: 'More zoom, tighter aimed spread', con: 'Slower to aim, slower while aiming',
    mods: {
      assault: { mul: { adsFov: 0.72, adsSpread: 0.45, adsTicks: 1.45, adsMoveMult: 0.85 },
        pro: 'More zoom, aimed spread more than halved', con: 'Aiming takes 45% longer, 15% slower while aiming' },
      sniper: { mul: { adsFov: 0.65, adsSpread: 0, adsTicks: 1.4, adsMoveMult: 0.8 },
        pro: 'Much more zoom, perfectly accurate when fully aimed', con: 'Aiming takes 40% longer, 20% slower while aiming' },
      shotgun: { mul: { adsFov: 0.85, adsSpread: 0.6, adsTicks: 1.5, adsMoveMult: 0.85 },
        pro: 'Aimed pellet pattern 40% tighter - reaches further when aimed', con: 'Aiming takes 50% longer, 15% slower while aiming' },
    },
  },
  {
    id: 1, key: 'extmag', area: 'magazine', name: 'Extended Mag',
    desc: 'A larger magazine.', pro: 'About 50% more rounds', con: 'Slower reload',
    mods: {
      assault: { mul: { magSize: 1.5, reloadTicks: 1.3 }, pro: '+50% rounds', con: 'Reload 30% slower' },
      sniper: { mul: { magSize: 1.5, reloadTicks: 1.3 }, pro: '+50% rounds', con: 'Reload 30% slower' },
      shotgun: { mul: { magSize: 1.5, reloadTicks: 1.3 }, pro: '+50% shells', con: 'Reload 30% slower' },
    },
  },
  {
    id: 2, key: 'heavy', area: 'ammunition', name: 'Heavy Rounds',
    desc: 'Heavier, slower-cycling ammunition.', pro: 'More damage per hit', con: 'Lower fire rate',
    mods: {
      assault: { mul: { damage: 1.15, fireTicks: 1.2 }, pro: '+15% damage: one headshot saves a body shot, holds up further', con: 'Fire rate -17%' },
      sniper: { mul: { damage: 1.15, fireTicks: 1.2 }, pro: '+15% damage: one-shots wounded targets, keeps kills through falloff', con: 'Bolt cycles 20% slower' },
      shotgun: { mul: { damage: 1.15, fireTicks: 1.2 }, pro: '+15% damage per pellet: kills from a little further', con: 'Fire rate -17%' },
    },
  },
  {
    id: 3, key: 'barrel', area: 'barrel', name: 'Long Barrel',
    desc: 'A longer barrel.', pro: 'More range before damage falloff, tighter hip spread', con: 'Slower movement',
    mods: {
      assault: { mul: { falloffStart: 1.35, falloffEnd: 1.35, hipSpread: 0.8, moveMult: 0.95, adsMoveMult: 0.95 },
        pro: 'Falloff starts 35% further out, hip spread -20%', con: 'Movement -5%' },
      sniper: { mul: { falloffStart: 1.35, falloffEnd: 1.35, hipSpread: 0.75, moveMult: 0.95, adsMoveMult: 0.95 },
        pro: 'Falloff starts 35% further out, hip shots 25% tighter', con: 'Movement -5%' },
      shotgun: { mul: { falloffStart: 1.35, falloffEnd: 1.35, range: 1.25, hipSpread: 0.85, adsSpread: 0.85, moveMult: 0.95, adsMoveMult: 0.95 },
        pro: 'Falloff starts 35% further out, pellet pattern 15% tighter', con: 'Movement -5%' },
    },
  },
  {
    id: 4, key: 'stock', area: 'stock', name: 'Light Stock',
    desc: 'A skeleton stock.', pro: 'Faster movement and faster aiming', con: 'More spread',
    mods: {
      assault: { mul: { moveMult: 1.05, adsMoveMult: 1.15, adsTicks: 0.7, hipSpread: 1.25, adsSpread: 1.4, bloom: 1.25 },
        pro: 'Movement +5%, +15% while aiming, aims 30% faster', con: 'Hip spread +25%, aimed spread +40%, recoil bloom +25%' },
      sniper: { mul: { moveMult: 1.05, adsMoveMult: 1.2, adsTicks: 0.7, hipSpread: 1.2 }, add: { adsSpread: 0.003 },
        pro: 'Movement +5%, +20% while aiming, aims 30% faster', con: 'Never perfectly steady when aimed, hip spread +20%' },
      shotgun: { mul: { moveMult: 1.05, adsMoveMult: 1.1, adsTicks: 0.7, hipSpread: 1.18, adsSpread: 1.18 },
        pro: 'Movement +5%, aims 30% faster', con: 'Pellet pattern 18% wider' },
    },
  },
  {
    id: 5, key: 'quick', area: 'grip', name: 'Quick Hands',
    desc: 'A grip and mag-well tuned for speed.', pro: 'Faster reload and weapon swap', con: 'Smaller magazine',
    mods: {
      assault: { mul: { reloadTicks: 0.7, swapTicks: 0.6, magSize: 0.75 }, pro: 'Reload 30% faster, swap 40% faster', con: 'Magazine -25%' },
      sniper: { mul: { reloadTicks: 0.7, swapTicks: 0.6, magSize: 0.7 }, pro: 'Reload 30% faster, swap 40% faster', con: 'Magazine -30%' },
      shotgun: { mul: { reloadTicks: 0.7, swapTicks: 0.6, magSize: 0.67 }, pro: 'Reload 30% faster, swap 40% faster', con: 'Magazine -33%' },
    },
  },
];
for (const a of ATTACHMENTS) { for (const k of Object.keys(a.mods)) Object.freeze(a.mods[k]); Object.freeze(a.mods); Object.freeze(a); }
Object.freeze(ATTACHMENTS);

const ATT_BY_KEY = new Map(ATTACHMENTS.map((a) => [a.key, a.id]));
const GUN_BY_KEY = new Map(GUNS.map((g) => [g.key, g.id]));
const INT_FIELDS = ['fireTicks', 'magSize', 'reloadTicks', 'swapTicks', 'adsTicks', 'kick', 'heatDecay', 'heatMax'];

/** Class-specific pro/con text for an attachment on a gun class ('assault'|'sniper'|'shotgun'). */
export function attachmentText(attId, cls) {
  const a = ATTACHMENTS[attId];
  if (!a) return null;
  const m = a.mods[cls] || {};
  return { name: a.name, area: a.area, desc: a.desc, pro: m.pro || a.pro, con: m.con || a.con };
}

// ------------------------------------------------------------------------------- masks

export function popcount6(m) { m &= ATT_MASK_ALL; let n = 0; while (m) { n += m & 1; m >>= 1; } return n; }

/** Keep only known bits and at most MAX_ATTACHMENTS of them (lowest ids win). */
export function sanitizeMask(m) {
  m = (m | 0) & ATT_MASK_ALL;
  let out = 0, n = 0;
  for (let i = 0; i < ATT_COUNT && n < MAX_ATTACHMENTS; i++) if (m & (1 << i)) { out |= 1 << i; n++; }
  return out;
}
export function maskHas(mask, attId) { return ((mask >> attId) & 1) === 1; }
export function maskToList(mask) { const l = []; for (let i = 0; i < ATT_COUNT; i++) if (mask & (1 << i)) l.push(i); return l; }
/** Attachment list (ids, or keys like 'optic') -> mask. Unknown entries are dropped, 3-limit enforced. */
export function listToMask(list) {
  if (!Array.isArray(list)) return 0;
  let m = 0, n = 0;
  for (const x of list) {
    const id = typeof x === 'string' ? ATT_BY_KEY.get(x) : (Number.isInteger(x) ? x : -1);
    if (id === undefined || id < 0 || id >= ATT_COUNT || (m & (1 << id))) continue;
    if (n >= MAX_ATTACHMENTS) break;
    m |= 1 << id; n++;
  }
  return m;
}
/**
 * UI helper: toggle attachment attId in mask. Adding a 4th is refused (returns the mask
 * unchanged) - check canAddAttachment first to grey the option out.
 */
export function toggleAttachment(mask, attId) {
  mask = sanitizeMask(mask);
  if (!(attId >= 0 && attId < ATT_COUNT)) return mask;
  if (maskHas(mask, attId)) return mask & ~(1 << attId);
  return popcount6(mask) >= MAX_ATTACHMENTS ? mask : mask | (1 << attId);
}
export function canAddAttachment(mask, attId) { return maskHas(mask, attId) || popcount6(mask) < MAX_ATTACHMENTS; }

// ------------------------------------------------------------------------------- loadouts

export const DEFAULT_LOADOUT = Object.freeze({ slots: Object.freeze([
  Object.freeze({ gun: 0, att: 0 }), Object.freeze({ gun: 2, att: 0 }), Object.freeze({ gun: 4, att: 0 }),
]) });

function slotGun(slot, g) {
  let id = -1;
  if (typeof g === 'string') { const k = GUN_BY_KEY.get(g); id = k === undefined ? -1 : k; }
  else if (Number.isInteger(g)) id = g;
  if (id >= 0 && id < GUN_COUNT && GUNS[id].slot === slot) return id;
  if (id === 0 || id === 1) return slot * 2 + id;          // a bare variant (0 = A, 1 = B)
  return slot * 2;
}

/**
 * Lenient input -> canonical NEW loadout { slots: [{ gun, att }, x3] }. Accepts the canonical
 * form, a loadout code (number), slots whose gun is a gun id, a gun key ('maul') or a bare
 * variant 0/1, and att as a mask or an array of attachment ids / keys. Guns from the wrong
 * slot fall back to that slot's gun A; unknown attachments are dropped; at most 3 per gun.
 */
export function sanitizeLoadout(input) {
  if (typeof input === 'number') return decodeLoadout(input);
  const src = input && typeof input === 'object' && Array.isArray(input.slots) ? input.slots
    : Array.isArray(input) ? input : [];
  const slots = [];
  for (let s = 0; s < SLOT_COUNT; s++) {
    const e = src[s] && typeof src[s] === 'object' ? src[s] : {};
    const gun = slotGun(s, e.gun);
    const raw = e.att !== undefined ? e.att : e.attachments;
    const att = Array.isArray(raw) ? listToMask(raw) : sanitizeMask(Number.isInteger(raw) ? raw : 0);
    slots.push({ gun, att });
  }
  return { slots };
}

/** Loadout (any form sanitizeLoadout accepts) -> integer code (3 bytes). */
export function encodeLoadout(lo) {
  const l = sanitizeLoadout(lo);
  let code = 0;
  for (let s = 0; s < SLOT_COUNT; s++) code |= (((l.slots[s].gun & 1) | (l.slots[s].att << 1)) & 0x7f) << (8 * s);
  return code;
}

/** Integer code -> canonical loadout. Anything malformed decodes to something valid. */
export function decodeLoadout(code) {
  const c = Number.isInteger(code) && code >= 0 && code <= 0xffffff ? code : 0;
  const slots = [];
  for (let s = 0; s < SLOT_COUNT; s++) {
    const b = (c >> (8 * s)) & 0xff;
    slots.push({ gun: s * 2 + (b & 1), att: sanitizeMask(b >> 1) });
  }
  return { slots };
}

/** Normalise any code (or loadout) to its canonical code. */
export function sanitizeLoadoutCode(code) { return encodeLoadout(typeof code === 'number' ? decodeLoadout(code) : code); }
export const DEFAULT_LOADOUT_CODE = encodeLoadout(DEFAULT_LOADOUT);

/** 3-byte binary form (if a binary message ever needs it). */
export const LOADOUT_BYTES = 3;
export function writeLoadout(view, o, code) {
  const c = sanitizeLoadoutCode(code);
  view.setUint8(o, c & 0xff); view.setUint8(o + 1, (c >> 8) & 0xff); view.setUint8(o + 2, (c >> 16) & 0xff);
  return o + LOADOUT_BYTES;
}
export function readLoadout(view, o) {
  return sanitizeLoadoutCode(view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16));
}

// ------------------------------------------------------------------------------- effective stats

const effCache = new Array(GUN_COUNT * 64).fill(null);

/** Effective stats of gun `gid` with attachment mask `mask` (computed once, cached, frozen). */
export function effectiveStats(gid, mask = 0) {
  if (!(gid >= 0 && gid < GUN_COUNT)) gid = 0;
  mask = sanitizeMask(mask);
  const k = gid * 64 + mask;
  const hit = effCache[k];
  if (hit) return hit;
  const g = GUNS[gid];
  const e = { ...g };
  const adds = [];
  for (let i = 0; i < ATT_COUNT; i++) {
    if (!(mask & (1 << i))) continue;
    const m = ATTACHMENTS[i].mods[g.cls];
    if (!m) continue;
    if (m.mul) for (const f of Object.keys(m.mul)) e[f] *= m.mul[f];
    if (m.add) adds.push(m.add);
  }
  for (const a of adds) for (const f of Object.keys(a)) e[f] += a[f];
  for (const f of INT_FIELDS) e[f] = Math.round(e[f]);
  e.magSize = Math.max(1, e.magSize);
  e.fireTicks = Math.max(1, e.fireTicks);
  e.adsTicks = Math.max(1, e.adsTicks);
  e.swapTicks = Math.max(1, e.swapTicks);
  e.reloadTicks = Math.max(1, e.reloadTicks);
  e.gun = gid;
  e.mask = mask;
  e.attachments = Object.freeze(maskToList(mask));
  // aliases for older call sites (render / hud / input read these from WEAPONS)
  e.fireIntervalTicks = e.fireTicks;
  e.spread = e.hipSpread;
  e.speedMult = e.moveMult;
  e.adsSpeedMult = e.adsMoveMult;
  e.slotKey = SLOT_KEYS[g.slot];
  Object.freeze(e);
  effCache[k] = e;
  return e;
}

/** Damage multiplier at distance d (metres) for effective stats eff. */
export function falloffAt(eff, d) {
  if (!(d > eff.falloffStart)) return 1;
  if (d >= eff.falloffEnd) return eff.falloffMin;
  return 1 - (1 - eff.falloffMin) * (d - eff.falloffStart) / (eff.falloffEnd - eff.falloffStart);
}
/** Damage of ONE pellet at distance d, body (head = false) or head. */
export function damageAt(eff, d, head = false) {
  return eff.damage * falloffAt(eff, d) * (head ? eff.headMult : 1);
}

// ------------------------------------------------------------------------------- kits

const kitCache = new Map();

/** Resolved per-life rules for a loadout (code or object). Cached and frozen. */
export function getKit(lo) {
  const code = typeof lo === 'number' ? sanitizeLoadoutCode(lo) : encodeLoadout(lo);
  let kit = kitCache.get(code);
  if (kit) return kit;
  const l = decodeLoadout(code);
  const slots = [], guns = [], variants = [], masks = [];
  for (let s = 0; s < SLOT_COUNT; s++) {
    const { gun, att } = l.slots[s];
    slots.push(effectiveStats(gun, att)); guns.push(gun); variants.push(gun & 1); masks.push(att);
  }
  kit = Object.freeze({
    code, loadout: l, slots: Object.freeze(slots), guns: Object.freeze(guns),
    variants: Object.freeze(variants), masks: Object.freeze(masks),
  });
  kitCache.set(code, kit);
  return kit;
}
export const DEFAULT_KIT = getKit(DEFAULT_LOADOUT_CODE);

/**
 * Legacy per-slot table (slot -> the default gun of that slot, bare). Kept so older code that
 * indexes WEAPONS[slot] for key / name / auto / adsFov / range keeps working; per-player
 * numbers (magSize etc.) must come from the player's kit: kit.slots[slot].
 */
export const WEAPONS = Object.freeze(DEFAULT_KIT.slots.map((e, s) => Object.freeze({
  ...e, id: s, key: SLOT_KEYS[s], name: SLOT_NAMES[s], gunKey: e.key, gunName: e.name,
})));

// ------------------------------------------------------------------------------- weapon state

export function createWeaponState(kit = DEFAULT_KIT) {
  return resetWeaponState({ weapon: 0, ammo: [0, 0, 0], cooldown: 0, reload: 0, fireHeld: false, aim: 0, heat: 0, spread: 0 }, kit);
}

/** Fresh life: slot 0 out, every magazine full (from the kit), not aiming, no heat. */
export function resetWeaponState(ws, kit = DEFAULT_KIT) {
  ws.weapon = 0;
  for (let i = 0; i < SLOT_COUNT; i++) ws.ammo[i] = kit.slots[i].magSize;
  ws.cooldown = 0;
  ws.reload = 0;
  ws.fireHeld = false;
  ws.aim = 0;
  ws.heat = 0;
  ws.spread = 0;
  return ws;
}

export function copyWeaponState(dst, src) {
  dst.weapon = src.weapon;
  for (let i = 0; i < SLOT_COUNT; i++) dst.ammo[i] = src.ammo[i];
  dst.cooldown = src.cooldown;
  dst.reload = src.reload;
  dst.fireHeld = src.fireHeld;
  dst.aim = src.aim;
  dst.heat = src.heat;
  dst.spread = src.spread;
  return dst;
}

/** Every serialised field equal (spread is per-shot scratch, not state). */
export function sameWeaponState(a, b) {
  return a.weapon === b.weapon && a.cooldown === b.cooldown && a.reload === b.reload && a.fireHeld === b.fireHeld &&
    a.aim === b.aim && a.heat === b.heat && a.ammo[0] === b.ammo[0] && a.ammo[1] === b.ammo[1] && a.ammo[2] === b.ammo[2];
}

/** 0..1 aim progress of the weapon in hand. */
export function aimFraction(kit, ws) {
  const e = kit.slots[ws.weapon] || kit.slots[0];
  const f = ws.aim / e.adsTicks;
  return f > 1 ? 1 : f;
}

/**
 * Movement speed multiplier for stepPlayer, from the kit and the weapon state BEFORE this
 * tick's stepWeapon (gun in hand + current aim progress).
 */
export function moveSpeedMult(kit, ws) {
  const e = kit.slots[ws.weapon] || kit.slots[0];
  let f = ws.aim / e.adsTicks;
  if (f > 1) f = 1;
  return e.moveMult * (1 + (e.adsMoveMult - 1) * f);
}

/** Cone half-angle for a shot fired now (before this shot's kick is added). */
export function currentSpread(eff, ws) {
  let f = ws.aim / eff.adsTicks;
  if (f > 1) f = 1;
  return eff.hipSpread + (eff.adsSpread - eff.hipSpread) * f + ws.heat * eff.bloom;
}

/**
 * Advance one tick. cmd = { seq, buttons, yaw, pitch, weapon (slot) }, kit = getKit(loadout).
 * Returns true if a shot was fired on this tick; ws.spread then holds that shot's cone.
 */
export function stepWeapon(ws, cmd, kit = DEFAULT_KIT) {
  const buttons = cmd.buttons | 0;
  const fire = (buttons & BTN.FIRE) !== 0;
  let fired = false;

  if (cmd.weapon !== ws.weapon && cmd.weapon >= 0 && cmd.weapon < SLOT_COUNT) {
    ws.weapon = cmd.weapon;
    ws.reload = 0;
    ws.cooldown = kit.slots[ws.weapon].swapTicks;
    ws.aim = 0;
    ws.heat = 0;
  }
  const w = kit.slots[ws.weapon];

  if (ws.cooldown > 0) ws.cooldown--;
  if (ws.heat > 0) ws.heat = ws.heat > w.heatDecay ? ws.heat - w.heatDecay : 0;
  if ((buttons & BTN.ADS) !== 0) { if (ws.aim < w.adsTicks) ws.aim++; else ws.aim = w.adsTicks; }
  else if (ws.aim > 0) ws.aim = ws.aim > 2 ? ws.aim - 2 : 0;

  if (ws.reload > 0) {
    ws.reload--;
    if (ws.reload === 0) ws.ammo[ws.weapon] = w.magSize;
  } else if ((buttons & BTN.RELOAD) !== 0 && ws.ammo[ws.weapon] < w.magSize) {
    ws.reload = w.reloadTicks;
  } else if (fire && ws.cooldown === 0 && (w.auto || !ws.fireHeld)) {
    if (ws.ammo[ws.weapon] > 0) {
      ws.spread = currentSpread(w, ws);
      ws.ammo[ws.weapon]--;
      ws.cooldown = w.fireTicks;
      if (w.kick > 0) { const h = ws.heat + w.kick; ws.heat = h > w.heatMax ? w.heatMax : h; }
      fired = true;
      if (ws.ammo[ws.weapon] === 0) ws.reload = w.reloadTicks;
    } else {
      ws.reload = w.reloadTicks;
    }
  }

  ws.fireHeld = fire;
  return fired;
}

/** Back-compat helper: cone for a shot with this kit + weapon state (same as stepWeapon uses). */
export function shotSpread(kit, ws) {
  return currentSpread(kit.slots[ws.weapon] || kit.slots[0], ws);
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
//   u8 weapon, u8 ammo[3], u8 cooldown, u16 reload, u8 flags (bit0 fireHeld), u8 aim, u8 heat
export const WSTATE_BYTES = 10;

export function writeWeaponState(view, offset, ws) {
  view.setUint8(offset, ws.weapon);
  view.setUint8(offset + 1, ws.ammo[0]);
  view.setUint8(offset + 2, ws.ammo[1]);
  view.setUint8(offset + 3, ws.ammo[2]);
  view.setUint8(offset + 4, ws.cooldown);
  view.setUint16(offset + 5, ws.reload, true);
  view.setUint8(offset + 7, ws.fireHeld ? 1 : 0);
  view.setUint8(offset + 8, ws.aim);
  view.setUint8(offset + 9, ws.heat);
  return offset + WSTATE_BYTES;
}

export function readWeaponState(view, offset, ws) {
  const w = view.getUint8(offset);
  ws.weapon = w < SLOT_COUNT ? w : 0;
  ws.ammo[0] = view.getUint8(offset + 1);
  ws.ammo[1] = view.getUint8(offset + 2);
  ws.ammo[2] = view.getUint8(offset + 3);
  ws.cooldown = view.getUint8(offset + 4);
  ws.reload = view.getUint16(offset + 5, true);
  ws.fireHeld = (view.getUint8(offset + 7) & 1) !== 0;
  ws.aim = view.getUint8(offset + 8);
  ws.heat = view.getUint8(offset + 9);
  return offset + WSTATE_BYTES;
}

// ------------------------------------------------------------------------------- display (UI)
// Ratings are 0..100 on fixed scales shared by every gun, so bars compare across guns.

export const STAT_KEYS = ['damage', 'fireRate', 'range', 'accuracy', 'mobility', 'handling', 'magazine', 'reload'];
export const STAT_LABELS = {
  damage: 'Damage', fireRate: 'Fire rate', range: 'Range', accuracy: 'Accuracy',
  mobility: 'Mobility', handling: 'Handling', magazine: 'Magazine', reload: 'Reload',
};
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const TICK_S = 1 / 60;

/** Shots to kill a 100 hp target at distance d with every pellet hitting (body or head). */
export function shotsToKill(eff, d, head = false, hp = 100) {
  const per = damageAt(eff, d, head) * eff.pellets;
  return per > 0 ? Math.ceil((hp - 1e-9) / per) : Infinity;
}
/** Perfect-accuracy time to kill in ms (first shot at t = 0; includes a reload if the mag runs dry). */
export function ttkMs(eff, d, head = false, hp = 100) {
  const n = shotsToKill(eff, d, head, hp);
  if (!Number.isFinite(n)) return Infinity;
  const reloads = Math.floor((n - 1) / eff.magSize);
  return Math.round(((n - 1 - reloads) * eff.fireTicks + reloads * eff.reloadTicks) * TICK_S * 1000);
}

/**
 * Effective range (m): the furthest distance (<= 120) where the expected damage of a fully
 * aimed shot is still >= 75% of its point-blank value. Spread is modelled as a uniform disk
 * against a 0.4 m-radius target, so shotguns are limited by pellet spread as well as falloff.
 */
export function effectiveRange(eff) {
  const exp = (d) => {
    const r = d * Math.tan(eff.adsSpread);
    const p = r <= 0.4 ? 1 : (0.4 / r) * (0.4 / r);
    return falloffAt(eff, d) * p;
  };
  const ref = exp(1);
  let d = 1;
  while (d < 120 && exp(d + 0.5) >= 0.75 * ref) d += 0.5;
  return d;
}

const dispCache = new Map();

/**
 * Stats for the loadout UI: gun `gid` with attachment mask `mask` (or a list of ids/keys).
 * Returns (cached, frozen) {
 *   gun, mask, name, cls,
 *   ratings: { damage, fireRate, range, accuracy, mobility, handling, magazine, reload } 0..100,
 *   values:  { same keys: short human strings, e.g. '28 (42 head)', '514 rpm', '56 m' },
 *   raw:     { damage, headDamage, pellets, rpm, effectiveRange, falloffStart, falloffEnd, falloffMin,
 *              hipSpreadDeg, adsSpreadDeg, bloomMaxDeg, moveSpeed, adsMoveSpeed, adsMs, swapMs,
 *              magSize, reloadS, ttkBodyMs: { 5, 15, 30, 60 }, ttkHeadMs: { ... }, shotsBody, shotsHead } }
 */
export function displayStats(gid, mask = 0) {
  if (Array.isArray(mask)) mask = listToMask(mask);
  const e = effectiveStats(gid, mask);
  const key = e.gun * 64 + e.mask;
  const hit = dispCache.get(key);
  if (hit) return hit;
  const perShot = e.damage * e.pellets;
  const rpm = 3600 / e.fireTicks;
  const range = effectiveRange(e);
  const bloomMax = e.bloom * e.heatMax;
  const accScore = 0.4 * e.hipSpread + 2 * e.adsSpread + 0.4 * bloomMax;
  const mob = 0.75 * e.moveMult + 0.25 * e.moveMult * e.adsMoveMult;
  const RUN = 7.0;   // physics MOVE.runSpeed (not imported to keep this module physics-free)
  const ttkB = {}, ttkH = {};
  for (const d of [5, 15, 30, 60]) { ttkB[d] = ttkMs(e, d, false); ttkH[d] = ttkMs(e, d, true); }
  const deg = (r) => Math.round(r * 180 / Math.PI * 100) / 100;
  const ratings = {
    damage: Math.round(100 * Math.sqrt(clamp01(perShot / 125))),
    fireRate: Math.round(100 * clamp01(rpm / 800)),
    range: Math.round(100 * clamp01(Math.log(1 + range / 3) / Math.log(1 + 120 / 3))),
    accuracy: Math.round(100 * Math.exp(-accScore / 0.06)),
    mobility: Math.round(100 * clamp01((mob - 0.6) / 0.5)),
    handling: Math.round(100 * clamp01(1 - (e.adsTicks + 0.5 * e.swapTicks) / 60)),
    magazine: Math.round(100 * Math.sqrt(clamp01(e.magSize / 50))),
    reload: Math.round(100 * clamp01(1 - (e.reloadTicks - 40) / 240)),
  };
  const r1 = (v) => Math.round(v * 10) / 10;
  const values = {
    damage: e.pellets > 1 ? `${r1(e.damage)} x${e.pellets} (${Math.round(perShot)})` : `${Math.round(e.damage)} (${Math.round(e.damage * e.headMult)} head)`,
    fireRate: `${Math.round(rpm)} rpm`,
    range: range >= 120 ? '120+ m' : `${Math.round(range)} m`,
    accuracy: `${deg(e.adsSpread)}° aimed / ${deg(e.hipSpread)}° hip`,
    mobility: `${r1(RUN * e.moveMult)} m/s (${r1(RUN * e.moveMult * e.adsMoveMult)} aimed)`,
    handling: `${Math.round(e.adsTicks * 1000 / 60)} ms aim, ${Math.round(e.swapTicks * 1000 / 60)} ms swap`,
    magazine: `${e.magSize}`,
    reload: `${r1(e.reloadTicks / 60)} s`,
  };
  const raw = {
    damage: e.damage, headDamage: e.damage * e.headMult, pellets: e.pellets, rpm, effectiveRange: range,
    falloffStart: e.falloffStart, falloffEnd: e.falloffEnd, falloffMin: e.falloffMin,
    hipSpreadDeg: deg(e.hipSpread), adsSpreadDeg: deg(e.adsSpread), bloomMaxDeg: deg(bloomMax),
    moveSpeed: RUN * e.moveMult, adsMoveSpeed: RUN * e.moveMult * e.adsMoveMult,
    adsMs: e.adsTicks * 1000 / 60, swapMs: e.swapTicks * 1000 / 60, magSize: e.magSize, reloadS: e.reloadTicks / 60,
    ttkBodyMs: ttkB, ttkHeadMs: ttkH, shotsBody: shotsToKill(e, 5, false), shotsHead: shotsToKill(e, 5, true),
  };
  const out = Object.freeze({ gun: e.gun, mask: e.mask, name: e.name, cls: e.cls, ratings: Object.freeze(ratings), values: Object.freeze(values), raw: Object.freeze(raw) });
  dispCache.set(key, out);
  return out;
}

/**
 * Compare two attachment sets on the same gun (or two guns): per stat { from, to, delta }
 * where delta = to - from on the 0..100 rating (positive = better).
 */
export function compareStats(gidA, maskA, gidB = gidA, maskB = 0) {
  const a = displayStats(gidA, maskA), b = displayStats(gidB, maskB);
  const out = {};
  for (const k of STAT_KEYS) out[k] = { from: a.ratings[k], to: b.ratings[k], delta: b.ratings[k] - a.ratings[k], fromText: a.values[k], toText: b.values[k] };
  return out;
}
