// Hopshot client bootstrap: menu + settings, fixed 60 Hz simulation (accumulator) with render
// interpolation, and all renderer / HUD / audio wiring.
//
// URL params: ?room=NAME (private room), ?name=NAME, ?autoplay=1 (synthetic input, no pointer
// lock needed - for automated browsers), ?touch=1 (force the on-screen touch controls, e.g. to
// drive them with a mouse on a desktop; ?touch=0 forces them off). Debug surface: window.__hopshot.
//
// Layout of this file: settings -> modules -> loadout -> menu flow -> server wake/probe -> game
// events -> simulation (simTick) -> frame loop (runFrame: assists, sim, render, HUD) -> debug surface.
//
// Weapons: every per-player number comes from net.kit (the ACTIVE loadout of the current life):
// net.kit.slots[slot] = effective stats (mag size, ADS fov, spread, reload / swap ticks), .guns[slot] =
// gun id, .masks[slot] = attachment mask. Aim progress is net.localView().aim (0..1) - never a timer
// here. The menu's Loadout tab edits the PENDING loadout (net.setLoadout), which applies at the next spawn.
// ?randlo=1 (autoplay) re-rolls a random loadout on every death, to exercise all six guns.

import { TICK_RATE, BTN, RESPAWN_MS } from '../shared/constants.js';
import { GUNS, currentSpread, popcount6, SLOT_COUNT } from '../shared/weapons.js';
import { MAP } from '../shared/map.js';
import { createWorld, eyeHeight } from '../shared/physics.js';
import { TICK_MS, SHOT } from '../shared/protocol.js';
import { createRenderer } from './render.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import { createInput, createAutopilot, wrapAngle, detectTouch } from './input.js';
import { createNet } from './net.js';
import { normalizeSaved } from './loadout-ui.js';

const MAX_CATCHUP_TICKS = 6;           // at most this many sim ticks per frame
const RESYNC_MS = 250;                 // a frame gap longer than this drops the backlog
const STEP_DIST = 2.3;                 // m of ground travel per footstep sound

// ------------------------------------------------------------------ settings / params
const params = new URLSearchParams(location.search);
const AUTOPLAY = params.get('autoplay') === '1' || params.get('autoplay') === 'true';
const ROOM = (params.get('room') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
// Bot fill level for a private room (0 = no bots). Undefined = server default.
const RANDLO = params.get('randlo') === '1';
const ROOM_BOTS = ROOM && params.has('bots') ? num(params.get('bots'), 0, 0, 20) | 0 : undefined;

function load(key, def) {
  try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch { return def; }
}
function save(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ }
}
function num(v, def, lo, hi) { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; }

const IS_TOUCH = detectTouch();
const FORCED_TOUCH = params.get('touch') === '1' || params.get('touch') === 'true';
const stored = load('hopshot.settings', {}) || {};
const DEFAULTS = {
  sensitivity: 1, adsSens: 1, invertY: false, fov: 90, volume: 0.7,
  quality: IS_TOUCH ? 'medium' : 'high',
  showStats: !IS_TOUCH,
  crosshairColor: '#ffffff', crosshairSize: 1,
  stickSide: 'left', btnScale: 1, aimAssist: IS_TOUCH, autoFire: IS_TOUCH,
};
const bool = (v, def) => (typeof v === 'boolean' ? v : def);
const pick = (v, list, def) => (list.includes(v) ? v : def);
// Validate a (possibly partial or hostile) settings object against `base`; missing fields keep base.
function sanitize(s, base) {
  s = s && typeof s === 'object' ? s : {};
  return {
    sensitivity: num(s.sensitivity, base.sensitivity, 0.05, 10),
    adsSens: num(s.adsSens, base.adsSens, 0.2, 2),
    invertY: bool(s.invertY, base.invertY),
    fov: num(s.fov, base.fov, 50, 130),
    volume: num(s.volume, base.volume, 0, 1),
    quality: pick(s.quality, ['low', 'medium', 'high'], base.quality),
    showStats: bool(s.showStats, base.showStats),
    crosshairColor: typeof s.crosshairColor === 'string' && /^#[0-9a-f]{6}$/i.test(s.crosshairColor) ? s.crosshairColor.toLowerCase() : base.crosshairColor,
    crosshairSize: num(s.crosshairSize, base.crosshairSize, 0.5, 3),
    stickSide: pick(s.stickSide, ['left', 'right'], base.stickSide),
    btnScale: num(s.btnScale, base.btnScale, 0.8, 1.6),
    aimAssist: bool(s.aimAssist, base.aimAssist),
    autoFire: bool(s.autoFire, base.autoFire),
  };
}
const settings = sanitize(stored, DEFAULTS);
let playerName = String(params.get('name') || load('hopshot.name', '') || (AUTOPLAY ? 'Autoplay' : '')).slice(0, 16);

// ------------------------------------------------------------------ modules
const canvas = document.getElementById('game');
const hudRoot = document.getElementById('hud');
const world = createWorld(MAP);
if (IS_TOUCH) document.documentElement.classList.add('touch');
const renderer = createRenderer(canvas, MAP, { quality: settings.quality, touch: IS_TOUCH });
const hud = createHud(hudRoot, {
  touch: IS_TOUCH,
  onWeapon(slot) { input.weapon = slot; },
  onScoreboardClose() { scoreboardHeld = false; input.setScoreboardActive(false); input.state.scoreboard = false; },
});
const audio = createAudio();
// Game server address. Defaults to the host that served this page; ?server=https://host or a
// global HOPSHOT_SERVER lets a separately hosted page point at the game server.
const SERVER_HTTP = String(params.get('server') || window.HOPSHOT_SERVER || location.origin).replace(/\/+$/, '');
const net = createNet({ world, url: SERVER_HTTP.replace(/^http/, 'ws') + '/ws' });
const autopilot = AUTOPLAY ? createAutopilot({ seed: (Math.random() * 1e9) | 0 }) : null;

let started = false;      // joined at least once (connect requested)
let menuOpen = false;
let scoreboardHeld = false;

const input = createInput(canvas, {
  touch: IS_TOUCH,
  onLockChange(locked) {
    if (locked) { hideMenu(); return; }
    if (!AUTOPLAY) showMenu();
  },
  onLockError() { /* we keep playing unlocked; a canvas click retries */ },
  onScoreboard(held) { scoreboardHeld = held; if (!held) hud.setScoreboard(false); },
  onEscape() { if (!AUTOPLAY && !menuOpen) showMenu(); },       // Esc key, or the on-screen menu button
  onGesture() { audio.unlock(); if (net.state.status === 'reconnecting') net.retryNow(); },
});

function applySettings() {
  renderer.setFov(settings.fov);
  renderer.setQuality(settings.quality);
  audio.setVolume(settings.volume);
  input.sensitivity = settings.sensitivity;
  input.invertY = settings.invertY;
  input.configureTouch({ side: settings.stickSide, scale: settings.btnScale });
  hud.setPrefs(settings);
}
applySettings();

const onResize = () => renderer.resize(window.innerWidth, window.innerHeight);
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 200));
onResize();

// ------------------------------------------------------------------ loadout
// Saved as { code, builds } (loadout-ui.js). net remembers the pending loadout and sends it with
// every join; changes while connected go to the server immediately but only apply at the next spawn.
let savedLoadout = normalizeSaved(load('hopshot.loadout', null));
net.setLoadout(savedLoadout.code);
function loadoutStatus() {
  const L = net.state.loadout;
  return { pendingCode: L.pendingCode, activeCode: L.activeCode, joined: started && net.state.connected };
}
net.on('loadout', () => hud.setLoadoutStatus(loadoutStatus()));
function randomLoadoutCode() {
  let code = 0;
  for (let s = 0; s < SLOT_COUNT; s++) {
    let mask = 0;
    for (let i = 0; i < 6; i++) if (Math.random() < 0.45) mask |= 1 << i;
    code |= ((Math.random() < 0.5 ? 0 : 1) | (mask << 1)) << (8 * s);
  }
  return code;     // net.setLoadout sanitises it (3-attachment limit)
}

// ------------------------------------------------------------------ private rooms / invites
function roomQuery(code, bots) {
  if (!code) return '';
  return `?room=${encodeURIComponent(code)}` + (bots !== undefined ? `&bots=${bots}` : '');
}
function goRoom(code, bots, name) {
  if (name) save('hopshot.name', String(name).slice(0, 16));
  location.href = location.origin + '/' + roomQuery(code, bots);
}
function randomRoomCode() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const r = new Uint8Array(5);
  try { crypto.getRandomValues(r); } catch { for (let i = 0; i < r.length; i++) r[i] = Math.random() * 256; }
  let s = '';
  for (let i = 0; i < r.length; i++) s += abc[r[i] % abc.length];
  return s;
}
const roomMenu = {
  code: ROOM,
  bots: ROOM_BOTS,
  inviteUrl: ROOM ? location.origin + '/' + roomQuery(ROOM, ROOM_BOTS) : '',
  note: ROOM ? 'Send this link to your friends. Everyone who opens it lands in this room.' : '',
  onCreate(withBots, name) { goRoom(randomRoomCode(), withBots ? 4 : 0, name); },
  onJoin(code, name) {
    const c = String(code).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
    if (c) goRoom(c, undefined, name);
  },
  onLeave(name) { goRoom('', undefined, name); },
};
// Hosting from this computer: "localhost" means nothing to friends, so swap in the LAN address.
if (ROOM && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
  roomMenu.note = 'This link only works on this computer. To play with friends, they need a link to a server they can reach.';
  fetch('/lan').then((r) => r.json()).then((j) => {
    const ip = j && j.addresses && j.addresses[0];
    if (!ip) return;
    roomMenu.inviteUrl = `http://${ip}:${j.port}/` + roomQuery(ROOM, ROOM_BOTS);
    roomMenu.note = 'Works for friends on the same Wi-Fi or network as this computer. Friends elsewhere need the game hosted online.';
    if (hud.setInvite) hud.setInvite(roomMenu.inviteUrl, roomMenu.note);
  }).catch(() => { /* keep the localhost link */ });
}

// ------------------------------------------------------------------ menu flow
let menuShown = 0;
function showMenu() {
  menuOpen = true;
  // Refresh the server line when the menu reopens (it is not polled while idle).
  if (server.state === 'online' && !server.pending && !net.state.connected && performance.now() - server.checkedAt > 15000) probeSoon(0);
  input.enabled = false;
  scoreboardHeld = false;
  input.setScoreboardActive(false);
  hud.showMenu({
    defaultName: playerName,
    settings: { ...settings },
    room: roomMenu,
    inGame: started,
    tab: menuShown++ === 0 && ROOM ? 'friends' : undefined,
    loadout: {
      saved: savedLoadout,
      status: loadoutStatus(),
      onChange(v) {
        savedLoadout = v;
        save('hopshot.loadout', v);
        net.setLoadout(v.code);
        hud.setLoadoutStatus(loadoutStatus());
      },
    },
    onPlay(name) {
      playerName = String(name || 'Player').slice(0, 16);
      save('hopshot.name', playerName);
      audio.unlock();
      input.requestLock().then((ok) => { lockHint = !ok; });
      hideMenu();
      if (IS_TOUCH && !FORCED_TOUCH) goFullscreen();
      if (!started) { started = true; net.connect(playerName, ROOM, { bots: ROOM_BOTS }); }
    },
    onSettings(s) {
      Object.assign(settings, sanitize(s, settings));
      applySettings();
      save('hopshot.settings', settings);
    },
  });
}
// Phones: hide the browser chrome and pin landscape when the browser allows it (both can be refused).
function goFullscreen() {
  try {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req && !document.fullscreenElement && !document.webkitFullscreenElement) {
      const r = req.call(el, { navigationUI: 'hide' });
      const lock = () => { try { const o = screen.orientation; if (o && o.lock) o.lock('landscape').catch(() => {}); } catch { /* unsupported */ } };
      if (r && r.then) r.then(lock, () => {}); else lock();
    }
  } catch { /* unsupported */ }
}
function hideMenu() {
  menuOpen = false;
  hud.hideMenu();
  input.enabled = !AUTOPLAY;
}

canvas.addEventListener('click', () => {
  if (IS_TOUCH) return;     // touch: the overlay handles taps, there is no pointer lock
  audio.unlock();
  if (net.state.status === 'reconnecting') net.retryNow();
  if (!AUTOPLAY && !menuOpen && !input.locked) input.requestLock().then((ok) => { lockHint = !ok; });
});

// ------------------------------------------------------------------ connection status
let statusText = '';
let lockHint = false;     // pointer lock was refused: tell the player to click
function setStatus(t) { statusText = t; hud.setStatus(t); }
let reconnectInfo = null;

// ------------------------------------------------------------------ server availability
// Free hosting tiers put the server to sleep when nobody is playing, and waking it takes up to
// a minute. Probe /health so the menu and the in-game overlay can say what is going on. While
// a match is running the same probe doubles as a light keep-alive.
const server = { state: 'checking', since: performance.now(), humans: 0, pending: false, timer: null, checkedAt: 0 };
let wakeShown = false;
let serverUiNext = 0;
function setServerState(state) {
  if (server.state !== state) { server.state = state; server.since = performance.now(); }
}
function probeSoon(ms) {
  clearTimeout(server.timer);
  server.timer = setTimeout(probeServer, ms);
}
async function probeServer() {
  if (server.pending) return;
  server.pending = true;
  clearTimeout(server.timer);
  // A sleeping host holds the request open while it boots: call it "waking" once it is slow.
  const slow = setTimeout(() => { if (server.state === 'checking') setServerState('waking'); }, 2500);
  const ctl = new AbortController();
  const kill = setTimeout(() => ctl.abort(), 90000);
  let next = 2500;
  try {
    const r = await fetch(SERVER_HTTP + '/health', { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error('bad status');
    const j = await r.json();
    server.humans = j.humans | 0;
    const wasDown = server.state !== 'online';
    setServerState('online');
    if (wasDown && started && !net.state.connected && net.state.status === 'reconnecting') net.retryNow();
    server.checkedAt = performance.now();
    // Keep-alive only while actually playing. An idle menu must not poll, or an open tab would
    // stop a sleep-when-idle host from ever sleeping.
    next = net.state.connected ? 240000 : 0;
  } catch {
    if (server.state !== 'waking') setServerState('waking');
  } finally {
    clearTimeout(slow);
    clearTimeout(kill);
    server.pending = false;
    if (next > 0) probeSoon(next);
  }
}
function updateServerUi(t) {
  const secs = Math.max(0, Math.floor((t - server.since) / 1000));
  let kind = server.state;
  let pill;
  if (kind === 'online') pill = server.humans > 0 ? `Server online · ${server.humans} playing` : 'Server online';
  else if (kind === 'checking') pill = 'Contacting server…';
  else if (secs < 90) pill = `Waking up the server… ${secs}s`;
  else { kind = 'offline'; pill = 'Server is not responding. Still trying…'; }
  hud.setServer(kind, pill);
  wakeShown = started && !menuOpen && !net.state.connected && (kind === 'waking' || kind === 'offline');
  if (kind === 'offline') {
    hud.setWake(wakeShown, 'Server is not responding', 'Still trying to reach it. Check your connection, or try again in a minute.');
  } else {
    hud.setWake(wakeShown, 'Waking up the server', `The server sleeps when nobody is playing. Starting it usually takes under a minute. (${secs}s)`);
  }
}
probeServer();

net.on('status', (s, extra) => {
  hud.setLoadoutStatus(loadoutStatus());
  if (s === 'connected') { setServerState('online'); probeSoon(240000); }
  else if (s === 'reconnecting' && server.state === 'online' && !server.pending) { setServerState('checking'); probeSoon(0); }
  if (s === 'connecting' || s === 'joining') setStatus(net.stats.connects ? 'Reconnecting...' : 'Connecting...');
  else if (s === 'connected') { reconnectInfo = null; setStatus(''); }
  else if (s === 'reconnecting') reconnectInfo = { at: performance.now() + (extra ? extra.inMs : 0) };
  else if (s === 'closed') setStatus('Disconnected');
});
net.on('error', (m) => {
  if (m.code === 'room_full') setStatus('Room is full - retrying...');
  else if (m.code === 'bad_version') setStatus('Version mismatch - reload the page');
  else setStatus(String(m.message || m.code || 'Server error'));
});

// ------------------------------------------------------------------ game events
const counters = { kills: 0, hits: 0, damage: 0, spawns: 0, localDeaths: 0, remoteShots: 0, rounds: 0 };
const nameOf = (id) => { const e = net.state.roster.get(id); return e ? e.name : (id ? '#' + id : ''); };

net.on('welcome', () => {
  if (autopilot) autopilot.setYaw(input.yaw);
});
net.on('spawn', (m) => {
  counters.spawns++;
  if (m.id === net.state.id) {
    input.yaw = +m.yaw || 0;
    input.pitch = 0;
    if (autopilot) autopilot.setYaw(input.yaw);
  }
});
net.on('kill', (m) => {
  counters.kills++;
  const me = net.state.id;
  const g = GUNS[m.gun] || GUNS[(m.weapon | 0) * 2] || GUNS[0];
  const env = !m.killer;     // fell out of the map / world kill
  hud.addKill({
    killerName: env ? nameOf(m.victim) : nameOf(m.killer),
    victimName: env ? '' : nameOf(m.victim),
    weaponKey: env ? 'fell' : g.key,
    weaponName: env ? 'fell' : g.name,
    headshot: !!m.headshot,
    localInvolved: m.killer === me || m.victim === me,
  });
  if (m.victim === me) {
    counters.localDeaths++; audio.play('death');
    if (RANDLO) net.setLoadout(randomLoadoutCode());
  }
});
net.on('hit', (m) => {
  counters.hits++;
  hud.hitmarker({ headshot: !!m.headshot, kill: !!m.kill });
  audio.play(m.headshot ? 'headshot' : 'hit');
  if (m.kill) audio.play('kill');
});
net.on('damage', (m) => {
  counters.damage++;
  const p = net.pred;
  if (Array.isArray(m.from)) {
    const dx = m.from[0] - p.x, dz = m.from[2] - p.z;
    // direction to the attacker in yaw convention (yaw 0 = -Z, + = left), relative to the view
    const toYaw = Math.atan2(-dx, -dz);
    hud.damageFrom(wrapAngle(toYaw - input.yaw));
  } else hud.damageFrom(0);
  audio.play('hurt');
});
net.on('round', (m) => {
  counters.rounds++;
  if (m.phase === 'intermission') {
    const rows = scoreRows();
    hud.showRoundEnd({
      winnerName: m.winner ? nameOf(m.winner) : '',
      rows,
      nextIn: Math.max(0, (m.endsTick - net.serverTick()) / TICK_RATE),
    });
  } else hud.hideRoundEnd();
});
net.on('close', () => { hud.hideRoundEnd(); });

// remote shots: tracers, impacts, muzzle flash, positional sound (own shots are predicted)
const shotFrom = [0, 0, 0], shotTo = [0, 0, 0];
const seenShooter = new Set();
net.on('shots', (shots) => {
  seenShooter.clear();
  const me = net.state.id;
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    if (s.shooter === me) continue;
    counters.remoteShots++;
    if (!net.remoteEye(s.shooter, shotFrom)) continue;
    shotTo[0] = s.x; shotTo[1] = s.y; shotTo[2] = s.z;
    const gun = s.gun >= 0 && s.gun < GUNS.length ? s.gun : (s.weapon | 0) * 2;
    renderer.tracer(shotFrom, shotTo, { local: false, gun });
    if (s.kind !== SHOT.MISS) renderer.impact(shotTo, s.normal, { flesh: s.kind === SHOT.BODY || s.kind === SHOT.HEAD });
    if (!seenShooter.has(s.shooter)) {
      seenShooter.add(s.shooter);
      renderer.remoteFire(s.shooter);
      audio.play(GUNS[gun].key, { pos: shotFrom.slice(), volume: 0.9 });
    }
  }
});

function scoreRows() {
  const me = net.state.id;
  const rows = [];
  for (const e of net.state.roster.values()) {
    rows.push({ id: e.id, name: e.name, kills: e.kills, deaths: e.deaths, ping: e.id === me && Number.isFinite(net.state.ping) ? net.state.ping : e.ping, isLocal: e.id === me, isBot: e.bot });
  }
  return rows;
}

// ------------------------------------------------------------------ simulation
const cmdInput = { buttons: 0, yaw: 0, pitch: 0, weapon: 0 };
const local = { alive: false, x: 0, y: 0, z: 0, eyeHeight: 1.62, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0,
  onGround: true, crouching: false, sliding: false, weapon: 0, gun: 0, aim: 0, ads: 0, reloading: false,
  att: 0, adsFov: 90, swapDur: 0.3, reloadP: 0, scopeKind: 0 };
const frame = { dt: 0, time: 0, local, players: [] };
let stepAcc = 0;
let adsHeld = false;
let curRenderTick = 0;

function simTick() {
  let buttons;
  if (autopilot) {
    const p = net.pred, w = net.predWeapon;
    const o = autopilot.update({
      world, self: p, alive: net.state.alive, remotes: frame.players,
      weapon: w.weapon, ammo: w.ammo[w.weapon], magSize: net.kit.slots[w.weapon].magSize, auto: net.kit.slots[w.weapon].auto,
    });
    input.yaw = o.yaw; input.pitch = o.pitch; input.weapon = o.weapon;
    buttons = o.buttons;
  } else {
    buttons = input.sampleButtons();
  }
  if (menuOpen && !AUTOPLAY) buttons = 0;
  adsHeld = (buttons & BTN.ADS) !== 0;
  cmdInput.buttons = buttons;
  cmdInput.yaw = input.yaw;
  cmdInput.pitch = input.pitch;
  cmdInput.weapon = input.weapon;
  const fx = net.tick(cmdInput, curRenderTick);
  if (fx && fx.alive) liveEffects(fx);
}

// Side effects of the FIRST (live) prediction of a tick only - replays never get here.
function liveEffects(fx) {
  if (fx.fired) {
    const eff = net.kit.slots[fx.weapon];
    renderer.localFire(fx.gun, net.kit.masks[fx.weapon], eff.fireTicks / TICK_RATE);
    audio.play(GUNS[fx.gun].key, { volume: 0.75 });
    for (let k = 0; k < fx.shotCount; k++) {
      const s = fx.shots[k];
      renderer.tracer(s.from, s.to, { local: true, gun: fx.gun });
      if (s.kind !== SHOT.MISS) renderer.impact(s.to, s.hasNormal ? s.normal : null, { flesh: s.kind === SHOT.BODY || s.kind === SHOT.HEAD });
    }
  }
  if (fx.switched) audio.play('switch', { volume: 0.6 });
  if (fx.reloadStart) {
    const e = net.kit.slots[net.predWeapon.weapon];
    audio.play('reload_' + (e.cls === 'assault' ? 'rifle' : e.cls), { volume: 0.7, dur: e.reloadTicks / TICK_RATE, pitch: e.gun === 1 ? 1.2 : e.gun === 3 ? 0.8 : 1 });
  }
  if (fx.empty) audio.play('empty', { volume: 0.7 });
  if (fx.jumped) audio.play('jump', { volume: 0.5 });
  if (fx.landed && fx.landSpeed > 3) audio.play('land', { volume: Math.min(1, 0.3 + fx.landSpeed / 20) });
  if (fx.slideStart) audio.play('slide', { volume: 0.7 });
  if (fx.groundMove > 0) {
    stepDist += fx.groundMove;
    if (stepDist > STEP_DIST) { stepDist = 0; audio.play('step', { volume: 0.35 }); }
  }
}
let stepDist = 0;

// ------------------------------------------------------------------ frame loop
let lastFrame = performance.now();
let fps = 60, fpsFrames = 0, fpsT = 0, time = 0;
let errors = 0, lastErrorLog = 0;

document.addEventListener('visibilitychange', () => {
  // coming back from a hidden tab: resync instead of simulating the whole gap
  lastFrame = performance.now();
  stepAcc = 0;
  if (document.hidden) input.clear();
});

function frameLoop() {
  requestAnimationFrame(frameLoop);
  try {
    runFrame();
  } catch (err) {
    errors++;
    const t = performance.now();
    if (t - lastErrorLog > 1000) { lastErrorLog = t; console.error('[hopshot] frame error:', err); }
  }
}

function runFrame() {
  const t = performance.now();
  let dtMs = t - lastFrame;
  lastFrame = t;
  if (dtMs > RESYNC_MS) { dtMs = TICK_MS; stepAcc = 0; }
  if (dtMs < 0) dtMs = 0;
  const dt = dtMs / 1000;
  time += dt;
  fpsFrames++; fpsT += dt;
  if (fpsT >= 0.5) { fps = fpsFrames / fpsT; fpsFrames = 0; fpsT = 0; }

  // remote players at the interpolation time (also what lag compensation will rewind to)
  const connected = net.state.connected;
  curRenderTick = connected ? net.renderTick(t) : 0;
  net.sampleRemotes(curRenderTick, frame.players);

  // touch assists: gentle aim pull + auto-fire (client-side input shaping only)
  if (input.touch && !AUTOPLAY) {
    if (connected && input.enabled) {
      const pw = net.predWeapon;
      input.applyAssist(dt, { world, self: net.pred, alive: net.state.alive, remotes: frame.players,
        weapon: pw.weapon, ammo: pw.ammo[pw.weapon], reloading: pw.reload > 0, ads: local.ads, range: net.kit.slots[pw.weapon].range,
        aimAssist: settings.aimAssist, autoFire: settings.autoFire });
    } else { input.state.autoFire = false; input.state.assistSlow = 1; }
  }

  // fixed-step simulation
  if (connected) {
    stepAcc += dtMs;
    let n = 0;
    while (stepAcc >= TICK_MS && n < MAX_CATCHUP_TICKS) { simTick(); stepAcc -= TICK_MS; n++; }
    if (stepAcc >= TICK_MS) stepAcc %= TICK_MS;     // cap catch-up: drop the rest
  } else stepAcc = 0;
  const alpha = stepAcc / TICK_MS;

  // local view
  net.decayError(dt);
  net.localView(alpha, local);
  if (!connected) local.alive = false;
  local.yaw = input.yaw;
  local.pitch = input.pitch;
  // aim comes from the weapon state (net.localView -> local.aim 0..1), so it follows each gun's and
  // attachment's real aim time; a little smoothing hides the 60 Hz stepping on fast displays
  const kit = net.kit;
  const eff = kit.slots[local.weapon] || kit.slots[0];
  input.kit = kit;
  local.ads = local.alive ? local.ads + (local.aim - local.ads) * (1 - Math.exp(-dt * 45)) : 0;
  local.att = kit.masks[local.weapon] | 0;
  local.adsFov = eff.adsFov;
  local.swapDur = eff.swapTicks / TICK_RATE;
  const pw0 = net.predWeapon;
  local.reloadP = pw0.reload > 0 ? 1 - pw0.reload / eff.reloadTicks : 0;
  local.scopeKind = eff.cls === 'sniper' ? 2 : (local.att & 1) ? 1 : 0;
  // keep the on-screen sensitivity constant while zoomed
  const zoom = Math.tan((eff.adsFov * Math.PI) / 360) / Math.tan((settings.fov * Math.PI) / 360);
  input.adsScale = 1 + (zoom * settings.adsSens - 1) * local.ads;

  frame.dt = dt;
  frame.time = time;
  renderer.render(frame);
  audio.setListener(local.x, local.y + local.eyeHeight, local.z, local.yaw);

  // HUD
  updateHud(t);
}

const hudSlots = [{ name: '', att: 0 }, { name: '', att: 0 }, { name: '', att: 0 }];
const hudState = { alive: true, health: 100, ammo: 0, magSize: 0, weaponKey: 'maul', weaponName: 'Maul', reloading: false,
  slots: hudSlots, slot: 0, scope: 0, crossGap: 7,
  ads: 0, speed: 0, kills: 0, deaths: 0, roundTimeLeft: 0, respawnIn: 0, ping: 0, fps: 60, players: 0 };
let sbNext = 0;

function updateHud(t) {
  const s = net.state;
  const pw = net.predWeapon;
  const kit = net.kit;
  const w = kit.slots[pw.weapon] || kit.slots[0];
  const st = net.serverTick(t);
  const me = s.roster.get(s.id);
  hudState.alive = s.connected ? s.alive : true;
  hudState.health = s.health;
  hudState.ammo = pw.ammo[pw.weapon];
  hudState.magSize = w.magSize;
  hudState.weaponKey = w.key;
  hudState.weaponName = w.name;
  hudState.slot = pw.weapon;
  for (let i = 0; i < SLOT_COUNT; i++) { hudSlots[i].name = kit.slots[i].name; hudSlots[i].att = popcount6(kit.masks[i]); }
  // scope overlay: a sniper rifle or any gun with the optic, once (nearly) fully aimed and not reloading
  hudState.scope = s.alive && local.ads > 0.85 && pw.reload === 0 ? local.scopeKind : 0;
  // crosshair gap = real spread (hip vs aimed blend + recoil bloom) projected to screen pixels
  {
    const fovR = renderer.getCamera().fov * Math.PI / 180;
    const px = Math.tan(currentSpread(w, pw)) * (window.innerHeight / 2) / Math.tan(fovR / 2) / settings.crosshairSize;
    hudState.crossGap = Math.max(2.5, Math.min(90, px));
  }
  hudState.reloading = pw.reload > 0;
  hudState.ads = local.ads;
  hudState.speed = Math.hypot(local.vx, local.vz);
  hudState.kills = me ? me.kills : 0;
  hudState.deaths = me ? me.deaths : 0;
  hudState.roundTimeLeft = s.connected ? Math.max(0, (s.round.endsTick - st) / TICK_RATE) : 0;
  hudState.respawnIn = s.alive ? 0 : Math.max(0, Math.min(RESPAWN_MS / 1000, (s.respawnAtTick - st) / TICK_RATE));
  hudState.ping = Number.isFinite(s.ping) ? s.ping : null;
  hudState.fps = fps;
  hudState.quality = s.quality || null;
  hudState.players = s.connected ? s.roster.size : null;
  hud.update(hudState);
  hud.setInGame(started && !menuOpen);

  if (scoreboardHeld && !menuOpen && t >= sbNext) { sbNext = t + 250; hud.setScoreboard(true, scoreRows()); }

  if (t >= serverUiNext) { serverUiNext = t + 250; updateServerUi(t); }

  if (wakeShown) {
    if (statusText !== '') setStatus('');
  } else if (reconnectInfo) {
    const left = Math.max(0, Math.ceil((reconnectInfo.at - t) / 1000));
    const txt = `Disconnected - reconnecting in ${left}s (click to retry)`;
    if (txt !== statusText) setStatus(txt);
  } else if (s.connected) {
    const want = lockHint && !IS_TOUCH && !input.locked && !menuOpen && !AUTOPLAY ? 'Click to capture the mouse' : '';
    if (want !== statusText) setStatus(want);
  }
}

// ------------------------------------------------------------------ debug surface
const r3 = (v) => Math.round(v * 1000) / 1000;
window.__hopshot = {
  get connected() { return net.state.connected; },
  get status() { return net.state.status; },
  get id() { return net.state.id; },
  get room() { return net.state.roomName; },
  get autoplay() { return AUTOPLAY; },
  get alive() { return net.state.alive; },
  get health() { return net.state.health; },
  get local() {
    const p = net.pred, w = net.predWeapon;
    return { x: r3(p.x), y: r3(p.y), z: r3(p.z), vx: r3(p.vx), vy: r3(p.vy), vz: r3(p.vz),
      speed: r3(Math.hypot(p.vx, p.vz)), onGround: p.onGround, crouching: p.crouching, sliding: p.sliding,
      eyeHeight: r3(eyeHeight(p)), yaw: r3(input.yaw), pitch: r3(input.pitch), weapon: w.weapon, ammo: w.ammo.slice(), reloading: w.reload > 0 };
  },
  get remoteCount() { return net.remoteCount; },
  get remotes() { return frame.players.map((p) => ({ id: p.id, name: p.name, x: r3(p.x), y: r3(p.y), z: r3(p.z), alive: p.alive, bot: p.bot })); },
  get roster() { return Array.from(net.state.roster.values()); },
  get ping() { return Number.isFinite(net.state.ping) ? Math.round(net.state.ping) : null; },
  get rtt() { return Number.isFinite(net.state.rtt) ? r3(net.state.rtt) : null; },
  get serverTick() { return r3(net.serverTick()); },
  get renderTick() { return r3(curRenderTick); },
  get seq() { return net.seq; },
  get ackSeq() { return net.state.ackSeq; },
  get reconciliation() {
    const s = net.stats;
    return { snapshots: s.snapshots, compared: s.compared, corrections: s.corrections,
      maxError: r3(s.maxError), avgError: s.compared ? +(s.sumError / s.compared).toExponential(3) : 0,
      lastError: r3(s.lastError), replays: s.replays, maxReplay: s.maxReplay,
      avgReplay: s.replays ? r3(s.replayedCmds / s.replays) : 0, visualSnaps: s.snaps, maxVisualError: r3(s.maxVisualError) };
  },
  get fps() { return Math.round(fps); },
  get isTouch() { return IS_TOUCH; },
  get touch() { return input.touchDebug(); },
  get settings() { return { ...settings }; },
  get quality() { return renderer.getQuality(); },
  get tags() { return renderer.tagDebug(); },
  renderer, audio,
  get kit() { return net.kit; },
  get loadout() { return { saved: savedLoadout, ...net.state.loadout }; },
  get hudState() { return hudState; },
  setLoadout(v) { net.setLoadout(v); },
  get counters() { return { ...counters, predictedShots: net.stats.predictedShots, frameErrors: errors }; },
  get round() { return { ...net.state.round }; },
  net, input,
};

// ------------------------------------------------------------------ go
if (AUTOPLAY) {
  started = true;
  menuOpen = false;
  input.enabled = false;
  net.connect(playerName || 'Autoplay', ROOM, { bots: ROOM_BOTS });
  setStatus('Connecting...');
} else {
  showMenu();
}
requestAnimationFrame(frameLoop);
