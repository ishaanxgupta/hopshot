#!/usr/bin/env node
// Voice chat signaling relay rules (protocol v5), against the real server.
//
//   node tools/voice.test.js [--port 3110]
//
// Starts `node server/index.js` on the port as a child process and checks, with plain WebSocket
// clients (no browser):
//   - welcome: private rooms get voice:true + an ICE server list, public rooms voice:false, no ice
//   - 'rtc' is relayed between two humans of the same private room, rebuilt from known fields only
//   - refused: across rooms, in public rooms, to bots, to yourself, to unknown ids, malformed /
//     oversized signals; a flood is rate limited (and does not reach the target in full)
//   - 'voice' state is broadcast to the rest of the room only, stored in roster entries for
//     later joiners, never in public rooms; non-boolean states are refused
//   - TURN env vars appear in welcome.ice
// The server child is always killed.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, MAX_SIGNAL_BYTES, encodeJoin, encodeRtc, encodeVoiceState, sanitizeSignal, voiceAllowed } from '../shared/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const PORT = args.includes('--port') ? parseInt(args[args.indexOf('--port') + 1], 10) : 3110;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), BOTS: '4', COUNTDOWN_MS: '300', TURN_URLS: 'turn:relay.test:3478', TURN_USER: 'u1', TURN_PASS: 'p1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
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

/** A bare protocol client: collects every text message. */
function client(name, room, bots) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const c = { ws, name, msgs: [], welcome: null, closed: false, closeCode: 0 };
    c.send = (s) => { if (ws.readyState === 1) ws.send(s); };
    c.of = (t, pred) => c.msgs.filter((m) => m.t === t && (!pred || pred(m)));
    c.clear = () => { c.msgs.length = 0; };
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(String(data));
      c.msgs.push(m);
      if (m.t === 'welcome') { c.welcome = m; c.id = m.id; resolve(c); }
    });
    ws.on('open', () => ws.send(encodeJoin(name, room, bots)));
    ws.on('close', (code) => { c.closed = true; c.closeCode = code; });
    ws.on('error', reject);
    setTimeout(() => reject(new Error(`${name}: no welcome`)), 5000);
  });
}

const OFFER = 'v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n';
const CAND = { candidate: 'candidate:1 1 udp 2122260223 192.168.1.20 54400 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' };
let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok    ${name}`); } catch (e) { failures++; console.log(`  FAIL  ${name}\n        ${e && e.message}`); }
}
async function status() { return (await fetch(`http://localhost:${PORT}/status`)).json(); }
const roomStatus = async (name) => (await status()).rooms.find((r) => r.name === name);

async function main() {
  console.log(`voice relay test (protocol v${PROTOCOL_VERSION}, port ${PORT})`);

  // pure helpers
  await check('voiceAllowed: team modes in countdown/playing are team-only, everything else open', () => {
    assert.equal(voiceAllowed(true, 'playing', 'a', 'a'), true);
    assert.equal(voiceAllowed(true, 'playing', 'a', 'b'), false);
    assert.equal(voiceAllowed(true, 'countdown', 'b', 'a'), false);
    assert.equal(voiceAllowed(true, 'playing', '', ''), false);
    assert.equal(voiceAllowed(true, 'lobby', 'a', 'b'), true);
    assert.equal(voiceAllowed(true, 'results', 'a', 'b'), true);
    assert.equal(voiceAllowed(false, 'playing', '', ''), true);
  });
  await check('sanitizeSignal rebuilds known fields and rejects junk', () => {
    assert.deepEqual(sanitizeSignal({ k: 'sdp', type: 'offer', sdp: OFFER, evil: 1 }), { k: 'sdp', type: 'offer', sdp: OFFER });
    assert.equal(sanitizeSignal({ k: 'sdp', type: 'rollback', sdp: OFFER }), null);
    assert.equal(sanitizeSignal({ k: 'sdp', type: 'offer', sdp: 'hello' }), null);
    assert.equal(sanitizeSignal({ k: 'sdp', type: 'offer', sdp: 'v=0' + 'x'.repeat(8000) }), null);
    assert.deepEqual(sanitizeSignal({ k: 'ice', c: null }), { k: 'ice', c: null });
    assert.equal(sanitizeSignal({ k: 'ice', c: { candidate: 'x'.repeat(700) } }), null);
    assert.equal(sanitizeSignal({ k: 'ice', c: { candidate: 'a', sdpMLineIndex: -1 } }), null);
    assert.equal(sanitizeSignal({ k: 'bye' }), null);
    assert.equal(sanitizeSignal([1]), null);
  });

  await startServer();
  try {
    const A = await client('Ann', 'vtroom', 0);
    const B = await client('Ben', 'vtroom');
    const C = await client('Cat', 'vtother', 0);
    const P1 = await client('Pub1');           // public room (bots fill it)
    const P2 = await client('Pub2');
    await sleep(200);

    await check('welcome: private room has voice + ICE list (STUN + TURN from env)', () => {
      assert.equal(A.welcome.voice, true);
      assert.ok(Array.isArray(A.welcome.ice) && A.welcome.ice.length === 2, JSON.stringify(A.welcome.ice));
      assert.ok(A.welcome.ice[0].urls.includes('stun:stun.l.google.com:19302'));
      assert.deepEqual(A.welcome.ice[1], { urls: ['turn:relay.test:3478'], username: 'u1', credential: 'p1' });
      const me = A.welcome.players.find((p) => p.id === A.id);
      assert.equal(me.mic, false); assert.equal(me.deaf, false);
    });
    await check('welcome: public room has no voice and no ICE list', () => {
      assert.equal(P1.welcome.voice, false);
      assert.equal(P1.welcome.ice, undefined);
      assert.equal(P1.welcome.room, P2.welcome.room, 'both public clients share a room');
      assert.equal(P1.welcome.players.find((p) => p.id === P1.id).mic, undefined);
    });

    await check('rtc relayed between two humans of the same private room (fields rebuilt)', async () => {
      B.clear();
      A.send(JSON.stringify({ t: 'rtc', to: B.id, d: { k: 'sdp', type: 'offer', sdp: OFFER, extra: 'x' }, junk: 1 }));
      A.send(encodeRtc(B.id, { k: 'ice', c: { ...CAND, foo: 'bar' } }));
      A.send(encodeRtc(B.id, { k: 'ice', c: null }));
      await sleep(150);
      const got = B.of('rtc');
      assert.equal(got.length, 3);
      assert.deepEqual(got[0], { t: 'rtc', from: A.id, d: { k: 'sdp', type: 'offer', sdp: OFFER } });
      assert.deepEqual(got[1].d, { k: 'ice', c: CAND });
      assert.deepEqual(got[2].d, { k: 'ice', c: null });
      // and back
      A.clear();
      B.send(encodeRtc(A.id, { k: 'sdp', type: 'answer', sdp: OFFER }));
      await sleep(100);
      assert.equal(A.of('rtc', (m) => m.from === B.id && m.d.type === 'answer').length, 1);
    });

    await check('rtc refused across rooms (target id only exists in another room)', async () => {
      C.clear(); A.clear(); B.clear();
      const foreign = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((id) => id !== A.id && id !== B.id);
      A.send(encodeRtc(foreign, { k: 'sdp', type: 'offer', sdp: OFFER }));
      C.send(encodeRtc(A.id, { k: 'sdp', type: 'offer', sdp: OFFER }));    // C's room has no player with A's id other than C itself / nobody
      await sleep(150);
      assert.equal(C.of('rtc').length, 0);
      assert.equal(B.of('rtc').length, 0);
      assert.equal(A.of('rtc').length, 0);
    });

    await check('rtc refused to yourself and with malformed signals', async () => {
      A.clear(); B.clear();
      A.send(encodeRtc(A.id, { k: 'sdp', type: 'offer', sdp: OFFER }));
      A.send(encodeRtc(B.id, { k: 'sdp', type: 'offer', sdp: 'not an sdp' }));
      A.send(encodeRtc(B.id, { k: 'bye' }));
      A.send(JSON.stringify({ t: 'rtc', to: String(B.id), d: { k: 'ice', c: null } }));
      A.send(encodeRtc(B.id, { k: 'ice', c: { candidate: 'x'.repeat(700) } }));
      await sleep(150);
      assert.equal(A.of('rtc').length, 0);
      assert.equal(B.of('rtc').length, 0);
    });

    await check('rtc refused in a public room', async () => {
      P2.clear();
      P1.send(encodeRtc(P2.id, { k: 'sdp', type: 'offer', sdp: OFFER }));
      await sleep(150);
      assert.equal(P2.of('rtc').length, 0);
      const r = await roomStatus(P1.welcome.room);
      assert.ok(r.voice.refused >= 1 && r.voice.relayed === 0, JSON.stringify(r.voice));
    });

    await check('oversized signals are dropped (SDP over the limit; frame over MAX_SIGNAL_BYTES; huge frame closes)', async () => {
      B.clear();
      A.send(encodeRtc(B.id, { k: 'sdp', type: 'offer', sdp: 'v=0' + 'a'.repeat(7700) }));                     // > MAX_SDP_CHARS
      A.send(JSON.stringify({ t: 'rtc', to: B.id, d: { k: 'ice', c: null }, pad: 'p'.repeat(MAX_SIGNAL_BYTES) }));   // frame too big
      await sleep(150);
      assert.equal(B.of('rtc').length, 0);
      assert.equal(A.closed, false, 'a few bad frames do not drop the connection');
      const X = await client('Xtra', 'vtroom');
      X.send(encodeRtc(B.id, { k: 'sdp', type: 'offer', sdp: 'v=0' + 'z'.repeat(40000) }));                    // > ws maxPayload
      await sleep(200);
      assert.equal(X.closed, true, 'a frame over maxPayload closes the socket');
      assert.equal(B.of('rtc').length, 0);
    });

    await check('signaling flood is rate limited', async () => {
      await sleep(1500);                    // let the buckets refill after the tests above
      B.clear();
      const N = 600;
      for (let i = 0; i < N; i++) A.send(encodeRtc(B.id, { k: 'ice', c: { ...CAND, candidate: CAND.candidate + ' n' + i } }));
      await sleep(400);
      const got = B.of('rtc').length;
      assert.ok(got > 20 && got < 200, `relayed ${got} of ${N}`);
      const r = await roomStatus('vtroom');
      assert.ok(r.voice.limited > 0, JSON.stringify(r.voice));
      assert.equal(A.closed, false);
    });

    await check('voice state is broadcast to the rest of the room only', async () => {
      await sleep(1500);
      A.clear(); B.clear(); C.clear();
      A.send(encodeVoiceState(true, false));
      await sleep(150);
      assert.deepEqual(B.of('voice'), [{ t: 'voice', id: A.id, mic: true, deaf: false }]);
      assert.equal(A.of('voice').length, 0, 'no echo to the sender');
      assert.equal(C.of('voice').length, 0, 'other rooms see nothing');
      // unchanged state is not re-broadcast; non-boolean is refused
      A.send(encodeVoiceState(true, false));
      A.send(JSON.stringify({ t: 'voice', mic: 'yes', deaf: 0 }));
      await sleep(150);
      assert.equal(B.of('voice').length, 1);
      // a later joiner sees it in the roster
      const D = await client('Dee', 'vtroom');
      const ann = D.welcome.players.find((p) => p.id === A.id);
      assert.equal(ann.mic, true); assert.equal(ann.deaf, false);
      B.send(encodeVoiceState(false, true));
      await sleep(150);
      assert.deepEqual(D.of('voice', (m) => m.id === B.id).map((m) => [m.mic, m.deaf]), [[false, true]]);
      D.ws.close();
    });

    await check('voice state is not broadcast in a public room', async () => {
      P2.clear();
      P1.send(encodeVoiceState(true, false));
      await sleep(150);
      assert.equal(P2.of('voice').length, 0);
    });

    await check('rtc to a bot is refused (private room after the match starts)', async () => {
      const H = await client('Hos', 'vtbots', 4);
      const G = await client('Gus', 'vtbots');
      H.send('{"t":"start"}');
      for (let i = 0; i < 40 && !H.of('match', (m) => m.phase === 'playing').length; i++) await sleep(50);
      const bots = H.of('join', (m) => m.player.bot).map((m) => m.player.id);
      assert.ok(bots.length > 0, 'bots joined');
      const before = (await roomStatus('vtbots')).voice;
      for (const b of bots) H.send(encodeRtc(b, { k: 'sdp', type: 'offer', sdp: OFFER }));
      G.clear();
      H.send(encodeRtc(G.id, { k: 'sdp', type: 'offer', sdp: OFFER }));    // the human still works mid-match
      await sleep(200);
      const after = (await roomStatus('vtbots')).voice;
      assert.equal(after.refused - before.refused, bots.length);
      assert.equal(after.relayed - before.relayed, 1);
      assert.equal(G.of('rtc').length, 1);
      H.ws.close(); G.ws.close();
    });

    await check('a player who left can no longer be reached', async () => {
      const L = await client('Lea', 'vtroom');
      const id = L.id;
      L.ws.close();
      await sleep(200);
      assert.ok(A.of('leave', (m) => m.id === id).length === 1);
      const before = (await roomStatus('vtroom')).voice;
      A.send(encodeRtc(id, { k: 'sdp', type: 'offer', sdp: OFFER }));
      await sleep(150);
      const after = (await roomStatus('vtroom')).voice;
      assert.equal(after.relayed, before.relayed);
    });

    for (const c of [A, B, C, P1, P2]) c.ws.close();
    await sleep(200);
  } finally {
    killServer();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall voice relay checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); killServer(); process.exit(1); });
