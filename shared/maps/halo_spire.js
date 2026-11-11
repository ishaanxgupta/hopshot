// Halo Spire - 64 x 64 m, large and vertical. Four stepped pylons (1.1 / 2.2 / 3.3 m tiers) are joined
// by a ring of 3 m wide bridges at 2.2 m (the halo) around an open atrium; shelves along the outer walls
// give a second level; bases sit in opposite corners (north-west and south-east). 180-degree rotational
// symmetry (team A north-west, team B south-east). Palette: night violet and slate with
// neon magenta (A) against cyan (B).
import { createKit, mirrorSpawn } from './_kit.js';

const COL = {
  floor: 0x5b5590, wall: 0x2f2a58, slate: 0x7570b0, steel: 0x8f89c9, deck: 0xb9b1f2, glow: 0xf0edff,
  magA: 0xe23fa8, cyanB: 0x22d0e8, gold: 0xffd45e, plum: 0x9a5db5, teal: 0x2fb0c0,
};

const k = createKit('xz');
const bounds = k.arena(-32, 32, -32, 32, 16, COL.floor, COL.wall);

// --- pylons: three tiers, each a 1.1 m jump-up from the last ---
function pylon(cx, cz) {
  k.box(cx - 4, 0, cz - 4, cx + 4, 1.1, cz + 4, COL.slate);
  k.box(cx - 3, 1.1, cz - 3, cx + 3, 2.2, cz + 3, COL.steel);
  k.box(cx - 1.8, 2.2, cz - 1.8, cx + 1.8, 3.3, cz + 1.8, COL.glow);
}
pylon(14, 14); pylon(-14, -14);
pylon(14, -14); pylon(-14, 14);

// --- the halo: bridge decks at 2.2 m (1.9 m clearance underneath) ---
k.pair(12.5, 1.9, -11, 15.5, 2.2, 11, COL.deck);    // east + west decks
k.pair(-11, 1.9, 12.5, 11, 2.2, 15.5, COL.deck);    // south + north decks

// --- outer shelves (2.2 m) with 1.1 m step blocks at both ends ---
k.pair(-12, 0, -31.5, 12, 2.2, -28.5, COL.plum);    // north shelf (+ south)
k.pair(-14.5, 0, -31.5, -12, 1.1, -28.5, COL.slate);
k.pair(12, 0, -31.5, 14.5, 1.1, -28.5, COL.slate);
k.pair(-31.5, 0, -12, -28.5, 2.2, 12, COL.teal);    // west shelf (+ east)
k.pair(-31.5, 0, -14.5, -28.5, 1.1, -12, COL.slate);
k.pair(-31.5, 0, 12, -28.5, 1.1, 14.5, COL.slate);

// --- home areas: corner pockets walled from the lanes, flag on a small stand ---
k.pair(-22.5, 0, -31, -21.5, 3.2, -25.5, COL.magA, COL.cyanB);
k.pair(-31, 0, -22.5, -25.5, 3.2, -21.5, COL.magA, COL.cyanB);
k.pair(-27.8, 0, -27.8, -26.2, 0.3, -26.2, COL.gold);
k.pair(-31, 0, -26, -29.4, 1.3, -23.5, COL.glow);
k.pair(-26, 0, -31, -23.5, 1.3, -29.4, COL.glow);
k.pair(-20, 0, -26, -18.5, 2.6, -22, COL.slate);
k.pair(-26, 0, -20, -22, 2.6, -18.5, COL.slate);

// --- atrium and lane cover ---
k.pair(4, 0, 4, 6, 1.2, 6, COL.steel);
k.pair(4, 0, -6, 6, 1.2, -4, COL.steel);
k.pair(-3, 0, -19.6, 3, 2.4, -18.4, COL.slate);
k.pair(-19.6, 0, -3, -18.4, 2.4, 3, COL.slate);

// --- kiosks: two-tier 1.1 m steps on the open flanks, all around ---
function kiosk(x0, z0, x1, z1) {
  k.pair(x0, 0, z0, x1, 1.1, z1, COL.steel);
  k.pair(x0 + 1, 1.1, z0 + 1, x1 - 1, 2.2, z1 - 1, COL.glow);
}
kiosk(-10, -24.5, -6.5, -21); kiosk(6.5, -24.5, 10, -21);
kiosk(-24.5, -10, -21, -6.5); kiosk(-24.5, 6.5, -21, 10);

const TEAM_A = [
  { pos: [-31.5, 0, -31.5], yaw: 3.927 },
  { pos: [-17, 0, -18.5], yaw: 4.320 },
  { pos: [-29.5, 0, -19.5], yaw: 3.927 },
  { pos: [-21, 0, -28], yaw: 4.320 },
  { pos: [-27.5, 0, -26], yaw: 3.927 },
  { pos: [-23, 0, -21], yaw: 4.320 },
  { pos: [-25.5, 0, -31.5], yaw: 1.963 },
  { pos: [-25.5, 0, -17], yaw: 4.320 },
  { pos: [-18, 0, -23], yaw: 3.927 },
  { pos: [-21, 0, -17], yaw: 3.534 },
];
const FFA = [
  { pos: [-31.5, 0, -31.5], yaw: 3.927 },
  { pos: [31.5, 0, 31.5], yaw: 0.785 },
  { pos: [31.5, 0, -31.5], yaw: 2.356 },
  { pos: [-31.5, 0, 31.5], yaw: 5.498 },
  { pos: [0, 0, -20.5], yaw: 4.712 },
  { pos: [0, 0, 20.5], yaw: 1.571 },
  { pos: [-25.5, 0, 0], yaw: 4.712 },
  { pos: [25.5, 0, 0], yaw: 1.571 },
  { pos: [-18.5, 0, -17.5], yaw: 3.534 },
  { pos: [18.5, 0, 17.5], yaw: 0.393 },
  { pos: [18.5, 0, -15.5], yaw: 3.142 },
  { pos: [-18.5, 0, 15.5], yaw: 0.000 },
  { pos: [11, 0, -28], yaw: 3.142 },
  { pos: [-11, 0, 28], yaw: 0.000 },
  { pos: [-11, 0, -28], yaw: 3.142 },
  { pos: [10.5, 0, 28], yaw: 0.000 },
  { pos: [30, 0, -19.5], yaw: 1.963 },
  { pos: [-30, 0, 19.5], yaw: 5.105 },
  { pos: [-30, 0, -19.5], yaw: 3.927 },
  { pos: [30, 0, 19.5], yaw: 0.785 },
  { pos: [21, 0, 29.5], yaw: 1.178 },
  { pos: [-21, 0, -31.5], yaw: 3.927 },
  { pos: [21, 0, -31.5], yaw: 2.749 },
  { pos: [-21, 0, 31.5], yaw: 5.890 },
  { pos: [-26.5, 0, -10], yaw: 5.105 },
  { pos: [26.5, 0, 10], yaw: 1.963 },
];

export const MAP = {
  id: 'halo_spire',
  name: 'Halo Spire',
  blurb: 'Vertical night arena: bridges, pylons and shelves wrapped around an open atrium.',
  size: 'large',
  boxes: k.boxes,
  bounds,
  killY: -20,
  spawns: FFA,
  teamSpawns: { a: TEAM_A, b: TEAM_A.map((s) => mirrorSpawn(s, 'xz')) },
  flags: { a: [-27, 0.3, -27], b: [27, 0.3, 27] },
  hardpoints: [
    { name: 'Atrium', min: [-3, 0, -3], max: [3, 3, 3] },
    { name: 'North Court', min: [-3, 0, -26], max: [3, 3, -20] },
    { name: 'South Court', min: [-3, 0, 20], max: [3, 3, 26] },
    { name: 'West Court', min: [-26, 0, -3], max: [-20, 3, 3] },
    { name: 'East Court', min: [20, 0, -3], max: [26, 3, 3] },
  ],
  theme: { skyTop: 0x120a2e, skyBottom: 0x5a3a9a, fog: 0x2a2150, fogDensity: 0.009, sun: [-25, 70, 35] },
};
