// Hopshot private-room lobby screen (DOM + one small canvas per map card).
//
//   const lobby = createLobby(hostEl, { touch, onConfig(partial) -> requested config, onStart(), onTeam(team),
//                                       onLoadout(), onMenu() });
//   lobby.update(match, ctx)   match = net.state.match, ctx = { selfId, inviteUrl, inviteNote, code }
//                              (cheap: DOM is touched only when something changed)
//   lobby.notice(text)         a short toast (rejected request, ...)
//
// The host edits mode / map / bots / limits; everybody else sees the same controls read-only with
// "Waiting for host". The lobby never sends anything by itself: it calls the callbacks, and shows what
// the server says (net.state.match.config), plus a short-lived local echo so steppers feel instant.

import { MODES, MODE_IDS, TEAM_NAMES, TIME_LIMIT_MIN_S, TIME_LIMIT_MAX_S } from '../shared/modes.js';
import { MAPS } from '../shared/maps/index.js';
import { MAX_PLAYERS } from '../shared/constants.js';
import { teamRel, relCss } from './teams.js';

const TIME_STEPS = [60, 120, 180, 300, 420, 600, 900, 1200, 1800];
const SIZE_LABEL = { small: 'Small · 2-8', medium: 'Medium · 4-12', large: 'Large · 8-20' };
const UNIT_LABEL = { kills: 'kills', captures: 'captures', points: 'points' };
const ECHO_MS = 900;

export async function copyToClipboard(text, inputEl) {
  if (!text) return false;
  let ok = false;
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; } } catch { /* fall through */ }
  if (!ok && inputEl) { inputEl.focus(); inputEl.select(); try { ok = document.execCommand('copy'); } catch { /* manual copy */ } }
  return ok;
}

function fmtMin(s) {
  const m = Math.floor(s / 60), r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

/** Top-down thumbnail of a map from its boxes, in the map's own palette. */
function drawThumb(cv, map) {
  const S = cv.width, g = cv.getContext('2d');
  const th = map.theme || {};
  g.fillStyle = '#0d1424';
  g.fillRect(0, 0, S, S);
  const b = map.bounds;
  const x0 = b.min[0], x1 = b.max[0], z0 = b.min[2], z1 = b.max[2];
  const pad = S * 0.06;
  const sc = Math.min((S - pad * 2) / (x1 - x0), (S - pad * 2) / (z1 - z0));
  const ox = (S - (x1 - x0) * sc) / 2, oz = (S - (z1 - z0) * sc) / 2;
  const px = (x) => ox + (x - x0) * sc, pz = (z) => oz + (z - z0) * sc;
  const hex = (c, k) => {
    const r = Math.min(255, ((c >> 16) & 255) * k), gg = Math.min(255, ((c >> 8) & 255) * k), bb = Math.min(255, (c & 255) * k);
    return 'rgb(' + (r | 0) + ',' + (gg | 0) + ',' + (bb | 0) + ')';
  };
  const boxes = map.boxes.slice().sort((a, c) => a.max[1] - c.max[1]);
  for (const bx of boxes) {
    const top = bx.max[1];
    const k = top <= 0.05 ? 0.9 : 0.8 + Math.min(0.45, top / 14);
    g.fillStyle = hex(bx.color, k);
    g.fillRect(px(bx.min[0]), pz(bx.min[2]), Math.max(1, (bx.max[0] - bx.min[0]) * sc), Math.max(1, (bx.max[2] - bx.min[2]) * sc));
    if (top > 1.5) {
      g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1;
      g.strokeRect(px(bx.min[0]) + 0.5, pz(bx.min[2]) + 0.5, Math.max(1, (bx.max[0] - bx.min[0]) * sc) - 1, Math.max(1, (bx.max[2] - bx.min[2]) * sc) - 1);
    }
  }
  if (map.hardpoints) {
    g.strokeStyle = 'rgba(255,210,58,0.9)'; g.lineWidth = Math.max(1, S / 56); g.setLineDash([S / 28, S / 40]);
    for (const h of map.hardpoints) g.strokeRect(px(h.min[0]), pz(h.min[2]), (h.max[0] - h.min[0]) * sc, (h.max[2] - h.min[2]) * sc);
    g.setLineDash([]);
  }
  if (map.flags) {
    for (const [t, col] of [['a', '#3b9dff'], ['b', '#ff5047']]) {
      const f = map.flags[t];
      g.fillStyle = col; g.strokeStyle = '#fff'; g.lineWidth = Math.max(1, S / 56);
      g.beginPath(); g.arc(px(f[0]), pz(f[2]), S * 0.045, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }
  void th;
}

export function createLobby(host, o = {}) {
  host.innerHTML = `
    <div class="lb-card">
      <div class="lb-top">
        <div class="lb-room"><span>ROOM</span><b class="lb-code"></b></div>
        <div class="lb-link"><input type="text" class="lb-linkin" readonly spellcheck="false" aria-label="Invite link" /><button type="button" class="hs-btn lb-copy">Copy link</button></div>
        <div class="lb-acts"><button type="button" class="hs-btn lb-loadout">Loadout</button><button type="button" class="hs-btn lb-menu">Menu</button></div>
      </div>
      <div class="lb-body">
        <section class="lb-players">
          <div class="lb-sec"><span>PLAYERS</span><em class="lb-count"></em></div>
          <div class="lb-plist"></div>
          <div class="lb-pnote"></div>
          <button type="button" class="hs-btn lb-switch"></button>
        </section>
        <section class="lb-settings">
          <div class="lb-host"><i></i><span class="lb-hosttxt"></span></div>
          <div class="lb-sec"><span>MODE</span></div>
          <div class="lb-modes"></div>
          <div class="lb-sec"><span>MAP</span></div>
          <div class="lb-maps"></div>
          <div class="lb-sec"><span>BOTS</span></div>
          <div class="lb-bots">
            <div class="lb-seg" role="group" aria-label="Bots"><button type="button" data-b="off">Off</button><button type="button" data-b="fill">Fill</button><button type="button" data-b="coop">Co-op</button></div>
            <div class="lb-step lb-botn"><button type="button" data-d="-1" aria-label="Fewer">-</button><output></output><button type="button" data-d="1" aria-label="More">+</button></div>
          </div>
          <div class="lb-botnote"></div>
          <div class="lb-sec"><span>LIMITS</span></div>
          <div class="lb-limits">
            <div class="lb-lim lb-time"><span>Time</span><div class="lb-step"><button type="button" data-d="-1" aria-label="Shorter">-</button><output></output><button type="button" data-d="1" aria-label="Longer">+</button></div></div>
            <div class="lb-lim lb-score"><span>First to</span><div class="lb-step"><button type="button" data-d="-1" aria-label="Lower">-</button><output></output><button type="button" data-d="1" aria-label="Higher">+</button></div></div>
          </div>
        </section>
      </div>
      <div class="lb-foot">
        <span class="lb-why"></span>
        <button type="button" class="lb-start">START MATCH</button>
      </div>
      <div class="lb-toast" role="status"></div>
    </div>`;
  const $ = (s) => host.querySelector(s);
  const el = {
    code: $('.lb-code'), link: $('.lb-linkin'), copy: $('.lb-copy'), loadout: $('.lb-loadout'), menu: $('.lb-menu'),
    plist: $('.lb-plist'), count: $('.lb-count'), pnote: $('.lb-pnote'), sw: $('.lb-switch'),
    settings: $('.lb-settings'), hostTxt: $('.lb-hosttxt'), host: $('.lb-host'),
    modes: $('.lb-modes'), maps: $('.lb-maps'),
    seg: $('.lb-seg'), botn: $('.lb-botn'), botnOut: $('.lb-botn output'), botNote: $('.lb-botnote'),
    time: $('.lb-time'), timeOut: $('.lb-time output'), score: $('.lb-score'), scoreOut: $('.lb-score output'), scoreLab: $('.lb-score > span'),
    why: $('.lb-why'), start: $('.lb-start'), toast: $('.lb-toast'),
  };

  // ---- static cards ----
  const modeBtns = {};
  for (const id of MODE_IDS) {
    const m = MODES[id];
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'lb-mode'; b.dataset.id = id;
    b.innerHTML = '<b></b><span></span>';
    b.firstChild.textContent = m.name; b.lastChild.textContent = m.blurb;
    b.addEventListener('click', () => edit({ mode: id }));
    el.modes.appendChild(b);
    modeBtns[id] = b;
  }
  const mapBtns = {};
  for (const map of MAPS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'lb-map'; b.dataset.id = map.id;
    b.title = map.blurb || '';
    const cv = document.createElement('canvas');
    cv.width = cv.height = 112;
    b.appendChild(cv);
    const t = document.createElement('b'); t.textContent = map.name;
    const s = document.createElement('span'); s.textContent = SIZE_LABEL[map.size] || map.size;
    b.append(t, s);
    try { drawThumb(cv, map); } catch { /* thumbnails are decoration */ }
    b.addEventListener('click', () => edit({ mapId: map.id }));
    el.maps.appendChild(b);
    mapBtns[map.id] = b;
  }

  // ---- state ----
  let M = null, ctx = {}, isHost = false;
  let echo = null, echoUntil = 0;
  function cfgNow() {
    if (echo && performance.now() < echoUntil) return echo;
    echo = null;
    return M ? M.config : null;
  }
  // net merges a partial request into the SERVER's last config, so two quick edits (mode, then map) would
  // cancel each other; keep the edits of the last moment together and send them as one growing partial.
  let pend = null, pendUntil = 0;
  function edit(partial) {
    if (!isHost || !M || !o.onConfig) return;
    const t = performance.now();
    if (!pend || t > pendUntil) pend = {};
    if (partial.mode !== undefined && partial.scoreLimit === undefined) delete pend.scoreLimit;     // a new mode brings its own default limit
    Object.assign(pend, partial);
    pendUntil = t + 1500;
    const full = o.onConfig({ ...pend });
    if (full) { echo = full; echoUntil = performance.now() + ECHO_MS; }
    render(true);
  }

  // segmented bots + steppers
  const DEFAULT_FILL = 6;
  el.seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !isHost) return;
    const c = cfgNow(); if (!c) return;
    const fill = c.bots.fill > 0 ? c.bots.fill : DEFAULT_FILL;
    if (b.dataset.b === 'off') edit({ bots: { fill: 0 }, coop: false });
    else if (b.dataset.b === 'fill') edit({ bots: { fill }, coop: false });
    else if (b.dataset.b === 'coop' && MODES[c.mode].teams) edit({ bots: { fill }, coop: true });
  });
  el.botn.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !isHost) return;
    const c = cfgNow(); if (!c || c.bots.fill <= 0) return;
    edit({ bots: { fill: Math.max(2, Math.min(MAX_PLAYERS, c.bots.fill + (+b.dataset.d)) ) } });
  });
  el.time.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !isHost) return;
    const c = cfgNow(); if (!c) return;
    const d = +b.dataset.d;
    let next = c.timeLimitS;
    if (d > 0) next = TIME_STEPS.find((t) => t > c.timeLimitS) || TIME_LIMIT_MAX_S;
    else { for (let i = TIME_STEPS.length - 1; i >= 0; i--) if (TIME_STEPS[i] < c.timeLimitS) { next = TIME_STEPS[i]; break; } if (next === c.timeLimitS) next = TIME_LIMIT_MIN_S; }
    edit({ timeLimitS: next });
  });
  el.score.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !isHost) return;
    const c = cfgNow(); if (!c) return;
    const m = MODES[c.mode];
    const next = Math.max(m.scoreLimitMin, Math.min(m.scoreLimitMax, c.scoreLimit + (+b.dataset.d) * m.scoreLimitStep));
    edit({ scoreLimit: next });
  });

  el.copy.addEventListener('click', async () => {
    const ok = await copyToClipboard(el.link.value, el.link);
    el.copy.textContent = ok ? 'Copied' : 'Press Ctrl/Cmd+C';
    setTimeout(() => { el.copy.textContent = 'Copy link'; }, 1800);
  });
  el.link.addEventListener('keydown', (e) => e.stopPropagation());
  el.link.addEventListener('keyup', (e) => e.stopPropagation());
  el.link.addEventListener('focus', () => el.link.select());
  el.loadout.addEventListener('click', () => { if (o.onLoadout) o.onLoadout(); });
  el.menu.addEventListener('click', () => { if (o.onMenu) o.onMenu(); });
  el.start.addEventListener('click', () => { if (!el.start.disabled && o.onStart) o.onStart(); });
  el.sw.addEventListener('click', () => { if (el.sw.dataset.t && o.onTeam) o.onTeam(el.sw.dataset.t); });

  let toastTimer = 0;
  function notice(text) {
    el.toast.textContent = text;
    el.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('on'), 2600);
  }

  // ---- render ----
  const last = {};
  const set = (k, node, v) => { if (last[k] !== v) { last[k] = v; node.textContent = v; } };
  const cls = (k, node, c, on) => { on = !!on; if (last[k] !== on) { last[k] = on; node.classList.toggle(c, on); } };
  let plSig = '';

  function botsToAdd(c, humans) {
    if (c.bots.fill <= 0) return 0;
    if (c.coop) return Math.max(c.bots.fill - humans, humans);
    return Math.max(0, c.bots.fill - humans);
  }

  function renderPlayers(c) {
    const my = M.myTeam;
    const humans = M.lobby.filter((p) => !p.bot).length;
    const nb = botsToAdd(c, humans);
    let sig = (M.teams ? 't' : 'f') + (c.coop ? 'c' : '') + '|' + my + '|' + ctx.selfId + '|' + M.hostId + '|' + nb;
    for (const p of M.lobby) sig += ';' + p.id + ',' + p.name + ',' + p.team + ',' + (p.bot ? 1 : 0);
    if (sig === plSig) return;
    plSig = sig;
    el.plist.textContent = '';
    const row = (p) => {
      const d = document.createElement('div');
      d.className = 'lb-p' + (p.id === ctx.selfId ? ' me' : '');
      const n = document.createElement('span'); n.className = 'nm'; n.textContent = p.name || ('Player ' + p.id);
      d.appendChild(n);
      const tag = (t, c2) => { const e = document.createElement('em'); e.textContent = t; if (c2) e.className = c2; d.appendChild(e); };
      if (p.id === M.hostId && M.private) tag('HOST', 'host');
      if (p.bot) tag('BOT');
      if (p.id === ctx.selfId) tag('YOU', 'you');
      return d;
    };
    if (M.teams) {
      const order = my === 'b' ? ['b', 'a'] : ['a', 'b'];
      for (const t of order) {
        const list = M.lobby.filter((p) => p.team === t);
        const sec = document.createElement('div');
        const rel = teamRel(t, my);
        sec.className = 'lb-team ' + (rel === 1 ? 'friend' : 'enemy');
        const h = document.createElement('div'); h.className = 'lb-th';
        const nm = document.createElement('span'); nm.textContent = TEAM_NAMES[t] + (t === my ? ' (you)' : '');
        const ct = document.createElement('b');
        const extra = c.coop ? (t === 'b' ? nb : 0) : 0;
        ct.textContent = String(list.length + extra);
        h.append(nm, ct);
        sec.appendChild(h);
        for (const p of list) sec.appendChild(row(p));
        if (c.coop && t === 'b' && nb > 0) { const d = document.createElement('div'); d.className = 'lb-p ghost'; d.textContent = nb + ' bots'; sec.appendChild(d); }
        if (!list.length && !(c.coop && t === 'b' && nb > 0)) { const d = document.createElement('div'); d.className = 'lb-p ghost'; d.textContent = 'empty'; sec.appendChild(d); }
        el.plist.appendChild(sec);
      }
    } else {
      for (const p of M.lobby) el.plist.appendChild(row(p));
    }
    set('count', el.count, humans + (humans === 1 ? ' player' : ' players'));
    let note = '';
    if (nb > 0 && !c.coop) note = '+ ' + nb + ' bot' + (nb === 1 ? '' : 's') + ' will join at the start';
    else if (c.coop) note = 'Humans vs bots';
    set('pnote', el.pnote, note);
  }

  function render(force) {
    if (!M) return;
    const c = cfgNow();
    if (!c) return;
    const mi = MODES[c.mode];
    const humans = M.lobby.filter((p) => !p.bot).length;
    isHost = !!M.isHost;
    cls('ro', el.settings, 'ro', !isHost);
    cls('host', host, 'is-host', isHost);
    set('hosttxt', el.hostTxt, isHost ? 'You are the host. Pick the match.' : 'Waiting for host…');
    set('code', el.code, ctx.code || '');
    if (ctx.inviteUrl !== undefined && last.link !== ctx.inviteUrl) { last.link = ctx.inviteUrl; el.link.value = ctx.inviteUrl || ''; }

    for (const id of MODE_IDS) cls('m' + id, modeBtns[id], 'on', c.mode === id);
    for (const map of MAPS) cls('p' + map.id, mapBtns[map.id], 'on', c.mapId === map.id);
    for (const id of MODE_IDS) modeBtns[id].disabled = !isHost;
    for (const map of MAPS) mapBtns[map.id].disabled = !isHost;

    // bots
    const bmode = c.bots.fill <= 0 ? 'off' : c.coop ? 'coop' : 'fill';
    for (const b of el.seg.children) {
      const on = b.dataset.b === bmode;
      cls('bs' + b.dataset.b, b, 'on', on);
      b.disabled = !isHost || (b.dataset.b === 'coop' && !mi.teams);
    }
    cls('botnOff', el.botn, 'off', bmode === 'off');
    set('botn', el.botnOut, bmode === 'off' ? '-' : String(c.bots.fill));
    for (const b of el.botn.querySelectorAll('button')) b.disabled = !isHost || bmode === 'off';
    set('botnote', el.botNote, bmode === 'off' ? 'No bots. Only the people in the room play.'
      : bmode === 'coop' ? 'Humans on Team A against bots on Team B, up to ' + c.bots.fill + ' players.'
        : 'Bots fill the room up to ' + c.bots.fill + ' players' + (mi.teams ? ' and keep the teams even.' : '.'));

    // limits
    set('time', el.timeOut, fmtMin(c.timeLimitS));
    set('score', el.scoreOut, c.scoreLimit + ' ' + (UNIT_LABEL[mi.scoreUnit] || ''));
    for (const b of el.time.querySelectorAll('button')) b.disabled = !isHost;
    for (const b of el.score.querySelectorAll('button')) b.disabled = !isHost;

    renderPlayers(c);

    // team switch
    const canSwitch = M.teams && !c.coop && (M.myTeam === 'a' || M.myTeam === 'b');
    cls('swOn', el.sw, 'on', canSwitch);
    if (canSwitch) {
      const to = M.myTeam === 'a' ? 'b' : 'a';
      el.sw.dataset.t = to;
      set('swt', el.sw, 'Switch to ' + TEAM_NAMES[to]);
    }

    // start
    const total = c.bots.fill <= 0 ? humans : c.coop ? humans + botsToAdd(c, humans) : Math.max(humans, c.bots.fill);
    let why = '';
    if (total < mi.minPlayers) why = 'Needs ' + mi.minPlayers + ' players: add bots or invite a friend.';
    el.start.disabled = !isHost || !!why;
    cls('startRo', el.start, 'ro', !isHost);
    set('start', el.start, isHost ? 'START MATCH' : 'WAITING FOR HOST');
    set('why', el.why, isHost ? why : (why ? 'Needs ' + mi.minPlayers + ' players.' : (mi.name + ' · ' + MAPS.find((m) => m.id === c.mapId).name)));
    void force;
  }

  function update(match, c) {
    M = match; ctx = c || {};
    render(false);
  }

  return { update, notice, el: host };
}
