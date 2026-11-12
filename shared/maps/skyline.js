import { createKit, mirrorSpawn, shade } from './_kit.js';
// Skyline - 64 x 64 m, medium (4-12 players), vertical. The roofs of a city block at hazy sunset: seven
// separate rooftops at three heights with a deliberate void between them (fall = death), AC units,
// water tanks, stairwell huts you can walk into, billboards, planks and bridges between the roofs and a
// few open gaps you can slide-hop across. Every roof is also linked by a walkable plank (bots cannot jump
// gaps). x-mirror symmetric: team A holds the west roof, team B the east roof.
// Palette: dusty rose, slate and brick under an orange-to-violet sky.

const C = {
  tarW: 0x82808c, tarM: 0x94889a, tarC: 0xa38f9c, wall: 0x4f4a5a, brick: 0xb4654a, slate: 0x58607a, plank: 0xc29a62, plankD: 0x7a5a36,
  ac: 0xc8ccd2, acD: 0x8a9098, tank: 0xb06a3c, tankD: 0x6d4328, bill: 0xe8a02c, bill2: 0x3fa0b8, hut: 0xcfc2ac, hutRoof: 0x58607a,
  orange: 0xf28c38, glass: 0xf6d98a, dark: 0x2b2733, flag: 0xf2c744, pipe: 0x9aa0a8, street: 0x302c38,
};
const K = createKit('x');
const FLOOR = -26, TOP = 17;
// perimeter: neighbouring tower faces, closed from below the void to above every roof prop
{
  const W = C.wall;
  K.solid(-33, FLOOR, -33, 33, TOP, -32, W); K.solid(-33, FLOOR, 32, 33, TOP, 33, W);
  K.solid(-33, FLOOR, -32, -32, TOP, 32, W); K.solid(32, FLOOR, -32, 33, TOP, 32, W);
  // lit windows on the inner faces (deco)
  for (let row = 0; row < 5; row++) for (let i = 0; i < 12; i++) {
    const y = 1.5 + row * 3, a = -30 + i * 5.2, lit = ((i * 7 + row * 3) % 5) < 2;
    const c = lit ? C.glass : shade(C.wall, 0.7);
    K.paint(a, y, -32.04, a + 2.6, y + 1.8, -32, c); K.paint(a, y, 32, a + 2.6, y + 1.8, 32.04, ((i * 5 + row) % 4) < 2 ? C.glass : shade(C.wall, 0.7));
    K.paint(-32.04, y, a, -32, y + 1.8, a + 2.6, ((i * 3 + row * 2) % 5) < 2 ? C.glass : shade(C.wall, 0.7)); K.paint(32, y, a, 32.04, y + 1.8, a + 2.6, ((i * 4 + row) % 5) < 2 ? C.glass : shade(C.wall, 0.7));
  }
}
// the street, far below (deco only: you die at killY long before you reach it)
K.paint(-32, -23.6, -32, 32, -23.4, 32, C.street);
for (let i = -28; i < 30; i += 8) { K.paint(i, -23.4, -32, i + 3, -23.3, 32, 0x4a4552); K.paint(-32, -23.4, i, 32, -23.3, i + 3, 0x4a4552); }

const roofCols = [C.tarW, C.tarM, C.tarC];
// a rooftop: a solid block from the void up to y, with parapet lip, gravel and seams drawn on top
function roof(x0, z0, x1, z1, y, color, ci = 0) {
  K.solid(x0, FLOOR, z0, x1, y, z1, color);
  const lip = shade(color, 1.25), t = 0.14;
  K.paint(x0, y, z0, x1, y + 0.12, z0 + t, lip); K.paint(x0, y, z1 - t, x1, y + 0.12, z1, lip);
  K.paint(x0, y, z0, x0 + t, y + 0.12, z1, lip); K.paint(x1 - t, y, z0, x1, y + 0.12, z1, lip);
  for (let k = 0; k < 4; k++) {
    const px = x0 + ((k * 5.3 + 2) % (x1 - x0 - 3)), pz = z0 + ((k * 3.7 + 1) % (z1 - z0 - 3));
    K.paint(px, y, pz, px + 3, y + 0.03, pz + 2.2, shade(color, k % 2 ? 0.88 : 1.12));
  }
  for (let d = -22; d < y; d += 3.2) {              // floor lines down the faces
    const c = shade(color, 0.8 - ((d + 22) / 3.2 % 2) * 0.1);
    K.paint(x0 - 0.04, d, z0 - 0.04, x1 + 0.04, d + 0.5, z0, c); K.paint(x0 - 0.04, d, z1, x1 + 0.04, d + 0.5, z1 + 0.04, c);
    K.paint(x0 - 0.04, d, z0, x0, d + 0.5, z1, c); K.paint(x1, d, z0, x1 + 0.04, d + 0.5, z1, c);
  }
  void ci;
}
// waist-high parapet (0.8 m) round a roof's exposed edges, with gaps where planks and gates are: bots strafing in a
// fight no longer walk off, players can still hop over it into the void on purpose
function parapet(x0, z0, x1, z1, y, gaps = {}) {
  const T = 0.25, H = 0.8, col = C.slate;
  const cut = (a, b, list = []) => {
    let segs = [[a, b]];
    for (const [g0, g1] of list) segs = segs.flatMap(([s0, s1]) => (g1 <= s0 || g0 >= s1 ? [[s0, s1]] : [[s0, Math.min(s1, g0)], [Math.max(s0, g1), s1]].filter(([u, v]) => v - u > 0.05)));
    return segs;
  };
  for (const [a, b] of cut(x0, x1, gaps.n)) { K.solid(a, y, z0, b, y + H, z0 + T, col); K.paint(a, y + H, z0 - 0.02, b, y + H + 0.07, z0 + T + 0.02, shade(col, 1.3)); }
  for (const [a, b] of cut(x0, x1, gaps.s)) { K.solid(a, y, z1 - T, b, y + H, z1, col); K.paint(a, y + H, z1 - T - 0.02, b, y + H + 0.07, z1 + 0.02, shade(col, 1.3)); }
  for (const [a, b] of cut(z0, z1, gaps.w)) { K.solid(x0, y, a, x0 + T, y + H, b, col); K.paint(x0 - 0.02, y + H, a, x0 + T + 0.02, y + H + 0.07, b, shade(col, 1.3)); }
  for (const [a, b] of cut(z0, z1, gaps.e)) { K.solid(x1 - T, y, a, x1, y + H, b, col); K.paint(x1 - T - 0.02, y + H, a, x1 + 0.02, y + H + 0.07, b, shade(col, 1.3)); }
}
function plank(x0, z0, x1, z1, y) {
  K.solid(x0, y - 0.25, z0, x1, y, z1, C.plank);
  if ((x1 - x0) > (z1 - z0)) { K.solid(x0, y, z0, x1, y + 0.8, z0 + 0.1, C.plankD); K.solid(x0, y, z1 - 0.1, x1, y + 0.8, z1, C.plankD); }
  else { K.solid(x0, y, z0, x0 + 0.1, y + 0.8, z1, C.plankD); K.solid(x1 - 0.1, y, z0, x1, y + 0.8, z1, C.plankD); }
  const alongX = (x1 - x0) > (z1 - z0), n = Math.round((alongX ? x1 - x0 : z1 - z0) / 0.9);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (alongX) K.paint(x0 + (x1 - x0) * t - 0.03, y, z0, x0 + (x1 - x0) * t + 0.03, y + 0.02, z1, C.plankD);
    else K.paint(x0, y, z0 + (z1 - z0) * t - 0.03, x1, y + 0.02, z0 + (z1 - z0) * t + 0.03, C.plankD);
  }
  if (alongX) { K.paint(x0, y - 0.45, z0, x1, y - 0.25, z0 + 0.12, C.plankD); K.paint(x0, y - 0.45, z1 - 0.12, x1, y - 0.25, z1, C.plankD); }
  else { K.paint(x0, y - 0.45, z0, x0 + 0.12, y - 0.25, z1, C.plankD); K.paint(x1 - 0.12, y - 0.45, z0, x1, y - 0.25, z1, C.plankD); }
}
function ac(x, z, y, w = 2.2, d = 1.2, h = 1.2, rot = 0) {
  const hx = (rot ? d : w) / 2, hz = (rot ? w : d) / 2;
  K.solid(x - hx, y, z - hz, x + hx, y + h, z + hz, C.ac);
  K.paint(x - hx - 0.03, y, z - hz - 0.03, x + hx + 0.03, y + 0.25, z + hz + 0.03, C.acD);
  K.paint(x - hx * 0.6, y + h, z - hz * 0.6, x + hx * 0.6, y + h + 0.08, z + hz * 0.6, C.dark);
  K.paint(x - 0.12, y + h, z - hz * 0.6, x + 0.12, y + h + 0.1, z + hz * 0.6, C.acD);
}
function tank(x, z, y) {
  for (const sx of [-1.2, 1.2]) for (const sz of [-1.2, 1.2]) K.solid(x + sx - 0.2, y, z + sz - 0.2, x + sx + 0.2, y + 3.0, z + sz + 0.2, C.tankD);
  K.paint(x - 1.3, y + 1.4, z - 1.3, x + 1.3, y + 1.55, z + 1.3, C.tankD);
  K.solid(x - 1.7, y + 3.0, z - 1.7, x + 1.7, y + 5.4, z + 1.7, C.tank);
  for (let i = 0; i < 4; i++) K.paint(x - 1.75, y + 3.4 + i * 0.55, z - 1.75, x + 1.75, y + 3.5 + i * 0.55, z + 1.75, C.tankD);
  K.paint(x - 1.2, y + 5.4, z - 1.2, x + 1.2, y + 5.8, z + 1.2, C.tankD);
  K.paint(x + 1.7, y, z - 0.15, x + 1.78, y + 5.2, z + 0.15, C.pipe);
}
function billboard(x, z, y, w, h, alongZ, color, legs = 2.4) {
  const t = 0.3;
  if (alongZ) {
    K.solid(x - t / 2, y + legs, z - w / 2, x + t / 2, y + legs + h, z + w / 2, color);
    for (const s of [-1, 1]) K.solid(x - 0.2, y, z + s * (w / 2 - 0.5) - 0.2, x + 0.2, y + legs, z + s * (w / 2 - 0.5) + 0.2, C.dark);
    K.paint(x + t / 2, y + legs + 0.3, z - w / 2 + 0.4, x + t / 2 + 0.04, y + legs + h - 0.3, z + w / 2 - 0.4, shade(color, 1.25));
    K.paint(x - t / 2 - 0.04, y + legs + 0.3, z - w / 2 + 0.4, x - t / 2, y + legs + h - 0.3, z + w / 2 - 0.4, shade(color, 1.25));
    K.paint(x + t / 2, y + legs + h * 0.35, z - w * 0.3, x + t / 2 + 0.06, y + legs + h * 0.65, z + w * 0.1, C.dark);
    K.paint(x - t / 2 - 0.06, y + legs + h * 0.35, z - w * 0.1, x - t / 2, y + legs + h * 0.65, z + w * 0.3, C.dark);
  } else {
    K.solid(x - w / 2, y + legs, z - t / 2, x + w / 2, y + legs + h, z + t / 2, color);
    for (const s of [-1, 1]) K.solid(x + s * (w / 2 - 0.5) - 0.2, y, z - 0.2, x + s * (w / 2 - 0.5) + 0.2, y + legs, z + 0.2, C.dark);
    K.paint(x - w / 2 + 0.4, y + legs + 0.3, z + t / 2, x + w / 2 - 0.4, y + legs + h - 0.3, z + t / 2 + 0.04, shade(color, 1.25));
    K.paint(x - w / 2 + 0.4, y + legs + 0.3, z - t / 2 - 0.04, x + w / 2 - 0.4, y + legs + h - 0.3, z - t / 2, shade(color, 1.25));
    K.paint(x - w * 0.3, y + legs + h * 0.35, z + t / 2, x + w * 0.1, y + legs + h * 0.65, z + t / 2 + 0.06, C.dark);
    K.paint(x - w * 0.1, y + legs + h * 0.35, z - t / 2 - 0.06, x + w * 0.3, y + legs + h * 0.65, z - t / 2, C.dark);
  }
}
function hut(x, z, y, doorSide, rot = 0) {
  const side = { [doorSide]: [{ a: -0.8, b: 0.8, head: 2.0 }] };
  const r = K.building(x, z, rot, { w: 3.6, d: 3.6, y, th: 0.25, floors: 1, h1: 2.2, wall: C.hut, trim: C.brick, roofC: C.hutRoof, floorC: C.acD, roof: 'flat', g: side, fake: { n: [], s: [], w: [], e: [] } });
  void r;
}
const duct = (x0, z0, x1, z1, y, h = 2.0) => { K.solid(x0, y, z0, x1, y + h, z1, C.pipe); K.paint(x0 - 0.03, y + h * 0.45, z0 - 0.03, x1 + 0.03, y + h * 0.55, z1 + 0.03, C.acD); };

K.sym(() => {
  // ---------------- West roof (home): level 0 ----------------
  roof(-30, -12, -17, 12, 0, C.tarW);
  parapet(-30, -12, -17.6, 12, 0, { n: [[-25.2, -22.8]], s: [[-25.2, -22.8]], e: [[-12, 12]] });
  hut(-28.2, -9.8, 0, 's'); hut(-28.2, 9.8, 0, 'n');
  K.crate(-25.6, -9.8, 1.2, 1.2, C.plank); K.crate(-25.6, 9.8, 1.2, 1.2, C.plank);        // step up to the hut roofs
  K.solid(-28.6, 0, -1.0, -26.6, 0.3, 1.0, C.acD); K.paint(-28.5, 0.3, -0.9, -26.7, 0.34, 0.9, C.flag);   // flag stand
  duct(-29.6, -3.4, -26.2, -2.7, 0, 2.2); duct(-29.6, 2.7, -26.2, 3.4, 0, 2.2);              // shelter the flag stand
  ac(-22, -7.5, 0); ac(-22, 7.5, 0);
  tank(-22.5, 0, 0);
  // roof-edge cooling wall towards the centre, with two gates (plank gate and slide-hop gate)
  for (const [a, b] of [[-12, -6.8], [-3.2, 3.2], [6.8, 12]]) {
    K.solid(-17.6, 0, a, -17.0, 2.4, b, C.slate);
    K.paint(-17.65, 1.2, a, -16.95, 1.35, b, C.orange); K.paint(-17.65, 2.4, a, -16.95, 2.5, b, C.dark);
  }
  duct(-26, -7.6, -23.4, -6.9, 0); duct(-26, 6.9, -23.4, 7.6, 0);
  duct(-30, -5.8, -28.4, -4.8, 0, 2.2); duct(-30, 4.8, -28.4, 5.8, 0, 2.2);
  // ---------------- North-west and south-west roofs: level 1.1 ----------------
  for (const sz of [-1, 1]) {
    const z0 = sz < 0 ? -30 : 16, z1 = sz < 0 ? -16 : 30, zc = (z0 + z1) / 2;
    roof(-30, z0, -17, z1, 1.1, C.tarM);
    parapet(-30, z0, -17, z1, 1.1, { [sz < 0 ? 's' : 'n']: [[-25.2, -22.8]], e: [[sz < 0 ? -25.2 : 22.8, sz < 0 ? -22.8 : 25.2]] });
    ac(-26, zc - 1.5 * sz, 1.1, 2.2, 1.2, 1.2); ac(-21, zc + 3 * sz, 1.1, 1.2, 2.2, 1.2);
    duct(-28.6, zc + 1.5 * sz, -26.4, zc + 2.5 * sz, 1.1, 2.2);
    billboard(-23.5, sz < 0 ? -29.6 : 29.6, 1.1, 6, 2.6, false, C.bill2, 2.4);
    K.crate(-18.4, zc, 1.1, 1.1, C.plank);
    plank(-25, sz < 0 ? -16 : 12, -23, sz < 0 ? -12 : 16, 1.1);              // west roof <-> corner roof (flush with the higher roof)
    plank(-17, sz < 0 ? -25 : 23, -13, sz < 0 ? -23 : 25, 2.2);       // corner roof <-> mid roof
  }
  // ---------------- North and south mid roofs: level 2.2 ----------------
  for (const sz of [-1, 1]) {
    const z0 = sz < 0 ? -30 : 18, z1 = sz < 0 ? -18 : 30, zc = (z0 + z1) / 2;
    roof(-13, z0, 13, z1, 2.2, C.tarC);
    parapet(-13, z0, 13, z1, 2.2, { [sz < 0 ? 's' : 'n']: [[-6.2, -3.8], [3.8, 6.2]], w: [[sz < 0 ? -25.2 : 22.8, sz < 0 ? -22.8 : 25.2]], e: [[sz < 0 ? -25.2 : 22.8, sz < 0 ? -22.8 : 25.2]] });
    hut(-11.2, zc, 2.2, sz < 0 ? 's' : 'n');
    K.crate(-8.8, zc, 1.2, 1.2, C.plank, 0, 2.2);
    ac(-1.0, zc + 3.4 * sz, 2.2, 2.2, 1.2, 1.2, 0);
    billboard(0, sz < 0 ? -29.6 : 29.6, 2.2, 8, 3, false, C.orange, 2.4);
    duct(-1.5, zc - 0.5, 1.5, zc + 0.5, 2.2, 2.2);
  }
  // ---------------- Centre roof: level 1.1, a tall lift core in the middle ----------------
  roof(-9, -11, 9, 11, 1.1, C.tarW);
  parapet(-9, -11, 9, 11, 1.1, { n: [[-6.2, -3.8], [3.8, 6.2]], s: [[-6.2, -3.8], [3.8, 6.2]], w: [[-6.2, -3.8], [3, 7]], e: [[-6.2, -3.8], [3, 7]] });
  K.solid(-1.6, 1.1, -1.6, 1.6, 6.1, 1.6, C.slate);
  K.paint(-1.7, 4.8, -1.7, 1.7, 5.0, 1.7, C.orange); K.paint(-1.7, 5.9, -1.7, 1.7, 6.2, 1.7, C.dark);
  K.paint(-0.4, 6.2, -0.4, 0.4, 8.4, 0.4, C.pipe);
  ac(-6.2, -1.2, 1.1, 1.2, 2.2, 1.2); ac(-6.2, 1.2 + 0.0, 1.1, 1.2, 2.2, 1.2);
  duct(-7.8, -9.8, -6.3, -8.8, 1.1, 2.2); duct(-7.8, 8.8, -6.3, 9.8, 1.1, 2.2);
  plank(-17, -6, -9, -4, 1.1);                         // west roof <-> centre (the z = +5 side is an open slide-hop gap)
  plank(-6, -18, -4, -11, 2.2); plank(-6, 11, -4, 18, 2.2);   // mid roofs <-> centre
});

// ---- spawns (west roof + corner roofs) ----
const A = [
  { pos: [-26.5, 0, 0], yaw: 3.927 }, { pos: [-23, 0, -3], yaw: 0.000 }, { pos: [-23, 0, 3], yaw: 0.000 }, { pos: [-27, 0, -7], yaw: 5.498 },
  { pos: [-27, 0, 7], yaw: 3.927 }, { pos: [-19.5, 0, 0], yaw: 0.000 }, { pos: [-22.5, 0, -9], yaw: 0.000 }, { pos: [-22.5, 0, 9], yaw: 0.000 },
];
const X = [
  { pos: [-11.5, 2.2, -23], yaw: 2.749 }, { pos: [-11.5, 2.2, 25], yaw: 0.4 }, { pos: [-29, 1.1, -21], yaw: 3.534 }, { pos: [-29, 1.1, 21], yaw: 2.5 },
];
const FFA = [...A, ...A.map((s) => mirrorSpawn(s, 'x')), ...X, ...X.map((s) => mirrorSpawn(s, 'x'))];

export const MAP = {
  id: 'skyline',
  name: 'Skyline',
  blurb: 'Rooftop city block: AC units, water tanks, planks over a deadly void and slide-hop gaps.',
  size: 'medium',
  boxes: K.boxes,
  deco: K.deco,
  spawns: FFA,
  teamSpawns: { a: A, b: A.map((s) => mirrorSpawn(s, 'x')) },
  flags: { a: [-27.6, 0.3, 0], b: [27.6, 0.3, 0] },
  hardpoints: [
    { name: 'Lift Core North', min: [-3, 1.1, -10.5], max: [3, 4.1, -4.5] },
    { name: 'Lift Core South', min: [-3, 1.1, 4.5], max: [3, 4.1, 10.5] },
    { name: 'North Deck West', min: [-8.0, 2.2, -27], max: [-2.0, 5.2, -21] },
    { name: 'North Deck East', min: [2.0, 2.2, -27], max: [8.0, 5.2, -21] },
  ],
  theme: { skyTop: 0x4d3f7e, skyBottom: 0xffa66e, fog: 0xf2b08c, fogDensity: 0.009, sun: [-40, 14, -30] },
  bounds: { min: [-33, FLOOR, -33], max: [33, 40, 33] },
  killY: -22,
};
