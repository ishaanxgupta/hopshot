#!/usr/bin/env node
// Headless end-to-end test of the client core (client/net.js + the autopilot from client/input.js)
// against the real server.
//
//   node tools/client.test.js [--clean 20] [--lag 10] [--lat 40] [--jit 10] [--loss 0.02]
//   (--lat/--jit are ONE-WAY ms applied in each direction; the default is ~80 +- 20 ms RTT)
//
// 1. Starts `node server/index.js` on port 3103 (private room) as a child process.
// 2. Clean run: 3 headless clients built on createNet(), driven by createAutopilot() (wander,
//    slide-hop, aim + fire at the nearest visible enemy) through a 60 Hz accumulator, exactly
//    like client/main.js. Asserts prediction stays exact after reconciliation, remote
//    interpolation is continuous while alive, clients see each other and bots, shots / kills /
//    respawns flow, and a clean disconnect leaves the server with no room.
// 3. Lag run: same with artificial latency + jitter + loss injected in the client's socket
//    (send and receive), reporting the correction statistics.
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

const PORT = 3103;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? parseFloat(args[i + 1]) : d; };
const CLEAN_S = opt('clean', 20);
const LAG_S = opt('lag', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const world = createWorld(MAP);

// ------------------------------------------------------------------ server child
let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), BOTS: '4' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/status`); if (r.ok) return; } catch { /* not yet */ }
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

// ------------------------------------------------------------------ lossy / laggy socket
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
 * WebSocket wrapper adding one-way latency +- jitter in both directions (order preserved, as
 * on a real TCP stream) and dropping a fraction of BINARY frames (inputs / snapshots), which is
 * how a lossy link looks to the game: lost inputs are covered by redundancy, lost snapshots by
 * interpolation.
 */
function laggySocket({ latency, jitter, loss, seed }) {
  const rnd = prng(seed);
  const counts = { upDropped: 0, downDropped: 0, up: 0, down: 0 };
  const factory = (url) => {
    const real = new WebSocket(url);
    real.binaryType = 'arraybuffer';
    let lastUp = 0, lastDown = 0;
    const delay = (last) => {
      const t = performance.now();
      const at = Math.max(last, t + latency + (rnd() * 2 - 1) * jitter);
      return at;
    };
    const fake = {
      binaryType: 'arraybuffer', onopen: null, onmessage: null, onclose: null, onerror: null,
      get readyState() { return real.readyState; },
      send(d) {
        counts.up++;
        if (typeof d !== 'string' && rnd() < loss) { counts.upDropped++; return; }
        lastUp = delay(lastUp);
        setTimeout(() => { if (real.readyState === 1) real.send(d); }, lastUp - performance.now());
      },
      close(code, reason) { real.close(code, reason); },
    };
    real.onopen = (e) => setTimeout(() => fake.onopen && fake.onopen(e), latency);
    real.onmessage = (e) => {
      counts.down++;
      if (typeof e.data !== 'string' && rnd() < loss) { counts.downDropped++; return; }
      lastDown = delay(lastDown);
      const data = e.data;
      setTimeout(() => fake.onmessage && fake.onmessage({ data }), lastDown - performance.now());
    };
    real.onerror = (e) => fake.onerror && fake.onerror(e);
    real.onclose = (e) => setTimeout(() => fake.onclose && fake.onclose({ code: e.code, reason: e.reason }), Math.max(0, lastDown - performance.now()) + 1);
    return fake;
  };
  return { factory, counts };
}

// ------------------------------------------------------------------ headless client
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
    this.cont = { samples: 0, maxStep: 0, teleports: 0, worst: null };
    this.local = { maxStep: 0, steps: 0, last: null, view: {} };
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
    if (v.alive && this.local.last) {
      const d = Math.hypot(v.x - this.local.last[0], v.y - this.local.last[1], v.z - this.local.last[2]);
      this.local.steps++;
      if (d > this.local.maxStep) this.local.maxStep = d;
    }
    this.local.last = v.alive ? [v.x, v.y, v.z] : null;
  }

  checkRemotes() {
    const seen = new Set();
    for (const r of this.players) {
      seen.add(r.id);
      const prev = this.prevRemote.get(r.id);
      if (prev && prev.alive && r.alive && prev.life === r.life) {
        const d = Math.hypot(r.x - prev.x, r.y - prev.y, r.z - prev.z);
        this.cont.samples++;
        if (d > this.cont.maxStep) this.cont.maxStep = d;
        if (d > 1.0) { this.cont.teleports++; if (!this.cont.worst) this.cont.worst = { id: r.id, d, from: [prev.x, prev.y, prev.z], to: [r.x, r.y, r.z] }; }
      }
      if (prev) { prev.x = r.x; prev.y = r.y; prev.z = r.z; prev.alive = r.alive; prev.life = r.life; }
      else this.prevRemote.set(r.id, { x: r.x, y: r.y, z: r.z, alive: r.alive, life: r.life });
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

async function phase(label, secs, room, makeSocket) {
  const clients = [0, 1, 2].map((i) => new Client(i, room, makeSocket ? makeSocket(i) : undefined));
  for (const c of clients) await c.connect();
  await run(clients, secs);
  report(label, clients);
  return clients;
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

  // ---------------- clean run
  const clean = await phase(`clean local run (${CLEAN_S}s, 3 clients + bots, room ${ROOM})`, CLEAN_S, ROOM, null);
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

  // ---------------- lag run
  const LAT = opt('lat', 40), JIT = opt('jit', 10), LOSS = opt('loss', 0.02);   // one-way, each direction
  const ROOM2 = `ctestlag${process.pid}`;
  const lags = [];
  const lagClients = await phase(`lag run (${LAG_S}s, ${LAT} +- ${JIT} ms each way = ~${2 * LAT} +- ${2 * JIT} ms RTT, ${LOSS * 100}% binary loss each way)`,
    LAG_S, ROOM2, (i) => { const l = laggySocket({ latency: LAT, jitter: JIT, loss: LOSS, seed: 99 + i }); lags.push(l); return l.factory; });
  for (const l of lags) console.log(`  injected: up ${l.counts.up} sent / ${l.counts.upDropped} dropped, down ${l.counts.down} recv / ${l.counts.downDropped} dropped`);
  console.log('\nassertions (lag):');
  let lc = 0, lcorr = 0, lmax = 0, lsum = 0;
  for (const c of lagClients) { const s = c.net.stats; lc += s.compared; lcorr += s.corrections; lmax = Math.max(lmax, s.maxError); lsum += s.sumError; }
  console.log(`  prediction totals: ${lc} compared, ${lcorr} corrections (${fmt(100 * lcorr / Math.max(1, lc), 2)}%), max error ${fmt(lmax)} m, avg ${fmt(lsum / Math.max(1, lc), 6)} m`);
  check(lagClients.every((c) => c.net.state.connected && c.net.state.ping > LAT * 1.5), 'clients stayed connected and measured the injected RTT');
  check(lc > 200, 'reconciliation kept running under lag + loss');
  check(lagClients.every((c) => c.local.maxStep < 1.0), 'rendered local position stays smooth under lag (no per-tick jump > 1 m)');
  check(lagClients.every((c) => c.cont.teleports === 0), 'remote interpolation stays continuous under lag + loss');
  check(lagClients.every((c) => c.c.fired > 0), 'clients kept firing under lag');
  const dc2 = await disconnect(lagClients, ROOM2);
  check(dc2.roomGone, 'lag room destroyed after disconnect');

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
