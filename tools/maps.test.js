// Map validation: node tools/maps.test.js [map_id ...]
//   VERBOSE=1  list every offending item, ASCII=1  print a top-down ASCII plan of each map.
// Plain Node. Prints PASS/FAIL per check per map and a summary line; exits non-zero on any FAIL.
import { MAPS, MAP_IDS, DEFAULT_MAP_ID, getMap } from '../shared/maps/index.js';
import { MAP as LEGACY_MAP } from '../shared/map.js';
import { PLAYER, BTN } from '../shared/constants.js';
import { MOVE, createWorld, createPlayerState, spawnState, stepPlayer, raycastWorld } from '../shared/physics.js';

const VERBOSE = !!process.env.VERBOSE, ASCII = !!process.env.ASCII;
const only = process.argv.slice(2);
let fails = 0, passes = 0;
function report(mapId, name, errs, info) {
  if (errs.length === 0) { passes++; console.log(`PASS  ${mapId.padEnd(13)} ${name}${info ? '  (' + info + ')' : ''}`); }
  else {
    fails++;
    console.log(`FAIL  ${mapId.padEnd(13)} ${name}  ${errs.length} problem(s)`);
    for (const e of errs.slice(0, VERBOSE ? 400 : 4)) console.log(`        - ${e}`);
    if (!VERBOSE && errs.length > 4) console.log(`        ... ${errs.length - 4} more (VERBOSE=1)`);
  }
}
const f1 = (v) => (Math.round(v * 10) / 10).toString();
const P = (p) => `(${p.map(f1).join(', ')})`;
const EYE = PLAYER.eyeHeight, HW = PLAYER.halfWidth, STEP = MOVE.stepHeight;

// ---------------------------------------------------------------- geometry helpers
function inBox(b, x, y, z, e = 0) {
  return x > b.min[0] - e && x < b.max[0] + e && y > b.min[1] - e && y < b.max[1] + e && z > b.min[2] - e && z < b.max[2] + e;
}
function topAt(map, x, z, belowY = Infinity) { // highest box top at (x,z) that is <= belowY
  let t = -Infinity;
  for (const b of map.boxes) if (x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2] && b.max[1] <= belowY + 1e-6 && b.max[1] > t) t = b.max[1];
  return t;
}
// Is a standing player (feet y, centre x,z) free of solid geometry? Boxes whose top is within the
// step height of the feet do not block (the player steps onto them).
function bodyFree(map, x, y, z, hw = HW - 0.01) {
  for (const b of map.boxes) {
    if (b.max[1] <= y + STEP + 0.01 || b.min[1] >= y + PLAYER.height) continue;
    if (x + hw > b.min[0] && x - hw < b.max[0] && z + hw > b.min[2] && z - hw < b.max[2]) return false;
  }
  return true;
}
function los(W, a, b) { // true if the straight segment a->b is unobstructed
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) return true;
  return !(raycastWorld(W, a[0], a[1], a[2], dx / d, dy / d, dz / d, d - 0.05) < d - 0.05);
}
function mapCentre(map) {
  const cx = (map.bounds.min[0] + map.bounds.max[0]) / 2, cz = (map.bounds.min[2] + map.bounds.max[2]) / 2;
  const t = topAt(map, cx, cz, 4);
  return [cx, (t === -Infinity ? 0 : t) + 1.0, cz];
}
const eyeOf = (s) => [s.pos[0], s.pos[1] + EYE, s.pos[2]];

// ---------------------------------------------------------------- navigation grid (for routes and traps)
const CELL = 0.5;
function buildNav(map) {
  const x0 = map.bounds.min[0], z0 = map.bounds.min[2];
  const nx = Math.ceil((map.bounds.max[0] - x0) / CELL), nz = Math.ceil((map.bounds.max[2] - z0) / CELL);
  const nodes = []; // {i,j,x,y,z, adj:[], radj:[]}
  const cellNodes = new Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + (i + 0.5) * CELL, z = z0 + (j + 0.5) * CELL, list = [];
    const tops = new Set();
    for (const b of map.boxes) if (x >= b.min[0] && x <= b.max[0] && z >= b.min[2] && z <= b.max[2]) tops.add(Math.round(b.max[1] * 1000) / 1000);
    for (const t of tops) if (t > -2.5 && t < 30 && bodyFree(map, x, t, z, HW + 0.12)) { const n = { id: nodes.length, i, j, x, y: t, z, adj: [], radj: [] }; nodes.push(n); list.push(n); }
    cellNodes[j * nx + i] = list;
  }
  const link = (a, b) => {
    const dy = b.y - a.y;
    if (dy > 1.2 || dy < -12) return;
    const w = Math.hypot(a.x - b.x, a.z - b.z) + (dy > STEP ? 1.5 : 0);
    a.adj.push([b, w]); b.radj.push(a);
  };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    for (const a of cellNodes[j * nx + i]) {
      for (const [di, dj] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        for (const b of cellNodes[jj * nx + ii]) link(a, b);
      }
    }
  }
  // ledges: a drop or a jump-up across a wall leaves an unwalkable cell in between, link nodes two cells apart
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    for (const a of cellNodes[j * nx + i]) {
      for (const [di, dj] of [[2, 0], [0, 2], [-2, 0], [0, -2]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        for (const b of cellNodes[jj * nx + ii]) if (Math.abs(b.y - a.y) > STEP) link(a, b);
      }
    }
  }
  // diagonals when both orthogonal detours exist at (nearly) the same height
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    for (const [di, dj] of [[1, 1], [-1, 1]]) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || ii >= nx) continue;
      for (const a of cellNodes[j * nx + i]) for (const b of cellNodes[jj * nx + ii]) {
        if (Math.abs(a.y - b.y) > 0.05) continue;
        const m1 = cellNodes[j * nx + ii].some((n) => Math.abs(n.y - a.y) < 0.05);
        const m2 = cellNodes[jj * nx + i].some((n) => Math.abs(n.y - a.y) < 0.05);
        if (m1 && m2) link(a, b);
      }
    }
  }
  const nearest = (p, maxXZ = 1.6) => {
    let best = null, bd = Infinity;
    const ci = Math.floor((p[0] - x0) / CELL), cj = Math.floor((p[2] - z0) / CELL);
    for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) {
      const ii = ci + di, jj = cj + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
      for (const n of cellNodes[jj * nx + ii]) {
        const d = Math.hypot(n.x - p[0], n.z - p[2]) + Math.abs(n.y - p[1]) * 2;
        if (d < bd && Math.hypot(n.x - p[0], n.z - p[2]) <= maxXZ) { bd = d; best = n; }
      }
    }
    return best;
  };
  const reach = (start, rev) => {
    const seen = new Uint8Array(nodes.length), st = [start]; seen[start.id] = 1;
    while (st.length) {
      const n = st.pop();
      if (rev) { for (const m of n.radj) if (!seen[m.id]) { seen[m.id] = 1; st.push(m); } }
      else for (const [m] of n.adj) if (!seen[m.id]) { seen[m.id] = 1; st.push(m); }
    }
    return seen;
  };
  const path = (a, b) => { // Dijkstra with a binary heap
    const dist = new Float64Array(nodes.length).fill(Infinity), prev = new Int32Array(nodes.length).fill(-1);
    const heap = [[0, a.id]];
    const push = (e) => { heap.push(e); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { let l = 2 * k + 1, r = l + 1, m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
    dist[a.id] = 0;
    while (heap.length) {
      const [d, id] = pop();
      if (d > dist[id]) continue;
      if (id === b.id) break;
      for (const [m, w] of nodes[id].adj) if (d + w < dist[m.id]) { dist[m.id] = d + w; prev[m.id] = id; push([d + w, m.id]); }
    }
    if (dist[b.id] === Infinity) return null;
    const out = []; for (let k = b.id; k !== -1; k = prev[k]) out.push(nodes[k]);
    out.reverse();
    return { nodes: out, length: dist[b.id] };
  };
  return { nodes, nearest, reach, path };
}

// ---------------------------------------------------------------- bot: follow a nav path with stepPlayer
function walkTo(W, nav, from, to, maxSec) {
  const a = nav.nearest(from), b = nav.nearest(to, 2.2);
  if (!a) return { ok: false, why: 'start not on a walkable cell' };
  if (!b) return { ok: false, why: 'target not on a walkable cell' };
  const p = nav.path(a, b);
  if (!p) return { ok: false, why: 'no walkable route (nav graph)' };
  // thin out collinear same-height points
  const pts = [];
  for (let k = 0; k < p.nodes.length; k++) {
    const n = p.nodes[k];
    if (k > 0 && k < p.nodes.length - 1) {
      const q = p.nodes[k - 1], r = p.nodes[k + 1];
      if (Math.abs(n.y - q.y) < 0.01 && Math.abs(n.y - r.y) < 0.01 && Math.abs((n.x - q.x) * (r.z - n.z) - (n.z - q.z) * (r.x - n.x)) < 1e-6) continue;
    }
    pts.push(n);
  }
  const s = spawnState(createPlayerState(), from[0], from[1], from[2]);
  const cmd = { seq: 0, buttons: 0, yaw: 0, pitch: 0, weapon: 0 };
  const limit = Math.round(maxSec * 60);
  let wi = 0, stuck = 0, lx = s.x, lz = s.z;
  for (let t = 0; t < limit; t++) {
    while (wi < pts.length - 1 && Math.hypot(pts[wi].x - s.x, pts[wi].z - s.z) < 0.5 && Math.abs(pts[wi].y - s.y) < 0.8) wi++;
    const w = pts[wi];
    const dx = w.x - s.x, dz = w.z - s.z;
    cmd.yaw = Math.atan2(-dx, -dz);
    cmd.buttons = BTN.FORWARD | (w.y - s.y > STEP - 0.02 ? BTN.JUMP : 0);
    cmd.seq = t;
    stepPlayer(s, cmd, W);
    if (s.y < -5) return { ok: false, why: `fell off at (${f1(s.x)}, ${f1(s.y)}, ${f1(s.z)})`, t: t / 60 };
    if (Math.hypot(to[0] - s.x, to[2] - s.z) < 1.3 && Math.abs(to[1] - s.y) < 1.6) return { ok: true, t: (t + 1) / 60, len: p.length };
    if (t % 120 === 119) { // 2 s without 1 m of progress = stuck
      if (Math.hypot(s.x - lx, s.z - lz) < 1) stuck++; else stuck = 0;
      lx = s.x; lz = s.z;
      if (stuck >= 2) return { ok: false, why: `stuck at (${f1(s.x)}, ${f1(s.y)}, ${f1(s.z)}) heading to (${f1(w.x)}, ${f1(w.y)}, ${f1(w.z)})`, t: t / 60 };
    }
  }
  return { ok: false, why: `not there after ${maxSec.toFixed(0)} s (at ${f1(s.x)}, ${f1(s.y)}, ${f1(s.z)})`, t: maxSec };
}

// ---------------------------------------------------------------- symmetry
function detectMirrors(map) {
  const key = (b) => [...b.min, ...b.max].map((v) => Math.round(v * 100) / 100 + 0).join(',');
  const set = new Map();
  for (const b of map.boxes) set.set(key(b), (set.get(key(b)) || 0) + 1);
  const modes = [];
  for (const mode of ['x', 'z', 'xz']) {
    const mx = mode !== 'z' ? -1 : 1, mz = mode !== 'x' ? -1 : 1;
    let ok = true;
    for (const b of map.boxes) {
      const a = [b.min[0] * mx, b.max[0] * mx].sort((p, q) => p - q), c = [b.min[2] * mz, b.max[2] * mz].sort((p, q) => p - q);
      if (!set.has(key({ min: [a[0], b.min[1], c[0]], max: [a[1], b.max[1], c[1]] }))) { ok = false; break; }
    }
    if (ok) modes.push(mode);
  }
  return modes;
}
function mir(p, mode) { return [mode !== 'z' ? -p[0] : p[0], p[1], mode !== 'x' ? -p[2] : p[2]]; }
function mirYaw(yaw, mode) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  return Math.atan2(-(mode !== 'z' ? -fx : fx), -(mode !== 'x' ? -fz : fz));
}
function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d); }

// ---------------------------------------------------------------- per-map checks
const RULES = [];
const rule = (name, fn) => RULES.push([name, fn]);
const near = (a, b, e = 0.02) => a.every((v, i) => Math.abs(v - b[i]) <= e);

rule('schema', (m) => {
  const e = [];
  if (!/^[a-z0-9_]+$/.test(m.id || '')) e.push(`bad id ${m.id}`);
  if (!m.name || !m.blurb || m.blurb.length > 120) e.push('name/blurb missing or blurb too long');
  if (!['small', 'medium', 'large'].includes(m.size)) e.push(`size ${m.size}`);
  const v3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  if (!Array.isArray(m.boxes)) e.push('boxes missing');
  else {
    if (m.boxes.length < 30 || m.boxes.length > 90) e.push(`box count ${m.boxes.length} not in 30-90`);
    m.boxes.forEach((b, i) => {
      if (!v3(b.min) || !v3(b.max) || !Number.isInteger(b.color) || b.color < 0 || b.color > 0xffffff) e.push(`box ${i} malformed`);
      else for (let a = 0; a < 3; a++) if (!(b.min[a] < b.max[a])) e.push(`box ${i} min >= max on axis ${a}: ${P(b.min)} ${P(b.max)}`);
    });
  }
  if (!m.bounds || !v3(m.bounds.min) || !v3(m.bounds.max)) e.push('bounds malformed');
  else for (let a = 0; a < 3; a++) if (!(m.bounds.min[a] < m.bounds.max[a])) e.push('bounds min >= max');
  if (!Number.isFinite(m.killY) || m.killY >= 0) e.push('killY');
  const nS = m.size === 'large' ? 24 : 16;
  if (!Array.isArray(m.spawns) || m.spawns.length < nS) e.push(`need >= ${nS} ffa spawns, have ${m.spawns && m.spawns.length}`);
  const sp = (s, tag) => { if (!s || !v3(s.pos) || !Number.isFinite(s.yaw)) e.push(`${tag} malformed`); };
  (m.spawns || []).forEach((s, i) => sp(s, `spawn ${i}`));
  for (const t of ['a', 'b']) {
    const l = m.teamSpawns && m.teamSpawns[t];
    if (!Array.isArray(l) || l.length < 8) e.push(`teamSpawns.${t} needs >= 8`);
    else l.forEach((s, i) => sp(s, `teamSpawns.${t}[${i}]`));
    if (!m.flags || !v3(m.flags[t])) e.push(`flags.${t} missing`);
  }
  if (!Array.isArray(m.hardpoints) || m.hardpoints.length < 3 || m.hardpoints.length > 5) e.push('3-5 hardpoints needed');
  else m.hardpoints.forEach((h, i) => {
    if (!h.name || !v3(h.min) || !v3(h.max)) e.push(`hardpoint ${i} malformed`);
    else {
      const w = h.max[0] - h.min[0], d = h.max[2] - h.min[2], t = h.max[1] - h.min[1];
      if (w < 5 || w > 7.5 || d < 5 || d > 7.5 || t < 2.5 || t > 3.5) e.push(`hardpoint ${h.name} is ${f1(w)}x${f1(d)}x${f1(t)}, want about 6x6x3`);
    }
  });
  const th = m.theme;
  if (!th) e.push('theme missing');
  else {
    for (const k of ['skyTop', 'skyBottom', 'fog']) if (!Number.isInteger(th[k])) e.push(`theme.${k}`);
    if (!(th.fogDensity > 0 && th.fogDensity < 0.05)) e.push('theme.fogDensity');
    if (!v3(th.sun)) e.push('theme.sun');
  }
  return e;
});

rule('perimeter closed + boxes inside bounds', (m, W) => {
  const e = [], B = m.bounds;
  for (const b of m.boxes) for (const a of [0, 2]) if (b.min[a] < B.min[a] - 1e-6 || b.max[a] > B.max[a] + 1e-6) e.push(`box ${P(b.min)}..${P(b.max)} outside bounds`);
  // cast rays from just inside the playable area outwards at several heights; all must hit within 2.5 m
  const inset = 1.05;
  const x0 = B.min[0] + inset, x1 = B.max[0] - inset, z0 = B.min[2] + inset, z1 = B.max[2] - inset;
  let maxWalk = 0;
  for (const b of m.boxes) if (b.max[1] > maxWalk && (b.max[0] - b.min[0]) < (B.max[0] - B.min[0]) * 0.6 && (b.max[2] - b.min[2]) < (B.max[2] - B.min[2]) * 0.6) maxWalk = b.max[1];
  const heights = [0.3, 0.9, 1.6, 2.5, 3.5, 5, 7, 9, maxWalk + 3];
  let leaks = 0;
  for (const y of heights) {
    for (let t = 0; t <= 1.0001; t += 0.5 / ((B.max[0] - B.min[0]) / 2)) {
      const x = x0 + (x1 - x0) * Math.min(1, t), z = z0 + (z1 - z0) * Math.min(1, t);
      const tests = [[x, z0, 0, -1], [x, z1, 0, 1], [x0, z, -1, 0], [x1, z, 1, 0]];
      for (const [px, pz, dx, dz] of tests) if (!(raycastWorld(W, px, y, pz, dx, 0, dz, 3) < 3)) { if (leaks++ < 6) e.push(`opening in perimeter near (${f1(px)}, ${f1(y)}, ${f1(pz)}) heading ${dx || dz}`); }
    }
  }
  return e;
});

function groundOK(m, s, tag, e) {
  const [x, y, z] = s.pos;
  const t = topAt(m, x, z, y + 0.02);
  if (Math.abs(t - y) > 0.02) e.push(`${tag} ${P(s.pos)} has no ground at its feet (top below = ${f1(t)})`);
  for (const b of m.boxes) {
    if (b.max[1] > y + 0.02 && b.min[1] < y + PLAYER.height && x >= b.min[0] - 0.01 && x <= b.max[0] + 0.01 && z >= b.min[2] - 0.01 && z <= b.max[2] + 0.01) { e.push(`${tag} ${P(s.pos)} is inside box ${P(b.min)}..${P(b.max)}`); break; }
    if (b.max[1] <= y + STEP + 0.01 || b.min[1] >= y + PLAYER.height) continue;
    if (x > b.min[0] - 0.5 && x < b.max[0] + 0.5 && z > b.min[2] - 0.5 && z < b.max[2] + 0.5) { e.push(`${tag} ${P(s.pos)} is inside or within 0.5 m of box ${P(b.min)}..${P(b.max)}`); break; }
  }
}
rule('spawns on solid ground and clear of geometry', (m) => {
  const e = [];
  m.spawns.forEach((s, i) => groundOK(m, s, `ffa spawn ${i}`, e));
  for (const t of ['a', 'b']) m.teamSpawns[t].forEach((s, i) => groundOK(m, s, `team ${t} spawn ${i}`, e));
  for (const t of ['a', 'b']) {
    const f = m.flags[t];
    if (m.boxes.some((b) => b.max[1] > f[1] + 0.02 && b.min[1] < f[1] + 1.5 && f[0] > b.min[0] && f[0] < b.max[0] && f[2] > b.min[2] && f[2] < b.max[2])) e.push(`flag ${t} ${P(f)} is inside a box`);
    if (Math.abs(topAt(m, f[0], f[2], f[1] + 0.02) - f[1]) > 0.02) e.push(`flag ${t} ${P(f)} floats (no ground under it)`);
  }
  m.hardpoints.forEach((h) => {
    const cy = h.min[1];
    // open floor: every 0.5 m cell inside the zone stands on the zone's floor height with no taller box intruding
    let bad = 0, n = 0;
    for (let x = h.min[0] + 0.25; x < h.max[0]; x += 0.5) for (let z = h.min[2] + 0.25; z < h.max[2]; z += 0.5) {
      n++;
      if (Math.abs(topAt(m, x, z, cy + 0.02) - cy) > 0.02 || m.boxes.some((b) => b.max[1] > cy + 0.4 && b.min[1] < cy + 2 && x > b.min[0] && x < b.max[0] && z > b.min[2] && z < b.max[2])) bad++;
    }
    if (bad > 0.04 * n) e.push(`hardpoint ${h.name} is not open floor (${bad}/${n} cells blocked or at another height)`);
  });
  return e;
});

rule('spawn cover: facing a clear way, cover nearby, no line to centre', (m, W) => {
  const e = [], C = mapCentre(m);
  const all = [...m.spawns.map((s, i) => [s, `ffa ${i}`]), ...['a', 'b'].flatMap((t) => m.teamSpawns[t].map((s, i) => [s, `team ${t}${i}`]))];
  for (const [s, tag] of all) {
    const eye = eyeOf(s);
    if (los(W, eye, C)) e.push(`${tag} ${P(s.pos)} has a straight line to the map centre`);
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    const fwd = raycastWorld(W, eye[0], eye[1] - 0.4, eye[2], fx, 0, fz, 12);
    if (fwd < 2.5) e.push(`${tag} ${P(s.pos)} faces a wall ${f1(fwd)} m away`);
    let coverDist = Infinity, open = 0;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2, d = raycastWorld(W, eye[0], eye[1] - 0.4, eye[2], Math.cos(a), 0, Math.sin(a), 20);
      if (d < coverDist) coverDist = d;
      if (d >= 12) open++;
    }
    if (coverDist > 3.2) e.push(`${tag} ${P(s.pos)} has no cover within 3.2 m (nearest ${f1(coverDist)})`);
    if (open / 24 > 0.62) e.push(`${tag} ${P(s.pos)} is too exposed (${open}/24 directions open past 12 m)`);
  }
  return e;
});

rule('team data present and mirror-symmetric', (m, W, ctx) => {
  const modes = detectMirrors(m);
  if (!modes.length) return ['boxes are not mirror-symmetric under x, z or 180-degree rotation'];
  let first = null;
  for (const mode of modes) {
    const e = teamSymmetryErrors(m, mode);
    if (!e.length) { ctx.mirror = mode; return []; }
    if (!first) first = e.map((x) => `[mirror ${mode}] ${x}`);
  }
  return first;
});
function teamSymmetryErrors(m, mode) {
  const e = [];
  const chk = (A, B, label) => {
    A.forEach((s) => {
      const p = mir(s.pos, mode), y = mirYaw(s.yaw, mode);
      if (!B.some((t) => near(t.pos, p) && angDiff(t.yaw, y) < 0.02)) e.push(`${label} ${P(s.pos)} has no mirrored partner at ${P(p)}`);
    });
  };
  if (m.teamSpawns.a.length !== m.teamSpawns.b.length) e.push('teams have different spawn counts');
  chk(m.teamSpawns.a, m.teamSpawns.b, 'team a spawn'); chk(m.teamSpawns.b, m.teamSpawns.a, 'team b spawn');
  if (!near(mir(m.flags.a, mode), m.flags.b)) e.push(`flag b ${P(m.flags.b)} is not the mirror of flag a ${P(m.flags.a)}`);
  if (near(m.flags.a, m.flags.b, 1)) e.push('flags are not apart');
  const mid = (h) => [(h.min[0] + h.max[0]) / 2, h.min[1], (h.min[2] + h.max[2]) / 2];
  m.hardpoints.forEach((h) => {
    const c = mir(mid(h), mode);
    if (!m.hardpoints.some((g) => near(mid(g), c, 0.05) && Math.abs((g.max[0] - g.min[0]) - (h.max[0] - h.min[0])) < 0.05)) e.push(`hardpoint ${h.name} has no mirrored partner`);
  });
  // team spawns belong to their own half of the map
  const ctr = mapCentre(m);
  const side = (s) => (mode === 'z' ? s.pos[2] - ctr[2] : s.pos[0] - ctr[0]);
  const sa = m.teamSpawns.a.map(side), sb = m.teamSpawns.b.map(side);
  if (mode !== 'xz' && !(sa.every((v) => v < 0) && sb.every((v) => v > 0)) && !(sa.every((v) => v > 0) && sb.every((v) => v < 0))) e.push('team spawns are not each in their own half');
  return e;
}

rule('team spawns hidden from enemy flag and enemy home spawns', (m, W) => {
  const e = [];
  for (const t of ['a', 'b']) {
    const o = t === 'a' ? 'b' : 'a', fl = [m.flags[o][0], m.flags[o][1] + 1.0, m.flags[o][2]];
    const myF = m.flags[t];
    m.teamSpawns[t].forEach((s, i) => {
      const eye = eyeOf(s);
      if (los(W, eye, fl)) e.push(`team ${t}${i} ${P(s.pos)} sees the enemy flag`);
      m.teamSpawns[o].forEach((q, k) => { if (los(W, eye, eyeOf(q))) e.push(`team ${t}${i} ${P(s.pos)} sees enemy spawn ${o}${k} ${P(q.pos)}`); });
      const d = Math.hypot(s.pos[0] - myF[0], s.pos[2] - myF[2]), dEnemy = Math.hypot(s.pos[0] - m.flags[o][0], s.pos[2] - m.flags[o][2]);
      if (d > dEnemy * 0.6) e.push(`team ${t}${i} ${P(s.pos)} is ${f1(d)} m from its own flag (enemy flag ${f1(dEnemy)} m): not in the home area`);
    });
  }
  return e;
});

rule('flag stands have cover but are not sealed', (m, W) => {
  const e = [];
  for (const t of ['a', 'b']) {
    const f = m.flags[t], eye = [f[0], f[1] + 0.9, f[2]];
    let blocked = 0, open = 0, N = 24;
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2, d = raycastWorld(W, eye[0], eye[1], eye[2], Math.cos(a), 0, Math.sin(a), 10);
      if (d < 4) blocked++; else open++;
    }
    if (blocked < 4) e.push(`flag ${t}: only ${blocked}/${N} directions covered within 4 m (needs cover)`);
    if (open < 5) e.push(`flag ${t}: only ${open}/${N} directions open (too sealed)`);
  }
  return e;
});

rule('routes simulated with stepPlayer (spawns -> flags, hardpoints)', (m, W, ctx) => {
  const e = [], nav = ctx.nav;
  const targets = [];
  m.hardpoints.forEach((h) => targets.push([`hardpoint ${h.name}`, [(h.min[0] + h.max[0]) / 2, h.min[1], (h.min[2] + h.max[2]) / 2]]));
  // climbing proof: the highest and the lowest surface reachable from the first spawn of each team
  for (const t of ['a', 'b']) {
    const from = m.teamSpawns[t][0].pos, n0 = nav.nearest(from);
    if (!n0) continue;
    const seen = nav.reach(n0, false);
    let hi = null, lo = null;
    for (const n of nav.nodes) if (seen[n.id]) {
      if (!hi || n.y > hi.y + 0.01 || (Math.abs(n.y - hi.y) < 0.01 && Math.hypot(n.x - from[0], n.z - from[2]) < Math.hypot(hi.x - from[0], hi.z - from[2]))) hi = n;
      if (!lo || n.y < lo.y - 0.01) lo = n;
    }
    if (hi && hi.y > 0.5) targets.push([`highest perch ${t === 'a' ? '' : ''}(${f1(hi.y)} m)`, [hi.x, hi.y, hi.z]]);
    if (lo && lo.y < -0.5) targets.push([`lowest floor (${f1(lo.y)} m)`, [lo.x, lo.y, lo.z]]);
  }
  const jobs = [];
  for (const t of ['a', 'b']) {
    const o = t === 'a' ? 'b' : 'a';
    m.teamSpawns[t].forEach((s, i) => {
      jobs.push([`team ${t}${i}`, s.pos, [[`own flag`, m.flags[t]], [`enemy flag`, m.flags[o]], ...targets]]);
    });
  }
  m.spawns.forEach((s, i) => jobs.push([`ffa ${i}`, s.pos, targets]));
  let slowest = 0, n = 0, sum = 0;
  for (const [tag, from, tl] of jobs) {
    for (const [name, to] of tl) {
      const a = nav.nearest(from), b = nav.nearest(to, 2.2);
      let limit = 60;
      if (a && b) { const p = nav.path(a, b); if (p) limit = 25 + p.length / 3; }
      const r = walkTo(W, nav, from, to, limit);
      n++;
      if (!r.ok) e.push(`${tag} ${P(from)} -> ${name} ${P(to)}: ${r.why}`);
      else { slowest = Math.max(slowest, r.t); sum += r.t; }
    }
  }
  ctx.routeInfo = `${n} routes, slowest ${slowest.toFixed(1)} s, mean ${(sum / Math.max(1, n)).toFixed(1)} s`;
  return e;
});

rule('no traps: everything reachable from a spawn can get back', (m, W, ctx) => {
  const e = [], nav = ctx.nav;
  const starts = [...m.teamSpawns.a.slice(0, 1), ...m.teamSpawns.b.slice(0, 1), m.spawns[0]];
  const hub = nav.nearest(starts[0].pos);
  if (!hub) return ['spawn not on nav'];
  const back = nav.reach(hub, true), fwd = nav.reach(hub, false);
  let trapped = 0, area = 0;
  const samples = [];
  for (const n of nav.nodes) if (fwd[n.id] && !back[n.id]) { trapped++; if (samples.length < 5) samples.push(n); }
  for (const n of nav.nodes) if (fwd[n.id]) area++;
  if (trapped) e.push(`${trapped} reachable cells cannot return, e.g. ${samples.map((n) => P([n.x, n.y, n.z])).join(' ')}`);
  for (const s of [...m.spawns, ...m.teamSpawns.a, ...m.teamSpawns.b]) {
    const n = nav.nearest(s.pos);
    if (!n || !fwd[n.id] || !back[n.id]) e.push(`spawn ${P(s.pos)} is cut off from the main area`);
  }
  // walkable floor-level cells that are NOT part of the main area (sealed pockets)
  let sealed = 0; const ss = [];
  for (const n of nav.nodes) if (n.y < 0.05 && n.y > -0.05 && !fwd[n.id]) { sealed++; if (ss.length < 3) ss.push(n); }
  if (sealed > 6) e.push(`${sealed} floor cells are sealed pockets nobody can reach, e.g. ${ss.map((n) => P([n.x, n.y, n.z])).join(' ')}`);
  ctx.area = area;
  return e;
});

rule('at least two routes between the team bases', (m, W, ctx) => {
  const nav = ctx.nav, a = nav.nearest(m.flags.a, 2), b = nav.nearest(m.flags.b, 2);
  const p1 = nav.path(a, b);
  if (!p1) return ['no route between flags'];
  // block the middle of the shortest path (all cells within 2.5 m of its midpoint) and look for another way
  const mid = p1.nodes[Math.floor(p1.nodes.length / 2)];
  const blocked = new Set();
  for (const n of nav.nodes) if (Math.hypot(n.x - mid.x, n.z - mid.z) < 2.5 && Math.abs(n.y - mid.y) < 3) blocked.add(n.id);
  const seen = new Uint8Array(nav.nodes.length), st = [a]; seen[a.id] = 1;
  while (st.length) { const n = st.pop(); for (const [q] of n.adj) if (!seen[q.id] && !blocked.has(q.id)) { seen[q.id] = 1; st.push(q); } }
  ctx.flagDist = p1.length;
  return seen[b.id] ? [] : [`blocking ${P([mid.x, mid.y, mid.z])} (a 5 m choke on the shortest path) cuts the bases apart`];
});

// ---------------------------------------------------------------- legacy export + registry
function registryChecks() {
  const e1 = [];
  if (!Array.isArray(MAPS) || MAPS.length < 5) e1.push(`expected >= 5 maps, have ${MAPS.length}`);
  if (MAPS[0].id !== DEFAULT_MAP_ID) e1.push('default map is not first');
  if (new Set(MAP_IDS).size !== MAP_IDS.length) e1.push('duplicate ids');
  if (getMap('nope_nope') !== getMap(DEFAULT_MAP_ID)) e1.push('getMap fallback broken');
  for (const m of MAPS) if (getMap(m.id) !== m) e1.push(`getMap(${m.id}) mismatch`);
  const sizes = MAPS.map((m) => m.size);
  if (sizes.filter((s) => s === 'small').length < 2 || !sizes.includes('medium') || !sizes.includes('large')) e1.push(`size mix is ${sizes.join(',')}`);
  const names = new Set(), themes = new Set();
  for (const m of MAPS) { names.add(m.name); themes.add(`${m.theme.skyTop}/${m.theme.fog}`); }
  if (names.size !== MAPS.length) e1.push('duplicate names');
  if (themes.size !== MAPS.length) e1.push('two maps share a theme');
  report('registry', 'MAPS / MAP_IDS / getMap / DEFAULT_MAP_ID', e1, `${MAP_IDS.join(', ')}`);
  const e2 = [];
  if (LEGACY_MAP !== getMap(DEFAULT_MAP_ID)) e2.push('shared/map.js MAP is not the default map');
  for (const k of ['boxes', 'spawns', 'bounds', 'killY', 'name']) if (LEGACY_MAP[k] === undefined) e2.push(`MAP.${k} missing`);
  report('registry', 'shared/map.js still exports MAP', e2);
}

// ---------------------------------------------------------------- summary helpers
function longestSightline(m, W) {
  let best = 0, at = null;
  const pts = m.spawns.map((s) => eyeOf(s));
  for (let x = m.bounds.min[0] + 3; x < m.bounds.max[0] - 2; x += 4) for (let z = m.bounds.min[2] + 3; z < m.bounds.max[2] - 2; z += 4) {
    const t = topAt(m, x, z, 4);
    if (t > -Infinity && t < 0.05 && bodyFree(m, x, 0, z)) pts.push([x, EYE, z]);
  }
  for (const p of pts) for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2, d = raycastWorld(W, p[0], p[1], p[2], Math.cos(a), 0, Math.sin(a), 400);
    if (d !== Infinity && d > best) { best = d; at = p; }
  }
  return [best, at];
}
function ascii(m) {
  const step = m.size === 'small' ? 0.5 : 1, B = m.bounds, rows = [];
  const mark = new Map();
  const put = (p, c) => mark.set(`${Math.floor((p[0] - B.min[0]) / step)},${Math.floor((p[2] - B.min[2]) / step)}`, c);
  m.spawns.forEach((s) => put(s.pos, 'o')); m.teamSpawns.a.forEach((s) => put(s.pos, 'a')); m.teamSpawns.b.forEach((s) => put(s.pos, 'b'));
  put(m.flags.a, 'A'); put(m.flags.b, 'B');
  for (let z = B.min[2] + step / 2, j = 0; z < B.max[2]; z += step, j++) {
    let line = '';
    for (let x = B.min[0] + step / 2, i = 0; x < B.max[0]; x += step, i++) {
      const c = mark.get(`${i},${j}`);
      if (c) { line += c; continue; }
      const t = topAt(m, x, z, 40);
      let hp = m.hardpoints.some((h) => x > h.min[0] && x < h.max[0] && z > h.min[2] && z < h.max[2]);
      line += t <= 0.05 ? (hp ? '+' : '.') : t <= 0.4 ? ',' : t <= 1.3 ? '1' : t <= 2.5 ? '2' : t <= 3.6 ? '3' : t <= 5.5 ? '4' : '#';
    }
    rows.push(line);
  }
  return rows.join('\n');
}

// ---------------------------------------------------------------- main
registryChecks();
const summaries = [];
for (const m of MAPS) {
  if (only.length && !only.includes(m.id)) continue;
  let W = null, nav = null;
  const ctx = {};
  let schemaOk = true;
  for (const [name, fn] of RULES) {
    if (!schemaOk) break;
    try {
      if (name !== 'schema' && !W) { W = createWorld(m); }
      if (!nav && /simulated|traps|routes between/.test(name)) { nav = buildNav(m); ctx.nav = nav; }
      const errs = fn(m, W, ctx);
      report(m.id, name, errs, name.startsWith('routes') ? ctx.routeInfo : name.startsWith('at least') ? `flag-to-flag ${f1(ctx.flagDist || 0)} m of path` : '');
      if (name === 'schema' && errs.length) schemaOk = false;
    } catch (err) { fails++; console.log(`FAIL  ${m.id.padEnd(13)} ${name}  threw ${err && err.stack}`); if (name === 'schema') schemaOk = false; }
  }
  if (!schemaOk) { if (ASCII) console.log(ascii(m)); continue; }
  const [ls] = longestSightline(m, W);
  const w = m.bounds.max[0] - m.bounds.min[0] - 2, d = m.bounds.max[2] - m.bounds.min[2] - 2;
  summaries.push(`${m.id.padEnd(13)} ${m.size.padEnd(6)} ${f1(w)}x${f1(d)} m  boxes ${String(m.boxes.length).padStart(2)}  spawns ffa ${m.spawns.length} / team ${m.teamSpawns.a.length}+${m.teamSpawns.b.length}  hardpoints ${m.hardpoints.length}  longest sightline ${f1(ls)} m  cross ${f1(Math.max(w, d) / MOVE.runSpeed)} s at run speed (${f1(Math.hypot(w, d) / MOVE.runSpeed)} s diagonal)  flag-flag path ${f1(ctx.flagDist || 0)} m = ${f1((ctx.flagDist || 0) / MOVE.runSpeed)} s`);
  if (ASCII) console.log(`\n${m.name} (${m.id})  legend: a/b team spawns, o ffa spawn, A/B flags, + hardpoint floor, digits = top height class\n${ascii(m)}\n`);
}
console.log('\nSummary');
for (const s of summaries) console.log('  ' + s);
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
