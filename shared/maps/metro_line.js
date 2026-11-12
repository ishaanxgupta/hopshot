import { createKit, mirrorSpawn, shade } from './_kit.js';
// Metro Line - 78 x 52 m, large (8-20 players). An underground station under cool fluorescent light:
// two raised platforms with a stopped train on each track (walk through the cars, door gaps on both
// sides), a station office on every platform, a concrete pier between the tracks, a raised ticket hall
// at each end (stairs up from the platforms) and a maintenance tunnel behind each platform. Three ways
// between the ends: the platforms, the tracks (through the train cars) and the tunnels.
// x-mirror symmetric: team A holds the west ticket hall, team B the east one.
// Palette: white tile, steel blue, signal yellow, concrete grey.

const C = {
  floor: 0x6b7078, track: 0x4a4d54, tile: 0xdfe3e6, tileD: 0xaab2bb, concrete: 0x8d9299, concreteD: 0x6e737b, platform: 0x9aa0a8, yellow: 0xf2c744, blue: 0x2f6fb0,
  steel: 0x5d6b7c, ceiling: 0xf1f4f7, light: 0xf4fbff, orange: 0xe8873a, machine: 0x2b4f8a, train: 0xc9ced6, trainStripe: 0x2f6fb0, trainB: 0xd7d2c4,
  wood: 0xa8855a, green: 0x3f8a5a, red: 0xc94a3c, flag: 0xf2c744, rail: 0x7b7f86, cabinet: 0x516273,
};
const K = createKit('x');
const PF = 1.1, MZ = 3.9, CEIL = 7.0;
const bounds = K.arena(-39, 39, -26, 26, 11, C.floor, C.tile);

// ---------------- shell: ceiling, wall tiling, lights, track bed ----------------
K.solid(-39, CEIL, -26, 39, CEIL + 0.4, 26, C.ceiling);
for (let x = -36; x <= 36; x += 6) for (const z of [-17, -5, 5, 17]) {
  K.paint(x - 1.4, CEIL - 0.14, z - 0.2, x + 1.4, CEIL, z + 0.2, C.light);
  K.paint(x - 1.6, CEIL - 0.04, z - 0.35, x + 1.6, CEIL, z + 0.35, C.tileD);
}
for (let x = -38; x < 38; x += 4) {
  for (const z of [-25.98, 25.9]) {
    K.paint(x + 0.05, 0, z, x + 3.95, 4.8, z + 0.08, C.tile); K.paint(x + 0.05, 1.4, z, x + 3.95, 1.9, z + 0.09, C.blue);
    K.paint(x + 0.05, 4.8, z, x + 3.95, 6.2, z + 0.08, C.tileD);
  }
}
for (let z = -26; z < 26; z += 4) for (const x of [-38.98, 38.9]) { K.paint(x, 0, z + 0.05, x + 0.08, 4.8, z + 3.95, C.tile); K.paint(x, 1.4, z + 0.05, x + 0.09, 1.9, z + 3.95, C.blue); }
// rails and sleepers on the two tracks (deco)
for (const zc of [-8.4, 8.4]) for (const zr of [zc - 0.72, zc + 0.72]) K.paint(-27, 0, zr - 0.06, 27, 0.16, zr + 0.06, C.rail);
for (const zc of [-8.4, 8.4]) for (let x = -26.5; x < 27; x += 1.2) K.paint(x, 0, zc - 1.25, x + 0.3, 0.07, zc + 1.25, 0x3c342c);
K.paint(-27, 0, -1.4, 27, 0.02, 1.4, 0xb59a3a);       // hazard strip down the middle of the track bed
for (let x = -26; x < 26; x += 2.4) K.paint(x, 0.02, -1.4, x + 1.2, 0.03, 1.4, 0x2d2d30);

// ---------------- platforms, maintenance tunnels and the divider walls ----------------
const sides = [-1, 1];
for (const sz of sides) {
  const a = sz < 0 ? -20.8 : 11.2, b = sz < 0 ? -11.2 : 20.8;
  K.solid(-27, 0, sz < 0 ? -26 : 11.2, 27, PF, sz < 0 ? -11.2 : 26, C.platform);          // platform and tunnel floor share one slab (door sills are flush)
  const ya = sz < 0 ? b - 0.55 : a, yb = sz < 0 ? b : a + 0.55;
  K.paint(-27, PF, ya, 27, PF + 0.03, yb, C.yellow);                                    // tactile strip along the track edge
  const doors = [-24, -16, -6, 6, 16, 24].map((c) => ({ a: c - 0.8, b: c + 0.8 }));
  const zw = sz < 0 ? -21.0 : 21.0;
  K.wallRun(K.frame(0, 0, 0, 0), 'x', -27, 27, zw, 0.4, PF, 3.4, C.concrete, doors, null);
  // the tunnel: a solid mass above it (the back of the hall), lights and cable trays drawn inside
  const za = sz < 0 ? -26 : 20.8, zb = sz < 0 ? -20.8 : 26;
  K.solid(-27, 3.4, za, 27, CEIL, zb, C.concreteD);
  K.paint(-27, 3.4, za, 27, 3.45, zb, C.steel);
  for (let x = -25; x <= 25; x += 6) K.paint(x - 1.0, 3.2, (za + zb) / 2 - 0.2, x + 1.0, 3.4, (za + zb) / 2 + 0.2, C.light);
  K.paint(-27, 2.6, sz < 0 ? -25.95 : 25.85, 27, 2.75, sz < 0 ? -25.85 : 25.95, C.orange);
  K.paint(-27, 1.5, sz < 0 ? -25.95 : 25.85, 27, 1.62, sz < 0 ? -25.85 : 25.95, C.blue);
  // the back of the hall above the platform: tile band with a blue stripe and station name boards (deco)
  const wz = sz < 0 ? -20.8 : 20.8, wd = sz < 0 ? -0.06 : 0.06;
  for (let x = -26; x < 26; x += 4) { K.paint(x + 0.1, PF, wz, x + 3.9, 5.6, wz + wd, C.tile); K.paint(x + 0.1, 2.6, wz, x + 3.9, 3.0, wz + wd, C.blue); K.paint(x + 0.1, 3.5, wz, x + 3.9, 5.4, wz + wd, C.tileD); }
  for (const x of [-12, 12]) K.paint(x - 3, 3.8, wz, x + 3, 5.0, wz + wd * 1.5, 0x20304a);
}

// ---------------- the stopped trains (on tracks beside each platform) ----------------
K.train(0, -8.4, 0, { y: PF, cars: 3, len: 12.8, color: C.train, stripe: C.trainStripe });
K.train(0, 8.4, 0, { y: PF, cars: 3, len: 12.8, color: C.trainB, stripe: C.orange });
// threshold plates over the gap between platform edge and train doors, both trains
for (const sz of sides) for (const cc of [-12.8, 0, 12.8]) for (const d of [-3.2, 3.2]) {
  const za = sz < 0 ? -11.2 : 9.97, zb = sz < 0 ? -9.97 : 11.2;
  K.solid(cc + d - 0.8, PF - 0.2, za, cc + d + 0.8, PF, zb, C.steel);
}

// ---------------- platform offices (walk through, windows onto the track) ----------------
for (const sz of sides) {
  const trackSide = sz < 0 ? 's' : 'n';
  const r = K.building(0, sz * 16.9, 0, {
    w: 8, d: 7.8, y: PF, th: 0.3, floors: 1, h1: 2.4, wall: C.tile, trim: C.blue, roofC: C.ceiling, floorC: C.tileD, roof: 'flat',
    g: {
      w: [{ a: -0.8, b: 0.8, head: 2.3 }, { a: -3.3, b: -2.1, sill: 1.0, head: 2.2 }],
      e: [{ a: -0.8, b: 0.8, head: 2.3 }, { a: -3.3, b: -2.1, sill: 1.0, head: 2.2 }],
      [trackSide]: [{ a: -3.2, b: -1.6, sill: 1.0, head: 2.2 }, { a: 1.6, b: 3.2, sill: 1.0, head: 2.2 }, { a: -0.8, b: 0.8, head: 2.3 }],
    },
  });
  r.f.b(-0.6, 0, -0.4, 0.6, 1.9, 0.4, C.machine);                               // ticket machine on the door line
  r.f.d(-0.6, 1.2, -0.44 * 1, 0.6, 1.7, -0.4, 0x9fd7ff);
  r.f.b(-1.6, 0, sz * 2.4 - 0.4, 1.6, 1.0, sz * 2.4 + 0.4, C.wood);           // counter facing the track
  r.f.b(-3.5, 0, sz * -2.4 - 0.3, -2.2, 1.9, sz * -2.4 + 0.3, C.cabinet); r.f.b(2.2, 0, sz * -2.4 - 0.3, 3.5, 1.9, sz * -2.4 + 0.3, C.cabinet);   // locker banks
  r.f.d(-3.0, 0, -3.0, 3.0, 0.03, 3.0, 0xc4cbd2);
}

// ---------------- centre: a concrete pier between the tracks (also keeps the middle out of sight) ----------------
K.solid(-1.6, 0, -1.6, 1.6, CEIL, 1.6, C.concrete);
K.paint(-1.7, 0, -1.7, 1.7, 0.4, 1.7, C.concreteD); K.paint(-1.7, 1.2, -1.7, 1.7, 1.5, 1.7, C.yellow); K.paint(-1.7, 6.2, -1.7, 1.7, CEIL, 1.7, C.concreteD);

K.sym(() => {
  // ---------------- ticket hall: a raised concrete podium (stairs up from the platforms) ----------------
  K.solid(-39, 0, -26, -27, MZ, 26, C.concrete);
  K.paint(-27.05, 0, -25.9, -27, MZ, 25.9, C.tile);
  for (const z of [-26, -20.8, -10, 0, 10, 20.8]) K.paint(-27.07, 0, z - 0.08, -26.95, MZ, z + 0.08, C.tileD);
  K.paint(-27.1, 3.55, -25.9, -26.95, 3.9, 25.9, C.blue);
  K.paint(-27.4, MZ, -25.9, -27.0, MZ + 0.03, 25.9, C.yellow);
  K.paint(-38.9, MZ, -25.9, -27.5, MZ + 0.03, 25.9, C.tileD);
  for (let z = -24; z < 24; z += 4) K.paint(-38.9, MZ + 0.03, z, -27.5, MZ + 0.05, z + 0.12, C.tile);
  for (const [a, b] of [[-26, -17.7], [-14.3, 14.3], [17.7, 26]]) {                                          // edge kerb + see-through rail
    K.solid(-27.25, MZ, a, -27.0, MZ + 0.25, b, C.steel);
    K.paint(-27.25, MZ + 1.0, a, -27.0, MZ + 1.08, b, C.rail);
    for (let z = a; z <= b + 0.01; z += 1.8) K.paint(-27.22, MZ + 0.25, z - 0.03, -27.05, MZ + 1.0, z + 0.03, C.rail);
  }
  for (const zc of [-16, 16]) {                                                                              // stairs up from each platform
    const f = K.frame(0, 0, 0, PF);
    K.stairs(f, -23.0, zc, 'x-', 3.0, MZ - PF, C.tileD);
    f.d(-27.0, 2.0, zc - 1.56, -23.0, 2.1, zc - 1.5, C.rail); f.d(-27.0, 2.0, zc + 1.5, -23.0, 2.1, zc + 1.56, C.rail);
  }
  // flag alcove: stand with a back wall and two side walls (open to the east)
  K.solid(-36.0, MZ, -1.0, -34.0, MZ + 0.3, 1.0, C.steel); K.paint(-35.9, MZ + 0.3, -0.9, -34.1, MZ + 0.34, 0.9, C.flag);
  K.solid(-38.3, MZ, -3.0, -38.0, MZ + 2.2, 3.0, C.tile); K.solid(-38.0, MZ, -3.0, -33.0, MZ + 2.2, -2.7, C.tile); K.solid(-38.0, MZ, 2.7, -33.0, MZ + 2.2, 3.0, C.tile);
  K.paint(-38.3, MZ + 1.4, -3.0, -33.0, MZ + 1.7, -2.65, C.blue); K.paint(-38.3, MZ + 1.4, 2.65, -33.0, MZ + 1.7, 3.0, C.blue);
  K.solid(-30.65, MZ, -9, -30.5, MZ + 1.1, -3.4, 0x9fd7ff); K.solid(-30.65, MZ, 3.4, -30.5, MZ + 1.1, 9, 0x9fd7ff);      // fare-gate glass screens
  K.paint(-30.7, MZ + 1.1, -9, -30.45, MZ + 1.2, -3.4, C.yellow); K.paint(-30.7, MZ + 1.1, 3.4, -30.45, MZ + 1.2, 9, C.yellow);
  for (const z of [-15, -8, 8, 15]) { K.solid(-38.3, MZ, z - 0.5, -37.4, MZ + 1.9, z + 0.5, C.machine); K.paint(-37.45, MZ + 1.1, z - 0.4, -37.4, MZ + 1.7, z + 0.4, 0x9fd7ff); }
  for (const z of [-5.5, 5.5]) K.solid(-30.0 - 0.45, MZ, z - 0.45, -30.0 + 0.45, CEIL, z + 0.45, C.concrete);            // pillars
  K.solid(-34.5, MZ, -13.2, -31.5, MZ + 2.4, -10.8, C.blue); K.solid(-34.5, MZ, 10.8, -31.5, MZ + 2.4, 13.2, C.blue);   // info kiosks
  K.paint(-34.5, MZ + 2.4, -13.2, -31.5, MZ + 2.5, -10.8, C.yellow); K.paint(-34.5, MZ + 2.4, 10.8, -31.5, MZ + 2.5, 13.2, C.yellow);
  K.solid(-30.2, MZ, -20, -29.3, MZ + 0.5, -17.5, C.wood); K.solid(-30.2, MZ, 17.5, -29.3, MZ + 0.5, 20, C.wood);   // benches
  for (const z of [-18.5, 18.5]) K.solid(-36.6, MZ, z - 0.6, -35.4, CEIL, z + 0.6, C.concrete);
  // hanging departure boards over the platforms and tracks (cut the long lines between the two halls)
  K.solid(-16.15, 4.9, -20.8, -15.85, 6.6, 20.8, 0x151b26);
  K.paint(-16.2, 5.2, -20.2, -15.8, 6.3, 20.2, 0x20304a);
  for (let z = -19; z < 18; z += 6) { K.paint(-16.25, 5.5, z, -15.75, 5.65, z + 4.4, 0xffcf4a); K.paint(-16.25, 5.9, z, -15.75, 6.05, z + 3.0, 0xe9f4ff); }
  // ---------------- platforms: pillars, vending, benches; tunnels: bulkhead doors and cover ----------------
  for (const sz of sides) {
    for (const x of [-18, -11.5]) K.solid(x - 0.4, PF, sz * 15.9 - 0.4, x + 0.4, CEIL, sz * 15.9 + 0.4, C.concrete);
    for (const x of [-18, -11.5]) K.paint(x - 0.45, PF, sz * 15.9 - 0.45, x + 0.45, PF + 0.3, sz * 15.9 + 0.45, C.yellow);
    K.solid(-19.9, PF, sz * 20.3 - 0.4, -18.9, PF + 1.9, sz * 20.3 + 0.4, C.red); K.solid(-9.9, PF, sz * 20.3 - 0.4, -8.9, PF + 1.9, sz * 20.3 + 0.4, C.green);
    K.solid(-14.0, PF, sz * 20.1 - 0.25, -12.0, PF + 0.5, sz * 20.1 + 0.25, C.wood);
    const t0 = sz < 0 ? -26 : 21.2, t1 = sz < 0 ? -21.2 : 26, mid = (t0 + t1) / 2;
    K.solid(-11.15, PF, t0, -10.85, 3.4, mid - 0.8, C.concreteD); K.solid(-11.15, PF, mid + 0.8, -10.85, 3.4, t1, C.concreteD);
    K.paint(-11.2, 3.3, mid - 0.8, -10.8, 3.4, mid + 0.8, C.yellow);
    K.solid(-25.5, PF, sz * 24.4 - 0.8, -24.1, PF + 1.2, sz * 24.4 + 0.8, C.wood); K.solid(-14.5, PF, sz * 22.4 - 0.6, -13.5, PF + 1.0, sz * 22.4 + 0.6, C.red);
    K.solid(-21.5, PF, sz * 23.2 - 0.5, -20.3, PF + 2.1, sz * 23.2 + 0.5, C.cabinet); K.solid(-3.0, PF, sz * 23.6 - 0.5, -1.8, PF + 2.1, sz * 23.6 + 0.5, C.cabinet);
  }
  for (const x of [-24, -16, -6]) for (const sz of sides) K.paint(x - 0.9, 2.5, sz * 20.95 - 0.25, x + 0.9, 3.0, sz * 20.95 + 0.25, C.green);
});

// ---------------- spawns ----------------
const A = [
  { pos: [-36.5, 3.9, 0], yaw: 4.320 }, { pos: [-32, 3.9, -0.5], yaw: 3.927 }, { pos: [-34, 3.9, 4], yaw: 2.749 }, { pos: [-35, 3.9, -4.5], yaw: 0.000 },
  { pos: [-29.5, 3.9, -4.5], yaw: 0.000 }, { pos: [-29.5, 3.9, 4.5], yaw: 0.000 }, { pos: [-38, 3.9, 6.5], yaw: 4.320 }, { pos: [-33.5, 3.9, 8.5], yaw: 3.927 },
];
const X = [
  { pos: [-26, 1.1, -12], yaw: 3.142 }, { pos: [-20, 1.1, -12], yaw: 0.393 }, { pos: [-26, 1.1, -20], yaw: 3.927 },
  { pos: [-26, 1.1, 12], yaw: 0.000 }, { pos: [-20, 1.1, 12], yaw: 0.000 }, { pos: [-25, 1.1, 19.5], yaw: 4.712 },
  { pos: [-26, PF, -22], yaw: 4.712 }, { pos: [-21, PF, -22], yaw: 5.105 }, { pos: [-26, PF, 21.9], yaw: 4.712 }, { pos: [-21, PF, 21.9], yaw: 4.320 }, { pos: [-26, 0, 0], yaw: 0.000 },
];
const FFA = [...A, ...A.map((s) => mirrorSpawn(s, 'x')), ...X, ...X.map((s) => mirrorSpawn(s, 'x'))];

export const MAP = {
  id: 'metro_line',
  name: 'Metro Line',
  blurb: 'Underground station: walk-through trains, platform offices, ticket-hall mezzanines and tunnels.',
  size: 'large',
  boxes: K.boxes,
  deco: K.deco,
  spawns: FFA,
  teamSpawns: { a: A, b: A.map((s) => mirrorSpawn(s, 'x')) },
  flags: { a: [-35, MZ + 0.3, 0], b: [35, MZ + 0.3, 0] },
  hardpoints: [
    { name: 'West Platform', min: [-14, PF, -19], max: [-8, PF + 3, -13] },
    { name: 'East Platform', min: [8, PF, -19], max: [14, PF + 3, -13] },
    { name: 'Track North', min: [-3, 0, -6.6], max: [3, 3, -1.6] },
    { name: 'Track South', min: [-3, 0, 1.6], max: [3, 3, 6.6] },
  ],
  theme: { skyTop: 0xa5b4c6, skyBottom: 0xdde7f2, fog: 0xb6c2ce, fogDensity: 0.007, sun: [10, 80, 20] },
  bounds,
  killY: -20,
};
