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

import { INTERP_DELAY_MS, BTN, PLAYER } from '../shared/constants.js';
import {
  WEAPONS, createWeaponState, copyWeaponState, resetWeaponState, stepWeapon, shotSpread, shotDir,
} from '../shared/weapons.js';
import {
  MOVE, createPlayerState, copyState, spawnState, stepPlayer, eyeHeight, hitboxHeight, raycastWorld,
  raycastPlayer,
} from '../shared/physics.js';
import {
  TICK_MS, SHOT, INPUT_REDUNDANCY, createCmd, sanitizeCmd, encodeInput, encodeJoin, encodePing,
  decodeSnapshot, decodeText, createSnapshot,
} from '../shared/protocol.js';

const RING = 256;                          // prediction history (power of two, ~4.3 s)
const RING_MASK = RING - 1;
const INTERP_TICKS = INTERP_DELAY_MS / TICK_MS;
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
function sameWeapon(a, b) {
  return a.weapon === b.weapon && a.cooldown === b.cooldown && a.reload === b.reload &&
    a.fireHeld === b.fireHeld && a.ammo[0] === b.ammo[0] && a.ammo[1] === b.ammo[1] && a.ammo[2] === b.ammo[2];
}

function createSample() {
  return { tick: 0, life: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: false, crouching: false, sliding: false,
    onGround: false, ads: false, reloading: false, weapon: 0, health: 0 };
}

function createRemote(id) {
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) samples.push(createSample());
  return {
    id, samples, head: 0, count: 0, life: 0, pendingTeleport: true, lastSeenTick: 0,
    out: { id, name: '', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, crouching: false, sliding: false, alive: false,
      onGround: false, ads: false, reloading: false, weapon: 0, health: 0, life: 0, bot: false },
  };
}

/** Sample k back from the newest (0 = newest). */
function sampleAt(r, k) { return r.samples[(r.head - 1 - k + SAMPLES * 2) % SAMPLES]; }

function copySampleTo(o, s) {
  o.x = s.x; o.y = s.y; o.z = s.z; o.yaw = s.yaw; o.pitch = s.pitch; o.alive = s.alive;
  o.crouching = s.crouching; o.sliding = s.sliding; o.onGround = s.onGround; o.ads = s.ads;
  o.reloading = s.reloading; o.weapon = s.weapon; o.health = s.health; o.life = s.life;
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
  const world = opts.world;
  if (!world) throw new Error('createNet: opts.world is required');
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
    roster: new Map(),           // id -> { id, name, bot, kills, deaths, ping }
    round: { phase: 'playing', endsTick: 0, winner: 0 },
    rtt: NaN, ping: NaN,
    reconnectAttempt: 0, reconnectAt: 0,
    lastError: null,
  };

  const stats = {
    snapshots: 0, compared: 0, corrections: 0, maxError: 0, sumError: 0, lastError: 0,
    replays: 0, replayedCmds: 0, maxReplay: 0, snaps: 0, maxVisualError: 0,
    cmdsSent: 0, packetsSent: 0, bytesUp: 0, bytesDown: 0, remoteShots: 0, predictedShots: 0,
    connects: 0,
  };

  // prediction
  const pred = createPlayerState();
  const predW = createWeaponState();
  const before = createPlayerState();
  const beforeW = createWeaponState();
  const server = createPlayerState();    // last authoritative self state (at ackSeq)
  const serverW = createWeaponState();
  const ring = [];
  for (let i = 0; i < RING; i++) ring.push({ seq: -1, cmd: createCmd(), state: createPlayerState(), ws: createWeaponState(), valid: false });
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

  // connection
  let ws = null;
  let wantConnected = false;
  let reconnectTimer = null, pingTimer = null, watchdog = null;
  let pingCount = 0, lastMsgAt = 0;
  const snap = createSnapshot();

  // per-tick side effects (reused object, valid until the next tick() call)
  const fx = {
    seq: 0, alive: false, fired: false, weapon: 0, shotCount: 0,
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
      sendText(encodeJoin(st.name, st.room || undefined, st.bots));
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
  }

  function rosterEntry(p) {
    return { id: p.id | 0, name: String(p.name || ''), bot: !!p.bot, kills: p.kills | 0, deaths: p.deaths | 0, ping: p.ping | 0 };
  }

  function applyRows(rows) {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      const e = st.roster.get(r.id);
      if (!e) continue;
      e.kills = r.kills | 0; e.deaths = r.deaths | 0; e.ping = r.ping | 0;
    }
  }

  function onText(m) {
    switch (m.t) {
      case 'welcome': {
        resetGame();
        st.connected = true;
        st.id = m.id | 0;
        st.roomName = String(m.room || '');
        st.mapName = String(m.map || '');
        for (const p of m.players || []) st.roster.set(p.id, rosterEntry(p));
        if (m.round) { st.round.phase = m.round.phase; st.round.endsTick = m.round.endsTick; st.round.winner = 0; }
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
        return;
      }
      case 'pong': onPong(m); return;
      case 'join': {
        if (m.player) st.roster.set(m.player.id, rosterEntry(m.player));
        emit('join', m);
        return;
      }
      case 'leave': {
        st.roster.delete(m.id);
        removeRemote(m.id);
        emit('leave', m);
        return;
      }
      case 'kill': {
        const k = st.roster.get(m.killer), v = st.roster.get(m.victim);
        if (v) v.deaths++;
        if (k && m.killer !== m.victim && st.round.phase === 'playing') k.kills++;
        if (m.victim === st.id) st.alive = false;
        emit('kill', m);
        return;
      }
      case 'spawn': {
        if (m.id === st.id) {
          spawnState(pred, +m.x || 0, +m.y || 0, +m.z || 0);
          resetWeaponState(predW);
          for (const e of ring) e.valid = false;
          st.alive = true;
          st.health = 100;
          teleportPending = true;
          snapView();
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
        if (m.phase === 'playing') for (const e of st.roster.values()) { e.kills = 0; e.deaths = 0; }
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
  function renderTick(t = now()) { return serverTick(t) - INTERP_TICKS; }

  // ------------------------------------------------------------------ snapshots
  function onSnapshot(data) {
    const s = decodeSnapshot(data, snap);
    if (!s || !st.connected) return;
    if (s.tick <= st.lastSnapTick) return;
    st.lastSnapTick = s.tick;
    stats.snapshots++;
    const you = s.you;
    if (!st.id) st.id = you.id;
    st.health = you.health;
    st.respawnAtTick = s.tick + you.respawnTicks;
    copyState(server, you.state);
    copyWeaponState(serverW, you.weapon);
    if (s.ackSeq >= 0) st.ackSeq = s.ackSeq;

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
        if (sameState(e.state, server) && sameWeapon(e.ws, serverW)) return;  // prediction was exact
        stats.corrections++;
      }
      // rewind to the authoritative state and replay everything the server has not seen yet
      copyState(pred, server);
      copyWeaponState(predW, serverW);
      if (e.seq === ack) { copyState(e.state, server); copyWeaponState(e.ws, serverW); e.valid = true; }
      let n = 0;
      for (let seq = ack + 1; seq <= last; seq++) {
        const r = ring[seq & RING_MASK];
        if (r.seq !== seq) break;
        stepPlayer(pred, r.cmd, world);
        stepWeapon(predW, r.cmd);
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
    s.reloading = p.reloading; s.weapon = p.weapon; s.health = p.health;
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
      const e = st.roster.get(r.id);
      o.name = e ? e.name : '';
      o.bot = e ? e.bot : false;
      if (out) out.push(o);
    }
    return out;
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
    if (!Number.isFinite(rt)) rt = renderTick();
    const seq = nextSeq++;
    st.lastSeq = seq;
    const e = ring[seq & RING_MASK];
    e.seq = seq;
    const c = e.cmd;
    c.seq = seq; c.buttons = input.buttons | 0; c.yaw = +input.yaw || 0; c.pitch = +input.pitch || 0; c.weapon = input.weapon | 0;
    if (sanitizeCmd(c) === null) { c.yaw = 0; c.pitch = 0; sanitizeCmd(c); }

    // render interpolation base
    prevView.x = pred.x; prevView.y = pred.y; prevView.z = pred.z; prevView.eye = eyeHeight(pred);

    fx.seq = seq; fx.alive = st.alive; fx.fired = false; fx.shotCount = 0; fx.jumped = false; fx.landed = false;
    fx.landSpeed = 0; fx.slideStart = false; fx.slideBoost = false; fx.reloadStart = false; fx.switched = false; fx.empty = false; fx.groundMove = 0;

    if (st.alive) {
      copyState(before, pred);
      copyWeaponState(beforeW, predW);
      stepPlayer(pred, c, world);
      const fired = stepWeapon(predW, c);
      copyState(e.state, pred); copyWeaponState(e.ws, predW); e.valid = true;
      collectFx(c, fired);
    } else {
      e.valid = false;
    }

    // send newest cmds (redundancy covers packet loss)
    if (sendList.length >= INPUT_REDUNDANCY) sendList.shift();
    sendList.push(c);
    const pkt = encodeInput(sendList, rt);
    if (pkt) {
      ws.send(pkt);
      stats.packetsSent++; stats.cmdsSent++; stats.bytesUp += pkt.byteLength;
    }
    return fx;
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
    const def = WEAPONS[w];
    fx.fired = true; fx.weapon = w;
    stats.predictedShots++;
    const ox = a.x, oy = a.y + eyeHeight(a), oz = a.z;
    const spread = shotSpread(w, c.buttons);
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
    out.reloading = predW.reload > 0;
    return out;
  }

  const api = {
    on, off, connect, close, retryNow,
    tick, sampleRemotes, remoteEye, decayError, localView,
    serverTick, renderTick,
    get state() { return st; },
    get stats() { return stats; },
    get pred() { return pred; },
    get predWeapon() { return predW; },
    get serverState() { return server; },
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
