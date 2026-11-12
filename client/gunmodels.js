// Hopshot gun models: pure data, no three.js. render.js turns these box lists into geometry.
//
// Six guns (shared/weapons.js GUNS ids 0..5) x attachment mask (bit i = attachment id i):
//   optic (bit 0)  scope / sight on top        extmag (bit 1) bigger magazine / drum / tube
//   barrel (bit 3) long barrel + muzzle device  stock (bit 4)  skeleton stock instead of a solid one
// (heavy rounds and quick hands have no model change.)
//
// A part is [cx, cy, cz, sx, sy, sz, hex, rotX?] - a box centred at (cx, cy, cz) with size
// (sx, sy, sz), optionally rolled around its own X axis by rotX radians (used to make octagons).
//
// First-person model space: -Z forward, +X right, +Y up, origin near the sight line.
//   buildViewmodel(gun, mask) -> { body, mag, pump, muzzle, hip, ads, recoil, camKick, flash, style }
//     body  parts that never move relative to the gun (receiver, barrel, stock, arms...)
//     mag   parts that drop out / spin while reloading (magazine, drum, shells)
//     pump  parts that slide back and forth while cycling (pump forend, bolt handle)
//     style 'mag' | 'shell' (reload animation family),  cyc 'pump' | 'bolt' | null (cycle animation)
// Third-person (hung on the character's right arm):
//   buildThird(gun, mask) -> { parts: [[gx, gu, gf, sx, su, sf, hex] x <= TP_PARTS], muzzle }
//     gx = sideways, gu = up, gf = distance from the shoulder along the arm to the part centre,
//     (sx, su, sf) = width, height, length. muzzle = gf of the muzzle.

export const TP_PARTS = 6;

const has = (m, id) => ((m >> id) & 1) === 1;
const OPTIC = 0, EXTMAG = 1, BARREL = 3, STOCK = 4;

const SKIN = 0xf0c8a0, SLEEVE = 0x2f4a73;
function arms(rz, lz) {
  return [
    [0.03, -0.13, rz, 0.075, 0.075, 0.085, SKIN],             // right glove (grip)
    [0.07, -0.2, rz + 0.3, 0.085, 0.085, 0.5, SLEEVE],        // right forearm
    [-0.02, -0.105, lz, 0.075, 0.07, 0.1, SKIN],              // left glove (fore-end)
    [-0.11, -0.19, lz + 0.3, 0.085, 0.085, 0.5, SLEEVE],      // left forearm
  ];
}

const LENS = 0x66ccff, DARKG = 0x20242d, IRON = 0x1c2029, BLK = 0x101318;

// a compact optic on a riser (assault / shotgun)
function optic(topY, z) {
  return [
    [0, topY + 0.016, z, 0.034, 0.03, 0.12, DARKG],
    [0, topY + 0.052, z, 0.05, 0.05, 0.2, DARKG],
    [0, topY + 0.052, z - 0.12, 0.062, 0.062, 0.04, DARKG],
    [0, topY + 0.052, z + 0.11, 0.056, 0.056, 0.03, DARKG],
    [0, topY + 0.052, z - 0.142, 0.045, 0.045, 0.006, LENS],
    [0, topY + 0.082, z, 0.014, 0.012, 0.03, 0xff4d5e],
  ];
}
// skeleton stock: two thin bars + a butt plate
function skeleton(y, z0, len, h, col) {
  return [
    [0, y + h * 0.28, z0 + len / 2, 0.026, 0.024, len, col],
    [0, y - h * 0.34, z0 + len / 2, 0.026, 0.024, len, col],
    [0, y - h * 0.03, z0 + len, 0.036, h, 0.018, IRON],
  ];
}

const VM = [
  // ---- 0 Maul: heavy battle rifle (steel, wood handguard, curved amber magazine)
  (m) => {
    const body = [
      [0, -0.052, 0.0, 0.078, 0.086, 0.36, 0x3b4250],
      [0, -0.004, 0.02, 0.05, 0.016, 0.3, 0x242932],
      [0, -0.06, -0.28, 0.09, 0.09, 0.22, 0x8a4b2a],
      [0, -0.02, -0.28, 0.03, 0.018, 0.2, IRON],
      [0, -0.052, -0.46, 0.03, 0.03, 0.14, 0x15181e],
      [0, -0.022, -0.5, 0.012, 0.045, 0.012, BLK],
      [0, -0.006, 0.12, 0.04, 0.02, 0.014, BLK],
      [0, -0.123, 0.1, 0.05, 0.11, 0.055, 0x6e3a20, 0.3],
    ];
    if (has(m, STOCK)) body.push(...skeleton(-0.08, 0.17, 0.27, 0.12, 0x8a4b2a));
    else body.push([0, -0.08, 0.32, 0.064, 0.115, 0.28, 0x8a4b2a], [0, -0.08, 0.465, 0.07, 0.135, 0.02, IRON]);
    let mz = -0.56;
    if (has(m, BARREL)) { body.push([0, -0.052, -0.6, 0.04, 0.04, 0.12, BLK], [0, -0.052, -0.68, 0.056, 0.056, 0.05, 0x0a0c10]); mz = -0.72; }
    if (has(m, OPTIC)) body.push(...optic(0.004, 0.02));
    const e = has(m, EXTMAG);
    const mag = e
      ? [[0, -0.2, -0.045, 0.05, 0.2, 0.075, 0xc9822b], [0, -0.325, -0.02, 0.05, 0.05, 0.075, 0xc9822b]]
      : [[0, -0.145, -0.045, 0.05, 0.13, 0.075, 0xc9822b], [0, -0.22, -0.02, 0.05, 0.04, 0.075, 0xc9822b]];
    return { body: [...body, ...arms(0.09, -0.26)], mag, pump: null, muzzle: [0, -0.052, mz], hip: [0.22, -0.2, -0.46], ads: [0, 0.004, -0.36],
      recoil: 1.5, camKick: 0.0046, flash: 0.27, style: 'mag', cyc: null };
  },
  // ---- 1 Vireo: light carbine (steel blue, teal shroud, short straight magazine)
  (m) => {
    const body = [
      [0, -0.05, 0.0, 0.06, 0.07, 0.34, 0x4d5b6b],
      [0, -0.006, 0.0, 0.04, 0.012, 0.3, 0x2b333f],
      [0, -0.05, -0.3, 0.05, 0.055, 0.26, 0x2fb5a8],
      [0, -0.05, -0.47, 0.022, 0.022, 0.1, 0x15181e],
      [0, 0.004, -0.16, 0.014, 0.03, 0.014, BLK],
      [0, 0.0, 0.1, 0.03, 0.025, 0.012, BLK],
      [0, -0.115, 0.1, 0.045, 0.1, 0.05, IRON, 0.2],
    ];
    if (has(m, STOCK)) body.push(...skeleton(-0.06, 0.17, 0.22, 0.09, 0x4d5b6b));
    else body.push([0, -0.06, 0.28, 0.05, 0.09, 0.2, 0x4d5b6b], [0, -0.06, 0.385, 0.056, 0.105, 0.016, IRON]);
    let mz = -0.54;
    if (has(m, BARREL)) { body.push([0, -0.05, -0.56, 0.026, 0.026, 0.1, BLK], [0, -0.05, -0.65, 0.04, 0.04, 0.06, 0x0a0c10]); mz = -0.69; }
    if (has(m, OPTIC)) body.push(...optic(0.0, 0.0));
    const mag = has(m, EXTMAG) ? [[0, -0.17, -0.06, 0.04, 0.2, 0.06, 0xd7e2ea]] : [[0, -0.13, -0.06, 0.04, 0.11, 0.06, 0xd7e2ea]];
    return { body: [...body, ...arms(0.1, -0.25)], mag, pump: null, muzzle: [0, -0.05, mz], hip: [0.2, -0.19, -0.44], ads: [0, 0.006, -0.34],
      recoil: 0.6, camKick: 0.0016, flash: 0.17, style: 'mag', cyc: null };
  },
  // ---- 2 Kestrel: light bolt-action (wood, long thin barrel, slim scope)
  (m) => {
    const body = [
      [0, -0.05, 0.0, 0.05, 0.06, 0.3, 0x5e4334],
      [0, -0.048, -0.5, 0.024, 0.024, 0.64, IRON],
      [0, -0.048, -0.83, 0.036, 0.036, 0.04, 0x2b303b],
      [0, 0.025, -0.02, 0.04, 0.04, 0.26, DARKG],
      [0, 0.025, -0.17, 0.052, 0.052, 0.04, DARKG],
      [0, 0.025, 0.13, 0.05, 0.05, 0.03, DARKG],
      [0, 0.025, -0.192, 0.04, 0.04, 0.006, LENS],
      [0, -0.005, -0.08, 0.02, 0.03, 0.03, DARKG],
      [0, -0.005, 0.07, 0.02, 0.03, 0.03, DARKG],
      [0, -0.12, 0.1, 0.045, 0.09, 0.045, IRON, 0.2],
    ];
    if (has(m, STOCK)) body.push(...skeleton(-0.07, 0.15, 0.3, 0.1, 0x5e4334));
    else body.push([0, -0.075, 0.34, 0.05, 0.1, 0.32, 0x5e4334]);
    let mz = -0.87;
    if (has(m, BARREL)) { body.push([0, -0.048, -0.93, 0.034, 0.034, 0.14, IRON], [0, -0.048, -1.02, 0.05, 0.05, 0.05, BLK]); mz = -1.05; }
    if (has(m, OPTIC)) body.push([0, 0.025, -0.2, 0.066, 0.066, 0.07, DARKG], [0, 0.025, 0.16, 0.06, 0.06, 0.04, DARKG], [0, 0.06, -0.02, 0.02, 0.022, 0.04, 0xff4d5e]);
    const mag = [[0, has(m, EXTMAG) ? -0.13 : -0.105, 0.0, 0.035, has(m, EXTMAG) ? 0.11 : 0.06, 0.08, 0x2fb5a8]];
    const pump = [[0.045, -0.035, 0.08, 0.05, 0.014, 0.014, 0xd9d9d9], [0.075, -0.035, 0.08, 0.02, 0.022, 0.022, 0xd9d9d9]];
    return { body: [...body, ...arms(0.1, -0.32)], mag, pump, muzzle: [0, -0.048, mz], hip: [0.23, -0.2, -0.42], ads: [0, -0.022, -0.3],
      recoil: 2.6, camKick: 0.02, flash: 0.3, style: 'mag', cyc: 'bolt' };
  },
  // ---- 3 Halberd: heavy rifle (olive, thick barrel, big brake, big scope, folded bipod)
  (m) => {
    const body = [
      [0, -0.06, 0.0, 0.085, 0.1, 0.38, 0x3a4538],
      [0, -0.055, -0.5, 0.05, 0.05, 0.62, 0x15181e],
      [0, -0.055, -0.36, 0.075, 0.075, 0.3, 0x2b332a],
      [0, -0.055, -0.86, 0.085, 0.07, 0.1, BLK],
      [0, -0.055, -0.86, 0.06, 0.1, 0.1, BLK],
      [0, 0.035, -0.03, 0.065, 0.065, 0.34, 0x181b21],
      [0, 0.035, -0.24, 0.09, 0.09, 0.07, 0x181b21],
      [0, 0.035, 0.17, 0.075, 0.075, 0.04, 0x181b21],
      [0, 0.035, -0.278, 0.07, 0.07, 0.006, LENS],
      [0, 0.0, -0.08, 0.03, 0.04, 0.04, DARKG],
      [0, 0.0, 0.1, 0.03, 0.04, 0.04, DARKG],
      [0.05, -0.14, -0.44, 0.014, 0.12, 0.014, 0x5b6358],
      [-0.05, -0.14, -0.44, 0.014, 0.12, 0.014, 0x5b6358],
      [0, -0.14, 0.12, 0.055, 0.12, 0.06, IRON, 0.25],
    ];
    if (has(m, STOCK)) body.push(...skeleton(-0.09, 0.17, 0.34, 0.15, 0x3a4538));
    else body.push([0, -0.09, 0.36, 0.075, 0.14, 0.3, 0x3a4538], [0, -0.015, 0.33, 0.06, 0.025, 0.2, 0x2b332a], [0, -0.09, 0.52, 0.08, 0.16, 0.03, BLK]);
    let mz = -0.92;
    if (has(m, BARREL)) { body.push([0, -0.055, -0.99, 0.05, 0.05, 0.14, 0x15181e], [0, -0.055, -1.1, 0.09, 0.075, 0.1, BLK], [0, -0.055, -1.1, 0.065, 0.105, 0.1, BLK]); mz = -1.17; }
    if (has(m, OPTIC)) body.push([0, 0.035, -0.29, 0.1, 0.1, 0.07, 0x181b21], [0, 0.035, 0.2, 0.085, 0.085, 0.04, 0x181b21], [0, 0.088, -0.03, 0.024, 0.026, 0.05, 0xff4d5e]);
    const mag = [[0, has(m, EXTMAG) ? -0.18 : -0.15, 0.02, 0.06, has(m, EXTMAG) ? 0.2 : 0.12, 0.12, 0xc9822b]];
    const pump = [[0.06, -0.04, 0.1, 0.07, 0.02, 0.02, 0xd9d9d9], [0.1, -0.04, 0.1, 0.028, 0.03, 0.03, 0xd9d9d9]];
    return { body: [...body, ...arms(0.12, -0.34)], mag, pump, muzzle: [0, -0.055, mz], hip: [0.25, -0.22, -0.46], ads: [0, -0.03, -0.32],
      recoil: 3.6, camKick: 0.03, flash: 0.48, style: 'mag', cyc: 'bolt' };
  },
  // ---- 4 Breaker: pump shotgun (red-brown wood, twin tubes, orange pump)
  (m) => {
    const ext = has(m, EXTMAG);
    const body = [
      [0, -0.065, 0.02, 0.08, 0.085, 0.38, 0x7a3b2a],
      [0, -0.036, -0.4, 0.05, 0.05, 0.52, 0x2a2f38],
      [0, -0.09, ext ? -0.42 : -0.36, 0.036, 0.036, ext ? 0.56 : 0.44, 0x3a3f48],
      [0, -0.006, -0.64, 0.012, 0.014, 0.012, 0xf2c744],
      [0, -0.145, 0.1, 0.05, 0.1, 0.05, 0x2a2f38],
    ];
    if (ext) body.push([0, -0.09, -0.7, 0.046, 0.046, 0.03, BLK]);
    if (has(m, STOCK)) body.push(...skeleton(-0.088, 0.18, 0.28, 0.11, 0x7a3b2a));
    else body.push([0, -0.088, 0.31, 0.062, 0.11, 0.26, 0x7a3b2a]);
    let mz = -0.68;
    if (has(m, BARREL)) { body.push([0, -0.036, -0.72, 0.056, 0.056, 0.14, 0x20242d], [0, -0.036, -0.8, 0.064, 0.064, 0.04, BLK]); mz = -0.83; }
    if (has(m, OPTIC)) body.push(...optic(-0.02, -0.02));
    const mag = [[0.06, -0.07, -0.02, 0.04, 0.04, 0.12, 0xe0483c], [0.06, -0.07, 0.1, 0.04, 0.04, 0.12, 0xe0483c]];
    const pump = [[0, -0.1, -0.3, 0.075, 0.065, 0.17, 0xf28c38]];
    return { body: [...body, ...arms(0.1, -0.33)], mag, pump, muzzle: [0, -0.036, mz], hip: [0.23, -0.21, -0.44], ads: [0, -0.012, -0.38],
      recoil: 2.3, camKick: 0.026, flash: 0.36, style: 'shell', cyc: 'pump' };
  },
  // ---- 5 Squall: drum-fed full-auto shotgun (dark steel, orange drum, fat shroud)
  (m) => {
    const ext = has(m, EXTMAG);
    const body = [
      [0, -0.06, 0.0, 0.08, 0.09, 0.34, 0x2f3540],
      [0, -0.05, -0.28, 0.1, 0.085, 0.26, 0x23272f],
      [0, 0.0, -0.28, 0.06, 0.012, 0.2, 0xf28c38],
      [0, -0.05, -0.43, 0.07, 0.07, 0.04, BLK],
      [0, 0.02, 0.02, 0.03, 0.025, 0.2, IRON],
      [0, -0.135, 0.12, 0.055, 0.12, 0.06, IRON, 0.25],
      [0, -0.14, -0.2, 0.04, 0.09, 0.05, IRON],
    ];
    if (has(m, STOCK)) body.push(...skeleton(-0.075, 0.17, 0.2, 0.1, 0x2f3540));
    else body.push([0, -0.075, 0.28, 0.06, 0.1, 0.18, 0x2f3540]);
    let mz = -0.47;
    if (has(m, BARREL)) { body.push([0, -0.05, -0.5, 0.08, 0.08, 0.1, 0x1b1f26], [0, -0.05, -0.57, 0.09, 0.09, 0.04, BLK]); mz = -0.6; }
    if (has(m, OPTIC)) body.push(...optic(0.03, 0.02));
    const r = ext ? 0.115 : 0.08, cy = ext ? -0.225 : -0.185;
    const mag = [[0, cy, -0.04, 0.07, r * 2, r * 2, 0xf28c38], [0, cy, -0.04, 0.07, r * 2, r * 2, 0xf28c38, Math.PI / 4], [0, cy, -0.04, 0.09, 0.05, 0.05, 0x23272f]];
    return { body: [...body, ...arms(0.12, -0.2)], mag, pump: null, muzzle: [0, -0.05, mz], hip: [0.22, -0.2, -0.44], ads: [0, 0.0, -0.38],
      recoil: 1.2, camKick: 0.005, flash: 0.32, style: 'mag', cyc: null };
  },
];

const vmCache = new Map();
export function buildViewmodel(gun, mask) {
  const k = (gun | 0) * 64 + (mask & 63);
  let v = vmCache.get(k);
  if (!v) { v = VM[gun] ? VM[gun](mask & 63) : VM[0](mask & 63); vmCache.set(k, v); }
  return v;
}

// ------------------------------------------------------------------------------- third person
const TP = [
  // 0 Maul
  (m) => {
    const bl = has(m, BARREL) ? 0.46 : 0.3;
    const p = [
      [0, 0, 0.55, 0.1, 0.14, 0.5, 0x3b4250],
      [0, 0.02, 0.8 + bl / 2, 0.04, 0.04, bl, 0x15181e],
      [0, has(m, EXTMAG) ? -0.2 : -0.14, 0.58, 0.07, has(m, EXTMAG) ? 0.3 : 0.2, 0.1, 0xc9822b],
      has(m, STOCK) ? [0, 0.0, 0.16, 0.04, 0.05, 0.3, 0x8a4b2a] : [0, -0.01, 0.15, 0.09, 0.16, 0.3, 0x8a4b2a],
      [0, -0.01, 0.78, 0.11, 0.12, 0.2, 0x8a4b2a],
    ];
    if (has(m, OPTIC)) p.push([0, 0.12, 0.5, 0.06, 0.07, 0.22, DARKG]);
    return { parts: p, muzzle: 0.8 + bl };
  },
  // 1 Vireo
  (m) => {
    const bl = has(m, BARREL) ? 0.3 : 0.16;
    const p = [
      [0, 0, 0.5, 0.08, 0.12, 0.42, 0x4d5b6b],
      [0, 0, 0.8, 0.07, 0.08, 0.22, 0x2fb5a8],
      [0, 0.01, 0.91 + bl / 2, 0.03, 0.03, bl, 0x15181e],
      [0, has(m, EXTMAG) ? -0.18 : -0.12, 0.52, 0.05, has(m, EXTMAG) ? 0.26 : 0.14, 0.07, 0xd7e2ea],
      [0, 0, 0.17, has(m, STOCK) ? 0.03 : 0.05, has(m, STOCK) ? 0.05 : 0.1, 0.28, 0x4d5b6b],
    ];
    if (has(m, OPTIC)) p.push([0, 0.11, 0.5, 0.055, 0.06, 0.2, DARKG]);
    return { parts: p, muzzle: 0.91 + bl };
  },
  // 2 Kestrel
  (m) => {
    const bl = has(m, BARREL) ? 0.9 : 0.74;
    const p = [
      [0, 0, 0.45, 0.07, 0.1, 0.34, 0x5e4334],
      [0, 0.01, 0.62 + bl / 2, 0.035, 0.035, bl, IRON],
      [0, 0.09, 0.5, has(m, OPTIC) ? 0.075 : 0.055, has(m, OPTIC) ? 0.075 : 0.055, 0.3, DARKG],
      has(m, STOCK) ? [0, 0.0, 0.16, 0.035, 0.07, 0.32, 0x5e4334] : [0, -0.01, 0.14, 0.07, 0.13, 0.32, 0x5e4334],
      [0, has(m, EXTMAG) ? -0.11 : -0.09, 0.45, 0.04, has(m, EXTMAG) ? 0.14 : 0.08, 0.08, 0x2fb5a8],
    ];
    return { parts: p, muzzle: 0.62 + bl };
  },
  // 3 Halberd
  (m) => {
    const ext = has(m, BARREL) ? 0.16 : 0;
    const p = [
      [0, 0, 0.5, 0.12, 0.16, 0.45, 0x3a4538],
      [0, 0.01, 1.0 + ext / 2, 0.07, 0.07, 0.7 + ext, 0x15181e],
      [0, 0.01, 1.38 + ext, 0.12, 0.1, 0.12, BLK],
      [0, 0.13, 0.5, has(m, OPTIC) ? 0.11 : 0.09, has(m, OPTIC) ? 0.11 : 0.09, 0.36, 0x181b21],
      has(m, STOCK) ? [0, 0.0, 0.14, 0.05, 0.1, 0.34, 0x3a4538] : [0, -0.01, 0.12, 0.11, 0.2, 0.34, 0x3a4538],
      [0, has(m, EXTMAG) ? -0.2 : -0.16, 0.5, 0.08, has(m, EXTMAG) ? 0.22 : 0.14, 0.14, 0xc9822b],
    ];
    return { parts: p, muzzle: 1.44 + ext };
  },
  // 4 Breaker
  (m) => {
    const bl = has(m, BARREL) ? 0.7 : 0.55;
    const p = [
      [0, 0, 0.5, 0.1, 0.12, 0.45, 0x7a3b2a],
      [0, 0.03, 0.7 + bl / 2, 0.05, 0.05, bl, 0x2a2f38],
      [0, -0.04, 0.68 + (has(m, EXTMAG) ? 0.28 : 0.22), 0.04, 0.04, has(m, EXTMAG) ? 0.56 : 0.45, 0x3a3f48],
      [0, -0.05, 0.85, 0.09, 0.08, 0.2, 0xf28c38],
      has(m, STOCK) ? [0, -0.01, 0.17, 0.04, 0.07, 0.3, 0x7a3b2a] : [0, -0.02, 0.15, 0.09, 0.15, 0.3, 0x7a3b2a],
    ];
    if (has(m, OPTIC)) p.push([0, 0.1, 0.5, 0.055, 0.06, 0.2, DARKG]);
    return { parts: p, muzzle: 0.7 + bl };
  },
  // 5 Squall
  (m) => {
    const ext = has(m, EXTMAG);
    const sl = has(m, BARREL) ? 0.42 : 0.3;
    const p = [
      [0, 0, 0.5, 0.1, 0.13, 0.42, 0x2f3540],
      [0, 0, 0.7 + sl / 2, 0.12, 0.12, sl, 0x23272f],
      [0, ext ? -0.23 : -0.19, 0.55, 0.1, ext ? 0.34 : 0.26, ext ? 0.34 : 0.26, 0xf28c38],
      has(m, STOCK) ? [0, 0, 0.17, 0.04, 0.07, 0.2, 0x2f3540] : [0, 0, 0.18, 0.08, 0.12, 0.2, 0x2f3540],
      [0, has(m, OPTIC) ? 0.12 : 0.1, 0.5, has(m, OPTIC) ? 0.055 : 0.04, has(m, OPTIC) ? 0.06 : 0.05, has(m, OPTIC) ? 0.2 : 0.25, has(m, OPTIC) ? DARKG : IRON],
    ];
    return { parts: p, muzzle: 0.7 + sl };
  },
];

const tpCache = new Map();
export function buildThird(gun, mask) {
  const k = (gun | 0) * 64 + (mask & 63);
  let v = tpCache.get(k);
  if (!v) { v = TP[gun] ? TP[gun](mask & 63) : TP[0](mask & 63); tpCache.set(k, v); }
  return v;
}

/** Per-gun tracer look: [width multiplier, length multiplier, r, g, b]. */
export const TRACER_STYLE = [
  [1.2, 1.0, 1.0, 0.8, 0.4],     // Maul: warm
  [0.8, 0.8, 0.6, 1.0, 0.9],     // Vireo: thin, teal-white
  [1.0, 1.6, 1.0, 1.0, 0.7],     // Kestrel: long
  [2.1, 2.0, 1.0, 0.55, 0.3],    // Halberd: fat orange streak
  [0.8, 0.5, 1.0, 0.8, 0.5],     // Breaker: short pellets
  [0.7, 0.45, 1.0, 0.65, 0.35],  // Squall: short pellets
];
