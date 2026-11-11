// Dune Relay - 60 x 44 m, medium. Three parallel lanes between two walled home courts: a container
// yard (north), a flat corridor with sand dunes and the central hardpoint (middle), and an arcade of
// slide-under arches (south). Long lane walls have doorways so you can hop between lanes.
// x-mirror symmetric (team A west, team B east). Palette: desert sand, rust, ochre; sun-orange (A)
// against turquoise (B); hazy apricot sky.
import { createKit, mirrorSpawn } from './_kit.js';

const COL = {
  sand: 0xe8cc96, wall: 0x8a5d3b, rust: 0xb5532f, ochre: 0xd89a3a, clay: 0xc77b4d, stone: 0xf3e2b8,
  gold: 0xffd45e, sunA: 0xf5862a, tealB: 0x1fb5a0, dune: 0xe6c690, shade: 0x8a5a3a,
};

const k = createKit('x');
const bounds = k.arena(-30, 30, -22, 22, 10, COL.sand, COL.wall);

// --- home courts (west drawn) ---
k.pair(-21.5, 0, -9, -20.5, 3.2, -2.5, COL.sunA, COL.tealB);      // gate wall, north half
k.pair(-21.5, 0, 2.5, -20.5, 3.2, 9, COL.sunA, COL.tealB);        // gate wall, south half
k.pair(-24, 0, -1.5, -23, 1.2, 1.5, COL.clay);                    // low barrier behind the gate mouth
k.pair(-26.8, 0, -0.8, -25.2, 0.3, 0.8, COL.gold);                // flag stand
k.pair(-29.5, 0, -5.2, -27, 1.3, -3.4, COL.clay);                 // crates beside the flag
k.pair(-29.5, 0, 3.4, -27, 1.3, 5.2, COL.clay);
k.pair(-28, 0, -16, -26.5, 2.6, -13, COL.stone);                  // wing walls (spawn cover)
k.pair(-28, 0, 13, -26.5, 2.6, 16, COL.stone);
k.pair(-24, 0, -20.5, -21.5, 1.2, -19, COL.ochre);                // corner crates
k.pair(-24, 0, 19, -21.5, 1.2, 20.5, COL.ochre);

// --- lane walls with doorways (z = -9..-8 and 8..9) ---
k.pair(-15, 0, -9, -9, 3.2, -8, COL.wall);
k.box(-4.5, 0, -9, 4.5, 3.2, -8, COL.wall);
k.pair(-15, 0, 8, -9, 3.2, 9, COL.wall);
k.box(-4.5, 0, 8, 4.5, 3.2, 9, COL.wall);

// --- north lane: container yard (2.2 m tops with 1.1 m step crates) ---
k.pair(-17, 0, -18, -11, 2.2, -15.6, COL.rust);
k.pair(-11, 0, -17.4, -9.6, 1.1, -15.8, COL.ochre);
k.box(-3.5, 0, -14, 3.5, 2.2, -11.6, COL.rust);
k.box(-1.5, 0, -11.6, 1.5, 1.1, -10.2, COL.ochre);
k.pair(-8, 0, -22, -6.8, 3, -19, COL.shade);

// --- south lane: arches (legs plus a 2.6 m-clearance roof) and low walls ---
k.pair(-16, 0, 13, -15, 3.4, 14, COL.shade);
k.pair(-16, 0, 17, -15, 3.4, 18, COL.shade);
k.pair(-16, 2.6, 13, -15, 3.4, 18, COL.shade);
k.pair(-9, 0, 12, -6.5, 1.2, 13.2, COL.stone);
k.pair(-8, 0, 19, -6.8, 3, 22, COL.shade);
k.box(-3.5, 0, 14.5, 3.5, 1.2, 15.7, COL.stone);
k.box(-1.5, 0, 12.5, 1.5, 2.4, 14.5, COL.stone);

// --- middle corridor: dunes (1.1 then 2.2) either side of the open hardpoint floor ---
k.pair(-9, 0, -4.5, -5, 1.1, 4.5, COL.dune);
k.pair(-8, 1.1, -3, -6, 2.2, 3, COL.dune);
k.pair(-12.5, 0, -1.5, -11.5, 3, 1.5, COL.wall);                  // ruin wall blocking the axis

// --- extra cover: pillars, crates, a second arch ---
k.pair(-19, 0, -13, -17.5, 3.4, -11.5, COL.shade);
k.pair(-19, 0, 11.5, -17.5, 3.4, 13, COL.shade);
k.pair(-13.5, 0, -13.2, -11, 1.2, -11.8, COL.ochre);
k.pair(-6.5, 0, -18, -5, 1.2, -16.4, COL.stone);
k.pair(-13, 0, 15.5, -11, 1.2, 17, COL.stone);
k.pair(-8, 0, 17, -7, 3.4, 18, COL.shade);
k.pair(-8, 0, 20, -7, 3.4, 21, COL.shade);
k.pair(-8, 2.6, 17, -7, 3.4, 21, COL.shade);

const TEAM_A = [
  { pos: [-29.5, 0, -21.5], yaw: 3.927 },
  { pos: [-18, 0, 21.5], yaw: 5.105 },
  { pos: [-18, 0, -1.5], yaw: 5.105 },
  { pos: [-29.5, 0, 9], yaw: 5.105 },
  { pos: [-29.5, 0, -8], yaw: 4.320 },
  { pos: [-18, 0, -16], yaw: 3.927 },
  { pos: [-29.5, 0, 20.5], yaw: 5.105 },
  { pos: [-18.5, 0, 9], yaw: 5.498 },
  { pos: [-27, 0, 0.5], yaw: 4.712 },
  { pos: [-24, 0, 14.5], yaw: 5.498 },
];
const FFA = [
  { pos: [-29.5, 0, -21.5], yaw: 3.927 },
  { pos: [29.5, 0, 21.5], yaw: 0.785 },
  { pos: [16, 0, -21.5], yaw: 2.356 },
  { pos: [-18, 0, 21.5], yaw: 5.105 },
  { pos: [-9.5, 0, -4], yaw: 4.712 },
  { pos: [6, 0, 15], yaw: 0.393 },
  { pos: [29.5, 0, -2], yaw: 1.571 },
  { pos: [-29.5, 0, 2.5], yaw: 4.712 },
  { pos: [10, 0, -3.5], yaw: 1.178 },
  { pos: [-3, 0, -21.5], yaw: 3.142 },
  { pos: [20, 0, 9.5], yaw: 0.785 },
  { pos: [29.5, 0, -16.5], yaw: 1.178 },
  { pos: [-10, 0, 10], yaw: 5.105 },
  { pos: [-22.5, 0, -9.5], yaw: 5.105 },
  { pos: [-16, 0, -21], yaw: 3.927 },
  { pos: [-29.5, 0, 15.5], yaw: 5.890 },
  { pos: [-5, 0, 21.5], yaw: 5.890 },
  { pos: [17.5, 0, 21], yaw: 1.178 },
  { pos: [20, 0, -9.5], yaw: 2.356 },
  { pos: [6.5, 0, -14.5], yaw: 3.142 },
  { pos: [-18.5, 0, 3], yaw: 5.105 },
  { pos: [29.5, 0, 11.5], yaw: 1.178 },
  { pos: [-2.5, 0, -11], yaw: 4.320 },
  { pos: [19, 0, 0], yaw: 1.571 },
];

export const MAP = {
  id: 'dune_relay',
  name: 'Dune Relay',
  blurb: 'Three long lanes, doorways between them and a sunny middle to fight over.',
  size: 'medium',
  boxes: k.boxes,
  bounds,
  killY: -20,
  spawns: FFA,
  teamSpawns: { a: TEAM_A, b: TEAM_A.map((s) => mirrorSpawn(s, 'x')) },
  flags: { a: [-26, 0.3, 0], b: [26, 0.3, 0] },
  hardpoints: [
    { name: 'Oasis', min: [-3, 0, -3], max: [3, 3, 3] },
    { name: 'North Yard', min: [-3, 0, -21], max: [3, 3, -15] },
    { name: 'South Arcade', min: [-3, 0, 16.5], max: [3, 3, 21.5] },
  ],
  theme: { skyTop: 0xf0a458, skyBottom: 0xfbe7c3, fog: 0xecc99a, fogDensity: 0.011, sun: [45, 55, -20] },
};
