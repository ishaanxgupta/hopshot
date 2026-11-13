// Hopshot HUD: pure DOM/CSS. Styles live in client/style.css (classes prefixed "hs-").
// update(state) is called every frame and only touches the DOM when a value actually changed.

import { createLoadoutEditor } from './loadout-ui.js';
import { createMatchHud } from './matchhud.js';
import { createLobby, copyToClipboard, VOICE_ICON, micLabel } from './lobby-ui.js';

// opts for createHud(rootEl, opts): { touch: bool, onScoreboardClose(), onWeapon(slot), onReturnToLobby(),
//   lobby: { onConfig(partial), onStart(), onTeam(team), onLoadout(), onMenu() } }
// Modes / lobby (protocol v4): hud.match = createMatchHud (top panel per mode, countdown, banner, objective feed,
// markers, results, team scoreboard; see matchhud.js), hud.lobby = createLobby (private-room lobby; lobby-ui.js).
// hud.setScoreboard(visible, boardData) takes the data main.js builds (rows with team / obj).
// Extra methods beyond the base contract: setPrefs(settings) (crosshair, stats line), setInGame(bool)
// (rotate hint), showMenu({ ..., inGame, tab }) -> the menu is a two-pane card (play column +
// Loadout / Settings / Friends / Controls tabs) that fits a 640x360 landscape phone.
// Weapons: update(state) takes state.slots = [{ name, att }] x3 + state.slot (active) for the weapon
// bar, state.scope (0 none | 1 optic | 2 sniper scope overlay), state.crossGap (px) for the crosshair
// bloom. showMenu({ loadout: { saved, onChange({code, builds}) } }); setLoadoutStatus({ pendingCode,
// activeCode, joined }) keeps the "applies on your next spawn" line honest.
// Voice chat (private rooms): attachVoice(voice) (client/voice.js) adds a small mic + speaker pair at the top
// left (shown only while voice is available; the lobby has its own pair in its header), voiceFrame(ctx) per
// frame (button state, a speaking wave next to talking players' name tags, scoreboard voice cells),
// voiceNotice(text) (short toast under the buttons), setBoardHint(text) (a line under the scoreboard).
// The scoreboard rows (rendered by matchhud.js) get a Voice cell: speaking wave + per-player mute + volume.
// Memory (v6, only when the server has it on): setPlayerCode({ enabled, code, onUse(code) -> message })
// shows a "Player code" settings group (masked code + Copy, paste a code from another device);
// setLoadoutTip(text) puts one history-based line in the Loadout tab ('' hides it).

const MAX_FEED = 6;
const FEED_MS = 5500;
const SPEED_BAR_MAX = 17;

function restartAnim(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth; // reflow so the CSS animation restarts
  el.classList.add(cls);
}

function fmtTime(s) {
  s = Math.max(0, Math.ceil(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// Settings model: drives both the menu controls and the validation in main.js (keep keys in sync).
export const CROSSHAIR_COLORS = ['#ffffff', '#ffd23a', '#5dff8a', '#3fe6ff', '#ff6bd6', '#ff4d5e'];
const fmtX = (v) => Number(v).toFixed(2) + 'x';
const pct = (v) => Math.round(v * 100) + '%';
const SET_DEFS = [
  { id: 'controls', title: 'Controls', items: [
    { k: 'sensitivity', label: 'Sensitivity', type: 'range', min: 0.05, max: 5, step: 0.05, fmt: (v) => Number(v).toFixed(2) },
    { k: 'adsSens', label: 'Aim (ADS) sensitivity', type: 'range', min: 0.2, max: 2, step: 0.05, fmt: fmtX },
    { k: 'invertY', label: 'Invert Y axis', type: 'check' },
  ] },
  { id: 'video', title: 'Video & audio', items: [
    { k: 'fov', label: 'Field of view', type: 'range', min: 60, max: 120, step: 1, fmt: (v) => Math.round(v) + '\u00b0' },
    { k: 'volume', label: 'Volume', type: 'range', min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100) + '%' },
    { k: 'quality', label: 'Graphics quality', type: 'select', options: [['low', 'Low (fastest)'], ['medium', 'Medium'], ['high', 'High']] },
    { k: 'showStats', label: 'Show FPS / ping / net stats', type: 'check' },
  ] },
  { id: 'crosshair', title: 'Crosshair', items: [
    { k: 'crosshairColor', label: 'Colour', type: 'swatch' },
    { k: 'crosshairSize', label: 'Size', type: 'range', min: 0.5, max: 2.5, step: 0.05, fmt: fmtX },
  ] },
  { id: 'voice', title: 'Voice chat (private rooms)', items: [
    { k: 'voiceVolume', label: 'Voice volume', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
    { k: 'micDefault', label: 'Microphone on when I join a room', type: 'check' },
    { k: 'pttKey', label: 'Push-to-talk (hold)', type: 'select', desktop: true, options: [['KeyV', 'V'], ['KeyB', 'B'], ['KeyT', 'T'], ['KeyG', 'G'], ['KeyX', 'X'], ['KeyZ', 'Z'], ['CapsLock', 'Caps Lock'], ['Backquote', '` (backquote)'], ['', 'Off']] },
    { k: 'proximity', label: 'Proximity voice (louder when close, from their direction)', type: 'check' },
    { k: 'noiseSuppression', label: 'Noise suppression', type: 'check' },
    { k: 'echoCancellation', label: 'Echo cancellation', type: 'check' },
  ] },
  { id: 'touch', title: 'Touch controls', touch: true, items: [
    { k: 'stickSide', label: 'Move stick side', type: 'select', options: [['left', 'Left (buttons right)'], ['right', 'Right (buttons left)']] },
    { k: 'jumpSlide', label: 'Jump & slide', type: 'select', options: [['stick', 'Stick gestures'], ['buttons', 'Buttons']] },
    { k: 'slideAssist', label: 'Slide-hop assist (stick jump zone crouches on landing)', type: 'check' },
    { k: 'btnScale', label: 'Button size', type: 'range', min: 0.9, max: 1.5, step: 0.05, fmt: fmtX },
    { k: 'aimAssist', label: 'Aim assist (gentle slow-down and pull)', type: 'check' },
    { k: 'autoFire', label: 'Auto-fire when aiming at an enemy', type: 'check' },
  ] },
];

export function createHud(rootEl, hudOpts = {}) {
  const TOUCH = !!hudOpts.touch;
  rootEl.classList.add('hs-root');
  if (TOUCH) rootEl.classList.add('hs-touch');
  rootEl.innerHTML = `
    <div class="hs-vignette"></div>
    <div class="hs-dmg-wrap"></div>
    <div class="hs-cross"><i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i><i class="d"></i></div>
    <div class="hs-hit"><i></i><i></i><i></i><i></i></div>
    <div class="hs-scope" data-k="0"><div class="ring"></div><div class="h"></div><div class="v"></div><div class="opt"><i></i></div></div>

    <div class="hs-topleft"><span class="hs-fps"></span><span class="hs-ping"></span><span class="hs-q"></span><span class="hs-pl"></span></div>
    <div class="hs-vtags" aria-hidden="true"></div>
    <div class="hs-match"></div>
    <div class="hs-feed"></div>
    <div class="hs-status"></div>

    <div class="hs-wbar" role="toolbar" aria-label="Weapons">
      <button type="button" class="hs-ws" data-slot="0"><em>1</em><b></b><small></small></button>
      <button type="button" class="hs-ws" data-slot="1"><em>2</em><b></b><small></small></button>
      <button type="button" class="hs-ws" data-slot="2"><em>3</em><b></b><small></small></button>
    </div>
    <div class="hs-bl">
      <div class="hs-health"><div class="hs-hnum">100</div><div class="hs-hlabel">HEALTH</div>
        <div class="hs-hbar"><div class="fill"></div></div></div>
    </div>
    <div class="hs-bc">
      <div class="hs-speed"><span class="num">0</span><span class="unit">m/s</span>
        <div class="bar"><div class="fill"></div></div></div>
    </div>
    <div class="hs-br">
      <div class="hs-wname">RIFLE</div>
      <div class="hs-ammo"><span class="cur">30</span><span class="sep">/</span><span class="mag">30</span></div>
      <div class="hs-reload"><div class="fill"></div><span>RELOADING</span></div>
    </div>

    <div class="hs-death"><div class="hs-dtitle">ELIMINATED</div><div class="hs-dsub"></div></div>

    <div class="hs-lb"></div>

    <div class="hs-wake" role="status"><div class="hs-wcard">
      <div class="hs-spin"></div><div class="hs-wtitle"></div><div class="hs-wsub"></div>
    </div></div>

    <div class="hs-rotate"><div class="hs-rcard">
      <div class="hs-phone"><i></i></div>
      <div class="hs-rtitle">Rotate your phone</div>
      <div class="hs-rsub">Hopshot plays best in landscape.</div>
      <button class="hs-btn hs-rgo" type="button">Play in portrait anyway</button>
    </div></div>

    <div class="hs-menu"><div class="hs-card">
      <div class="hs-main">
        <div class="hs-logo"><span>HOP</span>SHOT</div>
        <div class="hs-tag">slide. hop. shoot.</div>
        <label class="hs-field"><span>Name</span><input class="hs-name" maxlength="16" spellcheck="false" autocomplete="off" autocapitalize="off" enterkeyhint="go" /></label>
        <button class="hs-play" type="button">PLAY</button>
        <div class="hs-server" data-state="checking" role="status"><i></i><span>Contacting server\u2026</span></div>
      </div>
      <div class="hs-side">
        <div class="hs-tabs" role="tablist">
          <button type="button" role="tab" data-tab="loadout">Loadout</button>
          <button type="button" role="tab" data-tab="settings">Settings</button>
          <button type="button" role="tab" data-tab="friends">Friends</button>
          <button type="button" role="tab" data-tab="keys">Controls</button>
        </div>
        <div class="hs-tabbody">
          <section class="hs-pane" data-pane="loadout"><div class="hs-loadout"></div></section>
          <section class="hs-pane hs-settings" data-pane="settings"></section>
          <section class="hs-pane hs-friends" data-pane="friends">
            <div class="hs-ftitle">Play with friends</div>
            <div class="hs-invite">
              <div class="hs-roomline">Private room <b class="hs-roomcode"></b><span class="hs-roombots"></span></div>
              <div class="hs-row"><input type="text" class="hs-link" readonly spellcheck="false" aria-label="Invite link" /><button class="hs-btn hs-copy" type="button">Copy</button></div>
              <div class="hs-linknote"></div>
              <button class="hs-btn hs-leave" type="button">Leave private room</button>
            </div>
            <div class="hs-lobby">
              <div class="hs-row"><label class="hs-check"><input type="checkbox" class="hs-bots" />Fill empty slots with bots</label><button class="hs-btn hs-create" type="button">Create private room</button></div>
              <div class="hs-row"><input type="text" class="hs-code" maxlength="24" placeholder="Have a room code? Enter it" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Room code" /><button class="hs-btn hs-join" type="button">Join</button></div>
            </div>
          </section>
          <section class="hs-pane hs-keys" data-pane="keys">
            <div class="hs-keys-pc">
              <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><em>Move</em></div>
              <div><kbd>Space</kbd><em>Jump (hold to hop)</em></div>
              <div><kbd>Shift</kbd> / <kbd>C</kbd><em>Crouch / slide</em></div>
              <div><kbd>LMB</kbd><em>Fire</em><kbd>RMB</kbd><em>Aim</em></div>
              <div><kbd>R</kbd><em>Reload</em><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><em>Weapon</em></div>
              <div><kbd>Tab</kbd><em>Scoreboard</em><kbd>Esc</kbd><em>Menu</em></div>
            </div>
            <div class="hs-keys-touch">
              <div><kbd>Left thumb</kbd><em>Drag to move (full push = run)</em></div>
              <div><kbd>Ring</kbd><em>Push past the stick edge to slide</em></div>
              <div><kbd>Up</kbd><em>Push up past the ring (or flick) to jump, hold to hop</em></div>
              <div><kbd>Right side</kbd><em>Drag to look</em></div>
              <div><kbd>FIRE</kbd><em>Hold to shoot, drag it to aim</em></div>
              <div><kbd>AIM</kbd><em>Toggle scope</em><kbd>1 2 3</kbd><em>Tap a weapon slot</em></div>
              <div><em>Top-left buttons: menu and scoreboard</em></div>
            </div>
          </section>
        </div>
      </div>
    </div></div>

    <div class="hs-voice" role="group" aria-label="Voice chat">
      <button type="button" class="hs-vb hs-vmic" data-s="off" aria-label="Microphone">${VOICE_ICON.micOff}</button>
      <button type="button" class="hs-vb hs-vspk" data-s="on" aria-label="Speaker">${VOICE_ICON.spk}</button>
    </div>
    <div class="hs-vnote" role="status"></div>`;

  const $ = (sel) => rootEl.querySelector(sel);
  const el = {
    vig: $('.hs-vignette'), dmgWrap: $('.hs-dmg-wrap'), cross: $('.hs-cross'), hit: $('.hs-hit'), scope: $('.hs-scope'),
    fps: $('.hs-fps'), ping: $('.hs-ping'), q: $('.hs-q'), pl: $('.hs-pl'),
    feed: $('.hs-feed'), status: $('.hs-status'),
    hnum: $('.hs-hnum'), hfill: $('.hs-hbar .fill'), speedNum: $('.hs-speed .num'), speedFill: $('.hs-speed .fill'),
    wname: $('.hs-wname'), cur: $('.hs-ammo .cur'), mag: $('.hs-ammo .mag'), ammo: $('.hs-ammo'),
    reload: $('.hs-reload'), death: $('.hs-death'), dsub: $('.hs-dsub'),
    menu: $('.hs-menu'), name: $('.hs-name'), play: $('.hs-play'),
    rotate: $('.hs-rotate'), rotateGo: $('.hs-rgo'), card: $('.hs-card'), wbar: $('.hs-wbar'),
  };
  const match = createMatchHud($('.hs-match'), { touch: TOUCH, onReturnToLobby: hudOpts.onReturnToLobby, onScoreboardClose: hudOpts.onScoreboardClose });
  const lobby = createLobby($('.hs-lb'), { touch: TOUCH, ...(hudOpts.lobby || {}) });
  const wsBtns = Array.from(rootEl.querySelectorAll('.hs-ws'));
  for (const b of wsBtns) {
    // taps on the weapon bar must not reach the touch-controls layer underneath
    // Switch on pointerdown: phone browsers often never send a 'click' here, because the touch
    // layer cancels touch defaults (and a finger that is also holding the stick or look pad makes
    // it a multi-touch gesture). 'click' stays as the fallback for keyboard activation.
    let handledAt = -1e9;
    b.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      handledAt = e.timeStamp;
      if (hudOpts.onWeapon) hudOpts.onWeapon(+b.dataset.slot);
    });
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.timeStamp - handledAt < 800) return;
      if (hudOpts.onWeapon) hudOpts.onWeapon(+b.dataset.slot);
    });
  }

  // damage indicator pool
  const dmgEls = [];
  for (let i = 0; i < 6; i++) {
    const d = document.createElement('div');
    d.className = 'hs-dmg';
    d.innerHTML = '<i></i>';
    el.dmgWrap.appendChild(d);
    dmgEls.push(d);
  }
  let dmgNext = 0;

  const last = {};
  let gapSm = 7;
  function setText(key, node, value) {
    if (last[key] !== value) { last[key] = value; node.textContent = value; }
  }
  function setCls(key, node, cls, on) {
    on = !!on;
    if (last[key] !== on) { last[key] = on; node.classList.toggle(cls, on); }
  }

  let menuCb = null;

  // "jitter 6 ms · interp 100 ms · corr 0" from net.state.quality (may be undefined or partial)
  function netQualityText(q) {
    if (!q || typeof q !== 'object') return '';
    const parts = [];
    const n = (v) => (Number.isFinite(v) ? Math.round(v) : null);
    const j = n(q.jitterMs), ip = n(q.interpDelayMs), c = n(q.corrections10s), st = n(q.starved10s);
    if (j !== null) parts.push('jitter ' + j + ' ms');
    if (ip !== null) parts.push('interp ' + ip + ' ms');
    if (c !== null) parts.push('corr ' + c);
    if (st !== null && st > 0) parts.push('starved ' + st);
    return parts.join(' \u00b7 ');
  }

  function update(s) {
    const alive = s.alive !== false;
    const ads = s.ads || 0;
    const kind = alive ? (s.scope | 0) : 0;      // 0 none, 1 optic reticle, 2 sniper scope
    const scoped = kind > 0;

    setCls('alive', rootEl, 'hs-dead', !alive);
    setCls('scoped', rootEl, 'hs-scoped', scoped);
    // crosshair: fades out as you aim down sights, hidden when scoped
    const crossOp = !alive || scoped ? 0 : 1 - ads * 0.65;
    const cq = Math.round(crossOp * 100) / 100;
    if (last.cross !== cq) { last.cross = cq; el.cross.style.opacity = cq; }
    if (last.scopek !== kind) {
      last.scopek = kind;
      if (kind > 0) el.scope.dataset.k = String(kind);
      el.scope.style.opacity = kind > 0 ? 1 : 0;
    }
    // crosshair gap follows the real spread (hip vs aimed, bloom while spraying), smoothed
    if (s.crossGap != null) {
      gapSm += (s.crossGap - gapSm) * 0.4;
      const gq = Math.round(gapSm * 2) / 2;
      if (last.gap !== gq) { last.gap = gq; el.cross.style.setProperty('--g', gq + 'px'); }
    }

    if (s.slots) {
      for (let i = 0; i < 3; i++) {
        const sl = s.slots[i];
        if (!sl) continue;
        const b = wsBtns[i];
        setText('wsn' + i, b.children[1], sl.name);
        setText('wsa' + i, b.children[2], sl.att > 0 ? '+' + sl.att : '');
        setCls('wson' + i, b, 'on', i === s.slot);
      }
    }

    const hp = Math.max(0, Math.min(100, Math.round(s.health == null ? 100 : s.health)));
    setText('hp', el.hnum, String(hp));
    if (last.hpw !== hp) {
      last.hpw = hp;
      el.hfill.style.transform = 'scaleX(' + hp / 100 + ')';
      el.vig.style.opacity = alive ? Math.max(0, (60 - hp) / 60).toFixed(2) : 0.6;
    }
    setCls('lowhp', rootEl, 'hs-low', alive && hp <= 30);

    setText('wname', el.wname, String(s.weaponName || '').toUpperCase());
    setText('cur', el.cur, String(s.ammo == null ? 0 : s.ammo));
    setText('mag', el.mag, String(s.magSize == null ? 0 : s.magSize));
    setCls('ammolow', el.ammo, 'low', s.magSize > 0 && s.ammo <= Math.ceil(s.magSize * 0.25));
    setCls('reloading', el.reload, 'on', s.reloading);

    const sp = s.speed || 0;
    setText('speed', el.speedNum, sp.toFixed(1));
    const sf = Math.min(1, sp / SPEED_BAR_MAX), sfq = Math.round(sf * 100);
    if (last.sf !== sfq) {
      last.sf = sfq;
      el.speedFill.style.transform = 'scaleX(' + sf.toFixed(3) + ')';
    }
    setCls('fast', rootEl, 'hs-fast', sp > 11);

    setText('fps', el.fps, s.fps != null ? Math.round(s.fps) + ' FPS' : '');
    setText('ping', el.ping, s.ping != null ? Math.round(s.ping) + ' ms' : '');
    setText('q', el.q, netQualityText(s.quality));
    setText('pl', el.pl, s.players != null ? s.players + ' players' : '');

    setText('dsub', el.dsub, !alive ? (s.respawnIn > 0 ? 'Respawning in ' + Math.max(0, s.respawnIn).toFixed(1) + 's' : 'Respawning...') : '');
  }

  function addKill(k) {
    const row = document.createElement('div');
    row.className = 'hs-kill' + (k.localInvolved ? ' me' : '');
    const kn = document.createElement('b'); kn.textContent = k.killerName || '';
    const wp = document.createElement('span'); wp.className = 'wp'; wp.textContent = String(k.weaponName || k.weaponKey || '').toUpperCase();
    const vn = document.createElement('b'); vn.textContent = k.victimName || '';
    row.appendChild(kn); row.appendChild(wp);
    if (k.headshot) { const h = document.createElement('i'); h.className = 'hs'; h.title = 'Headshot'; row.appendChild(h); }
    row.appendChild(vn);
    el.feed.appendChild(row);
    while (el.feed.children.length > MAX_FEED) el.feed.removeChild(el.feed.firstChild);
    setTimeout(() => {
      row.classList.add('out');
      setTimeout(() => { if (row.parentNode) row.parentNode.removeChild(row); }, 400);
    }, FEED_MS);
  }

  function hitmarker(h) {
    el.hit.classList.toggle('head', !!(h && h.headshot));
    el.hit.classList.toggle('kill', !!(h && h.kill));
    restartAnim(el.hit, 'pop');
  }

  function damageFrom(angle) {
    const d = dmgEls[dmgNext]; dmgNext = (dmgNext + 1) % dmgEls.length;
    d.style.transform = 'rotate(' + (-(angle || 0)).toFixed(3) + 'rad)';
    restartAnim(d, 'on');
    restartAnim(el.vig, 'flash');
  }

  function setScoreboard(visible, data) {
    match.setScoreboard(visible, data);
    sbVisible = !!visible;
    if (visible && data) { sbData = data; augmentBoard(); }
  }

  // ---- voice chat ----
  let voice = null, vVer = -1;
  const vb = { box: $('.hs-voice'), mic: $('.hs-vmic'), spk: $('.hs-vspk'), note: $('.hs-vnote'), tags: $('.hs-vtags') };
  function attachVoice(v) { voice = v; vVer = -1; lobby.attachVoice(v); }
  // same pattern as the weapon bar: act on pointerdown (phones may never send a click past the touch layer)
  for (const [b, act] of [[vb.mic, () => voice && voice.toggleMic()], [vb.spk, () => voice && voice.toggleSpeaker()]]) {
    let at = -1e9;
    b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); at = e.timeStamp; act(); });
    b.addEventListener('click', (e) => { e.stopPropagation(); if (e.timeStamp - at < 800) return; act(); });
  }
  function renderVoiceBar() {
    const v = voice.view;
    const ms = v.mic;
    if (vb.mic.dataset.s !== ms) {
      vb.mic.dataset.s = ms;
      vb.mic.innerHTML = ms === 'on' || ms === 'ptt' || ms === 'pending' ? VOICE_ICON.mic : VOICE_ICON.micOff;
    }
    const lab = micLabel(ms, v.pttKey);
    if (vb.mic.title !== lab) { vb.mic.title = lab; vb.mic.setAttribute('aria-label', lab); }
    const ss = v.spk ? 'on' : 'off';
    if (vb.spk.dataset.s !== ss) {
      vb.spk.dataset.s = ss;
      vb.spk.innerHTML = v.spk ? VOICE_ICON.spk : VOICE_ICON.spkOff;
      const sl = v.spk ? 'Speaker on - tap to stop hearing others' : 'Speaker off - tap to hear others';
      vb.spk.title = sl; vb.spk.setAttribute('aria-label', sl);
    }
  }
  let noteTimer = 0;
  function voiceNotice(text) {
    vb.note.textContent = text || '';
    vb.note.classList.toggle('on', !!text);
    clearTimeout(noteTimer);
    if (text) noteTimer = setTimeout(() => vb.note.classList.remove('on'), 4500);
  }

  // speaking wave next to a talking player's name tag (HTML overlay over the WebGL tag atlas)
  const VT = 10, vt = [];
  for (let i = 0; i < VT; i++) {
    const d = document.createElement('div');
    d.className = 'hs-vt'; d.innerHTML = VOICE_ICON.wave;
    vb.tags.appendChild(d);
    vt.push({ d, on: false, x: -1, y: -1, a: -1 });
  }
  const tagW = new Map();
  let measure = null;
  /** Half the on-screen width of a name tag (mirrors render.js drawTag: 24px bold text + 26 px, 0.5 px per texel). */
  function tagHalf(name) {
    let w = tagW.get(name);
    if (w === undefined) {
      if (!measure) { measure = document.createElement('canvas').getContext('2d'); measure.font = '700 24px system-ui, -apple-system, "Segoe UI", sans-serif'; }
      w = Math.min(314, measure.measureText(name || '').width + 26) * 0.25;
      if (tagW.size > 64) tagW.clear();
      tagW.set(name, w);
    }
    return w;
  }
  const _vs = { x: 0, y: 0, z: 0 };
  let alphas = null, alphasAt = -1e9;
  function updateTags(c) {
    let n = 0;
    if (c.playing && c.players) {
      const ps = c.players;
      for (let i = 0; i < ps.length && n < VT; i++) {
        const p = ps[i];
        if (!p.alive || !voice.isSpeaking(p.id)) continue;
        if (c.now - alphasAt > 100) { alphas = c.tagAlpha ? c.tagAlpha() : null; alphasAt = c.now; }
        const a = alphas && i < alphas.length ? alphas[i] : 1;
        if (a < 0.05) continue;
        const head = p.y + 1.8 - (p.sliding ? 0.9 : p.crouching ? 0.7 : 0) + 0.1;
        c.view(p.x, head, p.z, _vs);
        if (_vs.z > -0.6) continue;
        const f = (c.H / 2) / Math.tan((c.fov * Math.PI) / 360);
        const x = Math.round(c.W / 2 + f * _vs.x / -_vs.z + tagHalf(p.name) + 10), y = Math.round(c.H / 2 - f * _vs.y / -_vs.z - 16);
        const t = vt[n++];
        if (!t.on) { t.on = true; t.d.style.display = 'block'; }
        if (t.x !== x || t.y !== y) { t.x = x; t.y = y; t.d.style.transform = 'translate(' + x + 'px,' + y + 'px)'; }
        const aq = Math.round(a * 20) / 20;
        if (t.a !== aq) { t.a = aq; t.d.style.opacity = String(aq); }
      }
    }
    for (let i = n; i < VT; i++) if (vt[i].on) { vt[i].on = false; vt[i].d.style.display = 'none'; }
  }

  // scoreboard: a Voice cell per row (speaking wave, mute, volume). matchhud.js renders the rows without
  // ids, so rows are matched back to the board data by name + K/D within their table.
  let sbData = null, sbVisible = false;
  const sbCells = new Map();          // id -> { td, mute, range }
  const sbBoard = $('.hs-score .hs-board');
  const sbHint = document.createElement('div');
  sbHint.className = 'hs-sbvhint';
  sbBoard.parentNode.appendChild(sbHint);
  function setBoardHint(text) { if (sbHint.textContent !== (text || '')) sbHint.textContent = text || ''; }
  function syncCell(id, c) {
    const inf = voice.info(id);
    if (!inf) return;
    c.td.classList.toggle('vs', inf.speaking);
    if (c.mute) {
      if (c.muted !== inf.muted) {
        c.muted = inf.muted;
        c.mute.innerHTML = inf.muted ? VOICE_ICON.spkOff : VOICE_ICON.spk;
        c.mute.classList.toggle('on', inf.muted);
        c.mute.title = (inf.muted ? 'Unmute ' : 'Mute ') + c.name;
      }
      if (document.activeElement !== c.range && +c.range.value !== inf.volume) c.range.value = String(inf.volume);
      c.td.classList.toggle('vx', !inf.allowed);
    } else c.td.classList.toggle('voff', !inf.mic);
  }
  function augmentBoard() {
    if (!voice || !voice.enabled || !sbData) return;
    const tables = sbBoard.getElementsByTagName('table');
    let fresh = false;
    for (let i = 0; i < tables.length; i++) if (!tables[i].dataset.v) { fresh = true; break; }
    if (!fresh) return;
    sbCells.clear();
    const order = sbData.myTeam === 'b' ? ['b', 'a'] : ['a', 'b'];
    for (let ti = 0; ti < tables.length; ti++) {
      const t = tables[ti];
      t.dataset.v = '1';
      const team = sbData.teams ? order[ti] : null;
      const cand = sbData.rows.filter((r) => !sbData.teams || r.team === team);
      const used = new Set();
      const htr = t.tHead && t.tHead.rows[0];
      if (htr) { const th = document.createElement('th'); th.className = 'vc'; th.textContent = 'Voice'; htr.appendChild(th); }
      const body = t.tBodies[0];
      if (!body) continue;
      for (const tr of body.rows) {
        const nm = tr.cells[1] && tr.cells[1].firstChild ? tr.cells[1].firstChild.textContent : '';
        const k = +(tr.cells[2] ? tr.cells[2].textContent : 0), dd = +(tr.cells[3] ? tr.cells[3].textContent : 0);
        const r = cand.find((x) => !used.has(x) && x.name === nm && (x.kills | 0) === k && (x.deaths | 0) === dd) || cand.find((x) => !used.has(x) && x.name === nm);
        const td = document.createElement('td');
        td.className = 'vc';
        tr.appendChild(td);
        if (!r) continue;
        used.add(r);
        if (r.isBot) continue;
        const inf = voice.info(r.id);
        if (!inf) continue;
        td.innerHTML = VOICE_ICON.wave + (inf.self ? VOICE_ICON.micTiny : '');
        const c = { td, mute: null, range: null, muted: null, name: r.name };
        if (!inf.self) {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'hs-vmute';
          const rg = document.createElement('input'); rg.type = 'range'; rg.min = '0'; rg.max = '2'; rg.step = '0.05'; rg.className = 'hs-vvol';
          rg.setAttribute('aria-label', 'Volume of ' + r.name);
          b.addEventListener('click', () => { const i2 = voice.info(r.id); if (i2) { voice.setPeerMuted(r.id, !i2.muted); syncCell(r.id, c); } });
          rg.addEventListener('input', () => voice.setPeerVolume(r.id, +rg.value));
          for (const ev of ['keydown', 'keyup']) rg.addEventListener(ev, (e) => e.stopPropagation());
          td.append(b, rg);
          c.mute = b; c.range = rg;
        }
        // the touch scoreboard closes on a tap anywhere in the panel: not on these controls
        td.addEventListener('click', (e) => e.stopPropagation());
        td.addEventListener('pointerdown', (e) => e.stopPropagation());
        sbCells.set(r.id, c);
        syncCell(r.id, c);
      }
    }
  }

  let vSpeak = -1, sbVer = -1;
  /** Per frame. c = { now, playing, players, view(x,y,z,out), W, H, fov, tagAlpha() } */
  function voiceFrame(c) {
    const on = !!(voice && voice.enabled);
    setCls('hasvoice', rootEl, 'hs-hasvoice', on);
    if (!on) { if (vt[0].on || vt[1].on) for (const t of vt) if (t.on) { t.on = false; t.d.style.display = 'none'; } return; }
    if (voice.version !== vVer) { vVer = voice.version; renderVoiceBar(); }
    setCls('vtalk', vb.mic, 'talk', voice.view.selfSpeaking);
    updateTags(c);
    if (sbVisible && sbCells.size && (voice.speakVersion !== vSpeak || voice.version !== sbVer)) {
      vSpeak = voice.speakVersion; sbVer = voice.version;
      for (const [id, cell] of sbCells) syncCell(id, cell);
    }
  }

  // ---- settings controls (generated from SET_DEFS) ----
  const setHost = $('.hs-settings');
  const ctl = {};            // key -> { def, input, out }
  const cur = {};            // current values, as sent to onSettings
  function emitSettings() {
    if (!menuCb || !menuCb.onSettings) return;
    menuCb.onSettings({ ...cur });
  }
  function applyPrefs(st) {
    if (!st) return;
    if (typeof st.crosshairColor === 'string') rootEl.style.setProperty('--xh-c', st.crosshairColor);
    if (Number.isFinite(st.crosshairSize)) rootEl.style.setProperty('--xh-s', String(st.crosshairSize));
    if (st.showStats !== undefined) rootEl.classList.toggle('hs-nostats', !st.showStats);
    if (st.stickSide !== undefined) rootEl.classList.toggle('hs-stick-right', st.stickSide === 'right');
    if (Number.isFinite(st.btnScale)) rootEl.style.setProperty('--vbs', String(Math.max(0.9, Math.min(1.5, st.btnScale))));
  }
  function setControl(k, v) {
    const c = ctl[k];
    if (!c) return;
    cur[k] = v;
    if (c.def.type === 'check') c.input.checked = !!v;
    else if (c.def.type === 'swatch') c.input.forEach((b) => b.classList.toggle('on', b.dataset.v.toLowerCase() === String(v).toLowerCase()));
    else if (c.def.type === 'select') c.input.value = v;
    else {
      const d = c.def;
      c.input.min = Math.min(d.min, v); c.input.max = Math.max(d.max, v); c.input.step = d.step; c.input.value = v;
      c.out.textContent = d.fmt(v);
    }
  }
  function buildSettings() {
    const groups = [];
    for (const g of SET_DEFS) {
      if (g.touch && !TOUCH) continue;
      const d = document.createElement('details');
      d.className = 'hs-sgroup';
      const sm = document.createElement('summary');
      sm.textContent = g.title;
      d.appendChild(sm);
      const body = document.createElement('div');
      body.className = 'hs-sbody';
      d.appendChild(body);
      for (const it of g.items) {
        if (it.desktop && TOUCH) continue;
        let row = document.createElement('label');
        row.className = 'hs-set hs-set-' + it.type;
        const name = document.createElement('span');
        name.textContent = it.label;
        if (it.type === 'range') {
          const inp = document.createElement('input'); inp.type = 'range';
          const out = document.createElement('output');
          row.append(name, inp, out);
          ctl[it.k] = { def: it, input: inp, out };
          inp.addEventListener('input', () => { cur[it.k] = +inp.value; out.textContent = it.fmt(+inp.value); emitSettings(); });
        } else if (it.type === 'check') {
          const inp = document.createElement('input'); inp.type = 'checkbox';
          row.append(inp, name);
          ctl[it.k] = { def: it, input: inp };
          inp.addEventListener('change', () => { cur[it.k] = inp.checked; emitSettings(); });
        } else if (it.type === 'select') {
          const sel = document.createElement('select');
          for (const [v, t] of it.options) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
          row.append(name, sel);
          ctl[it.k] = { def: it, input: sel };
          sel.addEventListener('change', () => { cur[it.k] = sel.value; emitSettings(); });
        } else if (it.type === 'swatch') {
          const wrap = document.createElement('div'); wrap.className = 'hs-swatches';
          const btns = CROSSHAIR_COLORS.map((c) => {
            const b = document.createElement('button'); b.type = 'button'; b.dataset.v = c; b.style.background = c; b.setAttribute('aria-label', 'Crosshair colour ' + c);
            b.addEventListener('click', () => { cur[it.k] = c; setControl(it.k, c); emitSettings(); });
            wrap.appendChild(b); return b;
          });
          row = document.createElement('div'); row.className = 'hs-set hs-set-swatch';
          row.append(name, wrap);
          ctl[it.k] = { def: it, input: btns };
        }
        body.appendChild(row);
      }
      groups.push(d);
      setHost.appendChild(d);
    }
    // accordion: opening one group closes the others (keeps the pane short on a phone)
    for (const d of groups) d.addEventListener('toggle', () => { if (d.open) for (const o of groups) if (o !== d) o.open = false; });
    const first = TOUCH ? groups[groups.length - 1] : groups[0];
    if (first) first.open = true;
  }
  buildSettings();

  // ---- (v6) player code: the memory identity, copy / paste between devices (hidden unless memory is on)
  const pc = document.createElement('details');
  pc.className = 'hs-sgroup hs-pcode';
  pc.hidden = true;
  pc.innerHTML = `<summary>Player code</summary><div class="hs-sbody">
      <p class="hs-linknote">Your history on this server (AI bots tune to you, the lobby can suggest maps) is tied to this code. Copy it to play on another device. Clearing your browser data without saving it loses your history.</p>
      <div class="hs-pcrow"><input type="password" class="hs-pcval" readonly spellcheck="false" autocomplete="off" aria-label="Your player code" /><button type="button" class="hs-btn hs-pcshow">Show</button><button type="button" class="hs-btn hs-pccopy">Copy</button></div>
      <div class="hs-row"><input type="text" class="hs-pcin" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="Paste a code from another device" aria-label="Use a player code" /><button type="button" class="hs-btn hs-pcuse">Use</button></div>
      <p class="hs-linknote hs-pcmsg" role="status"></p>
    </div>`;
  setHost.appendChild(pc);
  pc.addEventListener('toggle', () => { if (pc.open) for (const o of setHost.querySelectorAll('.hs-sgroup')) if (o !== pc) o.open = false; });
  for (const o of setHost.querySelectorAll('.hs-sgroup')) if (o !== pc) o.addEventListener('toggle', () => { if (o.open) pc.open = false; });
  const pcEl = { val: pc.querySelector('.hs-pcval'), show: pc.querySelector('.hs-pcshow'), copy: pc.querySelector('.hs-pccopy'), inp: pc.querySelector('.hs-pcin'), use: pc.querySelector('.hs-pcuse'), msg: pc.querySelector('.hs-pcmsg') };
  let pcInfo = null;
  function setPlayerCode(info) {
    pcInfo = info || null;
    const on = !!(pcInfo && pcInfo.enabled && pcInfo.code);
    pc.hidden = !on;
    if (on && pcEl.val.value !== pcInfo.code) pcEl.val.value = pcInfo.code;
  }
  pcEl.show.addEventListener('click', () => { const hid = pcEl.val.type === 'password'; pcEl.val.type = hid ? 'text' : 'password'; pcEl.show.textContent = hid ? 'Hide' : 'Show'; });
  pcEl.copy.addEventListener('click', async () => {
    const t = pcEl.val.type; pcEl.val.type = 'text';
    const ok = await copyToClipboard(pcEl.val.value, pcEl.val);
    pcEl.val.type = t;
    pcEl.msg.textContent = ok ? 'Copied. Keep it somewhere safe - anyone with it plays as you.' : 'Select the code and copy it.';
  });
  pcEl.use.addEventListener('click', () => {
    if (!pcInfo || !pcInfo.onUse) return;
    pcEl.msg.textContent = pcInfo.onUse(pcEl.inp.value.trim()) || '';
    pcEl.inp.value = '';
  });
  for (const inp of [pcEl.val, pcEl.inp]) {
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (inp === pcEl.inp && e.key === 'Enter') pcEl.use.click(); });
    inp.addEventListener('keyup', (e) => e.stopPropagation());
  }

  // ---- loadout editor (the Loadout tab) ----
  const editor = createLoadoutEditor($('.hs-loadout'), {
    onChange(v) { if (menuCb && menuCb.loadout && menuCb.loadout.onChange) menuCb.loadout.onChange(v); },
    onPlay() { play(); },
  });
  function setLoadoutStatus(st) { editor.setStatus(st); }
  function setLoadoutTip(text) { editor.setTip(text); }

  // ---- tabs ----
  const tabBtns = Array.from(rootEl.querySelectorAll('.hs-tabs button'));
  const panes = Array.from(rootEl.querySelectorAll('.hs-pane'));
  let curTab = 'settings';
  function setTab(name) {
    curTab = name;
    el.card.classList.toggle('lo-mode', name === 'loadout');
    if (name === 'loadout') editor.refresh();
    for (const b of tabBtns) { const on = b.dataset.tab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); }
    for (const p of panes) p.classList.toggle('on', p.dataset.pane === name);
  }
  for (const b of tabBtns) b.addEventListener('click', () => setTab(b.dataset.tab));
  setTab('settings');

  function showMenu(o) {
    menuCb = o || {};
    const st = menuCb.settings || {};
    el.name.value = menuCb.defaultName || '';
    for (const k in ctl) if (st[k] !== undefined) setControl(k, st[k]);
    applyPrefs(st);
    el.play.textContent = menuCb.playLabel || (menuCb.inGame ? 'RESUME' : 'PLAY');
    editor.setPlayLabel(el.play.textContent);
    if (menuCb.loadout) { editor.setState(menuCb.loadout.saved); if (menuCb.loadout.status) editor.setStatus(menuCb.loadout.status); }
    applyRoom(menuCb.room);
    setTab(menuCb.tab || curTab);
    el.menu.classList.add('on');
    rootEl.classList.add('hs-menuopen');
    match.setScoreboard(false);
    if (!TOUCH) setTimeout(() => el.name.focus(), 0);     // a focused field would pop the keyboard on phones
  }
  function setPrefs(st) { applyPrefs(st); }
  function play() {
    if (!menuCb) return;
    const nm = el.name.value.trim().slice(0, 16) || menuCb.defaultName || 'Player';
    if (menuCb.onPlay) menuCb.onPlay(nm);
  }
  el.play.addEventListener('click', play);
  el.name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') play(); });
  el.name.addEventListener('keyup', (e) => e.stopPropagation());
  function hideMenu() { el.menu.classList.remove('on'); rootEl.classList.remove('hs-menuopen'); }

  // ---- play with friends: private rooms + invite link
  const fr = {
    lobby: $('.hs-lobby'), invite: $('.hs-invite'), code: $('.hs-code'), join: $('.hs-join'),
    create: $('.hs-create'), bots: $('.hs-bots'), roomCode: $('.hs-roomcode'), roomBots: $('.hs-roombots'),
    link: $('.hs-link'), copy: $('.hs-copy'), note: $('.hs-linknote'), leave: $('.hs-leave'),
  };
  function setInvite(url, note) { fr.link.value = url || ''; fr.note.textContent = note || ''; }
  function applyRoom(room) {
    const r = room || {};
    const inRoom = !!r.code;
    fr.invite.style.display = inRoom ? '' : 'none';
    fr.lobby.style.display = inRoom ? 'none' : '';
    if (inRoom) {
      fr.roomCode.textContent = r.code;
      fr.roomBots.textContent = r.bots === 0 ? 'no bots' : 'bots fill empty slots';
      setInvite(r.inviteUrl, r.note);
    }
  }
  const roomCb = () => (menuCb && menuCb.room) || {};
  const typedName = () => el.name.value.trim().slice(0, 16);
  fr.create.addEventListener('click', () => { const r = roomCb(); if (r.onCreate) r.onCreate(fr.bots.checked, typedName()); });
  function joinCode() { const c = fr.code.value.trim(); const r = roomCb(); if (c && r.onJoin) r.onJoin(c, typedName()); }
  fr.join.addEventListener('click', joinCode);
  fr.leave.addEventListener('click', () => { const r = roomCb(); if (r.onLeave) r.onLeave(typedName()); });
  fr.copy.addEventListener('click', async () => {
    const ok = await copyToClipboard(fr.link.value, fr.link);
    fr.copy.textContent = ok ? 'Copied' : 'Press Ctrl/Cmd+C';
    setTimeout(() => { fr.copy.textContent = 'Copy'; }, 1800);
  });
  for (const inp of [fr.code, fr.link]) {
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (inp === fr.code && e.key === 'Enter') joinCode(); });
    inp.addEventListener('keyup', (e) => e.stopPropagation());
  }

  // ---- server availability: pill in the menu, overlay while the server is waking up
  const sv = { box: $('.hs-server'), text: $('.hs-server span'), wake: $('.hs-wake'), title: $('.hs-wtitle'), sub: $('.hs-wsub') };
  let svKind = 'checking', svText = '', wakeOn = false, wakeTitle = '', wakeSub = '';
  function setServer(kind, text) {
    if (kind !== svKind) { svKind = kind; sv.box.dataset.state = kind; }
    if (text !== svText) { svText = text; sv.text.textContent = text; }
  }
  function setWake(visible, title, detail) {
    visible = !!visible;
    if (visible !== wakeOn) { wakeOn = visible; sv.wake.classList.toggle('on', visible); }
    if (!visible) return;
    if (title !== wakeTitle) { wakeTitle = title; sv.title.textContent = title || ''; }
    if (detail !== wakeSub) { wakeSub = detail; sv.sub.textContent = detail || ''; }
  }

  // ---- touch: rotate-to-landscape hint + tap the scoreboard to close it
  let inGame = false, portrait = false, hintDismissed = false;
  function syncRotate() {
    rootEl.classList.toggle('hs-portrait', portrait);
    rootEl.classList.toggle('hs-ingame', inGame);
    rootEl.classList.toggle('hs-hint', TOUCH && portrait && inGame && !hintDismissed);
  }
  function setInGame(v) { v = !!v; if (v !== inGame) { inGame = v; syncRotate(); } }
  if (TOUCH) {
    const mq = window.matchMedia ? window.matchMedia('(orientation: portrait)') : null;
    const onOrient = () => { portrait = mq ? mq.matches : window.innerHeight > window.innerWidth; if (!portrait) hintDismissed = false; syncRotate(); };
    if (mq) { if (mq.addEventListener) mq.addEventListener('change', onOrient); else if (mq.addListener) mq.addListener(onOrient); }
    window.addEventListener('resize', onOrient);
    onOrient();
    el.rotateGo.addEventListener('click', () => { hintDismissed = true; syncRotate(); });
  }

  function setStatus(text) {
    el.status.textContent = text || '';
    el.status.classList.toggle('on', !!text);
  }

  return { update, setLoadoutStatus, addKill, hitmarker, damageFrom, setScoreboard, showMenu, hideMenu, setPrefs, setInGame, setInvite, setServer, setWake, setStatus, setTab, match, lobby,
    attachVoice, voiceFrame, voiceNotice, setBoardHint, setPlayerCode, setLoadoutTip };
}
