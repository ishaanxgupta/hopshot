import { createKit, mirrorSpawn, shade } from './_kit.js';
// Crate Cove - 28 x 28 m, small (2-8 players). A cramped dockside container yard at harbour dusk:
// shipping containers in rows and stacks two high (open-ended ones to run through, stacks you climb
// with crate steps), a gantry-crane base in the middle (climb the plinth, the posts are cover), oil
// drums and pallets in the lanes. x-mirror symmetric: team A on the west quay, team B on the east.
// Palette: rust, teal, mustard and slate under an orange-pink dusk sky.

const C = {
  ground: 0x8a8174, wall: 0x56627a, rust: 0xc0562a, teal: 0x2f8f8c, mustard: 0xd9a22b, red: 0xa83232, blue: 0x3f5f9f,
  green: 0x4f8a4a, slate: 0x6d7888, cream: 0xe8dcc0, drum: 0xb53a2a, pallet: 0xb48a54, crane: 0xf0b92a, dark: 0x2a2f3a,
};
const K = createKit('x');
const bounds = K.arena(-14, 14, -14, 14, 9.5, C.ground, C.wall);

// ---- quay surface: paving slabs and painted lanes (deco, no collision) ----
K.paint(-14, 0, -14, 14, 0.03, 14, shade(C.ground, 0.92));
for (let i = -3; i <= 3; i++) K.paint(-14, 0.03, i * 4 - 0.05, 14, 0.05, i * 4 + 0.05, shade(C.ground, 0.78));
K.paint(-0.15, 0.03, -14, 0.15, 0.06, 14, C.mustard);                                  // centre painted line
for (let z = -13; z < 13; z += 2) K.paint(-1.6, 0.03, z, 1.6, 0.05, z + 0.9, 0xf2e6a8);    // loading-bay hatching
// ---- perimeter: stacked containers seen from the inside (deco bands) ----
{
  const cols = [C.rust, C.teal, C.mustard, C.red, C.blue, C.green];
  let n = 0;
  for (let row = 0; row < 3; row++) for (let s = 0; s < 5; s++) {
    const a = -14 + s * 5.6, c1 = cols[(n++ * 7 + row) % cols.length], y0 = row * 2.9;
    K.paint(a + 0.1, y0 + 0.1, -13.97, a + 5.5, y0 + 2.7, -13.9, c1);
    K.paint(a + 0.1, y0 + 0.1, 13.9, a + 5.5, y0 + 2.7, 13.97, cols[(n * 5 + row) % cols.length]);
    K.paint(-13.97, y0 + 0.1, a + 0.1, -13.9, y0 + 2.7, a + 5.5, cols[(n * 3 + row + 1) % cols.length]);
    K.paint(13.9, y0 + 0.1, a + 0.1, 13.97, y0 + 2.7, a + 5.5, cols[(n * 3 + row + 2) % cols.length]);
  }
  K.paint(-14, 8.9, -14, 14, 9.5, -13.9, C.dark); K.paint(-14, 8.9, 13.9, 14, 9.5, 14, C.dark);
}

const drum = (x, z, col = C.drum) => { K.solid(x - 0.35, 0, z - 0.35, x + 0.35, 1.0, z + 0.35, col); K.paint(x - 0.38, 0.55, z - 0.38, x + 0.38, 0.65, z + 0.38, shade(col, 0.7)); K.paint(x - 0.3, 1.0, z - 0.3, x + 0.3, 1.04, z + 0.3, shade(col, 1.2)); };
const pallet = (x, z, h = 0.9, col = C.pallet) => { K.solid(x - 0.65, 0, z - 0.65, x + 0.65, h, z + 0.65, col); K.paint(x - 0.67, h * 0.4, z - 0.67, x + 0.67, h * 0.5, z + 0.67, shade(col, 0.72)); };

K.sym(() => {
  // home block: two open containers shield the flag stand, run-through from the quay strip to the yard
  K.container(-9.5, -4.8, 0, { color: C.rust, ends: 'both', stripe: C.cream });
  K.container(-9.5, 4.8, 0, { color: C.teal, ends: 'both', stripe: C.cream });
  K.solid(-13.3, 0, -1, -11.3, 0.3, 1, C.slate);                                  // flag stand
  K.paint(-13.2, 0.3, -0.9, -11.4, 0.34, 0.9, C.mustard);
  K.paint(-14, 0, -13, -13.9, 3.5, 13, C.dark);
  // north and south stacks: bottom container + upper container, crate steps up the west end
  K.container(-6.2, -11, 90, { color: C.mustard, ends: 'both' });
  K.container(-6.2, -11, 90, { color: C.blue, ends: 'both', y: 2.6 });
  K.crate(-11.0, -11.0, 1.2, 1.1, C.pallet); K.crate(-9.8, -11.0, 1.2, 2.2, C.cream);
  K.container(-6.2, 11, 90, { color: C.red, ends: 'both' });
  K.container(-6.2, 11, 90, { color: C.green, ends: 'both', y: 2.6 });
  K.crate(-11.0, 11.0, 1.2, 1.1, C.pallet); K.crate(-9.8, 11.0, 1.2, 2.2, C.cream);
  // cross containers flanking the central square
  K.container(-4.6, -4.5, 90, { len: 4, color: C.blue, ends: 'both' });
  K.container(-4.6, 4.5, 90, { len: 4, color: C.rust, ends: 'both' });
  // alley closers: tall crate stacks that stop the long straight lanes
  K.solid(-3.9, 0, -9.8, -3.2, 2.0, -7.8, C.pallet); K.solid(-3.9, 0, 7.8, -3.2, 2.0, 9.8, C.pallet);
  K.paint(-3.95, 0.9, -9.8, -3.15, 1.1, -7.8, shade(C.pallet, 0.7)); K.paint(-3.95, 0.9, 7.8, -3.15, 1.1, 9.8, shade(C.pallet, 0.7));
  // yard clutter
  drum(-1.0, -5.0); drum(-1.8, -5.2, C.green); drum(-1.0, 5.0); drum(-1.8, 5.2, C.mustard);
  pallet(-12.6, -8.6, 0.5); pallet(-12.6, 8.6, 0.5);
  K.crate(-12.6, -6.4, 1.1, 1.1, C.cream);
  K.crate(-12.6, 6.4, 1.1, 1.1, C.cream);
});

// ---- central gantry crane: plinth (jump up), machinery cabin, four posts, boom (deco) ----
K.solid(-2.6, 0, -2.6, 2.6, 1.1, 2.6, C.crane);
K.solid(-1.4, 1.1, -1.4, 1.4, 4.2, 1.4, C.red);                        // machinery house: blocks the long centre lines
for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
  K.solid(sx * 2.15 - 0.25, 1.1, sz * 2.15 - 0.25, sx * 2.15 + 0.25, 5.0, sz * 2.15 + 0.25, C.crane);
  K.paint(sx * 2.15 - 0.3, 1.1, sz * 2.15 - 0.3, sx * 2.15 + 0.3, 1.5, sz * 2.15 + 0.3, C.dark);
}
K.paint(-2.5, 5.0, -2.5, 2.5, 5.5, 2.5, C.crane);
K.paint(-12, 5.5, -0.5, 12, 6.1, 0.5, C.crane);
K.paint(-12, 6.1, -0.2, 12, 6.2, 0.2, C.dark);
K.paint(-0.8, 4.2, -0.8, 0.8, 7.2, 0.8, C.crane);
K.paint(-1.45, 2.2, -1.2, -1.4, 3.4, 1.2, 0xbfe3f0); K.paint(1.4, 2.2, -1.2, 1.45, 3.4, 1.2, 0xbfe3f0);
K.paint(7.8, 3.5, -0.04, 7.9, 5.5, 0.04, C.dark);
K.paint(7.3, 3.0, -0.35, 8.4, 3.5, 0.35, C.mustard);
K.paint(-2.6, 1.1, -2.6, 2.6, 1.14, 2.6, 0x3a3a3a);
for (let i = 0; i < 6; i++) K.paint(-2.6 + i * 0.9, 1.14, -2.6, -2.3 + i * 0.9, 1.17, 2.6, C.mustard);
K.sym(() => { K.solid(-0.7, 0, -13.9, 0.0, 2.0, -12.3, C.pallet); K.solid(-0.7, 0, 12.3, 0.0, 2.0, 13.9, C.pallet); });
K.solid(0.0, 0, -13.9, 0.7, 2.0, -12.3, C.pallet); K.solid(0.0, 0, 12.3, 0.7, 2.0, 13.9, C.pallet);

// ---- spawns ----
const A = [
  { pos: [-12.8, 0, -4.5], yaw: 0 }, { pos: [-12.8, 0, 4.5], yaw: Math.PI }, { pos: [-13, 0, -10.5], yaw: Math.PI }, { pos: [-13, 0, 10.5], yaw: 0 },
  { pos: [-6.6, 0, -8.8], yaw: 4.712 }, { pos: [-6.6, 0, 8.8], yaw: 4.712 }, { pos: [-12.6, 0, -13.1], yaw: 4.712 }, { pos: [-12.6, 0, 13.1], yaw: 4.712 },
];
const FFA = [
  ...A,
  ...A.map((s) => mirrorSpawn(s, 'x')),
  { pos: [-6.5, 0, -1.2], yaw: 4.712 }, { pos: [6.5, 0, 1.2], yaw: 1.571 },
];

export const MAP = {
  id: 'crate_cove',
  name: 'Crate Cove',
  blurb: 'Tight dockside container yard: run-through boxes, two-high stacks, a crane in the middle.',
  size: 'small',
  boxes: K.boxes,
  deco: K.deco,
  spawns: FFA,
  teamSpawns: { a: A, b: A.map((s) => mirrorSpawn(s, 'x')) },
  flags: { a: [-12.3, 0.3, 0], b: [12.3, 0.3, 0] },
  hardpoints: [
    { name: 'West Bay', min: [-8.2, 0, -3], max: [-2.8, 3, 3] },
    { name: 'East Bay', min: [2.8, 0, -3], max: [8.2, 3, 3] },
    { name: 'North Slip', min: [-2.7, 0, -11.5], max: [2.7, 3, -5.9] },
    { name: 'South Slip', min: [-2.7, 0, 5.9], max: [2.7, 3, 11.5] },
  ],
  theme: { skyTop: 0x6c5aa0, skyBottom: 0xffb27a, fog: 0xe9a98a, fogDensity: 0.014, sun: [-30, 22, 40] },
  bounds,
  killY: -20,
};
