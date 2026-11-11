// Cinder Loop - 40 x 40 m, small. Bases at the west and east ends, a walled "kiln" courtyard in the
// middle (the contested hardpoint) with a ring road around it to slide-hop, and two lanes (north and
// south) that zig-zag around cover walls. x-mirror symmetric (team A west, team B east).
// Palette: charcoal and ash, copper (team A) against ice-teal (team B), ember-orange sky.
import { createKit, mirrorSpawn } from './_kit.js';

const COL = {
  floor: 0x5d5157, wall: 0x3a3135, ash: 0x9c8f96, slate: 0x6c6068, gold: 0xffc65a,
  copperA: 0xff7a2e, iceB: 0x35c4d8, brick: 0xb5502f, coal: 0x5e525a,
};

const k = createKit('x');
const bounds = k.arena(-20, 20, -20, 20, 9, COL.floor, COL.wall);

// --- home areas (west drawn, east mirrored) ---
k.pair(-13.5, 0, -5, -12.5, 3.2, 5, COL.copperA, COL.iceB);        // front wall shielding the flag room
k.pair(-18, 0, -0.8, -16.4, 0.3, 0.8, COL.gold);                    // flag stand
k.pair(-19.5, 0, -4.2, -16, 1.3, -2.6, COL.ash);                    // crates flanking the flag
k.pair(-19.5, 0, 2.6, -16, 1.3, 4.2, COL.ash);
k.pair(-18, 0, 9, -16.5, 2.6, 10.5, COL.slate);                     // spawn pillars, south wing
k.pair(-18, 0, -10.5, -16.5, 2.6, -9, COL.slate);                   // spawn pillars, north wing
k.pair(-15, 0, 14, -12, 1.2, 15.5, COL.ash);
k.pair(-15, 0, -15.5, -12, 1.2, -14, COL.ash);
k.pair(-19.5, 0, 14.5, -18, 1.1, 17.5, COL.brick);                  // a 1.1 m jump-up ledge in each corner
k.pair(-19.5, 0, -17.5, -18, 1.1, -14.5, COL.brick);

// --- the kiln: walled courtyard, four 4 m doorways, 3.2 m walls ---
for (const [a, b] of [[-8, -2], [2, 8]]) {
  k.box(a, 0, -8, b, 3.2, -6.5, COL.brick);   // north wall
  k.box(a, 0, 6.5, b, 3.2, 8, COL.brick);     // south wall
}
k.pair(-8, 0, -6.5, -6.5, 3.2, -2, COL.brick);   // west wall, north half
k.pair(-8, 0, 2, -6.5, 3.2, 6.5, COL.brick);     // west wall, south half
// courtyard crates (the courtyard stays open in the middle for the hardpoint)
k.pair(-5.5, 0, -5.5, -4, 1.2, -4, COL.coal);
k.pair(-5.5, 0, 4, -4, 1.2, 5.5, COL.coal);
// jump-up steps to the kiln roofline pieces: 1.1 m blocks outside the corners
k.box(-1.5, 0, -10.8, 1.5, 1.1, -8.8, COL.ash);
k.box(-1.5, 0, 8.8, 1.5, 1.1, 10.8, COL.ash);

// --- north lane (z < 0): zig-zag walls ---
k.pair(-7.5, 0, -20, -6.5, 3, -13.5, COL.slate);
k.box(-2, 0, -14, 2, 3, -11.5, COL.coal);
k.pair(-11, 0, -12, -9.5, 1.2, -10, COL.ash);
// --- south lane (z > 0): a bar to slide under and a ledge ---
k.pair(-7.5, 0, 13.5, -6.5, 3, 20, COL.slate);
k.box(-2, 0, 11.5, 2, 3, 14, COL.coal);
k.pair(-11, 0, 10, -9.5, 2.4, 12, COL.ash);

const TEAM_A = [
  { pos: [-19.5, 0, -19], yaw: 3.927 },
  { pos: [-11, 0, 19], yaw: 5.890 },
  { pos: [-19.5, 0, 1], yaw: 4.712 },
  { pos: [-11, 0, -8], yaw: 3.927 },
  { pos: [-11, 0, 8], yaw: 5.498 },
  { pos: [-19.5, 0, 13.5], yaw: 5.105 },
  { pos: [-11, 0, -17], yaw: 3.534 },
  { pos: [-19.5, 0, -10], yaw: 3.534 },
];
const FFA = [
  { pos: [-19.5, 0, -19.5], yaw: 3.927 },
  { pos: [19.5, 0, 19.5], yaw: 0.785 },
  { pos: [19.5, 0, -19.5], yaw: 2.356 },
  { pos: [-19.5, 0, 19.5], yaw: 5.498 },
  { pos: [-14, 0, 0], yaw: 0.393 },
  { pos: [14, 0, 0], yaw: 3.534 },
  { pos: [0, 0, -14.5], yaw: 1.178 },
  { pos: [0, 0, 14.5], yaw: 1.963 },
  { pos: [-11.5, 0, 11.5], yaw: 0.000 },
  { pos: [11.5, 0, 11.5], yaw: 0.000 },
  { pos: [-10.5, 0, -13], yaw: 4.320 },
  { pos: [10.5, 0, -13], yaw: 1.963 },
  { pos: [-19.5, 0, -8.5], yaw: 4.320 },
  { pos: [19.5, 0, -8.5], yaw: 1.963 },
  { pos: [-19.5, 0, 7.5], yaw: 4.712 },
  { pos: [19.5, 0, 7.5], yaw: 1.571 },
  { pos: [-8, 0, 19.5], yaw: 0.393 },
  { pos: [8, 0, 19.5], yaw: 5.890 },
];

export const MAP = {
  id: 'cinder_loop',
  name: 'Cinder Loop',
  blurb: 'Tiny walled kiln in the middle and a slide-hop ring around it. Everyone meets in seconds.',
  size: 'small',
  boxes: k.boxes,
  bounds,
  killY: -20,
  spawns: FFA,
  teamSpawns: { a: TEAM_A, b: TEAM_A.map((s) => mirrorSpawn(s, 'x')) },
  flags: { a: [-17.2, 0.3, 0], b: [17.2, 0.3, 0] },
  hardpoints: [
    { name: 'Kiln', min: [-3, 0, -3], max: [3, 3, 3] },
    { name: 'North Run', min: [-3, 0, -19], max: [3, 3, -14] },
    { name: 'South Run', min: [-3, 0, 14], max: [3, 3, 19] },
  ],
  theme: { skyTop: 0x2a1530, skyBottom: 0xff9a55, fog: 0x7a4a45, fogDensity: 0.014, sun: [-30, 28, 40] },
};
