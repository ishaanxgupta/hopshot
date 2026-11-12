// Hopshot match HUD (DOM): everything that depends on the game mode.
//   - the top panel: time left, and per mode: ffa (you vs the leader and the limit), team modes (two
//     score bars in friend / enemy colours + the limit), ctf (both flags), hardpoint (zone, owner, rotation)
//   - countdown overlay (big number), match-start banner, objective event feed
//   - edge-clamped world markers (flags, carrier, zone), the "capturing / contested" chip,
//     the carrying chip and the spawn-protection chip
//   - the results screen and the (team grouped) scoreboard
// All colours are from the viewer's point of view (your team = blue, the other = red).
//
//   const mh = createMatchHud(hostEl, { touch, onReturnToLobby(), onScoreboardClose() });
//   mh.update(ctx)                     every frame; ctx = { match, st, nameOf, view, W, H, fov, self: {x,y,z},
//                                      alive, kills, deaths, leader }  (see main.js)
//   mh.setScoreboard(visible, data)    data = board data (see boardData in main.js)
//   mh.pushEvent(m, ctx)               a net 'ev' message -> feed line
//   mh.setResults(result, data)        net 'result' (or the stored one) + the board data for it
//   mh.hideResults()

import { MODES, TEAM_NAMES } from '../shared/modes.js';
import { teamRel, relCss, FRIEND_CSS, ENEMY_CSS, CONTEST_CSS } from './teams.js';

const FEED_MAX = 4;
const FEED_MS = 5200;
const BANNER_MS = 3400;

function fmtTime(s) {
  s = Math.max(0, Math.ceil(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function restartAnim(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
function esc(t) { return String(t == null ? '' : t); }

export function goalText(mode, limit) {
  const m = MODES[mode];
  if (!m) return '';
  const u = m.scoreUnit;
  if (mode === 'ffa') return 'First to ' + limit + ' kills';
  if (mode === 'tdm') return 'First team to ' + limit + ' kills';
  if (mode === 'ctf') return 'First to ' + limit + (limit === 1 ? ' capture' : ' captures');
  return 'First to ' + limit + ' ' + u;
}

function objHeader(mode) { return mode === 'ctf' ? 'Caps' : mode === 'hardpoint' ? 'Zone' : ''; }

/**
 * Fill `host` with the board: team sections (my team first) or one ffa table.
 * data = { mode, teams, myTeam, scores:{a,b}, limit, rows:[{id,name,team,kills,deaths,obj,ping,isLocal,isBot}] }
 * opts = { ping: bool, cap: rows per table (Infinity = all) }
 */
export function renderBoard(host, data, opts) {
  host.textContent = '';
  const objH = objHeader(data.mode);
  const showObj = !!objH;
  const cap = opts.cap || Infinity;
  const sortRows = (rows) => rows.slice().sort((a, b) => (showObj ? (b.obj - a.obj) : 0) || (b.kills - a.kills) || (a.deaths - b.deaths) || (a.id - b.id));
  const table = (rows, startAt) => {
    const sorted = sortRows(rows);
    const t = document.createElement('table');
    const head = '<thead><tr><th class="n">#</th><th class="nm">Player</th><th>K</th><th>D</th>' + (showObj ? '<th>' + objH + '</th>' : '') + (opts.ping ? '<th>Ping</th>' : '') + '</tr></thead>';
    t.innerHTML = head;
    const body = document.createElement('tbody');
    let list = sorted.map((r, i) => ({ r, i }));
    if (list.length > cap) {
      const keep = list.slice(0, cap - 1);
      const me = list.find((x) => x.r.isLocal);
      keep.push(me && me.i >= cap - 1 ? me : list[cap - 1]);
      list = keep;
    }
    for (const { r, i } of list) {
      const tr = document.createElement('tr');
      if (r.isLocal) tr.className = 'me';
      const cells = [String(i + 1 + (startAt || 0)), null, String(r.kills | 0), String(r.deaths | 0)];
      if (showObj) cells.push(String(r.obj | 0));
      if (opts.ping) cells.push(r.isBot ? 'BOT' : String(Math.round(r.ping || 0)));
      cells.forEach((c, ci) => {
        const td = document.createElement('td');
        if (ci === 1) {
          td.className = 'nm'; td.textContent = r.name || '';
          if (r.isBot) { const e = document.createElement('em'); e.textContent = 'bot'; td.appendChild(e); }
        } else { if (ci === 0) td.className = 'n'; td.textContent = c; }
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
    t.appendChild(body);
    return t;
  };
  if (!data.teams) { host.appendChild(table(data.rows)); host.classList.remove('teams'); return; }
  host.classList.add('teams');
  const order = data.myTeam === 'b' ? ['b', 'a'] : ['a', 'b'];
  for (const t of order) {
    const sec = document.createElement('section');
    const rel = teamRel(t, data.myTeam);
    sec.className = 'tsec ' + (rel === 1 ? 'friend' : 'enemy');
    const h = document.createElement('div');
    h.className = 'th';
    const label = (rel === 1 && (data.myTeam === 'a' || data.myTeam === 'b') ? 'YOUR TEAM' : (data.myTeam === 'a' || data.myTeam === 'b') ? 'ENEMY' : TEAM_NAMES[t].toUpperCase());
    h.innerHTML = '<span></span><b></b>';
    h.firstChild.textContent = label;
    h.lastChild.textContent = String(data.scores ? data.scores[t] | 0 : 0);
    sec.appendChild(h);
    sec.appendChild(table(data.rows.filter((r) => r.team === t)));
    host.appendChild(sec);
  }
}

export function createMatchHud(host, o = {}) {
  host.innerHTML = `
    <div class="hs-mh" data-mode="ffa">
      <div class="hs-timer">0:00</div>
      <div class="hs-mscore">
        <b class="sa">0</b><div class="bar a"><i></i></div><span class="lim">/ 0</span><div class="bar b"><i></i></div><b class="sb">0</b>
      </div>
      <div class="hs-mlab"><span class="la">YOUR TEAM</span><span class="lb">ENEMY</span></div>
      <div class="hs-mffa"><span class="y">YOU <b>0</b></span><span class="l">LEADER <b>0</b></span><span class="g">FIRST TO <b>0</b></span></div>
      <div class="hs-mflags">
        <div class="fl mine" data-s="home"><i></i><span class="k">YOUR FLAG</span><span class="v">home</span></div>
        <div class="fl enemy" data-s="home"><i></i><span class="k">ENEMY FLAG</span><span class="v">home</span></div>
      </div>
      <div class="hs-mzone" data-o=""><i></i><span class="zn"></span><span class="zs"></span><span class="zt"></span></div>
      <div class="hs-kd"><span class="k"><b>0</b> KILLS</span><span class="d"><b>0</b> DEATHS</span></div>
    </div>
    <div class="hs-ofeed"></div>
    <div class="hs-markers"></div>
    <div class="hs-chips"><div class="hs-chip hs-cap"></div><div class="hs-chip hs-carry"></div><div class="hs-chip hs-prot">SPAWN PROTECTED</div></div>
    <div class="hs-banner"><b></b><span></span></div>
    <div class="hs-count"><div class="cn">3</div><div class="cm"></div><div class="cs"></div><div class="cg"></div></div>
    <div class="hs-res"><div class="hs-panel hs-respanel">
      <div class="hs-rhead"><div class="rt"></div><div class="rs"></div></div>
      <div class="hs-rscore"><b class="a">0</b><i>-</i><b class="b">0</b></div>
      <div class="hs-board"></div>
      <div class="hs-rfoot"><span class="rn"></span><button type="button" class="hs-btn hs-rback">Back to lobby now</button></div>
    </div></div>
    <div class="hs-score"><div class="hs-panel">
      <div class="hs-ptitle">SCOREBOARD</div>
      <div class="hs-sbinfo"></div>
      <div class="hs-board"></div>
    </div></div>`;
  const $ = (sel) => host.querySelector(sel);
  const el = {
    mh: $('.hs-mh'), timer: $('.hs-timer'), sa: $('.sa'), sb: $('.sb'), barA: $('.bar.a i'), barB: $('.bar.b i'), lim: $('.lim'),
    la: $('.la'), lb: $('.hs-mlab .lb'),
    ffaY: $('.hs-mffa .y b'), ffaL: $('.hs-mffa .l'), ffaLb: $('.hs-mffa .l b'), ffaG: $('.hs-mffa .g b'),
    flMine: $('.fl.mine'), flEnemy: $('.fl.enemy'), flMineV: $('.fl.mine .v'), flEnemyV: $('.fl.enemy .v'),
    zone: $('.hs-mzone'), zn: $('.hs-mzone .zn'), zs: $('.hs-mzone .zs'), zt: $('.hs-mzone .zt'),
    kills: $('.hs-kd .k b'), deaths: $('.hs-kd .d b'),
    feed: $('.hs-ofeed'), markers: $('.hs-markers'),
    cap: $('.hs-cap'), carry: $('.hs-carry'), prot: $('.hs-prot'),
    banner: $('.hs-banner'), bt: $('.hs-banner b'), bs: $('.hs-banner span'),
    count: $('.hs-count'), cn: $('.hs-count .cn'), cm: $('.hs-count .cm'), cs: $('.hs-count .cs'), cg: $('.hs-count .cg'),
    res: $('.hs-res'), rt: $('.rt'), rs: $('.rs'), rsa: $('.hs-rscore .a'), rsb: $('.hs-rscore .b'), rscore: $('.hs-rscore'),
    resBoard: $('.hs-res .hs-board'), rn: $('.rn'), rback: $('.hs-rback'),
    score: $('.hs-score'), sbBoard: $('.hs-score .hs-board'), sbInfo: $('.hs-sbinfo'),
  };
  const root = host.parentNode;
  const last = {};
  const set = (k, node, v) => { if (last[k] !== v) { last[k] = v; node.textContent = v; } };
  const attr = (k, node, name, v) => { if (last[k] !== v) { last[k] = v; node.setAttribute(name, v); } };
  const cls = (k, node, c, on) => { on = !!on; if (last[k] !== on) { last[k] = on; node.classList.toggle(c, on); } };
  const css = (k, node, prop, v) => { if (last[k] !== v) { last[k] = v; node.style.setProperty(prop, v); } };

  // markers: a small pool (two flags + the zone)
  const MK = 3;
  const mk = [];
  for (let i = 0; i < MK; i++) {
    const d = document.createElement('div');
    d.className = 'hs-mk';
    d.innerHTML = '<u class="ar"></u><i class="ic"></i><b class="lb"></b><span class="di"></span>';
    el.markers.appendChild(d);
    mk.push({ d, ar: d.querySelector('.ar'), ic: d.querySelector('.ic'), lb: d.querySelector('.lb'), di: d.querySelector('.di'), on: false, x: -999, y: -999, lbT: '', diT: '', kind: '' });
  }
  let panelBottom = 60, panelNext = 0;       // bottom edge of the top panel (markers stay clear of it)
  const _vs = { x: 0, y: 0, z: 0 };
  function placeMarker(i, ctx, wx, wy, wz, kind, label, dist) {
    const m = mk[i];
    const W = ctx.W, H = ctx.H;
    ctx.view(wx, wy, wz, _vs);
    const f = (H / 2) / Math.tan((ctx.fov * Math.PI) / 360);
    const front = _vs.z < -0.15;
    const marginX = 38, top = Math.max(o.touch ? 56 : 64, panelBottom + 20), bottom = o.touch ? 86 : 120;
    let sx, sy, edge = false, ang = 0;
    if (front) {
      sx = W / 2 + f * _vs.x / -_vs.z; sy = H / 2 - f * _vs.y / -_vs.z;
      if (sx < marginX || sx > W - marginX || sy < top || sy > H - bottom) edge = true;
    } else edge = true;
    if (edge) {
      let dx = _vs.x, dy = -_vs.y;
      if (front) { dx = sx - W / 2; dy = sy - H / 2; }
      if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) dy = 1;
      const hw = W / 2 - marginX, hh = (H - bottom - top) / 2, cy = (top + (H - bottom)) / 2;
      const t = Math.min(hw / (Math.abs(dx) || 1e-4), hh / (Math.abs(dy) || 1e-4));
      sx = W / 2 + dx * t; sy = cy + dy * t;
      ang = Math.atan2(dy, dx) + Math.PI / 2;
    }
    if (!m.on) { m.on = true; m.d.style.display = 'flex'; }
    if (m.kind !== kind) { m.kind = kind; m.d.dataset.k = kind; }
    const qx = Math.round(sx), qy = Math.round(sy);
    if (qx !== m.x || qy !== m.y) { m.x = qx; m.y = qy; m.d.style.transform = 'translate(' + qx + 'px,' + qy + 'px)'; }
    m.d.classList.toggle('edge', edge);
    if (edge) m.ar.style.transform = 'rotate(' + ang.toFixed(2) + 'rad)';
    if (m.lbT !== label) { m.lbT = label; m.lb.textContent = label; }
    const dt = Math.round(dist) + 'm';
    if (m.diT !== dt) { m.diT = dt; m.di.textContent = dt; }
  }
  function hideMarkers(from) {
    for (let i = from; i < MK; i++) if (mk[i].on) { mk[i].on = false; mk[i].d.style.display = 'none'; }
  }

  // ---- feed / banner ----
  function feedLine(text, rel) {
    const row = document.createElement('div');
    row.className = 'hs-oe ' + (rel === 1 ? 'friend' : rel === 2 ? 'enemy' : '');
    row.textContent = text;
    el.feed.appendChild(row);
    while (el.feed.children.length > FEED_MAX) el.feed.removeChild(el.feed.firstChild);
    setTimeout(() => {
      row.classList.add('out');
      setTimeout(() => { if (row.parentNode) row.parentNode.removeChild(row); }, 400);
    }, FEED_MS);
  }
  let bannerTimer = 0;
  function showBanner(title, sub, rel) {
    el.bt.textContent = title;
    el.bs.textContent = sub || '';
    el.banner.dataset.r = rel ? String(rel) : '';
    restartAnim(el.banner, 'on');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.banner.classList.remove('on'), BANNER_MS);
  }

  /** A net 'ev' message -> a feed line (and the start banner). */
  function pushEvent(m, ctx) {
    const nm = ctx.nameOf;
    const my = ctx.myTeam;
    const who = (id) => (id ? nm(id) : 'Someone');
    switch (m.e) {
      case 'match_start': {
        const mode = MODES[m.mode] || ctx.match.modeInfo;
        showBanner(mode.name.toUpperCase(), goalText(mode.id, ctx.match.scoreLimit) + (ctx.match.mapName ? ' · ' + ctx.match.mapName : ''));
        break;
      }
      case 'flag_taken': {
        const rel = teamRel(m.team, my);        // m.team = the flag's team
        feedLine(rel === 1 ? who(m.player) + ' took your flag' : who(m.player) + ' took the enemy flag', rel === 1 ? 2 : 1);
        break;
      }
      case 'flag_dropped': {
        const rel = teamRel(m.team, my);
        feedLine(rel === 1 ? 'Your flag was dropped' : 'The enemy flag was dropped', rel === 1 ? 1 : 1);
        break;
      }
      case 'flag_returned': {
        const rel = teamRel(m.team, my);
        feedLine(m.player ? who(m.player) + ' returned ' + (rel === 1 ? 'your' : 'the enemy') + ' flag' : (rel === 1 ? 'Your' : 'The enemy') + ' flag returned home', rel);
        break;
      }
      case 'flag_captured': {
        const rel = teamRel(m.scorer, my);
        feedLine(who(m.player) + ' captured the flag!' + (rel === 2 ? ' (enemy)' : ''), rel);
        showBanner(rel === 1 ? 'FLAG CAPTURED' : rel === 2 ? 'ENEMY CAPTURED' : 'FLAG CAPTURED', who(m.player), rel);
        break;
      }
      case 'zone_rotated': feedLine('Zone moved to ' + esc(m.name), 0); break;
      case 'zone_taken': { const rel = teamRel(m.team, my); feedLine(rel === 1 ? 'Your team took the zone' : 'The enemy took the zone', rel); break; }
      case 'zone_contested': feedLine('Zone contested', 0); break;
      case 'zone_neutral': feedLine('Zone is open', 0); break;
      default: break;
    }
  }

  // ---- results ----
  let resShown = false, resSig = '';
  function setResults(result, data) {
    if (!result) return;
    const M = data.match;
    const my = data.myTeam;
    let title, rel = 0;
    if (M.teams) {
      if (result.draw || !result.winner) title = 'DRAW';
      else if (my === 'a' || my === 'b') { rel = result.winner === my ? 1 : 2; title = rel === 1 ? 'VICTORY' : 'DEFEAT'; }
      else title = (TEAM_NAMES[result.winner] || 'Team').toUpperCase() + ' WINS';
    } else if (result.draw || result.winner == null) title = 'DRAW';
    else if (result.winner === data.selfId) { title = 'YOU WIN!'; rel = 1; }
    else title = esc(result.winnerName || 'Someone').toUpperCase() + ' WINS';
    const sig = title + '|' + (result.rows ? result.rows.map((r) => r.id + ':' + r.kills + ':' + r.deaths + ':' + r.obj).join(',') : '') + '|' + my;
    el.res.dataset.r = rel ? String(rel) : '';
    if (sig !== resSig) {
      resSig = sig;
      set('rt', el.rt, title);
      const mi = MODES[result.mode] || M.modeInfo;
      set('rs', el.rs, (mi ? mi.name : '') + (M.mapName ? ' · ' + M.mapName : '') + ' · ' + (result.reason === 'time' ? 'time up' : 'limit reached'));
      el.rscore.style.display = M.teams ? '' : 'none';
      if (M.teams) {
        const a = result.scores ? result.scores.a : 0, b = result.scores ? result.scores.b : 0;
        const mine = my === 'b' ? b : a, theirs = my === 'b' ? a : b;
        set('rsa', el.rsa, String(mine)); set('rsb', el.rsb, String(theirs));
      }
      const rows = (result.rows || []).map((r) => ({ id: r.id, name: r.name, team: r.team, kills: r.kills, deaths: r.deaths, obj: r.obj, isBot: r.bot, isLocal: r.id === data.selfId }));
      renderBoard(el.resBoard, { mode: result.mode, teams: M.teams, myTeam: my, scores: result.scores, limit: M.scoreLimit, rows }, { ping: false, cap: Infinity });
    }
    resShown = true;
    el.res.classList.add('on');
    el.score.classList.remove('on');
  }
  function hideResults() { resShown = false; resSig = ''; el.res.classList.remove('on'); }
  el.rback.addEventListener('click', (e) => { e.stopPropagation(); if (o.onReturnToLobby) o.onReturnToLobby(); });
  el.rback.addEventListener('pointerdown', (e) => e.stopPropagation());

  // ---- scoreboard ----
  let sbSig = '';
  function maxRows() { const h = window.innerHeight; return h < 460 ? 6 : h < 620 ? 10 : 24; }
  function setScoreboard(visible, data) {
    el.score.classList.toggle('on', !!visible);
    if (!visible || !data) return;
    let sig = data.mode + '|' + data.myTeam + '|' + (data.scores ? data.scores.a + ':' + data.scores.b : '') + '|' + window.innerWidth + 'x' + window.innerHeight;
    for (const r of data.rows) sig += ';' + r.id + '|' + r.name + '|' + r.team + '|' + r.kills + '|' + r.deaths + '|' + r.obj + '|' + (r.ping | 0) + '|' + (r.isLocal ? 1 : 0);
    if (sig === sbSig) return;
    sbSig = sig;
    const wide = window.innerWidth >= 560;
    const cap = data.teams ? (wide ? maxRows() : Math.max(3, Math.floor(maxRows() / 2))) : maxRows();
    renderBoard(el.sbBoard, data, { ping: true, cap });
    const mi = MODES[data.mode];
    el.sbInfo.textContent = (mi ? mi.name : '') + (data.mapName ? ' · ' + data.mapName : '') + (mi ? ' · ' + goalText(data.mode, data.limit).toLowerCase() : '');
  }
  if (o.touch) {
    el.score.querySelector('.hs-panel').addEventListener('click', () => {
      el.score.classList.remove('on');
      if (o.onScoreboardClose) o.onScoreboardClose();
    });
  }

  // ---- per-frame update ----
  const lastCount = { n: -1 };
  let lastPhase = '', zoneInside = false;
  function update(ctx) {
    const M = ctx.match;
    const phase = M.phase;
    const playing = phase === 'playing';
    cls('ovw', root, 'hs-ovw', phase !== 'playing');
    cls('res', root, 'hs-results', phase === 'results');
    if (phase !== lastPhase) {
      lastPhase = phase;
      if (phase !== 'results') hideResults();
      if (phase !== 'playing') el.banner.classList.remove('on');
    }

    // countdown
    const counting = phase === 'countdown';
    cls('cdOn', el.count, 'on', counting);
    if (counting) {
      const n = Math.max(1, Math.ceil(M.countdown));
      if (n !== lastCount.n) { lastCount.n = n; el.cn.textContent = String(n); restartAnim(el.cn, 'pop'); }
      set('cm', el.cm, M.modeInfo.name.toUpperCase());
      set('cs', el.cs, M.mapName || '');
      set('cg', el.cg, goalText(M.mode, M.scoreLimit));
    } else lastCount.n = -1;

    // results timer + button
    if (phase === 'results') {
      const left = Math.max(0, Math.ceil(M.resultsLeftS));
      set('rn', el.rn, M.private ? 'Back to the lobby in ' + left + 's' : 'Next match starting in ' + left + 's');
      cls('rback', el.rback, 'show', M.private && M.isHost);
      if (!resShown && M.result) setResults(M.result, ctx);
    }

    if (!playing) {
      hideMarkers(0);
      cls('prot', el.prot, 'on', false); cls('cap', el.cap, 'on', false); cls('carry', el.carry, 'on', false);
      return;
    }

    if (ctx.now >= panelNext) { panelNext = ctx.now + 300; panelBottom = el.mh.getBoundingClientRect().bottom; }
    // ---- playing: the top panel ----
    const teams = M.teams;
    const my = ctx.myTeam;
    const mode = M.mode;
    attr('mode', el.mh, 'data-mode', mode);
    set('timer', el.timer, fmtTime(M.timeLeftS));
    set('kills', el.kills, String(ctx.kills | 0));
    set('deaths', el.deaths, String(ctx.deaths | 0));
    if (teams) {
      const mine = my === 'b' ? 'b' : 'a', theirs = mine === 'a' ? 'b' : 'a';
      const sm = M.scores[mine] | 0, se = M.scores[theirs] | 0;
      set('sa', el.sa, String(sm)); set('sb', el.sb, String(se));
      set('lim', el.lim, '/ ' + M.scoreLimit);
      const fa = Math.min(1, sm / Math.max(1, M.scoreLimit)), fb = Math.min(1, se / Math.max(1, M.scoreLimit));
      css('fa', el.barA, 'transform', 'scaleX(' + fa.toFixed(3) + ')');
      css('fb', el.barB, 'transform', 'scaleX(' + fb.toFixed(3) + ')');
      const labelled = my === 'a' || my === 'b';
      set('la', el.la, labelled ? 'YOUR TEAM' : 'TEAM A'); set('lb', el.lb, labelled ? 'ENEMY' : 'TEAM B');
    } else {
      set('ffaY', el.ffaY, String(ctx.kills | 0));
      const L = ctx.leader;
      set('ffaL', el.ffaL.firstChild, L && !L.isMe ? 'LEADER ' + L.name.slice(0, 10) + ' ' : 'LEAD ');
      set('ffaLb', el.ffaLb, L ? String(L.kills) : '0');
      cls('ffaMe', el.ffaL, 'me', L && L.isMe);
      set('ffaG', el.ffaG, String(M.scoreLimit));
    }

    // ctf flags
    const F = M.flags;
    const showFlags = mode === 'ctf' && F;
    let mkN = 0;
    if (showFlags) {
      const mineT = my === 'b' ? 'b' : 'a', enemyT = mineT === 'a' ? 'b' : 'a';
      const fm = F[mineT], fe = F[enemyT];
      const stateText = (f, ownFlag) => {
        if (f.state === 'home') return 'home';
        if (f.state === 'dropped') return 'dropped ' + Math.ceil(f.returnInS) + 's';
        return (f.carrier === ctx.selfId ? 'YOU' : ctx.nameOf(f.carrier)) + (ownFlag ? ' has it' : ' carries');
      };
      set('flm', el.flMineV, stateText(fm, true));
      set('fle', el.flEnemyV, stateText(fe, false));
      attr('flms', el.flMine, 'data-s', fm.state === 'carried' ? 'danger' : fm.state);
      attr('fles', el.flEnemy, 'data-s', fe.state === 'carried' ? (fe.carrier === ctx.selfId || teamRel(ctx.teamOf(fe.carrier), my) === 1 ? 'good' : 'danger') : fe.state);
      // markers: the enemy flag (or the carrier) and your own flag / base
      const carrying = fe.state === 'carried' && fe.carrier === ctx.selfId;
      if (!carrying) {
        const d = Math.hypot(fe.pos[0] - ctx.self.x, fe.pos[1] - ctx.self.y, fe.pos[2] - ctx.self.z);
        const lab = fe.state === 'carried' ? ctx.nameOf(fe.carrier) : fe.state === 'dropped' ? 'ENEMY FLAG' : 'ENEMY FLAG';
        placeMarker(mkN++, ctx, fe.pos[0], fe.pos[1] + 2.4, fe.pos[2], fe.state === 'carried' && teamRel(ctx.teamOf(fe.carrier), my) === 1 ? 'friend' : 'enemy', lab, d);
      }
      {
        const d = Math.hypot(fm.pos[0] - ctx.self.x, fm.pos[1] - ctx.self.y, fm.pos[2] - ctx.self.z);
        const lab = carrying ? 'CAPTURE HERE' : fm.state === 'carried' ? ctx.nameOf(fm.carrier) : fm.state === 'dropped' ? 'YOUR FLAG' : 'BASE';
        // when you carry the enemy flag point at your own stand, not at the flag (which is you)
        const sp = carrying && M.map && M.map.flags ? M.map.flags[mineT] : fm.pos;
        const d2 = Math.hypot(sp[0] - ctx.self.x, sp[1] - ctx.self.y, sp[2] - ctx.self.z);
        placeMarker(mkN++, ctx, sp[0], sp[1] + 2.4, sp[2], fm.state === 'carried' ? 'enemy' : 'friend', lab, carrying ? d2 : d);
      }
    }
    hideMarkers(mkN);

    // hardpoint
    const HP = M.hardpoint;
    let inside = false;
    if (mode === 'hardpoint' && HP) {
      const owner = HP.owner;
      const orel = owner === 'a' || owner === 'b' ? teamRel(owner, my) : 0;
      attr('zo', el.zone, 'data-o', owner === 'contested' ? 'c' : owner === '' ? 'n' : orel === 1 ? 'f' : 'e');
      set('zn', el.zn, HP.name);
      set('zs', el.zs, owner === 'contested' ? 'contested' : owner === '' ? 'open' : orel === 1 ? 'held by you' : 'held by enemy');
      set('zt', el.zt, 'moves in ' + fmtTime(HP.rotateInS));
      const s = ctx.self;
      inside = ctx.alive && s.x >= HP.min[0] - 0.2 && s.x <= HP.max[0] + 0.2 && s.z >= HP.min[2] - 0.2 && s.z <= HP.max[2] + 0.2 && s.y >= HP.min[1] - 1 && s.y <= HP.max[1] + 0.6;
      const cx = (HP.min[0] + HP.max[0]) / 2, cz = (HP.min[2] + HP.max[2]) / 2;
      const d = Math.hypot(cx - s.x, cz - s.z);
      placeMarker(mkN++, ctx, cx, HP.max[1] + 1.4, cz, owner === 'contested' ? 'contest' : owner === '' ? 'neutral' : orel === 1 ? 'friend' : 'enemy', HP.name, d);
      hideMarkers(mkN);
      let msg = '', kind = '';
      if (inside) {
        if (owner === 'contested') { msg = 'CONTESTED'; kind = 'c'; }
        else if (owner === 'a' || owner === 'b') { if (orel === 1) { msg = 'CAPTURING  +1/s'; kind = 'f'; } else { msg = 'ENEMY HOLDS THE ZONE'; kind = 'e'; } }
        else { msg = 'CAPTURING'; kind = 'f'; }
      }
      set('cap', el.cap, msg);
      attr('capk', el.cap, 'data-k', kind);
      cls('capOn', el.cap, 'on', !!msg);
    } else cls('capOn', el.cap, 'on', false);
    zoneInside = inside;

    // carrying chip + spawn protection
    const carrying = mode === 'ctf' && ctx.st.carrier;
    set('carry', el.carry, carrying ? 'YOU HAVE THE FLAG - BRING IT TO YOUR BASE' : '');
    cls('carryOn', el.carry, 'on', carrying);
    cls('protOn', el.prot, 'on', ctx.alive && ctx.st.protected);
  }

  return { update, pushEvent, setScoreboard, setResults, hideResults, feedLine, showBanner, get zoneInside() { return zoneInside; } };
}
