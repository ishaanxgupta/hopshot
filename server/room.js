// One game room: 60 Hz authoritative simulation, cmd jitter buffers, lag-compensated hitscan,
// FFA rules, rounds, 30 Hz per-client snapshots and JSON events.
//
// Input path (netcode, protocol v2):
//   - Per-player adaptive jitter buffer. Arrival lateness of every input packet is measured
//     (against the least-delayed arrival of the last ~1 s; packets released in a TCP burst are
//     excluded) and the buffer target is ~p90 lateness + 1 tick. The server never stalls or
//     speeds up the queue itself: it tells the client (snapshot timeScale, +-3%) to run its
//     fixed-step clock slightly faster/slower so the smoothed depth settles on the target.
//   - Starvation (e.g. a TCP retransmission stall) is SPECULATIVE: the player keeps moving
//     on a guess (last movement buttons), and when the real cmds arrive the server rewinds
//     that player to the last real state and replays the real cmds for the guessed ticks.
//     The authoritative timeline is therefore exactly "one real cmd per tick", the client's
//     prediction stays bit-exact, and the self state in snapshots is always the state right
//     after ackSeq. Only very long stalls (> MAX_SPEC ticks) commit the guess.
//   - No hard drops in normal operation; a large sustained surplus is trimmed (latency cap)
//     and nobody can speed-hack: at most one cmd per tick on average is ever simulated.
//
// Loadouts (protocol v3): each player has a PENDING loadout code (from join / 'loadout'
// messages, sanitised) and an ACTIVE kit (weapons.getKit) that only changes in respawn(). Every
// simulated cmd - live, replayed after a stall, or guessed - uses p.kit, and a respawn clears
// any speculation (specN = 0), so a replay can never mix two lives' loadouts. The client gets
// the active code in its own 'spawn' event and predicts with exactly the same kit.
//
// Matches (protocol v4, rules in shared/modes.js):
//   phase 'lobby'     private rooms only. Nobody is alive, no bots, no snapshots, and the loop
//                     wakes only every LOBBY_WAKE_MS (cheap). The host (first human; the
//                     longest-present human after the host leaves) edits the config and starts.
//   phase 'countdown' everyone dead; teams balanced, bots added; play starts at endsTick.
//   phase 'playing'   the mode runs (scores, flags, zone); spawn protection; respawns.
//   phase 'results'   everyone dead; result shown until endsTick, then private -> lobby (same
//                     config), public -> the next map/mode of the rotation -> countdown.
//   Public rooms never use the lobby. Score changes that end a match are applied at the end of
//   the tick (pendingEnd), so nothing is despawned while the tick is still iterating players.
//
// Memory (protocol v6, optional; server/memory): opts.memory = the MemoryService (null = off, the
// default). When on, this.mem (a MemoryRoom) gets O(1) hooks from addHuman / removePlayer / fire /
// damage / kill / match start + end and a 1 Hz tick while playing; it never blocks the loop (all
// I/O is async, after the match). 'ai' bots exist only then (sanitizeMatchConfig allowAi). Off,
// every hook is skipped by a null check and the room behaves exactly as before.
//
// Voice (protocol v5): private rooms only. relaySignal() forwards WebRTC signaling between two
// humans of this room (validated + rebuilt by protocol.sanitizeSignal); setVoiceState() keeps
// each human's mic / deaf flags and broadcasts changes. The server never touches audio, and who
// may hear whom is enforced by the sending client (protocol.voiceAllowed).

import { performance } from 'node:perf_hooks';
import {
  TICK_RATE, SNAPSHOT_EVERY, MAX_PLAYERS, MAX_REWIND_MS, RESPAWN_MS,
  MAX_HEALTH, REGEN_DELAY_MS, REGEN_PER_SEC, BTN, DT, MAX_DILATION_PERMILLE,
  COUNTDOWN_MS, PUBLIC_COUNTDOWN_MS, RESULTS_MS,
} from '../shared/constants.js';
import {
  createPlayerState, copyState, spawnState, stepPlayer, eyeHeight, hitboxHeight, raycastWorld, raycastPlayer,
} from '../shared/physics.js';
import {
  createWeaponState, resetWeaponState, stepWeapon, shotDir, getKit, moveSpeedMult, damageAt,
  DEFAULT_LOADOUT_CODE,
} from '../shared/weapons.js';
import {
  PROTOCOL_VERSION, SHOT, SNAP_SELF_BYTES, PLAYER_ENTRY_BYTES, SHOT_ENTRY_BYTES, MAX_SNAP_SHOTS,
  writeSnapshotSelf, writePlayerEntry, writeShotEntry, normalToAxis, createCmd, sanitizeCmd, encodeText,
  parseLoadoutCode, sanitizeSignal,
} from '../shared/protocol.js';
import {
  MODES, isTeamMode, otherTeam, sanitizeMatchConfig, defaultMatchConfig, decideWinner, MAP_SIZE_PLAYERS,
  FLAG_RETURN_S, HARDPOINT_ROTATE_S, SPAWN_PROTECT_MS, FLAG_TOUCH_RADIUS,
} from '../shared/modes.js';
import { MAPS } from '../shared/maps/index.js';
import { Bot } from './bots.js';
import { worldFor, pickSpawn } from './spawns.js';

const envMs = (name, def) => {
  const v = process.env[name];
  const n = v === undefined || v === '' ? NaN : parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
};
const COUNTDOWN = envMs('COUNTDOWN_MS', COUNTDOWN_MS);
const PUBLIC_COUNTDOWN = envMs('PUBLIC_COUNTDOWN_MS', PUBLIC_COUNTDOWN_MS);
const RESULTS = envMs('RESULTS_MS', RESULTS_MS);
const LOBBY_WAKE_MS = 100;
const MATCH_REFRESH = 120;        // ticks: periodic 'match' (+ 'lobby' in the lobby) refresh
const OBJ_REFRESH = 60;           // ticks: periodic 'obj' refresh while playing
const OBJ_MIN_GAP = 6;            // ticks: objective changes are sent at most this often
const PUBLIC_MODES = ['ffa', 'tdm', 'hardpoint', 'ctf'];

const TICK_MS = 1000 / TICK_RATE;
const msToTicks = (ms) => Math.round(ms / TICK_MS);

const HIST = 128;                                  // per-player position history (~2.1 s)
const MAX_REWIND_TICKS = MAX_REWIND_MS / TICK_MS;  // 36 at 60 Hz
const QUEUE_CAP = 64;                              // ring capacity (overflow drops the oldest)
const QUEUE_WINDOW = 60;                           // ticks over which the min queue depth is tracked
const TRIM_EXCESS = 4;                             // window min > target + this -> trim (latency cap)
const MAX_SPEC = 30;                               // speculate at most this many ticks, then commit
const GUESS_MOVE_TICKS = 12;                       // guessed ticks repeat movement this long, then idle
const LAT_N = 128;                                 // arrival lateness samples kept per player
const TARGET_MIN = 2, TARGET_MAX = 10;             // jitter buffer target bounds (ticks)
const TARGET_MARGIN = 1.25;                        // ticks above p90 lateness
const DEPTH_ALPHA = 1 / 30;                        // depth EWMA (per tick)
const DILATION_GAIN = 12;                          // permille per tick of depth error
const DILATION_DEADBAND = 0.25;                    // ticks
const BURST_GAP = 0.15;                            // ticks: arrivals closer than this are a burst tail
const ARR_LEAK = 0.04;                             // leaky-min rise per tick (> max dilation)
const REANCHOR_TICKS = 0.75;                       // every arrival in a control window later than this -> re-anchor
const REANCHOR_MIN_SAMPLES = 8;                    // ...needs at least this many samples in the window
const MOVE_BUTTONS = BTN.FORWARD | BTN.BACK | BTN.LEFT | BTN.RIGHT | BTN.JUMP | BTN.CROUCH | BTN.ADS;
const SLOW_CLIENT_BYTES = 64 * 1024;               // skip snapshots while more than this is queued
const DEAD_CLIENT_BYTES = 1024 * 1024;             // terminate above this
const TIMING_SAMPLES = 3600;
const MAX_CATCHUP = 5;
const SCORES_EVERY = TICK_RATE;                    // scoreboard broadcast period

export const BOT_MIN = process.env.BOTS !== undefined && process.env.BOTS !== ''
  ? Math.max(0, Math.min(MAX_PLAYERS, parseInt(process.env.BOTS, 10) || 0)) : 4;

export class Room {
  /**
   * opts: { isPrivate, config (partial MatchConfig), botMin (public rooms: keep this many
   * participants), onEmpty(room), spawnPolicy ('smart' | 'legacy') }
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.isPrivate = !!opts.isPrivate;
    this.botMin = opts.botMin ?? BOT_MIN;
    this.onEmpty = opts.onEmpty || (() => {});
    this.spawnPolicy = opts.spawnPolicy || 'smart';
    this.iceServers = Array.isArray(opts.iceServers) ? opts.iceServers : [];
    this.voiceStats = { relayed: 0, refused: 0, limited: 0, states: 0 };
    this.memory = opts.memory || null;
    this.mem = this.memory ? this.memory.createRoom(this) : null;
    this.players = [];          // dense list, humans and bots
    this.byId = new Map();
    this.nextId = 1;
    this.joinSeq = 0;
    this.tick = 0;
    this.destroyed = false;

    // match
    this.modeRot = 0; this.mapRot = 0;
    const cfg = this.isPrivate ? sanitizeMatchConfig(opts.config || {}, defaultMatchConfig(), { allowAi: !!this.mem })
      : this.rotationConfig(opts.config);
    this.config = cfg;
    this.map = null; this.world = null;
    this.setMap(cfg.mapId);
    this.phase = this.isPrivate ? 'lobby' : 'playing';
    this.startTick = 0;
    this.endsTick = this.isPrivate ? 0 : msToTicks(cfg.timeLimitS * 1000);
    this.scores = { a: 0, b: 0 };
    this.result = null;
    this.hostId = 0;
    this.pendingEnd = null;
    this.flags = null;          // ctf: { a: flag, b: flag }
    this.hp = null;             // hardpoint zone state
    this.objDirty = false; this.objSentAt = -1e9;
    this.spawnStats = { spawns: 0, visible: 0 };
    if (this.phase === 'playing') this.initObjectives();

    // Timing / stats
    this.tickTimes = new Float32Array(TIMING_SAMPLES);
    this.tickTimesN = 0;
    this.tickTimesHead = 0;
    this.tickMax = 0;
    this.overruns = 0;
    this.catchUpDrops = 0;
    this.snapshotsSkipped = 0;
    this.bytesOut = 0;
    this.createdAt = performance.now();

    // Scratch (no per-tick allocation)
    this.dir = [0, 0, 0];
    this.normal = [0, 0, 0];
    this.rew = new Float64Array(256 * 5);    // per player index: x,y,z,h,valid
    this.dmgVictim = new Array(16).fill(null);
    this.dmgAmount = new Float64Array(16);
    this.dmgHead = new Uint8Array(16);
    this.playersBlock = new Uint8Array(256 * PLAYER_ENTRY_BYTES);
    this.playersView = new DataView(this.playersBlock.buffer);
    this.shotsBlock = new Uint8Array(MAX_SNAP_SHOTS * SHOT_ENTRY_BYTES);
    this.shotsView = new DataView(this.shotsBlock.buffer);
    this.shotCount = 0;
    this.selfBlock = new Uint8Array(SNAP_SELF_BYTES);
    this.selfView = new DataView(this.selfBlock.buffer);
    this.shotScratch = { shooter: 0, weapon: 0, gun: 0, kind: 0, victim: 0, x: 0, y: 0, z: 0, normal: 7 };
    this.latSort = new Float32Array(LAT_N);

    // Fixed-step loop
    this.timer = null;
    this.nextAt = 0;
    this.lastTickAt = 0;
    this.loop = this.loop.bind(this);
  }

  // ------------------------------------------------------------------ lifecycle

  start() {
    this.nextAt = performance.now();
    this.lastTickAt = this.nextAt;
    this.updateBots();
    this.loop();
  }

  destroy() {
    if (this.mem && !this.destroyed) this.mem.destroy();
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.players.length = 0;
    this.byId.clear();
  }

  loop() {
    if (this.destroyed) return;
    const now = performance.now();
    let steps = 0;
    // lobby: nothing is simulated, so wake rarely and catch the tick counter up in one go
    const idle = this.phase === 'lobby';
    const maxSteps = idle ? Math.ceil(LOBBY_WAKE_MS / TICK_MS) + MAX_CATCHUP : MAX_CATCHUP;
    while (now >= this.nextAt && steps < maxSteps) {
      this.lastTickAt = this.nextAt;
      this.nextAt += TICK_MS;
      const t0 = performance.now();
      try {
        this.step();
      } catch (err) {
        console.error(`[room ${this.name}] tick ${this.tick} failed:`, err);
      }
      if (!idle) this.recordTiming(performance.now() - t0);
      steps++;
      if (this.destroyed) return;
    }
    if (now - this.nextAt > TICK_MS * maxSteps) {
      // Hopelessly behind (machine stalled): drop the backlog instead of fast-forwarding.
      this.catchUpDrops++;
      this.nextAt = now + TICK_MS;
    }
    let delay = this.nextAt - performance.now();
    if (this.phase === 'lobby') delay += LOBBY_WAKE_MS - TICK_MS;
    this.timer = setTimeout(this.loop, delay > 1 ? Math.floor(delay) : 0);
  }

  recordTiming(ms) {
    this.tickTimes[this.tickTimesHead] = ms;
    this.tickTimesHead = (this.tickTimesHead + 1) % TIMING_SAMPLES;
    if (this.tickTimesN < TIMING_SAMPLES) this.tickTimesN++;
    if (ms > this.tickMax) this.tickMax = ms;
    if (ms > TICK_MS) this.overruns++;
  }

  resetStats() {
    this.tickTimesN = 0; this.tickTimesHead = 0; this.tickMax = 0; this.overruns = 0;
    this.catchUpDrops = 0; this.snapshotsSkipped = 0; this.bytesOut = 0;
    this.createdAt = performance.now();
    for (const p of this.players) {
      p.starvedTotal = 0; p.cmdsDropped = 0; p.dropCommit = 0; p.dropTrim = 0; p.dropAlive = 0; p.specReplays = 0; p.specCommits = 0;
      p.shotsFired = 0; p.rewindClamped = 0; p.maxRewind = 0;
    }
  }

  /** Current server time in fractional ticks (for pong / clock sync). */
  currentTick() {
    const f = (performance.now() - this.lastTickAt) / TICK_MS;
    const cap = this.phase === 'lobby' ? LOBBY_WAKE_MS / TICK_MS + 2 : 1.5;   // the lobby loop sleeps
    return this.tick + (f < 0 ? 0 : f > cap ? cap : f);
  }

  get humans() { let n = 0; for (const p of this.players) if (!p.bot) n++; return n; }
  get botCount() { let n = 0; for (const p of this.players) if (p.bot) n++; return n; }
  hasFreeSlot() { return this.humans < MAX_PLAYERS; }

  // ------------------------------------------------------------------ players

  allocId() {
    for (let i = 0; i < 255; i++) {
      const id = this.nextId;
      this.nextId = this.nextId >= 255 ? 1 : this.nextId + 1;
      if (!this.byId.has(id)) return id;
    }
    return 0;
  }

  createPlayer(name, ws, bot, loadoutCode) {
    const id = this.allocId();
    if (!id) return null;
    const lo = parseLoadoutCode(loadoutCode, DEFAULT_LOADOUT_CODE);
    const kit = getKit(lo);
    const queue = [];
    for (let i = 0; i < QUEUE_CAP; i++) { const c = createCmd(); c.rt = 0; queue.push(c); }
    const p = {
      id, name, bot: !!bot, ws: ws || null, botBrain: null,
      state: createPlayerState(), wstate: createWeaponState(kit),
      // loadout: pending code (applied at the next spawn) and the active kit of this life
      loadout: lo, kit,
      alive: false, health: 0, respawnAt: 0, lastDamageTick: -1e9, spawnTick: 0,
      kills: 0, deaths: 0, ping: 0,
      // match: team ('' | 'a' | 'b'), spawn protection end tick, carried flag ('' | the
      // flag's team), objective score (captures / zone seconds), join order (host migration)
      team: '', protectedUntil: 0, carrying: '', obj: 0, joinSeq: ++this.joinSeq,
      // voice (v5, private rooms): transmitting / speaker off
      mic: false, deaf: false,
      // cmd jitter buffer
      queue, qHead: 0, qLen: 0, lastQueuedSeq: -1, ackSeq: -1,
      lastCmd: createCmd(), guess: createCmd(), starved: 0, qMin: 1e9, qWindow: 0,
      // speculation while starved: state after the last real cmd + number of guessed ticks
      specBase: createPlayerState(), specN: 0, commitN: 0, commitTick: 0,
      // adaptive target + dilation
      lat: new Float32Array(LAT_N), latHead: 0, latN: 0, lastArrAt: -1e9,
      arrMinCur: 1e9, arrBucketAt: 0, latWinMin: 1e9, latWinN: 0,
      target: 2, depthAvg: 2, dilation: 0, starvedCounter: 0,
      // net stats (/status)
      starvedTotal: 0, cmdsDropped: 0, dropCommit: 0, dropTrim: 0, dropAlive: 0, specReplays: 0, specCommits: 0, rewindClamped: 0, shotsFired: 0, maxRewind: 0,
      // lag-compensation history
      hist: new Float32Array(HIST * 4), histTick: new Int32Array(HIST).fill(-1), histAlive: new Uint8Array(HIST),
      // reused snapshot views
      entry: { id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: false, crouching: false, sliding: false,
        onGround: false, ads: false, reloading: false, weapon: 0, gun: 0, health: 0, team: '', protected: false, carrier: false },
      you: { id, alive: false, health: 0, respawnTicks: 0, state: null, weapon: null,
        inputBuffer: 0, inputTarget: 0, timeScale: 0, starved: 0, protected: false, team: '', carrier: false },
      index: 0, removed: false,
    };
    p.you.state = p.state;
    p.you.weapon = p.wstate;
    return p;
  }

  addPlayer(p) {
    p.index = this.players.length;
    this.players.push(p);
    this.byId.set(p.id, p);
    if (!p.bot && !this.hostId) this.hostId = p.id;
    if (p.ws) this.sendTo(p, this.welcomeFor(p));
    this.broadcast(encodeText({ t: 'join', player: this.rosterEntry(p) }), p);
    if (this.phase === 'playing') this.respawn(p);
    else this.despawn(p);
  }

  /**
   * Add a human (loadoutCode: optional client-supplied code; playerCode: (v6) the secret memory
   * identity, only looked at when memory is on and never kept). Returns the player, or null if full.
   */
  addHuman(ws, name, loadoutCode, playerCode) {
    if (!this.hasFreeSlot()) return null;
    const p = this.createPlayer(name, ws, false, loadoutCode);
    if (!p) return null;
    if (this.mem) this.mem.addHuman(p, playerCode);
    p.team = this.teamForNew(p);
    // make room by removing a bot first if necessary (one from the newcomer's team if possible)
    if (this.players.length >= MAX_PLAYERS) {
      const bot = this.players.find((q) => q.bot && q.team === p.team) || this.players.find((q) => q.bot);
      if (bot) this.removePlayer(bot);
    }
    this.addPlayer(p);
    this.updateBots();
    this.lobbyChanged();
    if (this.mem) this.mem.refreshTips();
    return p;
  }

  addBot(team = '') {
    const p = this.createPlayer(Bot.pickName(this), null, true, Bot.pickLoadout());
    if (!p) return null;
    p.team = team;
    p.botBrain = new Bot(this, p);
    this.addPlayer(p);
    return p;
  }

  removePlayer(p) {
    if (p.removed) return;
    if (p.carrying) this.dropFlag(p, false);
    p.removed = true;
    p.alive = false;
    const i = this.players.indexOf(p);
    if (i >= 0) {
      this.players.splice(i, 1);
      for (let k = i; k < this.players.length; k++) this.players[k].index = k;
    }
    this.byId.delete(p.id);
    p.ws = null;
    this.broadcast(encodeText({ t: 'leave', id: p.id }), null);
    if (!p.bot) {
      if (this.mem) this.mem.removeHuman(p);
      if (this.humans === 0) { this.destroy(); this.onEmpty(this); return; }
      if (this.hostId === p.id) this.migrateHost();
      this.updateBots();
      this.lobbyChanged();
      if (this.mem) this.mem.refreshTips();
    }
  }

  /** The human present longest becomes host. */
  migrateHost() {
    let best = null;
    for (const q of this.players) if (!q.bot && (!best || q.joinSeq < best.joinSeq)) best = q;
    this.hostId = best ? best.id : 0;
    this.broadcastMatch();
    if (this.mem) this.mem.refreshTips();
  }

  get teamMode() { return isTeamMode(this.config.mode); }

  teamCounts(except = null) {
    const c = { a: 0, b: 0, ha: 0, hb: 0 };
    for (const q of this.players) {
      if (q === except || q.removed) continue;
      if (q.team === 'a') { c.a++; if (!q.bot) c.ha++; } else if (q.team === 'b') { c.b++; if (!q.bot) c.hb++; }
    }
    return c;
  }

  /**
   * Team for a joining human: co-op -> 'a'; otherwise the smaller team counting humans first
   * (bots are rebalanced around humans), then all players, then the lower score, then 'a'.
   */
  teamForNew(p) {
    if (!this.teamMode) return '';
    if (this.config.coop) return 'a';
    const c = this.teamCounts(p);
    if (c.ha !== c.hb) return c.ha < c.hb ? 'a' : 'b';
    if (c.a !== c.b) return c.a < c.b ? 'a' : 'b';
    if (this.scores.a !== this.scores.b) return this.scores.a < this.scores.b ? 'a' : 'b';
    return 'a';
  }

  setTeam(p, team) {
    if (p.team === team) return;
    p.team = team;
    this.broadcast(encodeText({ t: 'team', id: p.id, team }), null);
  }

  /** (Re)assign every human's team after a mode / co-op change in the lobby. */
  reassignTeams() {
    const humans = this.players.filter((q) => !q.bot).sort((x, y) => x.joinSeq - y.joinSeq);
    if (!this.teamMode) { for (const q of humans) this.setTeam(q, ''); return; }
    if (this.config.coop) { for (const q of humans) this.setTeam(q, 'a'); return; }
    // keep valid teams, place the rest on the smaller side
    for (const q of humans) if (q.team !== 'a' && q.team !== 'b') q.team = '';
    for (const q of humans) {
      if (q.team === 'a' || q.team === 'b') continue;
      const c = this.teamCounts(q);
      this.setTeam(q, c.ha <= c.hb ? 'a' : 'b');
    }
  }

  /** Without bots, humans are evened out (latest joiners move) when a match starts. */
  balanceHumans() {
    if (!this.teamMode || this.config.coop || (this.isPrivate ? this.config.bots.fill : this.botMin) > 0) return;
    for (let guard = 0; guard < MAX_PLAYERS; guard++) {
      const c = this.teamCounts();
      if (Math.abs(c.ha - c.hb) <= 1) return;
      const from = c.ha > c.hb ? 'a' : 'b';
      let mover = null;
      for (const q of this.players) if (!q.bot && q.team === from && (!mover || q.joinSeq > mover.joinSeq)) mover = q;
      if (!mover) return;
      this.setTeam(mover, otherTeam(from));
    }
  }

  /**
   * Bots. Lobby: none. Private rooms fill to config.bots.fill participants, public rooms to
   * botMin. Team modes: both teams are filled to the same size (ceil(total / 2)) around the
   * humans; 0 = no bots at all. Co-op: every bot on team 'b', max(fill - humans, humans) of them.
   */
  updateBots() {
    const humans = this.humans;
    const fill = this.isPrivate ? this.config.bots.fill : this.botMin;
    const want = { '': 0, a: 0, b: 0 };
    if (this.phase === 'lobby' || fill <= 0) { /* none */ } else if (!this.teamMode) {
      want[''] = Math.max(0, Math.min(fill - humans, MAX_PLAYERS - humans));
    } else if (this.config.coop) {
      want.b = Math.max(0, Math.min(Math.max(fill - humans, humans), MAX_PLAYERS - humans));
    } else {
      const c = this.teamCounts();
      const per = Math.ceil(Math.min(MAX_PLAYERS, Math.max(fill, humans)) / 2);
      want.a = Math.max(0, per - c.ha); want.b = Math.max(0, per - c.hb);
      while (humans + want.a + want.b > MAX_PLAYERS) { if (want.a >= want.b) want.a--; else want.b--; }
    }
    // remove surplus (newest first) and bots on a team that no longer exists in this mode
    for (let i = this.players.length - 1; i >= 0; i--) {
      const q = this.players[i];
      if (!q || !q.bot) continue;
      const t = q.team in want ? q.team : null;
      if (t === null || want[t] <= 0) { this.removePlayer(q); continue; }
      want[t]--;
    }
    for (const t of ['', 'a', 'b']) while (want[t] > 0) { if (!this.addBot(t)) break; want[t]--; }
  }

  rosterEntry(p) {
    const e = { id: p.id, name: p.name, bot: p.bot, kills: p.kills, deaths: p.deaths, ping: p.ping, lo: p.kit.code, team: p.team, obj: p.obj };
    if (this.isPrivate) { e.mic = p.mic; e.deaf = p.deaf; }
    return e;
  }

  // ------------------------------------------------------------------ voice (v5)

  /**
   * Relay one WebRTC signal from human p to player `to`. Only inside a private room, only between
   * two different humans that are both in this room. Returns null (sent) or a reason string.
   */
  relaySignal(p, to, d) {
    const refuse = (why) => { this.voiceStats.refused++; return why; };
    if (!this.isPrivate) return refuse('not_private');
    if (!p || p.bot || !p.ws || p.removed || this.byId.get(p.id) !== p) return refuse('bad_sender');
    if (!Number.isInteger(to) || to === p.id) return refuse('bad_target');
    const q = this.byId.get(to);
    if (!q) return refuse('no_target');
    if (q.bot || !q.ws || q.removed) return refuse('bad_target');
    const sig = sanitizeSignal(d);
    if (!sig) return refuse('bad_signal');
    this.sendTo(q, encodeText({ t: 'rtc', from: p.id, d: sig }));
    this.voiceStats.relayed++;
    return null;
  }

  /** A human's voice state (mic = transmitting, deaf = speaker off). Private rooms only. */
  setVoiceState(p, mic, deaf) {
    if (!this.isPrivate || p.bot) { this.voiceStats.refused++; return 'not_private'; }
    if (typeof mic !== 'boolean' || typeof deaf !== 'boolean') return 'bad_voice';
    if (p.mic === mic && p.deaf === deaf) return null;
    p.mic = mic; p.deaf = deaf;
    this.voiceStats.states++;
    this.broadcast(encodeText({ t: 'voice', id: p.id, mic, deaf }), p);
    return null;
  }

  /**
   * Set p's PENDING loadout (client 'loadout' message or a bot re-roll). Sanitised; applied at
   * p's next spawn, never mid-life. Humans get the sanitised code back. Returns the code.
   */
  setLoadout(p, code) {
    const lo = parseLoadoutCode(code, p.loadout);
    p.loadout = lo;
    if (p.ws) this.sendTo(p, encodeText({ t: 'loadout', lo }));
    return lo;
  }

  welcomeFor(p) {
    return encodeText({
      t: 'welcome', v: PROTOCOL_VERSION, id: p.id, room: this.name, tick: this.currentTick(),
      private: !!this.isPrivate, bots: this.isPrivate ? this.config.bots.fill : this.botMin,
      tickRate: TICK_RATE, snapshotEvery: SNAPSHOT_EVERY, mapId: this.map.id, map: this.map.name, lo: p.loadout,
      players: this.players.map((q) => this.rosterEntry(q)),
      round: this.roundCompat(),
      match: this.matchState(), lobby: this.lobbyState(), obj: this.objState(),
      // (v5) voice chat: private rooms only
      voice: !!this.isPrivate, ice: this.isPrivate ? this.iceServers : undefined,
      // (v6) optional memory layer: AI bots + suggestions available
      memory: !!this.mem,
    });
  }

  // ------------------------------------------------------------------ match: state + messages

  setMap(mapId) {
    const { map, world } = worldFor(mapId);
    this.map = map; this.world = world;
  }

  matchState() {
    return {
      phase: this.phase, mode: this.config.mode, mapId: this.map.id, map: this.map.name, config: this.config,
      private: this.isPrivate, hostId: this.isPrivate ? this.hostId : 0, startTick: this.startTick, endsTick: this.endsTick,
      scores: { a: this.scores.a, b: this.scores.b }, result: this.phase === 'results' ? this.result : null,
    };
  }

  lobbyState() {
    return {
      hostId: this.isPrivate ? this.hostId : 0,
      players: this.players.map((q) => ({ id: q.id, name: q.name, team: q.team, bot: q.bot })),
    };
  }

  roundCompat() {
    return { phase: this.phase === 'playing' ? 'playing' : 'intermission', endsTick: this.endsTick };
  }

  broadcastMatch() { this.broadcast(encodeText({ t: 'match', ...this.matchState() }), null); }
  lobbyChanged() { this.broadcast(encodeText({ t: 'lobby', ...this.lobbyState() }), null); }

  objState() {
    if (this.phase !== 'playing') return null;
    const o = { mode: this.config.mode, scores: { a: this.scores.a, b: this.scores.b }, flags: null, hp: null };
    if (this.flags) {
      o.flags = {};
      for (const t of ['a', 'b']) {
        const f = this.flags[t];
        const c = f.state === 'carried' ? this.byId.get(f.carrier) : null;
        if (c) { f.x = c.state.x; f.y = c.state.y; f.z = c.state.z; }
        o.flags[t] = { state: f.state, carrier: f.carrier, pos: [round2(f.x), round2(f.y), round2(f.z)], returnTick: f.returnTick };
      }
    }
    if (this.hp) {
      const h = this.hp, z = this.map.hardpoints[h.index];
      o.hp = { index: h.index, name: z.name, min: z.min, max: z.max, owner: h.owner, rotateTick: h.rotateTick,
        next: (h.index + 1) % this.map.hardpoints.length, count: { a: h.countA, b: h.countB } };
    }
    return o;
  }

  sendObj() {
    const o = this.objState();
    if (!o) return;
    this.objDirty = false; this.objSentAt = this.tick;
    this.broadcast(encodeText({ t: 'obj', ...o }), null);
  }

  event(e, fields) { this.broadcast(encodeText({ t: 'ev', e, ...fields }), null); }

  // ------------------------------------------------------------------ match: client requests

  /** Returns null on success or an error code (the caller reports it to the client). */
  requestConfig(p, cfg) {
    if (!this.isPrivate || p.id !== this.hostId) return 'not_host';
    if (this.phase !== 'lobby') return 'bad_phase';
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return 'bad_config';
    const prev = this.config;
    const next = sanitizeMatchConfig(cfg, prev, { allowAi: !!this.mem });
    this.config = next;
    if (next.mapId !== this.map.id) this.setMap(next.mapId);
    if (next.mode !== prev.mode || next.coop !== prev.coop) { this.reassignTeams(); this.lobbyChanged(); }
    this.broadcastMatch();
    if (this.mem) this.mem.refreshTips();
    return null;
  }

  requestStart(p) {
    if (!this.isPrivate || p.id !== this.hostId) return 'not_host';
    if (this.phase !== 'lobby') return 'bad_phase';
    this.startCountdown(COUNTDOWN);
    return null;
  }

  requestTeam(p, team) {
    if (team !== 'a' && team !== 'b') return 'bad_team';
    if (!this.teamMode || this.config.coop) return 'bad_team';
    if (this.phase !== 'lobby') return 'bad_phase';
    this.setTeam(p, team);
    this.lobbyChanged();
    return null;
  }

  requestLobby(p) {
    if (!this.isPrivate || p.id !== this.hostId) return 'not_host';
    if (this.phase === 'lobby') return 'bad_phase';
    this.toLobby();
    return null;
  }

  // ------------------------------------------------------------------ match: phases

  /** Kill silently (no kill event, no score): phase changes. Commits any speculation. */
  despawn(p) {
    if (p.carrying) this.dropFlag(p, false);
    if (p.alive && p.specN > 0) { p.commitN += p.specN; p.commitTick = this.tick; p.specN = 0; }
    p.alive = false;
    p.health = 0;
    p.respawnAt = Infinity;
    p.protectedUntil = 0;
  }

  startCountdown(ms) {
    this.phase = 'countdown';
    this.result = null;
    this.pendingEnd = null;
    this.flags = null; this.hp = null;
    for (const p of this.players) {
      this.despawn(p);
      // a fresh start for the input path (clients stop sending in the lobby)
      p.commitN = 0; p.specN = 0;
    }
    this.reassignTeams();
    this.balanceHumans();
    this.updateBots();
    this.endsTick = this.tick + Math.max(1, msToTicks(ms));
    this.warmNav();
    this.broadcastMatch();
    this.lobbyChanged();
    this.broadcast(encodeText({ t: 'round', ...this.roundCompat() }), null);
    if (this.mem) this.mem.refreshTips();
  }

  startPlaying() {
    this.phase = 'playing';
    this.pendingEnd = null;
    this.result = null;
    this.scores.a = 0; this.scores.b = 0;
    this.startTick = this.tick;
    this.endsTick = this.tick + msToTicks(this.config.timeLimitS * 1000);
    for (const p of this.players) { p.kills = 0; p.deaths = 0; p.obj = 0; p.carrying = ''; }
    if (this.mem) this.mem.matchStart();
    this.initObjectives();
    this.broadcastMatch();
    this.event('match_start', { mode: this.config.mode, mapId: this.map.id, endsTick: this.endsTick });
    this.broadcast(encodeText({ t: 'round', ...this.roundCompat() }), null);
    // spawn everyone in a random order (spawn choice depends on who is already standing)
    const order = this.players.slice();
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = order[i]; order[i] = order[j]; order[j] = t; }
    for (const p of order) this.respawn(p);
    this.sendObj();
  }

  endMatch(reason) {
    const rows = this.players.map((p) => ({ id: p.id, name: p.name, team: p.team, bot: p.bot, kills: p.kills, deaths: p.deaths, obj: p.obj }));
    const { winner, draw } = decideWinner(this.config.mode, this.scores, rows);
    const wp = typeof winner === 'number' ? this.byId.get(winner) : null;
    this.phase = 'results';
    this.pendingEnd = null;
    this.endsTick = this.tick + Math.max(1, msToTicks(RESULTS));
    this.result = {
      mode: this.config.mode, mapId: this.map.id, winner, draw,
      winnerName: wp ? wp.name : winner === 'a' ? 'Team A' : winner === 'b' ? 'Team B' : '',
      scores: { a: this.scores.a, b: this.scores.b }, reason, endsTick: this.endsTick, rows,
    };
    if (this.mem) this.mem.matchEnd(this.result);     // reads the live stats; writes happen later, async
    for (const p of this.players) this.despawn(p);
    this.flags = null; this.hp = null;
    this.broadcast(encodeText({ t: 'result', ...this.result }), null);
    this.event('match_end', this.result);
    this.broadcastMatch();
    this.broadcast(encodeText({
      t: 'round', phase: 'intermission', endsTick: this.endsTick, winner: wp ? wp.id : 0, rows: this.scoreRows(),
    }), null);
  }

  afterResults() {
    if (this.isPrivate) { this.toLobby(); return; }
    this.config = this.rotationConfig();
    this.setMap(this.config.mapId);
    this.startCountdown(PUBLIC_COUNTDOWN);
  }

  toLobby() {
    this.phase = 'lobby';
    this.result = null;
    this.pendingEnd = null;
    this.flags = null; this.hp = null;
    this.endsTick = 0;
    for (const p of this.players) this.despawn(p);
    this.updateBots();          // removes every bot
    this.broadcastMatch();
    this.lobbyChanged();
    this.broadcast(encodeText({ t: 'round', ...this.roundCompat() }), null);
    if (this.mem) this.mem.refreshTips();
  }

  /**
   * Public rotation: modes in PUBLIC_MODES order; maps whose `size` suits the expected
   * participant count (max(humans, botMin)), cycling, never the same map twice in a row when
   * another one fits. Mode defaults for limits.
   */
  rotationConfig(seed) {
    const mode = PUBLIC_MODES[this.modeRot++ % PUBLIC_MODES.length];
    const n = Math.max(this.players ? this.humans : 1, this.botMin, 2);
    let fit = MAPS.filter((m) => { const r = MAP_SIZE_PLAYERS[m.size] || [2, 20]; return n >= r[0] && n <= r[1]; });
    if (!fit.length) fit = MAPS.slice();
    const cur = this.map ? this.map.id : null;
    let pick = fit[this.mapRot++ % fit.length];
    if (fit.length > 1 && pick.id === cur) pick = fit[this.mapRot++ % fit.length];
    const base = defaultMatchConfig(mode, pick.id);
    return sanitizeMatchConfig({ ...base, ...(seed || {}), mode, mapId: pick.id, bots: { fill: this.botMin } });
  }

  initObjectives() {
    this.flags = null; this.hp = null;
    const map = this.map;
    if (this.config.mode === 'ctf' && map.flags) {
      this.flags = {};
      for (const t of ['a', 'b']) {
        const s = map.flags[t];
        this.flags[t] = { team: t, state: 'home', carrier: 0, x: s[0], y: s[1], z: s[2], home: s, returnTick: 0 };
      }
    } else if (this.config.mode === 'hardpoint' && map.hardpoints && map.hardpoints.length) {
      this.hp = { index: 0, owner: '', rotateTick: this.tick + msToTicks(HARDPOINT_ROTATE_S * 1000), hold: 0, countA: 0, countB: 0 };
    }
    this.objDirty = true;
  }

  /** Precompute the bots' flow fields for this map + mode (once per map, cached). */
  warmNav() {
    if (!this.players.some((q) => q.bot)) return;
    Bot.warm(this);
  }

  isProtected(p) { return p.alive && this.tick < p.protectedUntil; }

  // ------------------------------------------------------------------ match: objectives (per tick)

  stepMatch(tick) {
    if (this.phase === 'countdown') { if (tick >= this.endsTick) this.startPlaying(); return; }
    if (this.phase === 'results') { if (tick >= this.endsTick) this.afterResults(); return; }
    if (this.phase !== 'playing') return;
    if (this.flags) this.stepFlags(tick);
    else if (this.hp) this.stepHardpoint(tick);
    if (!this.pendingEnd && tick >= this.endsTick) this.pendingEnd = 'time';
    if (this.pendingEnd) { this.endMatch(this.pendingEnd); return; }
    if (this.objDirty && tick - this.objSentAt >= OBJ_MIN_GAP) this.sendObj();
    else if (tick - this.objSentAt >= OBJ_REFRESH && (this.flags || this.hp || this.config.mode === 'tdm')) this.sendObj();
  }

  addScore(team, n) {
    this.scores[team] += n;
    this.objDirty = true;
    if (this.scores[team] >= this.config.scoreLimit) this.pendingEnd = 'score';
  }

  touches(p, x, y, z) {
    const dx = p.state.x - x, dz = p.state.z - z, dy = p.state.y - y;
    return dx * dx + dz * dz < FLAG_TOUCH_RADIUS * FLAG_TOUCH_RADIUS && dy > -1.2 && dy < 2.2;
  }

  stepFlags(tick) {
    const F = this.flags;
    for (const t of ['a', 'b']) {
      const f = F[t];
      if (f.state === 'dropped' && tick >= f.returnTick) this.returnFlag(f, null);
    }
    const players = this.players;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive || !p.team) continue;
      const own = F[p.team], enemy = F[otherTeam(p.team)];
      if (own.state === 'dropped' && this.touches(p, own.x, own.y, own.z)) this.returnFlag(own, p);
      if ((enemy.state === 'home' || enemy.state === 'dropped') && !p.carrying && this.touches(p, enemy.x, enemy.y, enemy.z)) {
        enemy.state = 'carried'; enemy.carrier = p.id; enemy.returnTick = 0;
        p.carrying = enemy.team;
        p.protectedUntil = 0;              // no invulnerable carriers
        this.objDirty = true;
        this.event('flag_taken', { team: enemy.team, player: p.id });
      }
      if (p.carrying && own.state === 'home' && this.touches(p, own.home[0], own.home[1], own.home[2])) {
        const f = F[p.carrying];
        p.carrying = '';
        p.obj++;
        this.resetFlag(f);
        this.addScore(p.team, 1);
        this.event('flag_captured', { team: f.team, player: p.id, scorer: p.team, scores: { a: this.scores.a, b: this.scores.b } });
      }
    }
    for (const t of ['a', 'b']) {
      const f = F[t];
      if (f.state !== 'carried') continue;
      const c = this.byId.get(f.carrier);
      if (c) { f.x = c.state.x; f.y = c.state.y; f.z = c.state.z; }
    }
  }

  resetFlag(f) {
    f.state = 'home'; f.carrier = 0; f.returnTick = 0;
    f.x = f.home[0]; f.y = f.home[1]; f.z = f.home[2];
    this.objDirty = true;
  }

  returnFlag(f, byPlayer) {
    this.resetFlag(f);
    this.event('flag_returned', { team: f.team, player: byPlayer ? byPlayer.id : 0 });
  }

  /** p (carrier) died / left / despawned: the flag drops on the ground below p (or goes home). */
  dropFlag(p, fell) {
    const F = this.flags;
    const team = p.carrying;
    p.carrying = '';
    if (!F || !F[team]) return;
    const f = F[team];
    if (f.state !== 'carried' || f.carrier !== p.id) return;
    if (this.phase !== 'playing') { this.resetFlag(f); return; }
    const s = p.state;
    const t = fell ? Infinity : raycastWorld(this.world, s.x, s.y + 0.5, s.z, 0, -1, 0, 40, undefined);
    if (!(t < 40) || s.y + 0.5 - t < this.map.killY + 1) { this.returnFlag(f, null); return; }
    f.state = 'dropped'; f.carrier = 0;
    f.x = s.x; f.y = s.y + 0.5 - t; f.z = s.z;
    f.returnTick = this.tick + msToTicks(FLAG_RETURN_S * 1000);
    this.objDirty = true;
    this.event('flag_dropped', { team: f.team, player: p.id, pos: [round2(f.x), round2(f.y), round2(f.z)], returnTick: f.returnTick });
  }

  inZone(p, z) {
    const s = p.state;
    return s.x >= z.min[0] && s.x <= z.max[0] && s.z >= z.min[2] && s.z <= z.max[2] && s.y >= z.min[1] - 0.6 && s.y <= z.max[1];
  }

  stepHardpoint(tick) {
    const h = this.hp, zones = this.map.hardpoints;
    if (tick >= h.rotateTick) {
      h.index = (h.index + 1) % zones.length;
      h.rotateTick += msToTicks(HARDPOINT_ROTATE_S * 1000);
      h.owner = ''; h.hold = 0;
      this.objDirty = true;
      this.event('zone_rotated', { index: h.index, name: zones[h.index].name, rotateTick: h.rotateTick });
    }
    const z = zones[h.index];
    let a = 0, b = 0;
    const players = this.players;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive || !p.team || !this.inZone(p, z)) continue;
      if (p.team === 'a') a++; else b++;
    }
    h.countA = a; h.countB = b;
    const owner = a > 0 && b === 0 ? 'a' : b > 0 && a === 0 ? 'b' : a > 0 && b > 0 ? 'contested' : '';
    if (owner !== h.owner) {
      h.owner = owner; h.hold = 0;
      this.objDirty = true;
      if (owner === 'a' || owner === 'b') this.event('zone_taken', { team: owner });
      else if (owner === 'contested') this.event('zone_contested', {});
      else this.event('zone_neutral', {});
    }
    if (owner === 'a' || owner === 'b') {
      if (++h.hold >= TICK_RATE) {
        h.hold = 0;
        for (let i = 0; i < players.length; i++) {
          const p = players[i];
          if (p.alive && p.team === owner && this.inZone(p, z)) p.obj++;
        }
        this.addScore(owner, 1);
      }
    }
  }


  // ------------------------------------------------------------------ input

  /**
   * Queue the cmds of a decoded input packet (protocol.decodeInput output) for player p.
   * Seqs at or below the newest already queued/processed are ignored (redundant copies).
   */
  ingestInput(p, pkt) {
    let first = -1;
    for (let i = 0; i < pkt.count; i++) {
      const c = pkt.cmds[i];
      if (c.seq <= p.lastQueuedSeq) continue;
      this.pushCmd(p, c, pkt.renderTick - (pkt.count - 1 - i));
      if (first < 0) first = c.seq;
    }
    // the OLDEST new cmd is the on-schedule one (a dilated client sends two cmds now and then)
    if (first >= 0) this.measureArrival(p, this.currentTick(), first);
  }

  /**
   * Arrival lateness of cmd `seq` arriving at server time T (fractional ticks): T - seq against
   * the least-delayed recent arrival (a "leaky" minimum that may rise ARR_LEAK ticks per tick, so
   * it follows a client whose clock was slowed down by dilation without inflating lateness).
   * Packets that arrive right behind the previous one (a TCP burst after head-of-line blocking)
   * are not jitter samples.
   */
  measureArrival(p, T, seq) {
    const d = T - seq;
    let base = p.arrMinCur + ARR_LEAK * (T - p.arrBucketAt);
    if (!(d > base)) base = d;            // also initialises (arrMinCur starts huge)
    p.arrMinCur = base; p.arrBucketAt = T;
    const burst = T - p.lastArrAt < BURST_GAP;
    p.lastArrAt = T;
    if (burst) return;
    if (d - base < p.latWinMin) p.latWinMin = d - base;
    p.latWinN++;
    p.lat[p.latHead] = d - base;
    p.latHead = (p.latHead + 1) % LAT_N;
    if (p.latN < LAT_N) p.latN++;
  }

  /** Recompute the buffer target from the lateness samples (p90 + margin). */
  updateTarget(p) {
    const n = p.latN;
    if (n < 16) return;
    const a = this.latSort.subarray(0, n);
    a.set(p.lat.subarray(0, n));
    a.sort();
    const q = a[Math.min(n - 1, Math.floor(n * 0.9))];
    let t = q + TARGET_MARGIN;
    t = t < TARGET_MIN ? TARGET_MIN : t > TARGET_MAX ? TARGET_MAX : t;
    // rise quickly, fall slowly (do not chase every quiet second)
    p.target = t > p.target ? t : p.target + (t - p.target) * 0.1;
  }

  pushCmd(p, c, rt) {
    if (p.qLen === QUEUE_CAP) { p.qHead = (p.qHead + 1) % QUEUE_CAP; p.qLen--; p.cmdsDropped++; }
    const q = p.queue[(p.qHead + p.qLen) % QUEUE_CAP];
    q.seq = c.seq; q.buttons = c.buttons; q.yaw = c.yaw; q.pitch = c.pitch; q.weapon = c.weapon; q.rt = rt;
    p.qLen++;
    p.lastQueuedSeq = c.seq;
  }

  /** Bots feed cmds through here: the same sanitise + queue path as network input. */
  pushBotCmd(p, cmd) {
    if (sanitizeCmd(cmd) === null || cmd.seq <= p.lastQueuedSeq) return;
    this.pushCmd(p, cmd, this.tick);
  }

  popCmd(p) {
    const c = p.queue[p.qHead];
    p.qHead = (p.qHead + 1) % QUEUE_CAP; p.qLen--;
    return c;
  }

  dropOldest(p, n) {
    if (n <= 0) return;
    if (n > p.qLen) n = p.qLen;
    p.qHead = (p.qHead + n) % QUEUE_CAP; p.qLen -= n; p.cmdsDropped += n;
    if (p.alive) p.dropAlive += n;
  }

  /** Simulate one real cmd for p. `late` = ticks this cmd is processed behind schedule (replay). */
  runCmd(p, c, late) {
    if (p.alive) {
      stepPlayer(p.state, c, this.world, moveSpeedMult(p.kit, p.wstate));
      if (stepWeapon(p.wstate, c, p.kit)) this.fire(p, c, c.rt, late);
      if (p.alive && p.state.y < this.map.killY) this.kill(p, null, 0, false);
    }
    p.ackSeq = c.seq;
    const last = p.lastCmd;
    last.seq = c.seq; last.buttons = c.buttons; last.yaw = c.yaw; last.pitch = c.pitch; last.weapon = c.weapon;
  }

  /** One guessed tick while starved: last movement buttons for a while, then idle. Never fires. */
  guessStep(p, i) {
    const g = p.guess, last = p.lastCmd;
    g.seq = last.seq; g.yaw = last.yaw; g.pitch = last.pitch; g.weapon = last.weapon;
    g.buttons = i <= GUESS_MOVE_TICKS ? (last.buttons & MOVE_BUTTONS) : 0;
    stepPlayer(p.state, g, this.world, moveSpeedMult(p.kit, p.wstate));
  }

  /** This tick's input for player p (see the header comment). */
  consume(p) {
    // Depth sample for the dilation controller: real cmds available minus ticks we owe (guessed).
    // Skipped while a long stall is in progress (that is TCP, not clock drift or jitter).
    if (p.specN <= 2 && p.lastQueuedSeq >= 0) this.sampleDepth(p, p.qLen - p.specN);
    // 1. real cmds arrived for ticks we guessed: rewind to the last real state and replay them
    if (p.specN > 0 && p.qLen > 0) {
      const n = p.specN;
      p.specN = 0;
      copyState(p.state, p.specBase);
      const k = n < p.qLen ? n : p.qLen;
      for (let i = 0; i < k; i++) this.runCmd(p, this.popCmd(p), n - i);
      p.specReplays++;
      if (n > k && p.alive) {   // still short: guess the rest again from the new real state
        copyState(p.specBase, p.state);
        p.specN = n - k;
        for (let i = 1; i <= p.specN; i++) this.guessStep(p, i);
      }
    } else if (p.qLen > 0 && p.commitN > 0) {
      // first cmds after a committed (too long) stall: drop the backlog that the guess replaced
      if (this.tick - p.commitTick < TICK_RATE) {
        const n = Math.min(p.commitN, p.qLen - Math.ceil(p.target));
        if (n > 0) { this.dropOldest(p, n); p.commitN -= n; p.dropCommit += n; }
      }
      if (this.tick - p.commitTick >= TICK_RATE || p.commitN <= 0) p.commitN = 0;
    }

    // 2. this tick
    if (p.qLen > 0) {
      p.starved = 0;
      this.runCmd(p, this.popCmd(p), 0);
      return;
    }
    p.starved++;
    p.starvedCounter = (p.starvedCounter + 1) & 0xff;
    if (p.lastQueuedSeq < 0) return;                      // nothing received yet
    if (!p.alive) {
      // dead: nothing to simulate, but this tick happened without a cmd. If a burst brings the
      // missing cmds later, the surplus is dropped (they are worthless now) instead of adding
      // permanent input delay.
      if (p.commitN < TICK_RATE) p.commitN++;
      p.commitTick = this.tick;
      return;
    }
    p.starvedTotal++;
    if (p.specN === 0) copyState(p.specBase, p.state);
    if (p.specN < MAX_SPEC) {
      p.specN++;
      this.guessStep(p, p.specN);
    } else {
      // stalled too long: the guesses become authoritative (the client will get one correction)
      p.specCommits++;
      p.commitN += p.specN; p.commitTick = this.tick;
      p.specN = 0;
      this.guessStep(p, MAX_SPEC + 1);
    }
  }

  sampleDepth(p, depth) {
    p.depthAvg += (depth - p.depthAvg) * DEPTH_ALPHA;
    if (depth < p.qMin) p.qMin = depth;
  }

  /** Once per QUEUE_WINDOW ticks: target from jitter, dilation from depth error, latency cap. */
  netControl(p) {
    // Re-anchor the arrival baseline after a discontinuity. A client that froze (background tab,
    // locked phone) drops its backlog, so every cmd afterwards is "late" by the frozen time. The
    // leaky minimum alone needs 25x the freeze to catch up and would hold the target at its
    // maximum (extra input delay) all that time. If even the earliest arrival of a whole window
    // was late, the baseline is stale: move it and start the jitter statistics afresh.
    if (p.latWinN >= REANCHOR_MIN_SAMPLES && p.latWinMin > REANCHOR_TICKS) {
      p.arrMinCur += p.latWinMin;
      p.latN = 0; p.latHead = 0;
    }
    p.latWinMin = 1e9; p.latWinN = 0;
    this.updateTarget(p);
    const err = p.target - p.depthAvg;
    let dil = 0;
    if (err > DILATION_DEADBAND || err < -DILATION_DEADBAND) {
      dil = Math.round((err - (err > 0 ? DILATION_DEADBAND : -DILATION_DEADBAND)) * DILATION_GAIN);
      if (dil > MAX_DILATION_PERMILLE) dil = MAX_DILATION_PERMILLE;
      else if (dil < -MAX_DILATION_PERMILLE) dil = -MAX_DILATION_PERMILLE;
    }
    p.dilation = dil;
    // latency cap: a large surplus that persisted for the whole window (client ignoring the
    // dilation, or a clock running fast) is trimmed. Never happens to a cooperating client.
    if (p.qMin !== 1e9 && p.qMin > p.target + TRIM_EXCESS && p.specN === 0) {
      const n = Math.floor(p.qMin - p.target - 1);
      this.dropOldest(p, n); p.dropTrim += n;
      p.depthAvg = p.target;
    }
    p.qMin = 1e9;
  }

  // ------------------------------------------------------------------ simulation

  step() {
    const tick = ++this.tick;
    const players = this.players;

    if (this.phase === 'lobby') {
      // nobody is alive: only drain input queues (clients normally send nothing here)
      for (let i = 0; i < players.length; i++) if (players[i].qLen > 0) this.consume(players[i]);
      if (tick % MATCH_REFRESH === 0) { this.broadcastMatch(); this.lobbyChanged(); }
      return;
    }

    // bots decide (produces cmds through the normal queue)
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.botBrain) p.botBrain.think(tick);
    }

    // one cmd per player (or a guess + later replay, see consume)
    const control = tick % QUEUE_WINDOW === 0;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      this.consume(p);
      if (control && p.ws) this.netControl(p);
    }

    // respawn / regen
    const regenDelay = msToTicks(REGEN_DELAY_MS);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive) {
        if (tick >= p.respawnAt && this.phase === 'playing') this.respawn(p);
      } else if (p.health < MAX_HEALTH && tick - p.lastDamageTick >= regenDelay) {
        p.health = Math.min(MAX_HEALTH, p.health + REGEN_PER_SEC * DT);
      }
    }

    // history for lag compensation (state at the END of this tick == what snapshot `tick` shows)
    const slot = tick % HIST;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const o = slot * 4;
      p.hist[o] = p.state.x; p.hist[o + 1] = p.state.y; p.hist[o + 2] = p.state.z;
      p.hist[o + 3] = hitboxHeight(p.state);
      p.histTick[slot] = tick;
      p.histAlive[slot] = p.alive ? 1 : 0;
    }

    // modes, objectives, phase timers (may end the match / start the next phase)
    this.stepMatch(tick);
    if (this.phase === 'lobby') return;

    if (tick % SNAPSHOT_EVERY === 0) this.sendSnapshots();
    if (tick % SCORES_EVERY === 0) this.broadcast(encodeText({ t: 'scores', rows: this.scoreRows() }), null);
    if (tick % MATCH_REFRESH === 0) this.broadcastMatch();
    if (this.botWarm && this.botWarm.length) Bot.warmStep(this);
    if (this.mem && this.phase === 'playing' && tick % TICK_RATE === 0) this.mem.second();
  }

  // ------------------------------------------------------------------ combat

  /** Rewound position of `q` at fractional tick r into this.rew[q.index]. */
  rewind(q, r) {
    const base = q.index * 5;
    const rew = this.rew;
    rew[base + 4] = 0;
    const t0 = Math.floor(r);
    const f = r - t0;
    const s0 = ((t0 % HIST) + HIST) % HIST;
    const s1 = (s0 + 1) % HIST;
    const ok0 = q.histTick[s0] === t0 && q.histAlive[s0] === 1;
    const ok1 = f > 0 && q.histTick[s1] === t0 + 1 && q.histAlive[s1] === 1;
    const h = q.hist;
    if (ok0 && ok1) {
      const a = s0 * 4, b = s1 * 4;
      rew[base] = h[a] + (h[b] - h[a]) * f;
      rew[base + 1] = h[a + 1] + (h[b + 1] - h[a + 1]) * f;
      rew[base + 2] = h[a + 2] + (h[b + 2] - h[a + 2]) * f;
      rew[base + 3] = h[a + 3] + (h[b + 3] - h[a + 3]) * f;
      rew[base + 4] = 1;
    } else if (ok0 || ok1) {
      const a = (ok0 ? s0 : s1) * 4;
      rew[base] = h[a]; rew[base + 1] = h[a + 1]; rew[base + 2] = h[a + 2]; rew[base + 3] = h[a + 3];
      rew[base + 4] = 1;
    }
  }

  fire(p, cmd, renderTick, late = 0) {
    const slot = p.wstate.weapon;
    const w = p.kit.slots[slot];
    const gun = p.kit.guns[slot];
    const st = p.state;
    const ox = st.x, oy = st.y + eyeHeight(st), oz = st.z;
    const spread = p.wstate.spread;     // set by stepWeapon for this shot (aim, bloom)

    // Rewind other players to the time the shooter was looking at.
    // History exists up to tick-1 for everyone (this tick's moves are not final yet).
    // A cmd replayed after a stall (late > 0) is honoured as if it had arrived on time.
    p.protectedUntil = 0;               // firing ends spawn protection
    let r = renderTick;
    const newest = this.tick - 1;
    const oldest = this.tick - MAX_REWIND_TICKS - late;
    if (!(r <= newest)) r = newest;     // also handles NaN
    p.shotsFired++;
    if (r < oldest) { r = oldest; p.rewindClamped++; }
    const rw = this.tick - r - late;
    if (rw > p.maxRewind) p.maxRewind = rw;
    const players = this.players;
    for (let i = 0; i < players.length; i++) {
      const q = players[i];
      // friendly fire is off: shots pass through teammates
      if (q === p || !q.alive || (p.team && q.team === p.team)) { this.rew[q.index * 5 + 4] = 0; continue; }
      this.rewind(q, r);
    }

    const dir = this.dir, normal = this.normal, rew = this.rew;
    let nd = 0;
    const shot = this.shotScratch;
    for (let k = 0; k < w.pellets; k++) {
      shotDir(dir, cmd.yaw, cmd.pitch, spread, cmd.seq, k);
      const dx = dir[0], dy = dir[1], dz = dir[2];
      normal[0] = 0; normal[1] = 0; normal[2] = 0;
      const wd = raycastWorld(this.world, ox, oy, oz, dx, dy, dz, w.range, normal);
      let best = wd < w.range ? wd : w.range;
      let kind = wd < w.range ? SHOT.WORLD : SHOT.MISS;
      let victim = null;
      for (let i = 0; i < players.length; i++) {
        const q = players[i];
        const b = q.index * 5;
        if (rew[b + 4] !== 1) continue;
        const hit = raycastPlayer(ox, oy, oz, dx, dy, dz, rew[b], rew[b + 1], rew[b + 2], rew[b + 3], best);
        if (hit && hit.t < best) {
          best = hit.t; victim = q; kind = hit.head ? SHOT.HEAD : SHOT.BODY;
        }
      }
      if (victim) {
        const dmg = damageAt(w, best, kind === SHOT.HEAD);
        let j = 0;
        while (j < nd && this.dmgVictim[j] !== victim) j++;
        if (j === nd) { this.dmgVictim[j] = victim; this.dmgAmount[j] = 0; this.dmgHead[j] = 0; nd++; }
        this.dmgAmount[j] += dmg;
        if (kind === SHOT.HEAD) this.dmgHead[j] = 1;
      }
      if (this.shotCount < MAX_SNAP_SHOTS) {
        shot.shooter = p.id; shot.weapon = slot; shot.gun = gun; shot.kind = kind;
        shot.victim = victim ? victim.id : 0;
        shot.x = ox + dx * best; shot.y = oy + dy * best; shot.z = oz + dz * best;
        shot.normal = kind === SHOT.WORLD ? normalToAxis(normal) : 7;
        writeShotEntry(this.shotsView, this.shotCount * SHOT_ENTRY_BYTES, shot);
        this.shotCount++;
      }
    }

    if (this.phase !== 'playing') { for (let j = 0; j < nd; j++) this.dmgVictim[j] = null; return; }
    if (this.mem && p.mem) this.mem.shot(p, gun, p.kit.masks[slot], nd > 0);
    for (let j = 0; j < nd; j++) {
      const v = this.dmgVictim[j];
      this.dmgVictim[j] = null;
      if (!v.alive || this.isProtected(v)) continue;      // spawn protection: hit, no damage
      this.damage(v, p, Math.round(this.dmgAmount[j]), this.dmgHead[j] === 1, slot, gun);
    }
  }

  damage(victim, attacker, amount, headshot, weapon, gun = weapon * 2) {
    if (this.mem) this.mem.damaged(victim, attacker);
    victim.health -= amount;
    victim.lastDamageTick = this.tick;
    const killed = victim.health <= 0;
    if (victim.ws) {
      const a = attacker.state;
      this.sendTo(victim, encodeText({
        t: 'damage', attacker: attacker.id, from: [round2(a.x), round2(a.y), round2(a.z)],
        damage: amount, health: Math.max(0, Math.round(victim.health)),
      }));
    }
    if (attacker.ws) {
      this.sendTo(attacker, encodeText({ t: 'hit', victim: victim.id, damage: amount, headshot, kill: killed }));
    }
    if (victim.botBrain) victim.botBrain.onDamaged(attacker);
    if (killed) this.kill(victim, attacker, weapon, headshot, gun);
  }

  kill(victim, killer, weapon, headshot, gun = (weapon | 0) * 2) {
    const fell = !killer;
    if (victim.carrying) this.dropFlag(victim, fell && victim.state.y < this.map.killY);
    victim.alive = false;
    if (victim.specN > 0) {          // guessed ticks are final now; drop their late cmds later
      victim.commitN += victim.specN; victim.commitTick = this.tick; victim.specN = 0;
    }
    victim.health = 0;
    victim.protectedUntil = 0;
    victim.respawnAt = this.tick + msToTicks(RESPAWN_MS);
    if (this.phase === 'playing') {
      victim.deaths++;
      const enemy = killer && killer !== victim && (!killer.team || killer.team !== victim.team);
      if (enemy) {
        killer.kills++;
        if (this.config.mode === 'tdm' && killer.team) this.addScore(killer.team, 1);
        else if (this.config.mode === 'ffa' && killer.kills >= this.config.scoreLimit) this.pendingEnd = 'score';
      }
      if (this.mem) this.mem.killed(victim, killer, gun | 0);
    }
    this.broadcast(encodeText({
      t: 'kill', killer: killer && killer !== victim ? killer.id : 0, victim: victim.id,
      weapon: weapon | 0, gun: gun | 0, headshot: !!headshot, respawnTicks: msToTicks(RESPAWN_MS),
    }), null);
  }

  respawn(p) {
    const ts = this.spawnStats.enabled ? performance.now() : 0;
    const sp = pickSpawn(this, p);
    if (ts) { const d = performance.now() - ts; this.spawnStats.ms = (this.spawnStats.ms || 0) + d; if (d > (this.spawnStats.maxMs || 0)) this.spawnStats.maxMs = d; }
    spawnState(p.state, sp.pos[0], sp.pos[1], sp.pos[2]);
    p.specN = 0;
    if (p.botBrain) p.botBrain.beforeSpawn();       // bots may re-roll their pending loadout
    p.kit = getKit(p.loadout);                      // the pending loadout becomes active (new life)
    resetWeaponState(p.wstate, p.kit);
    p.alive = true;
    p.health = MAX_HEALTH;
    p.lastDamageTick = -1e9;
    p.spawnTick = this.tick;
    p.respawnAt = Infinity;
    p.protectedUntil = this.tick + msToTicks(SPAWN_PROTECT_MS);
    p.carrying = '';
    if (this.spawnStats.enabled) {     // measurement only (tools/modes.test.js)
      this.spawnStats.spawns++;
      if (this.spawnStats.check(this, p, sp.pos)) this.spawnStats.visible++;
    }
    if (p.botBrain) p.botBrain.onSpawn(sp);
    this.broadcast(encodeText({
      t: 'spawn', id: p.id, x: sp.pos[0], y: sp.pos[1], z: sp.pos[2], yaw: sp.yaw || 0, lo: p.kit.code,
      team: p.team, prot: msToTicks(SPAWN_PROTECT_MS),
    }), null);
  }

  // ------------------------------------------------------------------ scoreboard

  scoreRows() {
    return this.players.map((p) => ({ id: p.id, kills: p.kills, deaths: p.deaths, ping: p.ping, team: p.team, obj: p.obj }));
  }

  // ------------------------------------------------------------------ output

  sendTo(p, str) {
    const ws = p.ws;
    if (!ws || ws.readyState !== 1) return;
    if (ws.bufferedAmount > DEAD_CLIENT_BYTES) { ws.terminate(); return; }
    ws.send(str);
    this.bytesOut += str.length;
  }

  broadcast(str, except) {
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p !== except && p.ws) this.sendTo(p, str);
    }
  }

  sendSnapshots() {
    const players = this.players;
    const n = players.length;
    const pv = this.playersView;
    // shared block: one compact entry per player, in room order
    for (let i = 0; i < n; i++) {
      const p = players[i];
      const e = p.entry, s = p.state;
      e.x = s.x; e.y = s.y; e.z = s.z;
      e.yaw = p.lastCmd.yaw; e.pitch = p.lastCmd.pitch;
      e.alive = p.alive; e.crouching = !!s.crouching; e.sliding = !!s.sliding; e.onGround = !!s.onGround;
      e.ads = (p.lastCmd.buttons & BTN.ADS) !== 0; e.reloading = p.wstate.reload > 0;
      e.weapon = p.wstate.weapon; e.gun = p.kit.guns[p.wstate.weapon]; e.health = p.health;
      e.team = p.team; e.protected = this.isProtected(p); e.carrier = p.carrying !== '';
      writePlayerEntry(pv, i * PLAYER_ENTRY_BYTES, e);
    }
    const shotsLen = this.shotCount * SHOT_ENTRY_BYTES;
    const shotCount = this.shotCount;
    this.shotCount = 0;
    const othersLen = (n - 1) * PLAYER_ENTRY_BYTES;
    const total = SNAP_SELF_BYTES + 1 + othersLen + 1 + shotsLen;

    for (let i = 0; i < n; i++) {
      const p = players[i];
      const ws = p.ws;
      if (!ws || ws.readyState !== 1) continue;
      if (ws.bufferedAmount > SLOW_CLIENT_BYTES) {
        this.snapshotsSkipped++;
        if (ws.bufferedAmount > DEAD_CLIENT_BYTES) ws.terminate();
        continue;
      }
      const you = p.you;
      you.alive = p.alive;
      you.health = p.health;
      you.respawnTicks = p.alive ? 0 : Math.max(0, p.respawnAt - this.tick);
      // the self state is always the state right after ackSeq (never a guessed tick)
      you.state = p.specN > 0 ? p.specBase : p.state;
      you.inputBuffer = p.depthAvg; you.inputTarget = p.target; you.timeScale = p.dilation;
      you.starved = p.starvedCounter;
      you.protected = this.isProtected(p); you.team = p.team; you.carrier = p.carrying !== '';
      writeSnapshotSelf(this.selfView, 0, this.tick, p.ackSeq, you);
      // ws may keep a reference to the buffer while the socket is busy, so each client gets
      // its own (pooled, small) Buffer; all encoding work above is shared.
      const buf = Buffer.allocUnsafe(total);
      buf.set(this.selfBlock, 0);
      let o = SNAP_SELF_BYTES;
      buf[o++] = n - 1;
      const a = i * PLAYER_ENTRY_BYTES;
      if (a > 0) buf.set(this.playersBlock.subarray(0, a), o);
      o += a;
      const rest = (n - 1 - i) * PLAYER_ENTRY_BYTES;
      if (rest > 0) buf.set(this.playersBlock.subarray(a + PLAYER_ENTRY_BYTES, a + PLAYER_ENTRY_BYTES + rest), o);
      o += rest;
      buf[o++] = shotCount;
      if (shotsLen > 0) buf.set(this.shotsBlock.subarray(0, shotsLen), o);
      ws.send(buf, { binary: true });
      this.bytesOut += total;
    }
  }

  // ------------------------------------------------------------------ status

  timingStats() {
    const n = this.tickTimesN;
    if (n === 0) return { samples: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    const a = Array.from(this.tickTimes.subarray(0, n)).sort((x, y) => x - y);
    let sum = 0; for (const v of a) sum += v;
    const pct = (q) => a[Math.min(n - 1, Math.floor(q * n))];
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return { samples: n, avg: r3(sum / n), p50: r3(pct(0.5)), p95: r3(pct(0.95)), p99: r3(pct(0.99)), max: r3(this.tickMax) };
  }

  status() {
    const secs = Math.max(0.001, (performance.now() - this.createdAt) / 1000);
    return {
      name: this.name, tick: this.tick, phase: this.phase, private: this.isPrivate,
      mode: this.config.mode, mapId: this.map.id, hostId: this.hostId, scores: { ...this.scores },
      roundLeftS: Math.max(0, Math.round((this.endsTick - this.tick) / TICK_RATE)),
      players: this.players.length, humans: this.humans, bots: this.botCount,
      tickMs: this.timingStats(), overruns: this.overruns, catchUpDrops: this.catchUpDrops,
      snapshotsSkipped: this.snapshotsSkipped, bytesOutPerSec: Math.round(this.bytesOut / secs),
      voice: { ...this.voiceStats },
      cmdsDropped: this.players.reduce((s, p) => s + p.cmdsDropped, 0),
      net: this.players.filter((p) => !p.bot).map((p) => ({
        id: p.id, starved: p.starvedTotal, dropped: p.cmdsDropped, dropCommit: p.dropCommit, dropTrim: p.dropTrim, dropAlive: p.dropAlive, replays: p.specReplays, commits: p.specCommits,
        target: Math.round(p.target * 100) / 100, depth: Math.round(p.depthAvg * 100) / 100, dilation: p.dilation,
        shots: p.shotsFired, rewindClamped: p.rewindClamped, maxRewindMs: Math.round(p.maxRewind * TICK_MS),
      })),
    };
  }
}

function round2(v) { return Math.round(v * 100) / 100; }
