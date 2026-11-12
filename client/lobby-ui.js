// Hopshot private-room lobby screen: map hero, mode title + segmented picker, avatar-chip roster,
// one quiet row of match-setting chips (popover editors), map thumbnail strip, one bright START.
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
const MODE_SHORT = { ffa: 'FFA', tdm: 'TDM', ctf: 'CTF', hardpoint: 'Hold' };
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
function drawThumb(cv, map, bare) {
  const S = cv.width, g = cv.getContext('2d');
  const th = map.theme || {};
  if (!bare) { g.fillStyle = '#0d1424'; g.fillRect(0, 0, S, S); }
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


const SVG = (inner, w = 20) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON = {
  ffa: SVG('<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>', 18),
  tdm: SVG('<circle cx="8" cy="8" r="3"/><path d="M2.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2c3.5-.5 6 1.3 6 4.8"/>', 18),
  ctf: SVG('<path d="M6 21V4"/><path d="M6 4.5h11l-2.5 4 2.5 4H6"/>', 18),
  hardpoint: SVG('<path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><circle cx="12" cy="12" r="2.5"/>', 18),
  link: SVG('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>', 18),
  loadout: SVG('<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>', 18),
  menu: SVG('<path d="M4 7h16M4 12h16M4 17h16"/>', 18),
  bot: SVG('<rect x="5" y="8.5" width="14" height="10" rx="3"/><path d="M12 8.5V5"/><circle cx="12" cy="4" r="1"/><circle cx="9.3" cy="13.5" r="1.1" fill="currentColor"/><circle cx="14.7" cy="13.5" r="1.1" fill="currentColor"/>', 18),
  clock: SVG('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', 18),
  goal: SVG('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>', 18),
  swap: SVG('<path d="M4 8h14l-3-3M20 16H6l3 3"/>', 16),
  crown: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M2.5 8l4.8 4.2L12 4.5l4.7 7.7L21.5 8 19.6 19.5H4.4z"/></svg>',
  botGlyph: SVG('<rect x="5" y="8.5" width="14" height="10" rx="3"/><path d="M12 8.5V5"/><circle cx="9.3" cy="13.5" r="1.1" fill="currentColor"/><circle cx="14.7" cy="13.5" r="1.1" fill="currentColor"/>', 20),
};
const hexCss = (c, dflt) => '#' + ((typeof c === 'number' ? c : dflt) & 0xffffff).toString(16).padStart(6, '0');
const hueOf = (id) => ((Number(id) || 0) * 137 + 40) % 360;

export function createLobby(host, o = {}) {
  host.innerHTML = `
    <div class="lb-card">
      <header class="lb-top">
        <div class="lb-room"><span>Room</span><b class="lb-code"></b></div>
        <div class="lb-acts">
          <button type="button" class="lb-btn lb-invite" aria-label="Copy invite link">${ICON.link}<span class="lb-t">Invite</span></button>
          <button type="button" class="lb-btn lb-loadout" aria-label="Loadout" title="Loadout">${ICON.loadout}<span class="lb-t">Loadout</span></button>
          <button type="button" class="lb-btn lb-menu" aria-label="Menu" title="Menu">${ICON.menu}<span class="lb-t">Menu</span></button>
        </div>
        <input type="text" class="lb-hidden" readonly tabindex="-1" aria-hidden="true" />
      </header>
      <div class="lb-main">
        <section class="lb-hero" aria-label="Map">
          <canvas class="lb-herocv" width="512" height="512"></canvas>
          <div class="lb-heroname"><b></b><span></span></div>
        </section>
        <section class="lb-side">
          <div class="lb-modehead"><h2 class="lb-title"></h2><p class="lb-rule"></p></div>
          <div class="lb-modes" role="group" aria-label="Mode"></div>
          <div class="lb-roster-wrap"><div class="lb-roster"></div><button type="button" class="lb-swap">${ICON.swap}<span></span></button></div>
          <div class="lb-chips">
            <button type="button" class="lb-chip" data-k="bots">${ICON.bot}<span></span></button>
            <button type="button" class="lb-chip" data-k="time">${ICON.clock}<span></span></button>
            <button type="button" class="lb-chip" data-k="score">${ICON.goal}<span></span></button>
          </div>
        </section>
      </div>
      <footer class="lb-foot">
        <div class="lb-maps" role="group" aria-label="Map"></div>
        <button type="button" class="lb-start"><b></b><i></i></button>
      </footer>
      <div class="lb-pop" data-k="bots" role="dialog">
        <div class="lb-seg" role="group" aria-label="Bots"><button type="button" data-b="off">Off</button><button type="button" data-b="fill">Fill</button><button type="button" data-b="coop">Co-op</button></div>
        <div class="lb-step lb-botn"><button type="button" data-d="-1" aria-label="Fewer bots">&minus;</button><output></output><button type="button" data-d="1" aria-label="More bots">+</button></div>
        <div class="lb-seg lb-lvl" role="group" aria-label="Bot difficulty"><button type="button" data-l="easy">Easy</button><button type="button" data-l="normal">Normal</button><button type="button" data-l="hard">Hard</button></div>
      </div>
      <div class="lb-pop" data-k="time" role="dialog"><div class="lb-step lb-time"><button type="button" data-d="-1" aria-label="Shorter">&minus;</button><output></output><button type="button" data-d="1" aria-label="Longer">+</button></div></div>
      <div class="lb-pop" data-k="score" role="dialog"><div class="lb-step lb-score"><button type="button" data-d="-1" aria-label="Lower">&minus;</button><output></output><button type="button" data-d="1" aria-label="Higher">+</button></div></div>
      <div class="lb-toast" role="status"></div>
    </div>`;
  const $ = (s) => host.querySelector(s);
  const el = {
    card: $('.lb-card'), code: $('.lb-code'), hid: $('.lb-hidden'), invite: $('.lb-invite'), loadout: $('.lb-loadout'), menu: $('.lb-menu'),
    hero: $('.lb-hero'), herocv: $('.lb-herocv'), heroName: $('.lb-heroname b'), heroSize: $('.lb-heroname span'),
    title: $('.lb-title'), rule: $('.lb-rule'), modes: $('.lb-modes'), roster: $('.lb-roster'), sw: $('.lb-swap'), swT: $('.lb-swap span'),
    chips: $('.lb-chips'), maps: $('.lb-maps'), start: $('.lb-start'), startT: $('.lb-start b'), startH: $('.lb-start i'), toast: $('.lb-toast'),
    seg: $('.lb-seg'), lvl: $('.lb-lvl'), botn: $('.lb-botn'), botnOut: $('.lb-botn output'), time: $('.lb-time'), timeOut: $('.lb-time output'), score: $('.lb-score'), scoreOut: $('.lb-score output'),
  };
  const chipBtn = {};
  for (const b of el.chips.children) chipBtn[b.dataset.k] = b;
  const pops = {};
  for (const p of host.querySelectorAll('.lb-pop')) pops[p.dataset.k] = p;

  // ---- static pickers (read from the registries every time: any number of maps / modes) ----
  const modeBtns = {};
  for (const id of MODE_IDS) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = id; b.title = MODES[id].name; b.setAttribute('aria-label', MODES[id].name);
    b.innerHTML = (ICON[id] || '') + '<span></span>';
    b.lastChild.textContent = MODE_SHORT[id] || MODES[id].name;
    b.addEventListener('click', () => edit({ mode: id }));
    el.modes.appendChild(b);
    modeBtns[id] = b;
  }
  const mapBtns = {};
  for (const map of MAPS) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = map.id; b.title = map.name; b.setAttribute('aria-label', map.name);
    const cv = document.createElement('canvas');
    cv.width = cv.height = 96;
    b.appendChild(cv);
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
    render();
  }

  // ---- popover editors ----
  let openKey = '';
  function closePop() { if (!openKey) return; openKey = ''; syncPop(); }
  function syncPop() {
    for (const k of Object.keys(pops)) pops[k].classList.toggle('on', k === openKey);
    for (const k of Object.keys(chipBtn)) chipBtn[k].classList.toggle('open', k === openKey);
    if (!openKey) return;
    const c = el.card.getBoundingClientRect(), b = chipBtn[openKey].getBoundingClientRect(), p = pops[openKey];
    const pw = p.offsetWidth;
    const left = Math.max(8, Math.min(c.width - pw - 8, b.left - c.left));
    p.style.left = left + 'px';
    p.style.bottom = (c.bottom - b.top + 8) + 'px';
  }
  el.chips.addEventListener('click', (e) => {
    const b = e.target.closest('.lb-chip');
    if (!b || !isHost) return;
    openKey = openKey === b.dataset.k ? '' : b.dataset.k;
    syncPop();
  });
  host.addEventListener('pointerdown', (e) => { if (openKey && !e.target.closest('.lb-pop') && !e.target.closest('.lb-chip')) closePop(); });
  host.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openKey) { closePop(); e.stopPropagation(); } });

  const DEFAULT_FILL = 6;
  el.seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !isHost) return;
    const c = cfgNow(); if (!c) return;
    const fill = c.bots.fill > 0 ? c.bots.fill : DEFAULT_FILL;
    if (b.dataset.b === 'off') edit({ bots: { fill: 0, level: c.bots.level }, coop: false });
    else if (b.dataset.b === 'fill') edit({ bots: { fill, level: c.bots.level }, coop: false });
    else if (b.dataset.b === 'coop' && MODES[c.mode].teams) edit({ bots: { fill, level: c.bots.level }, coop: true });
  });
  el.lvl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !isHost) return;
    const c = cfgNow(); if (!c) return;
    edit({ bots: { fill: c.bots.fill, level: b.dataset.l } });
  });
  el.botn.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !isHost) return;
    const c = cfgNow(); if (!c || c.bots.fill <= 0) return;
    edit({ bots: { fill: Math.max(2, Math.min(MAX_PLAYERS, c.bots.fill + (+b.dataset.d))), level: c.bots.level } });
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
    edit({ scoreLimit: Math.max(m.scoreLimitMin, Math.min(m.scoreLimitMax, c.scoreLimit + (+b.dataset.d) * m.scoreLimitStep)) });
  });

  // ---- invite / loadout / menu / start / team ----
  let toastTimer = 0;
  function notice(text, bad = true) {
    el.toast.textContent = text;
    el.toast.classList.toggle('bad', bad);
    el.toast.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('on'), 2200);
  }
  el.invite.addEventListener('click', async () => {
    const url = ctx.inviteUrl || '';
    el.hid.value = url;
    const ok = await copyToClipboard(url, el.hid);
    notice(ok ? 'Copied' : 'Copy the link from the address bar', !ok);
  });
  el.hid.addEventListener('keydown', (e) => e.stopPropagation());
  el.hid.addEventListener('keyup', (e) => e.stopPropagation());
  el.loadout.addEventListener('click', () => { if (o.onLoadout) o.onLoadout(); });
  el.menu.addEventListener('click', () => { if (o.onMenu) o.onMenu(); });
  el.start.addEventListener('click', () => { if (!el.start.disabled && o.onStart) o.onStart(); });
  el.sw.addEventListener('click', () => { if (el.sw.dataset.t && o.onTeam) o.onTeam(el.sw.dataset.t); });
  // keep the map strip scrolled to the selected thumbnail (2-10 maps; the strip scrolls sideways)
  function revealMap(id) {
    const b = mapBtns[id];
    if (!b || el.maps.scrollWidth <= el.maps.clientWidth) return;
    el.maps.scrollTo({ left: b.offsetLeft - (el.maps.clientWidth - b.offsetWidth) / 2, behavior: 'smooth' });
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

  function chip(p, rel, mine) {
    const d = document.createElement('div');
    d.className = 'lb-p' + (p.bot ? ' bot' : '') + (p.ghost ? ' ghost' : '') + (mine ? ' me' : '');
    const av = document.createElement('span'); av.className = 'av';
    if (p.ghost) d.title = 'Open slot';
    else if (p.bot) { av.innerHTML = ICON.botGlyph; if (rel) av.style.color = relCss(rel); d.title = 'Bot'; }
    else {
      const nm = p.name || ('Player ' + p.id);
      av.textContent = (Array.from(nm.trim())[0] || '?').toUpperCase();
      av.style.background = rel ? relCss(rel) : 'hsl(' + hueOf(p.id) + ',52%,46%)';
      d.title = nm;
    }
    d.appendChild(av);
    if (p.crown) { const k = document.createElement('i'); k.className = 'crown'; k.innerHTML = ICON.crown; d.appendChild(k); }
    const n = document.createElement('em');
    n.textContent = p.ghost ? '' : p.bot ? 'Bot' : (p.name || ('Player ' + p.id));
    d.appendChild(n);
    return d;
  }

  function renderPlayers(c) {
    const my = M.myTeam;
    const humans = M.lobby.filter((p) => !p.bot).length;
    const nb = botsToAdd(c, humans);
    let sig = (M.teams ? 't' : 'f') + (c.coop ? 'c' : '') + '|' + my + '|' + ctx.selfId + '|' + M.hostId + '|' + nb + '|' + c.bots.fill + '|' + M.private;
    for (const p of M.lobby) sig += ';' + p.id + ',' + p.name + ',' + p.team + ',' + (p.bot ? 1 : 0);
    if (sig === plSig) return;
    plSig = sig;
    el.roster.textContent = '';
    const real = (p) => ({ ...p, crown: p.id === M.hostId && M.private && !p.bot });
    if (M.teams) {
      const order = my === 'b' ? ['b', 'a'] : ['a', 'b'];
      const total = c.bots.fill > 0 ? Math.max(humans, c.coop ? humans + nb : c.bots.fill) : 0;
      const haveBots = M.lobby.filter((p) => p.bot).length;
      for (const t of order) {
        const list = M.lobby.filter((p) => p.team === t);
        const rel = teamRel(t, my);
        const g = document.createElement('div');
        g.className = 'lb-grp ' + (rel === 1 ? 'friend' : 'enemy');
        for (const p of list) g.appendChild(chip(real(p), rel, p.id === ctx.selfId));
        let add = 0;
        if (c.coop) add = t === 'b' ? Math.max(0, nb - haveBots) : 0;
        else if (total) add = Math.max(0, Math.ceil(total / 2) - list.length);
        for (let i = 0; i < add; i++) g.appendChild(chip({ bot: true }, rel, false));
        if (!g.children.length) g.appendChild(chip({ ghost: true }, 0, false));
        el.roster.appendChild(g);
      }
    } else {
      for (const p of M.lobby) el.roster.appendChild(chip(real(p), 0, p.id === ctx.selfId));
      const have = M.lobby.length;
      const target = c.bots.fill > 0 ? Math.max(c.bots.fill, have) : Math.max(have, Math.min(4, MAX_PLAYERS));
      for (let i = have; i < target; i++) el.roster.appendChild(chip(c.bots.fill > 0 ? { bot: true } : { ghost: true }, 0, false));
    }
  }

  function renderHero(c) {
    const map = MAPS.find((m) => m.id === c.mapId) || MAPS[0];
    if (!map || last.hero === map.id) return;
    last.hero = map.id;
    el.herocv.getContext('2d').clearRect(0, 0, 512, 512);
    try { drawThumb(el.herocv, map, true); } catch { /* decoration */ }
    const th = map.theme || {};
    el.hero.style.setProperty('--sky1', hexCss(th.skyTop, 0x2a3a66));
    el.hero.style.setProperty('--sky2', hexCss(th.skyBottom, 0x151c33));
    el.hero.classList.remove('swap'); void el.hero.offsetWidth; el.hero.classList.add('swap');
    el.heroName.textContent = map.name;
    el.heroSize.textContent = SIZE_LABEL[map.size] || map.size || '';
    revealMap(map.id);
  }

  function render() {
    if (!M) return;
    const c = cfgNow();
    if (!c) return;
    const mi = MODES[c.mode];
    const humans = M.lobby.filter((p) => !p.bot).length;
    isHost = !!M.isHost;
    cls('ro', host, 'ro', !isHost);
    set('code', el.code, ctx.code || '');
    if (!isHost && openKey) closePop();

    for (const id of MODE_IDS) { cls('m' + id, modeBtns[id], 'on', c.mode === id); modeBtns[id].disabled = !isHost; modeBtns[id].setAttribute('aria-pressed', c.mode === id ? 'true' : 'false'); }
    for (const map of MAPS) { cls('p' + map.id, mapBtns[map.id], 'on', c.mapId === map.id); mapBtns[map.id].disabled = !isHost; }
    set('title', el.title, mi.name);
    set('rule', el.rule, mi.blurb);
    renderHero(c);

    // setting chips (+ their popover editors)
    const bmode = c.bots.fill <= 0 ? 'off' : c.coop ? 'coop' : 'fill';
    const lvl = c.bots.level || 'hard';
    set('cb', chipBtn.bots.lastChild, bmode === 'off' ? 'No bots' : (bmode === 'coop' ? 'Co-op ' : 'Bots ') + c.bots.fill + ' · ' + lvl[0].toUpperCase() + lvl.slice(1));
    for (const b of el.lvl.children) {
      cls('bl' + b.dataset.l, b, 'on', b.dataset.l === lvl);
      b.disabled = !isHost || bmode === 'off';
    }
    set('ct', chipBtn.time.lastChild, fmtMin(c.timeLimitS));
    const scoreTxt = c.scoreLimit + ' ' + (UNIT_LABEL[mi.scoreUnit] || '');
    set('cs', chipBtn.score.lastChild, scoreTxt);
    for (const k of Object.keys(chipBtn)) chipBtn[k].disabled = !isHost;
    for (const b of el.seg.children) {
      cls('bs' + b.dataset.b, b, 'on', b.dataset.b === bmode);
      b.disabled = !isHost || (b.dataset.b === 'coop' && !mi.teams);
    }
    set('botn', el.botnOut, bmode === 'off' ? '-' : String(c.bots.fill));
    for (const b of el.botn.querySelectorAll('button')) b.disabled = !isHost || bmode === 'off';
    set('time', el.timeOut, fmtMin(c.timeLimitS));
    set('score', el.scoreOut, scoreTxt);

    renderPlayers(c);
    const canSwitch = M.teams && !c.coop && (M.myTeam === 'a' || M.myTeam === 'b');
    cls('swOn', el.sw, 'on', canSwitch);
    if (canSwitch) {
      el.sw.dataset.t = M.myTeam === 'a' ? 'b' : 'a';
      set('swt', el.swT, 'Switch team');
    }

    // start
    const total = c.bots.fill <= 0 ? humans : c.coop ? humans + botsToAdd(c, humans) : Math.max(humans, c.bots.fill);
    const why = total < mi.minPlayers ? 'Need ' + mi.minPlayers + ' players' : '';
    el.start.disabled = !isHost || !!why;
    cls('startRo', el.start, 'ro', !isHost);
    set('start', el.startT, isHost ? 'Start' : 'Waiting for host');
    set('why', el.startH, isHost ? why : '');
    cls('hasWhy', el.start, 'why', isHost && !!why);
    if (openKey) syncPop();
  }

  function update(match, c) {
    M = match; ctx = c || {};
    render();
  }

  return { update, notice, el: host };
}
