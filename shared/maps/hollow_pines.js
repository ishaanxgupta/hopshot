import { createKit, mirrorSpawn, shade } from './_kit.js';
// Hollow Pines - 60 x 60 m, medium (4-12 players). A misty pine forest cut by a shallow creek that runs
// north-south down the middle. A log cabin on each side (door, windows, a back door and a loft up the
// stairs), a fallen log across the creek, boulders for cover, and a ranger lookout on stilts in the
// middle: two long staircases lead up to the cab. x-mirror symmetric: team A west, team B east.
// Palette: moss and bark, cold blue water, grey-green mist.

const C = {
  moss: 0x4f6b3e, needles: 0x5d5a3a, dirt: 0x6e5a3f, rockWall: 0x59645b, bark: 0x6b4a2f, pine: 0x2c5e3a, pine2: 0x356b3f,
  log: 0x8b5a2b, logDark: 0x5b3a1e, roof: 0x4a3a30, rock: 0x8c9690, rock2: 0x767f7a, water: 0x4f86b0, bed: 0x6d6a5a,
  plank: 0xb98a55, plankDark: 0x7a5630, flag: 0xd9b24a, fire: 0x7a6f66,
};
const K = createKit('x');
const bounds = K.arena(-30, 30, -30, 30, 13, null, C.rockWall);
// ground: two banks and a 0.3 m deep creek bed between them
K.solid(-31, -1, -31, -1.5, 0, 31, C.moss);
K.solid(1.5, -1, -31, 31, 0, 31, C.moss);
K.solid(-1.5, -1, -31, 1.5, -0.3, 31, C.bed);
K.paint(-1.5, -0.3, -30, 1.5, -0.12, 30, C.water);
K.paint(-0.2, -0.12, -30, 0.2, -0.1, 30, 0x9cc6e0);
// cliff face texture on the perimeter walls (strata bands, inside faces)
for (let i = 0; i < 4; i++) {
  const y = 1.2 + i * 3, c = shade(C.rockWall, 0.82 + (i % 2) * 0.2);
  K.paint(-30, y, -29.95, 30, y + 1.6, -29.9, c); K.paint(-30, y, 29.9, 30, y + 1.6, 29.95, c);
  K.paint(-29.95, y, -30, -29.9, y + 1.6, 30, c); K.paint(29.9, y, -30, 29.95, y + 1.6, 30, c);
}
// needle patches and dirt trails (deco)
{
  let s = 99; const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < 70; i++) {
    const x = (r() * 2 - 1) * 28, z = (r() * 2 - 1) * 28, w = 1 + r() * 3, d = 1 + r() * 3;
    if (Math.abs(x) < 3) continue;
    K.paint(x - w / 2, 0, z - d / 2, x + w / 2, 0.02 + (i % 3) * 0.005, z + d / 2, i % 2 ? C.needles : shade(C.moss, 1.12));
  }
  K.paint(-14, 0, -0.9, -1.5, 0.03, 0.9, C.dirt); K.paint(-30, 0, -0.9, -25, 0.03, 0.9, C.dirt);
  K.paint(1.5, 0, -0.9, 14, 0.03, 0.9, C.dirt); K.paint(25, 0, -0.9, 30, 0.03, 0.9, C.dirt);
}

// ---- ranger lookout on stilts over the creek (on the axis, so built once) ----
for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  K.solid(sx * 2.0 - 0.3, 0, sz * 2.0 - 0.3, sx * 2.0 + 0.3, 4.6, sz * 2.0 + 0.3, C.bark);
  K.paint(sx * 2.0 - 0.35, 0, sz * 2.0 - 0.35, sx * 2.0 + 0.35, 0.4, sz * 2.0 + 0.35, C.rock2);
}
K.paint(-2.3, 2.1, -2.0, 2.3, 2.4, -1.95, C.plankDark); K.paint(-2.3, 2.1, 1.95, 2.3, 2.4, 2.0, C.plankDark);
K.paint(-2.0, 2.4, -2.3, -1.95, 2.7, 2.3, C.plankDark); K.paint(1.95, 2.4, -2.3, 2.0, 2.7, 2.3, C.plankDark);
K.solid(-2.7, 4.6, -2.7, 2.7, 4.8, 2.7, C.plank);
K.solid(-2.7, 4.8, -2.7, 2.7, 5.9, -2.58, C.plankDark); K.solid(-2.7, 4.8, 2.58, 2.7, 5.9, 2.7, C.plankDark);
for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.solid(sx * 2.55 - 0.12, 4.8, sz * 2.55 - 0.12, sx * 2.55 + 0.12, 7.4, sz * 2.55 + 0.12, C.bark);
K.solid(-3.2, 7.4, -3.2, 3.2, 7.7, 3.2, C.roof);
K.paint(-3.3, 7.7, -3.3, 3.3, 8.1, 3.3, shade(C.roof, 1.15)); K.paint(-2.0, 8.1, -2.0, 2.0, 8.5, 2.0, shade(C.roof, 1.3));
K.paint(0, 8.5, -0.05, 0.1, 10.6, 0.05, 0x3a3a3a); K.paint(0.1, 9.7, -0.04, 1.3, 10.6, 0.04, 0xd6422f);   // pennant
K.paint(-2.4, 5.9, -2.74, 2.4, 6.0, -2.58, shade(C.plankDark, 1.2)); K.paint(-2.4, 5.9, 2.58, 2.4, 6.0, 2.74, shade(C.plankDark, 1.2));
K.sym(() => {
  K.solid(-2.7, 4.8, -2.7, -2.58, 5.9, -1.0, C.plankDark); K.solid(-2.7, 4.8, 1.0, -2.58, 5.9, 2.7, C.plankDark);
  const f = K.frame(0, 0, 0, 0);
  const st = K.stairs(f, -9.0, 0, 'x+', 2.0, 4.8, C.plank);
  f.d(-9.0, 0.3, -1.15, -2.6, 0.5, -1.0, C.plankDark); f.d(-9.0, 0.3, 1.0, -2.6, 0.5, 1.15, C.plankDark);
  for (let i = 0; i < 6; i++) { const x = -8.6 + i * 1.1; f.d(x, 0, -1.15, x + 0.15, 1.0 + i * 0.8, -1.0, C.bark); f.d(x, 0, 1.0, x + 0.15, 1.0 + i * 0.8, 1.15, C.bark); }
  void st;
});

// ---- log cabins (door east, back door west, loft over the west half) ----
const FY = 2.7;
K.sym(() => {
  K.bandC = shade(C.log, 0.62);
  const win = (a, b) => ({ a, b, sill: 1.0, head: 2.2 });
  const uwin = (a, b) => ({ a, b, sill: FY + 0.9, head: FY + 2.1 });
  const r = K.building(-19.5, 0, 0, {
    w: 11, d: 8, th: 0.3, floors: 2, h1: 2.5, h2: 2.5, wall: C.log, trim: C.logDark, roofC: C.roof, floorC: C.plank, roof: 'cabin',
    g: {
      e: [{ a: -0.8, b: 0.8, head: 2.3 }, win(-2.9, -1.6), win(1.6, 2.9)],
      w: [{ a: -0.8, b: 0.8, head: 2.3 }, win(-3.5, -2.8), win(2.8, 3.5)],
      n: [win(-3.6, -2.3), win(2.3, 3.6)],
      s: [win(-3.6, -2.3), win(2.3, 3.6), win(-0.6, 0.6)],
    },
    upper: { x0: -5.5, z0: -4, x1: 0.6, z1: 4 }, upperWalls: true,
    u: { n: [uwin(-3.6, -2.3)], s: [uwin(-3.6, -2.3), uwin(-0.6, 0.6)], w: [uwin(-1, 1)], e: [{ a: -1, b: 1, sill: FY + 0.6, head: FY + 2.0 }] },
    stairs: { x: 4.0, z: -3.0, dir: 'x-', width: 1.4 },
    chimney: { x: -1.2, z: 0 }, chimneyC: C.fire,
  });
  K.bandC = null;
  r.f.b(0.5, FY, -2.0, 0.6, FY + 1.0, 3.7, shade(C.plank, 0.75));          // loft rail (open at the stairs)
  r.f.b(-1.0, 0, -0.6, 1.0, 2.5, 0.6, C.fire);                                // fireplace column
  r.f.d(-1.0, 0.0, -0.64, 1.0, 0.5, 0.64, C.dirt); r.f.d(-0.4, 0.5, 0.6, 0.4, 1.2, 0.66, 0xe0782a);
  r.f.d(-5.4, 0, 3.0, -3.6, 0.7, 3.8, 0x7a4a30); r.f.d(-3.5, 0, -3.6, -2.6, 0.5, -2.9, 0x7a4a30);
  r.f.d(-3.0, 0.01, -1.2, 1.0, 0.04, 1.4, 0x7a2e2e);                           // rug
});

// ---- the fallen log over the creek, boulders, stumps ----
K.solid(-5.5, 0.0, -10.5, 5.5, 0.95, -9.6, C.bark);
K.paint(-5.6, 0.2, -10.6, -5.5, 0.85, -9.5, 0xc9a97a); K.paint(5.5, 0.2, -10.6, 5.6, 0.85, -9.5, 0xc9a97a);
for (let x = -4.5; x < 5; x += 1.6) K.paint(x, 0.95, -10.4, x + 0.5, 1.02, -9.7, 0x4f7a3c);
K.paint(-5.0, 0.6, -10.8, -4.2, 0.8, -10.5, C.bark); K.paint(3.6, 0.3, -9.4, 4.6, 0.55, -9.1, C.bark);
K.solid(-4.0, 0, 11.4, 4.0, 0.7, 12.1, C.bark);                                // a smaller log, south
K.paint(-4.1, 0.15, 11.3, -4.0, 0.6, 12.2, 0xc9a97a); K.paint(4.0, 0.15, 11.3, 4.1, 0.6, 12.2, 0xc9a97a);

// ---- keep-outs for the random forest (west half, mirrored) ----
const OUT = [
  [-27, -6.5, -12.5, 6.5], [-31, -9, -24, 9], [-10.5, -4.5, -1.0, 4.5], [-4.5, -12.5, 0, -8], [-4, 9.5, 0, 14.5],
  [-13, -16.5, -5.0, -7.0], [-13, 7.0, -5.0, 16.5], [-23, 10, -15, 16.2], [-23, -16.2, -15, -10], [-31, 18, -20, 29], [-31, -29, -20, -18],
];
const ROCKS = [
  [-28.5, -5.5, 2.4, 1.6, 1.1], [-28.5, 5.5, 2.4, 1.6, 1.1], [-27.8, -10.5, 2.2, 2.0, 1.5], [-27.8, 10.5, 2.2, 2.0, 1.5],
  [-8.5, -6.2, 2.6, 2.0, 1.1], [-8.5, 6.2, 2.6, 2.0, 1.1], [-6.2, -18, 3.0, 2.4, 1.6], [-6.2, 18, 3.0, 2.4, 1.6],
  [-12, -22, 2.2, 1.8, 1.5], [-12, 22, 2.2, 1.8, 1.5], [-3.0, -4.5, 1.4, 1.4, 1.0], [-3.0, 4.5, 1.4, 1.4, 1.0],
  [-26, -20, 2.6, 2.2, 1.3], [-26, 20, 2.6, 2.2, 1.3], [-18.5, -7.5, 1.6, 1.2, 0.8], [-18.5, 7.5, 1.6, 1.2, 0.8],
  // tall outcrops (2.4 m) screen the long straight lanes between the two halves
  [-6.0, -3.0, 2.2, 3.0, 2.4], [-6.0, 3.0, 2.2, 3.0, 2.4], [-13.5, -12.2, 3.2, 2.2, 2.4], [-13.5, 12.2, 3.2, 2.2, 2.4],
  [-8.5, -21.5, 3.4, 2.4, 2.4], [-8.5, 21.5, 3.4, 2.4, 2.4], [-18.5, -15.5, 2.6, 2.6, 2.4], [-18.5, 15.5, 2.6, 2.6, 2.4],
  [-5.5, -26, 3.0, 2.0, 2.4], [-5.5, 26, 3.0, 2.0, 2.4],
  [-22.4, -17.6, 2.0, 1.6, 1.4], [-22.4, 17.6, 2.0, 1.6, 1.4],
];
const SPAWN_XZ = [[-28.4, -3.2], [-28.4, 3.2], [-28.5, -8.4], [-28.5, 8.4], [-26.2, -12.2], [-26.2, 12.2], [-24.5, -15.5], [-24.5, 15.5], [-15, -21.5], [-15, 21.5], [-9.5, -26.2], [-9.5, 26.2]];
const trees = [];
K.sym(() => {
  let s = 4242; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const blocked = (x, z) => SPAWN_XZ.some(([sx, sz]) => Math.hypot(x - sx, z - sz) < 2.4) || OUT.some(([x0, z0, x1, z1]) => x > x0 && x < x1 && z > z0 && z < z1) || ROCKS.some(([rx, rz, w, d]) => Math.abs(x - rx) < w / 2 + 1.6 && Math.abs(z - rz) < d / 2 + 1.6);
  for (let tries = 0; tries < 4000 && trees.length < 34; tries++) {
    const x = -3.8 - rnd() * 24.5, z = (rnd() * 2 - 1) * 28.4;
    if (blocked(x, z) || trees.some(([tx, tz]) => Math.hypot(tx - x, tz - z) < 4.6)) continue;
    trees.push([x, z]);
  }
  trees.forEach(([x, z], i) => K.tree(x, z, { h: 6.5 + (i * 7 % 5) * 0.7, t: 0.5 + (i % 3) * 0.1, leaf: i % 2 ? C.pine : C.pine2, trunk: i % 4 ? C.bark : shade(C.bark, 0.8) }));
  for (const [x, z, w, d, h] of ROCKS) K.rock(x, z, w, d, h, h > 1.3 ? C.rock2 : C.rock);
  K.rock(-14.6, -6.8, 1.0, 1.0, 0.5, C.bark); K.rock(-14.6, 6.8, 1.0, 1.0, 0.5, C.bark);
  K.solid(-28.5, 0, -1, -26.5, 0.3, 1, C.fire);                               // flag stand
  K.paint(-28.4, 0.3, -0.9, -26.6, 0.34, 0.9, C.flag);
});

// ---- spawns ----
const A = [
  { pos: [-28.4, 0, -3.2], yaw: 0 }, { pos: [-28.4, 0, 3.2], yaw: 3.14159 }, { pos: [-28.5, 0, -8.4], yaw: 0.6 }, { pos: [-28.5, 0, 8.4], yaw: 2.5 },
  { pos: [-26.2, 0, -12.2], yaw: 1.2 }, { pos: [-26.2, 0, 12.2], yaw: 1.9 }, { pos: [-24.5, 0, -15.5], yaw: 4.4 }, { pos: [-24.5, 0, 15.5], yaw: 4.9 },
];
const FFA = [
  ...A, ...A.map((s) => mirrorSpawn(s, 'x')),
  { pos: [-15, 0, -21.5], yaw: 0 }, { pos: [15, 0, 21.5], yaw: 0 }, { pos: [-15, 0, 21.5], yaw: 3.14159 }, { pos: [15, 0, -21.5], yaw: 3.14159 },
  { pos: [-9.5, 0, -26.2], yaw: 3.14159 }, { pos: [9.5, 0, 26.2], yaw: 0 },
];

export const MAP = {
  id: 'hollow_pines',
  name: 'Hollow Pines',
  blurb: 'Misty pine forest: log cabins with lofts, a creek, a fallen log and a ranger lookout.',
  size: 'medium',
  boxes: K.boxes,
  deco: K.deco,
  spawns: FFA,
  teamSpawns: { a: A, b: A.map((s) => mirrorSpawn(s, 'x')) },
  flags: { a: [-27.5, 0.3, 0], b: [27.5, 0.3, 0] },
  hardpoints: [
    { name: 'North Clearing', min: [-12, 0, -16], max: [-6, 3, -10] },
    { name: 'South Clearing', min: [-12, 0, 10], max: [-6, 3, 16] },
    { name: 'Far Clearing', min: [6, 0, -16], max: [12, 3, -10] },
    { name: 'Hollow', min: [6, 0, 10], max: [12, 3, 16] },
  ],
  theme: { skyTop: 0x7f9a98, skyBottom: 0xc9d6cd, fog: 0xb4c4bb, fogDensity: 0.022, sun: [20, 40, -30] },
  bounds,
  killY: -20,
};
