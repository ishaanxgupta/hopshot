// Hopshot renderer: low-poly flat-shaded look, merged static map, instanced characters,
// pooled tracers / sparks, first-person box viewmodels (client/gunmodels.js). No allocations inside render().
//
// Draw calls (typical frame): sky 1, skyline 1, clouds 1, map 1, blob shadows 1, characters 1,
// name tags 1, tracers 1, sparks 1, viewmodel 3-4 (body, mag, pump, flash)  => about 13.
// Team modes add at most 4 (flags + stands, zone fill, zone edges, spawn-protection shimmer).
//
// setMap(map) rebuilds the static scene for a map (geometry, flat box list for occlusion tests,
// sky gradient, fog, sun, skyline) and disposes the previous GPU resources.
// setTeamView(teamMode, myTeam): characters / tags are coloured friend (blue) vs enemy (red) from
// the viewer's point of view. setOverview(true): orbiting map camera (menu, lobby, countdown, results).
// render(frame): frame.objective = null | { flags, hardpoint, myTeam } draws flags, stands and the zone.
// viewSpace(x, y, z, out) -> out { x, y, z } in camera space (for the HUD's off-screen markers).

import * as THREE from 'three';
import { buildViewmodel, buildThird, TP_PARTS, TRACER_STYLE } from './gunmodels.js';
import { FRIEND_HEX, ENEMY_HEX, FRIEND_CSS, ENEMY_CSS, teamRel } from './teams.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------------------------
// Box geometry merging (positions, normals, vertex colours, world-projected uvs)
// ---------------------------------------------------------------------------------------------
const FACES = [
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], tint: 0.88 },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], tint: 0.88 },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], tint: 1.0 },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], tint: 0.6 },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], tint: 0.94 },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], tint: 0.94 },
];
const _col = new THREE.Color();

function newAcc() { return { pos: [], nor: [], col: [], uv: [], idx: [] }; }

function addBox(acc, x0, y0, z0, x1, y1, z1, hex, o) {
  const lo = [x0, y0, z0], hi = [x1, y1, z1];
  _col.setHex(hex);
  const baseV = acc.pos.length / 3;
  let vi = baseV;
  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    if (o.skipBottom && f === 3 && y0 <= 0.001) continue;
    for (let k = 0; k < 4; k++) {
      const cs = face.c[k];
      const x = cs[0] ? hi[0] : lo[0], y = cs[1] ? hi[1] : lo[1], z = cs[2] ? hi[2] : lo[2];
      acc.pos.push(x, y, z);
      acc.nor.push(face.n[0], face.n[1], face.n[2]);
      let s = face.tint;
      // cheap fake ambient occlusion: darker where walls meet the floor
      if (o.ao && f !== 2 && f !== 3 && y <= 0.001) s *= 0.78;
      acc.col.push(_col.r * s, _col.g * s, _col.b * s);
      if (f < 2) acc.uv.push(z * 0.25, y * 0.25);
      else if (f < 4) acc.uv.push(x * 0.25, z * 0.25);
      else acc.uv.push(x * 0.25, y * 0.25);
    }
    acc.idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    vi += 4;
  }
}

function accToGeometry(acc) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(acc.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(acc.col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uv, 2));
  g.setIndex(acc.idx);
  g.computeBoundingSphere();
  return g;
}

// parts: [cx, cy, cz, sx, sy, sz, hex, rotX?]  (rotX rolls the box around its own X axis)
function partsGeometry(parts) {
  const acc = newAcc();
  for (const p of parts) {
    const v0 = acc.pos.length;
    addBox(acc, p[0] - p[3] / 2, p[1] - p[4] / 2, p[2] - p[5] / 2, p[0] + p[3] / 2, p[1] + p[4] / 2, p[2] + p[5] / 2, p[6], {});
    if (p[7]) {
      const c = Math.cos(p[7]), sn = Math.sin(p[7]);
      for (let i = v0; i < acc.pos.length; i += 3) {
        const y = acc.pos[i + 1] - p[1], z = acc.pos[i + 2] - p[2];
        acc.pos[i + 1] = p[1] + y * c - z * sn; acc.pos[i + 2] = p[2] + y * sn + z * c;
        const ny = acc.nor[i + 1], nz = acc.nor[i + 2];
        acc.nor[i + 1] = ny * c - nz * sn; acc.nor[i + 2] = ny * sn + nz * c;
      }
    }
  }
  return accToGeometry(acc);
}

function gridTexture(renderer) {
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
  // 4 m tile = 4 x 4 one-metre cells, alternating faint checker
  g.fillStyle = 'rgba(0,0,40,0.045)';
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if ((i + j) & 1) g.fillRect(i * 64, j * 64, 64, 64);
  g.strokeStyle = 'rgba(20,30,60,0.16)'; g.lineWidth = 2;
  g.beginPath();
  for (let i = 1; i < 4; i++) { g.moveTo(i * 64, 0); g.lineTo(i * 64, S); g.moveTo(0, i * 64); g.lineTo(S, i * 64); }
  g.stroke();
  g.strokeStyle = 'rgba(20,30,60,0.34)'; g.lineWidth = 4;
  g.strokeRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}

function flashTexture() {
  const S = 64, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(32, 32, 1, 32, 32, 30);
  r.addColorStop(0, 'rgba(255,255,230,1)'); r.addColorStop(0.35, 'rgba(255,200,90,0.85)'); r.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = r; g.fillRect(0, 0, S, S);
  g.fillStyle = 'rgba(255,230,150,0.9)';
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU, rr = i % 2 ? 12 : 31;
    g.lineTo(32 + Math.cos(a) * rr, 32 + Math.sin(a) * rr);
  }
  g.closePath(); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// per player: 2 legs, torso, head, visor, 2 arms, TP_PARTS gun boxes, backpack, muzzle flash
const MAXP = 32;
const P_LEGL = 0, P_LEGR = 1, P_TORSO = 2, P_HEAD = 3, P_VISOR = 4, P_ARML = 5, P_ARMR = 6,
  P_GUN = 7, P_PACK = 7 + TP_PARTS, P_FLASH = 8 + TP_PARTS;
const PARTS = 9 + TP_PARTS;
const SKIN_TONES = [0xf3d2b3, 0xe0b08a, 0xb98260, 0x8d5b3f, 0xf0c8a0, 0xd9a47a];

// opts = { quality: 'low'|'medium'|'high', touch: bool }. Anti-aliasing is fixed when the WebGL
// context is created (so a quality change that would toggle it applies on the next page load);
// everything else in setQuality() takes effect immediately.
const PIXEL_CAP = { desktop: { low: 1, medium: 1.5, high: 2 }, touch: { low: 0.75, medium: 1, high: 1.5 } };
const TAG_PX = 0.5;                 // CSS pixels per name-tag texel (cell 320x40 texels -> 160x20 px)
const TAG_FADE_NEAR = 28, TAG_FADE_FAR = 70;   // metres: fully visible, then fades to nothing

export function createRenderer(canvas, map, opts = {}) {
  const touch = !!opts.touch;
  let quality = ['low', 'medium', 'high'].includes(opts.quality) ? opts.quality : (touch ? 'medium' : 'high');
  const wantAA = quality === 'high' || (!touch && quality === 'medium');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: wantAA, powerPreference: 'high-performance' });
  const pixelRatio = () => Math.min(window.devicePixelRatio || 1, (touch ? PIXEL_CAP.touch : PIXEL_CAP.desktop)[quality]);
  renderer.setPixelRatio(pixelRatio());
  renderer.autoClear = false;
  renderer.info.autoReset = false;

  const DEFAULT_THEME = { skyTop: 0x3f86e0, skyBottom: 0xd7ecff, fog: 0xd7ecff, fogDensity: 0.008, sun: [45, 80, 30] };
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xd7ecff, 0.008);
  const camera = new THREE.PerspectiveCamera(90, 1, 0.05, 400);
  camera.rotation.order = 'YXZ';

  const sunDir = new THREE.Vector3(0.45, 0.8, 0.3).normalize();
  const hemi = new THREE.HemisphereLight(0xdcefff, 0x9d9272, 1.7);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d0, 2.2);
  sun.position.copy(sunDir).multiplyScalar(100);
  scene.add(sun);

  // ---- sky dome (follows camera; its colours are repainted in place for every map theme) ----
  const skyGeo = new THREE.SphereGeometry(300, 28, 18);
  const skyCols = new Float32Array(skyGeo.attributes.position.count * 3);
  skyGeo.setAttribute('color', new THREE.BufferAttribute(skyCols, 3));
  const sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -10; sky.frustumCulled = false;
  scene.add(sky);
  const _hz = new THREE.Color(), _zn = new THREE.Color(), _gr = new THREE.Color(), _sc = new THREE.Color(), _dv = new THREE.Vector3();
  function paintSky(th) {
    const p = skyGeo.attributes.position;
    _hz.setHex(th.skyBottom); _zn.setHex(th.skyTop);
    _gr.copy(_hz).multiplyScalar(0.82);
    for (let i = 0; i < p.count; i++) {
      _dv.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
      if (_dv.y >= 0) _sc.copy(_hz).lerp(_zn, Math.pow(_dv.y, 0.55));
      else _sc.copy(_hz).lerp(_gr, Math.min(1, -_dv.y * 4));
      const glow = Math.pow(Math.max(0, _dv.dot(sunDir)), 24) * 0.9 + Math.pow(Math.max(0, _dv.dot(sunDir)), 400) * 3;
      skyCols[i * 3] = _sc.r + glow; skyCols[i * 3 + 1] = _sc.g + glow * 0.95; skyCols[i * 3 + 2] = _sc.b + glow * 0.8;
    }
    skyGeo.attributes.color.needsUpdate = true;
  }

  // ---- skyline blocks outside the walls (one merged mesh, rebuilt per map) ----
  let skyline = null;
  function buildSkyline(map, th) {
    if (skyline) { scene.remove(skyline); skyline.geometry.dispose(); skyline.material.dispose(); skyline = null; }
    const b = map.bounds;
    const half = Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]), Math.abs(b.min[2]), Math.abs(b.max[2]));
    const acc = newAcc();
    const base = new THREE.Color(th.fog), top = new THREE.Color(th.skyTop), tc = new THREE.Color();
    const tints = [];
    for (let i = 0; i < 6; i++) { tc.copy(base).lerp(top, 0.08 + i * 0.07).multiplyScalar(0.78 + (i % 3) * 0.1); tints.push(tc.getHex()); }
    let s = 12345;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const N = 30;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + rnd() * 0.1, r = half + 42 + rnd() * 36, w = 10 + rnd() * 14, h = 10 + rnd() * 26;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      addBox(acc, cx - w / 2, -6, cz - w / 2, cx + w / 2, h, cz + w / 2, tints[(rnd() * tints.length) | 0], { skipBottom: true });
      if (rnd() > 0.5) addBox(acc, cx - w / 4, h, cz - w / 4, cx + w / 4, h + 5 + rnd() * 6, cz + w / 4, tints[(rnd() * tints.length) | 0], {});
    }
    const m = new THREE.Mesh(accToGeometry(acc), new THREE.MeshLambertMaterial({ vertexColors: true }));
    m.matrixAutoUpdate = false; m.frustumCulled = false;
    m.visible = quality !== 'low';
    scene.add(m);
    skyline = m;
  }

  // ---- clouds (flat boxes, unfogged, one mesh; only the tint changes per map) ----
  const clouds = (() => {
    const acc = newAcc();
    let s = 777;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < 14; i++) {
      const a = rnd() * TAU, r = 90 + rnd() * 140, y = 70 + rnd() * 60;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      const n = 2 + ((rnd() * 3) | 0);
      for (let k = 0; k < n; k++) {
        const w = 14 + rnd() * 22, d = 8 + rnd() * 10, h = 3 + rnd() * 3;
        const ox = (k - n / 2) * 12 + rnd() * 6, oz = rnd() * 8 - 4;
        addBox(acc, cx + ox - w / 2, y, cz + oz - d / 2, cx + ox + w / 2, y + h, cz + oz + d / 2, 0xffffff, {});
      }
    }
    const m = new THREE.Mesh(accToGeometry(acc), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, transparent: true, opacity: 0.85, depthWrite: false }));
    m.renderOrder = -9; m.frustumCulled = false;
    return m;
  })();
  scene.add(clouds);

  // ---- static map: one mesh, one draw call. setMap() rebuilds it (and the theme) and frees the old GPU data ----
  const gridTex = gridTexture(renderer);
  let curMap = null, mapMesh = null, flatBoxes = new Float32Array(0), nBoxes = 0;
  let mapHalf = 36, mapCx = 0, mapCz = 0;
  function groundBelow(x, y, z) {
    let best = -1e9;
    for (let i = 0; i < nBoxes; i++) {
      const o = i * 6;
      const top = flatBoxes[o + 4];
      if (top > best && top <= y + 0.4 && x >= flatBoxes[o] && x <= flatBoxes[o + 3] && z >= flatBoxes[o + 2] && z <= flatBoxes[o + 5]) best = top;
    }
    return best < -1e8 ? y : best;
  }
  const _fc = new THREE.Color();
  function setMap(map) {
    if (!map || !map.boxes || map === curMap) return;
    curMap = map;
    if (mapMesh) { scene.remove(mapMesh); mapMesh.geometry.dispose(); mapMesh.material.dispose(); mapMesh = null; }
    nBoxes = map.boxes.length;
    flatBoxes = new Float32Array(nBoxes * 6);
    const acc = newAcc();
    map.boxes.forEach((b, i) => {
      addBox(acc, b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2], b.color, { ao: true, skipBottom: true });
      for (let k = 0; k < 3; k++) { flatBoxes[i * 6 + k] = b.min[k]; flatBoxes[i * 6 + 3 + k] = b.max[k]; }
    });
    // deco: drawn only (no collision, not in flatBoxes), merged into the same mesh and the same draw call
    if (Array.isArray(map.deco)) for (const d of map.deco) addBox(acc, d.min[0], d.min[1], d.min[2], d.max[0], d.max[1], d.max[2], d.color, { skipBottom: true });
    mapMesh = new THREE.Mesh(accToGeometry(acc), new THREE.MeshLambertMaterial({ vertexColors: true, map: gridTex }));
    mapMesh.matrixAutoUpdate = false; mapMesh.frustumCulled = false;
    scene.add(mapMesh);
    const bd = map.bounds || { min: [-36, 0, -36], max: [36, 40, 36] };
    mapCx = (bd.min[0] + bd.max[0]) / 2; mapCz = (bd.min[2] + bd.max[2]) / 2;
    mapHalf = Math.max(bd.max[0] - bd.min[0], bd.max[2] - bd.min[2]) / 2;
    // theme: sky gradient, fog, sun direction
    const th = { ...DEFAULT_THEME, ...(map.theme || {}) };
    if (Array.isArray(th.sun) && th.sun.length === 3) sunDir.set(th.sun[0], th.sun[1], th.sun[2]).normalize();
    else sunDir.set(...DEFAULT_THEME.sun).normalize();
    sun.position.copy(sunDir).multiplyScalar(100);
    scene.fog.color.setHex(th.fog); scene.fog.density = th.fogDensity;
    renderer.setClearColor(th.fog, 1);
    paintSky(th);
    _fc.setHex(th.skyBottom);
    const lum = _fc.r * 0.3 + _fc.g * 0.59 + _fc.b * 0.11;
    hemi.color.setHex(th.skyBottom).lerp(_hz.setHex(0xffffff), 0.55);
    hemi.intensity = 1.0 + 0.8 * Math.min(1, lum * 1.5);
    clouds.material.color.setHex(th.skyBottom).lerp(_hz.setHex(0xffffff), 0.6);
    buildSkyline(map, th);
    tagVis.fill(-1);
  }

  // ---- characters: one InstancedMesh for every part of every player ----
  const unitBox = (() => {
    const acc = newAcc();
    addBox(acc, -0.5, -0.5, -0.5, 0.5, 0.5, 0.5, 0xffffff, {});
    return accToGeometry(acc);
  })();
  const chars = new THREE.InstancedMesh(unitBox, new THREE.MeshLambertMaterial({ vertexColors: false }), MAXP * PARTS);
  chars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  chars.frustumCulled = false;
  // unitBox has vertex colours (white * tint) - material ignores them, so give flat light shading via normals only
  scene.add(chars);

  const shadowGeo = new THREE.CircleGeometry(0.55, 10);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadows = new THREE.InstancedMesh(shadowGeo, new THREE.MeshBasicMaterial({
    color: 0x0a1020, transparent: true, opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }), MAXP);
  shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shadows.frustumCulled = false;
  scene.add(shadows);

  const slotId = new Int32Array(MAXP).fill(-1);
  const slotWeapon = new Int16Array(MAXP).fill(-1);      // gun * 64 + attachment mask of the gun in hand
  const slotThird = new Array(MAXP).fill(null);          // buildThird() result for that gun
  const slotName = new Array(MAXP).fill('');
  const slotSeen = new Float64Array(MAXP);
  const prevX = new Float32Array(MAXP), prevZ = new Float32Array(MAXP);
  const speedSm = new Float32Array(MAXP), phase = new Float32Array(MAXP);
  const crouchSm = new Float32Array(MAXP), slideSm = new Float32Array(MAXP);
  const deadT = new Float32Array(MAXP), flashT = new Float32Array(MAXP), flashRot = new Float32Array(MAXP);
  const tagVis = new Int8Array(MAXP).fill(-1);   // cached wall-occlusion result per slot (-1 = unknown)
  const slotRel = new Int8Array(MAXP).fill(-2);  // 0 no team, 1 friend, 2 enemy (the colours currently painted)
  let teamMode = false, viewerTeam = '';
  let slotCount = 0;

  const ONE = new THREE.Vector3(1, 1, 1), QID = new THREE.Quaternion();
  const _v = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
  const _m = new THREE.Matrix4(), mRoot = new THREE.Matrix4(), mTorso = new THREE.Matrix4(), mP = new THREE.Matrix4();

  function pivot(out, parent, px, py, pz, rx, ry) {
    _v.set(px, py, pz); _e.set(rx, ry, 0, 'YXZ'); _q.setFromEuler(_e);
    out.compose(_v, _q, ONE); out.premultiply(parent);
  }
  function put(idx, parent, px, py, pz, sx, sy, sz) {
    _v.set(px, py, pz); _s.set(sx, sy, sz);
    _m.compose(_v, QID, _s); _m.premultiply(parent);
    chars.setMatrixAt(idx, _m);
  }

  const hsl = new THREE.Color();
  function setCol(i, part, hex) { _col.setHex(hex); chars.setColorAt(i * PARTS + part, _col); }
  const teamCol = new THREE.Color();
  function paintChar(i, p, rel) {
    slotRel[i] = rel;
    const h = (Math.abs(p.id) * 0.61803398875) % 1;
    if (rel === 0) {
      hsl.setHSL(h, 0.82, 0.55); chars.setColorAt(i * PARTS + P_TORSO, hsl);
      hsl.setHSL(h, 0.8, 0.42); chars.setColorAt(i * PARTS + P_ARML, hsl); chars.setColorAt(i * PARTS + P_ARMR, hsl);
      hsl.setHSL((h + 0.5) % 1, 0.7, 0.5); chars.setColorAt(i * PARTS + P_PACK, hsl);
      hsl.setHSL(h, 0.3, 0.26); chars.setColorAt(i * PARTS + P_LEGL, hsl); chars.setColorAt(i * PARTS + P_LEGR, hsl);
    } else {
      teamCol.setHex(rel === 1 ? FRIEND_HEX : ENEMY_HEX);
      chars.setColorAt(i * PARTS + P_TORSO, teamCol);
      _col.copy(teamCol).multiplyScalar(0.72); chars.setColorAt(i * PARTS + P_ARML, _col); chars.setColorAt(i * PARTS + P_ARMR, _col);
      _col.copy(teamCol).multiplyScalar(1.25); chars.setColorAt(i * PARTS + P_PACK, _col);
      _col.copy(teamCol).multiplyScalar(0.3); chars.setColorAt(i * PARTS + P_LEGL, _col); chars.setColorAt(i * PARTS + P_LEGR, _col);
    }
    chars.instanceColor.needsUpdate = true;
    slotName[i] = '';          // redraw the tag in the new colour
  }
  function assignSlot(i, p) {
    slotId[i] = p.id; slotWeapon[i] = -1; slotThird[i] = null; slotName[i] = '';
    prevX[i] = p.x; prevZ[i] = p.z; speedSm[i] = 0; phase[i] = 0;
    crouchSm[i] = 0; slideSm[i] = 0; deadT[i] = 0; flashT[i] = 0;
    setCol(i, P_HEAD, SKIN_TONES[Math.abs(p.id) % SKIN_TONES.length]);
    setCol(i, P_VISOR, 0x18212e);
    _col.setRGB(3.2, 2.5, 1.0); chars.setColorAt(i * PARTS + P_FLASH, _col);
    slotRel[i] = -2;           // painted by updateCharacters for the current team view
    tagDirty = true;
    tagAlpha[i] = 0; tagVis[i] = -1;
  }
  function setWeaponLook(i, key) {
    slotWeapon[i] = key;
    const t = buildThird(key >> 6, key & 63);
    slotThird[i] = t;
    for (let k = 0; k < TP_PARTS; k++) {
      const part = t.parts[k];
      if (part) setCol(i, P_GUN + k, part[6]);
    }
    chars.instanceColor.needsUpdate = true;
  }

  // ---- name tags: one dynamic quad mesh + one canvas atlas (one draw call) ----
  // Each tag is a camera-facing quad sized in SCREEN pixels (so it stays small and constant at any
  // distance or zoom), anchored just above the head, faded with distance, and hidden when a wall
  // is between the camera and the player or the player is dead.
  const TAG_W = 320, TAG_H = 40, TAG_COLS = 2;
  const tagCanvas = document.createElement('canvas');
  tagCanvas.width = TAG_W * TAG_COLS; tagCanvas.height = TAG_H * (MAXP / TAG_COLS);
  const tagCtx = tagCanvas.getContext('2d');
  const tagTex = new THREE.CanvasTexture(tagCanvas);
  tagTex.colorSpace = THREE.SRGBColorSpace; tagTex.generateMipmaps = false; tagTex.minFilter = THREE.LinearFilter;
  let tagDirty = false;
  const tagPos = new Float32Array(MAXP * 12);
  const tagCol = new Float32Array(MAXP * 16).fill(1);       // rgba per vertex; a = fade
  const tagAlpha = new Float32Array(MAXP);
  const tagGeo = new THREE.BufferGeometry();
  tagGeo.setAttribute('position', new THREE.BufferAttribute(tagPos, 3).setUsage(THREE.DynamicDrawUsage));
  tagGeo.setAttribute('color', new THREE.BufferAttribute(tagCol, 4).setUsage(THREE.DynamicDrawUsage));
  {
    const uv = new Float32Array(MAXP * 8), idx = new Uint16Array(MAXP * 6);
    const rows = MAXP / TAG_COLS;
    for (let i = 0; i < MAXP; i++) {
      const col = i % TAG_COLS, row = (i / TAG_COLS) | 0;
      const u0 = col / TAG_COLS, u1 = (col + 1) / TAG_COLS, v1 = 1 - row / rows, v0 = 1 - (row + 1) / rows;
      uv.set([u0, v0, u1, v0, u1, v1, u0, v1], i * 8);
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    tagGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    tagGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  const tagMesh = new THREE.Mesh(tagGeo, new THREE.MeshBasicMaterial({ map: tagTex, vertexColors: true, transparent: true, depthWrite: false, depthTest: false, fog: false }));
  tagMesh.frustumCulled = false; tagMesh.renderOrder = 5;
  scene.add(tagMesh);

  function drawTag(i, p, rel) {
    const col = i % TAG_COLS, row = (i / TAG_COLS) | 0, x = col * TAG_W, y = row * TAG_H;
    tagCtx.clearRect(x, y, TAG_W, TAG_H);
    const name = String(p.name || ('Player ' + p.id)).slice(0, 16);
    tagCtx.font = '700 24px system-ui, -apple-system, "Segoe UI", sans-serif';
    tagCtx.textAlign = 'center'; tagCtx.textBaseline = 'middle';
    const w = Math.min(TAG_W - 6, tagCtx.measureText(name).width + 26);
    const px = x + (TAG_W - w) / 2, py = y + 3, ph = TAG_H - 6;
    tagCtx.fillStyle = 'rgba(8,13,26,0.62)';
    tagCtx.beginPath(); tagCtx.roundRect(px, py, w, ph, 9); tagCtx.fill();
    const h = (Math.abs(p.id) * 0.61803398875) % 1;
    tagCtx.fillStyle = rel === 1 ? FRIEND_CSS : rel === 2 ? ENEMY_CSS : 'hsl(' + Math.round(h * 360) + ',85%,62%)';
    tagCtx.fillRect(px + 9, py + ph - 3, w - 18, 2);
    tagCtx.fillStyle = '#fff';
    tagCtx.fillText(name, x + TAG_W / 2, py + ph / 2 - 1, TAG_W - 30);
    tagDirty = true;
  }

  // Is the straight segment (ox,oy,oz)->(tx,ty,tz) free of map boxes? (slab test over the flat box list)
  function segClear(ox, oy, oz, tx, ty, tz) {
    const dx = tx - ox, dy = ty - oy, dz = tz - oz;
    for (let i = 0; i < nBoxes; i++) {
      const o = i * 6;
      let t0 = 0, t1 = 1;
      if (Math.abs(dx) < 1e-9) { if (ox < flatBoxes[o] || ox > flatBoxes[o + 3]) continue; }
      else {
        let a = (flatBoxes[o] - ox) / dx, b = (flatBoxes[o + 3] - ox) / dx;
        if (a > b) { const t = a; a = b; b = t; }
        if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) continue;
      }
      if (Math.abs(dy) < 1e-9) { if (oy < flatBoxes[o + 1] || oy > flatBoxes[o + 4]) continue; }
      else {
        let a = (flatBoxes[o + 1] - oy) / dy, b = (flatBoxes[o + 4] - oy) / dy;
        if (a > b) { const t = a; a = b; b = t; }
        if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) continue;
      }
      if (Math.abs(dz) < 1e-9) { if (oz < flatBoxes[o + 2] || oz > flatBoxes[o + 5]) continue; }
      else {
        let a = (flatBoxes[o + 2] - oz) / dz, b = (flatBoxes[o + 5] - oz) / dz;
        if (a > b) { const t = a; a = b; b = t; }
        if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) continue;
      }
      if (t0 < 0.985) return false;
    }
    return true;
  }

  // ---- tracers: one dynamic ribbon mesh ----
  const MAXT = 24;
  const tr = {
    a: new Float32Array(MAXT * 3), d: new Float32Array(MAXT * 3), dist: new Float32Array(MAXT),
    age: new Float32Array(MAXT), life: new Float32Array(MAXT), len: new Float32Array(MAXT),
    width: new Float32Array(MAXT), cr: new Float32Array(MAXT), cg: new Float32Array(MAXT), cb: new Float32Array(MAXT), local: new Uint8Array(MAXT), on: new Uint8Array(MAXT), next: 0,
  };
  const trPos = new Float32Array(MAXT * 12), trCol = new Float32Array(MAXT * 12);
  const trGeo = new THREE.BufferGeometry();
  trGeo.setAttribute('position', new THREE.BufferAttribute(trPos, 3).setUsage(THREE.DynamicDrawUsage));
  trGeo.setAttribute('color', new THREE.BufferAttribute(trCol, 3).setUsage(THREE.DynamicDrawUsage));
  {
    const idx = new Uint16Array(MAXT * 6);
    for (let i = 0; i < MAXT; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
    trGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  const trMesh = new THREE.Mesh(trGeo, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
  }));
  trMesh.frustumCulled = false; trMesh.renderOrder = 6;
  scene.add(trMesh);

  // ---- impact sparks: one Points object ----
  const MAXS = 256;
  const sp = {
    pos: new Float32Array(MAXS * 3), col: new Float32Array(MAXS * 3), vel: new Float32Array(MAXS * 3),
    base: new Float32Array(MAXS * 3), life: new Float32Array(MAXS), life0: new Float32Array(MAXS), next: 0,
  };
  for (let i = 0; i < MAXS; i++) sp.pos[i * 3 + 1] = -500;
  const spGeo = new THREE.BufferGeometry();
  spGeo.setAttribute('position', new THREE.BufferAttribute(sp.pos, 3).setUsage(THREE.DynamicDrawUsage));
  spGeo.setAttribute('color', new THREE.BufferAttribute(sp.col, 3).setUsage(THREE.DynamicDrawUsage));
  const spMesh = new THREE.Points(spGeo, new THREE.PointsMaterial({
    size: 0.11, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  spMesh.frustumCulled = false; spMesh.renderOrder = 7;
  scene.add(spMesh);

  // ---- spawn-protection shimmer: one instanced translucent ellipsoid per protected player ----
  const shieldMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({
    color: 0x9fe8ff, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }), MAXP);
  shieldMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shieldMesh.frustumCulled = false; shieldMesh.renderOrder = 3; shieldMesh.count = 0; shieldMesh.visible = false;
  scene.add(shieldMesh);

  // ---- objectives: flags + stands (one instanced mesh), the hardpoint zone (a translucent box and 12 edge bars) ----
  const OBJ_N = 6;                       // 2 stand pads + 2 x (pole, cloth)
  const objMesh = new THREE.InstancedMesh(unitBox, new THREE.MeshLambertMaterial({ vertexColors: false }), OBJ_N);
  objMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  objMesh.frustumCulled = false; objMesh.visible = false;
  for (let i = 0; i < OBJ_N; i++) objMesh.setColorAt(i, _col.setHex(0xffffff));
  scene.add(objMesh);
  const zoneFill = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide, fog: false,
  }));
  zoneFill.frustumCulled = false; zoneFill.renderOrder = 4; zoneFill.visible = false;
  scene.add(zoneFill);
  const edgeMesh = new THREE.InstancedMesh(unitBox, new THREE.MeshBasicMaterial({ fog: false }), 12);
  edgeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  edgeMesh.frustumCulled = false; edgeMesh.visible = false;
  for (let i = 0; i < 12; i++) edgeMesh.setColorAt(i, _col.setHex(0xffffff));
  scene.add(edgeMesh);
  const _qy = new THREE.Quaternion(), UP = new THREE.Vector3(0, 1, 0);
  function putObj(idx, px, py, pz, yaw, sx, sy, sz) {
    _v.set(px, py, pz); _qy.setFromAxisAngle(UP, yaw); _s.set(sx, sy, sz);
    _m.compose(_v, _qy, _s); objMesh.setMatrixAt(idx, _m);
  }
  let zoneKey = '';
  const ZONE_CONTEST = 0xffd23a;
  function updateObjective(obj, time, frame) {
    const flags = obj && obj.flags, hp = obj && obj.hardpoint;
    const mf = curMap && curMap.flags;
    const showFlags = !!(flags && mf);
    objMesh.visible = showFlags;
    if (showFlags) {
      for (let k = 0; k < 2; k++) {
        const t = k === 0 ? 'a' : 'b';
        const rel = teamRel(t, obj.myTeam);
        const hex = rel === 1 ? FRIEND_HEX : ENEMY_HEX;
        const sp = mf[t], f = flags[t];
        putObj(k, sp[0], sp[1] + 0.03, sp[2], 0, 1.9, 0.06, 1.9);
        objMesh.setColorAt(k, _col.setHex(hex).multiplyScalar(0.8));
        let px = sp[0], py = sp[1], pz = sp[2], yaw = 0, h = 2.2, w = 0.86;
        if (f.state === 'dropped') { px = f.pos[0]; py = f.pos[1]; pz = f.pos[2]; h = 1.9; }
        else if (f.state === 'carried') {
          let cy = null, hide = false;
          if (f.carrier === obj.selfId) hide = true;            // never in your own face
          else for (let i = 0; i < frame.players.length; i++) if (frame.players[i].id === f.carrier) { cy = frame.players[i].yaw; break; }
          if (hide || cy === null) { px = py = pz = 0; h = 0.0001; w = 0.0001; }
          else {
            yaw = cy; h = 1.5; w = 0.7;
            px = f.pos[0] + Math.sin(cy) * 0.36; py = f.pos[1] + 0.25; pz = f.pos[2] + Math.cos(cy) * 0.36;
          }
        }
        const wave = Math.sin(time * 3 + k * 1.7) * 0.28;
        const a = yaw + wave;
        putObj(2 + k * 2, px, py + h / 2, pz, yaw, 0.08, h, 0.08);
        objMesh.setColorAt(2 + k * 2, _col.setHex(0xe8edf5));
        putObj(3 + k * 2, px + Math.cos(a) * w * 0.5, py + h - 0.34, pz - Math.sin(a) * w * 0.5, a, w, 0.55, 0.05);
        objMesh.setColorAt(3 + k * 2, _col.setHex(hex));
      }
      objMesh.instanceMatrix.needsUpdate = true;
      objMesh.instanceColor.needsUpdate = true;
    }
    zoneFill.visible = edgeMesh.visible = !!hp;
    if (hp) {
      const key = hp.min.join(',') + '|' + hp.max.join(',') + '|' + hp.owner + '|' + obj.myTeam;
      if (key !== zoneKey) {
        zoneKey = key;
        const x0 = hp.min[0], y0 = hp.min[1], z0 = hp.min[2], x1 = hp.max[0], y1 = hp.max[1], z1 = hp.max[2];
        const hex = hp.owner === 'a' || hp.owner === 'b' ? (teamRel(hp.owner, obj.myTeam) === 1 ? FRIEND_HEX : ENEMY_HEX)
          : hp.owner === 'contested' ? ZONE_CONTEST : 0xffffff;
        zoneFill.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
        zoneFill.scale.set(x1 - x0, y1 - y0, z1 - z0);
        zoneFill.material.color.setHex(hex);
        const T = 0.09;
        let n = 0;
        const bar = (cx, cy, cz, sx, sy, sz) => { _v.set(cx, cy, cz); _s.set(sx, sy, sz); _m.compose(_v, QID, _s); edgeMesh.setMatrixAt(n, _m); edgeMesh.setColorAt(n, _col.setHex(hex)); n++; };
        for (const y of [y0, y1]) for (const z of [z0, z1]) bar((x0 + x1) / 2, y, z, x1 - x0 + T, T, T);
        for (const y of [y0, y1]) for (const x of [x0, x1]) bar(x, y, (z0 + z1) / 2, T, T, z1 - z0 + T);
        for (const x of [x0, x1]) for (const z of [z0, z1]) bar(x, (y0 + y1) / 2, z, T, y1 - y0, T);
        edgeMesh.instanceMatrix.needsUpdate = true;
        edgeMesh.instanceColor.needsUpdate = true;
      }
      zoneFill.material.opacity = 0.11 + 0.05 * Math.sin(time * 3);
    }
  }

  // ---- viewmodel scene ----
  const vmScene = new THREE.Scene();
  const vmCam = new THREE.PerspectiveCamera(62, 1, 0.02, 6);
  vmScene.add(new THREE.HemisphereLight(0xe6f2ff, 0x8d8670, 2.0));
  const vmSun = new THREE.DirectionalLight(0xfff0d0, 2.2);
  vmSun.position.set(0.5, 1, 0.6);
  vmScene.add(vmSun);
  const vmRoot = new THREE.Group();
  vmScene.add(vmRoot);
  const vmMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const flashTex = flashTexture();
  const flashMat = new THREE.MeshBasicMaterial({
    map: flashTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, opacity: 0,
  });
  const flashGeo = new THREE.PlaneGeometry(1, 1);
  // One viewmodel per (gun, attachment mask) in use, built on first need (4 meshes: body, mag, pump,
  // flash). At most VM_KEEP stay cached; older ones lose their geometry.
  const VM_KEEP = 8;
  const vmCache = new Map();
  function getVm(key) {
    let v = vmCache.get(key);
    if (v) { vmCache.delete(key); vmCache.set(key, v); return v; }     // refresh LRU order
    const def = buildViewmodel(key >> 6, key & 63);
    const group = new THREE.Group();
    const body = new THREE.Mesh(partsGeometry(def.body), vmMat);
    group.add(body);
    const mag = def.mag ? new THREE.Mesh(partsGeometry(def.mag), vmMat) : null;
    if (mag) group.add(mag);
    const pump = def.pump ? new THREE.Mesh(partsGeometry(def.pump), vmMat) : null;
    if (pump) group.add(pump);
    const flash = new THREE.Mesh(flashGeo, flashMat.clone());
    flash.position.set(def.muzzle[0], def.muzzle[1], def.muzzle[2] - 0.04);
    flash.visible = false; flash.renderOrder = 10;
    group.add(flash);
    group.visible = false;
    vmRoot.add(group);
    v = { key, def, group, body, mag, pump, flash };
    vmCache.set(key, v);
    if (vmCache.size > VM_KEEP) {
      for (const [k, old] of vmCache) {
        if (k === key || k === vmKey) continue;
        vmRoot.remove(old.group);
        old.body.geometry.dispose(); if (old.mag) old.mag.geometry.dispose(); if (old.pump) old.pump.geometry.dispose();
        old.flash.material.dispose();
        vmCache.delete(k);
        break;
      }
    }
    return v;
  }

  // ---- state ----
  let baseFov = 90, W = 1, H = 1;
  let vmKey = 0, vmLower = 0;       // viewmodel on screen (gun * 64 + mask) and how far it is lowered (0 up .. 1 away)
  let recoil = 0, camKick = 0, flashLeft = 0, flashScale = 1, flashRotZ = 0, flashKey = 0, cycleT = 9, cycleDur = 0.5;
  let sway = 0, swayP = 0, prevYaw = 0, prevPitch = 0, havePrev = false;
  let bobPhase = 0, reloadSm = 0, slideSmL = 0;
  let prevGround = true, lastAirVy = 0, dip = 0, roll = 0, fovKick = 0, deadTime = 0, lastAds = 0;
  let frameNo = 0;

  const rr = new THREE.Vector3(), ru = new THREE.Vector3(), rf = new THREE.Vector3();

  function resize(w, h) {
    W = Math.max(1, w | 0); H = Math.max(1, h | 0);
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(W, H, false);
    camera.aspect = W / H; camera.updateProjectionMatrix();
    vmCam.aspect = W / H; vmCam.updateProjectionMatrix();
  }
  function setFov(deg) { baseFov = deg; }
  let sparkMul = 1;
  function setQuality(q) {
    if (!PIXEL_CAP.desktop[q]) return;
    quality = q;
    sparkMul = q === 'low' ? 0.4 : q === 'medium' ? 0.7 : 1;
    skyline.visible = q !== 'low';
    clouds.visible = q !== 'low';
    shadows.visible = q !== 'low';
    resize(W, H);
  }
  function getQuality() { return quality; }

  // gun = gun id, mask = its attachment mask, fireSec = seconds until the next shot (drives pump / bolt)
  function localFire(gun, mask, fireSec) {
    const key = ((gun | 0) >= 0 && (gun | 0) < 6 ? (gun | 0) : 0) * 64 + ((mask | 0) & 63);
    const v = getVm(key);
    recoil = Math.min(recoil + 0.3 * v.def.recoil, 1.6);
    camKick += v.def.camKick;
    flashLeft = 0.055; flashKey = key;
    flashScale = v.def.flash * (0.8 + Math.random() * 0.5);
    flashRotZ = Math.random() * TAU;
    cycleT = 0; cycleDur = Math.max(0.12, +fireSec || 0.5);
  }
  function remoteFire(playerId) {
    for (let i = 0; i < slotCount; i++) if (slotId[i] === playerId) { flashT[i] = 0.06; flashRot[i] = Math.random(); return; }
  }
  function tracer(from, to, opts) {
    const st = TRACER_STYLE[opts && opts.gun >= 0 && opts.gun < 6 ? opts.gun | 0 : 0];
    const i = tr.next; tr.next = (i + 1) % MAXT;
    const local = !!(opts && opts.local);
    let ax = from[0], ay = from[1], az = from[2];
    if (local) { // start at the viewmodel muzzle instead of the eye
      const k = 1 - lastAds * 0.85, e = camera.matrixWorld.elements;
      ax += (e[0] * 0.15 - e[4] * 0.14 - e[8] * 0.6) * k; ay += (e[1] * 0.15 - e[5] * 0.14 - e[9] * 0.6) * k; az += (e[2] * 0.15 - e[6] * 0.14 - e[10] * 0.6) * k;
    }
    let dx = to[0] - ax, dy = to[1] - ay, dz = to[2] - az;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.3) return;
    const inv = 1 / dist;
    tr.a[i * 3] = ax; tr.a[i * 3 + 1] = ay; tr.a[i * 3 + 2] = az;
    tr.d[i * 3] = dx * inv; tr.d[i * 3 + 1] = dy * inv; tr.d[i * 3 + 2] = dz * inv;
    tr.dist[i] = dist; tr.age[i] = 0; tr.len[i] = Math.min(9 * st[1], dist);
    tr.cr[i] = st[2]; tr.cg[i] = st[3]; tr.cb[i] = st[4];
    tr.life[i] = Math.min(0.3, (dist + tr.len[i]) / 380);
    tr.width[i] = (local ? 0.022 : 0.04) * st[0]; tr.local[i] = local ? 1 : 0; tr.on[i] = 1;
  }
  function impact(pos, normal, opts) {
    const flesh = !!(opts && opts.flesh);
    const n = Math.max(2, Math.round((flesh ? 10 : 8) * sparkMul));
    const nx = normal ? normal[0] : 0, ny = normal ? normal[1] : 1, nz = normal ? normal[2] : 0;
    for (let k = 0; k < n; k++) {
      const i = sp.next; sp.next = (i + 1) % MAXS;
      const speed = 1.5 + Math.random() * 3.5;
      sp.pos[i * 3] = pos[0] + nx * 0.04; sp.pos[i * 3 + 1] = pos[1] + ny * 0.04; sp.pos[i * 3 + 2] = pos[2] + nz * 0.04;
      sp.vel[i * 3] = nx * speed + (Math.random() - 0.5) * 3;
      sp.vel[i * 3 + 1] = ny * speed + (Math.random() - 0.3) * 3;
      sp.vel[i * 3 + 2] = nz * speed + (Math.random() - 0.5) * 3;
      if (flesh) { sp.base[i * 3] = 1.0; sp.base[i * 3 + 1] = 0.1 + Math.random() * 0.1; sp.base[i * 3 + 2] = 0.1; }
      else { sp.base[i * 3] = 1.0; sp.base[i * 3 + 1] = 0.7 + Math.random() * 0.25; sp.base[i * 3 + 2] = 0.3; }
      sp.life[i] = sp.life0[i] = (flesh ? 0.45 : 0.3) + Math.random() * 0.3;
    }
  }

  // -------------------------------------------------------------------------------------------
  let overview = false, ovT = 0;
  function overviewCamera(dt) {
    ovT += dt;
    const a = ovT * 0.1;
    const r = mapHalf * 0.6, y = 8 + mapHalf * 0.26;
    const x = mapCx + Math.cos(a) * r, z = mapCz + Math.sin(a) * r;
    const dx = mapCx - x, dz = mapCz - z, dy = 1.5 - y;
    camera.fov = baseFov; camera.updateProjectionMatrix();
    camera.position.set(x, y, z);
    camera.rotation.set(Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0);
    camera.updateMatrixWorld(true);
    sky.position.copy(camera.position);
    clouds.position.set(camera.position.x, 0, camera.position.z);
  }
  function updateCamera(L, dt) {
    const yaw = L.yaw, pitch = L.pitch;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const hspeed = Math.hypot(L.vx, L.vz);
    lastAds = L.ads;

    if (L.alive) deadTime = 0; else deadTime += dt;

    // landing dip
    if (!L.onGround) lastAirVy = L.vy;
    else if (!prevGround) dip = -clamp(-lastAirVy * 0.014, 0, 0.22);
    prevGround = L.onGround;
    dip += (0 - dip) * Math.min(1, dt * 9);

    // strafe roll
    const strafe = L.vx * cy - L.vz * sy; // velocity . right
    const rollT = clamp(-strafe * 0.0028, -0.05, 0.05) + (L.sliding ? -0.035 : 0);
    roll += (rollT - roll) * Math.min(1, dt * 8);

    // fov: ads zoom + speed kick
    const kickT = L.alive ? clamp((hspeed - 7) / 9, 0, 1) * 7 * (1 - L.ads) + (L.sliding ? 2 : 0) : 0;
    fovKick += (kickT - fovKick) * Math.min(1, dt * 6);
    const ads = L.ads * L.ads * (3 - 2 * L.ads);
    camera.fov = lerp(baseFov, L.adsFov || baseFov, ads) + fovKick;
    camera.updateProjectionMatrix();

    camKick *= Math.exp(-dt * 10);

    // head bob (world camera)
    let bx = 0, by = 0;
    if (L.onGround && hspeed > 1 && !L.sliding && L.alive) {
      bobPhase += hspeed * dt * 1.25;
      const f = Math.min(hspeed / 7, 1) * (1 - L.ads * 0.9);
      by = Math.sin(bobPhase * 2) * 0.014 * f; bx = Math.cos(bobPhase) * 0.008 * f;
    }

    let ex = L.x + cy * bx, ey = L.y + L.eyeHeight + by + dip, ez = L.z - sy * bx;
    let pr = pitch + camKick, rl = roll;
    if (!L.alive) {
      const t = Math.min(1, deadTime * 2.2), e = 1 - (1 - t) * (1 - t);
      ey = L.y + lerp(L.eyeHeight, 0.28, e);
      rl = lerp(roll, 0.85, e);
      pr = lerp(pitch, -0.35, e);
      camera.fov = lerp(camera.fov, baseFov + 8, e);
      camera.updateProjectionMatrix();
    }
    camera.position.set(ex, ey, ez);
    camera.rotation.set(clamp(pr, -1.55, 1.55), yaw, rl);
    camera.updateMatrixWorld(true);
    sky.position.copy(camera.position);
    clouds.position.set(camera.position.x, 0, camera.position.z);
  }

  let curVm = null;
  function updateViewmodel(L, dt) {
    const g = (L.gun | 0) >= 0 && (L.gun | 0) < 6 ? L.gun | 0 : 0;
    const wantKey = g * 64 + ((L.att | 0) & 63);
    // weapon swap: lower the old gun, then raise the new one; durations come from the kit (swap ticks)
    const swapDur = Math.max(0.16, +L.swapDur || 0.3);
    if (!L.alive) { vmKey = wantKey; vmLower = 0; }
    else if (vmKey !== wantKey) {
      vmLower += dt / (0.4 * swapDur);
      if (vmLower >= 1) { vmLower = 1; vmKey = wantKey; }
    } else if (vmLower > 0) vmLower = Math.max(0, vmLower - dt / (0.6 * swapDur));

    const v = curVm && curVm.key === vmKey ? curVm : getVm(vmKey), def = v.def;
    if (curVm !== v) {
      if (curVm) { curVm.group.visible = false; curVm.flash.visible = false; }
      v.group.visible = true; curVm = v;
      cycleT = 9;
    }
    const hidden = !L.alive || (L.scopeKind > 0 && L.ads > 0.6 && !L.reloading);
    vmRoot.visible = !hidden;

    // look sway (lags behind view rotation)
    if (!havePrev) { prevYaw = L.yaw; prevPitch = L.pitch; havePrev = true; }
    let dy = L.yaw - prevYaw; dy -= Math.round(dy / TAU) * TAU;
    const dp = L.pitch - prevPitch;
    prevYaw = L.yaw; prevPitch = L.pitch;
    const inv = dt > 1e-4 ? 1 / dt : 0;
    const k = Math.min(1, dt * 10);
    sway += (clamp(dy * inv * 0.012, -0.06, 0.06) - sway) * k;
    swayP += (clamp(dp * inv * 0.01, -0.05, 0.05) - swayP) * k;

    const ads = L.ads * L.ads * (3 - 2 * L.ads);
    const hspeed = Math.hypot(L.vx, L.vz);
    const moving = L.onGround && !L.sliding ? Math.min(hspeed / 7, 1) : 0;
    const bobAmt = (moving * 1 + (L.onGround ? 0 : 0.0)) * (1 - ads * 0.92);
    const bp = bobPhase;
    slideSmL += ((L.sliding ? 1 : 0) - slideSmL) * Math.min(1, dt * 9);

    // reload progress 0..1 comes from the weapon state (so it follows this gun's / attachments' reload time)
    const rp = L.reloading ? clamp(L.reloadP || 0, 0, 1) : 0;
    reloadSm += ((L.reloading ? 1 : 0) - reloadSm) * Math.min(1, dt * 9);

    recoil *= Math.exp(-dt * 11);
    cycleT += dt;

    const air = L.onGround ? 0 : clamp(L.vy * 0.004, -0.03, 0.03);
    let px = lerp(def.hip[0], def.ads[0], ads) + sway + Math.cos(bp) * 0.008 * bobAmt - slideSmL * 0.06;
    let py = lerp(def.hip[1], def.ads[1], ads) - swayP + Math.abs(Math.sin(bp)) * 0.014 * bobAmt - air - reloadSm * 0.14 - vmLower * 0.3 - slideSmL * 0.04;
    let pz = lerp(def.hip[2], def.ads[2], ads) + recoil * 0.05 * (1 - ads * 0.5);
    vmRoot.position.set(px, py, pz);
    vmRoot.rotation.set(
      recoil * 0.1 * (1 - ads * 0.5) - reloadSm * 0.45 - vmLower * 0.9 + swayP * 1.5,
      -sway * 1.6 + slideSmL * 0.15,
      sway * 1.2 + reloadSm * 0.35 + slideSmL * 0.45 + Math.sin(bp) * 0.012 * bobAmt,
    );

    // magazine / drum comes out and goes back in; shotgun shells jiggle one by one
    if (v.mag) {
      if (def.style === 'shell') v.mag.position.set(0, Math.sin(rp * 5 * TAU) * 0.012 * reloadSm, 0);
      else {
        const t = clamp((rp - 0.2) / 0.55, 0, 1);
        v.mag.position.set(0, -Math.sin(t * Math.PI) * 0.16 * (rp > 0 ? 1 : 0), 0);
      }
    }
    // pump forend / bolt handle: slides during the fire cycle, works again at the end of a reload
    if (v.pump) {
      const p = clamp(cycleT / cycleDur, 0, 1);
      let slide = 0;
      if (cycleT < cycleDur) slide = def.cyc === 'bolt' ? Math.sin(clamp((p - 0.12) / 0.62, 0, 1) * Math.PI) * 0.075 : Math.sin(clamp((p - 0.2) / 0.6, 0, 1) * Math.PI) * 0.1;
      if (rp > 0) slide += def.cyc === 'bolt' ? Math.sin(clamp((rp - 0.82) / 0.16, 0, 1) * Math.PI) * 0.075 : Math.sin(rp * 5 * TAU) * 0.03;
      v.pump.position.z = slide;
    }

    // muzzle flash
    if (flashLeft > 0) {
      flashLeft -= dt;
      if (flashKey === vmKey) {
        v.flash.visible = true;
        v.flash.material.opacity = clamp(flashLeft / 0.055, 0, 1);
        v.flash.scale.set(flashScale, flashScale, 1);
        v.flash.rotation.z = flashRotZ;
      }
    } else if (v.flash.visible) v.flash.visible = false;
  }

  function updateCharacters(frame, dt) {
    const players = frame.players;
    const n = Math.min(players ? players.length : 0, MAXP);
    slotCount = n;
    const k = 1 - Math.exp(-dt * 14);
    let shieldN = 0;
    const ce = camera.matrixWorld.elements;
    const camX = ce[12], camY = ce[13], camZ = ce[14];
    rr.set(ce[0], ce[1], ce[2]); ru.set(ce[4], ce[5], ce[6]);
    const tanHalfFov = Math.tan(camera.fov * Math.PI / 360);

    for (let i = 0; i < n; i++) {
      const p = players[i];
      if (slotId[i] !== p.id) assignSlot(i, p);
      const rel = teamMode ? teamRel(p.team, viewerTeam) : 0;
      if (slotRel[i] !== rel) paintChar(i, p, rel);
      const gkey = ((p.gun | 0) >= 0 && (p.gun | 0) < 6 ? (p.gun | 0) : 0) * 64 + ((p.att | 0) & 63);
      if (slotWeapon[i] !== gkey) setWeaponLook(i, gkey);
      if (slotName[i] !== p.name) { slotName[i] = p.name; drawTag(i, p, rel); }

      crouchSm[i] += ((p.crouching ? 1 : 0) - crouchSm[i]) * k;
      slideSm[i] += ((p.sliding ? 1 : 0) - slideSm[i]) * k;
      const dx = p.x - prevX[i], dz = p.z - prevZ[i];
      prevX[i] = p.x; prevZ[i] = p.z;
      let sp2 = dt > 1e-4 ? Math.hypot(dx, dz) / dt : 0;
      if (sp2 > 40) sp2 = 0;
      speedSm[i] += (sp2 - speedSm[i]) * Math.min(1, dt * 10);
      phase[i] += speedSm[i] * dt * 1.7;
      if (p.alive) deadT[i] = 0; else deadT[i] += dt;
      flashT[i] = Math.max(0, flashT[i] - dt);

      const sl = slideSm[i], cr = crouchSm[i] * (1 - sl);
      const lean = 0.65 * cr - 0.95 * sl;
      const hipY = 0.85 - 0.47 * cr - 0.57 * sl;
      const fall = p.alive ? 0 : (1 - Math.pow(1 - Math.min(1, deadT[i] / 0.55), 2)) * 1.5;
      const swing = Math.sin(phase[i]) * 0.9 * Math.min(speedSm[i] / 6, 1) * (1 - sl);

      _v.set(p.x, p.y + fall * 0.1, p.z); _e.set(fall, p.yaw, 0, 'YXZ'); _q.setFromEuler(_e);
      mRoot.compose(_v, _q, ONE);

      const b = i * PARTS;
      // legs
      const legLen = hipY;
      pivot(mP, mRoot, -0.14, hipY, 0, swing + 1.15 * sl, 0);
      put(b + P_LEGL, mP, 0, -legLen / 2, 0, 0.2, legLen, 0.26);
      pivot(mP, mRoot, 0.14, hipY, 0, -swing + 1.15 * sl, 0);
      put(b + P_LEGR, mP, 0, -legLen / 2, 0, 0.2, legLen, 0.26);

      // torso frame
      pivot(mTorso, mRoot, 0, hipY, 0, -lean, 0);
      put(b + P_TORSO, mTorso, 0, 0.3, 0, 0.46, 0.6, 0.26);
      put(b + P_PACK, mTorso, 0, 0.34, 0.19, 0.3, 0.38, 0.12);
      // head
      pivot(mP, mTorso, 0, 0.62, 0, p.pitch * 0.9 + lean, 0);
      put(b + P_HEAD, mP, 0, 0.18, 0, 0.34, 0.34, 0.34);
      put(b + P_VISOR, mP, 0, 0.2, -0.18, 0.28, 0.11, 0.03);
      // arms + weapon
      const armRx = Math.PI / 2 + p.pitch + lean - 0.05;
      pivot(mP, mTorso, 0.32, 0.52, 0, armRx, 0);
      put(b + P_ARMR, mP, 0, -0.26, 0, 0.13, 0.52, 0.13);
      // gun boxes in the arm frame: forward = -y (distance gf from the shoulder), up = -z
      const t = slotThird[i] || buildThird(0, 0);
      for (let k = 0; k < TP_PARTS; k++) {
        const g = t.parts[k];
        if (g) put(b + P_GUN + k, mP, g[0] - 0.1, -g[2], -g[1] - 0.02, g[3], g[5], g[4]);
        else put(b + P_GUN + k, mP, 0, 0, 0, 0.0001, 0.0001, 0.0001);
      }
      const fs = flashT[i] > 0 ? (0.18 + flashRot[i] * 0.14) : 0.0001;
      put(b + P_FLASH, mP, -0.1, -(t.muzzle + 0.1), -0.02, fs, fs, fs);
      pivot(mP, mTorso, -0.32, 0.52, 0, armRx, -1.0);
      put(b + P_ARML, mP, 0, -0.26, 0, 0.13, 0.52, 0.13);

      // blob shadow
      const gy = groundBelow(p.x, p.y, p.z);
      const gap = p.y - gy, ss = p.alive ? Math.max(0.2, 1 - Math.min(gap, 6) / 7) * (1 + sl * 0.2) : 0.001;
      _v.set(p.x, gy + 0.03, p.z); _s.set(ss, 1, ss);
      _m.compose(_v, QID, _s);
      shadows.setMatrixAt(i, _m);
      if (p.protected && p.alive) {
        const pul = 1 + 0.05 * Math.sin(frame.time * 9 + i);
        _v.set(p.x, p.y + 0.95, p.z); _s.set(0.8 * pul, 1.15 * pul, 0.8 * pul); _m.compose(_v, QID, _s);
        shieldMesh.setMatrixAt(shieldN++, _m);
      }

      // name tag (constant screen size, distance fade, wall + death hiding)
      {
        const o = i * 12, oc = i * 16;
        const headTop = p.y + 1.8 - 0.7 * cr - 0.9 * sl;
        const dxc = p.x - camX, dyc = headTop - camY, dzc = p.z - camZ;
        const dist = Math.hypot(dxc, dyc, dzc);
        const depth = -(dxc * ce[8] + dyc * ce[9] + dzc * ce[10]);   // distance along the view direction
        let target = 0;
        if (p.alive && depth > 0.6 && dist < TAG_FADE_FAR) {
          target = dist <= TAG_FADE_NEAR ? 1 : 1 - (dist - TAG_FADE_NEAR) / (TAG_FADE_FAR - TAG_FADE_NEAR);
          if (rel === 1) tagVis[i] = 1;                              // teammates stay visible through walls
          else if (frameNo % 3 === i % 3 || tagVis[i] < 0) {         // occlusion test every 3rd frame per player
            tagVis[i] = (segClear(camX, camY, camZ, p.x, headTop + 0.15, p.z) || segClear(camX, camY, camZ, p.x, headTop - 0.2, p.z)) ? 1 : 0;
          }
          if (!tagVis[i]) target = 0;
        } else tagVis[i] = -1;
        const ka = target > tagAlpha[i] ? 1 - Math.exp(-dt * 18) : 1 - Math.exp(-dt * 10);
        tagAlpha[i] += (target - tagAlpha[i]) * ka;
        if (tagAlpha[i] < 0.02) { tagAlpha[i] = 0; tagPos.fill(0, o, o + 12); }
        else {
          const wpp = (2 * Math.max(depth, 0.6) * tanHalfFov) / H;     // world metres per CSS pixel at this depth
          const hw = TAG_W * TAG_PX * 0.5 * wpp, hh = TAG_H * TAG_PX * wpp;
          // bottom edge sits 6 px above the head, so the tag never overlaps the body
          const bx = p.x + ru.x * 6 * wpp, by = headTop + 0.1 + ru.y * 6 * wpp, bz = p.z + ru.z * 6 * wpp;
          tagPos[o] = bx - rr.x * hw;            tagPos[o + 1] = by - rr.y * hw;            tagPos[o + 2] = bz - rr.z * hw;
          tagPos[o + 3] = bx + rr.x * hw;        tagPos[o + 4] = by + rr.y * hw;            tagPos[o + 5] = bz + rr.z * hw;
          tagPos[o + 6] = bx + rr.x * hw + ru.x * hh; tagPos[o + 7] = by + rr.y * hw + ru.y * hh; tagPos[o + 8] = bz + rr.z * hw + ru.z * hh;
          tagPos[o + 9] = bx - rr.x * hw + ru.x * hh; tagPos[o + 10] = by - rr.y * hw + ru.y * hh; tagPos[o + 11] = bz - rr.z * hw + ru.z * hh;
        }
        const al = tagAlpha[i];
        tagCol[oc + 3] = al; tagCol[oc + 7] = al; tagCol[oc + 11] = al; tagCol[oc + 15] = al;
      }
    }
    for (let i = n; i < MAXP; i++) {
      if (slotId[i] !== -1) { slotId[i] = -1; slotName[i] = ''; slotWeapon[i] = -1; slotThird[i] = null; slotRel[i] = -2; }
    }
    // free the leftover slots visually
    tagPos.fill(0, n * 12);
    for (let i = n; i < MAXP; i++) { tagAlpha[i] = 0; tagVis[i] = -1; }
    chars.count = n * PARTS;
    shadows.count = n;
    shieldMesh.count = shieldN; shieldMesh.visible = shieldN > 0;
    if (shieldN > 0) { shieldMesh.instanceMatrix.needsUpdate = true; shieldMesh.material.opacity = 0.2 + 0.1 * Math.sin(frame.time * 8); }
    chars.instanceMatrix.needsUpdate = true;
    shadows.instanceMatrix.needsUpdate = true;
    tagGeo.attributes.position.needsUpdate = true;
    tagGeo.attributes.color.needsUpdate = true;
    if (tagDirty) { tagTex.needsUpdate = true; tagDirty = false; }
  }

  function updateTracers(dt) {
    const ce = camera.matrixWorld.elements;
    const cx = ce[12], cy = ce[13], cz = ce[14];
    for (let i = 0; i < MAXT; i++) {
      const o = i * 12;
      if (!tr.on[i]) { if (trPos[o] !== 0 || trPos[o + 1] !== 0) trPos.fill(0, o, o + 12); continue; }
      tr.age[i] += dt;
      const head = Math.min(tr.dist[i], 380 * tr.age[i]);
      const tail = Math.max(0, 380 * tr.age[i] - tr.len[i]);
      if (tail >= tr.dist[i] || tr.age[i] > tr.life[i] + 0.05) { tr.on[i] = 0; trPos.fill(0, o, o + 12); continue; }
      const ax = tr.a[i * 3], ay = tr.a[i * 3 + 1], az = tr.a[i * 3 + 2];
      const dx = tr.d[i * 3], dy = tr.d[i * 3 + 1], dz = tr.d[i * 3 + 2];
      const hx = ax + dx * head, hy = ay + dy * head, hz = az + dz * head;
      const tx = ax + dx * tail, ty = ay + dy * tail, tz = az + dz * tail;
      // ribbon side = dir x (mid - cam)
      const mx = (hx + tx) * 0.5 - cx, my = (hy + ty) * 0.5 - cy, mz = (hz + tz) * 0.5 - cz;
      let sx = dy * mz - dz * my, sy = dz * mx - dx * mz, sz = dx * my - dy * mx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      const w = tr.width[i] * (0.5 + 0.5 * Math.min(1, Math.hypot(mx, my, mz) / 8)) * 0.5 / sl;
      sx *= w; sy *= w; sz *= w;
      trPos[o] = tx - sx; trPos[o + 1] = ty - sy; trPos[o + 2] = tz - sz;
      trPos[o + 3] = tx + sx; trPos[o + 4] = ty + sy; trPos[o + 5] = tz + sz;
      trPos[o + 6] = hx - sx; trPos[o + 7] = hy - sy; trPos[o + 8] = hz - sz;
      trPos[o + 9] = hx + sx; trPos[o + 10] = hy + sy; trPos[o + 11] = hz + sz;
      const r = tr.cr[i], g = tr.cg[i] * (tr.local[i] ? 1.0 : 0.85), bl = tr.cb[i] * (tr.local[i] ? 1.0 : 0.8);
      trCol[o] = r * 0.05; trCol[o + 1] = g * 0.05; trCol[o + 2] = bl * 0.05;
      trCol[o + 3] = r * 0.05; trCol[o + 4] = g * 0.05; trCol[o + 5] = bl * 0.05;
      trCol[o + 6] = r; trCol[o + 7] = g; trCol[o + 8] = bl;
      trCol[o + 9] = r; trCol[o + 10] = g; trCol[o + 11] = bl;
    }
    trGeo.attributes.position.needsUpdate = true;
    trGeo.attributes.color.needsUpdate = true;
  }

  function updateSparks(dt) {
    for (let i = 0; i < MAXS; i++) {
      const l = sp.life[i];
      if (l <= 0) continue;
      const o = i * 3;
      const nl = l - dt;
      if (nl <= 0) {
        sp.life[i] = 0; sp.pos[o + 1] = -500; sp.col[o] = sp.col[o + 1] = sp.col[o + 2] = 0;
        continue;
      }
      sp.life[i] = nl;
      sp.vel[o + 1] -= 13 * dt;
      sp.pos[o] += sp.vel[o] * dt; sp.pos[o + 1] += sp.vel[o + 1] * dt; sp.pos[o + 2] += sp.vel[o + 2] * dt;
      const f = nl / sp.life0[i];
      sp.col[o] = sp.base[o] * f; sp.col[o + 1] = sp.base[o + 1] * f; sp.col[o + 2] = sp.base[o + 2] * f;
    }
    spGeo.attributes.position.needsUpdate = true;
    spGeo.attributes.color.needsUpdate = true;
  }

  const EMPTY_FRAME = { players: [], time: 0 };
  function render(frame) {
    if (frameNo === 0) renderer.info.reset();
    frameNo++;
    const dt = clamp(frame.dt || 0, 0, 0.1);
    if (overview) {
      overviewCamera(dt);
      vmRoot.visible = false;
      updateCharacters(EMPTY_FRAME, dt);
      updateObjective(null, frame.time, EMPTY_FRAME);
    } else {
      updateCamera(frame.local, dt);
      updateViewmodel(frame.local, dt);
      updateCharacters(frame, dt);
      updateObjective(frame.objective || null, frame.time, frame);
    }
    updateTracers(dt);
    updateSparks(dt);

    renderer.info.reset();
    renderer.clear();
    renderer.render(scene, camera);
    if (vmRoot.visible) {
      renderer.clearDepth();
      renderer.render(vmScene, vmCam);
    }
  }

  setMap(map);
  setQuality(quality);
  resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
  const _vs = new THREE.Vector3();
  function viewSpace(x, y, z, out) {
    _vs.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    out.x = _vs.x; out.y = _vs.y; out.z = _vs.z;
    return out;
  }
  function setTeamView(isTeamMode, myTeam) { teamMode = !!isTeamMode; viewerTeam = myTeam === 'a' || myTeam === 'b' ? myTeam : ''; }
  function setOverview(on) { overview = !!on; }

  return {
    resize, setFov, setQuality, getQuality, render, localFire, remoteFire, tracer, impact,
    setMap, setTeamView, setOverview, viewSpace,
    // optional extras
    getCamera: () => camera,
    tagDebug: () => Array.from(tagAlpha.subarray(0, slotCount)),
    stats: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
    memory: () => ({ geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, mapId: curMap ? curMap.id : '' }),
    renderer,
  };
}
