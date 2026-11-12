// Spawn selection and the per-map world cache.
//
// pickSpawn(room, p) (policy 'smart', the default):
//   candidates = the team's home spawns (map.teamSpawns[team]) + every free-for-all spawn in
//   team modes; in ffa the free-for-all spawns + both teams' home spawns. Each candidate gets
//   a preference score:
//     min(distance to the nearest living enemy, 45 m)
//     + 20 for a home spawn (team modes)          - 30 if an enemy is within 8 m
//     - 100 if anyone is standing on it (< 1.2 m)  + 0..4 m random (variety)
//   Candidates are then tested in preference order for VISIBILITY: a ray from each living
//   enemy's eye to the candidate's chest (1.2 m) and head (1.7 m) with raycastWorld; the first
//   candidate no enemy can see wins. When every designed spawn is seen (crowded ffa), up to 16
//   fallback points from the bots' nav grid (reachable floor on a 3 m lattice, >= 8 m from
//   enemies) are tried the same way. Only when all of those are seen too does the best-scored
//   designed spawn win anyway (counted as 'unavoidable' in tools/modes.test.js). So a home spawn is used while it is safe, and an overrun home falls back to the
//   safest free spawn elsewhere. Typical cost: a handful of candidates x enemies x 2 rays.
// policy 'legacy' reproduces phase-1 behaviour (farthest from enemies, no visibility test) and
// is only used by tools/modes.test.js to measure before/after.

import { createWorld, eyeHeight, raycastWorld } from '../shared/physics.js';
import { getMap } from '../shared/maps/index.js';
import { getNav } from './nav.js';

const worlds = new Map();
/** Cached collision world for a map id (one per map, shared by every room). */
export function worldFor(mapId) {
  const map = getMap(mapId);
  let w = worlds.get(map.id);
  if (!w) { w = createWorld(map); worlds.set(map.id, w); }
  return { map, world: w };
}

const CHEST = 1.2, HEAD = 1.7;
const candCache = new Map();

function candidates(map, team) {
  const key = `${map.id}:${team || '-'}`;
  let c = candCache.get(key);
  if (!c) {
    c = [];
    if (team && map.teamSpawns && map.teamSpawns[team]) for (const s of map.teamSpawns[team]) c.push({ pos: s.pos, yaw: s.yaw || 0, home: true });
    for (const s of map.spawns) c.push({ pos: s.pos, yaw: s.yaw || 0, home: false });
    // free-for-all also uses both teams' (covered) home spawns
    if (!team && map.teamSpawns) for (const t of ['a', 'b']) for (const s of map.teamSpawns[t] || []) c.push({ pos: s.pos, yaw: s.yaw || 0, home: false });
    candCache.set(key, c);
  }
  return c;
}

const isEnemy = (p, q) => q !== p && q.alive && (!p.team || q.team !== p.team);

/** True if any living enemy of p can see a player standing at pos (chest or head). */
export function spawnVisible(room, p, pos) {
  const W = room.world;
  for (const q of room.players) {
    if (!isEnemy(p, q)) continue;
    const ex = q.state.x, ey = q.state.y + eyeHeight(q.state), ez = q.state.z;
    for (let k = 0; k < 2; k++) {
      const tx = pos[0], ty = pos[1] + (k === 0 ? CHEST : HEAD), tz = pos[2];
      let dx = tx - ex, dy = ty - ey, dz = tz - ez;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 0.5) return true;
      dx /= d; dy /= d; dz /= d;
      if (!(raycastWorld(W, ex, ey, ez, dx, dy, dz, d - 0.05, undefined) < d - 0.05)) return true;
    }
  }
  return false;
}

const scoreBuf = new Float64Array(256), order = new Int32Array(256);

export function pickSpawn(room, p, policy = room.spawnPolicy || 'smart') {
  const map = room.map;
  const team = p.team || '';
  if (policy === 'legacy') return legacy(room, p, map.spawns);
  const cand = candidates(map, team);
  const n = Math.min(cand.length, 256);
  for (let i = 0; i < n; i++) {
    const c = cand[i];
    const [sx, sy, sz] = c.pos;
    let minE = 1e9, minAny = 1e9;
    for (const q of room.players) {
      if (q === p || !q.alive) continue;
      const dx = q.state.x - sx, dy = q.state.y - sy, dz = q.state.z - sz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < minAny) minAny = d;
      if (isEnemy(p, q) && d < minE) minE = d;
    }
    let s = (minE < 45 ? minE : 45) + (c.home ? 20 : 0) + Math.random() * 4;
    if (minE < 8) s -= 30;
    if (minAny < 1.2) s -= 100;
    scoreBuf[i] = s;
    order[i] = i;
  }
  // insertion sort by score desc (n <= ~40)
  for (let i = 1; i < n; i++) {
    const v = order[i], sv = scoreBuf[v];
    let j = i - 1;
    while (j >= 0 && scoreBuf[order[j]] < sv) { order[j + 1] = order[j]; j--; }
    order[j + 1] = v;
  }
  for (let k = 0; k < n; k++) {
    const c = cand[order[k]];
    if (!spawnVisible(room, p, c.pos)) return c;
  }
  // every designed spawn is seen (crowded match): try up to EXTRA_TRIES fallback points from
  // the nav grid (reachable floor on a 3 m lattice), best scored first
  const ex = extras(map);
  if (ex.length) {
    const m = Math.min(EXTRA_SAMPLES, ex.length);
    for (let i = 0; i < m; i++) {
      const c = ex[Math.floor(Math.random() * ex.length)];
      const [sx, sy, sz] = c.pos;
      let minE = 1e9;
      for (const q of room.players) {
        if (!isEnemy(p, q)) continue;
        const dx = q.state.x - sx, dy = q.state.y - sy, dz = q.state.z - sz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < minE) minE = d;
      }
      exPick[i] = c; scoreBuf[i] = minE;
    }
    for (let i = 1; i < m; i++) {
      const c = exPick[i], s = scoreBuf[i];
      let j = i - 1;
      while (j >= 0 && scoreBuf[j] < s) { exPick[j + 1] = exPick[j]; scoreBuf[j + 1] = scoreBuf[j]; j--; }
      exPick[j + 1] = c; scoreBuf[j + 1] = s;
    }
    for (let i = 0; i < m && i < EXTRA_TRIES; i++) {
      if (scoreBuf[i] < 64) break;                                // never closer than 8 m to an enemy
      if (!spawnVisible(room, p, exPick[i].pos)) return exPick[i];
    }
  }
  if (room.spawnStats && room.spawnStats.enabled) room.spawnStats.unavoidable = (room.spawnStats.unavoidable || 0) + 1;
  return cand[order[0]];
}

/** Precompute a map's fallback spawn points (server start). */
export function prewarmSpawns(map) { extras(map); }

const EXTRA_SAMPLES = 64;   // random lattice points scored by distance
const EXTRA_TRIES = 16;     // the best of them get the visibility test
const exPick = new Array(EXTRA_SAMPLES);
const extraCache = new Map();
/** Fallback spawn points: nav nodes on a 3 m lattice that can walk to the first spawn. */
function extras(map) {
  let ex = extraCache.get(map.id);
  if (ex) return ex;
  ex = [];
  const nav = getNav(map);
  const s0 = map.spawns[0].pos;
  const f = nav.field('spawnreach', s0);
  const cx = (map.bounds.min[0] + map.bounds.max[0]) / 2, cz = (map.bounds.min[2] + map.bounds.max[2]) / 2;
  for (let id = 0; id < nav.nodeCount; id++) {
    if (nav.cellI[id] % 6 !== 0 || nav.cellJ[id] % 6 !== 0 || !f.reaches(id)) continue;
    const x = nav.x[id], y = nav.y[id], z = nav.z[id];
    if (y > 6) continue;                                         // no rooftops
    ex.push({ pos: [x, y, z], yaw: Math.atan2(-(cx - x), -(cz - z)), home: false, extra: true });
  }
  extraCache.set(map.id, ex);
  return ex;
}

function legacy(room, p, spawns) {
  let best = -1, bestScore = -1;
  const scores = new Float64Array(spawns.length);
  for (let s = 0; s < spawns.length; s++) {
    const [sx, sy, sz] = spawns[s].pos;
    let minD = 1e12;
    for (const q of room.players) {
      if (!isEnemy(p, q)) continue;
      const dx = q.state.x - sx, dy = q.state.y - sy, dz = q.state.z - sz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < minD) minD = d;
    }
    scores[s] = minD;
    if (minD > bestScore) { bestScore = minD; best = s; }
  }
  const thr = bestScore * 0.7;
  let n = 0;
  for (let s = 0; s < spawns.length; s++) if (scores[s] >= thr) n++;
  let pick = Math.floor(Math.random() * n);
  for (let s = 0; s < spawns.length; s++) if (scores[s] >= thr && pick-- === 0) return spawns[s];
  return spawns[Math.max(0, best)];
}
