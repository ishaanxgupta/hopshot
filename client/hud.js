// Hopshot HUD: pure DOM/CSS. Styles live in client/style.css (classes prefixed "hs-").
// update(state) is called every frame and only touches the DOM when a value actually changed.

// opts for createHud(rootEl, opts): { touch: bool, onScoreboardClose() }
// Extra methods beyond the base contract: setPrefs(settings) (crosshair, stats line), setInGame(bool)
// (rotate hint), showMenu({ ..., inGame, tab }) -> the menu is a two-pane card (play column +
// Settings / Friends / Controls tabs) that fits a 640x360 landscape phone.

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
  { id: 'touch', title: 'Touch controls', touch: true, items: [
    { k: 'stickSide', label: 'Move stick side', type: 'select', options: [['left', 'Left (buttons right)'], ['right', 'Right (buttons left)']] },
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
    <div class="hs-scope"><div class="ring"></div><div class="h"></div><div class="v"></div></div>

    <div class="hs-topleft"><span class="hs-fps"></span><span class="hs-ping"></span><span class="hs-q"></span><span class="hs-pl"></span></div>
    <div class="hs-topcenter">
      <div class="hs-timer">0:00</div>
      <div class="hs-kd"><span class="k"><b>0</b> KILLS</span><span class="d"><b>0</b> DEATHS</span></div>
    </div>
    <div class="hs-feed"></div>
    <div class="hs-status"></div>

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

    <div class="hs-score"><div class="hs-panel">
      <div class="hs-ptitle">SCOREBOARD</div>
      <table><thead><tr><th class="n">#</th><th class="nm">Player</th><th>Kills</th><th>Deaths</th><th>Ping</th></tr></thead><tbody></tbody></table>
    </div></div>

    <div class="hs-round"><div class="hs-panel">
      <div class="hs-ptitle">ROUND OVER</div>
      <div class="hs-winner"></div>
      <table><thead><tr><th class="n">#</th><th class="nm">Player</th><th>Kills</th><th>Deaths</th></tr></thead><tbody></tbody></table>
      <div class="hs-next"></div>
    </div></div>

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
          <button type="button" role="tab" data-tab="settings">Settings</button>
          <button type="button" role="tab" data-tab="friends">Friends</button>
          <button type="button" role="tab" data-tab="keys">Controls</button>
        </div>
        <div class="hs-tabbody">
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
              <div><kbd>Right side</kbd><em>Drag to look</em></div>
              <div><kbd>FIRE</kbd><em>Hold to shoot, drag it to aim</em></div>
              <div><kbd>JUMP</kbd><em>Hold to bunny-hop</em><kbd>SLIDE</kbd><em>Crouch / slide</em></div>
              <div><kbd>AIM</kbd><em>Toggle scope</em><kbd>&#8249; &#8250;</kbd><em>Weapon</em></div>
              <div><em>Top-left buttons: menu and scoreboard</em></div>
            </div>
          </section>
        </div>
      </div>
    </div></div>`;

  const $ = (sel) => rootEl.querySelector(sel);
  const el = {
    vig: $('.hs-vignette'), dmgWrap: $('.hs-dmg-wrap'), cross: $('.hs-cross'), hit: $('.hs-hit'), scope: $('.hs-scope'),
    fps: $('.hs-fps'), ping: $('.hs-ping'), q: $('.hs-q'), pl: $('.hs-pl'), timer: $('.hs-timer'),
    kills: $('.hs-kd .k b'), deaths: $('.hs-kd .d b'), feed: $('.hs-feed'), status: $('.hs-status'),
    hnum: $('.hs-hnum'), hfill: $('.hs-hbar .fill'), speedNum: $('.hs-speed .num'), speedFill: $('.hs-speed .fill'),
    wname: $('.hs-wname'), cur: $('.hs-ammo .cur'), mag: $('.hs-ammo .mag'), ammo: $('.hs-ammo'),
    reload: $('.hs-reload'), death: $('.hs-death'), dsub: $('.hs-dsub'),
    score: $('.hs-score'), scoreBody: $('.hs-score tbody'),
    round: $('.hs-round'), roundBody: $('.hs-round tbody'), winner: $('.hs-winner'), next: $('.hs-next'),
    menu: $('.hs-menu'), name: $('.hs-name'), play: $('.hs-play'),
    rotate: $('.hs-rotate'), rotateGo: $('.hs-rgo'),
  };

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
    const scoped = ads > 0.85 && s.weaponKey === 'scout';

    setCls('alive', rootEl, 'hs-dead', !alive);
    setCls('scoped', rootEl, 'hs-scoped', scoped && alive);
    // crosshair: fades out as you aim down sights, hidden when scoped
    const crossOp = !alive || scoped ? 0 : 1 - ads * 0.65;
    const cq = Math.round(crossOp * 100) / 100;
    if (last.cross !== cq) { last.cross = cq; el.cross.style.opacity = cq; }
    if (last.scopeop !== (scoped && alive)) { last.scopeop = scoped && alive; el.scope.style.opacity = scoped && alive ? 1 : 0; }

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

    setText('kills', el.kills, String(s.kills || 0));
    setText('deaths', el.deaths, String(s.deaths || 0));
    setText('timer', el.timer, fmtTime(s.roundTimeLeft));
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
    const wp = document.createElement('span'); wp.className = 'wp'; wp.textContent = String(k.weaponKey || '').toUpperCase();
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

  let sbSig = '';
  // On a short screen only the top rows fit: show the leaders plus the local player's own row.
  function maxRows() { const h = window.innerHeight; return h < 460 ? 7 : h < 620 ? 11 : 24; }
  function fillRows(body, rows, withPing) {
    body.textContent = '';
    const sorted = rows.slice().sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
    const cap = maxRows();
    const shown = [];
    sorted.forEach((r, i) => { shown.push({ r, i }); });
    let list = shown;
    if (shown.length > cap) {
      list = shown.slice(0, cap - 1);
      const me = shown.find((x) => x.r.isLocal);
      list.push(me && me.i >= cap - 1 ? me : shown[cap - 1]);
    }
    list.forEach(({ r, i }) => {
      const tr = document.createElement('tr');
      if (r.isLocal) tr.className = 'me';
      const cells = [String(i + 1), null, String(r.kills | 0), String(r.deaths | 0)];
      if (withPing) cells.push(r.isBot ? 'BOT' : String(Math.round(r.ping || 0)));
      cells.forEach((c, ci) => {
        const td = document.createElement('td');
        if (ci === 1) { td.className = 'nm'; td.textContent = r.name || ''; if (r.isBot) { const t = document.createElement('em'); t.textContent = 'bot'; td.appendChild(t); } }
        else { if (ci === 0) td.className = 'n'; td.textContent = c; }
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }
  function setScoreboard(visible, rows) {
    el.score.classList.toggle('on', !!visible);
    if (!visible || !rows) return;
    let sig = '';
    for (let i = 0; i < rows.length; i++) { const r = rows[i]; sig += r.id + '|' + r.name + '|' + r.kills + '|' + r.deaths + '|' + (r.ping | 0) + '|' + (r.isLocal ? 1 : 0) + ';'; }
    if (sig === sbSig) return;
    sbSig = sig;
    fillRows(el.scoreBody, rows, true);
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

  // ---- tabs ----
  const tabBtns = Array.from(rootEl.querySelectorAll('.hs-tabs button'));
  const panes = Array.from(rootEl.querySelectorAll('.hs-pane'));
  let curTab = 'settings';
  function setTab(name) {
    curTab = name;
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
    el.play.textContent = menuCb.inGame ? 'RESUME' : 'PLAY';
    applyRoom(menuCb.room);
    setTab(menuCb.tab || curTab);
    el.menu.classList.add('on');
    rootEl.classList.add('hs-menuopen');
    el.score.classList.remove('on');
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
    const text = fr.link.value;
    if (!text) return;
    let ok = false;
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch { /* fall through */ }
    if (!ok) { fr.link.focus(); fr.link.select(); try { ok = document.execCommand('copy'); } catch { /* manual copy */ } }
    fr.copy.textContent = ok ? 'Copied' : 'Press Ctrl/Cmd+C';
    setTimeout(() => { fr.copy.textContent = 'Copy'; }, 1800);
  });
  for (const inp of [fr.code, fr.link]) {
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (inp === fr.code && e.key === 'Enter') joinCode(); });
    inp.addEventListener('keyup', (e) => e.stopPropagation());
  }

  let nextTimer = 0;
  function showRoundEnd(o) {
    el.winner.textContent = o && o.winnerName ? o.winnerName + ' wins!' : 'Round complete';
    fillRows(el.roundBody, (o && o.rows) || [], false);
    el.round.classList.add('on');
    el.score.classList.remove('on');
    clearInterval(nextTimer);
    let n = Math.max(0, Math.ceil((o && o.nextIn) || 0));
    el.next.textContent = n > 0 ? 'Next round in ' + n + 's' : '';
    if (n > 0) {
      nextTimer = setInterval(() => {
        n--;
        el.next.textContent = n > 0 ? 'Next round in ' + n + 's' : 'Starting...';
        if (n <= 0) clearInterval(nextTimer);
      }, 1000);
    }
  }
  function hideRoundEnd() { clearInterval(nextTimer); el.round.classList.remove('on'); }

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
    $('.hs-score .hs-panel').addEventListener('click', () => {
      el.score.classList.remove('on');
      if (hudOpts.onScoreboardClose) hudOpts.onScoreboardClose();
    });
  }

  function setStatus(text) {
    el.status.textContent = text || '';
    el.status.classList.toggle('on', !!text);
  }

  return { update, addKill, hitmarker, damageFrom, setScoreboard, showMenu, hideMenu, setPrefs, setInGame, setInvite, setServer, setWake, showRoundEnd, hideRoundEnd, setStatus };
}
