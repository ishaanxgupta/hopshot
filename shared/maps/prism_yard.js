import { mirrorSpawn } from './_kit.js';
// Hopshot arena "Prism Yard" - 70 x 70 m, axis-aligned boxes only.
// Export shape (contract):
//   boxes:  axis-aligned solid boxes, min/max corners in metres, color 0xRRGGBB
//   spawns: feet positions with a facing yaw (radians; yaw 0 looks down -Z, + turns left)
//   bounds: playable volume; killY: falling below this kills the player
//
// Layout: stepped centre block with stairs, four corner towers (jump-up routes, 2.2 m tops),
// bleachers along the E/W walls (0.3 m steps), canopies to slide under on the N/S lanes,
// tall cover walls, low crates and a clear ring around the centre for slide-hop loops.

const boxes = [];
function box(x0, y0, z0, x1, y1, z1, color) {
  boxes.push({ min: [x0, y0, z0], max: [x1, y1, z1], color });
}
// Mirror a feature (given in the +x,+z quadrant) into all four quadrants.
function quad(x0, y0, z0, x1, y1, z1, color) {
  box(x0, y0, z0, x1, y1, z1, color);
  box(-x1, y0, z0, -x0, y1, z1, color);
  box(x0, y0, -z1, x1, y1, -z0, color);
  box(-x1, y0, -z1, -x0, y1, -z0, color);
}
// Mirror across x only / z only.
function mirX(x0, y0, z0, x1, y1, z1, color) {
  box(x0, y0, z0, x1, y1, z1, color);
  box(-x1, y0, z0, -x0, y1, z1, color);
}
function mirZ(x0, y0, z0, x1, y1, z1, color) {
  box(x0, y0, z0, x1, y1, z1, color);
  box(x0, y0, -z1, x1, y1, -z0, color);
}

const C = {
  floor: 0xa7c4a0, wall: 0x93a6c4, orange: 0xf28c38, teal: 0x2fb5a8, blue: 0x4f7df0,
  yellow: 0xf2c744, purple: 0x8a63d2, pink: 0xe9638b, slate: 0x6f7f96, cream: 0xefe6d2,
  mint: 0x7fd8a6, coral: 0xff7a6b,
};

// --- floor and perimeter (closed) ---
box(-36, -1, -36, 36, 0, 36, C.floor);
box(-36, 0, -36, 36, 10, -35, C.wall);   // north
box(-36, 0, 35, 36, 10, 36, C.wall);     // south
box(-36, 0, -35, -35, 10, 35, C.wall);   // west
box(35, 0, -35, 36, 10, 35, C.wall);     // east

// --- centre block: 1.1 m jump-up + 1.1 m second tier, stairs (0.275 m steps) north and south ---
box(-6, 0, -6, 6, 1.1, 6, C.orange);
box(-3, 1.1, -3, 3, 2.2, 3, C.cream);
for (let i = 0; i < 3; i++) {
  const h = 0.275 * (3 - i);
  box(-2, 0, 6 + i, 2, h, 7 + i, C.yellow);
  box(-2, 0, -7 - i, 2, h, -6 - i, C.yellow);
}

// --- corner towers: 2.2 m top reached via two 1.1 m jump-up blocks ---
quad(22, 0, 22, 30, 2.2, 30, C.blue);
quad(18.5, 0, 23, 22, 1.1, 27, C.teal);
quad(23, 0, 18.5, 27, 1.1, 22, C.teal);

// --- tall cover walls breaking the long diagonals ---
quad(12, 0, 16, 13, 3, 26, C.slate);

// --- low crates and a pillar ---
quad(7, 0, 13, 9.5, 1.2, 15.5, C.pink);
quad(17, 0, 8, 19, 4, 10, C.purple);

// --- bleachers on the east/west walls: 0.3 m steps up to a 1.2 m ledge ---
for (const sx of [1, -1]) {
  for (const sz of [1, -1]) {
    const z0 = sz > 0 ? 8 : -16, z1 = sz > 0 ? 16 : -8;
    if (sx > 0) {
      box(33, 0, z0, 35, 1.2, z1, C.mint);
      box(32, 0, z0, 33, 0.9, z1, C.mint);
      box(31, 0, z0, 32, 0.6, z1, C.mint);
      box(30, 0, z0, 31, 0.3, z1, C.mint);
    } else {
      box(-35, 0, z0, -33, 1.2, z1, C.mint);
      box(-33, 0, z0, -32, 0.9, z1, C.mint);
      box(-32, 0, z0, -31, 0.6, z1, C.mint);
      box(-31, 0, z0, -30, 0.3, z1, C.mint);
    }
  }
}

// --- N/S canopies (slide under, 2.6 m clearance) ---
mirZ(-9, 0, 22, -7, 2.6, 24, C.coral);
mirZ(7, 0, 22, 9, 2.6, 24, C.coral);
mirZ(-9, 2.6, 22, 9, 3.4, 24, C.coral);

// --- east/west chicane ---
mirX(24, 0, -4, 26, 1.2, -1.5, C.orange);
mirX(24, 0, 1.5, 26, 2.4, 4, C.orange);

// --- inner ring stumps ---
quad(9, 0, 9, 11, 1.2, 11, C.yellow);

// --- home areas (x-mirrored): flag stand, flank crates, front wall for cover ---
mirX(-33.5, 0, -1, -31.5, 0.3, 1, C.coral);
mirX(-34, 0, -5.5, -31, 1.3, -4, C.orange);
mirX(-34, 0, 4, -31, 1.3, 5.5, C.orange);
mirX(-29, 0, -3, -28, 3, 3, C.slate);

// --- north/south balconies (1.2 m then 2.4 m) ---
mirZ(-14, 0, 31, 14, 1.2, 35, C.teal);
mirZ(-5, 1.2, 33, 5, 2.4, 35, C.cream);

// Spawns sit next to cover, facing a way out; tools/maps.test.js enforces it.
const TEAM_A = [
  { pos: [-34.5, 0, -30], yaw: 3.534 },
  { pos: [-30.5, 0, 30], yaw: 4.320 },
  { pos: [-29.5, 0, 0], yaw: 0.393 },
  { pos: [-34.5, 0, 16.5], yaw: 5.105 },
  { pos: [-32, 0, -16.5], yaw: 4.320 },
  { pos: [-30.5, 0, -24], yaw: 2.749 },
  { pos: [-30.5, 0, 22.5], yaw: 5.890 },
  { pos: [-34.5, 0, 2], yaw: 4.712 },
];
const FFA = [
  { pos: [-34.5, 0, -34.5], yaw: 3.927 },
  { pos: [34.5, 0, 34.5], yaw: 0.785 },
  { pos: [34.5, 0, -34.5], yaw: 2.356 },
  { pos: [-34.5, 0, 34.5], yaw: 5.498 },
  { pos: [-29.5, 0, 0], yaw: 0.393 },
  { pos: [29.5, 0, 0], yaw: 3.534 },
  { pos: [-7.5, 0, -24.5], yaw: 4.320 },
  { pos: [-7.5, 0, 24.5], yaw: 5.105 },
  { pos: [15.5, 0, -19.5], yaw: 3.142 },
  { pos: [15.5, 0, 19.5], yaw: 0.000 },
  { pos: [-34, 0, -17], yaw: 4.320 },
  { pos: [34, 0, -17], yaw: 1.963 },
  { pos: [-34, 0, 17], yaw: 5.105 },
  { pos: [34, 0, 17], yaw: 1.178 },
  { pos: [-18, 0, -10.5], yaw: 4.712 },
  { pos: [-18, 0, 10.5], yaw: 4.712 },
  { pos: [19, 0, -34.5], yaw: 2.749 },
  { pos: [19, 0, 34.5], yaw: 0.393 },
  { pos: [-19, 0, -34.5], yaw: 3.534 },
  { pos: [-19, 0, 34.5], yaw: 5.890 },
  { pos: [19.5, 0, 8.5], yaw: 0.393 },
  { pos: [8, 0, -27], yaw: 2.356 },
  { pos: [8, 0, 27], yaw: 0.785 },
  { pos: [-16, 0, -20], yaw: 3.534 },
  { pos: [-16, 0, 20], yaw: 5.890 },
  { pos: [-30.5, 0, -26], yaw: 2.749 },
];

export const MAP = {
  id: 'prism_yard',
  name: 'Prism Yard',
  blurb: 'Big pastel plaza with a stepped centre, towers and slide-hop rings.',
  size: 'large',
  boxes,
  spawns: FFA,
  teamSpawns: { a: TEAM_A, b: TEAM_A.map((s) => mirrorSpawn(s, 'x')) },
  flags: { a: [-32.5, 0.3, 0], b: [32.5, 0.3, 0] },
  hardpoints: [
    { name: 'North Court', min: [-3, 0, -16], max: [3, 3, -10] },
    { name: 'South Court', min: [-3, 0, 10], max: [3, 3, 16] },
    { name: 'West Lane', min: [-23, 0, -3], max: [-17, 3, 3] },
    { name: 'East Lane', min: [17, 0, -3], max: [23, 3, 3] },
  ],
  theme: { skyTop: 0x6fa8e8, skyBottom: 0xf6e3c8, fog: 0xdfe6ee, fogDensity: 0.006, sun: [40, 80, 25] },
  bounds: { min: [-36, -1, -36], max: [36, 40, 36] },
  killY: -20,
};
