#!/usr/bin/env node
// Voice relay (protocol.js VOICE RELAY): the server path, against the real server.
//
//   node tools/voice-relay.test.js [--port 3114]
//
// Starts `node server/index.js` on the port as a child process (HOPSHOT_DOTENV=0) and checks, with
// plain WebSocket clients (no browser):
//   - the wire helpers round-trip; malformed frames / diagnostics are rejected
//   - welcome.voiceRelay only in private rooms; the relay capability travels in 'voice' + roster
//   - a frame reaches its target with the sender id the SERVER knows; never to yourself, to
//     another room, to bots, in a public room; duplicate targets get one copy
//   - size cap and the frames/s + bytes/s buckets drop (silently, counted) while a normal
//     50 frames/s stream passes untouched; input packets still work next to voice
//   - 'vstat' is logged once per pair transition, with candidate types only (no addresses), and
//     a voice summary is logged when the room closes
// The server child is always killed.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION, MSG, VOICE_RELAY_VERSION, VOICE_MAX_PAYLOAD, VOICE_IN_MAX_BYTES, VOICE_MAX_TARGETS,
  encodeJoin, encodeVoiceState, encodeVoiceFrame, decodeVoiceFrame, encodeVoiceRelay, decodeVoiceRelay,
  encodeVoiceStat, sanitizeVoiceStat, encodeInput, createCmd,
} from '../shared/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const PORT = args.includes('--port') ? parseInt(args[args.indexOf('--port') + 1], 10) : 3114;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null, serverOut = '';
async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, HOPSHOT_DOTENV: '0', MEMORY_ENABLED: '0', PORT: String(PORT), BOTS: '4', COUNTDOWN_MS: '300' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverOut += String(d); });
  let inUse = false;
  server.stderr.on('data', (d) => { if (/EADDRINUSE/.test(String(d))) inUse = true; process.stderr.write(`[server] ${d}`); });
  for (let i = 0; i < 100; i++) {
    if (inUse || server.exitCode !== null) throw new Error(`server could not listen on ${PORT}`);
    try { const r = await fetch(`http://localhost:${PORT}/status`); if (r.ok) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}
function killServer() { if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); }
process.on('exit', killServer);
process.on('SIGINT', () => { killServer(); process.exit(1); });

/** A bare protocol client: collects text messages and relayed voice frames. */
function client(name, room, bots) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const c = { ws, name, msgs: [], frames: [], snaps: 0, welcome: null, closed: false };
    c.send = (s) => { if (ws.readyState === 1) ws.send(s); };
    c.of = (t, pred) => c.msgs.filter((m) => m.t === t && (!pred || pred(m)));
    c.clear = () => { c.msgs.length = 0; c.frames.length = 0; };
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (data[0] === MSG.VOICE) {
          const f = decodeVoiceRelay(data);
          c.frames.push(f ? { from: f.from, seq: f.seq, payload: Buffer.from(f.payload) } : { bad: true, len: data.length });
        } else if (data[0] === MSG.SNAPSHOT) c.snaps++;
        return;
      }
      const m = JSON.parse(String(data));
      c.msgs.push(m);
      if (m.t === 'welcome') { c.welcome = m; c.id = m.id; resolve(c); }
    });
    ws.on('open', () => ws.send(encodeJoin(name, room, bots)));
    ws.on('close', () => { c.closed = true; });
    ws.on('error', reject);
    setTimeout(() => reject(new Error(`${name}: no welcome`)), 5000);
  });
}

const payload = (n, fill = 0xab) => new Uint8Array(n).fill(fill);
function frame(targets, seq, p) { return encodeVoiceFrame(targets, seq, p); }

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); } catch (e) { failures++; console.log(`  FAIL  ${name}\n        ${e && e.message}`); }
}
async function status() { return (await fetch(`http://localhost:${PORT}/status`)).json(); }
const roomStatus = async (name) => (await status()).rooms.find((r) => r.name === name);
const logLines = (re) => serverOut.split('\n').filter((l) => re.test(l));

async function main() {
  console.log(`voice relay (server path) test (protocol v${PROTOCOL_VERSION}, relay v${VOICE_RELAY_VERSION}, port ${PORT})`);

  // ---------------------------------------------------------------- pure helpers
  await check('voice frame helpers round-trip (client frame -> server re-stamp -> client)', () => {
    const p = payload(61, 7);
    const f = frame([5, 9, 5, 0], 65535, p);
    assert.equal(f[0], MSG.VOICE); assert.equal(f[1], VOICE_RELAY_VERSION);
    assert.equal(f[2], 2, 'duplicates and id 0 are skipped by the encoder');
    const d = decodeVoiceFrame(Buffer.from(f));
    assert.ok(d);
    assert.deepEqual(Array.from(d.targets.subarray(0, d.count)), [5, 9]);
    assert.equal(d.seq, 65535); assert.equal(d.length, 61);
    const out = encodeVoiceRelay(42, d.seq, Buffer.from(f), d.offset, d.length);
    const r = decodeVoiceRelay(out.buffer);
    assert.equal(r.from, 42); assert.equal(r.seq, 65535);
    assert.deepEqual(Array.from(r.payload), Array.from(p));
  });
  await check('decodeVoiceFrame rejects malformed frames', () => {
    const ok = frame([2], 1, payload(10));
    const bad = (mut) => { const b = Uint8Array.from(ok); mut(b); return decodeVoiceFrame(b); };
    assert.equal(bad((b) => { b[1] = 2; }), null, 'version');
    assert.equal(bad((b) => { b[2] = 0; }), null, 'no targets');
    assert.equal(bad((b) => { b[3] = 0; }), null, 'target id 0');
    assert.equal(bad((b) => { b[2] = 200; }), null, 'count beyond the frame');
    assert.equal(decodeVoiceFrame(ok.subarray(0, 5)), null, 'no payload');
    assert.equal(decodeVoiceFrame(new Uint8Array(VOICE_IN_MAX_BYTES + 1).fill(3)), null, 'oversized');
    assert.equal(encodeVoiceFrame([2], 1, payload(VOICE_MAX_PAYLOAD + 1)), null, 'encoder refuses an oversized payload');
    const many = Array.from({ length: 30 }, (_, i) => i + 1);
    assert.equal(encodeVoiceFrame(many, 1, payload(5))[2], VOICE_MAX_TARGETS, 'targets capped');
  });
  await check('sanitizeVoiceStat keeps candidate TYPES only', () => {
    const s = sanitizeVoiceStat(JSON.parse(encodeVoiceStat({ to: 4, state: 'relay', why: 'failed', local: 'host,srflx,host', remote: 'host', pair: '', ms: 5012.4 })));
    assert.deepEqual(s, { to: 4, state: 'relay', why: 'failed', local: 'host,srflx', remote: 'host', pair: '', ms: 5012, nr: '' });
    assert.equal(sanitizeVoiceStat({ t: 'vstat', to: 4, state: 'relay', local: '192.168.1.20' }), null, 'address');
    assert.equal(sanitizeVoiceStat({ t: 'vstat', to: 4, state: 'relay', remote: 'host 10.0.0.1' }), null, 'address');
    assert.equal(sanitizeVoiceStat({ t: 'vstat', to: 4, state: 'relay', pair: '1.2.3.4-host' }), null, 'address pair');
    assert.equal(sanitizeVoiceStat({ t: 'vstat', to: 4, state: 'bogus' }), null, 'state');
    assert.equal(sanitizeVoiceStat({ t: 'vstat', to: '4', state: 'p2p' }), null, 'to');
    assert.equal(sanitizeVoiceStat({ t: 'vstat', to: 4, state: 'p2p', why: 'x'.repeat(20) }), null, 'why');
    assert.equal(sanitizeVoiceStat({ t: 'vstat', to: 4, state: 'p2p', ms: -5 }), null, 'ms');
  });

  await startServer();
  try {
    const A = await client('Ann', 'vrroom', 0);
    const B = await client('Ben', 'vrroom');
    const C = await client('Cat', 'vrother', 0);
    const P1 = await client('Pub1');
    const P2 = await client('Pub2');
    await sleep(200);

    await check('welcome: voiceRelay in private rooms only; relay capability starts false', () => {
      assert.equal(A.welcome.voiceRelay, VOICE_RELAY_VERSION);
      assert.equal(P1.welcome.voiceRelay, undefined);
      assert.equal(A.welcome.players.find((p) => p.id === A.id).relay, false);
      assert.equal(P1.welcome.players.find((p) => p.id === P1.id).relay, undefined);
    });

    await check("relay capability travels in 'voice' and in later joiners' roster", async () => {
      B.clear();
      A.send(encodeVoiceState(false, false, true));
      await sleep(150);
      assert.deepEqual(B.of('voice'), [{ t: 'voice', id: A.id, mic: false, deaf: false, relay: true }]);
      B.send(encodeVoiceState(false, false, true));
      A.send(encodeVoiceState(true, false));            // relay omitted = unchanged
      await sleep(150);
      assert.deepEqual(B.of('voice').map((m) => m.relay), [true, true]);
      A.send(JSON.stringify({ t: 'voice', mic: true, deaf: false, relay: 'yes' }));   // refused
      const D = await client('Dee', 'vrroom');
      assert.equal(D.welcome.players.find((p) => p.id === A.id).relay, true);
      D.ws.close();
      await sleep(150);
    });

    await check('a frame reaches its target, re-stamped with the real sender id', async () => {
      A.clear(); B.clear();
      const p = payload(58, 0x11);
      A.ws.send(frame([B.id], 7, p));
      await sleep(100);
      assert.equal(B.frames.length, 1);
      assert.equal(B.frames[0].from, A.id);
      assert.equal(B.frames[0].seq, 7);
      assert.deepEqual(Array.from(B.frames[0].payload), Array.from(p));
      assert.equal(A.frames.length, 0, 'nothing comes back to the sender');
      // a client cannot name the sender: a frame shaped like a server frame is just targets + seq + payload
      B.clear();
      A.ws.send(Uint8Array.from([MSG.VOICE, VOICE_RELAY_VERSION, 1, B.id, 9, 0, 0x55]));
      await sleep(100);
      assert.equal(B.frames.length, 1);
      assert.equal(B.frames[0].from, A.id);
    });

    await check('never to yourself, never to another room, duplicate targets get one copy', async () => {
      A.clear(); B.clear(); C.clear();
      const before = (await roomStatus('vrroom')).voice;
      const foreign = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((id) => id !== A.id && id !== B.id);   // exists only in other rooms (or nowhere)
      A.ws.send(frame([A.id], 1, payload(20)));
      A.ws.send(frame([foreign], 2, payload(20)));
      A.ws.send(Uint8Array.from([MSG.VOICE, VOICE_RELAY_VERSION, 3, B.id, B.id, B.id, 3, 0, 1, 2, 3]));   // hand-made duplicates
      C.ws.send(frame([A.id, B.id], 4, payload(20)));    // C's room has no A / B
      await sleep(150);
      assert.equal(A.frames.length, 0);
      assert.equal(C.frames.length, 0);
      assert.equal(B.frames.length, 1, 'one copy for duplicate targets');
      const after = (await roomStatus('vrroom')).voice;
      assert.equal(after.relayFrames - before.relayFrames, 1);
      assert.ok(after.relayRefused - before.relayRefused >= 4, JSON.stringify(after));
    });

    await check('not relayed in a public room', async () => {
      P2.clear();
      P1.ws.send(frame([P2.id], 1, payload(30)));
      await sleep(150);
      assert.equal(P2.frames.length, 0);
      const r = await roomStatus(P1.welcome.room);
      assert.equal(r.voice.relayFrames, 0);
      assert.ok(r.voice.relayRefused >= 1, JSON.stringify(r.voice));
    });

    await check('oversized / malformed frames are dropped and counted; the socket survives a few', async () => {
      B.clear();
      const before = (await roomStatus('vrroom')).voice;
      const big = new Uint8Array(VOICE_IN_MAX_BYTES + 20); big.set(frame([B.id], 1, payload(10)).subarray(0, 4)); big[2] = 1;
      A.ws.send(big);
      const v2 = frame([B.id], 1, payload(10)); v2[1] = 9;
      A.ws.send(v2);
      await sleep(150);
      assert.equal(B.frames.length, 0);
      const after = (await roomStatus('vrroom')).voice;
      assert.equal(after.relayDropped - before.relayDropped, 2);
      assert.equal(A.closed, false);
    });

    await check('a steady 50 frames/s stream (~24 kbps) passes untouched, next to 60 Hz input', async () => {
      await sleep(2500);                         // buckets full again
      B.clear();
      const before = (await roomStatus('vrroom')).voice;
      const cmds = [createCmd()];
      const t0 = Date.now();
      let sent = 0;
      for (let i = 0; i < 100; i++) {           // 2 s of speech; Opus VBR sizes around 60 bytes, some peaks
        A.ws.send(frame([B.id], 1000 + i, payload(i % 10 === 0 ? 160 : 55 + (i % 13))));
        sent++;
        for (let k = 0; k < 3; k++) { cmds[0].seq++; const pkt = encodeInput(cmds, 0); if (pkt) A.ws.send(pkt); }
        await sleep(Math.max(0, t0 + (i + 1) * 20 - Date.now()));
      }
      await sleep(150);
      const after = (await roomStatus('vrroom')).voice;
      assert.equal(B.frames.length, sent, `delivered ${B.frames.length} of ${sent}`);
      assert.deepEqual(B.frames.map((f) => f.seq), Array.from({ length: sent }, (_, i) => 1000 + i), 'in order');
      assert.equal(after.relayDropped - before.relayDropped, 0);
      assert.equal(A.closed, false);
    });

    await check('a frame flood is cut off by the frames/s bucket (dropped silently, counted)', async () => {
      await sleep(2500);
      B.clear();
      const before = (await roomStatus('vrroom')).voice;
      for (let i = 0; i < 600; i++) A.ws.send(frame([B.id], i, payload(20)));
      await sleep(300);
      const got = B.frames.length;
      const after = (await roomStatus('vrroom')).voice;
      assert.ok(got >= 140 && got < 220, `delivered ${got} of 600`);
      assert.ok(after.relayDropped - before.relayDropped >= 380, JSON.stringify(after));
      assert.equal(A.closed, false, 'over-rate frames do not drop the connection');
    });

    await check('a bytes flood is cut off by the bytes/s bucket', async () => {
      await sleep(2500);
      B.clear();
      for (let i = 0; i < 120; i++) A.ws.send(frame([B.id], i, payload(VOICE_MAX_PAYLOAD)));   // 120 x 406 B in one go
      await sleep(300);
      const got = B.frames.length;
      assert.ok(got >= 50 && got <= 75, `delivered ${got} of 120 (byte burst 24000)`);
    });

    await check('not relayed to bots (private room after the match starts); humans still are', async () => {
      const H = await client('Hos', 'vrbots', 4);
      const G = await client('Gus', 'vrbots');
      H.send('{"t":"start"}');
      for (let i = 0; i < 40 && !H.of('match', (m) => m.phase === 'playing').length; i++) await sleep(50);
      const bots = H.of('join', (m) => m.player.bot).map((m) => m.player.id);
      assert.ok(bots.length > 0, 'bots joined');
      const before = (await roomStatus('vrbots')).voice;
      H.ws.send(frame(bots, 1, payload(30)));
      H.ws.send(frame([...bots, G.id], 2, payload(30)));
      await sleep(200);
      const after = (await roomStatus('vrbots')).voice;
      assert.equal(after.relayFrames - before.relayFrames, 1);
      assert.equal(after.relayRefused - before.relayRefused, bots.length * 2);
      assert.equal(G.frames.length, 1);
      assert.equal(G.frames[0].from, H.id);
      H.ws.close(); G.ws.close();
    });

    await check('vstat: one log line per pair transition, candidate types only', async () => {
      await sleep(1500);
      const pre = logLines(/ voice (Ann|Ben|Pub)/).length;
      const st = { to: B.id, state: 'relay', why: 'failed', local: 'host,srflx', remote: 'host', ms: 5012 };
      A.send(encodeVoiceStat(st));
      A.send(encodeVoiceStat(st));                // same outcome again: no new line
      await sleep(150);
      A.send(encodeVoiceStat({ to: B.id, state: 'p2p', pair: 'srflx-srflx', ms: 12400 }));
      A.send(JSON.stringify({ t: 'vstat', to: B.id, state: 'failed', local: '192.168.1.20 typ host' }));   // rejected
      P1.send(encodeVoiceStat({ to: P2.id, state: 'relay', why: 'timeout' }));                              // public room: ignored
      B.send(encodeVoiceStat({ to: A.id, state: 'relay', why: 'timeout', local: 'host', remote: 'host,srflx', ms: 5000 }));
      await sleep(250);
      const lines = logLines(/ voice (Ann|Ben|Pub)/).slice(pre);
      assert.equal(lines.length, 3, lines.join('\n'));
      assert.match(lines[0], new RegExp(`voice Ann#${A.id} -> Ben#${B.id}: p2p failed after 5s \\(local host,srflx / remote host\\), using relay$`));
      assert.match(lines[1], new RegExp(`voice Ann#${A.id} -> Ben#${B.id}: p2p connected after 12s \\(pair srflx-srflx\\), relay off$`));
      assert.match(lines[2], new RegExp(`voice Ben#${B.id} -> Ann#${A.id}: p2p not connected after 5s \\(local host / remote host,srflx\\), using relay$`));
      const r = await roomStatus('vrroom');
      assert.equal(r.voice.reports, 3);
    });

    await check('room close logs a one-line voice summary; nothing in the log looks like an address', async () => {
      for (const c of [A, B]) c.ws.close();
      await sleep(300);
      const sum = logLines(/voice room vrroom:/);
      assert.equal(sum.length, 1, serverOut.slice(-800));
      assert.match(sum[0], /pairs p2p 1 \/ relay 2 \/ failed 0, relay \d+ frames [\d.]+ kB \(dropped \d+\)/);
      assert.equal(logLines(/voice room vrother:/).length, 0, 'no voice activity there -> no summary');
      C.ws.close();
      await sleep(200);
      assert.equal(logLines(/voice room vrother:/).length, 0);
      assert.equal(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(serverOut), false, 'an IPv4-looking string in the server log');
    });

    for (const c of [P1, P2]) c.ws.close();
    await sleep(200);
  } finally {
    killServer();
  }
  console.log(failures ? `\nRESULT voice-relay: ${failures} check(s) failed` : '\nRESULT voice-relay: all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); killServer(); process.exit(1); });
