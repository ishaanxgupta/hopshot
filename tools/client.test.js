#!/usr/bin/env node
// Headless end-to-end test of the client core (client/net.js + the autopilot from client/input.js)
// against the real server.
//
//   node tools/client.test.js [--port 3103] [--clean 20] [--lag 20] [--profiles p80,p180,p250] [--json out.json]
//   profiles (see PROFILES): p80 = 80 ms RTT +-10; p180 = 180 +-40 with 2.5% TCP stalls;
//   p250 = 250 +-60 with 3% TCP stalls. Stalls are modelled the way TCP delivers a loss:
//   head-of-line blocking until the retransmission, then an in-order burst.
//
// 1. Starts `node server/index.js` on port 3103 (private room) as a child process.
// 2. Clean run: 3 headless clients built on createNet(), driven by createAutopilot() (wander,
//    slide-hop, aim + fire at the nearest visible enemy) through a 60 Hz accumulator, exactly
//    like client/main.js. Asserts prediction stays exact after reconciliation, remote
//    interpolation is continuous while alive, clients see each other and bots, shots / kills /
//    respawns flow, and a clean disconnect leaves the server with no room.
// 3. Profile runs: same with a TCP-like link model injected in the client's socket (send and
//    receive), then a "feel" table: corrections/s and size, server starved ticks / dropped cmds,
//    remote stutter (per-tick step outliers, extrapolate / hold events), input-to-ack delay.
// The server child is always killed; nothing is left listening.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { MAP } from '../shared/map.js';
import { createWorld } from '../shared/physics.js';
import { WEAPONS } from '../shared/weapons.js';
import { TICK_MS } from '../shared/protocol.js';
import { createNet } from '../client/net.js';
import { createAutopilot } from '../client/input.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const PORT = args.includes('--port') ? parseInt(args[args.indexOf('--port') + 1], 10) : 3103;
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? parseFloat(args[i + 1]) : d; };
const CLEAN_S = opt('clean', 20);
const LAG_S = opt('lag', 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const world = createWorld(MAP);

// ------------------------------------------------------------------ server child
let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), BOTS: '4' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  let inUse = false;
  server.stderr.on('data', (d) => { if (/EADDRINUSE/.test(String(d))) inUse = true; process.stderr.write(`[server] ${d}`); });
  for (let i = 0; i < 100; i++) {
    if (inUse || server.exitCode !== null) throw new Error(`our server child could not listen (port ${PORT} in use? pick another with --port)`);
    try { const r = await fetch(`http://localhost:${PORT}/status`); if (r.ok) { await sleep(300); if (!inUse && server.exitCode === null) return; } } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}
function killServer() {
  if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
}
process.on('exit', killServer);
process.on('SIGINT', () => { killServer(); process.exit(130); });
const status = () => fetch(`http://localhost:${PORT}/status`).then((r) => r.json());

// ------------------------------------------------------------------ realistic TCP-like link
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Link profiles. rtt / jitter are ROUND-TRIP figures; each direction gets rtt/2 +- jitter/2
 * (uniform), independently. `stall` is the per-message probability of a lost TCP segment.
 * WebSocket runs over TCP, so a loss never drops a message: the segment is retransmitted
 * (fast retransmit ~1 RTT later, sometimes an RTO >= 200 ms) and every later message waits
 * behind it (head-of-line blocking), then everything is released in order in one burst.
 */
export const PROFILES = {
  clean: null,
  p80: { rtt: 80, jitter: 10, stall: 0 },
  p180: { rtt: 180, jitter: 40, stall: 0.025 },
  p250: { rtt: 250, jitter: 60, stall: 0.03 },
  // diagnostics (not in the default set): jitter without stalls, and asymmetric routes
  p180j: { rtt: 180, jitter: 40, stall: 0 },
  asym: { rtt: 180, jitter: 40, stall: 0.025, upShare: 0.75 },
};

function tcpDirection(rnd, { rtt, jitter, stall }, share = 0.5) {
  const oneWay = rtt * share, j = jitter * share;
  let last = 0;
  const counts = { msgs: 0, stalls: 0, stalledMs: 0 };
  /** delivery time for a message handed to the socket at time t (in-order, HOL-blocking). */
  const at = (t) => {
    counts.msgs++;
    let extra = 0;
    if (stall > 0 && rnd() < stall) {
      // time until the retransmission goes out: fast retransmit after ~1 RTT + dupack wait,
      // 15% of the time a retransmission timeout instead
      extra = rnd() < 0.15 ? Math.max(200, rtt * 1.5) + rnd() * rtt * 0.5 : rtt * (1 + 0.3 * rnd()) + 20;
      counts.stalls++; counts.stalledMs += extra;
    }
    const d = Math.max(last, t + extra + oneWay + (rnd() * 2 - 1) * j);
    last = d;
    return d;
  };
  return { at, counts };
}

/**
 * Strict FIFO delivery: items are released in the order they were queued, each no earlier than
 * its delivery time (separate setTimeouts with close expiry times can fire out of order in Node,
 * which a TCP stream never does).
 */
function fifo(deliver) {
  const q = [];
  let timer = null;
  const pump = () => {
    timer = null;
    const t = performance.now();
    while (q.length && q[0].at <= t + 0.5) deliver(q.shift().data);
    if (q.length) timer = setTimeout(pump, Math.max(0, q[0].at - performance.now()));
  };
  return {
    push(at, data) { q.push({ at, data }); if (!timer) timer = setTimeout(pump, Math.max(0, q[0].at - performance.now())); },
    get pending() { return q.length; },
  };
}

/** WebSocket wrapper applying an independent TCP-like link model in each direction. */
function laggySocket(profile, seed) {
  const rnd = prng(seed);
  const us = profile.upShare ?? 0.5;
  const up = tcpDirection(rnd, profile, us), down = tcpDirection(rnd, profile, 1 - us);
  const factory = (url) => {
    const real = new WebSocket(url);
    real.binaryType = 'arraybuffer';
    let lastDown = 0;
    const fake = {
      binaryType: 'arraybuffer', onopen: null, onmessage: null, onclose: null, onerror: null,
      get readyState() { return real.readyState; },
      send(d) { upQ.push(up.at(performance.now()), d); },
      close(code, reason) { real.close(code, reason); },
    };
    const upQ = fifo((d) => { if (real.readyState === 1) real.send(d); });
    const downQ = fifo((data) => { if (fake.onmessage) fake.onmessage({ data }); });
    real.onopen = (e) => setTimeout(() => fake.onopen && fake.onopen(e), profile.rtt * (1 - us));
    real.onmessage = (e) => { lastDown = down.at(performance.now()); downQ.push(lastDown, e.data); };
    real.onerror = (e) => fake.onerror && fake.onerror(e);
    real.onclose = (e) => setTimeout(() => fake.onclose && fake.onclose({ code: e.code, reason: e.reason }), Math.max(0, lastDown - performance.now()) + 1);
    return fake;
  };
  return { factory, up: up.counts, down: down.counts };
}

// ------------------------------------------------------------------ headless client
const VERBOSE = args.includes('--verbose');
const JERK = 0.08;   // m: horizontal per-tick step changing by more than this (4.8 m/s in one tick) = visible stutter

class Client {
  constructor(i, room, socketFactory) {
    this.i = i;
    this.room = room;
    this.net = createNet({ world, url: `ws://localhost:${PORT}/ws`, createSocket: socketFactory });
    this.ap = createAutopilot({ seed: 777 + i * 31 });
    this.players = [];
    this.c = {
      kills: 0, myKills: 0, deaths: 0, hits: 0, damage: 0, spawnsOther: 0, spawnsMine: 0, remoteShotEvents: 0,
      fired: 0, pellets: 0, jumps: 0, slides: 0, boosts: 0, lands: 0, reloads: 0, switches: 0, ticks: 0,
      closes: [], welcome: 0, rounds: 0, respawns: 0,
    };
    this.cont = { samples: 0, maxStep: 0, teleports: 0, jerks: 0, worst: null };
    this.local = { maxStep: 0, steps: 0, last: null, lastStep: -1, jerks: 0, view: {} };
    this.q = { n: 0, interp: 0, scale: 0, buf: 0, jitter: 0, scaleMin: 1, scaleMax: 1 };
    this.prevRemote = new Map();
    this.maxSpeed = 0;
    const n = this.net, c = this.c;
    n.on('welcome', () => { c.welcome++; });
    this.dead = new Set();
    n.on('kill', (m) => { c.kills++; this.dead.add(m.victim); if (m.killer === n.state.id) c.myKills++; if (m.victim === n.state.id) c.deaths++; });
    n.on('hit', () => { c.hits++; });
    n.on('damage', () => { c.damage++; });
    n.on('spawn', (m) => {
      if (this.dead.delete(m.id)) c.respawns++;
      if (m.id === n.state.id) { c.spawnsMine++; this.ap.setYaw(m.yaw || 0); this.local.last = null; } else c.spawnsOther++;
    });
    n.on('shots', (shots) => { c.remoteShotEvents += shots.filter((s) => s.shooter !== n.state.id).length; });
    n.on('close', (e) => { c.closes.push(e); });
    n.on('round', () => { c.rounds++; });
  }

  async connect() {
    this.net.connect(`ctest${this.i}`, this.room);
    for (let i = 0; i < 100 && !this.net.state.connected; i++) await sleep(50);
    assert.ok(this.net.state.connected, `client ${this.i} failed to connect`);
  }

  /** One 60 Hz tick: interpolate remotes, autopilot -> cmd, predict + send, check continuity. */
  tick() {
    const n = this.net;
    if (!n.state.connected) return;
    const rt = n.renderTick();
    n.sampleRemotes(rt, this.players);
    this.checkRemotes();
    const p = n.pred, w = n.predWeapon;
    const o = this.ap.update({
      world, self: p, alive: n.state.alive, remotes: this.players,
      weapon: w.weapon, ammo: w.ammo[w.weapon], magSize: WEAPONS[w.weapon].magSize,
    });
    const fx = n.tick(o, rt);
    n.decayError(TICK_MS / 1000);
    this.c.ticks++;
    if (fx && fx.alive) {
      if (fx.fired) { this.c.fired++; this.c.pellets += fx.shotCount; }
      if (fx.jumped) this.c.jumps++;
      if (fx.slideStart) this.c.slides++;
      if (fx.slideBoost) this.c.boosts++;
      if (fx.landed) this.c.lands++;
      if (fx.reloadStart) this.c.reloads++;
      if (fx.switched) this.c.switches++;
      this.maxSpeed = Math.max(this.maxSpeed, Math.hypot(p.vx, p.vz));
    }
    // rendered local position (alpha = 1 at tick boundaries) must move smoothly too
    const v = n.localView(1, this.local.view);
    const L = this.local;
    if (v.alive && L.last) {
      const d = Math.hypot(v.x - L.last[0], v.y - L.last[1], v.z - L.last[2]);
      const h = Math.hypot(v.x - L.last[0], v.z - L.last[2]);
      L.steps++;
      if (d > L.maxStep) L.maxStep = d;
      if (L.lastStep >= 0 && Math.abs(h - L.lastStep) > JERK) L.jerks++;
      L.lastStep = h;
    } else L.lastStep = -1;
    L.last = v.alive ? [v.x, v.y, v.z] : null;
    const q = n.state.quality;
    if (q && (this.c.ticks % 30) === 0) {
      const Q = this.q;
      Q.n++; Q.interp += q.interpDelayMs; Q.scale += q.timeScale; Q.buf += q.inputBufferTicks; Q.jitter += q.jitterMs;
      Q.scaleMin = Math.min(Q.scaleMin, q.timeScale); Q.scaleMax = Math.max(Q.scaleMax, q.timeScale);
    }
  }

  checkRemotes() {
    const seen = new Set();
    for (const r of this.players) {
      seen.add(r.id);
      const prev = this.prevRemote.get(r.id);
      if (prev && prev.alive && r.alive && prev.life === r.life) {
        const d = Math.hypot(r.x - prev.x, r.y - prev.y, r.z - prev.z);
        const h = Math.hypot(r.x - prev.x, r.z - prev.z);
        this.cont.samples++;
        if (d > this.cont.maxStep) this.cont.maxStep = d;
        if (prev.step >= 0 && Math.abs(h - prev.step) > JERK) this.cont.jerks++;
        prev.step = h;
        if (d > 1.0) { this.cont.teleports++; if (VERBOSE) console.log('  big remote step', JSON.stringify({ id: r.id, d, from: [prev.x, prev.y, prev.z], to: [r.x, r.y, r.z] })); if (!this.cont.worst) this.cont.worst = { id: r.id, d, from: [prev.x, prev.y, prev.z], to: [r.x, r.y, r.z] }; }
      } else if (prev) prev.step = -1;
      if (prev) { prev.x = r.x; prev.y = r.y; prev.z = r.z; prev.alive = r.alive; prev.life = r.life; }
      else this.prevRemote.set(r.id, { x: r.x, y: r.y, z: r.z, alive: r.alive, life: r.life, step: -1 });
    }
    for (const id of this.prevRemote.keys()) if (!seen.has(id)) this.prevRemote.delete(id);
  }
}

/** Drive all clients from one 60 Hz accumulator for `secs` seconds (cap catch-up like main.js). */
async function run(clients, secs) {
  let acc = 0, last = performance.now();
  const end = last + secs * 1000;
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      const t = performance.now();
      let dt = t - last; last = t;
      if (dt > 250) { dt = TICK_MS; acc = 0; }
      acc += dt;
      let n = 0;
      while (acc >= TICK_MS && n < 6) { for (const c of clients) c.tick(); acc -= TICK_MS; n++; }
      if (acc >= TICK_MS) acc %= TICK_MS;
      if (t >= end) { clearInterval(iv); resolve(); }
    }, 2);
  });
}

function fmt(v, d = 4) { return Number.isFinite(v) ? v.toFixed(d) : String(v); }

function report(label, clients) {
  console.log(`\n== ${label} ==`);
  for (const cl of clients) {
    const s = cl.net.stats, c = cl.c, st = cl.net.state;
    const avg = s.compared ? s.sumError / s.compared : 0;
    console.log(`client ${cl.i} id=${st.id} room=${st.roomName} ping=${fmt(st.ping, 1)}ms remotes=${cl.net.remoteCount} roster=${st.roster.size}`);
    console.log(`  prediction: ${s.snapshots} snapshots, ${s.compared} compared, ${s.corrections} corrections ` +
      `(${fmt(100 * s.corrections / Math.max(1, s.compared), 2)}%), max error ${fmt(s.maxError)} m, avg error ${fmt(avg, 6)} m, ` +
      `replays ${s.replays} (avg ${fmt(s.replayedCmds / Math.max(1, s.replays), 1)} cmds, max ${s.maxReplay}), visual snaps ${s.snaps}, ` +
      `max smoothed offset ${fmt(s.maxVisualError)} m`);
    console.log(`  local view: max per-tick step ${fmt(cl.local.maxStep, 3)} m over ${cl.local.steps} ticks, max horiz speed ${fmt(cl.maxSpeed, 2)} m/s`);
    console.log(`  remotes: ${cl.cont.samples} interpolated steps, max per-tick step ${fmt(cl.cont.maxStep, 3)} m, teleports while alive ${cl.cont.teleports}` +
      (cl.cont.worst ? ` (first: ${JSON.stringify(cl.cont.worst)})` : ''));
    console.log(`  play: ticks ${c.ticks}, fired ${c.fired} (${c.pellets} pellets, ${s.predictedShots} predicted), jumps ${c.jumps}, slides ${c.slides} (boosted ${c.boosts}), ` +
      `reloads ${c.reloads}, switches ${c.switches}, remote shots seen ${c.remoteShotEvents}, hits ${c.hits}, damage taken ${c.damage}, ` +
      `kill events ${c.kills} (mine ${c.myKills}, deaths ${c.deaths}), respawns after death ${c.respawns}, ` +
      `cmds sent ${s.cmdsSent}, up ${fmt(s.bytesUp / 1024, 1)} kB, down ${fmt(s.bytesDown / 1024, 1)} kB`);
  }
}

/** What a player would feel, averaged over the 3 clients (rates per second of play). */
function feel(clients, secs, serverNet) {
  const N = clients.length;
  const sum = (f) => clients.reduce((a, c) => a + f(c), 0);
  const corr = sum((c) => c.net.stats.corrections);
  const corrPos = sum((c) => c.net.stats.corrPos ?? c.net.stats.corrections);
  const corrSum = sum((c) => c.net.stats.corrSum);
  const delays = clients.flatMap((c) => { const s = c.net.stats; return Array.from(s.ackDelays.subarray ? s.ackDelays.subarray(0, Math.min(s.ackDelayN, s.ackDelays.length)) : s.ackDelays); }).sort((a, b) => a - b);
  const pct = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : NaN);
  const byId = new Map((serverNet || []).map((e) => [e.id, e]));
  const srv = clients.map((c) => byId.get(c.net.state.id) || { starved: NaN, dropped: NaN });
  const remSamples = sum((c) => c.net.stats.remoteSamples);
  const remotesPerClient = sum((c) => c.net.remoteCount) / N;
  const qn = sum((c) => c.q.n);
  return {
    ping: sum((c) => c.net.state.ping) / N,
    corrPerS: corr / N / secs,
    corrPosPerS: corrPos / N / secs,
    corrAvgCm: corr ? 100 * corrSum / corr : 0,
    corrBigPerS: sum((c) => c.net.stats.corrBig) / N / secs,
    corrMaxCm: 100 * Math.max(...clients.map((c) => c.net.stats.corrMax)),
    starvedPerS: srv.reduce((a, e) => a + e.starved, 0) / N / secs,
    droppedPerS: srv.reduce((a, e) => a + e.dropped, 0) / N / secs,
    droppedAlivePerS: srv.reduce((a, e) => a + (e.dropAlive ?? e.dropped), 0) / N / secs,
    remoteJerkPerS: sum((c) => c.cont.jerks) / N / secs / Math.max(1, remotesPerClient),
    remoteMaxStep: Math.max(...clients.map((c) => c.cont.maxStep)),
    remoteTeleports: sum((c) => c.cont.teleports),
    extrapPerS: sum((c) => c.net.stats.extrapEvents) / N / secs / Math.max(1, remotesPerClient),
    holdPerS: sum((c) => c.net.stats.holdEvents) / N / secs / Math.max(1, remotesPerClient),
    extrapPct: 100 * sum((c) => c.net.stats.extrapSamples) / Math.max(1, remSamples),
    ackAvg: sum((c) => c.net.stats.ackDelaySum) / Math.max(1, sum((c) => c.net.stats.ackDelayN)),
    ackP95: pct(delays, 0.95),
    localJerkPerS: sum((c) => c.local.jerks) / N / secs,
    localMaxStep: Math.max(...clients.map((c) => c.local.maxStep)),
    interpMs: qn ? sum((c) => c.q.interp) / qn : NaN,
    bufTicks: qn ? sum((c) => c.q.buf) / qn : NaN,
    timeScale: qn ? sum((c) => c.q.scale) / qn : NaN,
    timeScaleRange: qn ? [Math.min(...clients.map((c) => c.q.scaleMin)), Math.max(...clients.map((c) => c.q.scaleMax))] : null,
    hits: sum((c) => c.c.hits), fired: sum((c) => c.c.fired),
    replaysPerS: srv.reduce((a, e) => a + (e.replays || 0), 0) / N / secs,
    commits: srv.reduce((a, e) => a + (e.commits || 0), 0),
    srvTarget: srv.reduce((a, e) => a + (e.target ?? NaN), 0) / N,
    rewindClamped: srv.reduce((a, e) => a + (e.rewindClamped ?? NaN), 0),
    maxRewindMs: Math.max(...srv.map((e) => e.maxRewindMs ?? NaN)),
    dilExtraSkipPerS: sum((c) => (c.net.stats.dilationExtra || 0) + (c.net.stats.dilationSkip || 0)) / N / secs,
  };
}

const COLS = [
  ['ping', 'ping ms', 0], ['corrPerS', 'corr all/s', 2], ['corrPosPerS', 'corr pos/s', 2], ['corrAvgCm', 'corr avg cm', 1], ['corrBigPerS', '>10cm/s', 2],
  ['corrMaxCm', 'corr max cm', 0], ['starvedPerS', 'starved/s', 2], ['droppedPerS', 'dropped/s', 2], ['droppedAlivePerS', 'drop alive/s', 2],
  ['remoteJerkPerS', 'rem jerk/s', 2], ['extrapPerS', 'extrap/s', 2], ['holdPerS', 'hold/s', 2], ['extrapPct', 'extrap %', 1],
  ['remoteMaxStep', 'rem max step', 2], ['localJerkPerS', 'loc jerk/s', 2], ['ackAvg', 'ack ms', 0], ['ackP95', 'ack p95', 0],
  ['interpMs', 'interp ms', 0], ['bufTicks', 'buf ticks', 1], ['timeScale', 'timeScale', 4],
  ['srvTarget', 'srv target', 2], ['dilExtraSkipPerS', 'dil steps/s', 2], ['replaysPerS', 'spec replays/s', 2],
  ['commits', 'spec commits', 0], ['maxRewindMs', 'max rewind ms', 0], ['rewindClamped', 'rewind clamped', 0],
  ['hits', 'hits', 0], ['fired', 'shots', 0],
];
function table(rows) {
  const names = Object.keys(rows);
  console.log('\n== feel summary (per client, averaged over 3 clients; jerk/extrap/hold per remote) ==');
  const w = 14;
  console.log('metric'.padEnd(14) + names.map((n) => n.padStart(w)).join(''));
  for (const [k, label, d] of COLS) {
    console.log(label.padEnd(14) + names.map((n) => fmt(rows[n][k], d).padStart(w)).join(''));
  }
}

async function phase(label, secs, room, makeSocket) {
  const clients = [0, 1, 2].map((i) => new Client(i, room, makeSocket ? makeSocket(i) : undefined));
  for (const c of clients) await c.connect();
  // let clock sync / buffers settle, then measure from a clean slate
  await run(clients, 2);
  for (const c of clients) resetMeasure(c);
  await fetch(`http://localhost:${PORT}/status?reset=1`).catch(() => {});
  const trace = args.includes('--trace') ? setInterval(async () => {
    const r = (await status()).rooms.find((x) => x.name === room);
    if (r) console.log('  trace', JSON.stringify(r.net.map(({ id, target, depth, dilation, starved, replays, dropCommit, dropTrim, dropped }) => ({ id, target, depth, dilation, starved, replays, dropCommit, dropTrim, dropped }))),
      clients.map((c) => JSON.stringify(c.net.state.quality)).join(' '));
  }, 2000) : null;
  await run(clients, secs);
  if (trace) clearInterval(trace);
  const st = await status();
  const r = st.rooms.find((x) => x.name === room);
  report(label, clients);
  return { clients, serverNet: r ? r.net : [] };
}

function resetMeasure(c) {
  const s = c.net.stats;
  for (const k of Object.keys(s)) if (typeof s[k] === 'number' && k !== 'connects') s[k] = 0;
  if (Array.isArray(s.ackDelays)) s.ackDelays.length = 0;   // (typed-array ring: ackDelayN reset above)
  c.cont = { samples: 0, maxStep: 0, teleports: 0, jerks: 0, worst: null };
  c.local.maxStep = 0; c.local.steps = 0; c.local.jerks = 0;
  c.q = { n: 0, interp: 0, scale: 0, buf: 0, jitter: 0, scaleMin: 1, scaleMax: 1 };
  for (const k of Object.keys(c.c)) if (typeof c.c[k] === 'number' && k !== 'welcome') c.c[k] = 0;
}

async function disconnect(clients, room) {
  for (const c of clients) c.net.close();
  await sleep(600);
  const s = await status();
  const r = s.rooms.find((x) => x.name === room);
  return { roomGone: !r, status: s };
}

// ------------------------------------------------------------------ main
async function main() {
  await startServer();
  const failures = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); };
  const ROOM = `ctest${process.pid}`;
  const rows = {};
  const wanted = String(args.includes('--profiles') ? args[args.indexOf('--profiles') + 1] : 'p80,p180,p250').split(',').filter(Boolean);

  // ---------------- clean run
  const cleanRun = await phase(`clean local run (${CLEAN_S}s, 3 clients + bots, room ${ROOM})`, CLEAN_S, ROOM, null);
  const clean = cleanRun.clients;
  rows.clean = feel(clean, CLEAN_S, cleanRun.serverNet);
  console.log('\nassertions (clean):');
  const ids = new Set(clean.map((c) => c.net.state.id));
  check(ids.size === 3 && clean.every((c) => c.net.state.roomName === ROOM), 'three clients joined the same private room with distinct ids');
  for (const c of clean) {
    const others = clean.filter((o) => o !== c).map((o) => o.net.state.id);
    const sees = others.every((id) => c.net.remotes.some((r) => r.id === id && r.count > 0));
    const bots = [...c.net.state.roster.values()].filter((e) => e.bot).length;
    const botRemotes = c.net.remotes.filter((r) => c.net.state.roster.get(r.id)?.bot).length;
    check(sees && bots >= 1 && botRemotes >= 1, `client ${c.i} sees both other clients and ${botRemotes} bot(s) in its interpolation buffer`);
  }
  let compared = 0, corr = 0, maxErr = 0, sumErr = 0;
  for (const c of clean) { const s = c.net.stats; compared += s.compared; corr += s.corrections; maxErr = Math.max(maxErr, s.maxError); sumErr += s.sumError; }
  console.log(`  prediction totals: ${compared} acked states compared, ${corr} corrections, max error ${fmt(maxErr)} m, avg ${fmt(sumErr / Math.max(1, compared), 6)} m`);
  check(compared > 500, 'reconciliation compared predicted vs authoritative state for hundreds of snapshots');
  check(corr / Math.max(1, compared) < 0.03, 'prediction matched the server bit-for-bit on >97% of acked states (clean link)');
  check(sumErr / Math.max(1, compared) < 0.01, 'average prediction error after reconciliation < 1 cm');
  const posCorr = clean.reduce((a, c) => a + (c.net.stats.corrPos ?? c.net.stats.corrections), 0);
  check(posCorr === 0, `clean link: prediction bit-exact, 0 corrections from position error (${posCorr})`);
  const QK = ['rttMs', 'jitterMs', 'interpDelayMs', 'timeScale', 'inputBufferTicks', 'corrections10s', 'starved10s'];
  check(clean.every((c) => c.net.state.quality && QK.every((k) => Number.isFinite(c.net.state.quality[k]))),
    'net.state.quality exposes rttMs, jitterMs, interpDelayMs, timeScale, inputBufferTicks, corrections10s, starved10s');
  check(clean.every((c) => c.local.maxStep < 0.6), 'rendered local position never jumps more than 0.6 m in a tick while alive (smoothed corrections)');
  check(clean.every((c) => c.cont.teleports === 0), 'remote interpolation is continuous while alive (no per-tick step > 1 m)');
  check(clean.every((c) => c.c.fired > 0 && c.net.stats.predictedShots > 0), 'every client fired predicted shots');
  check(clean.every((c) => c.c.slides > 0 && c.c.jumps > 0), 'every client jumped and slid (slide-hop input)');
  check(clean.every((c) => c.c.remoteShotEvents > 0), 'every client received other shooters\' tracers from snapshots');
  const totalKills = clean.reduce((s, c) => Math.max(s, c.c.kills), 0);
  const totalHits = clean.reduce((s, c) => s + c.c.hits, 0);
  const respawns = clean.reduce((s, c) => Math.max(s, c.c.respawns), 0);
  check(totalHits > 0, `hit confirmations reached the shooters (${totalHits})`);
  check(totalKills > 0, `kill events flowed (${totalKills} seen by one client)`);
  check(respawns > 0, `killed players respawned (${respawns} respawns after a kill seen by one client)`);
  check(clean.every((c) => c.net.pings > 3 && Number.isFinite(c.net.state.ping)), 'clock sync pings answered (ping measured)');
  const dc = await disconnect(clean, ROOM);
  check(clean.every((c) => c.net.state.status === 'closed' && c.c.closes.every((e) => !e.willRetry)), 'clean disconnect: sockets closed, no reconnect attempts');
  check(dc.roomGone, 'server destroyed the private room after all clients left');

  // ---------------- lag profiles
  for (const name of wanted) {
    const prof = PROFILES[name];
    if (!prof) { console.log(`unknown profile ${name}`); continue; }
    const room = `ct${name}${process.pid}`;
    const links = [];
    const r = await phase(`profile ${name} (${LAG_S}s): ${prof.rtt} ms RTT +- ${prof.jitter}, ${prof.stall * 100}% TCP stalls per message each way`,
      LAG_S, room, (i) => { const l = laggySocket(prof, 99 + i * 7 + prof.rtt); links.push(l); return l.factory; });
    for (const l of links) console.log(`  injected: up ${l.up.msgs} msgs / ${l.up.stalls} stalls (${fmt(l.up.stalledMs / 1000, 1)} s), down ${l.down.msgs} msgs / ${l.down.stalls} stalls (${fmt(l.down.stalledMs / 1000, 1)} s)`);
    const lc = r.clients;
    rows[name] = feel(lc, LAG_S, r.serverNet);
    console.log(`\nassertions (${name}):`);
    check(lc.every((c) => c.net.state.connected && c.net.state.ping > prof.rtt * 0.75), `${name}: clients stayed connected and measured the injected RTT`);
    check(lc.every((c) => c.net.stats.compared > 100), `${name}: reconciliation kept running`);
    check(lc.every((c) => c.local.maxStep < 1.0), `${name}: rendered local position stays smooth (no per-tick jump > 1 m)`);
    const f = rows[name];
    check(f.remoteTeleports / (3 * LAG_S) < 0.1, `${name}: remote players rarely jump (${f.remoteTeleports} per-tick steps > 1 m in ${3 * LAG_S} client-seconds)`);
    check(f.corrPosPerS < 0.5, `${name}: local corrections from position error < 0.5/s (${fmt(f.corrPosPerS, 2)}/s)`);
    check(f.extrapPct < 35, `${name}: remotes rendered from real snapshots (not extrapolated) > 65% of the time (${fmt(f.extrapPct, 1)}% extrapolated)`);
    check(f.timeScaleRange === null || (f.timeScaleRange[0] >= 0.97 - 1e-9 && f.timeScaleRange[1] <= 1.03 + 1e-9), `${name}: time dilation stayed within +-3%`);
    check(lc.every((c) => c.c.fired > 0), `${name}: clients kept firing`);
    const dc2 = await disconnect(lc, room);
    check(dc2.roomGone, `${name}: room destroyed after disconnect`);
  }
  table(rows);
  const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
  if (jsonOut) (await import('node:fs')).writeFileSync(jsonOut, JSON.stringify(rows, null, 1));

  killServer();
  await sleep(300);
  let stillUp = false;
  try { await fetch(`http://localhost:${PORT}/status`); stillUp = true; } catch { /* good */ }
  check(!stillUp, `server child stopped, nothing listening on ${PORT}`);

  console.log(failures.length ? `\nRESULT: ${failures.length} FAILED` : '\nRESULT: all client-core checks passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('client test crashed:', err);
  killServer();
  process.exit(1);
});
