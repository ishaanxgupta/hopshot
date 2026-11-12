// Hopshot server: static HTTP + WebSocket (/ws) on one port, room matchmaking, /status.
//
// Env:
//   PORT             listen port (default 3000)
//   HOST             listen address (default: all interfaces)
//   BOTS             keep at least this many participants per room using bots (default 4, 0 = off)
//   MAX_CONNECTIONS  total WebSocket connections accepted (default 1000)

import http from 'node:http';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { MAX_PLAYERS } from '../shared/constants.js';
import {
  PROTOCOL_VERSION, MSG, MAX_TEXT_BYTES, INPUT_MAX_BYTES, createInputPacket, decodeInput, decodeText,
  encodeText, sanitizeName, sanitizeRoomName, parseTeam,
} from '../shared/protocol.js';
import { Room, BOT_MIN } from './room.js';
import { Bot } from './bots.js';
import { MAPS } from '../shared/maps/index.js';
import { serveStatic } from './static.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || undefined;
const MAX_CONNECTIONS = parseInt(process.env.MAX_CONNECTIONS || '1000', 10);
const JOIN_TIMEOUT_MS = 10000;
const HEARTBEAT_MS = 10000;
const MAX_BAD_MESSAGES = 50;
// token buckets: input packets (60/s nominal, bursts after a hitch are fine) and text messages
const BIN_RATE = 120, BIN_BURST = 60;
const TEXT_RATE = 5, TEXT_BURST = 15;

const startedAt = Date.now();
const rooms = new Map();          // name -> Room
let autoRoomSeq = 0;
let connections = 0;

function log(...args) { console.log(new Date().toISOString(), ...args); }

/**
 * Private rooms start in the lobby; `bots` (from the creating join) is the initial
 * config.bots.fill (default BOT_MIN). Public rooms play at once and rotate maps / modes.
 */
function createRoom(name, isPrivate, bots) {
  const room = new Room(name, {
    isPrivate,
    botMin: BOT_MIN,
    config: isPrivate ? { bots: { fill: bots ?? BOT_MIN } } : undefined,
    onEmpty: (r) => {
      if (rooms.get(r.name) === r) rooms.delete(r.name);
      log(`room ${r.name} closed`);
    },
  });
  rooms.set(name, room);
  room.start();
  log(`room ${name} created`);
  return room;
}

/** Fullest public room with a free human slot, else a new one. */
function pickRoom(requested, botMin) {
  if (requested) {
    const existing = rooms.get(requested);
    if (existing && !existing.destroyed) return existing.hasFreeSlot() ? existing : null;
    return createRoom(requested, true, botMin);
  }
  let best = null;
  for (const r of rooms.values()) {
    if (r.isPrivate || r.destroyed || !r.hasFreeSlot()) continue;
    if (!best || r.humans > best.humans) best = r;
  }
  if (best) return best;
  let name;
  do { name = `r${++autoRoomSeq}`; } while (rooms.has(name));
  return createRoom(name, false);
}

function statusJson(reset) {
  const list = [];
  for (const r of rooms.values()) {
    list.push(r.status());
    if (reset) r.resetStats();
  }
  return {
    ok: true, protocol: PROTOCOL_VERSION, uptimeS: Math.round((Date.now() - startedAt) / 1000),
    connections, maxPlayersPerRoom: MAX_PLAYERS, botMin: BOT_MIN,
    totals: {
      rooms: list.length,
      players: list.reduce((s, r) => s + r.players, 0),
      humans: list.reduce((s, r) => s + r.humans, 0),
      bots: list.reduce((s, r) => s + r.bots, 0),
    },
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    rooms: list,
  };
}

// ------------------------------------------------------------------ HTTP

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname === '/health') {
      let humans = 0;
      for (const r of rooms.values()) humans += r.humans;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ ok: true, uptimeS: Math.round((Date.now() - startedAt) / 1000), rooms: rooms.size, humans }));
      return;
    }
    if (url.pathname === '/status') {
      const addr = req.socket.remoteAddress || '';
      const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
      const body = JSON.stringify(statusJson(local && url.searchParams.get('reset') === '1'));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    if (url.pathname === '/lan') {
      // LAN addresses, so a host playing on localhost can build an invite link that works for
      // friends on the same network. Only answered for requests from this machine.
      const addr = req.socket.remoteAddress || '';
      const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
      const addresses = [];
      if (local) {
        const ifs = os.networkInterfaces();
        for (const k of Object.keys(ifs)) {
          for (const a of ifs[k] || []) if (a.family === 'IPv4' && !a.internal) addresses.push(a.address);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ addresses, port: PORT }));
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('http handler error:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// ------------------------------------------------------------------ WebSocket

const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: Math.max(MAX_TEXT_BYTES, INPUT_MAX_BYTES) * 2, perMessageDeflate: false,
  clientTracking: true,
});

function bucket(rate, burst) { return { tokens: burst, rate, burst, at: performance.now() }; }
function take(b) {
  const now = performance.now();
  b.tokens = Math.min(b.burst, b.tokens + (now - b.at) * b.rate / 1000);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

wss.on('connection', (ws, req) => {
  if (connections >= MAX_CONNECTIONS) {
    ws.close(1013, 'server full');
    return;
  }
  connections++;
  const conn = {
    ws, room: null, player: null, bad: 0, alive: true,
    bin: bucket(BIN_RATE, BIN_BURST), text: bucket(TEXT_RATE, TEXT_BURST),
    pkt: createInputPacket(),
  };
  const joinTimer = setTimeout(() => { if (!conn.player) ws.close(1008, 'join timeout'); }, JOIN_TIMEOUT_MS);

  const misbehave = () => {
    if (++conn.bad > MAX_BAD_MESSAGES) ws.close(1008, 'too many bad messages');
  };

  ws.on('pong', () => { conn.alive = true; });
  ws.on('error', () => {});
  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) {
        if (!conn.player || !take(conn.bin)) return;
        if (data.length === 0 || data[0] !== MSG.INPUT) { misbehave(); return; }
        const pkt = decodeInput(data, conn.pkt);
        if (!pkt) { misbehave(); return; }
        if (!conn.player.removed) conn.room.ingestInput(conn.player, pkt);
        return;
      }
      if (!take(conn.text)) return;
      const msg = decodeText(data);
      if (!msg) { misbehave(); return; }
      handleText(conn, msg);
    } catch (err) {
      console.error('message handler error:', err);
      misbehave();
    }
  });
  ws.on('close', () => {
    clearTimeout(joinTimer);
    connections--;
    try {
      if (conn.player && conn.room && !conn.player.removed) {
        log(`leave ${conn.player.name}#${conn.player.id} room ${conn.room.name}`);
        conn.room.removePlayer(conn.player);
      }
    } catch (err) {
      console.error('close handler error:', err);
    }
    conn.player = null;
  });
  ws._conn = conn;
});

function handleText(conn, msg) {
  const ws = conn.ws;
  switch (msg.t) {
    case 'join': {
      if (conn.player) return;
      if (msg.v !== undefined && msg.v !== PROTOCOL_VERSION) {
        ws.send(encodeText({ t: 'error', code: 'bad_version', message: `server speaks protocol ${PROTOCOL_VERSION}` }));
        ws.close(1008, 'bad version');
        return;
      }
      const name = sanitizeName(msg.name);
      const roomName = sanitizeRoomName(msg.room);
      const wantBots = Number.isFinite(msg.bots) ? Math.max(0, Math.min(MAX_PLAYERS, msg.bots | 0)) : undefined;
      const room = pickRoom(roomName, wantBots);
      if (!room) {
        ws.send(encodeText({ t: 'error', code: 'room_full', message: 'that room is full' }));
        ws.close(1008, 'room full');
        return;
      }
      const p = room.addHuman(ws, name, msg.lo);
      if (!p) {
        ws.send(encodeText({ t: 'error', code: 'room_full', message: 'room is full' }));
        ws.close(1008, 'room full');
        return;
      }
      conn.room = room;
      conn.player = p;
      log(`join ${name}#${p.id} room ${room.name} (${room.humans} humans, ${room.botCount} bots)`);
      return;
    }
    case 'loadout': {
      // pending loadout (weapons.encodeLoadout code); applied at the player's next spawn
      if (!conn.player || conn.player.removed || !Number.isInteger(msg.lo)) { conn.bad++; return; }
      conn.room.setLoadout(conn.player, msg.lo);
      return;
    }
    case 'config': case 'start': case 'team': case 'lobby': {
      // (v4) lobby / match control; every request is validated by the room (host, phase, values)
      if (!conn.player || conn.player.removed) { conn.bad++; return; }
      const room = conn.room, p = conn.player;
      let err;
      if (msg.t === 'config') err = room.requestConfig(p, msg.cfg);
      else if (msg.t === 'start') err = room.requestStart(p);
      else if (msg.t === 'team') { const team = parseTeam(msg.team); err = team ? room.requestTeam(p, team) : 'bad_team'; }
      else err = room.requestLobby(p);
      if (err) {
        conn.bad++;
        if (ws.readyState === 1) ws.send(encodeText({ t: 'error', code: err, message: `${msg.t}: ${err.replace('_', ' ')}`, req: msg.t }));
      }
      return;
    }
    case 'ping': {
      if (!conn.player || typeof msg.c !== 'number' || !Number.isFinite(msg.c)) { conn.bad++; return; }
      if (typeof msg.rtt === 'number' && Number.isFinite(msg.rtt)) {
        conn.player.ping = Math.max(0, Math.min(9999, Math.round(msg.rtt)));
      }
      if (ws.readyState === 1) ws.send(encodeText({ t: 'pong', c: msg.c, tick: conn.room.currentTick() }));
      return;
    }
    default:
      conn.bad++;
  }
}

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const conn = ws._conn;
    if (!conn) continue;
    if (!conn.alive) { ws.terminate(); continue; }
    conn.alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }
}, HEARTBEAT_MS);

// ------------------------------------------------------------------ process

process.on('uncaughtException', (err) => { console.error('uncaught exception (server stays up):', err); });
process.on('unhandledRejection', (err) => { console.error('unhandled rejection (server stays up):', err); });

function shutdown() {
  log('shutting down');
  clearInterval(heartbeat);
  for (const r of rooms.values()) r.destroy();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  log(`Hopshot server on http://${HOST || 'localhost'}:${PORT}  (ws path /ws, bots min ${BOT_MIN})`);
  // bot navigation for every map, built in small chunks so the first match never stalls a tick
  const t0 = performance.now();
  Bot.prewarm(MAPS).then(() => log(`bot navigation ready for ${MAPS.length} maps (${Math.round(performance.now() - t0)} ms)`));
});
