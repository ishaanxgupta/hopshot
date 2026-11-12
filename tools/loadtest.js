#!/usr/bin/env node
// Hopshot load test: N headless WebSocket clients sending realistic 60 Hz input.
//
//   node tools/loadtest.js [--clients 20] [--duration 20] [--warmup 3] [--port 3101]
//                          [--host localhost] [--room name] [--spawn]
//                          [--mode ffa|tdm|ctf|hardpoint --room name [--map id] [--bots 20]]
//
//   --mode    (protocol v4) the first client hosts a private match in --room: config
//             { mode, mapId, bots: { fill } } + start, then everyone plays it (bots fill the
//             room up to --bots participants, split evenly into teams in team modes)
//   --spawn   start `node server/index.js` on --port for the run (killed afterwards)
//
// Prints server tick time p50/p95/p99/max per room (from /status, measured after warm-up),
// bytes/s per client down and up (payload and estimated on-the-wire), decode errors, and
// whether any tick overran 16.6 ms.

import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { BTN, TICK_RATE, INTERP_DELAY_MS } from '../shared/constants.js';
import {
  encodeInput, encodeJoin, encodePing, decodeSnapshot, decodeText, createSnapshot, createCmd, sanitizeCmd,
  INPUT_REDUNDANCY, encodeMatchConfig, encodeStart,
} from '../shared/protocol.js';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const CLIENTS = parseInt(opt('clients', '20'), 10);
const DURATION = parseFloat(opt('duration', '20'));
const WARMUP = parseFloat(opt('warmup', '3'));
const PORT = parseInt(opt('port', process.env.PORT || '3101'), 10);
const HOST = opt('host', 'localhost');
const ROOM = opt('room', '');
const SPAWN = opt('spawn', false) === true;
// (v4) --mode ffa|tdm|ctf|hardpoint [--map id] [--bots fill]: host a private match in --room
const MODE = typeof opt('mode', '') === 'string' ? opt('mode', '') : '';
const MAP_ID = typeof opt('map', '') === 'string' ? opt('map', '') : '';
const BOTS_FILL = parseInt(opt('bots', '20'), 10);
// --url https://host targets a remote (TLS) server instead of --host/--port.
const URL_OPT = opt('url', '');
const BASE_HTTP = typeof URL_OPT === 'string' && URL_OPT ? URL_OPT.replace(/\/+$/, '') : `http://${HOST}:${PORT}`;
const BASE_WS = BASE_HTTP.replace(/^http/, 'ws');
const TICK_MS = 1000 / TICK_RATE;
const INTERP_TICKS = INTERP_DELAY_MS / TICK_MS;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

// ws frame header estimates: server->client unmasked, client->server masked (+4)
const wireDown = (n) => n + (n < 126 ? 2 : n < 65536 ? 4 : 10);
const wireUp = (n) => n + (n < 126 ? 6 : n < 65536 ? 8 : 14);

let serverProc = null;
async function startServer() {
  serverProc = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  serverProc.stdout.on('data', () => {});
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE_HTTP}/status`); if (r.ok) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}
function stopServer() {
  if (serverProc && serverProc.exitCode === null) serverProc.kill('SIGTERM');
}

class Client {
  constructor(i) {
    this.i = i;
    this.ws = null;
    this.id = 0;
    this.room = '';
    this.seq = 1 + Math.floor(Math.random() * 1000);
    this.hist = [];                  // last INPUT_REDUNDANCY cmds (sanitised)
    this.snap = createSnapshot();
    this.lastSnapTick = -1;
    this.lastSnapAt = 0;
    this.yaw = rnd(-Math.PI, Math.PI);
    this.pitch = 0;
    this.yawVel = 0;
    this.buttons = BTN.FORWARD;
    this.nextChange = 0;
    this.weapon = 0;
    this.firing = false;
    this.rtt = NaN;
    this.stats = { downBytes: 0, downWire: 0, upBytes: 0, upWire: 0, snaps: 0, badSnaps: 0, events: 0, ackLagMax: 0 };
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${BASE_WS}/ws`, { perMessageDeflate: false });
      this.ws = ws;
      ws.binaryType = 'nodebuffer';
      ws.on('open', () => { this.send(encodeJoin(`load${this.i}`, ROOM || undefined)); });
      ws.on('message', (data, isBinary) => {
        this.stats.downBytes += data.length;
        this.stats.downWire += wireDown(data.length);
        if (isBinary) {
          const s = decodeSnapshot(data, this.snap);
          if (!s) { this.stats.badSnaps++; return; }
          this.stats.snaps++;
          this.lastSnapTick = s.tick;
          this.lastSnapAt = performance.now();
          if (s.ackSeq >= 0) this.stats.ackLagMax = Math.max(this.stats.ackLagMax, this.seq - 1 - s.ackSeq);
          return;
        }
        const m = decodeText(data.toString(), 1 << 20);
        if (!m) return;
        this.stats.events++;
        if (m.t === 'welcome') { this.id = m.id; this.room = m.room; this.phase = m.match && m.match.phase; this.lastSnapTick = m.tick; this.lastSnapAt = performance.now(); resolve(); }
        else if (m.t === 'pong') this.rtt = performance.now() - m.c;
        else if (m.t === 'match') this.phase = m.phase;
        else if (m.t === 'spawn' && m.id === this.id) this.yaw = m.yaw;
        else if (m.t === 'error') reject(new Error(m.message));
      });
      ws.on('error', reject);
      ws.on('close', () => { this.closed = true; });
    });
  }

  send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const n = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    this.stats.upBytes += n;
    this.stats.upWire += wireUp(n);
    this.ws.send(data);
  }

  renderTick() {
    // naive clock estimate: newest snapshot tick + time since it arrived, minus the interp delay
    return this.lastSnapTick + (performance.now() - this.lastSnapAt) / TICK_MS - INTERP_TICKS;
  }

  tick(now) {
    if (now >= this.nextChange) {
      // pick a new "intent" like a human would: run in some direction, sometimes jump/crouch
      let b = 0;
      const r = Math.random();
      b |= r < 0.7 ? BTN.FORWARD : r < 0.8 ? BTN.BACK : 0;
      const s = Math.random();
      b |= s < 0.3 ? BTN.LEFT : s < 0.6 ? BTN.RIGHT : 0;
      if (Math.random() < 0.3) b |= BTN.JUMP;
      if (Math.random() < 0.15) b |= BTN.CROUCH;
      if (Math.random() < 0.2) b |= BTN.ADS;
      this.buttons = b;
      this.firing = Math.random() < 0.35;
      if (Math.random() < 0.1) this.weapon = Math.floor(Math.random() * 3);
      this.yawVel = rnd(-3, 3);
      this.nextChange = now + rnd(300, 1500);
    }
    this.yaw += this.yawVel / TICK_RATE + rnd(-0.01, 0.01);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2; else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    this.pitch = Math.max(-0.6, Math.min(0.6, this.pitch + rnd(-0.02, 0.02)));
    let buttons = this.buttons;
    if (this.firing) buttons |= BTN.FIRE;
    if (Math.random() < 0.002) buttons |= BTN.RELOAD;
    const cmd = sanitizeCmd({ seq: this.seq++, buttons, yaw: this.yaw, pitch: this.pitch, weapon: this.weapon });
    this.hist.push(cmd);
    if (this.hist.length > INPUT_REDUNDANCY) this.hist.shift();
    this.send(encodeInput(this.hist, this.renderTick()));
  }
}

function fmtRoom(r) {
  const t = r.tickMs;
  return `  room ${r.name}: ${r.players} players (${r.humans} humans, ${r.bots} bots), ${t.samples} ticks sampled\n` +
    `    tick ms  avg ${t.avg}  p50 ${t.p50}  p95 ${t.p95}  p99 ${t.p99}  max ${t.max}\n` +
    `    overruns(>16.6ms) ${r.overruns}  catch-up drops ${r.catchUpDrops}  snapshots skipped ${r.snapshotsSkipped}` +
    `  cmds dropped ${r.cmdsDropped}  server out ${(r.bytesOutPerSec / 1024).toFixed(1)} kB/s`;
}

async function main() {
  if (SPAWN) await startServer();
  console.log(`load test: ${CLIENTS} clients -> ${BASE_WS}/ws, ${DURATION}s (+${WARMUP}s warm-up)`);
  const clients = [];
  for (let i = 0; i < CLIENTS; i++) {
    const c = new Client(i);
    clients.push(c);
    await c.connect();
    await sleep(10);
  }
  const rooms = {};
  for (const c of clients) rooms[c.room] = (rooms[c.room] || 0) + 1;
  console.log(`connected; room split: ${JSON.stringify(rooms)}`);
  if (MODE) {
    // (protocol v4) a named room starts in the lobby: client 0 is host, configures and starts
    if (!ROOM) throw new Error('--mode needs --room');
    const cfg = { mode: MODE, bots: { fill: BOTS_FILL }, timeLimitS: 3600, scoreLimit: 1000 };
    if (MAP_ID) cfg.mapId = MAP_ID;
    clients[0].send(encodeMatchConfig(cfg));
    await sleep(200);
    clients[0].send(encodeStart());
    for (let i = 0; i < 100 && clients[0].phase !== 'playing'; i++) await sleep(50);
    console.log(`match: ${MODE} on ${MAP_ID || '(room default map)'}, bots fill ${BOTS_FILL}, phase ${clients[0].phase}`);
  }

  // 60 Hz input driven by an accumulator (each client sends exactly one packet per tick on average)
  const t0 = performance.now();
  let sent = 0;
  const pump = setInterval(() => {
    const now = performance.now();
    const due = Math.floor((now - t0) / TICK_MS);
    let guard = 0;
    while (sent < due && guard++ < 10) {
      for (const c of clients) c.tick(now);
      sent++;
    }
    if (sent < due) sent = due; // never burst more than 10 ticks after a stall
  }, 4);
  const pinger = setInterval(() => {
    for (const c of clients) c.send(encodePing(performance.now(), c.rtt));
  }, 1000);

  await sleep(WARMUP * 1000);
  await fetch(`${BASE_HTTP}/status?reset=1`).then((r) => r.json());
  for (const c of clients) for (const k of Object.keys(c.stats)) c.stats[k] = 0;
  const m0 = performance.now();
  await sleep(DURATION * 1000);
  const secs = (performance.now() - m0) / 1000;
  const status = await fetch(`${BASE_HTTP}/status`).then((r) => r.json());

  clearInterval(pump);
  clearInterval(pinger);

  const sum = (k) => clients.reduce((s, c) => s + c.stats[k], 0);
  const max = (k) => clients.reduce((s, c) => Math.max(s, c.stats[k]), 0);
  const per = (k) => (sum(k) / clients.length / secs / 1024).toFixed(2);
  const rtts = clients.map((c) => c.rtt).filter(Number.isFinite);
  console.log(`\nmeasured over ${secs.toFixed(1)} s`);
  console.log(`per client down: ${per('downBytes')} kB/s payload, ${per('downWire')} kB/s on the wire`);
  console.log(`per client up:   ${per('upBytes')} kB/s payload, ${per('upWire')} kB/s on the wire`);
  console.log(`snapshots/s per client: ${(sum('snaps') / clients.length / secs).toFixed(1)}, bad snapshots: ${sum('badSnaps')}, ` +
    `events: ${sum('events')}, max ack lag ${max('ackLagMax')} cmds, avg rtt ${rtts.length ? (rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(1) : '?'} ms`);
  console.log(`server: ${status.totals.rooms} rooms, ${status.totals.players} players, rss ${status.memoryMB} MB`);
  let overran = false;
  for (const r of status.rooms) {
    console.log(fmtRoom(r));
    if (r.overruns > 0) overran = true;
  }
  console.log(overran ? 'RESULT: at least one tick overran 16.6 ms' : 'RESULT: no tick overran 16.6 ms');

  for (const c of clients) c.ws.close();
  await sleep(200);
  stopServer();
  process.exit(0);
}

main().catch((err) => {
  console.error('load test failed:', err);
  stopServer();
  process.exit(1);
});
process.on('SIGINT', () => { stopServer(); process.exit(130); });
