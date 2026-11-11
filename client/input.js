// Hopshot input: pointer lock, key/mouse map, sensitivity, and the per-tick cmd sampling.
// Also exports createAutopilot(), a synthetic player used by ?autoplay=1 and by the headless
// test (tools/client.test.js). Nothing here touches the DOM at module load, so the file can be
// imported in Node; only createInput() needs a browser.
//
// Controls: WASD move, Space jump, Shift or C crouch/slide, LMB fire, RMB ADS, R reload,
// 1/2/3 + wheel weapon, Tab scoreboard (held), Esc menu (releases pointer lock).
//
// Touch (createInput(canvas, { touch: true })): a full-screen overlay (.hs-tc) built with Pointer
// Events. Every finger is tracked by pointer id, so move stick, look, fire and one button can all
// be held at once. The touch path produces exactly the same cmd fields as the keyboard path:
// the stick maps to the WASD bits (8-way), look edits yaw/pitch, buttons set BTN bits. There is
// no pointer lock on touch. Aim assist and auto-fire (createAssist) only reshape yaw/pitch and the
// FIRE bit on the client; the server sees ordinary input.

import { BTN, PITCH_LIMIT } from '../shared/constants.js';
import { WEAPONS } from '../shared/weapons.js';
import { raycastWorld, eyeHeight } from '../shared/physics.js';

const TWO_PI = Math.PI * 2;
export const RAD_PER_PIXEL = 0.0022;   // x sensitivity setting (mouse)
export const RAD_PER_TOUCH_PIXEL = 0.0046;   // x sensitivity setting (finger drag)

export function wrapAngle(a) {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

/** Should the touch UI be used? ?touch=1 forces it on, ?touch=0 off, otherwise coarse-pointer devices. */
export function detectTouch(search) {
  try {
    const q = new URLSearchParams(search !== undefined ? search : location.search).get('touch');
    if (q === '1' || q === 'true') return true;
    if (q === '0' || q === 'false') return false;
    const mm = (s) => typeof matchMedia === 'function' && matchMedia(s).matches;
    if (mm('(pointer: coarse)') && !mm('(any-pointer: fine) and (hover: hover)')) return true;
    return ('ontouchstart' in window) && (navigator.maxTouchPoints || 0) > 0 && !mm('(pointer: fine)');
  } catch { return false; }
}

const KEYMAP = {
  KeyW: BTN.FORWARD, ArrowUp: BTN.FORWARD,
  KeyS: BTN.BACK, ArrowDown: BTN.BACK,
  KeyA: BTN.LEFT, ArrowLeft: BTN.LEFT,
  KeyD: BTN.RIGHT, ArrowRight: BTN.RIGHT,
  Space: BTN.JUMP,
  ShiftLeft: BTN.CROUCH, ShiftRight: BTN.CROUCH, KeyC: BTN.CROUCH, ControlLeft: BTN.CROUCH,
  KeyR: BTN.RELOAD,
};

function isTyping(e) {
  const t = e && e.target;
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/**
 * Browser input. opts = { onLockChange(locked), onScoreboard(held), onEscape() }.
 * The owner sets `input.enabled` (game input accepted) and `input.adsScale` (sensitivity
 * multiplier while aiming). yaw/pitch are updated on every mousemove (render rate).
 */
export function createInput(canvas, opts = {}) {
  const st = {
    enabled: false,
    locked: false,
    sensitivity: 1,
    adsScale: 1,
    yaw: 0,
    pitch: 0,
    weapon: 0,
    held: 0,          // buttons currently held
    latched: 0,       // buttons pressed since the last sample (so a quick tap is never missed)
    scoreboard: false,
    touch: !!opts.touch,
    touchHeld: 0,     // buttons held by touch (stick bits, jump, crouch, fire, ads toggle)
    invertY: false,
    autoFire: false,  // set per frame by applyAssist
    autoPulse: false,
    assistSlow: 1,    // look-speed multiplier while the crosshair is near an enemy (touch aim assist)
    touchSens: 1,
    lookDYaw: 0, lookDPitch: 0,   // look deltas accumulated since the last applyAssist (rad)
  };
  let lastWheel = 0;

  function setWeapon(w) {
    st.weapon = ((w % WEAPONS.length) + WEAPONS.length) % WEAPONS.length;
  }

  function press(bit) { st.held |= bit; st.latched |= bit; }
  function release(bit) { st.held &= ~bit; }
  let touchUi = null;
  function clear() { st.held = 0; st.latched = 0; st.touchHeld = 0; st.autoFire = false; if (touchUi) touchUi.clear(); }

  function onKeyDown(e) {
    if (e.code === 'Tab') {             // never let Tab move focus
      e.preventDefault();
      if (!isTyping(e) && !st.scoreboard) { st.scoreboard = true; opts.onScoreboard && opts.onScoreboard(true); }
      return;
    }
    if (isTyping(e)) return;
    if (e.code === 'Escape' && !st.locked) { opts.onEscape && opts.onEscape(); return; }
    if (!st.enabled) return;
    const bit = KEYMAP[e.code];
    if (bit) { press(bit); e.preventDefault(); return; }
    if (e.repeat) return;
    if (e.code === 'Digit1' || e.code === 'Numpad1') setWeapon(0);
    else if (e.code === 'Digit2' || e.code === 'Numpad2') setWeapon(1);
    else if (e.code === 'Digit3' || e.code === 'Numpad3') setWeapon(2);
    else if (e.code === 'KeyQ') setWeapon(st.weapon - 1);
  }
  function onKeyUp(e) {
    if (e.code === 'Tab') {
      e.preventDefault();
      if (st.scoreboard) { st.scoreboard = false; opts.onScoreboard && opts.onScoreboard(false); }
      return;
    }
    const bit = KEYMAP[e.code];
    if (bit) release(bit);
  }
  function onMouseMove(e) {
    if (!st.locked || !st.enabled) return;
    let mx = e.movementX || 0, my = e.movementY || 0;
    // some browsers emit one huge bogus delta right after locking
    if (Math.abs(mx) > 600 || Math.abs(my) > 600) return;
    const k = RAD_PER_PIXEL * st.sensitivity * st.adsScale;
    st.yaw = wrapAngle(st.yaw - mx * k);
    st.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, st.pitch - (st.invertY ? -my : my) * k));
  }
  function onMouseDown(e) {
    if (!st.enabled || !st.locked) return;
    if (e.button === 0) press(BTN.FIRE);
    else if (e.button === 2) press(BTN.ADS);
    e.preventDefault();
  }
  function onMouseUp(e) {
    if (e.button === 0) release(BTN.FIRE);
    else if (e.button === 2) release(BTN.ADS);
  }
  function onWheel(e) {
    if (!st.enabled || !st.locked) return;
    e.preventDefault();
    const t = performance.now();
    if (t - lastWheel < 90 || Math.abs(e.deltaY) < 1) return;
    lastWheel = t;
    setWeapon(st.weapon + (e.deltaY > 0 ? 1 : -1));
  }
  function onLockChange() {
    const locked = document.pointerLockElement === canvas;
    if (locked === st.locked) return;
    st.locked = locked;
    if (!locked) clear();
    opts.onLockChange && opts.onLockChange(locked);
  }
  function onBlur() {
    clear();
    if (st.scoreboard) { st.scoreboard = false; opts.onScoreboard && opts.onScoreboard(false); }
  }

  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('keyup', onKeyUp, { capture: true });
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', onLockChange);
  document.addEventListener('pointerlockerror', () => { opts.onLockError && opts.onLockError(); });
  window.addEventListener('blur', onBlur);

  /** Ask for pointer lock (must be called from a user gesture). Resolves to true/false. */
  async function requestLock() {
    if (st.touch) return true;      // no pointer lock on touch devices
    if (document.pointerLockElement === canvas) return true;
    if (!canvas.requestPointerLock) return false;
    try {
      const r = canvas.requestPointerLock();
      if (r && typeof r.then === 'function') await r;
      return true;
    } catch {
      return false;
    }
  }
  function exitLock() { if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock(); }

  /** Buttons for this tick (held | tapped since last sample); clears the tap latch. */
  function sampleButtons() {
    let b = st.enabled ? (st.held | st.latched | st.touchHeld) : 0;
    if (st.enabled && st.autoFire) {
      // semi-automatic weapons need a release between shots: pulse the trigger every other tick
      st.autoPulse = !st.autoPulse;
      const w = WEAPONS[st.weapon] || WEAPONS[0];
      if (w.auto || st.autoPulse) b |= BTN.FIRE;
    }
    st.latched = 0;
    return b;
  }

  // ---- look (shared by the touch drag and the assist)
  function lookBy(dyaw, dpitch) {
    st.yaw = wrapAngle(st.yaw + dyaw);
    st.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, st.pitch + dpitch));
  }

  const assist = createAssist();
  /**
   * Per render frame (touch only): aim assist + auto-fire. ctx = { world, self (physics state),
   * alive, remotes, weapon, ammo, reloading, ads, aimAssist, autoFire }.
   */
  function applyAssist(dt, ctx) {
    const aiming = !!(touchUi && touchUi.lookActive()) || (st.touchHeld & (BTN.FIRE | BTN.ADS)) !== 0;
    ctx.yaw = st.yaw; ctx.pitch = st.pitch; ctx.aiming = aiming;
    ctx.lookDYaw = st.lookDYaw; ctx.lookDPitch = st.lookDPitch;
    st.lookDYaw = 0; st.lookDPitch = 0;
    const o = assist.update(dt, ctx);
    st.assistSlow = o.slow;
    st.autoFire = o.fire;
    if (o.dyaw || o.dpitch) lookBy(o.dyaw, o.dpitch);
    return o;
  }
  if (st.touch) {
    touchUi = createTouchControls(st, {
      lookBy, setWeapon,
      onMenu() { opts.onEscape && opts.onEscape(); },
      onScoreboard(v) { st.scoreboard = v; opts.onScoreboard && opts.onScoreboard(v); },
      onGesture() { opts.onGesture && opts.onGesture(); },
      parent: opts.touchParent,
    });
  }

  return {
    get state() { return st; },
    get yaw() { return st.yaw; }, set yaw(v) { st.yaw = wrapAngle(+v || 0); },
    get pitch() { return st.pitch; }, set pitch(v) { st.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, +v || 0)); },
    get weapon() { return st.weapon; }, set weapon(v) { setWeapon(v | 0); },
    get enabled() { return st.enabled; }, set enabled(v) { st.enabled = !!v; if (!v) clear(); if (touchUi) touchUi.setVisible(st.enabled); },
    get touch() { return st.touch; },
    get invertY() { return st.invertY; }, set invertY(v) { st.invertY = !!v; },
    configureTouch(c) { if (touchUi) touchUi.configure(c); },
    setScoreboardActive(v) { if (touchUi) touchUi.setScoreboardActive(v); },
    applyAssist, assist,
    touchDebug() { return touchUi ? touchUi.debug(assist.out) : null; },
    get locked() { return st.locked; },
    get sensitivity() { return st.sensitivity; }, set sensitivity(v) { st.sensitivity = +v > 0 ? +v : 1; },
    get adsScale() { return st.adsScale; }, set adsScale(v) { st.adsScale = +v > 0 ? +v : 1; },
    get held() { return st.held | st.touchHeld; },
    sampleButtons, requestLock, exitLock, clear,
  };
}

// ------------------------------------------------------------------------------- touch assists

/**
 * Aim assist + auto-fire, purely client-side input shaping. Finds the enemy nearest to the
 * crosshair (within a small cone, visible through raycastWorld) and then:
 *   - slows the finger's look speed a little while the crosshair is near the enemy (slow = 0.6..1),
 *   - gently pulls yaw/pitch toward it while the player is aiming (look finger / fire / ADS held),
 *     never snapping and never fighting a deliberate swipe away from the target,
 *   - sets `fire` when the crosshair is on the enemy (auto-fire; input.js pulses semi-autos).
 * update(dt, ctx) -> { dyaw, dpitch, fire, slow, target, err, cone }   (reused object)
 */
export function createAssist() {
  const out = { dyaw: 0, dpitch: 0, fire: false, slow: 1, target: 0, err: 0, cone: 0 };
  let holdFire = 0;
  const PULL_RATE = 3.0;        // 1/s: fraction of the remaining error closed per second
  const PULL_MAX = 0.5;         // rad/s hard cap on the pull
  const HOLD_FIRE_S = 0.09;     // keep auto-fire on briefly when the target flickers out of the cone

  function update(dt, c) {
    out.dyaw = 0; out.dpitch = 0; out.slow = 1; out.target = 0; out.err = 0; out.cone = 0;
    const wantAim = !!c.aimAssist, wantFire = !!c.autoFire;
    let best = null;
    if ((wantAim || wantFire) && c.alive && c.self && c.remotes) {
      const s = c.self, ex = s.x, ey = s.y + eyeHeight(s), ez = s.z;
      const w = WEAPONS[c.weapon | 0] || WEAPONS[0];
      const maxD = Math.min(90, w.range);
      const cp = Math.cos(c.pitch);
      let bestScore = 1e9;
      for (let i = 0; i < c.remotes.length; i++) {
        const r = c.remotes[i];
        if (!r.alive) continue;
        const ty = r.y + (r.sliding ? 0.6 : r.crouching ? 0.8 : 1.2);
        const dx = r.x - ex, dy = ty - ey, dz = r.z - ez;
        const h = Math.hypot(dx, dz), d = Math.hypot(h, dy);
        if (d < 1.2 || d > maxD) continue;
        const wantYaw = Math.atan2(-dx, -dz), wantPitch = Math.atan2(dy, h);
        const eYaw = wrapAngle(wantYaw - c.yaw), ePitch = wantPitch - c.pitch;
        const err = Math.hypot(eYaw * cp, ePitch);
        const cone = Math.max(0.035, Math.min(0.12, Math.atan(0.9 / d)));   // 2 .. 7 degrees
        if (err >= cone) continue;
        const score = err / cone;
        if (score >= bestScore) continue;
        const hit = raycastWorld(c.world, ex, ey, ez, dx / d, dy / d, dz / d, d, null);
        if (hit < d - 0.4) continue;                                       // behind a wall
        bestScore = score;
        best = { id: r.id, eYaw, ePitch, err, cone, d, w };
      }
    }

    let fire = false;
    if (best) {
      out.target = best.id; out.err = best.err; out.cone = best.cone;
      if (wantAim) {
        out.slow = 0.6 + 0.4 * (best.err / best.cone);
        if (c.aiming && best.err > 0.004) {
          // do not pull while the player is swiping away from the enemy
          const away = (c.lookDYaw * best.eYaw + c.lookDPitch * best.ePitch) < 0 && Math.hypot(c.lookDYaw, c.lookDPitch) > 0.004;
          if (!away) {
            const k = Math.min(1, dt * PULL_RATE);
            let py = best.eYaw * k, pp = best.ePitch * k;
            const m = Math.hypot(py, pp), cap = PULL_MAX * dt;
            if (m > cap) { py *= cap / m; pp *= cap / m; }
            out.dyaw = py; out.dpitch = pp;
          }
        }
      }
      if (wantFire && c.ammo > 0 && !c.reloading) {
        const tight = Math.max(0.012, Math.min(0.05, Math.atan(0.32 / best.d)));
        const w = best.w;
        const scoped = w.key !== 'scout' || (c.ads || 0) > 0.7;            // the scout is wild from the hip
        const inRange = w.key !== 'shotgun' || best.d <= w.range * 0.8;
        if (best.err <= tight && scoped && inRange) fire = true;
      }
    }
    if (fire) holdFire = HOLD_FIRE_S;
    else if (holdFire > 0 && wantFire && c.alive) { holdFire -= dt; fire = holdFire > 0 && c.ammo > 0 && !c.reloading; }
    else holdFire = 0;
    out.fire = fire;
    return out;
  }
  return { update, get out() { return out; } };
}

// --------------------------------------------------------------------------- touch controls

const TOUCH_HTML = `
  <div class="tc-hint tc-hint-move"><i></i><span>MOVE</span></div>
  <div class="tc-hint tc-hint-look"><span>DRAG TO LOOK</span></div>
  <div class="tc-stick"><div class="tc-knob"></div></div>
  <div class="tb tb-menu" data-act="menu" aria-label="Menu"><b><i class="ic-menu"></i></b></div>
  <div class="tb tb-score" data-act="score" aria-label="Scoreboard"><b><i class="ic-score"></i></b></div>
  <div class="tb tb-fire" data-act="fire" aria-label="Fire"><b>FIRE</b></div>
  <div class="tb tb-jump" data-act="jump" aria-label="Jump"><b>JUMP</b></div>
  <div class="tb tb-crouch" data-act="crouch" aria-label="Crouch or slide"><b>SLIDE</b></div>
  <div class="tb tb-ads" data-act="ads" aria-label="Aim"><b>AIM</b></div>
  <div class="tb tb-reload" data-act="reload" aria-label="Reload"><b>RELOAD</b></div>
  <div class="tb tb-wprev" data-act="wprev" aria-label="Previous weapon"><b>&#8249;</b></div>
  <div class="tb tb-wnext" data-act="wnext" aria-label="Next weapon"><b>&#8250;</b></div>`;

function createTouchControls(st, api) {
  const layer = document.createElement('div');
  layer.className = 'hs-tc';
  layer.dataset.side = 'left';
  layer.innerHTML = TOUCH_HTML;
  (api.parent || document.body).appendChild(layer);
  const q = (s) => layer.querySelector(s);
  const stickEl = q('.tc-stick'), knobEl = q('.tc-knob');
  const btnEls = {};
  layer.querySelectorAll('[data-act]').forEach((e) => { btnEls[e.dataset.act] = e; });

  const cfg = { side: 'left', scale: 1 };
  const ptrs = new Map();        // pointerId -> { role: 'stick'|'look'|'btn', act, x, y, ... }
  let stickId = null;
  const stick = { ox: 0, oy: 0, x: 0, y: 0, mag: 0, bits: 0 };
  const MOVE_BITS = BTN.FORWARD | BTN.BACK | BTN.LEFT | BTN.RIGHT;
  const DEAD = 0.22;
  let visible = false;

  function stickRadius() { return 56 * cfg.scale; }
  function setStickBits(b) { st.touchHeld = (st.touchHeld & ~MOVE_BITS) | b; stick.bits = b; }

  function updateStick(x, y) {
    const R = stickRadius();
    let vx = x - stick.ox, vy = y - stick.oy;
    let len = Math.hypot(vx, vy);
    if (len > R) {                                   // floating stick: the base follows the thumb
      const over = (len - R) / len;
      stick.ox += vx * over; stick.oy += vy * over;
      vx = x - stick.ox; vy = y - stick.oy; len = Math.hypot(vx, vy);
    }
    stick.x = len > 0 ? vx / len : 0; stick.y = len > 0 ? vy / len : 0;
    stick.mag = Math.min(1, len / R);
    let b = 0;
    if (stick.mag >= DEAD) {
      if (stick.y < -0.38) b |= BTN.FORWARD;
      else if (stick.y > 0.38) b |= BTN.BACK;
      if (stick.x < -0.38) b |= BTN.LEFT;
      else if (stick.x > 0.38) b |= BTN.RIGHT;
    }
    setStickBits(b);
    stickEl.style.transform = `translate(${stick.ox}px, ${stick.oy}px)`;
    knobEl.style.transform = `translate(${vx}px, ${vy}px)`;
  }
  function stickDown(x, y) {
    stick.ox = x; stick.oy = y;
    stickEl.classList.add('on');
    layer.classList.add('stick-on');
    updateStick(x, y);
  }
  function stickUp() {
    stickEl.classList.remove('on');
    layer.classList.remove('stick-on');
    setStickBits(0);
    stick.mag = 0;
  }

  function look(dx, dy) {
    const k = RAD_PER_TOUCH_PIXEL * st.sensitivity * st.adsScale * st.assistSlow;
    const dyaw = -dx * k, dpitch = -(st.invertY ? -dy : dy) * k;
    st.lookDYaw += dyaw; st.lookDPitch += dpitch;
    api.lookBy(dyaw, dpitch);
  }

  function setPressed(act, on) { const el = btnEls[act]; if (el) el.classList.toggle('on', !!on); }
  function btnDown(act) {
    setPressed(act, true);
    switch (act) {
      case 'fire': st.touchHeld |= BTN.FIRE; break;
      case 'jump': st.touchHeld |= BTN.JUMP; st.latched |= BTN.JUMP; break;
      case 'crouch': st.touchHeld |= BTN.CROUCH; st.latched |= BTN.CROUCH; break;
      case 'reload': st.touchHeld |= BTN.RELOAD; st.latched |= BTN.RELOAD; break;
      case 'ads': adsOn = !adsOn; syncAds(); break;
      case 'wprev': api.setWeapon(st.weapon - 1); break;
      case 'wnext': api.setWeapon(st.weapon + 1); break;
      case 'menu': api.onMenu(); break;
      case 'score': sbOn = !sbOn; setScoreboardActive(sbOn); api.onScoreboard(sbOn); break;
    }
  }
  function btnUp(act) {
    if (act !== 'ads' && act !== 'score') setPressed(act, false);
    else if (act === 'ads') setPressed('ads', adsOn);
    else setPressed('score', sbOn);
    switch (act) {
      case 'fire': st.touchHeld &= ~BTN.FIRE; break;
      case 'jump': st.touchHeld &= ~BTN.JUMP; break;
      case 'crouch': st.touchHeld &= ~BTN.CROUCH; break;
      case 'reload': st.touchHeld &= ~BTN.RELOAD; break;
    }
  }
  let adsOn = false, sbOn = false;
  function syncAds() { st.touchHeld = adsOn ? (st.touchHeld | BTN.ADS) : (st.touchHeld & ~BTN.ADS); setPressed('ads', adsOn); }
  function setScoreboardActive(v) { sbOn = !!v; setPressed('score', sbOn); }

  function release(id) {
    const rec = ptrs.get(id);
    if (!rec) return;
    ptrs.delete(id);
    try { layer.releasePointerCapture(id); } catch { /* not captured */ }
    if (rec.role === 'stick') { stickId = null; stickUp(); }
    else if (rec.role === 'btn') btnUp(rec.act);
  }

  function onDown(e) {
    if (!st.enabled) return;
    e.preventDefault();
    api.onGesture();
    const el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    let rec;
    if (el) rec = { role: 'btn', act: el.dataset.act, x: e.clientX, y: e.clientY };
    else {
      const w = window.innerWidth;
      const inStickZone = cfg.side === 'left' ? e.clientX < w * 0.42 : e.clientX > w * 0.58;
      if (inStickZone && stickId === null) rec = { role: 'stick', x: e.clientX, y: e.clientY };
      else rec = { role: 'look', x: e.clientX, y: e.clientY };
    }
    if (ptrs.has(e.pointerId)) release(e.pointerId);
    ptrs.set(e.pointerId, rec);
    try { layer.setPointerCapture(e.pointerId); } catch { /* synthetic or already gone */ }
    if (rec.role === 'stick') { stickId = e.pointerId; stickDown(e.clientX, e.clientY); }
    else if (rec.role === 'btn') btnDown(rec.act);
    layer.classList.add('touched');
  }
  function onMove(e) {
    const rec = ptrs.get(e.pointerId);
    if (!rec || !st.enabled) return;
    e.preventDefault();
    if (rec.role === 'stick') { updateStick(e.clientX, e.clientY); return; }
    // look pad, and the fire button doubles as a look pad so you can aim while firing
    if (rec.role === 'look' || (rec.role === 'btn' && rec.act === 'fire')) look(e.clientX - rec.x, e.clientY - rec.y);
    rec.x = e.clientX; rec.y = e.clientY;
  }
  function onUp(e) { if (ptrs.has(e.pointerId)) { e.preventDefault(); release(e.pointerId); } }
  layer.addEventListener('pointerdown', onDown);
  layer.addEventListener('pointermove', onMove);
  layer.addEventListener('pointerup', onUp);
  layer.addEventListener('pointercancel', onUp);
  layer.addEventListener('lostpointercapture', (e) => { if (ptrs.has(e.pointerId)) release(e.pointerId); });
  layer.addEventListener('contextmenu', (e) => e.preventDefault());
  // iOS Safari ignores user-scalable=no: block pinch / gesture zoom explicitly (touch-action: manipulation in the CSS stops double-tap zoom)
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault());
  layer.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

  function clear() {
    for (const id of Array.from(ptrs.keys())) release(id);
    ptrs.clear(); stickId = null; stickUp();
    adsOn = false; syncAds();
    for (const a in btnEls) if (a !== 'score') setPressed(a, false);
    st.touchHeld = 0;
    layer.classList.remove('touched');
  }
  function setVisible(v) {
    visible = !!v;
    layer.classList.toggle('on', visible);
  }
  function configure(c) {
    if (c.side === 'left' || c.side === 'right') cfg.side = c.side;
    if (Number.isFinite(c.scale)) cfg.scale = Math.max(0.8, Math.min(1.6, c.scale));
    layer.dataset.side = cfg.side;
    layer.style.setProperty('--ts', String(cfg.scale));
  }
  configure({});

  function debug(assistOut) {
    const held = st.touchHeld;
    return {
      visible, side: cfg.side, scale: cfg.scale, pointers: ptrs.size,
      stick: { active: stickId !== null, x: +stick.x.toFixed(2), y: +stick.y.toFixed(2), mag: +stick.mag.toFixed(2), bits: stick.bits },
      held, fire: !!(held & BTN.FIRE), jump: !!(held & BTN.JUMP), crouch: !!(held & BTN.CROUCH), ads: !!(held & BTN.ADS),
      autoFire: st.autoFire, assistSlow: st.assistSlow,
      assist: assistOut ? { target: assistOut.target, err: +assistOut.err.toFixed(4), cone: +assistOut.cone.toFixed(4), fire: assistOut.fire } : null,
    };
  }
  return {
    el: layer, clear, setVisible, configure, debug, setScoreboardActive,
    lookActive() { for (const r of ptrs.values()) if (r.role === 'look' || (r.role === 'btn' && r.act === 'fire')) return true; return false; },
  };
}

// ------------------------------------------------------------------------------- autopilot

/** Small deterministic PRNG (mulberry32) so autopilot runs are reproducible per seed. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthetic player: wanders with slide-hops, avoids walls, turns toward and shoots at the
 * nearest visible enemy. One update() per sim tick:
 *   ctx = { world, self (physics state), alive, remotes: [{ id, x, y, z, alive, crouching }],
 *           ammo, magSize, weapon }
 *   -> { buttons, yaw, pitch, weapon }   (reused object)
 */
export function createAutopilot(opts = {}) {
  const rnd = prng(opts.seed || 12345);
  const out = { buttons: 0, yaw: opts.yaw || 0, pitch: 0, weapon: 0, target: 0 };
  let tick = 0;
  let wanderYaw = out.yaw, nextWander = 0;
  let target = null, targetId = 0, nextScan = 0, strafe = 1, nextStrafe = 0;
  let nextWeapon = 600 + Math.floor(rnd() * 600);
  let blockedTicks = 0;
  let firePulse = false;
  const nrm = [0, 0, 0];
  const turnRate = opts.turnRate || 0.16;   // rad per tick

  function visible(world, ex, ey, ez, r) {
    const tx = r.x, ty = r.y + (r.crouching ? 0.7 : 1.2), tz = r.z;
    const dx = tx - ex, dy = ty - ey, dz = tz - ez;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 0.5 || d > 70) return 0;
    const hit = raycastWorld(world, ex, ey, ez, dx / d, dy / d, dz / d, d, null);
    return hit >= d - 0.3 ? d : 0;
  }

  function approach(cur, goal, step) {
    const d = wrapAngle(goal - cur);
    return wrapAngle(cur + (d > step ? step : d < -step ? -step : d));
  }

  function setYaw(v) { out.yaw = wrapAngle(v); wanderYaw = out.yaw; }

  function update(ctx) {
    tick++;
    const s = ctx.self, world = ctx.world;
    let b = 0;
    if (!ctx.alive) { out.buttons = 0; target = null; return out; }
    const ex = s.x, ey = s.y + eyeHeight(s), ez = s.z;

    // target selection
    if (tick >= nextScan) {
      nextScan = tick + 6;
      target = null; targetId = 0;
      let best = 1e9;
      const list = ctx.remotes || [];
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        if (!r.alive) continue;
        const d = visible(world, ex, ey, ez, r);
        if (d > 0 && d < best) { best = d; target = r; targetId = r.id; }
      }
    }
    if (target && (!target.alive || target.id !== targetId)) target = null;

    if (tick >= nextWeapon) { nextWeapon = tick + 900 + Math.floor(rnd() * 900); out.weapon = Math.floor(rnd() * WEAPONS.length); }

    if (target) {
      const tx = target.x - ex, ty = target.y + (target.crouching ? 0.75 : 1.25) - ey, tz = target.z - ez;
      const h = Math.hypot(tx, tz);
      const wantYaw = Math.atan2(-tx, -tz);
      const wantPitch = Math.atan2(ty, h);
      out.yaw = approach(out.yaw, wantYaw, turnRate);
      out.pitch += Math.max(-turnRate, Math.min(turnRate, wantPitch - out.pitch));
      const aimErr = Math.abs(wrapAngle(wantYaw - out.yaw)) + Math.abs(wantPitch - out.pitch);
      if (aimErr < 0.06) {
        const w = WEAPONS[ctx.weapon | 0] || WEAPONS[0];
        firePulse = w.auto ? true : !firePulse;          // semi-autos need a release between shots
        if (firePulse) b |= BTN.FIRE;
        if (h > 18) b |= BTN.ADS;
      }
      if (tick >= nextStrafe) { strafe = rnd() < 0.5 ? -1 : 1; nextStrafe = tick + 30 + Math.floor(rnd() * 50); }
      b |= strafe > 0 ? BTN.RIGHT : BTN.LEFT;
      if (h > 14) b |= BTN.FORWARD;
      if (h < 5) b |= BTN.BACK;
      wanderYaw = out.yaw;
    } else {
      // wander + wall avoidance
      if (tick >= nextWander) {
        nextWander = tick + 90 + Math.floor(rnd() * 150);
        wanderYaw = wrapAngle(wanderYaw + (rnd() - 0.5) * 2.2);
      }
      const fx = -Math.sin(out.yaw), fz = -Math.cos(out.yaw);
      const look = 2.2 + Math.hypot(s.vx, s.vz) * 0.25;
      const knee = raycastWorld(world, ex, s.y + 0.6, ez, fx, 0, fz, look, nrm);
      const chest = raycastWorld(world, ex, s.y + 1.3, ez, fx, 0, fz, look, nrm);
      if (knee < look || chest < look) {
        blockedTicks++;
        // turn toward whichever side is more open
        const lx = -Math.sin(out.yaw + 1.2), lz = -Math.cos(out.yaw + 1.2);
        const rx = -Math.sin(out.yaw - 1.2), rz = -Math.cos(out.yaw - 1.2);
        const dl = raycastWorld(world, ex, s.y + 1.0, ez, lx, 0, lz, 15, null);
        const dr = raycastWorld(world, ex, s.y + 1.0, ez, rx, 0, rz, 15, null);
        wanderYaw = wrapAngle(out.yaw + (dl > dr ? 1.3 : -1.3) + (blockedTicks > 60 ? Math.PI * 0.5 : 0));
        if (blockedTicks > 60) blockedTicks = 0;
      } else blockedTicks = 0;
      out.yaw = approach(out.yaw, wanderYaw, turnRate * 0.6);
      out.pitch += (0 - out.pitch) * 0.1;
      b |= BTN.FORWARD;
      if (ctx.magSize && ctx.ammo < ctx.magSize * 0.4 && (tick % 120) === 0) b |= BTN.RELOAD;
    }

    // slide-hop: hold jump (auto-hop), release crouch while rising, hold crouch while falling
    // so every landing becomes a boosted slide that the held jump immediately hops out of.
    // Air control is weak, so only start hopping once running speed is reached on the ground.
    const hs = Math.hypot(s.vx, s.vz);
    if (!s.onGround || s.sliding || hs > 6.2) b |= BTN.JUMP;
    // crouch while falling and on the landing tick (-> boosted slide), released while rising
    if (hs > 5 && ((!s.onGround && s.vy < -1.5) || (s.onGround && s.crouching))) b |= BTN.CROUCH;
    if (s.sliding) b |= BTN.CROUCH;

    out.buttons = b;
    out.target = targetId;
    return out;
  }

  return { update, setYaw, get out() { return out; } };
}

