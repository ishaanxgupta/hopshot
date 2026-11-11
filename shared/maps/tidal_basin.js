// Tidal Basin - 40 x 40 m, small. A sunken 18 m basin (1.1 m deep, every wall a jump-up) in the middle,
// bases at the north and south ends, raised docks on the east and west rims. Three lanes: the basin
// itself and one lane down each side past the docks. z-mirror symmetric (team A north, team B south).
// Palette: sand and sea-glass, coral (team A) against deep blue (team B), pale peach sky.
import { createKit, mirrorSpawn } from './_kit.js';

const COL = {
  sand: 0xe6d8b8, sandDark: 0xcdbb94, water: 0x56c2c4, wall: 0xf3efe6, shell: 0xf4f1ea, reef: 0x2f8f94,
  coralA: 0xff6f61, blueB: 0x2b59c3, gold: 0xf5c451, stone: 0xb8b2a4, deck: 0x8c6f4e,
};

const k = createKit('z');
const bounds = k.arena(-20, 20, -20, 20, 10, null, COL.wall);

// --- floor with a sunken basin (floor boxes reach down so the basin walls are solid) ---
k.box(-21, -3, -21, 21, 0, -9, COL.sand);     // north
k.box(-21, -3, 9, 21, 0, 21, COL.sand);       // south
k.box(-21, -3, -9, -9, 0, 9, COL.sand);       // west
k.box(9, -3, -9, 21, 0, 9, COL.sand);         // east
k.box(-9, -3, -9, 9, -1.1, 9, COL.water);     // basin floor

// --- home areas ---
k.pair(-5, 0, -12.5, 5, 3.2, -11.5, COL.coralA, COL.blueB);       // screen in front of the flag room
k.pair(-0.8, 0, -17.8, 0.8, 0.3, -16.2, COL.gold);                // flag stand
k.pair(-4.5, 0, -18.8, -2.6, 1.3, -15.6, COL.shell, COL.shell);   // crates beside the flag
k.pair(2.6, 0, -18.8, 4.5, 1.3, -15.6, COL.shell, COL.shell);
k.quad(-19.5, 0, -17, -14.5, 2.4, -16, COL.stone);                // spawn wing walls
k.quad(-14, 0, -15, -12, 1.2, -13.5, COL.deck);                   // low crates

// --- basin rim: tall posts and low stepping crates ---
k.quad(-11, 0, -11, -9.5, 3.4, -9.5, COL.reef);
k.quad(-6.5, 0, -12, -5.5, 1.2, -10, COL.stone);

// --- docks on the east and west rims: 2.2 m tops with 1.1 m steps on both ends ---
k.quad(-13, 0, -3, -10, 2.2, 3, COL.deck);
k.quad(-13, 0, -5, -10, 1.1, -3, COL.sandDark);
// --- low shells on the side lanes ---
k.quad(-17, 0, -9, -15.5, 1.2, -6.5, COL.shell);
k.quad(-18, 0, 6.5, -16.5, 2.6, 8, COL.stone);

// --- inside the basin: jetties and blocks for cover (tops 1.1 m above the rim, rims are 1.1 m jump-ups) ---
k.pair(-2, -1.1, -9, 2, 0, -6, COL.sandDark);
k.quad(-7, -1.1, -4.5, -5.5, 1.1, -3, COL.reef);
// --- side lane cover ---
k.quad(-16.5, 0, -13, -15.5, 3, -10, COL.stone);
k.quad(-9, 0, -16.5, -8, 2.4, -13, COL.shell);

const TEAM_A = [
  { pos: [-19.5, 0, -19.5], yaw: 4.320 },
  { pos: [19.5, 0, -17.5], yaw: 1.178 },
  { pos: [-0.5, 0, -13], yaw: 5.105 },
  { pos: [-12, 0, -11], yaw: 3.142 },
  { pos: [10.5, 0, -11.5], yaw: 1.571 },
  { pos: [-8, 0, -19.5], yaw: 3.534 },
  { pos: [5, 0, -19.5], yaw: 3.534 },
  { pos: [12.5, 0, -19.5], yaw: 2.749 },
];
const FFA = [
  { pos: [-19.5, 0, -19.5], yaw: 4.320 },
  { pos: [19.5, 0, 19.5], yaw: 1.178 },
  { pos: [19.5, 0, -19.5], yaw: 1.963 },
  { pos: [-19.5, 0, 19.5], yaw: 5.105 },
  { pos: [0, 0, -13], yaw: 1.178 },
  { pos: [0, 0, 13], yaw: 1.963 },
  { pos: [-15.5, 0, 0], yaw: 4.712 },
  { pos: [15.5, 0, 0], yaw: 1.571 },
  { pos: [-11.5, 0, -11], yaw: 3.142 },
  { pos: [11.5, 0, -11], yaw: 3.142 },
  { pos: [-11.5, 0, 11], yaw: 0.000 },
  { pos: [11.5, 0, 11], yaw: 0.000 },
  { pos: [-7, 0, -19.5], yaw: 3.534 },
  { pos: [7, 0, -19.5], yaw: 2.749 },
  { pos: [-7, 0, 19.5], yaw: 5.890 },
  { pos: [7, 0, 19.5], yaw: 0.393 },
  { pos: [-19.5, 0, -8], yaw: 3.534 },
  { pos: [19.5, 0, -8], yaw: 2.749 },
];

export const MAP = {
  id: 'tidal_basin',
  name: 'Tidal Basin',
  blurb: 'A sunken basin with a dock on each rim. Drop in, hop out, and slide the sand lanes.',
  size: 'small',
  boxes: k.boxes,
  bounds,
  killY: -20,
  spawns: FFA,
  teamSpawns: { a: TEAM_A, b: TEAM_A.map((s) => mirrorSpawn(s, 'z')) },
  flags: { a: [0, 0.3, -17], b: [0, 0.3, 17] },
  hardpoints: [
    { name: 'Basin', min: [-3, -1.1, -3], max: [3, 1.9, 3] },
    { name: 'West Shore', min: [-20, 0, -3], max: [-14, 3, 3] },
    { name: 'East Shore', min: [14, 0, -3], max: [20, 3, 3] },
  ],
  theme: { skyTop: 0x7cc8e6, skyBottom: 0xfbe2c6, fog: 0xcfe9ee, fogDensity: 0.008, sun: [20, 60, -30] },
};
