// Precomputed navigation for bots: one walkable-surface grid per map (0.5 m cells, every box top
// a standing player fits on), a CSR edge list (walk, step, drop down <= 12 m, jump up <= 1.2 m),
// lazily computed Dijkstra "flow fields" towards fixed goals (flag stands, hardpoints, roam
// points) and a budgeted A* for the rare moving goal (a dropped flag). Built once per map and
// shared by every room on that map. Same rules as the walker in tools/maps.test.js, which
// verifies every flag / hardpoint route on every map with stepPlayer.
//
//   const nav = getNav(map);
//   nav.nodeAt(x, y, z)            -> node id or -1 (the surface the feet are on / nearest)
//   nav.field(key, [x,y,z])        -> { dist: Float32Array, next: Int32Array } towards the goal
//   nav.path(from, to, budget)     -> Int32Array of node ids (from..to) or null
//   nav.x[n], nav.y[n], nav.z[n]   node position (feet level)

import { PLAYER } from '../shared/constants.js';
import { MOVE } from '../shared/physics.js';

const CELL = 0.5;
const CLEAR = PLAYER.halfWidth + 0.12;
const STEP = MOVE.stepHeight;
const cache = new Map();

export function getNav(map) {
  let nav = cache.get(map.id);
  if (!nav) { nav = buildNav(map); cache.set(map.id, nav); }
  return nav;
}

function bodyFree(boxes, x, y, z, hw) {
  for (const b of boxes) {
    if (b.max[1] <= y + STEP + 0.01 || b.min[1] >= y + PLAYER.height) continue;
    if (x + hw > b.min[0] && x - hw < b.max[0] && z + hw > b.min[2] && z - hw < b.max[2]) return false;
  }
  return true;
}

function buildNav(map) {
  const boxes = map.boxes;
  const x0 = map.bounds.min[0], z0 = map.bounds.min[2];
  const nx = Math.ceil((map.bounds.max[0] - x0) / CELL), nz = Math.ceil((map.bounds.max[2] - z0) / CELL);
  const X = [], Y = [], Z = [];
  const cellLists = new Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + (i + 0.5) * CELL, z = z0 + (j + 0.5) * CELL;
    const list = [];
    const tops = [];
    for (const b of boxes) {
      if (x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2]) {
        const t = Math.round(b.max[1] * 1000) / 1000;
        if (!tops.includes(t)) tops.push(t);
      }
    }
    for (const t of tops) {
      if (t > -2.5 && t < 30 && bodyFree(boxes, x, t, z, CLEAR)) { list.push(X.length); X.push(x); Y.push(t); Z.push(z); }
    }
    cellLists[j * nx + i] = list;
  }
  const n = X.length;
  const cellStart = new Int32Array(nx * nz + 1);
  for (let c = 0; c < nx * nz; c++) cellStart[c + 1] = cellStart[c] + cellLists[c].length;
  const cellNodes = new Int32Array(n);
  for (let c = 0; c < nx * nz; c++) cellNodes.set(cellLists[c], cellStart[c]);
  const cellI = new Int32Array(n), cellJ = new Int32Array(n);
  for (let c = 0; c < nx * nz; c++) for (const id of cellLists[c]) { cellI[id] = c % nx; cellJ[id] = (c / nx) | 0; }

  // edges
  const adj = Array.from({ length: n }, () => []);
  const link = (a, b) => {
    const dy = Y[b] - Y[a];
    if (dy > 1.2 || dy < -12) return;
    const w = Math.hypot(X[a] - X[b], Z[a] - Z[b]) + (dy > STEP ? 1.5 : 0) + (dy < -1.5 ? 0.5 : 0);
    adj[a].push(b, w);
  };
  const at = (i, j) => cellLists[j * nx + i];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    for (const a of at(i, j)) {
      for (const [di, dj] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        for (const b of at(ii, jj)) link(a, b);
      }
      // ledges: a drop or a jump-up across a wall top leaves an unwalkable cell in between
      for (const [di, dj] of [[2, 0], [0, 2], [-2, 0], [0, -2]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const mi = i + di / 2, mj = j + dj / 2;
        if (at(mi, mj).some((m) => Math.abs(Y[m] - Y[a]) < 0.05)) continue;   // walkable in between already
        for (const b of at(ii, jj)) if (Math.abs(Y[b] - Y[a]) > STEP) link(a, b);
      }
    }
  }
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx; i++) {
    for (const di of [1, -1]) {
      const ii = i + di, jj = j + 1;
      if (ii < 0 || ii >= nx) continue;
      for (const a of at(i, j)) for (const b of at(ii, jj)) {
        if (Math.abs(Y[a] - Y[b]) > 0.05) continue;
        const m1 = at(ii, j).some((m) => Math.abs(Y[m] - Y[a]) < 0.05);
        const m2 = at(i, jj).some((m) => Math.abs(Y[m] - Y[a]) < 0.05);
        if (m1 && m2) { link(a, b); link(b, a); }
      }
    }
  }
  // CSR forward + reverse
  const adjStart = new Int32Array(n + 1);
  for (let a = 0; a < n; a++) adjStart[a + 1] = adjStart[a] + adj[a].length / 2;
  const adjTo = new Int32Array(adjStart[n]), adjW = new Float32Array(adjStart[n]);
  const rcount = new Int32Array(n + 1);
  for (let a = 0; a < n; a++) {
    for (let k = 0; k < adj[a].length; k += 2) {
      const o = adjStart[a] + k / 2;
      adjTo[o] = adj[a][k]; adjW[o] = adj[a][k + 1];
      rcount[adj[a][k] + 1]++;
    }
  }
  const radjStart = new Int32Array(n + 1);
  for (let a = 0; a < n; a++) radjStart[a + 1] = radjStart[a] + rcount[a + 1];
  const radjFrom = new Int32Array(adjStart[n]), radjW = new Float32Array(adjStart[n]);
  const rfill = radjStart.slice(0, n);
  for (let a = 0; a < n; a++) {
    for (let o = adjStart[a]; o < adjStart[a + 1]; o++) {
      const b = adjTo[o], r = rfill[b]++;
      radjFrom[r] = a; radjW[r] = adjW[o];
    }
  }

  const x = Float32Array.from(X), y = Float32Array.from(Y), z = Float32Array.from(Z);
  // the build-time JS arrays would stay alive through the closures below: release them
  X.length = 0; Y.length = 0; Z.length = 0; adj.length = 0; cellLists.length = 0;
  const fields = new Map();
  const distScratch = new Float64Array(n);
  // scratch for searches
  const heapK = new Float64Array(Math.max(16, adjStart[n] + n));
  const heapV = new Int32Array(heapK.length);
  const gScore = new Float64Array(n), cameFrom = new Int32Array(n), stamp = new Uint32Array(n);
  let stampId = 0;

  function nodeAt(px, py, pz, maxXZ = 1.6) {
    const ci = Math.floor((px - x0) / CELL), cj = Math.floor((pz - z0) / CELL);
    // the surface right under the feet first
    if (ci >= 0 && cj >= 0 && ci < nx && cj < nz) {
      const c = cj * nx + ci;
      let best = -1, by = -Infinity;
      for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
        const id = cellNodes[k];
        if (y[id] <= py + 0.45 && y[id] > by && py - y[id] < 3) { by = y[id]; best = id; }
      }
      if (best >= 0) return best;
    }
    let best = -1, bd = Infinity;
    const r = Math.ceil(maxXZ / CELL);
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const ii = ci + di, jj = cj + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
      const c = jj * nx + ii;
      for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
        const id = cellNodes[k];
        const h = Math.hypot(x[id] - px, z[id] - pz);
        if (h > maxXZ) continue;
        const d = h + Math.abs(y[id] - py) * 2;
        if (d < bd) { bd = d; best = id; }
      }
    }
    return best;
  }

  function heapPush(len, key, val) {
    let k = len;
    heapK[k] = key; heapV[k] = val;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heapK[p] <= heapK[k]) break;
      const tk = heapK[p]; heapK[p] = heapK[k]; heapK[k] = tk;
      const tv = heapV[p]; heapV[p] = heapV[k]; heapV[k] = tv;
      k = p;
    }
    return len + 1;
  }
  function heapPop(len) {   // moves the top to index len-1, returns new length
    const last = len - 1;
    const tk = heapK[0], tv = heapV[0];
    heapK[0] = heapK[last]; heapV[0] = heapV[last];
    heapK[last] = tk; heapV[last] = tv;
    let k = 0;
    for (;;) {
      const l = 2 * k + 1, r = l + 1;
      let m = k;
      if (l < last && heapK[l] < heapK[m]) m = l;
      if (r < last && heapK[r] < heapK[m]) m = r;
      if (m === k) break;
      const a = heapK[m]; heapK[m] = heapK[k]; heapK[k] = a;
      const b = heapV[m]; heapV[m] = heapV[k]; heapV[k] = b;
      k = m;
    }
    return last;
  }

  /**
   * Flow field towards goal position `pos` (cached under `key`): next hop per node (-1 = the
   * goal itself or unreachable). Only `next` is kept (4 bytes per node per field).
   */
  function field(key, pos) {
    let f = fields.get(key);
    if (f) return f;
    const dist = distScratch.fill(Infinity), next = new Int32Array(n).fill(-1);
    f = { next, goal: -1, reaches: (id) => id === f.goal || next[id] >= 0 };
    fields.set(key, f);
    const g = nodeAt(pos[0], pos[1] + 0.2, pos[2], 3);
    f.goal = g;
    if (g < 0) return f;
    dist[g] = 0;
    let len = heapPush(0, 0, g);
    while (len > 0) {
      len = heapPop(len);
      const d = heapK[len], v = heapV[len];
      if (d > dist[v]) continue;
      for (let o = radjStart[v]; o < radjStart[v + 1]; o++) {
        const p = radjFrom[o], nd = d + radjW[o];
        if (nd < dist[p]) { dist[p] = nd; next[p] = v; len = heapPush(len, nd, p); }
      }
    }
    return f;
  }

  /** A* from node a to node b, at most `budget` expansions. Returns node ids or null. */
  function path(a, b, budget = 6000) {
    if (a < 0 || b < 0) return null;
    if (a === b) return Int32Array.of(a);
    stampId = (stampId + 1) >>> 0;
    if (stampId === 0) { stamp.fill(0); stampId = 1; }
    const bx = x[b], by = y[b], bz = z[b];
    const h = (v) => Math.hypot(x[v] - bx, z[v] - bz) + Math.abs(y[v] - by) * 0.3;
    stamp[a] = stampId; gScore[a] = 0; cameFrom[a] = -1;
    let len = heapPush(0, h(a), a);
    let expanded = 0;
    while (len > 0) {
      len = heapPop(len);
      const v = heapV[len];
      if (v === b) break;
      if (++expanded > budget) return null;
      const gv = gScore[v];
      for (let o = adjStart[v]; o < adjStart[v + 1]; o++) {
        const m = adjTo[o], ng = gv + adjW[o];
        if (stamp[m] !== stampId || ng < gScore[m]) {
          stamp[m] = stampId; gScore[m] = ng; cameFrom[m] = v;
          if (len < heapK.length) len = heapPush(len, ng + h(m), m);
        }
      }
    }
    if (stamp[b] !== stampId) return null;
    const out = [];
    for (let v = b; v !== -1 && out.length < n; v = cameFrom[v]) out.push(v);
    out.reverse();
    return Int32Array.from(out);
  }

  return { nodeCount: n, x, y, z, cellI, cellJ, nodeAt, field, path, adjStart, adjTo, cell: CELL };
}
