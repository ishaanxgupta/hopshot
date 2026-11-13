// Hopshot client networking: connection + join, clock sync, client-side prediction with the
// shared physics/weapon code, server reconciliation (rewind to the acked state, replay the
// un-acked cmds, visual error smoothing), the remote-player interpolation buffer, roster /
// scores / round state, and an event surface for main.js.
//
// DOM-free on purpose: it only uses WebSocket, performance and timers, so it runs headlessly
// in Node (tools/client.test.js) exactly as it runs in the browser.
//
//   const net = createNet({ world, url });
//   net.on('welcome' | 'spawn' | 'kill' | 'hit' | 'damage' | 'round' | 'scores' | 'join' |
//          'leave' | 'error' | 'status' | 'shots' | 'snapshot', fn);
//   net.connect(name, room);                // auto-reconnects with backoff until net.close()
//   per sim tick:   const fx = net.tick({ buttons, yaw, pitch, weapon }, renderTick);
//   per frame:      const rt = net.renderTick(now); net.sampleRemotes(rt, players);
//                   net.decayError(dt); net.localView(alpha, out);
//
// Netcode (protocol v2):
//   - Remote players are rendered on a clock derived from snapshot ARRIVAL times (de-jittered
//     with a windowed max), delayed by an adaptive interpolation delay sized from the measured
//     arrival jitter (INTERP_DELAY_MS .. INTERP_DELAY_MAX_MS, smooth, never runs backwards).
//     The render tick actually used is still sent with every input (lag compensation).
//   - Time dilation: the server reports its input-buffer depth for us and a timeScale
//     (+-MAX_DILATION_PERMILLE). net.tick() applies it internally by occasionally predicting two
//     ticks in one call or skipping one (only when the input did not change, so no press is
//     lost); the visual offset of that is smoothed like a correction. main.js needs no change.
//     Exposed as net.timeScale.
//   - net.state.quality = { rttMs, jitterMs, interpDelayMs, timeScale, inputBufferTicks,
//     corrections10s, starved10s } (same object, refreshed ~1/s) for the HUD net-stats line.
//
// Loadouts (protocol v3):
//   net.setLoadout(loadout)      any form weapons.sanitizeLoadout accepts (object or code). Stored,
//                                sent now if connected (else with the next join), and carried by
//                                every (re)join. It is PENDING until your next spawn.
//   net.state.loadout = { pendingCode, pending, activeCode, active, serverPendingCode }
//                                pending = what you chose (applies at next spawn); active = the
//                                loadout of your current life (from your last 'spawn' event);
//                                serverPendingCode = the server's sanitised copy of pending.
//   net.kit                      getKit(activeCode): per-slot effective stats for HUD / viewmodel
//                                (net.kit.slots[slot].magSize, .adsFov, .name, net.kit.guns[slot]).
//   event 'loadout' (state.loadout) whenever pending / active / serverPending changes.
//   Prediction and predicted shots use the ACTIVE kit, bit-exact with the server.
//   Remote players: the interpolated objects carry gun (gun id in hand), lo (that life's
//   loadout code) and att (attachment mask of the gun in hand); roster entries carry lo.
//   fx.gun / localView(out).gun = gun id in hand; localView(out).aim = aim progress 0..1.
//
// Modes, lobby, maps (protocol v4; rules in shared/modes.js):
//   createNet({ url, world? })   world is only a fallback: net predicts on the map the server
//                                names (welcome / 'match' mapId) and builds + caches that world
//                                itself. net.world / net.map = the current world / map object.
//   event 'map' ({ mapId, map, world })   on every welcome and whenever the map changes: rebuild
//                                the renderer from `map`. Only happens while you are dead
//                                (lobby / countdown / results), so prediction stays exact.
//   net.state.match (same object until the next welcome; read it every frame):
//     { phase: 'lobby'|'countdown'|'playing'|'results', mode, modeInfo (MODES[mode]), teams,
//       private, mapId, mapName, map, config, scoreLimit, timeLimitS, scores: { a, b },
//       startTick, endsTick, hostId, isHost, myTeam: ''|'a'|'b',
//       lobby: [{ id, name, team, bot, host }],
//       flags: null | { a: Flag, b: Flag }   (ctf; flags.a = team A's flag)
//         Flag = { state: 'home'|'carried'|'dropped', carrier, pos: [x,y,z] (follows the
//                  carrier's rendered position every sampleRemotes), returnTick, returnInS },
//       hardpoint: null | { index, name, min, max, owner: ''|'a'|'b'|'contested', rotateTick,
//                  rotateInS, next, count: { a, b } },
//       result: null | { mode, mapId, winner: 'a'|'b'|<id>|null, draw, winnerName, scores,
//                  reason: 'score'|'time', endsTick, rows: [{ id, name, team, bot, kills, deaths, obj }] },
//       timeLeftS, countdown, resultsLeftS }   (the last three are live getters, in seconds)
//   net.state.team / .protected / .carrier   your own team, spawn protection, carrying a flag
//   localView(out) also sets out.team, out.protected, out.carrier; remote objects from
//   sampleRemotes carry team ('' | 'a' | 'b'), protected and carrier; roster entries carry
//   team and obj (captures / zone seconds).
//   net.setMatchConfig(partial) host, lobby: edits are merged + sanitised and sent at most every
//                                250 ms; returns the full config requested
//   net.startMatch()             host, lobby -> countdown
//   net.switchTeam('a'|'b')      lobby, team modes (not co-op)
//   net.returnToLobby()          host, private rooms: abort countdown / match / results
//   A rejected request arrives as event 'error' { code: not_host|bad_phase|bad_team|bad_config, req }.
//   events: 'match' (state.match) any match change; 'phase' (phase, prev); 'lobby' (lobby);
//   'team' ({ id, team }); 'objective' (state.match) flags / zone / scores changed;
//   'ev' ({ e, ... }) flag_taken / flag_dropped / flag_returned / flag_captured / zone_rotated /
//   zone_taken / zone_contested / zone_neutral / match_start / match_end; 'result' (result).
//   In the lobby net.tick() returns null and sends no input (nobody is simulated there).
//
// Voice chat signaling (protocol v5; client/voice.js does the WebRTC part):
//   net.state.voice = { enabled, ice }   from the welcome: enabled only in private rooms, ice =
//                                the RTCIceServer list the server hands out (STUN, maybe TURN)
//   roster entries carry mic / deaf (that player is transmitting / has the speaker off)
//   net.sendRtc(to, d)           signal for peer `to` (protocol.encodeRtc); dropped unless connected
//   net.sendVoiceState(mic, deaf)
//   events: 'rtc' ({ from, d })  d already passed protocol.sanitizeSignal
//           'voice' ({ id, mic, deaf, relay })   a player's voice state changed (roster updated first)
// Voice relay (protocol.js VOICE RELAY; used by voice.js when P2P cannot connect):
//   net.state.voice.relay        the server forwards voice frames (welcome.voiceRelay) and takes 'vstat'
//   roster entries carry relay   that player can send + play relayed voice
//   net.sendVoiceFrame(targets, seq, opusBytes) -> bool   skipped (false) while the socket is backed up
//   net.sendVoiceStat({ to, state, why, local, remote, pair, ms, nr })   pair diagnostics for the server log
//   net.sendVoiceState(mic, deaf, relay)
//   event 'voiceframe' ({ from, seq, payload })   payload is a view: copy it if you keep it
//
// Memory (protocol v6, optional on the server):
//   net.connect(name, room, { bots, playerCode })   playerCode = the secret player code (main.js keeps
//                                it in localStorage); sent with every join, used only by a server with memory on
//   net.state.memory = { enabled, host, lobby, loadout }   enabled from the welcome; host / lobby /
//                                loadout = the latest suggestions ('memory' message; null / '' = none)
//   event 'memory' (state.memory) whenever enabled or a suggestion changes. With memory on the
//   config sanitiser allows bots.level 'ai'.

import { INTERP_DELAY_MS, INTERP_DELAY_MAX_MS, MAX_DILATION_PERMILLE, BTN, BTN_MASK as BTN_MASK_NET, PLAYER, TICK_RATE } from '../shared/constants.js';
import { getMap, DEFAULT_MAP_ID } from '../shared/maps/index.js';
import { createWorld } from '../shared/physics.js';
import { MODES, sanitizeMatchConfig, defaultMatchConfig, isTeamMode } from '../shared/modes.js';
import {
  createWeaponState, copyWeaponState, resetWeaponState, stepWeapon, shotDir, getKit, moveSpeedMult,
  sameWeaponState, aimFraction, sanitizeLoadout, encodeLoadout, decodeLoadout, sanitizeLoadoutCode,
  DEFAULT_LOADOUT_CODE,
} from '../shared/weapons.js';
import {
  MOVE, createPlayerState, copyState, spawnState, stepPlayer, eyeHeight, hitboxHeight, raycastWorld,
  raycastPlayer,
} from '../shared/physics.js';
import {
  TICK_MS, SHOT, INPUT_REDUNDANCY, createCmd, sanitizeCmd, encodeInput, encodeJoin, encodePing,
  decodeSnapshot, decodeText, createSnapshot, encodeSetLoadout, encodeMatchConfig, encodeStart, encodeTeam,
  encodeReturnToLobby, encodeRtc, encodeVoiceState, sanitizeSignal,
  MSG, VOICE_RELAY_VERSION, encodeVoiceFrame, decodeVoiceRelay, encodeVoiceStat,
} from '../shared/protocol.js';

const VOICE_MAX_BUFFERED = 32 * 1024;   // socket backlog above which voice frames are skipped (stale + would delay input)

const worldCache = new Map();   // map id -> collision world (shared by every net instance)
function worldForMap(map) {
  let w = worldCache.get(map.id);
  if (!w) { w = createWorld(map); worldCache.set(map.id, w); }
  return w;
}

const RING = 256;                          // prediction history (power of two, ~4.3 s)
const RING_MASK = RING - 1;
const INTERP_TICKS = INTERP_DELAY_MS / TICK_MS;          // minimum interpolation delay (6 ticks)
const INTERP_MAX_TICKS = INTERP_DELAY_MAX_MS / TICK_MS;  // maximum (15 ticks)
const SNAP_INTERVAL_TICKS = 2;             // server snapshot period (SNAPSHOT_EVERY)
const ARR_BUCKET_TICKS = 120;              // arrival-offset windowed max: 2 buckets of 2 s
const LATE_N = 90;                         // snapshot lateness samples (~3 s)
const DELAY_QUANTILE = 0.8;                // cover this fraction of snapshot arrivals
const DELAY_MARGIN = 0.5;                  // ticks
const CLOCK_SLEW = 0.06;                   // render clock may run +-6% fast/slow to follow its target
const REMOTE_SMOOTH_TAU = 0.12;            // s, blend-out after an extrapolation / hold
const REMOTE_SNAP = 5.0;                   // m, larger recovery jumps are not smoothed
const REMOTE_JUMP = 0.2;                   // m per tick of sudden departure from the rendered motion
const REMOTE_FRESH_JUMP = 0.45;            // m per tick: faster than anyone moves (27 m/s)
const EXTRAP_TICKS = 6;                    // extrapolate remotes at most 100 ms, then hold
const SAMPLES = 32;                        // per-remote snapshot samples (~1 s at 30 Hz)
const PING_SAMPLES = 10;
const STALE_REMOTE_TICKS = 60;             // drop a remote not present in snapshots for 1 s
const TELEPORT_SPEED = 45;                 // m/s; faster than any legit move -> teleport
const SMOOTH_TAU = 0.1;                    // s, visual error decay time constant
const SNAP_ERROR = 2.5;                    // m, larger corrections snap instead of smoothing
const SILENCE_MS = 6000;                   // no message for this long -> drop and reconnect
const TWO_PI = Math.PI * 2;

function wrapAngle(a) {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

function sameState(a, b) {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.vx === b.vx && a.vy === b.vy && a.vz === b.vz &&
    a.onGround === b.onGround && a.crouching === b.crouching && a.sliding === b.sliding &&
    a.hopArmed === b.hopArmed && a.jumpedAir === b.jumpedAir && a.slideTicks === b.slideTicks &&
    a.slideCooldown === b.slideCooldown && a.groundTicks === b.groundTicks && a.crouchTicks === b.crouchTicks;
}
const sameWeapon = sameWeaponState;

function createSample() {
  return { tick: 0, life: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: false, crouching: false, sliding: false,
    onGround: false, ads: false, reloading: false, weapon: 0, gun: 0, lo: DEFAULT_LOADOUT_CODE, health: 0,
    team: '', protected: false, carrier: false };
}

function createRemote(id) {
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) samples.push(createSample());
  return {
    id, samples, head: 0, count: 0, life: 0, pendingTeleport: true, lastSeenTick: 0,
    // recovery smoothing (after extrapolation / hold): error offset + last rendered motion
    ex: 0, ey: 0, ez: 0, lx: 0, ly: 0, lz: 0, vx: 0, vy: 0, vz: 0, lastRt: 0, lastLife: -1, lastAlive: false, fresh: true,
    wasExtrap: false, wasHold: false,
    out: { id, name: '', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouching: false, sliding: false, alive: false,
      onGround: false, ads: false, reloading: false, weapon: 0, gun: 0, lo: DEFAULT_LOADOUT_CODE, att: 0, health: 0, life: 0, bot: false,
      team: '', protected: false, carrier: false },
  };
}

/** Sample k back from the newest (0 = newest). */
function sampleAt(r, k) { return r.samples[(r.head - 1 - k + SAMPLES * 2) % SAMPLES]; }

function copySampleTo(o, s) {
  o.x = s.x; o.y = s.y; o.z = s.z; o.yaw = s.yaw; o.pitch = s.pitch; o.alive = s.alive;
  o.crouching = s.crouching; o.sliding = s.sliding; o.onGround = s.onGround; o.ads = s.ads;
  o.reloading = s.reloading; o.weapon = s.weapon; o.health = s.health; o.life = s.life;
  o.gun = s.gun; o.lo = s.lo; o.att = getKit(s.lo).masks[s.weapon] | 0;
  o.team = s.team; o.protected = s.protected; o.carrier = s.carrier;
}

/** Interpolate remote r at fractional tick rt into r.out. */
function interpolate(r, rt) {
  const o = r.out;
  const n = r.count;
  if (n === 0) return o;
  const newest = sampleAt(r, 0);
  if (rt >= newest.tick) {
    copySampleTo(o, newest);
    // brief extrapolation along the last velocity, then hold
    if (n >= 2 && newest.alive) {
      const prev = sampleAt(r, 1);
      const span = newest.tick - prev.tick;
      if (prev.alive && prev.life === newest.life && span > 0 && span <= 8) {
        const t = Math.min(rt - newest.tick, EXTRAP_TICKS) / span;
        o.x = newest.x + (newest.x - prev.x) * t;
        o.y = newest.y + (newest.y - prev.y) * t;
        o.z = newest.z + (newest.z - prev.z) * t;
      }
    }
    return o;
  }
  // find a (tick <= rt) and b (the next one)
  for (let k = 1; k < n; k++) {
    const a = sampleAt(r, k);
    if (a.tick <= rt) {
      const b = sampleAt(r, k - 1);
      if (b.life !== a.life) { copySampleTo(o, a); return o; }   // never lerp across a teleport
      const t = (rt - a.tick) / (b.tick - a.tick);
      const s = t < 0.5 ? a : b;
      copySampleTo(o, s);
      o.x = a.x + (b.x - a.x) * t;
      o.y = a.y + (b.y - a.y) * t;
      o.z = a.z + (b.z - a.z) * t;
      o.yaw = wrapAngle(a.yaw + wrapAngle(b.yaw - a.yaw) * t);
      o.pitch = a.pitch + (b.pitch - a.pitch) * t;
      o.alive = a.alive && b.alive ? true : s.alive;
      return o;
    }
  }
  copySampleTo(o, sampleAt(r, n - 1));  // older than everything buffered: hold the oldest
  return o;
}

export function createNet(opts = {}) {
  // The prediction world follows the room's map id (welcome / 'match'); opts.world is only the
  // fallback for a server that sends no map id. Without opts.world the default map is used
  // until the server names one.
  const fallbackWorld = opts.world || null;
  let curMap = fallbackWorld ? null : getMap(DEFAULT_MAP_ID);
  let world = fallbackWorld || worldForMap(curMap);
  const makeSocket = opts.createSocket || ((url) => new WebSocket(url));
  const now = opts.now || (() => performance.now());

  // ------------------------------------------------------------------ events
  const listeners = Object.create(null);
  function on(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); return api; }
  function off(type, fn) { const l = listeners[type]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }
  function emit(type, a, b) {
    const l = listeners[type];
    if (!l) return;
    for (let i = 0; i < l.length; i++) {
      try { l[i](a, b); } catch (err) { console.error(`[net] ${type} handler failed:`, err); }
    }
  }

  // ------------------------------------------------------------------ state
  const st = {
    url: opts.url || '', name: 'Player', room: '',
    status: 'idle',              // idle | connecting | joining | connected | reconnecting | closed
    connected: false,            // joined and welcomed
    id: 0, roomName: '', mapName: '',
    alive: false, health: 0, respawnAtTick: 0,
    lastSnapTick: -1, ackSeq: -1, lastSeq: 0,
    roster: new Map(),           // id -> { id, name, bot, kills, deaths, ping, lo }
    loadout: {                   // see header (Loadouts)
      pendingCode: DEFAULT_LOADOUT_CODE, pending: decodeLoadout(DEFAULT_LOADOUT_CODE),
      activeCode: DEFAULT_LOADOUT_CODE, active: decodeLoadout(DEFAULT_LOADOUT_CODE),
      serverPendingCode: -1,
    },
    round: { phase: 'playing', endsTick: 0, winner: 0 },
    rtt: NaN, ping: NaN,
    reconnectAttempt: 0, reconnectAt: 0,
    lastError: null,
    timeScale: 1,                // server-driven simulation clock scale (see header)
    quality: {                   // refreshed ~1/s; see header
      rttMs: NaN, jitterMs: 0, interpDelayMs: INTERP_DELAY_MS, timeScale: 1, inputBufferTicks: 0,
      corrections10s: 0, starved10s: 0,
    },
    // (v4) your team / spawn protection / carrying the enemy flag (from your own snapshots)
    team: '', protected: false, carrier: false,
    match: null,                 // see createMatchState (header: Modes, lobby, maps)
    voice: { enabled: false, ice: [], relay: false },   // (v5) see header (Voice chat signaling / Voice relay)
    memory: { enabled: false, host: null, lobby: '', loadout: '' },   // (v6) see header (Memory)
    playerCode: '',
  };
  st.match = createMatchState();

  function createMatchState() {
    const m = {
      phase: 'playing', mode: 'ffa', modeInfo: MODES.ffa, teams: false, private: false,
      mapId: curMap ? curMap.id : '', mapName: curMap ? curMap.name : '', map: curMap,
      config: defaultMatchConfig(), scoreLimit: MODES.ffa.scoreLimit, timeLimitS: MODES.ffa.timeLimitS,
      scores: { a: 0, b: 0 }, startTick: 0, endsTick: 0,
      hostId: 0, isHost: false, myTeam: '',
      lobby: [], flags: null, hardpoint: null, result: null,
    };
    const left = (tick) => (tick > 0 ? Math.max(0, (tick - serverTick()) / TICK_RATE) : 0);
    Object.defineProperties(m, {
      // seconds, computed from the synced server clock whenever read
      timeLeftS: { enumerable: true, get() { return m.phase === 'playing' ? left(m.endsTick) : 0; } },
      countdown: { enumerable: true, get() { return m.phase === 'countdown' ? left(m.endsTick) : 0; } },
      resultsLeftS: { enumerable: true, get() { return m.phase === 'results' ? left(m.endsTick) : 0; } },
    });
    return m;
  }

  const stats = {
    snapshots: 0, compared: 0, corrections: 0, maxError: 0, sumError: 0, lastError: 0,
    replays: 0, replayedCmds: 0, maxReplay: 0, snaps: 0, maxVisualError: 0,
    cmdsSent: 0, packetsSent: 0, bytesUp: 0, bytesDown: 0, remoteShots: 0, predictedShots: 0,
    connects: 0,
    voiceIn: 0, voiceOut: 0, voiceSkipped: 0,   // voice relay frames received / sent / skipped (socket backed up)
    corrWeapon: 0,               // corrections where only the weapon state differed (ammo/cooldown/aim/heat)
    // instrumentation (measurement only)
    corrSum: 0, corrBig: 0, corrMax: 0, corrPos: 0,   // corrections: summed size, > 10 cm, max, with position error
    dilationExtra: 0, dilationSkip: 0, remoteBlends: 0,
    extrapEvents: 0, holdEvents: 0, extrapSamples: 0, holdSamples: 0, remoteSamples: 0,
    ackDelaySum: 0, ackDelayN: 0, ackDelays: new Float32Array(2048),   // input -> ack delay (ms), ring
  };

  // prediction (kit = the ACTIVE loadout of the current life)
  let kit = getKit(DEFAULT_LOADOUT_CODE);
  const pred = createPlayerState();
  const predW = createWeaponState();
  const before = createPlayerState();
  const beforeW = createWeaponState();
  const server = createPlayerState();    // last authoritative self state (at ackSeq)
  const serverW = createWeaponState();
  const ring = [];
  for (let i = 0; i < RING; i++) ring.push({ seq: -1, sentAt: 0, cmd: createCmd(), state: createPlayerState(), ws: createWeaponState(), valid: false });
  let nextSeq = 1;
  const sendList = [];                   // newest INPUT_REDUNDANCY cmds, oldest first
  let teleportPending = true;            // next reconcile snaps the view (spawn / first state)

  // render interpolation of the local player (prev tick -> current tick) + error offset
  const prevView = { x: 0, y: 0, z: 0, eye: PLAYER.eyeHeight };
  const err = { x: 0, y: 0, z: 0 };

  // remotes
  const remotes = new Map();
  const remoteList = [];
  let lastRenderTick = 0;

  // clock
  const pingRtt = new Float64Array(PING_SAMPLES);
  const pingOff = new Float64Array(PING_SAMPLES);
  let pingN = 0, pingHead = 0;
  let clockTarget = 0, clockOffset = 0, clockLast = 0, haveClock = false, havePong = false;

  // render clock from snapshot arrivals
  let arrMaxCur = -1e12, arrMaxPrev = -1e12, arrBucketAt = -1e12, haveArr = false;
  const late = new Float32Array(LATE_N);
  const lateSort = new Float32Array(LATE_N);
  let lateHead = 0, lateN = 0, lateCount = 0;
  let delayTarget = INTERP_TICKS, delayTicks = INTERP_TICKS, jitterTicks = 0;
  let rclk = NaN, rclkAt = 0;

  // time dilation + quality
  let dilPhase = 0;
  let lastButtons = -1, lastWeapon = -1;
  const lastDelta = { x: 0, y: 0, z: 0 };
  const qCorr = new Uint16Array(10), qStarved = new Uint16Array(10);
  let qSec = 0, qSecAt = 0, lastStarvedCounter = -1;

  // connection
  let ws = null;
  let wantConnected = false;
  let reconnectTimer = null, pingTimer = null, watchdog = null;
  let pingCount = 0, lastMsgAt = 0;
  const snap = createSnapshot();

  // per-tick side effects (reused object, valid until the next tick() call)
  const fx = {
    seq: 0, alive: false, fired: false, weapon: 0, gun: 0, shotCount: 0,
    shots: Array.from({ length: 8 }, () => ({ from: [0, 0, 0], to: [0, 0, 0], kind: SHOT.MISS, normal: [0, 1, 0], hasNormal: false, victim: 0 })),
    jumped: false, landed: false, landSpeed: 0, slideStart: false, slideBoost: false, reloadStart: false, switched: false,
    empty: false, groundMove: 0,
  };
  const dir = [0, 0, 0];
  const nrm = [0, 0, 0];

  // ------------------------------------------------------------------ connection
  function connect(name, room, joinOpts) {
    if (name !== undefined) st.name = String(name);
    if (room !== undefined) st.room = room ? String(room) : '';
    if (joinOpts !== undefined) st.bots = joinOpts && Number.isFinite(joinOpts.bots) ? joinOpts.bots : undefined;
    if (joinOpts && typeof joinOpts.playerCode === 'string') st.playerCode = joinOpts.playerCode;
    wantConnected = true;
    st.reconnectAttempt = 0;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    if (!ws) open();
  }

  function setStatus(s, extra) {
    st.status = s;
    emit('status', s, extra);
  }

  function open() {
    if (!st.url) throw new Error('createNet: no url');
    let sock;
    try {
      sock = makeSocket(st.url);
    } catch (e) {
      st.lastError = String(e && e.message || e);
      scheduleReconnect();
      return;
    }
    ws = sock;
    sock.binaryType = 'arraybuffer';
    setStatus('connecting');
    sock.onopen = () => {
      if (ws !== sock) return;
      setStatus('joining');
      lastMsgAt = now();
      sendText(encodeJoin(st.name, st.room || undefined, st.bots, st.loadout.pendingCode, st.playerCode || undefined));
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      lastMsgAt = now();
      onMessage(ev.data);
    };
    sock.onerror = () => { /* a close event follows */ };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      const wasConnected = st.connected;
      teardown();
      emit('close', { code: ev && ev.code, reason: ev && ev.reason, wasConnected, willRetry: wantConnected });
      if (wantConnected) scheduleReconnect(); else setStatus('closed');
    };
  }

  function teardown() {
    st.connected = false;
    clearInterval(pingTimer); pingTimer = null;
    clearInterval(watchdog); watchdog = null;
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    const attempt = st.reconnectAttempt++;
    const delay = Math.min(10000, 750 * Math.pow(2, attempt)) * (0.85 + 0.3 * Math.random());
    st.reconnectAt = now() + delay;
    setStatus('reconnecting', { inMs: delay, attempt: attempt + 1 });
    reconnectTimer = setTimeout(() => { reconnectTimer = null; if (wantConnected && !ws) open(); }, delay);
  }

  /** Skip the remaining backoff wait (e.g. the user clicked "retry"). */
  function retryNow() {
    if (!wantConnected || ws) return;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    open();
  }

  function close() {
    wantConnected = false;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    teardown();
    const sock = ws;
    ws = null;
    if (sock) {
      try { sock.close(1000, 'bye'); } catch { /* already closed */ }
    }
    setStatus('closed');
  }

  function isOpen() { return ws !== null && ws.readyState === 1; }

  function sendText(str) {
    if (!isOpen()) return;
    stats.bytesUp += str.length;
    ws.send(str);
  }

  // ------------------------------------------------------------------ loadout
  /**
   * Choose the loadout for your NEXT life (any form weapons.sanitizeLoadout accepts). Returns
   * the sanitised code. Sent now when connected, otherwise with the next join.
   */
  function setLoadout(lo) {
    const code = encodeLoadout(sanitizeLoadout(lo));
    const L = st.loadout;
    L.pendingCode = code;
    L.pending = decodeLoadout(code);
    if (st.connected && isOpen()) sendText(encodeSetLoadout(code));
    emit('loadout', L);
    return code;
  }

  function setActiveLoadout(code) {
    const L = st.loadout;
    L.activeCode = sanitizeLoadoutCode(code);
    L.active = decodeLoadout(L.activeCode);
    kit = getKit(L.activeCode);
  }

  function sendPing() {
    if (!isOpen() || !st.connected) return;
    pingCount++;
    sendText(encodePing(now(), st.rtt));
  }

  // ------------------------------------------------------------------ messages
  function onMessage(data) {
    if (typeof data === 'string') {
      stats.bytesDown += data.length;
      const m = decodeText(data, 1 << 20);
      if (m) onText(m);
      return;
    }
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      stats.bytesDown += data.byteLength;
      const u8 = data instanceof ArrayBuffer ? new Uint8Array(data, 0, Math.min(1, data.byteLength)) : data;
      if (u8.length && u8[0] === MSG.VOICE) { onVoiceFrame(data); return; }
      onSnapshot(data);
    }
  }

  function resetGame() {
    st.roster.clear();
    remotes.clear(); remoteList.length = 0;
    for (const e of ring) { e.seq = -1; e.valid = false; }
    sendList.length = 0;
    nextSeq = 1;
    st.lastSeq = 0; st.ackSeq = -1; st.lastSnapTick = -1;
    st.alive = false; st.health = 0;
    teleportPending = true;
    err.x = err.y = err.z = 0;
    pingN = 0; pingHead = 0; havePong = false; haveClock = false;
    arrMaxCur = arrMaxPrev = arrBucketAt = -1e12; haveArr = false;
    lateHead = 0; lateN = 0; lateCount = 0; delayTarget = delayTicks = INTERP_TICKS; jitterTicks = 0; rclk = NaN;
    dilPhase = 0; st.timeScale = 1; lastButtons = -1; lastWeapon = -1;
    qCorr.fill(0); qStarved.fill(0); lastStarvedCounter = -1;
  }

  const teamOf = (t) => (t === 'a' || t === 'b' ? t : '');

  function rosterEntry(p) {
    return { id: p.id | 0, name: String(p.name || ''), bot: !!p.bot, kills: p.kills | 0, deaths: p.deaths | 0, ping: p.ping | 0,
      lo: Number.isInteger(p.lo) ? sanitizeLoadoutCode(p.lo) : DEFAULT_LOADOUT_CODE, team: teamOf(p.team), obj: p.obj | 0,
      mic: p.mic === true, deaf: p.deaf === true, relay: p.relay === true };
  }

  function applyRows(rows) {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      const e = st.roster.get(r.id);
      if (!e) continue;
      e.kills = r.kills | 0; e.deaths = r.deaths | 0; e.ping = r.ping | 0;
      if (r.team !== undefined) e.team = teamOf(r.team);
      if (r.obj !== undefined) e.obj = r.obj | 0;
    }
  }

  // ------------------------------------------------------------------ match / lobby / map (v4)
  /** Switch the prediction world to map `id` (force: emit 'map' even if unchanged). */
  function selectMap(id, force) {
    if (typeof id !== 'string' || !id) { if (force && curMap) emit('map', { mapId: curMap.id, map: curMap, world }); return; }
    const m = getMap(id);
    if (m.id !== id) return;                       // unknown to this client: keep the current world
    const changed = !curMap || curMap.id !== id;
    if (changed) {
      curMap = m;
      world = worldForMap(m);
      // whatever we predicted belongs to the old map
      for (const e of ring) e.valid = false;
      teleportPending = true;
    }
    const M = st.match;
    M.mapId = m.id; M.mapName = m.name; M.map = m;
    st.mapName = m.name;
    if (changed || force) emit('map', { mapId: m.id, map: m, world });
  }

  function refreshLobby() {
    const M = st.match;
    for (const e of M.lobby) {
      e.host = M.private && e.id === M.hostId;
      const r = st.roster.get(e.id);
      if (r) { e.team = r.team; e.name = r.name; }
    }
    M.isHost = M.private && M.hostId === st.id && st.id !== 0;
    const me = st.roster.get(st.id);
    if (me) M.myTeam = me.team;
  }

  function applyMatch(m, silent) {
    const M = st.match, prev = M.phase;
    if (typeof m.phase === 'string') M.phase = m.phase;
    if (m.config && typeof m.config === 'object') M.config = sanitizeMatchConfig(m.config, M.config, { allowAi: st.memory.enabled });
    M.mode = M.config.mode; M.modeInfo = MODES[M.mode]; M.teams = isTeamMode(M.mode);
    M.scoreLimit = M.config.scoreLimit; M.timeLimitS = M.config.timeLimitS;
    M.private = !!m.private;
    M.hostId = m.hostId | 0;
    M.startTick = +m.startTick || 0; M.endsTick = +m.endsTick || 0;
    if (m.scores) { M.scores.a = m.scores.a | 0; M.scores.b = m.scores.b | 0; }
    if (M.phase === 'results') { if (m.result) M.result = m.result; } else M.result = null;
    if (M.phase !== 'playing') { M.flags = null; M.hardpoint = null; st.alive = false; st.protected = false; st.carrier = false; }
    selectMap(m.mapId, false);
    st.round.phase = M.phase === 'playing' ? 'playing' : 'intermission';
    st.round.endsTick = M.endsTick;
    refreshLobby();
    if (silent) return;
    if (prev !== M.phase) emit('phase', M.phase, prev);
    emit('match', M);
  }

  function applyLobby(l, silent) {
    const M = st.match;
    if (Number.isFinite(l.hostId)) M.hostId = l.hostId | 0;
    M.lobby = [];
    for (const p of Array.isArray(l.players) ? l.players : []) {
      const team = teamOf(p.team);
      const r = st.roster.get(p.id);
      if (r) r.team = team;
      M.lobby.push({ id: p.id | 0, name: String(p.name || ''), team, bot: !!p.bot, host: false });
    }
    refreshLobby();
    if (!silent) emit('lobby', M.lobby);
  }

  function makeFlag() {
    const f = { state: 'home', carrier: 0, pos: [0, 0, 0], returnTick: 0 };
    Object.defineProperty(f, 'returnInS', { enumerable: true, get() { return f.state === 'dropped' && f.returnTick > 0 ? Math.max(0, (f.returnTick - serverTick()) / TICK_RATE) : 0; } });
    return f;
  }

  function applyObj(o, silent) {
    const M = st.match;
    if (!o) { M.flags = null; M.hardpoint = null; if (!silent) emit('objective', M); return; }
    if (o.scores) { M.scores.a = o.scores.a | 0; M.scores.b = o.scores.b | 0; }
    if (o.flags && o.flags.a && o.flags.b) {
      if (!M.flags) M.flags = { a: makeFlag(), b: makeFlag() };
      for (const t of ['a', 'b']) {
        const s = o.flags[t], f = M.flags[t];
        f.state = s.state === 'carried' || s.state === 'dropped' ? s.state : 'home';
        f.carrier = s.carrier | 0;
        if (Array.isArray(s.pos)) { f.pos[0] = +s.pos[0] || 0; f.pos[1] = +s.pos[1] || 0; f.pos[2] = +s.pos[2] || 0; }
        f.returnTick = +s.returnTick || 0;
      }
    } else M.flags = null;
    if (o.hp) {
      let h = M.hardpoint;
      if (!h) {
        h = M.hardpoint = { index: 0, name: '', min: [0, 0, 0], max: [0, 0, 0], owner: '', rotateTick: 0, next: 0, count: { a: 0, b: 0 } };
        Object.defineProperty(h, 'rotateInS', { enumerable: true, get() { return h.rotateTick > 0 ? Math.max(0, (h.rotateTick - serverTick()) / TICK_RATE) : 0; } });
      }
      h.index = o.hp.index | 0; h.name = String(o.hp.name || '');
      if (Array.isArray(o.hp.min)) h.min = o.hp.min.slice(0, 3);
      if (Array.isArray(o.hp.max)) h.max = o.hp.max.slice(0, 3);
      h.owner = o.hp.owner === 'a' || o.hp.owner === 'b' || o.hp.owner === 'contested' ? o.hp.owner : '';
      h.rotateTick = +o.hp.rotateTick || 0; h.next = o.hp.next | 0;
      if (o.hp.count) { h.count.a = o.hp.count.a | 0; h.count.b = o.hp.count.b | 0; }
    } else M.hardpoint = null;
    if (!silent) emit('objective', M);
  }

  /** Carried flags follow their carrier's rendered position (called per frame from sampleRemotes). */
  function updateCarriedFlags() {
    const F = st.match.flags;
    if (!F) return;
    for (const t of ['a', 'b']) {
      const f = F[t];
      if (f.state !== 'carried') continue;
      if (f.carrier === st.id) { f.pos[0] = pred.x; f.pos[1] = pred.y; f.pos[2] = pred.z; continue; }
      const r = remotes.get(f.carrier);
      if (r && r.count) { f.pos[0] = r.out.x; f.pos[1] = r.out.y; f.pos[2] = r.out.z; }
    }
  }

  // config edits are coalesced (sliders) and sent at most every CONFIG_GAP_MS
  const CONFIG_GAP_MS = 250;
  let cfgPending = null, cfgTimer = null, cfgSentAt = -1e9;
  function flushConfig() {
    cfgTimer = null;
    if (!cfgPending || !isOpen() || !st.connected) return;
    sendText(encodeMatchConfig(cfgPending));
    cfgPending = null;
    cfgSentAt = now();
  }
  /**
   * Host: change the match config (lobby only). Accepts a partial config; returns the full
   * sanitised config that will be requested (the server's 'match' reply is authoritative).
   */
  function setMatchConfig(partial) {
    const full = sanitizeMatchConfig(partial, { ...st.match.config, ...(cfgPending || {}) }, { allowAi: st.memory.enabled });
    cfgPending = full;
    const wait = CONFIG_GAP_MS - (now() - cfgSentAt);
    if (wait <= 0) flushConfig();
    else if (!cfgTimer) cfgTimer = setTimeout(flushConfig, wait);
    return full;
  }
  function startMatch() { if (cfgPending) flushConfig(); sendText(encodeStart()); }
  function switchTeam(team) { sendText(encodeTeam(team)); }
  function returnToLobby() { sendText(encodeReturnToLobby()); }
  // (v5) voice signaling
  function sendRtc(to, d) { if (st.connected) sendText(encodeRtc(to, d)); }
  function sendVoiceState(mic, deaf, relay) { if (st.connected) sendText(encodeVoiceState(mic, deaf, st.voice.relay ? relay : undefined)); }
  // voice relay
  const vframe = { from: 0, seq: 0, payload: null };
  function onVoiceFrame(data) {
    const f = decodeVoiceRelay(data, vframe);
    if (!f || !st.connected || !st.voice.relay || f.from === st.id) return;
    stats.voiceIn++;
    emit('voiceframe', f);
  }
  function sendVoiceFrame(targets, seq, payload) {
    if (!st.connected || !st.voice.relay || !isOpen()) return false;
    if ((ws.bufferedAmount || 0) > VOICE_MAX_BUFFERED) { stats.voiceSkipped++; return false; }
    const pkt = encodeVoiceFrame(targets, seq, payload);
    if (!pkt) return false;
    ws.send(pkt);
    stats.voiceOut++; stats.bytesUp += pkt.byteLength;
    return true;
  }
  function sendVoiceStat(s) { if (st.connected && st.voice.relay) sendText(encodeVoiceStat(s)); }

  function onText(m) {
    switch (m.t) {
      case 'welcome': {
        resetGame();
        st.connected = true;
        st.id = m.id | 0;
        st.roomName = String(m.room || '');
        st.mapName = String(m.map || '');
        st.voice = { enabled: m.voice === true, ice: m.voice === true && Array.isArray(m.ice) ? m.ice : [],
          relay: m.voice === true && m.voiceRelay === VOICE_RELAY_VERSION };
        st.memory = { enabled: m.memory === true, host: null, lobby: '', loadout: '' };
        for (const p of m.players || []) st.roster.set(p.id, rosterEntry(p));
        if (m.round) { st.round.phase = m.round.phase; st.round.endsTick = m.round.endsTick; st.round.winner = 0; }
        // (v4) match / lobby / objective state and the map to predict on
        st.match = createMatchState();
        if (m.match) applyMatch(m.match, true);
        if (m.lobby) applyLobby(m.lobby, true);
        applyObj(m.obj || null, true);
        if (!m.match) selectMap(m.mapId, false);
        refreshLobby();
        // the server's copy of our pending loadout; re-send ours if it changed while joining
        st.loadout.serverPendingCode = Number.isInteger(m.lo) ? m.lo : -1;
        if (st.loadout.serverPendingCode !== st.loadout.pendingCode) sendText(encodeSetLoadout(st.loadout.pendingCode));
        // rough clock until the first pong arrives
        const t = now();
        clockTarget = clockOffset = (+m.tick || 0) - t / TICK_MS;
        clockLast = t; haveClock = true;
        st.reconnectAttempt = 0;
        stats.connects++;
        setStatus('connected');
        // clock sync: a few quick pings, then ~1/s
        pingCount = 0;
        clearInterval(pingTimer);
        sendPing();
        let quick = 0;
        pingTimer = setInterval(() => {
          quick++;
          if (quick <= 4 || quick % 5 === 0) sendPing();
        }, 200);
        clearInterval(watchdog);
        watchdog = setInterval(() => {
          if (ws && now() - lastMsgAt > SILENCE_MS) {
            try { ws.close(4000, 'silent'); } catch { /* ignore */ }
            const sock = ws; ws = null; teardown();
            if (sock) { sock.onclose = null; sock.onmessage = null; }
            emit('close', { code: 4000, reason: 'timeout', wasConnected: true, willRetry: wantConnected });
            if (wantConnected) scheduleReconnect();
          }
        }, 1000);
        emit('welcome', m);
        emit('memory', st.memory);
        selectMap(st.match.mapId, true);   // always tell the UI which map to build
        emit('match', st.match);
        emit('lobby', st.match.lobby);
        emit('objective', st.match);
        return;
      }
      case 'match': applyMatch(m, false); return;
      case 'lobby': applyLobby(m, false); return;
      case 'obj': if (st.match.phase === 'playing') applyObj(m, false); return;
      case 'team': {
        const team = teamOf(m.team);
        const r = st.roster.get(m.id);
        if (r) r.team = team;
        const l = st.match.lobby.find((e) => e.id === m.id);
        if (l) l.team = team;
        refreshLobby();
        emit('team', { id: m.id | 0, team });
        return;
      }
      case 'result': st.match.result = m; emit('result', m); return;
      case 'memory': {
        // (v6) suggestions; only a server with memory on sends these
        if (!st.memory.enabled) return;
        const txt = (v) => (typeof v === 'string' ? v.slice(0, 300) : '');
        const h = m.host;
        st.memory.host = h && typeof h === 'object' && typeof h.mode === 'string' && typeof h.mapId === 'string' && typeof h.text === 'string'
          ? { mode: h.mode, mapId: h.mapId, text: txt(h.text) } : null;
        st.memory.lobby = txt(m.lobby);
        st.memory.loadout = txt(m.loadout);
        emit('memory', st.memory);
        return;
      }
      case 'ev': emit('ev', m); return;
      case 'pong': onPong(m); return;
      case 'loadout': {
        if (Number.isInteger(m.lo)) st.loadout.serverPendingCode = sanitizeLoadoutCode(m.lo);
        emit('loadout', st.loadout);
        return;
      }
      case 'join': {
        if (m.player) st.roster.set(m.player.id, rosterEntry(m.player));
        emit('join', m);
        return;
      }
      case 'leave': {
        st.roster.delete(m.id);
        removeRemote(m.id);
        const i = st.match.lobby.findIndex((e) => e.id === m.id);
        if (i >= 0) st.match.lobby.splice(i, 1);
        emit('leave', m);
        return;
      }
      case 'kill': {
        const k = st.roster.get(m.killer), v = st.roster.get(m.victim);
        const playing = st.match.phase === 'playing';
        if (v && playing) v.deaths++;
        if (k && m.killer !== m.victim && playing && (!k.team || !v || k.team !== v.team)) k.kills++;
        if (m.victim === st.id) st.alive = false;
        emit('kill', m);
        return;
      }
      case 'spawn': {
        const re = st.roster.get(m.id);
        if (re && Number.isInteger(m.lo)) re.lo = sanitizeLoadoutCode(m.lo);
        if (re && m.team !== undefined) re.team = teamOf(m.team);
        if (m.id === st.id) {
          if (m.team !== undefined) { st.team = teamOf(m.team); st.match.myTeam = st.team; }
          st.protected = (m.prot | 0) > 0;
          // a new life: the loadout the server activated for it (our pending one, sanitised)
          setActiveLoadout(Number.isInteger(m.lo) ? m.lo : st.loadout.pendingCode);
          spawnState(pred, +m.x || 0, +m.y || 0, +m.z || 0);
          resetWeaponState(predW, kit);
          for (const e of ring) e.valid = false;
          st.alive = true;
          st.health = 100;
          teleportPending = true;
          snapView();
          emit('loadout', st.loadout);
        } else {
          const r = remotes.get(m.id);
          if (r) r.pendingTeleport = true;
        }
        emit('spawn', m);
        return;
      }
      case 'round': {
        st.round.phase = m.phase; st.round.endsTick = m.endsTick; st.round.winner = m.winner | 0;
        if (m.rows) applyRows(m.rows);
        if (m.phase === 'playing') for (const e of st.roster.values()) { e.kills = 0; e.deaths = 0; e.obj = 0; }
        emit('round', m);
        return;
      }
      case 'scores': applyRows(m.rows); emit('scores', m); return;
      case 'hit': emit('hit', m); return;
      case 'damage': {
        if (Number.isFinite(m.health)) st.health = m.health;
        emit('damage', m);
        return;
      }
      case 'rtc': {
        const d = sanitizeSignal(m.d);
        if (d && Number.isInteger(m.from) && m.from !== st.id) emit('rtc', { from: m.from, d });
        return;
      }
      case 'voice': {
        const e = st.roster.get(m.id);
        if (e) { e.mic = m.mic === true; e.deaf = m.deaf === true; e.relay = m.relay === true; }
        emit('voice', { id: m.id | 0, mic: m.mic === true, deaf: m.deaf === true, relay: m.relay === true });
        return;
      }
      case 'error': st.lastError = m.message || m.code; emit('error', m);
        if (m.code === 'bad_version') wantConnected = false;
        return;
      default: emit(m.t, m);
    }
  }

  // ------------------------------------------------------------------ clock
  function onPong(m) {
    const t = now();
    const rtt = t - m.c;
    if (!(rtt >= 0 && rtt < 10000) || !Number.isFinite(m.tick)) return;
    st.rtt = rtt;
    st.ping = Number.isFinite(st.ping) ? st.ping * 0.7 + rtt * 0.3 : rtt;
    pingRtt[pingHead] = rtt;
    pingOff[pingHead] = m.tick + (rtt / 2) / TICK_MS - t / TICK_MS;
    pingHead = (pingHead + 1) % PING_SAMPLES;
    if (pingN < PING_SAMPLES) pingN++;
    let best = 0;
    for (let i = 1; i < pingN; i++) if (pingRtt[i] < pingRtt[best]) best = i;
    clockTarget = pingOff[best];
    if (!havePong) { clockOffset = clockTarget; havePong = true; }
    haveClock = true;
  }

  function updateClock(t) {
    const dtTicks = Math.max(0, (t - clockLast) / TICK_MS);
    clockLast = t;
    const d = clockTarget - clockOffset;
    if (Math.abs(d) > 4) clockOffset = clockTarget;           // way off: snap
    else {
      const maxStep = dtTicks * 0.05;                         // slew at most 5% of real time
      clockOffset += d > maxStep ? maxStep : d < -maxStep ? -maxStep : d;
    }
  }

  function serverTick(t = now()) {
    if (!haveClock) return st.lastSnapTick;
    if (t > clockLast) updateClock(t);
    return t / TICK_MS + clockOffset;
  }
  /**
   * Render tick for remote players: newest-snapshot clock (de-jittered from arrival times) minus
   * the adaptive interpolation delay. Slews smoothly (+-CLOCK_SLEW) and never runs backwards.
   */
  function renderTick(t = now()) {
    if (!haveArr) return serverTick(t) - INTERP_TICKS;
    const base = arrMaxCur > arrMaxPrev ? arrMaxCur : arrMaxPrev;
    const target = t / TICK_MS + base - delayTicks;
    if (rclk !== rclk) { rclk = target; rclkAt = t; return rclk; }
    if (t <= rclkAt) return rclk;
    const dt = (t - rclkAt) / TICK_MS;
    rclkAt = t;
    let next = rclk + dt;
    const e = target - next;
    if (e > 30 || e < -30) next = target;                       // way off (stall / resync): jump
    else { const m = dt * CLOCK_SLEW; next += e > m ? m : e < -m ? -m : e; }
    if (next > rclk) rclk = next;
    return rclk;
  }

  /** Snapshot arrival: update the arrival-offset window, lateness samples and the delay target. */
  function onArrival(tick, t) {
    const o = tick - t / TICK_MS;
    const tt = t / TICK_MS;
    if (tt - arrBucketAt >= ARR_BUCKET_TICKS) { arrMaxPrev = arrMaxCur; arrMaxCur = o; arrBucketAt = tt; }
    else if (o > arrMaxCur) arrMaxCur = o;
    haveArr = true;
    const base = arrMaxCur > arrMaxPrev ? arrMaxCur : arrMaxPrev;
    late[lateHead] = base - o;
    lateHead = (lateHead + 1) % LATE_N;
    if (lateN < LATE_N) lateN++;
    if ((++lateCount & 7) === 0 && lateN >= 8) {
      const a = lateSort.subarray(0, lateN);
      a.set(late.subarray(0, lateN));
      a.sort();
      const q = a[Math.min(lateN - 1, Math.floor(lateN * DELAY_QUANTILE))];
      jitterTicks = a[Math.min(lateN - 1, Math.floor(lateN * 0.9))];
      let d = SNAP_INTERVAL_TICKS + q + DELAY_MARGIN;
      delayTarget = d < INTERP_TICKS ? INTERP_TICKS : d > INTERP_MAX_TICKS ? INTERP_MAX_TICKS : d;
    }
    // smooth delay changes: grow quickly (0.25 tick per snapshot), shrink slowly
    const dd = delayTarget - delayTicks;
    delayTicks += dd > 0 ? Math.min(dd, 0.25) : Math.max(dd, -0.02);
  }

  function updateQuality(t, you) {
    if (t - qSecAt < 1000) return;
    qSecAt = t;
    const q = st.quality;
    let c = 0, sv = 0;
    for (let i = 0; i < 10; i++) { c += qCorr[i]; sv += qStarved[i]; }
    q.corrections10s = c; q.starved10s = sv;
    qSec = (qSec + 1) % 10; qCorr[qSec] = 0; qStarved[qSec] = 0;
    // displayed RTT: median of the recent pings (TCP stalls inflate single samples)
    if (pingN > 0) {
      const a = Array.from(pingRtt.subarray(0, pingN)).sort((x, y) => x - y);
      q.rttMs = Math.round(a[a.length >> 1]);
    }
    q.jitterMs = Math.round(jitterTicks * TICK_MS);
    q.interpDelayMs = Math.round(delayTicks * TICK_MS);
    q.timeScale = st.timeScale;
    q.inputBufferTicks = Math.round(you.inputBuffer * 10) / 10;
  }

  // ------------------------------------------------------------------ snapshots
  function onSnapshot(data) {
    const s = decodeSnapshot(data, snap);
    if (!s || !st.connected) return;
    if (s.tick <= st.lastSnapTick) return;
    st.lastSnapTick = s.tick;
    stats.snapshots++;
    const tArr = now();
    onArrival(s.tick, tArr);
    const you = s.you;
    // server-driven time dilation (bounded here too)
    const ts = you.timeScale > MAX_DILATION_PERMILLE ? MAX_DILATION_PERMILLE : you.timeScale < -MAX_DILATION_PERMILLE ? -MAX_DILATION_PERMILLE : you.timeScale;
    st.timeScale = 1 + ts / 1000;
    if (lastStarvedCounter >= 0) qStarved[qSec] += (you.starved - lastStarvedCounter) & 0xff;
    lastStarvedCounter = you.starved;
    updateQuality(tArr, you);
    if (!st.id) st.id = you.id;
    st.health = you.health;
    st.protected = you.protected; st.carrier = you.carrier;
    if (st.team !== you.team) {
      st.team = you.team; st.match.myTeam = you.team;
      const me = st.roster.get(st.id);
      if (me) me.team = you.team;
    }
    st.respawnAtTick = s.tick + you.respawnTicks;
    copyState(server, you.state);
    copyWeaponState(serverW, you.weapon);
    if (s.ackSeq >= 0) {
      if (s.ackSeq > st.ackSeq) {
        const e = ring[s.ackSeq & RING_MASK];
        if (e.seq === s.ackSeq && e.sentAt > 0) {
          const d = now() - e.sentAt;
          stats.ackDelays[stats.ackDelayN & 2047] = d;
          stats.ackDelaySum += d; stats.ackDelayN++;
        }
      }
      st.ackSeq = s.ackSeq;
    }

    if (!you.alive) {
      st.alive = false;
      copyState(pred, server);
      copyWeaponState(predW, serverW);
      snapView();
    } else {
      if (!st.alive) { st.alive = true; teleportPending = true; }
      reconcile(s.ackSeq);
    }

    // remote players
    for (let i = 0; i < s.players.length; i++) pushRemote(s.players[i], s.tick);
    for (let i = remoteList.length - 1; i >= 0; i--) {
      const r = remoteList[i];
      if (s.tick - r.lastSeenTick > STALE_REMOTE_TICKS) removeRemote(r.id);
    }

    if (s.shots.length) {
      for (let i = 0; i < s.shots.length; i++) if (s.shots[i].shooter !== st.id) stats.remoteShots++;
      emit('shots', s.shots, s.tick);
    }
    emit('snapshot', s);
  }

  function reconcile(ack) {
    const last = nextSeq - 1;
    const tele = teleportPending;
    teleportPending = false;
    const ox = pred.x, oy = pred.y, oz = pred.z;

    if (ack >= 0 && ack <= last) {
      const e = ring[ack & RING_MASK];
      if (e.seq === ack && e.valid && !tele) {
        const dx = e.state.x - server.x, dy = e.state.y - server.y, dz = e.state.z - server.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        stats.compared++;
        stats.lastError = d;
        stats.sumError += d;
        if (d > stats.maxError) stats.maxError = d;
        const posSame = sameState(e.state, server);
        if (posSame && sameWeapon(e.ws, serverW)) return;  // prediction was exact
        stats.corrections++;
        if (posSame) stats.corrWeapon++;
        stats.corrSum += d; if (d > 0.1) stats.corrBig++; if (d > stats.corrMax) stats.corrMax = d;
        if (d > 0) stats.corrPos++;
        qCorr[qSec]++;
      }
      // rewind to the authoritative state and replay everything the server has not seen yet
      copyState(pred, server);
      copyWeaponState(predW, serverW);
      if (e.seq === ack) { copyState(e.state, server); copyWeaponState(e.ws, serverW); e.valid = true; }
      let n = 0;
      for (let seq = ack + 1; seq <= last; seq++) {
        const r = ring[seq & RING_MASK];
        if (r.seq !== seq) break;
        stepPlayer(pred, r.cmd, world, moveSpeedMult(kit, predW));
        stepWeapon(predW, r.cmd, kit);
        copyState(r.state, pred); copyWeaponState(r.ws, predW); r.valid = true;
        n++;
      }
      stats.replays++; stats.replayedCmds += n;
      if (n > stats.maxReplay) stats.maxReplay = n;
    } else {
      copyState(pred, server);
      copyWeaponState(predW, serverW);
    }

    if (tele) { snapView(); return; }
    // visual smoothing: keep the rendered position continuous, decay the difference
    const dx = ox - pred.x, dy = oy - pred.y, dz = oz - pred.z;
    const ex = err.x + dx, ey = err.y + dy, ez = err.z + dz;
    const mag = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (mag > SNAP_ERROR) { stats.snaps++; snapView(); return; }
    if (mag > stats.maxVisualError) stats.maxVisualError = mag;
    err.x = ex; err.y = ey; err.z = ez;
    prevView.x -= dx; prevView.y -= dy; prevView.z -= dz;
  }

  function snapView() {
    err.x = err.y = err.z = 0;
    prevView.x = pred.x; prevView.y = pred.y; prevView.z = pred.z; prevView.eye = eyeHeight(pred);
  }

  // ------------------------------------------------------------------ remotes
  function pushRemote(p, tick) {
    let r = remotes.get(p.id);
    if (!r) { r = createRemote(p.id); remotes.set(p.id, r); remoteList.push(r); }
    r.lastSeenTick = tick;
    let tele = r.pendingTeleport || r.count === 0;
    if (!tele) {
      const prev = sampleAt(r, 0);
      if (p.alive && !prev.alive) tele = true;
      else {
        const dt = Math.max(1, tick - prev.tick) / 60;
        const dx = p.x - prev.x, dy = p.y - prev.y, dz = p.z - prev.z;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) > TELEPORT_SPEED * dt + 1.0) tele = true;
      }
    }
    if (tele) { r.life++; r.pendingTeleport = false; }
    const s = r.samples[r.head];
    r.head = (r.head + 1) % SAMPLES;
    if (r.count < SAMPLES) r.count++;
    s.tick = tick; s.life = r.life;
    s.x = p.x; s.y = p.y; s.z = p.z; s.yaw = p.yaw; s.pitch = p.pitch; s.alive = p.alive;
    s.crouching = p.crouching; s.sliding = p.sliding; s.onGround = p.onGround; s.ads = p.ads;
    s.reloading = p.reloading; s.weapon = p.weapon; s.gun = p.gun; s.health = p.health;
    s.team = p.team; s.protected = p.protected; s.carrier = p.carrier;
    const re = st.roster.get(p.id);
    s.lo = re ? re.lo : DEFAULT_LOADOUT_CODE;
  }

  function removeRemote(id) {
    const r = remotes.get(id);
    if (!r) return;
    remotes.delete(id);
    const i = remoteList.indexOf(r);
    if (i >= 0) remoteList.splice(i, 1);
  }

  /**
   * Fill `out` (array, reused) with interpolated remote players at render tick rt.
   * The objects are owned by net and reused every call.
   */
  function sampleRemotes(rt, out) {
    lastRenderTick = rt;
    if (out) out.length = 0;
    for (let i = 0; i < remoteList.length; i++) {
      const r = remoteList[i];
      if (r.count === 0) continue;
      const o = interpolate(r, rt);
      const nt = sampleAt(r, 0).tick;
      const ex = rt > nt, ho = rt > nt + EXTRAP_TICKS;
      stats.remoteSamples++;
      if (ex) stats.extrapSamples++;
      if (ho) stats.holdSamples++;
      if (ex && !r.wasExtrap) stats.extrapEvents++;
      if (ho && !r.wasHold) stats.holdEvents++;
      smoothRemote(r, o, rt, ex);
      r.wasExtrap = ex; r.wasHold = ho;
      const e = st.roster.get(r.id);
      o.name = e ? e.name : '';
      o.bot = e ? e.bot : false;
      if (out) out.push(o);
    }
    updateCarriedFlags();
    return out;
  }

  /**
   * After an extrapolation / hold ends (late snapshots arrived, e.g. a TCP burst) the
   * interpolated position jumps to where the player really was. Blend that jump out instead
   * of snapping: continue from the rendered position + motion and decay the offset.
   */
  function smoothRemote(r, o, rt, extrapolating) {
    const drt = rt - r.lastRt;
    if (drt <= 0 && drt > -1 && r.lastLife === o.life) { o.x += r.ex; o.y += r.ey; o.z += r.ez; return; }  // same frame again
    const same = r.lastLife === o.life && o.alive && r.lastAlive && drt > 0 && drt < 30;
    const x = o.x, y = o.y, z = o.z;    // raw (interpolated / extrapolated) position
    if (!same) { r.ex = r.ey = r.ez = 0; r.vx = r.vy = r.vz = 0; r.fresh = true; }
    else {
      const k = Math.exp(-(drt * TICK_MS / 1000) / REMOTE_SMOOTH_TAU);
      r.ex *= k; r.ey *= k; r.ez *= k;
      if (Math.abs(r.ex) + Math.abs(r.ey) + Math.abs(r.ez) < 1e-4) r.ex = r.ey = r.ez = 0;
      // departure of the RAW position from its own recent motion: a big one is a network
      // artefact (end of an extrapolation/hold, or the server correcting a stalled player's
      // guessed path), not movement. Absorb it into the offset and blend it out.
      const jx = r.lx + r.vx * drt - x, jy = r.ly + r.vy * drt - y, jz = r.lz + r.vz * drt - z;
      const j2 = jx * jx + jy * jy + jz * jz;
      const lim = REMOTE_JUMP * drt;
      const fl = REMOTE_FRESH_JUMP * drt;   // no motion reference yet: only an implausible step
      const jump = r.fresh ? j2 > fl * fl : (j2 > lim * lim || (r.wasExtrap && !extrapolating));
      if (jump && j2 < REMOTE_SNAP * REMOTE_SNAP) {
        r.ex += jx; r.ey += jy; r.ez += jz; stats.remoteBlends++;
        r.fresh = true;                      // re-measure the motion before testing again
      } else { r.vx = (x - r.lx) / drt; r.vy = (y - r.ly) / drt; r.vz = (z - r.lz) / drt; r.fresh = false; }
      const e2 = r.ex * r.ex + r.ey * r.ey + r.ez * r.ez;
      if (e2 > REMOTE_SNAP * REMOTE_SNAP) r.ex = r.ey = r.ez = 0;
      o.x += r.ex; o.y += r.ey; o.z += r.ez;
    }
    r.lx = x; r.ly = y; r.lz = z; r.lastRt = rt; r.lastLife = o.life; r.lastAlive = o.alive;
  }

  /** Interpolated eye position of a remote at the last sampled render tick -> out [x,y,z]. */
  function remoteEye(id, out) {
    const r = remotes.get(id);
    if (!r || r.count === 0) return null;
    const o = r.out;
    out[0] = o.x; out[1] = o.y + (o.crouching ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight); out[2] = o.z;
    return out;
  }

  // ------------------------------------------------------------------ prediction tick
  /**
   * Advance one fixed tick: build + sanitise the cmd, predict it (first and only "live"
   * prediction: side effects are reported in the returned fx object), store it in the ring and
   * send an input packet with redundancy. Returns fx (reused), or null when not in game.
   */
  function tick(input, rt) {
    if (!st.connected || !isOpen()) return null;
    // (v4) nothing is simulated in the lobby: send no input there (the server sleeps)
    if (st.match.phase === 'lobby') return null;
    if (!Number.isFinite(rt)) rt = renderTick();

    fx.alive = st.alive; fx.fired = false; fx.shotCount = 0; fx.jumped = false; fx.landed = false;
    fx.landSpeed = 0; fx.slideStart = false; fx.slideBoost = false; fx.reloadStart = false; fx.switched = false; fx.empty = false; fx.groundMove = 0;

    // Time dilation, applied in whole ticks: phase accumulates (timeScale - 1) per call.
    dilPhase += st.timeScale - 1;
    if (dilPhase > 2) dilPhase = 2; else if (dilPhase < -2) dilPhase = -2;
    if (dilPhase <= -1 && canSkip(input)) {
      // slow down: predict nothing this call. Keep the rendered view moving (decaying offset).
      dilPhase += 1;
      stats.dilationSkip++;
      prevView.x = pred.x - lastDelta.x; prevView.y = pred.y - lastDelta.y; prevView.z = pred.z - lastDelta.z;
      prevView.eye = eyeHeight(pred);
      err.x += lastDelta.x; err.y += lastDelta.y; err.z += lastDelta.z;
      fx.seq = nextSeq - 1;
      return fx;
    }

    // render interpolation base
    prevView.x = pred.x; prevView.y = pred.y; prevView.z = pred.z; prevView.eye = eyeHeight(pred);
    const c = stepOnce(input);
    if (dilPhase >= 1) {
      // speed up: a second tick with the same input; the extra displacement is smoothed out
      dilPhase -= 1;
      stats.dilationExtra++;
      const mx = pred.x, my = pred.y, mz = pred.z;
      stepOnce(input);
      const dx = mx - pred.x, dy = my - pred.y, dz = mz - pred.z;
      if (st.alive) { err.x += dx; err.y += dy; err.z += dz; prevView.x -= dx; prevView.y -= dy; prevView.z -= dz; }
    } else {
      lastDelta.x = pred.x - prevView.x; lastDelta.y = pred.y - prevView.y; lastDelta.z = pred.z - prevView.z;
    }
    lastButtons = c.buttons; lastWeapon = c.weapon;

    // send newest cmds (redundancy covers packet loss)
    const pkt = encodeInput(sendList, rt);
    if (pkt) {
      ws.send(pkt);
      stats.packetsSent++; stats.bytesUp += pkt.byteLength;
    }
    return fx;
  }

  /** Skipping a tick is only allowed when it cannot lose a press/release or a weapon switch. */
  function canSkip(input) {
    if (!st.alive) return true;
    return ((input.buttons | 0) & BTN_MASK_NET) === lastButtons && (input.weapon | 0) === lastWeapon;
  }

  /** Allocate the next cmd from input, predict it (live: side effects into fx), queue it to send. */
  function stepOnce(input) {
    const seq = nextSeq++;
    st.lastSeq = seq;
    const e = ring[seq & RING_MASK];
    e.seq = seq;
    e.sentAt = now();
    const c = e.cmd;
    c.seq = seq; c.buttons = input.buttons | 0; c.yaw = +input.yaw || 0; c.pitch = +input.pitch || 0; c.weapon = input.weapon | 0;
    if (sanitizeCmd(c) === null) { c.yaw = 0; c.pitch = 0; sanitizeCmd(c); }
    fx.seq = seq;
    if (st.alive) {
      copyState(before, pred);
      copyWeaponState(beforeW, predW);
      stepPlayer(pred, c, world, moveSpeedMult(kit, predW));
      const fired = stepWeapon(predW, c, kit);
      copyState(e.state, pred); copyWeaponState(e.ws, predW); e.valid = true;
      collectFx(c, fired);
    } else {
      e.valid = false;
    }
    if (sendList.length >= INPUT_REDUNDANCY) sendList.shift();
    sendList.push(c);
    stats.cmdsSent++;
    return c;
  }

  function collectFx(c, fired) {
    const b = before, a = pred;
    if (a.jumpedAir && (!b.jumpedAir || b.onGround) && a.vy > 0) fx.jumped = true;
    if (!b.onGround && a.onGround) { fx.landed = true; fx.landSpeed = -b.vy; }
    // a slide-hop starts and ends its slide inside one step (slide boost, then the held jump),
    // so detect the boost by the slide timer restarting, not only by the sliding flag
    if (a.slideTicks < b.slideTicks) { fx.slideStart = true; fx.slideBoost = true; }
    else if (!b.sliding && a.sliding) fx.slideStart = true;
    if (a.onGround && b.onGround && !a.sliding) fx.groundMove = Math.hypot(a.x - b.x, a.z - b.z);
    if (beforeW.weapon !== predW.weapon) fx.switched = true;
    if (beforeW.reload === 0 && predW.reload > 0 && !fx.switched) fx.reloadStart = true;
    const firePressed = (c.buttons & BTN.FIRE) !== 0 && !beforeW.fireHeld;
    if (firePressed && !fired && beforeW.ammo[beforeW.weapon] === 0) fx.empty = true;
    if (!fired) return;

    // predicted shot: same origin / directions / world ray as the server
    const w = predW.weapon;
    const def = kit.slots[w];
    fx.fired = true; fx.weapon = w; fx.gun = kit.guns[w];
    stats.predictedShots++;
    const ox = a.x, oy = a.y + eyeHeight(a), oz = a.z;
    const spread = predW.spread;   // this shot's cone (aim + bloom), set by stepWeapon
    const n = Math.min(def.pellets, fx.shots.length);
    for (let k = 0; k < n; k++) {
      shotDir(dir, c.yaw, c.pitch, spread, c.seq, k);
      const dx = dir[0], dy = dir[1], dz = dir[2];
      nrm[0] = 0; nrm[1] = 0; nrm[2] = 0;
      const wd = raycastWorld(world, ox, oy, oz, dx, dy, dz, def.range, nrm);
      let best = wd < def.range ? wd : def.range;
      let kind = wd < def.range ? SHOT.WORLD : SHOT.MISS;
      let victim = 0;
      for (let i = 0; i < remoteList.length; i++) {
        const o = remoteList[i].out;
        if (!o.alive || remoteList[i].count === 0) continue;
        if (st.team && o.team === st.team) continue;        // friendly fire off: shots pass through
        const h = raycastPlayer(ox, oy, oz, dx, dy, dz, o.x, o.y, o.z, o.crouching ? PLAYER.crouchHeight : PLAYER.height, best);
        if (h && h.t < best) { best = h.t; kind = h.head ? SHOT.HEAD : SHOT.BODY; victim = o.id; }
      }
      const s = fx.shots[k];
      s.from[0] = ox; s.from[1] = oy; s.from[2] = oz;
      s.to[0] = ox + dx * best; s.to[1] = oy + dy * best; s.to[2] = oz + dz * best;
      s.kind = kind; s.victim = victim;
      if (kind === SHOT.WORLD) { s.normal[0] = nrm[0]; s.normal[1] = nrm[1]; s.normal[2] = nrm[2]; s.hasNormal = true; }
      else { s.normal[0] = -dx; s.normal[1] = -dy; s.normal[2] = -dz; s.hasNormal = kind !== SHOT.MISS; }
    }
    fx.shotCount = n;
  }

  // ------------------------------------------------------------------ view
  function decayError(dt) {
    const k = Math.exp(-Math.max(0, dt) / SMOOTH_TAU);
    err.x *= k; err.y *= k; err.z *= k;
    if (Math.abs(err.x) + Math.abs(err.y) + Math.abs(err.z) < 1e-4) err.x = err.y = err.z = 0;
  }

  /**
   * Local player view for rendering: position interpolated between the previous and current
   * predicted tick (alpha 0..1) plus the decaying reconciliation offset. Writes into out.
   */
  function localView(alpha, out) {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    out.alive = st.alive;
    out.x = prevView.x + (pred.x - prevView.x) * a + err.x;
    out.y = prevView.y + (pred.y - prevView.y) * a + err.y;
    out.z = prevView.z + (pred.z - prevView.z) * a + err.z;
    const eye = eyeHeight(pred);
    out.eyeHeight = prevView.eye + (eye - prevView.eye) * a;
    out.vx = pred.vx; out.vy = pred.vy; out.vz = pred.vz;
    out.onGround = pred.onGround; out.crouching = pred.crouching; out.sliding = pred.sliding;
    out.weapon = predW.weapon;
    out.gun = kit.guns[predW.weapon];
    out.aim = aimFraction(kit, predW);
    out.reloading = predW.reload > 0;
    out.team = st.team; out.protected = st.protected && st.alive; out.carrier = st.carrier && st.alive;
    return out;
  }

  const api = {
    on, off, connect, close, retryNow, setLoadout,
    setMatchConfig, startMatch, switchTeam, returnToLobby, sendRtc, sendVoiceState, sendVoiceFrame, sendVoiceStat,
    tick, sampleRemotes, remoteEye, decayError, localView,
    serverTick, renderTick,
    get state() { return st; },
    get match() { return st.match; },
    get world() { return world; },
    get map() { return curMap; },
    get stats() { return stats; },
    get pred() { return pred; },
    get predWeapon() { return predW; },
    get kit() { return kit; },
    get loadout() { return st.loadout; },
    get serverState() { return server; },
    get timeScale() { return st.timeScale; },
    get interpDelayMs() { return delayTicks * TICK_MS; },
    get errorOffset() { return err; },
    get remoteCount() { return remoteList.length; },
    get remotes() { return remoteList; },
    get lastRenderTick() { return lastRenderTick; },
    get open() { return isOpen(); },
    get seq() { return nextSeq - 1; },
    get pings() { return pingCount; },
    hitboxHeight,
    MOVE,
  };
  return api;
}
