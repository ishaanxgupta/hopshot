// One game room: 60 Hz authoritative simulation, cmd jitter buffers, lag-compensated hitscan,
// FFA rules, rounds, 30 Hz per-client snapshots and JSON events.

import { performance } from 'node:perf_hooks';
import {
  TICK_RATE, SNAPSHOT_EVERY, MAX_PLAYERS, MAX_REWIND_MS, RESPAWN_MS, ROUND_MS, INTERMISSION_MS,
  MAX_HEALTH, REGEN_DELAY_MS, REGEN_PER_SEC, BTN, DT,
} from '../shared/constants.js';
import { MAP } from '../shared/map.js';
import {
  createPlayerState, spawnState, stepPlayer, eyeHeight, hitboxHeight, raycastWorld, raycastPlayer,
} from '../shared/physics.js';
import {
  WEAPONS, createWeaponState, resetWeaponState, stepWeapon, shotSpread, shotDir,
} from '../shared/weapons.js';
import {
  PROTOCOL_VERSION, SHOT, SNAP_SELF_BYTES, PLAYER_ENTRY_BYTES, SHOT_ENTRY_BYTES, MAX_SNAP_SHOTS,
  writeSnapshotSelf, writePlayerEntry, writeShotEntry, normalToAxis, createCmd, sanitizeCmd, encodeText,
} from '../shared/protocol.js';
import { Bot } from './bots.js';

const TICK_MS = 1000 / TICK_RATE;
const msToTicks = (ms) => Math.round(ms / TICK_MS);

const HIST = 64;                                   // per-player position history (~1.07 s)
const MAX_REWIND_TICKS = MAX_REWIND_MS / TICK_MS;  // 18 at 60 Hz
const QUEUE_CAP = 32;                              // ring capacity
const QUEUE_HARD_MAX = 10;                         // more queued than this -> trim immediately
const QUEUE_HARD_KEEP = 4;                         //   ... down to this many
const QUEUE_WINDOW = 60;                           // ticks over which the min queue length is tracked
const QUEUE_SPARE = 1;                             // keep this many spare cmds over a window
const REPEAT_TICKS = 6;                            // repeat last movement this long when starved
const MOVE_BUTTONS = BTN.FORWARD | BTN.BACK | BTN.LEFT | BTN.RIGHT | BTN.JUMP | BTN.CROUCH | BTN.ADS;
const SLOW_CLIENT_BYTES = 64 * 1024;               // skip snapshots while more than this is queued
const DEAD_CLIENT_BYTES = 1024 * 1024;             // terminate above this
const TIMING_SAMPLES = 3600;
const MAX_CATCHUP = 5;
const SCORES_EVERY = TICK_RATE;                    // scoreboard broadcast period

export const BOT_MIN = process.env.BOTS !== undefined && process.env.BOTS !== ''
  ? Math.max(0, Math.min(MAX_PLAYERS, parseInt(process.env.BOTS, 10) || 0)) : 4;

export class Room {
  constructor(name, world, opts = {}) {
    this.name = name;
    this.world = world;
    this.botMin = opts.botMin ?? BOT_MIN;
    this.onEmpty = opts.onEmpty || (() => {});
    this.players = [];          // dense list, humans and bots
    this.byId = new Map();
    this.nextId = 1;
    this.tick = 0;
    this.phase = 'playing';
    this.endsTick = msToTicks(ROUND_MS);
    this.destroyed = false;

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
    this.shotScratch = { shooter: 0, weapon: 0, kind: 0, victim: 0, x: 0, y: 0, z: 0, normal: 7 };

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
    while (now >= this.nextAt && steps < MAX_CATCHUP) {
      this.lastTickAt = this.nextAt;
      this.nextAt += TICK_MS;
      const t0 = performance.now();
      try {
        this.step();
      } catch (err) {
        console.error(`[room ${this.name}] tick ${this.tick} failed:`, err);
      }
      this.recordTiming(performance.now() - t0);
      steps++;
      if (this.destroyed) return;
    }
    if (now - this.nextAt > TICK_MS * MAX_CATCHUP) {
      // Hopelessly behind (machine stalled): drop the backlog instead of fast-forwarding.
      this.catchUpDrops++;
      this.nextAt = now + TICK_MS;
    }
    const delay = this.nextAt - performance.now();
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
  }

  /** Current server time in fractional ticks (for pong / clock sync). */
  currentTick() {
    const f = (performance.now() - this.lastTickAt) / TICK_MS;
    return this.tick + (f < 0 ? 0 : f > 1.5 ? 1.5 : f);
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

  createPlayer(name, ws, bot) {
    const id = this.allocId();
    if (!id) return null;
    const queue = [];
    for (let i = 0; i < QUEUE_CAP; i++) { const c = createCmd(); c.rt = 0; queue.push(c); }
    const p = {
      id, name, bot: !!bot, ws: ws || null, botBrain: null,
      state: createPlayerState(), wstate: createWeaponState(),
      alive: false, health: 0, respawnAt: 0, lastDamageTick: -1e9, spawnTick: 0,
      kills: 0, deaths: 0, ping: 0,
      // cmd jitter buffer
      queue, qHead: 0, qLen: 0, lastQueuedSeq: -1, ackSeq: -1,
      lastCmd: createCmd(), starved: 0, qMin: 1e9, qWindow: 0, cmdsDropped: 0,
      // lag-compensation history
      hist: new Float32Array(HIST * 4), histTick: new Int32Array(HIST).fill(-1), histAlive: new Uint8Array(HIST),
      // reused snapshot views
      entry: { id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: false, crouching: false, sliding: false,
        onGround: false, ads: false, reloading: false, weapon: 0, health: 0 },
      you: { id, alive: false, health: 0, respawnTicks: 0, state: null, weapon: null },
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
    if (p.ws) this.sendTo(p, this.welcomeFor(p));
    this.broadcast(encodeText({ t: 'join', player: this.rosterEntry(p) }), p);
    this.respawn(p);
  }

  /** Add a human. Returns the player, or null if the room is full. */
  addHuman(ws, name) {
    if (!this.hasFreeSlot()) return null;
    // make room by removing a bot first if necessary
    if (this.players.length >= MAX_PLAYERS) {
      const bot = this.players.find((q) => q.bot);
      if (bot) this.removePlayer(bot);
    }
    const p = this.createPlayer(name, ws, false);
    if (!p) return null;
    this.addPlayer(p);
    this.updateBots();
    return p;
  }

  addBot() {
    const p = this.createPlayer(Bot.pickName(this), null, true);
    if (!p) return null;
    p.botBrain = new Bot(this, p);
    this.addPlayer(p);
    return p;
  }

  removePlayer(p) {
    if (p.removed) return;
    p.removed = true;
    const i = this.players.indexOf(p);
    if (i >= 0) {
      this.players.splice(i, 1);
      for (let k = i; k < this.players.length; k++) this.players[k].index = k;
    }
    this.byId.delete(p.id);
    p.ws = null;
    this.broadcast(encodeText({ t: 'leave', id: p.id }), null);
    if (!p.bot) {
      if (this.humans === 0) { this.destroy(); this.onEmpty(this); return; }
      this.updateBots();
    }
  }

  updateBots() {
    const humans = this.humans;
    const want = Math.max(0, Math.min(this.botMin - humans, MAX_PLAYERS - humans));
    let have = this.botCount;
    while (have > want) {
      let bot = null;
      for (let i = this.players.length - 1; i >= 0; i--) if (this.players[i].bot) { bot = this.players[i]; break; }
      this.removePlayer(bot);
      have--;
    }
    while (have < want) { if (!this.addBot()) break; have++; }
  }

  rosterEntry(p) {
    return { id: p.id, name: p.name, bot: p.bot, kills: p.kills, deaths: p.deaths, ping: p.ping };
  }

  welcomeFor(p) {
    return encodeText({
      t: 'welcome', v: PROTOCOL_VERSION, id: p.id, room: this.name, tick: this.currentTick(),
      private: !!this.isPrivate, bots: this.botMin,
      tickRate: TICK_RATE, snapshotEvery: SNAPSHOT_EVERY, map: MAP.name,
      players: this.players.map((q) => this.rosterEntry(q)),
      round: { phase: this.phase, endsTick: this.endsTick },
    });
  }

  // ------------------------------------------------------------------ input

  /**
   * Queue the cmds of a decoded input packet (protocol.decodeInput output) for player p.
   * Seqs at or below the newest already queued/processed are ignored (redundant copies).
   */
  ingestInput(p, pkt) {
    for (let i = 0; i < pkt.count; i++) {
      const c = pkt.cmds[i];
      if (c.seq <= p.lastQueuedSeq) continue;
      this.pushCmd(p, c, pkt.renderTick - (pkt.count - 1 - i));
    }
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

  /** Pop the cmd for this tick. Returns the queue entry (real) or p.lastCmd (synthesised). */
  takeCmd(p) {
    // Latency control: hard cap, plus slow trimming of spare cmds that stayed queued all window.
    if (p.qLen > QUEUE_HARD_MAX) {
      const drop = p.qLen - QUEUE_HARD_KEEP;
      p.qHead = (p.qHead + drop) % QUEUE_CAP; p.qLen -= drop; p.cmdsDropped += drop;
    }
    if (p.qLen < p.qMin) p.qMin = p.qLen;
    if (++p.qWindow >= QUEUE_WINDOW) {
      if (p.qMin > QUEUE_SPARE && p.qMin !== 1e9) {
        const drop = Math.min(p.qMin - QUEUE_SPARE, 2);
        p.qHead = (p.qHead + drop) % QUEUE_CAP; p.qLen -= drop; p.cmdsDropped += drop;
      }
      p.qWindow = 0; p.qMin = 1e9;
    }

    const last = p.lastCmd;
    if (p.qLen > 0) {
      const c = p.queue[p.qHead];
      p.qHead = (p.qHead + 1) % QUEUE_CAP; p.qLen--;
      p.starved = 0;
      last.seq = c.seq; last.buttons = c.buttons; last.yaw = c.yaw; last.pitch = c.pitch; last.weapon = c.weapon;
      return c;
    }
    // Starved: repeat movement for a few ticks, then idle. Never fires, never reloads.
    p.starved++;
    last.buttons = p.starved <= REPEAT_TICKS ? (last.buttons & MOVE_BUTTONS) : 0;
    return null;
  }

  // ------------------------------------------------------------------ simulation

  step() {
    const tick = ++this.tick;
    const players = this.players;

    // bots decide (produces cmds through the normal queue)
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.botBrain) p.botBrain.think(tick);
    }

    // one cmd per player
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const real = this.takeCmd(p);
      const cmd = real || p.lastCmd;
      if (p.alive) {
        stepPlayer(p.state, cmd, this.world);
        if (real) {
          if (stepWeapon(p.wstate, cmd)) this.fire(p, cmd, real.rt);
        }
        if (p.alive && p.state.y < MAP.killY) this.kill(p, null, 0, false);
      }
      if (real) p.ackSeq = real.seq;
    }

    // respawn / regen
    const regenDelay = msToTicks(REGEN_DELAY_MS);
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive) {
        if (tick >= p.respawnAt) this.respawn(p);
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

    // rounds
    if (tick >= this.endsTick) {
      if (this.phase === 'playing') this.endRound(); else this.startRound();
    }

    if (tick % SNAPSHOT_EVERY === 0) this.sendSnapshots();
    if (tick % SCORES_EVERY === 0) this.broadcast(encodeText({ t: 'scores', rows: this.scoreRows() }), null);
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

  fire(p, cmd, renderTick) {
    const w = WEAPONS[p.wstate.weapon];
    const st = p.state;
    const ox = st.x, oy = st.y + eyeHeight(st), oz = st.z;
    const spread = shotSpread(p.wstate.weapon, cmd.buttons);

    // Rewind other players to the time the shooter was looking at.
    // History exists up to tick-1 for everyone (this tick's moves are not final yet).
    let r = renderTick;
    const newest = this.tick - 1;
    const oldest = this.tick - MAX_REWIND_TICKS;
    if (!(r <= newest)) r = newest;     // also handles NaN
    if (r < oldest) r = oldest;
    const players = this.players;
    for (let i = 0; i < players.length; i++) {
      const q = players[i];
      if (q === p || !q.alive) { this.rew[q.index * 5 + 4] = 0; continue; }
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
        const dmg = w.damage * (kind === SHOT.HEAD ? w.headMult : 1);
        let j = 0;
        while (j < nd && this.dmgVictim[j] !== victim) j++;
        if (j === nd) { this.dmgVictim[j] = victim; this.dmgAmount[j] = 0; this.dmgHead[j] = 0; nd++; }
        this.dmgAmount[j] += dmg;
        if (kind === SHOT.HEAD) this.dmgHead[j] = 1;
      }
      if (this.shotCount < MAX_SNAP_SHOTS) {
        shot.shooter = p.id; shot.weapon = p.wstate.weapon; shot.kind = kind;
        shot.victim = victim ? victim.id : 0;
        shot.x = ox + dx * best; shot.y = oy + dy * best; shot.z = oz + dz * best;
        shot.normal = kind === SHOT.WORLD ? normalToAxis(normal) : 7;
        writeShotEntry(this.shotsView, this.shotCount * SHOT_ENTRY_BYTES, shot);
        this.shotCount++;
      }
    }

    if (this.phase !== 'playing') { for (let j = 0; j < nd; j++) this.dmgVictim[j] = null; return; }
    for (let j = 0; j < nd; j++) {
      const v = this.dmgVictim[j];
      this.dmgVictim[j] = null;
      if (!v.alive) continue;
      this.damage(v, p, Math.round(this.dmgAmount[j]), this.dmgHead[j] === 1, p.wstate.weapon);
    }
  }

  damage(victim, attacker, amount, headshot, weapon) {
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
    if (killed) this.kill(victim, attacker, weapon, headshot);
  }

  kill(victim, killer, weapon, headshot) {
    victim.alive = false;
    victim.health = 0;
    victim.deaths++;
    victim.respawnAt = this.tick + msToTicks(RESPAWN_MS);
    if (killer && killer !== victim && this.phase === 'playing') killer.kills++;
    this.broadcast(encodeText({
      t: 'kill', killer: killer && killer !== victim ? killer.id : 0, victim: victim.id,
      weapon: weapon | 0, headshot: !!headshot, respawnTicks: msToTicks(RESPAWN_MS),
    }), null);
  }

  pickSpawn(p) {
    const spawns = MAP.spawns;
    let best = -1, bestScore = -1;
    const scores = this._spawnScores || (this._spawnScores = new Float64Array(spawns.length));
    for (let s = 0; s < spawns.length; s++) {
      const [sx, sy, sz] = spawns[s].pos;
      let minD = 1e12;
      for (const q of this.players) {
        if (q === p || !q.alive) continue;
        const dx = q.state.x - sx, dy = q.state.y - sy, dz = q.state.z - sz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < minD) minD = d;
      }
      scores[s] = minD;
      if (minD > bestScore) { bestScore = minD; best = s; }
    }
    // a little variety: random pick among spawns nearly as safe as the best
    const thr = bestScore * 0.7;
    let n = 0;
    for (let s = 0; s < spawns.length; s++) if (scores[s] >= thr) n++;
    let pick = Math.floor(Math.random() * n);
    for (let s = 0; s < spawns.length; s++) if (scores[s] >= thr && pick-- === 0) return spawns[s];
    return spawns[Math.max(0, best)];
  }

  respawn(p) {
    const sp = this.pickSpawn(p);
    spawnState(p.state, sp.pos[0], sp.pos[1], sp.pos[2]);
    resetWeaponState(p.wstate);
    p.alive = true;
    p.health = MAX_HEALTH;
    p.lastDamageTick = -1e9;
    p.spawnTick = this.tick;
    if (p.botBrain) p.botBrain.onSpawn(sp);
    this.broadcast(encodeText({
      t: 'spawn', id: p.id, x: sp.pos[0], y: sp.pos[1], z: sp.pos[2], yaw: sp.yaw || 0,
    }), null);
  }

  // ------------------------------------------------------------------ rounds

  scoreRows() {
    return this.players.map((p) => ({ id: p.id, kills: p.kills, deaths: p.deaths, ping: p.ping }));
  }

  endRound() {
    this.phase = 'intermission';
    this.endsTick = this.tick + msToTicks(INTERMISSION_MS);
    let winner = null;
    for (const p of this.players) {
      if (!winner || p.kills > winner.kills || (p.kills === winner.kills && p.deaths < winner.deaths)) winner = p;
    }
    this.broadcast(encodeText({
      t: 'round', phase: this.phase, endsTick: this.endsTick, winner: winner ? winner.id : 0, rows: this.scoreRows(),
    }), null);
  }

  startRound() {
    this.phase = 'playing';
    this.endsTick = this.tick + msToTicks(ROUND_MS);
    for (const p of this.players) { p.kills = 0; p.deaths = 0; }
    this.broadcast(encodeText({ t: 'round', phase: this.phase, endsTick: this.endsTick }), null);
    for (const p of this.players) this.respawn(p);
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
      e.weapon = p.wstate.weapon; e.health = p.health;
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
      name: this.name, tick: this.tick, phase: this.phase,
      roundLeftS: Math.max(0, Math.round((this.endsTick - this.tick) / TICK_RATE)),
      players: this.players.length, humans: this.humans, bots: this.botCount,
      tickMs: this.timingStats(), overruns: this.overruns, catchUpDrops: this.catchUpDrops,
      snapshotsSkipped: this.snapshotsSkipped, bytesOutPerSec: Math.round(this.bytesOut / secs),
      cmdsDropped: this.players.reduce((s, p) => s + p.cmdsDropped, 0),
    };
  }
}

function round2(v) { return Math.round(v * 100) / 100; }
