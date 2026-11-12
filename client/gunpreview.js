// Hopshot gun preview: draws the real viewmodel box models (client/gunmodels.js, attachments included)
// for the menu's Loadout tab. ONE WebGLRenderer for everything (the big turntable preview, and still
// snapshots that become the gun-card images); it is created on first use and idles when stopped.
//
//   const pv = createGunPreview(canvasEl);      // canvasEl is the visible preview canvas
//   pv.ok                                       // false if WebGL is unavailable (callers fall back to icons)
//   pv.setModel(gun, mask, hlAtt)               // show gun + attachments; hlAtt (0..5, or -1) lights the part(s) it adds
//   pv.start() / pv.stop()                      // run / pause the animation loop (stopped = zero GPU work)
//   pv.snapshot(gun, mask, w, h)                // -> PNG data URL of a still render (transparent background)
//   pv.partInfo(gun, mask, att)                 // -> { parts: n } how many boxes the attachment adds to the model
//
// The arms are left out (the last four body boxes of every viewmodel) - this is a product shot of the gun.

import * as THREE from 'three';
import { buildViewmodel } from './gunmodels.js';

const ACCENT = 0xffb43a;
const BASE_YAW = -Math.PI / 2 - 0.52;       // muzzle to the right, nose toward the camera: three-quarter view
const PITCH = 0.2;                           // camera looks slightly down
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** All boxes of a viewmodel without the arms: [{ p: [cx,cy,cz,sx,sy,sz,hex,rotX?], k: key }]. */
function modelParts(gun, mask) {
  const d = buildViewmodel(gun, mask);
  const body = d.body.slice(0, Math.max(0, d.body.length - 4));
  const all = [...body, ...(d.mag || []), ...(d.pump || [])];
  return all.map((p) => ({ p, k: p.join(',') }));
}

/** Boxes that exist with attachment `att` fitted but not without it (what the attachment visibly adds). */
function addedKeys(gun, mask, att) {
  const withM = (mask | (1 << att)) & 63, withoutM = mask & ~(1 << att) & 63;
  const before = new Map();
  for (const x of modelParts(gun, withoutM)) before.set(x.k, (before.get(x.k) || 0) + 1);
  const added = new Set();
  for (const x of modelParts(gun, withM)) {
    const n = before.get(x.k) || 0;
    if (n > 0) before.set(x.k, n - 1); else added.add(x.k);
  }
  return added;
}

export function createGunPreview(canvas) {
  let renderer = null, ok = true;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power', preserveDrawingBuffer: false });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(1);
  } catch (e) { ok = false; }
  if (!ok) {
    return { ok: false, setModel() {}, start() {}, stop() {}, snapshot() { return ''; }, partInfo() { return { parts: 0 }; }, get running() { return false; } };
  }

  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(28, 2, 0.05, 20);
  scene.add(new THREE.HemisphereLight(0xdcecff, 0x1a2234, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 2.1); key.position.set(1.6, 2.2, 2.4); scene.add(key);
  const rim = new THREE.DirectionalLight(0x6fe9dc, 1.3); rim.position.set(-2.2, 0.8, -1.8); scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffb98a, 0.5); fill.position.set(-1.5, -0.6, 2); scene.add(fill);

  // soft contact shadow on an invisible floor
  const shadowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
    gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.22)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  scene.add(shadow);

  const unit = new THREE.BoxGeometry(1, 1, 1);
  const edgeGeo = new THREE.EdgesGeometry(unit);
  const matCache = new Map();          // hex -> { n, dim }
  function mats(hex) {
    let m = matCache.get(hex);
    if (!m) {
      const col = new THREE.Color(hex);
      m = {
        n: new THREE.MeshStandardMaterial({ color: col, roughness: 0.62, metalness: 0.18, flatShading: true }),
        dim: new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.42), roughness: 0.8, metalness: 0.1, flatShading: true }),
      };
      matCache.set(hex, m);
    }
    return m;
  }

  // per gun: centre + size of the fully-kitted model, so the framing never jumps when attachments toggle
  const fitCache = new Map();
  function fitOf(gun) {
    let f = fitCache.get(gun);
    if (f) return f;
    const box = new THREE.Box3(), tmp = new THREE.Box3(), m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    for (const { p } of modelParts(gun, 63)) {
      e.set(p[7] || 0, 0, 0);
      m.compose(new THREE.Vector3(p[0], p[1], p[2]), q.setFromEuler(e), new THREE.Vector3(p[3], p[4], p[5]));
      tmp.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)).applyMatrix4(m);
      box.union(tmp);
    }
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    f = { c, s, minY: box.min.y, r: Math.max(s.x, s.z * 0.92, s.y * 1.6) };
    fitCache.set(gun, f);
    return f;
  }

  let cur = null;                       // { group, hl: [{ mesh, mat }], gun }
  let want = { gun: 0, mask: 0, hl: -1 };
  let running = false, raf = 0, lastT = 0, dirty = true, W = 0, H = 0, t0 = performance.now();

  function disposeGroup(g) {
    scene.remove(g.group);
    for (const h of g.hl) h.mat.dispose();
    for (const h of g.extra) h.dispose();
  }

  function build(gun, mask, hl) {
    const group = new THREE.Group();
    const hlList = [], extra = [];
    const added = hl >= 0 ? addedKeys(gun, mask, hl) : null;
    const shown = hl >= 0 ? ((mask | (1 << hl)) & 63) : mask;
    const parts = modelParts(gun, shown);
    // attachments with no new boxes (Heavy Rounds: the magazine; Quick Hands: the whole gun) light a stand-in
    const mode = !added ? 'none' : added.size ? 'parts' : (hl === 2 ? 'mag' : 'all');
    const magKeys = new Set((buildViewmodel(gun, shown).mag || []).map((p) => p.join(',')));
    const box = new THREE.Box3();
    for (const { p, k } of parts) {
      const lit = mode === 'parts' ? added.has(k) : mode === 'mag' ? magKeys.has(k) : mode === 'all';
      const dimmed = hl >= 0 && !lit && mode !== 'all';
      const mesh = new THREE.Mesh(unit, dimmed ? mats(p[6]).dim : mats(p[6]).n);
      mesh.position.set(p[0], p[1], p[2]);
      mesh.scale.set(p[3], p[4], p[5]);
      if (p[7]) mesh.rotation.x = p[7];
      if (lit) {
        const m = mats(p[6]).n.clone();
        m.emissive = new THREE.Color(ACCENT); m.emissiveIntensity = 0.5;
        mesh.material = m;
        hlList.push({ mesh, mat: m });
        if (mode === 'parts' || mode === 'mag') box.union(new THREE.Box3().setFromObject(mesh));
      }
      group.add(mesh);
    }
    if (!box.isEmpty()) {
      const sz = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
      const pad = 0.035;
      const ln = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.95, depthTest: false }));
      ln.position.copy(c); ln.scale.set(sz.x + pad * 2, sz.y + pad * 2, sz.z + pad * 2); ln.renderOrder = 5;
      group.add(ln); extra.push(ln.material);
    }
    const f = fitOf(gun);
    group.position.set(-f.c.x, -f.c.y, -f.c.z);
    const holder = new THREE.Group();
    holder.add(group);
    scene.add(holder);
    return { group: holder, hl: hlList, extra, gun, hasHl: hl >= 0 };
  }

  function frameCamera(gun, aspect, k = 0.5) {
    const f = fitOf(gun);
    const vfov = cam.fov * Math.PI / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const r = f.r * k;
    const dist = Math.max(r / Math.sin(Math.min(vfov, hfov) / 2), 0.5);
    cam.aspect = aspect;
    cam.position.set(0, Math.sin(PITCH) * dist, Math.cos(PITCH) * dist);
    cam.lookAt(0, -f.s.y * 0.02, 0);
    cam.updateProjectionMatrix();
    shadow.scale.set(f.s.z * 1.1, f.s.z * 0.5, 1);
    shadow.position.set(0, f.minY - f.c.y - 0.04, 0);
  }

  function setSize(w, h) {
    if (w === W && h === H) return;
    W = w; H = h;
    renderer.setSize(w, h, false);
  }
  function fitCanvas() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr)), h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    setSize(w, h);
  }

  function drawMain(now) {
    if (!cur || canvas.clientWidth < 2 || canvas.clientHeight < 2) return;
    fitCanvas();
    const t = (now - t0) / 1000;
    const yaw = BASE_YAW + (REDUCED ? 0 : Math.sin(t * 0.55) * 0.42);
    cur.group.rotation.y = yaw;
    cur.group.position.y = REDUCED ? 0 : Math.sin(t * 1.1) * 0.006;
    if (cur.hl.length) {
      const pulse = 0.55 + 0.45 * Math.sin(t * 5);
      for (const h of cur.hl) h.mat.emissiveIntensity = REDUCED ? 0.6 : 0.25 + pulse * 0.6;
    }
    frameCamera(cur.gun, W / H);
    renderer.render(scene, cam);
  }

  function loop(now) {
    raf = 0;
    if (!running) return;
    raf = requestAnimationFrame(loop);
    if (now - lastT < 32 && !dirty) return;          // ~30 fps is plenty for a product shot
    lastT = now;
    if (REDUCED && !dirty) return;
    dirty = false;
    drawMain(now);
  }

  function apply() {
    if (cur) disposeGroup(cur);
    cur = build(want.gun, want.mask, want.hl);
    dirty = true;
    if (!running) { if (canvas.clientWidth > 0) drawMain(performance.now()); }
  }

  return {
    ok: true,
    setModel(gun, mask, hl = -1) {
      gun = gun | 0; mask = mask & 63; hl = hl == null ? -1 : hl | 0;
      if (cur && want.gun === gun && want.mask === mask && want.hl === hl) return;
      want = { gun, mask, hl };
      apply();
    },
    start() { if (running) return; running = true; dirty = true; if (!raf) raf = requestAnimationFrame(loop); },
    stop() { running = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } },
    get running() { return running; },
    /** Still render of one gun (no highlight) -> PNG data URL. Re-uses the one renderer; the next frame repaints the live view. */
    snapshot(gun, mask, w, h) {
      try {
        const g = build(gun | 0, mask & 63, -1);
        const prev = cur && cur.group;
        if (prev) prev.visible = false;
        const keepW = W, keepH = H;
        renderer.setSize(w, h, false); W = w; H = h;
        g.group.rotation.y = BASE_YAW + 0.14;
        frameCamera(gun | 0, w / h, 0.4);
        renderer.render(scene, cam);
        const url = canvas.toDataURL('image/png');
        disposeGroup(g);
        if (prev) prev.visible = true;
        W = 0; H = 0; setSize(keepW || w, keepH || h);
        dirty = true;
        return url;
      } catch (e) { return ''; }
    },
    partInfo(gun, mask, att) { return { parts: addedKeys(gun | 0, mask & 63, att | 0).size }; },
  };
}
