// Hopshot client bootstrap: menu + settings, fixed 60 Hz simulation (accumulator) with render
// interpolation, and all renderer / HUD / audio wiring.
//
// URL params: ?room=NAME (private room), ?name=NAME, ?autoplay=1 (synthetic input, no pointer
// lock needed - for automated browsers). Debug surface: window.__hopshot.

import { TICK_RATE, BTN, RESPAWN_MS } from '../shared/constants.js';
import { WEAPONS } from '../shared/weapons.js';
import { MAP } from '../shared/map.js';
import { createWorld, eyeHeight } from '../shared/physics.js';
import { TICK_MS, SHOT } from '../shared/protocol.js';
import { createRenderer } from './render.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import { createInput, createAutopilot, wrapAngle } from './input.js';
import { createNet } from './net.js';

const MAX_CATCHUP_TICKS = 6;           // at most this many sim ticks per frame
const RESYNC_MS = 250;                 // a frame gap longer than this drops the backlog
const ADS_TIME = 0.14;                 // s to fully aim down sights
const STEP_DIST = 2.3;                 // m of ground travel per footstep sound

// ------------------------------------------------------------------ settings / params
const params = new URLSearchParams(location.search);
const AUTOPLAY = params.get('autoplay') === '1' || params.get('autoplay') === 'true';
const ROOM = (params.get('room') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
// Bot fill level for a private room (0 = no bots). Undefined = server default.
const ROOM_BOTS = ROOM && params.has('bots') ? num(params.get('bots'), 0, 0, 20) | 0 : undefined;

function load(key, def) {
  try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch { return def; }
}
function save(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ }
}
function num(v, def, lo, hi) { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; }

const stored = load('hopshot.settings', {}) || {};
const settings = {
  sensitivity: num(stored.sensitivity, 1, 0.05, 10),
  fov: num(stored.fov, 90, 50, 130),
  volume: num(stored.volume, 0.7, 0, 1),
};
let playerName = String(params.get('name') || load('hopshot.name', '') || (AUTOPLAY ? 'Autoplay' : '')).slice(0, 16);

// ------------------------------------------------------------------ modules
const canvas = document.getElementById('game');
const hudRoot = document.getElementById('hud');
const world = createWorld(MAP);
const renderer = createRenderer(canvas, MAP);
const hud = createHud(hudRoot);
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
  onLockChange(locked) {
    if (locked) { hideMenu(); return; }
    if (!AUTOPLAY) showMenu();
  },
  onLockError() { /* we keep playing unlocked; a canvas click retries */ },
  onScoreboard(held) { scoreboardHeld = held; if (!held) hud.setScoreboard(false); },
  onEscape() { if (!AUTOPLAY && !menuOpen) showMenu(); },
});
input.sensitivity = settings.sensitivity;

function applySettings() {
  renderer.setFov(settings.fov);
  audio.setVolume(settings.volume);
  input.sensitivity = settings.sensitivity;
}
applySettings();

const onResize = () => renderer.resize(window.innerWidth, window.innerHeight);
window.addEventListener('resize', onResize);
onResize();

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
function showMenu() {
  menuOpen = true;
  input.enabled = false;
  hud.showMenu({
    defaultName: playerName,
    settings: { ...settings },
    room: roomMenu,
    onPlay(name) {
      playerName = String(name || 'Player').slice(0, 16);
      save('hopshot.name', playerName);
      audio.unlock();
      input.requestLock().then((ok) => { lockHint = !ok; });
      hideMenu();
      if (!started) { started = true; net.connect(playerName, ROOM, { bots: ROOM_BOTS }); }
    },
    onSettings(s) {
      settings.sensitivity = num(s.sensitivity, settings.sensitivity, 0.05, 10);
      settings.fov = num(s.fov, settings.fov, 50, 130);
      settings.volume = num(s.volume, settings.volume, 0, 1);
      applySettings();
      save('hopshot.settings', settings);
    },
  });
}
function hideMenu() {
  menuOpen = false;
  hud.hideMenu();
  input.enabled = !AUTOPLAY;
}

canvas.addEventListener('click', () => {
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
const server = { state: 'checking', since: performance.now(), humans: 0, pending: false, timer: null };
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
    next = net.state.connected ? 240000 : 20000;
  } catch {
    if (server.state !== 'waking') setServerState('waking');
  } finally {
    clearTimeout(slow);
    clearTimeout(kill);
    server.pending = false;
    probeSoon(next);
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
  const w = WEAPONS[m.weapon] || WEAPONS[0];
  const env = !m.killer;     // fell out of the map / world kill
  hud.addKill({
    killerName: env ? nameOf(m.victim) : nameOf(m.killer),
    victimName: env ? '' : nameOf(m.victim),
    weaponKey: env ? 'fell' : w.key,
    headshot: !!m.headshot,
    localInvolved: m.killer === me || m.victim === me,
  });
  if (m.victim === me) { counters.localDeaths++; audio.play('death'); }
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
    renderer.tracer(shotFrom, shotTo, { local: false });
    if (s.kind !== SHOT.MISS) renderer.impact(shotTo, s.normal, { flesh: s.kind === SHOT.BODY || s.kind === SHOT.HEAD });
    if (!seenShooter.has(s.shooter)) {
      seenShooter.add(s.shooter);
      renderer.remoteFire(s.shooter);
      audio.play((WEAPONS[s.weapon] || WEAPONS[0]).key, { pos: shotFrom.slice(), volume: 0.9 });
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
  onGround: true, crouching: false, sliding: false, weapon: 0, ads: 0, reloading: false };
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
      weapon: w.weapon, ammo: w.ammo[w.weapon], magSize: WEAPONS[w.weapon].magSize,
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
    renderer.localFire(fx.weapon);
    audio.play(WEAPONS[fx.weapon].key, { volume: 0.75 });
    for (let k = 0; k < fx.shotCount; k++) {
      const s = fx.shots[k];
      renderer.tracer(s.from, s.to, { local: true });
      if (s.kind !== SHOT.MISS) renderer.impact(s.to, s.hasNormal ? s.normal : null, { flesh: s.kind === SHOT.BODY || s.kind === SHOT.HEAD });
    }
  }
  if (fx.switched) audio.play('switch', { volume: 0.6 });
  if (fx.reloadStart) audio.play('reload', { volume: 0.7 });
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
  const adsTarget = adsHeld && local.alive && !local.reloading ? 1 : 0;
  local.ads += Math.max(-dt / ADS_TIME, Math.min(dt / ADS_TIME, adsTarget - local.ads));
  if (!local.alive) local.ads = 0;
  const w = WEAPONS[local.weapon] || WEAPONS[0];
  // keep the on-screen sensitivity constant while zoomed
  const zoom = Math.tan((w.adsFov * Math.PI) / 360) / Math.tan((settings.fov * Math.PI) / 360);
  input.adsScale = 1 + (zoom - 1) * local.ads;

  frame.dt = dt;
  frame.time = time;
  renderer.render(frame);
  audio.setListener(local.x, local.y + local.eyeHeight, local.z, local.yaw);

  // HUD
  updateHud(t);
}

const hudState = { alive: true, health: 100, ammo: 0, magSize: 0, weaponKey: 'rifle', weaponName: 'Rifle', reloading: false,
  ads: 0, speed: 0, kills: 0, deaths: 0, roundTimeLeft: 0, respawnIn: 0, ping: 0, fps: 60, players: 0 };
let sbNext = 0;

function updateHud(t) {
  const s = net.state;
  const pw = net.predWeapon;
  const w = WEAPONS[pw.weapon] || WEAPONS[0];
  const st = net.serverTick(t);
  const me = s.roster.get(s.id);
  hudState.alive = s.connected ? s.alive : true;
  hudState.health = s.health;
  hudState.ammo = pw.ammo[pw.weapon];
  hudState.magSize = w.magSize;
  hudState.weaponKey = w.key;
  hudState.weaponName = w.name;
  hudState.reloading = pw.reload > 0;
  hudState.ads = local.ads;
  hudState.speed = Math.hypot(local.vx, local.vz);
  hudState.kills = me ? me.kills : 0;
  hudState.deaths = me ? me.deaths : 0;
  hudState.roundTimeLeft = s.connected ? Math.max(0, (s.round.endsTick - st) / TICK_RATE) : 0;
  hudState.respawnIn = s.alive ? 0 : Math.max(0, Math.min(RESPAWN_MS / 1000, (s.respawnAtTick - st) / TICK_RATE));
  hudState.ping = Number.isFinite(s.ping) ? s.ping : null;
  hudState.fps = fps;
  hudState.players = s.connected ? s.roster.size : null;
  hud.update(hudState);

  if (scoreboardHeld && !menuOpen && t >= sbNext) { sbNext = t + 250; hud.setScoreboard(true, scoreRows()); }

  if (t >= serverUiNext) { serverUiNext = t + 250; updateServerUi(t); }

  if (wakeShown) {
    if (statusText !== '') setStatus('');
  } else if (reconnectInfo) {
    const left = Math.max(0, Math.ceil((reconnectInfo.at - t) / 1000));
    const txt = `Disconnected - reconnecting in ${left}s (click to retry)`;
    if (txt !== statusText) setStatus(txt);
  } else if (s.connected) {
    const want = lockHint && !input.locked && !menuOpen && !AUTOPLAY ? 'Click to capture the mouse' : '';
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
