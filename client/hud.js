// Hopshot HUD: pure DOM/CSS. Styles live in client/style.css (classes prefixed "hs-").
// update(state) is called every frame and only touches the DOM when a value actually changed.

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

export function createHud(rootEl) {
  rootEl.classList.add('hs-root');
  rootEl.innerHTML = `
    <div class="hs-vignette"></div>
    <div class="hs-dmg-wrap"></div>
    <div class="hs-cross"><i class="t"></i><i class="b"></i><i class="l"></i><i class="r"></i><i class="d"></i></div>
    <div class="hs-hit"><i></i><i></i><i></i><i></i></div>
    <div class="hs-scope"><div class="ring"></div><div class="h"></div><div class="v"></div></div>

    <div class="hs-topleft"><span class="hs-fps"></span><span class="hs-ping"></span><span class="hs-pl"></span></div>
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

    <div class="hs-menu"><div class="hs-card">
      <div class="hs-logo"><span>HOP</span>SHOT</div>
      <div class="hs-tag">slide. hop. shoot.</div>
      <label class="hs-field"><span>Name</span><input class="hs-name" maxlength="16" spellcheck="false" autocomplete="off" /></label>
      <button class="hs-play" type="button">PLAY</button>
      <div class="hs-server" data-state="checking" role="status"><i></i><span>Contacting server…</span></div>
      <div class="hs-friends">
        <div class="hs-ftitle">Play with friends</div>
        <div class="hs-invite">
          <div class="hs-roomline">Private room <b class="hs-roomcode"></b><span class="hs-roombots"></span></div>
          <div class="hs-row"><input type="text" class="hs-link" readonly spellcheck="false" aria-label="Invite link" /><button class="hs-btn hs-copy" type="button">Copy</button></div>
          <div class="hs-linknote"></div>
          <button class="hs-btn hs-leave" type="button">Leave private room</button>
        </div>
        <div class="hs-lobby">
          <div class="hs-row"><label class="hs-check"><input type="checkbox" class="hs-bots" />Fill empty slots with bots</label><button class="hs-btn hs-create" type="button">Create private room</button></div>
          <div class="hs-row"><input type="text" class="hs-code" maxlength="24" placeholder="Have a room code? Enter it" spellcheck="false" autocomplete="off" aria-label="Room code" /><button class="hs-btn hs-join" type="button">Join</button></div>
        </div>
      </div>
      <div class="hs-sliders">
        <label><span>Sensitivity</span><input type="range" class="s-sens"><output></output></label>
        <label><span>Field of view</span><input type="range" class="s-fov"><output></output></label>
        <label><span>Volume</span><input type="range" class="s-vol"><output></output></label>
      </div>
      <div class="hs-keys">
        <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><em>Move</em></div>
        <div><kbd>Space</kbd><em>Jump (hold to hop)</em></div>
        <div><kbd>Shift</kbd> / <kbd>C</kbd><em>Crouch / slide</em></div>
        <div><kbd>LMB</kbd><em>Fire</em><kbd>RMB</kbd><em>Aim</em></div>
        <div><kbd>R</kbd><em>Reload</em><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><em>Weapon</em></div>
        <div><kbd>Tab</kbd><em>Scoreboard</em><kbd>Esc</kbd><em>Menu</em></div>
      </div>
    </div></div>`;

  const $ = (sel) => rootEl.querySelector(sel);
  const el = {
    vig: $('.hs-vignette'), dmgWrap: $('.hs-dmg-wrap'), cross: $('.hs-cross'), hit: $('.hs-hit'), scope: $('.hs-scope'),
    fps: $('.hs-fps'), ping: $('.hs-ping'), pl: $('.hs-pl'), timer: $('.hs-timer'),
    kills: $('.hs-kd .k b'), deaths: $('.hs-kd .d b'), feed: $('.hs-feed'), status: $('.hs-status'),
    hnum: $('.hs-hnum'), hfill: $('.hs-hbar .fill'), speedNum: $('.hs-speed .num'), speedFill: $('.hs-speed .fill'),
    wname: $('.hs-wname'), cur: $('.hs-ammo .cur'), mag: $('.hs-ammo .mag'), ammo: $('.hs-ammo'),
    reload: $('.hs-reload'), death: $('.hs-death'), dsub: $('.hs-dsub'),
    score: $('.hs-score'), scoreBody: $('.hs-score tbody'),
    round: $('.hs-round'), roundBody: $('.hs-round tbody'), winner: $('.hs-winner'), next: $('.hs-next'),
    menu: $('.hs-menu'), name: $('.hs-name'), play: $('.hs-play'),
    sSens: $('.s-sens'), sFov: $('.s-fov'), sVol: $('.s-vol'),
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
  function fillRows(body, rows, withPing) {
    body.textContent = '';
    const sorted = rows.slice().sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
    sorted.forEach((r, i) => {
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

  function showMenu(o) {
    menuCb = o || {};
    const st = menuCb.settings || {};
    el.name.value = menuCb.defaultName || '';
    const setup = (input, v, min, max, step) => {
      input.min = Math.min(min, v); input.max = Math.max(max, v); input.step = step; input.value = v;
      input.nextElementSibling.textContent = fmtSetting(input, v);
    };
    setup(el.sSens, st.sensitivity != null ? st.sensitivity : 1, 0.05, 5, 0.05);
    setup(el.sFov, st.fov != null ? st.fov : 90, 60, 120, 1);
    setup(el.sVol, st.volume != null ? st.volume : 0.7, 0, 1, 0.01);
    applyRoom(menuCb.room);
    el.menu.classList.add('on');
    el.score.classList.remove('on');
    setTimeout(() => el.name.focus(), 0);
  }
  function fmtSetting(input, v) {
    v = Number(v);
    if (input === el.sFov) return Math.round(v) + '°';
    if (input === el.sVol) return Math.round(v * 100) + '%';
    return v.toFixed(2);
  }
  function emitSettings() {
    if (!menuCb || !menuCb.onSettings) return;
    menuCb.onSettings({ sensitivity: +el.sSens.value, fov: +el.sFov.value, volume: +el.sVol.value });
  }
  for (const inp of [el.sSens, el.sFov, el.sVol]) {
    inp.addEventListener('input', () => { inp.nextElementSibling.textContent = fmtSetting(inp, inp.value); emitSettings(); });
  }
  function play() {
    if (!menuCb) return;
    const nm = el.name.value.trim().slice(0, 16) || menuCb.defaultName || 'Player';
    if (menuCb.onPlay) menuCb.onPlay(nm);
  }
  el.play.addEventListener('click', play);
  el.name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') play(); });
  el.name.addEventListener('keyup', (e) => e.stopPropagation());
  function hideMenu() { el.menu.classList.remove('on'); }

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

  function setStatus(text) {
    el.status.textContent = text || '';
    el.status.classList.toggle('on', !!text);
  }

  return { update, addKill, hitmarker, damageFrom, setScoreboard, showMenu, hideMenu, setInvite, setServer, setWake, showRoundEnd, hideRoundEnd, setStatus };
}
