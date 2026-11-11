// Hopshot renderer: low-poly flat-shaded look, merged static map, instanced characters,
// pooled tracers / sparks, first-person box viewmodels. No allocations inside render().
//
// Draw calls (typical frame): sky 1, skyline 1, clouds 1, map 1, blob shadows 1, characters 1,
// name tags 1, tracers 1, sparks 1, viewmodel 3-4 (body, mag, pump, flash)  => about 13.

import * as THREE from 'three';
import { WEAPONS } from '../shared/weapons.js';

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

// parts: [cx, cy, cz, sx, sy, sz, hex]
function partsGeometry(parts) {
  const acc = newAcc();
  for (const p of parts) {
    addBox(acc, p[0] - p[3] / 2, p[1] - p[4] / 2, p[2] - p[5] / 2, p[0] + p[3] / 2, p[1] + p[4] / 2, p[2] + p[5] / 2, p[6], {});
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

// ---------------------------------------------------------------------------------------------
// Viewmodel part lists (model space: -Z forward, +X right, +Y up; origin on the sight line)
// ---------------------------------------------------------------------------------------------
const SKIN = 0xf0c8a0, SLEEVE = 0x2f4a73;
function arms(rz, lz) {
  return [
    [0.03, -0.13, rz, 0.075, 0.075, 0.085, SKIN],             // right glove (grip)
    [0.07, -0.2, rz + 0.3, 0.085, 0.085, 0.5, SLEEVE],        // right forearm
    [-0.02, -0.105, lz, 0.075, 0.07, 0.1, SKIN],              // left glove (fore-end)
    [-0.11, -0.19, lz + 0.3, 0.085, 0.085, 0.5, SLEEVE],      // left forearm
  ];
}

const VM_DEFS = [
  { // rifle
    body: [
      [0, -0.055, 0.0, 0.07, 0.07, 0.36, 0x39414f],
      [0, -0.095, -0.27, 0.06, 0.05, 0.22, 0xf28c38],
      [0, -0.048, -0.4, 0.026, 0.026, 0.3, 0x1c2029],
      [0, -0.012, -0.5, 0.012, 0.022, 0.012, 0x101318],
      [0, -0.012, 0.09, 0.034, 0.02, 0.012, 0x101318],
      [0, -0.033, 0.0, 0.03, 0.012, 0.26, 0x252a34],
      [0, -0.075, 0.3, 0.055, 0.1, 0.26, 0x39414f],
      [0, -0.14, 0.09, 0.05, 0.11, 0.05, 0x1c2029],
      ...arms(0.09, -0.26),
    ],
    mag: [[0, -0.16, -0.05, 0.05, 0.14, 0.075, 0xf2c744]],
    muzzle: [0, -0.048, -0.58], hip: [0.22, -0.2, -0.46], ads: [0, 0, -0.36],
    recoil: 1.0, camKick: 0.003, flash: 0.2,
  },
  { // scout
    body: [
      [0, -0.055, 0.0, 0.06, 0.07, 0.42, 0x5e4334],
      [0, -0.05, -0.54, 0.028, 0.028, 0.66, 0x1c2029],
      [0, -0.05, -0.9, 0.05, 0.05, 0.07, 0x2b303b],
      [0, 0.022, -0.02, 0.05, 0.05, 0.3, 0x20242d],      // scope tube
      [0, 0.022, -0.17, 0.062, 0.062, 0.04, 0x20242d],
      [0, 0.022, 0.14, 0.058, 0.058, 0.035, 0x20242d],
      [0, 0.022, -0.192, 0.045, 0.045, 0.006, 0x66ccff],
      [0, -0.012, -0.1, 0.02, 0.03, 0.03, 0x20242d],
      [0, -0.012, 0.08, 0.02, 0.03, 0.03, 0x20242d],
      [0.045, -0.035, 0.1, 0.05, 0.014, 0.014, 0xd9d9d9],  // bolt handle
      [0, -0.085, 0.36, 0.055, 0.12, 0.3, 0x5e4334],
      [0, -0.14, 0.1, 0.05, 0.1, 0.05, 0x1c2029],
      ...arms(0.1, -0.32),
    ],
    mag: [[0, -0.12, 0.0, 0.04, 0.07, 0.09, 0x2fb5a8]],
    muzzle: [0, -0.05, -0.96], hip: [0.23, -0.2, -0.42], ads: [0, -0.022, -0.3],
    recoil: 2.6, camKick: 0.02, flash: 0.3,
  },
  { // shotgun
    body: [
      [0, -0.065, 0.02, 0.08, 0.085, 0.38, 0x7a3b2a],
      [0, -0.036, -0.4, 0.05, 0.05, 0.52, 0x2a2f38],
      [0, -0.09, -0.36, 0.036, 0.036, 0.44, 0x3a3f48],
      [0, -0.006, -0.64, 0.012, 0.014, 0.012, 0xf2c744],
      [0, -0.088, 0.31, 0.062, 0.11, 0.26, 0x7a3b2a],
      [0, -0.145, 0.1, 0.05, 0.1, 0.05, 0x2a2f38],
      ...arms(0.1, -0.33),
    ],
    mag: [[0.06, -0.07, -0.02, 0.04, 0.04, 0.12, 0xe0483c], [0.06, -0.07, 0.1, 0.04, 0.04, 0.12, 0xe0483c]],
    pump: [[0, -0.1, -0.3, 0.075, 0.065, 0.17, 0xf28c38]],
    muzzle: [0, -0.036, -0.68], hip: [0.23, -0.21, -0.44], ads: [0, -0.012, -0.38],
    recoil: 2.2, camKick: 0.025, flash: 0.34,
  },
];

// Third-person weapon dims in the arm frame: body width/len/height, barrel width/len, colours.
const TP_WEAPONS = [
  { bw: 0.1, bl: 0.45, bh: 0.14, rw: 0.04, rl: 0.3, body: 0x39414f, barrel: 0x1c2029 },
  { bw: 0.08, bl: 0.55, bh: 0.12, rw: 0.035, rl: 0.5, body: 0x5e4334, barrel: 0x1c2029 },
  { bw: 0.12, bl: 0.45, bh: 0.15, rw: 0.06, rl: 0.35, body: 0x7a3b2a, barrel: 0x2a2f38 },
];

const PARTS = 11, MAXP = 32;
const P_LEGL = 0, P_LEGR = 1, P_TORSO = 2, P_HEAD = 3, P_VISOR = 4, P_ARML = 5, P_ARMR = 6,
  P_GUN = 7, P_BARREL = 8, P_PACK = 9, P_FLASH = 10;
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

  const HORIZON = 0xd7ecff, ZENITH = 0x3f86e0;
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(HORIZON, 40, 165);
  const camera = new THREE.PerspectiveCamera(90, 1, 0.05, 400);
  camera.rotation.order = 'YXZ';

  const sunDir = new THREE.Vector3(0.45, 0.8, 0.3).normalize();
  scene.add(new THREE.HemisphereLight(0xdcefff, 0x9d9272, 1.7));
  const sun = new THREE.DirectionalLight(0xfff0d0, 2.2);
  sun.position.copy(sunDir).multiplyScalar(100);
  scene.add(sun);

  // ---- sky dome (follows camera) ----
  const sky = (() => {
    const g = new THREE.SphereGeometry(300, 28, 18);
    const p = g.attributes.position, cols = new Float32Array(p.count * 3);
    const hz = new THREE.Color(HORIZON), zn = new THREE.Color(ZENITH), gr = new THREE.Color(0xc9dccb), c = new THREE.Color();
    const d = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      d.set(p.getX(i), p.getY(i), p.getZ(i)).normalize();
      if (d.y >= 0) c.copy(hz).lerp(zn, Math.pow(d.y, 0.55));
      else c.copy(hz).lerp(gr, Math.min(1, -d.y * 4));
      const glow = Math.pow(Math.max(0, d.dot(sunDir)), 24) * 0.9 + Math.pow(Math.max(0, d.dot(sunDir)), 400) * 3;
      cols[i * 3] = c.r + glow; cols[i * 3 + 1] = c.g + glow * 0.95; cols[i * 3 + 2] = c.b + glow * 0.8;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    m.renderOrder = -10; m.frustumCulled = false;
    return m;
  })();
  scene.add(sky);

  // ---- skyline blocks outside the walls (one merged mesh) ----
  let skyline = null;
  {
    const acc = newAcc();
    const tints = [0x9cc4d6, 0x8fb8c4, 0xa8cfc0, 0x9db4d8, 0xb4cfe0, 0x8cb0a4];
    let s = 12345;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const N = 30;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU + rnd() * 0.1, r = 80 + rnd() * 35, w = 10 + rnd() * 14, h = 10 + rnd() * 26;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      addBox(acc, cx - w / 2, -6, cz - w / 2, cx + w / 2, h, cz + w / 2, tints[(rnd() * tints.length) | 0], { skipBottom: true });
      if (rnd() > 0.5) addBox(acc, cx - w / 4, h, cz - w / 4, cx + w / 4, h + 5 + rnd() * 6, cz + w / 4, tints[(rnd() * tints.length) | 0], {});
    }
    const m = new THREE.Mesh(accToGeometry(acc), new THREE.MeshLambertMaterial({ vertexColors: true }));
    m.matrixAutoUpdate = false; m.frustumCulled = false;
    scene.add(m);
    skyline = m;
  }

  // ---- clouds (flat boxes, unfogged, one mesh) ----
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

  // ---- static map: one mesh, one draw call ----
  const flatBoxes = new Float32Array(map.boxes.length * 6);
  {
    const acc = newAcc();
    map.boxes.forEach((b, i) => {
      addBox(acc, b.min[0], b.min[1], b.min[2], b.max[0], b.max[1], b.max[2], b.color, { ao: true, skipBottom: true });
      for (let k = 0; k < 3; k++) { flatBoxes[i * 6 + k] = b.min[k]; flatBoxes[i * 6 + 3 + k] = b.max[k]; }
    });
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: gridTexture(renderer) });
    const m = new THREE.Mesh(accToGeometry(acc), mat);
    m.matrixAutoUpdate = false; m.frustumCulled = false;
    scene.add(m);
  }
  const nBoxes = map.boxes.length;
  function groundBelow(x, y, z) {
    let best = -1e9;
    for (let i = 0; i < nBoxes; i++) {
      const o = i * 6;
      const top = flatBoxes[o + 4];
      if (top > best && top <= y + 0.4 && x >= flatBoxes[o] && x <= flatBoxes[o + 3] && z >= flatBoxes[o + 2] && z <= flatBoxes[o + 5]) best = top;
    }
    return best < -1e8 ? y : best;
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
  const slotWeapon = new Int8Array(MAXP).fill(-1);
  const slotName = new Array(MAXP).fill('');
  const slotSeen = new Float64Array(MAXP);
  const prevX = new Float32Array(MAXP), prevZ = new Float32Array(MAXP);
  const speedSm = new Float32Array(MAXP), phase = new Float32Array(MAXP);
  const crouchSm = new Float32Array(MAXP), slideSm = new Float32Array(MAXP);
  const deadT = new Float32Array(MAXP), flashT = new Float32Array(MAXP), flashRot = new Float32Array(MAXP);
  const tagVis = new Int8Array(MAXP).fill(-1);   // cached wall-occlusion result per slot (-1 = unknown)
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
  function assignSlot(i, p) {
    slotId[i] = p.id; slotWeapon[i] = -1; slotName[i] = '';
    prevX[i] = p.x; prevZ[i] = p.z; speedSm[i] = 0; phase[i] = 0;
    crouchSm[i] = 0; slideSm[i] = 0; deadT[i] = 0; flashT[i] = 0;
    const h = (Math.abs(p.id) * 0.61803398875) % 1;
    hsl.setHSL(h, 0.82, 0.55); chars.setColorAt(i * PARTS + P_TORSO, hsl);
    hsl.setHSL(h, 0.8, 0.42); chars.setColorAt(i * PARTS + P_ARML, hsl); chars.setColorAt(i * PARTS + P_ARMR, hsl);
    hsl.setHSL((h + 0.5) % 1, 0.7, 0.5); chars.setColorAt(i * PARTS + P_PACK, hsl);
    hsl.setHSL(h, 0.3, 0.26); chars.setColorAt(i * PARTS + P_LEGL, hsl); chars.setColorAt(i * PARTS + P_LEGR, hsl);
    setCol(i, P_HEAD, SKIN_TONES[Math.abs(p.id) % SKIN_TONES.length]);
    setCol(i, P_VISOR, 0x18212e);
    _col.setRGB(3.2, 2.5, 1.0); chars.setColorAt(i * PARTS + P_FLASH, _col);
    chars.instanceColor.needsUpdate = true;
    tagDirty = true;
    tagAlpha[i] = 0; tagVis[i] = -1;
  }
  function setWeaponLook(i, w) {
    slotWeapon[i] = w;
    const t = TP_WEAPONS[w] || TP_WEAPONS[0];
    setCol(i, P_GUN, t.body); setCol(i, P_BARREL, t.barrel);
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

  function drawTag(i, p) {
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
    tagCtx.fillStyle = 'hsl(' + Math.round(h * 360) + ',85%,62%)';
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
    width: new Float32Array(MAXT), local: new Uint8Array(MAXT), on: new Uint8Array(MAXT), next: 0,
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
  const vm = VM_DEFS.map((def) => {
    const group = new THREE.Group();
    const body = new THREE.Mesh(partsGeometry(def.body), vmMat);
    group.add(body);
    const mag = def.mag ? new THREE.Mesh(partsGeometry(def.mag), vmMat) : null;
    if (mag) group.add(mag);
    const pump = def.pump ? new THREE.Mesh(partsGeometry(def.pump), vmMat) : null;
    if (pump) group.add(pump);
    const flash = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: flashTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, opacity: 0,
    }));
    flash.position.set(def.muzzle[0], def.muzzle[1], def.muzzle[2] - 0.04);
    flash.visible = false; flash.renderOrder = 10;
    group.add(flash);
    group.visible = false;
    vmRoot.add(group);
    return { def, group, body, mag, pump, flash };
  });

  // ---- state ----
  let baseFov = 90, W = 1, H = 1;
  let vmWeapon = 0, vmLower = 0;
  let recoil = 0, camKick = 0, flashLeft = 0, flashScale = 1, flashRotZ = 0, flashWeapon = 0, pumpKick = 0;
  let sway = 0, swayP = 0, prevYaw = 0, prevPitch = 0, havePrev = false;
  let bobPhase = 0, reloadT = 0, reloadSm = 0, slideSmL = 0;
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

  function localFire(weaponId) {
    const v = vm[weaponId] || vm[0];
    recoil = Math.min(recoil + 0.3 * v.def.recoil, 1.6);
    camKick += v.def.camKick;
    flashLeft = 0.055; flashWeapon = weaponId;
    flashScale = v.def.flash * (0.8 + Math.random() * 0.5);
    flashRotZ = Math.random() * TAU;
    if (v.pump) pumpKick = 1;
  }
  function remoteFire(playerId) {
    for (let i = 0; i < slotCount; i++) if (slotId[i] === playerId) { flashT[i] = 0.06; flashRot[i] = Math.random(); return; }
  }
  function tracer(from, to, opts) {
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
    tr.dist[i] = dist; tr.age[i] = 0; tr.len[i] = Math.min(9, dist);
    tr.life[i] = Math.min(0.3, (dist + tr.len[i]) / 380);
    tr.width[i] = local ? 0.022 : 0.04; tr.local[i] = local ? 1 : 0; tr.on[i] = 1;
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
  function updateCamera(L, dt) {
    const w = WEAPONS[L.weapon] || WEAPONS[0];
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
    camera.fov = lerp(baseFov, w.adsFov, ads) + fovKick;
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

  function updateViewmodel(L, dt) {
    const target = L.weapon | 0;
    if (vmWeapon !== target) {
      vmLower += dt / 0.1;
      if (vmLower >= 1) { vmLower = 1; vmWeapon = target; }
    } else if (vmLower > 0) vmLower = Math.max(0, vmLower - dt / 0.2);
    for (let i = 0; i < vm.length; i++) vm[i].group.visible = i === vmWeapon;

    const v = vm[vmWeapon] || vm[0], def = v.def;
    const hidden = !L.alive || (vmWeapon === 1 && L.ads > 0.6);
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

    if (L.reloading) reloadT += dt; else reloadT = 0;
    reloadSm += ((L.reloading ? 1 : 0) - reloadSm) * Math.min(1, dt * 9);

    recoil *= Math.exp(-dt * 11);
    pumpKick = Math.max(0, pumpKick - dt * 2.2);

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

    // mag swap while reloading, pump action
    if (v.mag) {
      const t = clamp((reloadT - 0.3) / 0.5, 0, 1);
      const out = reloadT > 0 ? Math.sin(t * Math.PI) : 0;
      v.mag.position.set(0, -out * 0.16, 0);
      if (vmWeapon === 2) v.mag.position.set(0, Math.sin(reloadT * 12) * 0.01 * reloadSm, 0);
    }
    if (v.pump) {
      const fireSlide = pumpKick > 0 ? Math.sin(clamp((1 - pumpKick) * 1.6, 0, 1) * Math.PI) * 0.1 : 0;
      v.pump.position.z = fireSlide + (reloadT > 0 ? Math.sin(reloadT * 10) * 0.03 : 0);
    }

    // muzzle flash
    for (let i = 0; i < vm.length; i++) vm[i].flash.visible = false;
    if (flashLeft > 0) {
      flashLeft -= dt;
      const f = vm[flashWeapon];
      if (f && flashWeapon === vmWeapon) {
        f.flash.visible = true;
        f.flash.material.opacity = clamp(flashLeft / 0.055, 0, 1);
        f.flash.scale.set(flashScale, flashScale, 1);
        f.flash.rotation.z = flashRotZ;
      }
    }
  }

  function updateCharacters(frame, dt) {
    const players = frame.players;
    const n = Math.min(players ? players.length : 0, MAXP);
    slotCount = n;
    const k = 1 - Math.exp(-dt * 14);
    const ce = camera.matrixWorld.elements;
    const camX = ce[12], camY = ce[13], camZ = ce[14];
    rr.set(ce[0], ce[1], ce[2]); ru.set(ce[4], ce[5], ce[6]);
    const tanHalfFov = Math.tan(camera.fov * Math.PI / 360);

    for (let i = 0; i < n; i++) {
      const p = players[i];
      if (slotId[i] !== p.id) assignSlot(i, p);
      if (slotWeapon[i] !== p.weapon) setWeaponLook(i, p.weapon in TP_WEAPONS ? p.weapon : 0);
      if (slotName[i] !== p.name) { slotName[i] = p.name; drawTag(i, p); }

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
      const t = TP_WEAPONS[slotWeapon[i]] || TP_WEAPONS[0];
      put(b + P_GUN, mP, -0.1, -(0.3 + t.bl / 2), -0.02, t.bw, t.bl, t.bh);
      put(b + P_BARREL, mP, -0.1, -(0.3 + t.bl + t.rl / 2), -0.02, t.rw, t.rl, t.rw);
      const fs = flashT[i] > 0 ? (0.18 + flashRot[i] * 0.14) : 0.0001;
      put(b + P_FLASH, mP, -0.1, -(0.3 + t.bl + t.rl + 0.1), -0.02, fs, fs, fs);
      pivot(mP, mTorso, -0.32, 0.52, 0, armRx, -1.0);
      put(b + P_ARML, mP, 0, -0.26, 0, 0.13, 0.52, 0.13);

      // blob shadow
      const gy = groundBelow(p.x, p.y, p.z);
      const gap = p.y - gy, ss = p.alive ? Math.max(0.2, 1 - Math.min(gap, 6) / 7) * (1 + sl * 0.2) : 0.001;
      _v.set(p.x, gy + 0.03, p.z); _s.set(ss, 1, ss);
      _m.compose(_v, QID, _s);
      shadows.setMatrixAt(i, _m);

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
          if (frameNo % 3 === i % 3 || tagVis[i] < 0) {            // occlusion test every 3rd frame per player
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
      if (slotId[i] !== -1) { slotId[i] = -1; slotName[i] = ''; slotWeapon[i] = -1; }
    }
    // free the leftover slots visually
    tagPos.fill(0, n * 12);
    for (let i = n; i < MAXP; i++) { tagAlpha[i] = 0; tagVis[i] = -1; }
    chars.count = n * PARTS;
    shadows.count = n;
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
      const r = tr.local[i] ? 1.0 : 1.0, g = tr.local[i] ? 0.85 : 0.7, bl = tr.local[i] ? 0.45 : 0.35;
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

  function render(frame) {
    if (frameNo === 0) renderer.info.reset();
    frameNo++;
    const dt = clamp(frame.dt || 0, 0, 0.1);
    updateCamera(frame.local, dt);
    updateViewmodel(frame.local, dt);
    updateCharacters(frame, dt);
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

  setQuality(quality);
  resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);

  return {
    resize, setFov, setQuality, getQuality, render, localFire, remoteFire, tracer, impact,
    // optional extras
    getCamera: () => camera,
    tagDebug: () => Array.from(tagAlpha.subarray(0, slotCount)),
    stats: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
    renderer,
  };
}
