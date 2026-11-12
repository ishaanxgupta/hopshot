import { createKit, mirrorSpawn, shade } from './_kit.js';
// Maple Street - 68 x 48 m, medium (4-12 players). A sunny suburban street: two rows of houses you can
// walk into (front door, back door, windows to shoot from, stairs to an upper floor and a balcony over
// the front yard), low fences and hedges in the yards, parked cars along both kerbs, a broken-down bus
// across the middle of the road that you can walk through (door gaps) or climb onto, and a corner shop
// with an awning. 180-degree rotation symmetric: team A holds the west end of the street, team B the east.
// Palette: pastel clapboard, red roofs, warm asphalt, bright blue sky.

const C = {
  grass: 0x7fbf5a, grass2: 0x6fb04e, road: 0x5a5d63, side: 0xc4c2ba, curb: 0xa9a79f, line: 0xf0e8b8, fence: 0xf4f0e4, hedge: 0x3f8a3f,
  cream: 0xf1e3bd, blue: 0xa9c8e0, yellow: 0xf5dc8c, mint: 0x92d3b8, roofRed: 0xa8453a, roofDark: 0x4d5560, roofBrown: 0x7a4f3a, trim: 0xffffff,
  floor: 0x9a7d58, wallDark: 0x6b7a5a, bus: 0xf0b429, wood: 0xb48a54, dump: 0x3f6f4f, awnR: 0xd8483c, awnW: 0xf6f2ea, flag: 0xe8c94a, brick: 0xb5654a,
};
const K = createKit('xz');
const bounds = K.arena(-34, 34, -24, 24, 10.5, C.grass, 0x8fa87a);

// ---- ground: road, kerbs, sidewalks, markings, lawn stripes (deco) ----
K.paint(-34, 0, -5, 34, 0.04, 5, C.road);
K.paint(-34, 0, -7, 34, 0.05, -5, C.side); K.paint(-34, 0, 5, 34, 0.05, 7, C.side);
K.paint(-34, 0, -5.15, 34, 0.08, -5, C.curb); K.paint(-34, 0, 5, 34, 0.08, 5.15, C.curb);
for (let x = -33; x < 33; x += 4) K.paint(x, 0.04, -0.1, x + 2, 0.06, 0.1, C.line);
for (const x of [-9, 9]) for (let z = -4.5; z < 4.5; z += 1.1) K.paint(x - 1.2, 0.04, z, x + 1.2, 0.06, z + 0.55, 0xeeeeee);
for (let x = -34; x < 34; x += 6) { K.paint(x, 0, -23.9, x + 3, 0.03, -20, C.grass2); K.paint(x + 3, 0, 20, x + 6, 0.03, 23.9, C.grass2); }
K.paint(-34, 0, -24, 34, 0.04, -20, 0x8a8f86); K.paint(-34, 0, 20, 34, 0.04, 24, 0x8a8f86);   // back alleys
// perimeter: hedge and garden fence on the inside faces (deco)
for (let x = -34; x < 34; x += 4) {
  K.paint(x + 0.1, 0, -23.97, x + 3.9, 1.5, -23.9, C.hedge); K.paint(x + 0.1, 0, 23.9, x + 3.9, 1.5, 23.97, C.hedge);
  K.paint(x + 0.1, 1.5, -23.97, x + 3.9, 2.4, -23.9, 0xe9e2cf); K.paint(x + 0.1, 1.5, 23.9, x + 3.9, 2.4, 23.97, 0xe9e2cf);
}
for (let z = -24; z < 24; z += 4) {
  K.paint(-33.97, 0, z + 0.1, -33.9, 1.5, z + 3.9, C.hedge); K.paint(33.9, 0, z + 0.1, 33.97, 1.5, z + 3.9, C.hedge);
  K.paint(-33.97, 1.5, z + 0.1, -33.9, 2.4, z + 3.9, 0xe9e2cf); K.paint(33.9, 1.5, z + 0.1, 33.97, 2.4, z + 3.9, 0xe9e2cf);
}

const win = (a, b, s0 = 1.0, h0 = 2.2) => ({ a, b, sill: s0, head: h0 });
const FY = 2.7;
const fk = (a, b, s0 = 1.0, h0 = 2.2) => ({ a, b, sill: s0, head: h0 });

K.sym(() => {
  // ---------------- House A: two storeys, stairs, balcony over the front yard ----------------
  {
    const r = K.building(-25, -16, 0, {
      w: 10, d: 8, floors: 2, h1: 2.5, h2: 2.5, wall: C.cream, trim: C.trim, roofC: C.roofRed, floorC: C.floor, roof: 'gable', chimney: { x: -2.5, z: -1 },
      g: { s: [{ a: -2.0, b: -0.4, head: 2.3 }, win(0.8, 2.2)], n: [{ a: 1.0, b: 2.6, head: 2.3 }], w: [win(-1.0, 0.4)], e: [] },
      u: { s: [{ a: -2.0, b: -0.4, sill: FY, head: FY + 2.3 }, win(0.8, 2.2, FY + 0.9, FY + 2.1)], n: [win(-1.6, 0.0, FY + 0.9, FY + 2.1)], w: [], e: [win(1.8, 3.0, FY + 0.9, FY + 2.1)] },
      fake: { g: null, s: [fk(-4.4, -3.2)], n: [fk(-4.0, -2.8), fk(-0.8, 0.6)], w: [fk(1.8, 3.0), fk(-3.0, -1.8), fk(-1.0, 0.4, FY + 0.9, FY + 2.1)], e: [fk(-3.0, -1.8)] },
      stairs: { x: 3.9, z: 2.3, dir: 'z-', width: 1.6 },
      parts: [{ ax: 'x', p: -0.5, c0: -4.7, c1: 3.0, ops: [{ a: -3.4, b: -1.8, head: 2.3 }], level: 0 }],
      balcony: { side: 's', a: -2.9, b: 0.9, depth: 1.6 },
    });
    r.f.b(-4.6, 0, -3.6, -3.2, 2.0, -3.0, C.wood);                  // wardrobe / counter downstairs
    r.f.b(-4.6, FY, -3.6, -2.6, FY + 1.9, -3.0, C.wood);            // wardrobe upstairs
    r.f.b(-1.0, FY, -3.4, 1.4, FY + 0.6, -2.2, 0x8a6a8f);           // bed
    r.f.b(1.0, 0, 1.2, 2.6, 0.9, 2.0, C.wood);                      // kitchen counter
    r.f.d(-3.0, 0.01, 1.0, 0.0, 0.04, 3.0, 0x9b4a4a);               // rug
    // porch
    r.f.d(-2.4, 0, 4.0, -0.0, 0.12, 5.4, C.side);
    K.fence(-30, -8.2, -27.4, -8.2); K.fence(-25.0, -8.2, -20, -8.2);
    K.paint(-27.2, 0, -12, -25.2, 0.03, -8.2, C.side);
  }
  // ---------------- House B: bungalow, partition with a doorway ----------------
  {
    const r = K.building(-10, -16, 0, {
      w: 10, d: 8, floors: 1, h1: 2.6, wall: C.blue, trim: C.trim, roofC: C.roofDark, floorC: C.floor, roof: 'flat',
      g: { s: [{ a: 0.4, b: 2.0, head: 2.3 }, win(-3.6, -2.0), win(2.8, 4.0)], n: [win(-1.6, 0.0)], w: [win(-1.0, 0.4)], e: [{ a: -2.8, b: -1.2, head: 2.3 }] },
      fake: { s: [], n: [fk(2.0, 3.4)], w: [fk(1.8, 3.0)], e: [fk(1.0, 2.4)] },
      parts: [{ ax: 'z', p: -0.6, c0: -3.7, c1: 3.7, ops: [{ a: 0.2, b: 1.8, head: 2.3 }], level: 0 }],
    });
    r.f.b(-4.6, 0, -3.6, -3.0, 1.0, -2.8, C.wood); r.f.b(1.8, 0, -3.6, 4.6, 0.8, -2.9, 0x8a6a8f);
    K.fence(-15, -8.2, -10.6, -8.2); K.fence(-8.4, -8.2, -5, -8.2);
    K.paint(-10.6, 0, -12, -8.4, 0.03, -8.2, C.side);
  }
  // ---------------- Corner shop: big window, door, counter and shelves, awning ----------------
  {
    const r = K.building(8, -16, 0, {
      w: 12, d: 8, floors: 1, h1: 2.8, wall: C.mint, trim: C.trim, roofC: 0x6a7a80, floorC: 0xd9d2c0, roof: 'flat',
      g: { s: [{ a: -4.0, b: -2.4, head: 2.4 }, { a: -0.8, b: 4.0, sill: 0.9, head: 2.3 }], n: [{ a: 3.0, b: 4.6, head: 2.4 }, win(-3.5, -2.0)], w: [win(-1.0, 0.4)], e: [win(-1.0, 0.4)] },
      fake: { s: [], n: [fk(0.0, 1.8)], w: [], e: [] },
      sign: { side: 's', a: -4.5, b: 4.5, y: 3.0, h: 0.9, color: 0xf2c53d },
    });
    r.f.b(-1.0, 0, -0.4, 3.8, 1.0, 0.4, C.wood);                   // counter
    r.f.b(-5.4, 0, -3.1, -4.8, 1.9, 1.4, C.wood);                  // shelf along the west wall
    r.f.b(0.6, 0, -3.3, 4.6, 1.9, -2.7, C.wood);                   // shelf along the back wall
    r.f.b(-3.4, 0, -1.0, -2.0, 1.1, 0.0, 0xc9573f);                // fridge
    r.f.b(-4.6, 2.8, 4.0, 4.8, 2.95, 5.6, C.awnR);                 // awning (solid, 2.8 m clear)
    for (let i = 0; i < 6; i++) r.f.d(-4.6 + i * 1.6, 2.95, 4.0, -3.8 + i * 1.6, 2.99, 5.6, C.awnW);
    r.f.d(-4.6, 2.5, 5.55, 4.8, 2.8, 5.6, C.awnR);
    r.f.d(-3.8, 0, -3.0, 3.0, 0.04, 3.4, 0xcfc7b3);
  }
  // ---------------- House C: bungalow with a flat roof ----------------
  {
    const r = K.building(25, -16, 0, {
      w: 10, d: 8, floors: 1, h1: 2.6, wall: C.yellow, trim: C.trim, roofC: C.roofBrown, floorC: C.floor, roof: 'flat',
      g: { s: [{ a: -2.0, b: -0.4, head: 2.3 }, win(1.0, 2.4)], n: [{ a: 2.0, b: 3.6, head: 2.3 }], w: [win(-1.0, 0.4)], e: [win(-1.0, 0.4)] },
      fake: { s: [fk(-4.2, -3.0), fk(3.2, 4.4)], n: [fk(-3.6, -2.4)], w: [], e: [] },
      parts: [{ ax: 'x', p: -0.2, c0: -4.7, c1: 4.7, ops: [{ a: -3.4, b: -1.8, head: 2.3 }, { a: 1.2, b: 2.8, head: 2.3 }], level: 0 }],
    });
    r.f.b(-4.6, 0, 1.5, -3.2, 0.9, 3.5, C.wood);
    K.fence(20, -8.2, 22.6, -8.2); K.fence(24.8, -8.2, 30, -8.2);
    K.paint(22.6, 0, -12, 24.8, 0.03, -8.2, C.side);
  }
  // ---------------- hedges and yard clutter ----------------
  for (const [x0, x1] of [[-20.2, -19.4], [-15.3, -14.6]]) { K.solid(x0, 0, -12, x1, 1.9, -8.4, C.hedge); K.paint(x0 - 0.05, 1.9, -12, x1 + 0.05, 2.0, -8.4, shade(C.hedge, 1.2)); }
  K.solid(-5.2, 0, -12, -4.6, 1.9, -8.4, C.hedge); K.solid(19.4, 0, -12, 20, 1.9, -8.4, C.hedge);
  // back-alley dumpsters (screen the long straight alley)
  for (const x of [-12.5, 3.5, 22]) { K.solid(x - 1.1, 0, -23.9, x + 1.1, 1.6, -22.6, C.dump); K.paint(x - 1.15, 1.6, -23.95, x + 1.15, 1.72, -22.55, shade(C.dump, 0.7)); K.paint(x - 1.15, 0.5, -23.95, x + 1.15, 0.6, -22.55, shade(C.dump, 1.2)); }
  K.solid(-17.6 - 0.9, 0, -23.9, -17.6 + 0.9, 2.1, -22.9, C.brick);
  // parked cars along the north kerb
  K.car(-31.4, -3.9, 0, { color: 0xc23b3b }); K.car(-21.5, -3.9, 0, { color: 0x3b6ec2 }); K.car(-14.5, -3.9, 0, { color: 0xe8e2d0 }); K.car(-4.6, -3.9, 0, { color: 0x2f9a6a });
  K.car(14.6, -3.9, 0, { color: 0xe0a526 }); K.car(24.0, -3.9, 0, { color: 0x7a4f9a });
  // cul-de-sac cover for the flags (planter boxes + bench), mirrored to the east end
  for (const sz of [-1, 1]) { K.solid(-33.4, 0, sz * 2.6 - 0.6, -32.2, 1.3, sz * 2.6 + 0.6, C.brick); K.paint(-33.35, 1.3, sz * 2.6 - 0.55, -32.25, 1.45, sz * 2.6 + 0.55, C.hedge); }
  K.solid(-30.8, 0, -1.2, -30.2, 1.0, 1.2, C.wood);
  K.solid(-32.6, 0.0, -1.0, -30.9, 0.3, 1.0, 0xb8b3a4);          // flag stand
  K.paint(-32.5, 0.3, -0.9, -31.0, 0.34, 0.9, C.flag);
  // street lamps (thin posts, deco heads)
  for (const x of [-26, -14, 14, 26]) { K.solid(x - 0.1, 0, -7.1, x + 0.1, 3.8, -6.9, 0x3a3f46); K.paint(x - 0.4, 3.8, -7.3, x + 0.4, 4.0, -6.7, 0xfff3c0); }
});

// ---- the broken-down bus across the middle of the street (symmetric under the rotation) ----
K.sym(() => {
  K.bus(0, 0, 0, { color: C.bus, h: 2.7, len: 10, windows: [-0.9, 0.9] });
  K.crate(-3.1, -4.3, 1.2, 0.9, C.wood); K.crate(-1.9, -4.3, 1.2, 1.8, 0xc9a87a);
  K.paint(-1.4, 1.0, -5.05, 1.4, 1.2, -5.0, 0x3a3a3a);
  K.paint(-1.2, 2.7, -4.6, 1.2, 3.1, -4.2, 0xe9e2cf);          // luggage on the roof
  K.solid(-0.25, 2.7, -0.25, 0.25, 5.4, 0.25, 0x44494f);       // the roof-mounted route sign pole (also keeps the centre point out of view)
  K.paint(-0.9, 4.6, -0.12, 0.9, 5.4, 0.12, 0xf2c53d); K.paint(-0.12, 4.6, -0.9, 0.12, 5.4, 0.9, 0xf2c53d);
});

// ---- spawns (west end; east end mirrored through the centre) ----
const A = [
  { pos: [-32.4, 0, -8.5], yaw: 4.712 }, { pos: [-32.4, 0, 8.5], yaw: 4.712 }, { pos: [-33, 0, -14], yaw: 3.14159 }, { pos: [-33, 0, 14], yaw: 0 },
  { pos: [-27.5, 0, -14], yaw: 4.712 }, { pos: [-27.6, 0, -18.4], yaw: 4.712 }, { pos: [-26.7, 0, -23.2], yaw: 4.712 }, { pos: [-27, 0, 23.2], yaw: 4.712 },
];
const FFA = [
  ...A, ...A.map((s) => mirrorSpawn(s, 'xz')),
  { pos: [-13.5, 0, -14], yaw: 4.712 }, { pos: [13.5, 0, 14], yaw: 1.571 }, { pos: [-4.2, 0, -20.5], yaw: 4.712 }, { pos: [4.2, 0, 20.5], yaw: 1.571 },
  { pos: [24.5, 0, -14], yaw: 1.571 }, { pos: [-24.5, 0, 14], yaw: 4.712 },
];

export const MAP = {
  id: 'maple_street',
  name: 'Maple Street',
  blurb: 'Sunny suburb: enterable houses with balconies, a corner shop, parked cars and a bus across the road.',
  size: 'medium',
  boxes: K.boxes,
  deco: K.deco,
  spawns: FFA,
  teamSpawns: { a: A, b: A.map((s) => mirrorSpawn(s, 'xz')) },
  flags: { a: [-31.8, 0.3, 0], b: [31.8, 0.3, 0] },
  hardpoints: [
    { name: 'West Street', min: [-24, 0, -2.75], max: [-18, 3, 2.75] },
    { name: 'East Street', min: [18, 0, -2.75], max: [24, 3, 2.75] },
    { name: 'Corner', min: [-12, 0, -2.75], max: [-6, 3, 2.75] },
    { name: 'Crossroad', min: [6, 0, -2.75], max: [12, 3, 2.75] },
  ],
  theme: { skyTop: 0x4f9cf0, skyBottom: 0xd2e9ff, fog: 0xd8ecff, fogDensity: 0.007, sun: [30, 70, -20] },
  bounds,
  killY: -20,
};
