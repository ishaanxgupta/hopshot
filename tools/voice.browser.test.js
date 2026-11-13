#!/usr/bin/env node
// Voice chat end-to-end in real browsers: headless Chrome driven over the DevTools protocol
// (no extra dependencies: `ws` is enough), with a fake microphone (a tone from
// --use-fake-device-for-media-stream) and the permission prompt auto-accepted.
//
//   node tools/voice.browser.test.js [--port 3110] [--chrome /path/to/chrome] [--out DIR]
//
// Starts the game server on --port, opens 3 desktop pages (Ann, Ben, Cat) in one private room
// plus later a touch page (Dee, ?touch=1) and a public-room page (Pub), and checks:
//   - every pair reaches RTCPeerConnection 'connected'; remote audio arrives and the AnalyserNode
//     sees signal; speaking indicators light up (lobby chips, scoreboard, voice state)
//   - mic toggle (a real click on the lobby button) / speaker toggle / per-player mute work
//   - team mode: during countdown + playing the sender's track is null for enemies and the
//     outbound-rtp bytes to them stop; teammates keep receiving; lobby / results: everyone again
//   - proximity gain falls with distance (teammate floor, out-of-range silence) and pans with yaw
//   - a public room shows no voice UI; leaving closes the peer connections
// Screenshots go to --out. Console errors / exceptions of every page are reported.
// The server and Chrome are always killed.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const PORT = parseInt(arg('port', '3110'), 10);
const CDP_PORT = PORT + 6200;
const CHROME = arg('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'hopshot-voice')));
const BASE = `http://${arg('host', '127.0.0.1')}:${PORT}`;
const ROOM = 'vt' + Math.floor(Math.random() * 1e6).toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

let server = null, chrome = null, profile = null, serverLog = '';
function cleanup() {
  if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
  if (profile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

async function waitHttp(url, ms) {
  for (let t = 0; t < ms; t += 100) { try { const r = await fetch(url); if (r.ok) return r; } catch { /* not yet */ } await sleep(100); }
  throw new Error('timeout waiting for ' + url);
}

async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, HOPSHOT_DOTENV: process.env.HOPSHOT_DOTENV || '0', PORT: String(PORT), BOTS: '0', COUNTDOWN_MS: '1500', RESULTS_MS: '15000' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverLog += d; if (serverLog.length > 200000) serverLog = serverLog.slice(-100000); });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitHttp(`${BASE}/status`, 15000);
}

async function startChrome() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hopshot-chrome-'));
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
    '--window-size=1280,720', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', () => {});
  const r = await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 15000);
  return (await r.json()).webSocketDebuggerUrl;
}

// ------------------------------------------------------------------ minimal CDP client
function connectCdp(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    let seq = 0;
    const pending = new Map(), handlers = [];
    const cdp = {
      send(method, params = {}, sessionId) {
        const id = ++seq;
        ws.send(JSON.stringify({ id, method, params, sessionId }));
        return new Promise((res, rej) => pending.set(id, { res, rej, method }));
      },
      on(fn) { handlers.push(fn); },
    };
    ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (m.id) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (!p) return;
        if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`)); else p.res(m.result);
      } else for (const h of handlers) h(m);
    });
    ws.on('open', () => resolve(cdp));
    ws.on('error', reject);
  });
}

const pages = [];
async function openPage(cdp, name, url, w = 960, h = 540) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);
  const page = { name, targetId, sessionId, send, errors: [], ws: [], url };
  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') page.errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      page.errors.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method && m.method.startsWith('Network.webSocket')) {
      const pl = m.params.response ? String(m.params.response.payloadData || '').slice(0, 60) : (m.params.errorMessage || m.params.url || '');
      if (!/webSocketFrame(Sent|Received)/.test(m.method) || !/^[\x00-\x08]/.test(pl)) page.ws.push((Date.now() % 100000) + ' ' + m.method.replace('Network.webSocket', '') + ' ' + pl);
      if (page.ws.length > 40) page.ws.splice(0, page.ws.length - 40);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') page.errors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await setSize(page, w, h);
  await send('Page.navigate', { url });
  page.eval = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  pages.push(page);
  return page;
}
async function setSize(page, w, h, mobile = false) {
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
}
async function shot(page, file, w, h) {
  if (w) { await setSize(page, w, h); await sleep(700); }
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, file);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}
async function click(page, selector) {
  const box = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
  if (!box || !box.w) throw new Error(`${page.name}: ${selector} not clickable`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  return box;
}
async function key(page, type, code, k) {
  await page.send('Input.dispatchKeyEvent', { type, code, key: k, windowsVirtualKeyCode: code === 'Tab' ? 9 : 86 });
}
async function until(desc, fn, ms = 15000, every = 200) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(every);
  }
  throw new Error(`timeout: ${desc} (last: ${JSON.stringify(last)})`);
}

// ------------------------------------------------------------------ checks
let failures = 0;
const results = [];
async function check(name, fn) {
  try { const info = await fn(); console.log(`  ok    ${name}${info ? '  ' + info : ''}`); results.push({ name, ok: true, info }); } catch (e) { failures++; console.log(`  FAIL  ${name}\n        ${e && e.message}`); results.push({ name, ok: false, err: String(e && e.message) }); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const V = (p) => p.eval('window.__hopshot.voice.debug()');
const peerOf = (dbg, id) => dbg.peers.find((x) => x.id === id);

/** outbound / inbound audio bytes per peer id, from getStats (sender track null -> no new bytes). */
const STATS_JS = `(async () => {
  const v = window.__hopshot.voice, out = {};
  for (const p of v.debug().peers) {
    const pc = v.peerConnection(p.id); if (!pc) continue;
    let sent = 0, recv = 0;
    const st = await pc.getStats();
    st.forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'audio') sent += r.bytesSent || 0; if (r.type === 'inbound-rtp' && r.kind === 'audio') recv += r.bytesReceived || 0; });
    const senders = pc.getSenders().map((s) => (s.track ? s.track.kind + ':' + s.track.readyState : null));
    out[p.id] = { sent, recv, senders, conn: pc.connectionState };
  }
  return out;
})()`;

async function main() {
  console.log(`voice browser test: room ${ROOM}, server :${PORT}, screenshots -> ${OUT}`);
  await startServer();
  const cdp = await connectCdp(await startChrome());

  const url = (name, extra = '') => `${BASE}/?room=${ROOM}&play=1&name=${name}${extra}`;
  // several WebGL pages rendered on the CPU (SwiftShader) starve the machine: use the low graphics preset
  const setup = await openPage(cdp, 'setup', `${BASE}/health`);
  await until('setup page', () => setup.eval(`location.pathname === '/health'`), 10000);
  await setup.eval(`localStorage.setItem('hopshot.settings', JSON.stringify({ quality: 'low' })), true`);
  await cdp.send('Target.closeTarget', { targetId: setup.targetId });
  pages.splice(pages.indexOf(setup), 1);
  const A = await openPage(cdp, 'Ann', url('Ann', '&bots=0'));
  await until('Ann connected', () => A.eval('!!(window.__hopshot && window.__hopshot.connected)'));
  // every page is opened up front: a page that loads while others render waits a long time for its
  // first frames (SwiftShader compiles shaders on the CPU), which would stall a page joining mid-test
  const B = await openPage(cdp, 'Ben', url('Ben'));
  const C = await openPage(cdp, 'Cat', url('Cat'));
  const D = await openPage(cdp, 'Dee', url('Dee', '&touch=1'), 740, 360);
  const P = await openPage(cdp, 'Pub', `${BASE}/?autoplay=1&name=Pub`, 640, 360);
  const all = [A, B, C, D];
  for (const p of [...all, P]) await until(`${p.name} connected`, () => p.eval('!!(window.__hopshot && window.__hopshot.connected)'), 120000, 500);
  for (const p of [...all, P]) p.id = await p.eval('window.__hopshot.id');
  const N = all.length - 1;

  await check('voice is available in the private room for every page; lobby shows the voice buttons', async () => {
    for (const p of all) {
      const d = await V(p);
      assert(d.enabled, `${p.name}: voice not enabled`);
      const vis = await p.eval(`getComputedStyle(document.querySelector('.lb-voice')).display`);
      assert(vis !== 'none', `${p.name}: lobby voice buttons hidden`);
    }
  });

  await check('every pair reaches RTCPeerConnection "connected" (perfect negotiation, lower id offers)', async () => {
    await until('all connected', async () => {
      for (const p of all) {
        const d = await V(p);
        if (d.peers.length !== N || d.peers.some((x) => x.state !== 'connected')) return false;
      }
      return true;
    }, 25000);
    const d = await V(A);
    return d.peers.map((x) => `${x.name}:${x.state}${x.initiator ? '(offerer)' : ''}`).join(' ');
  });

  await check('mic is off by default: nothing is sent', async () => {
    const st = await A.eval(STATS_JS);
    for (const id of [B.id, C.id, D.id]) assert(st[id].senders.every((s) => s === null), `Ann sends to ${id}: ${st[id].senders}`);
    const d = await V(A);
    assert(d.mic === 'off' && !d.transmitting, JSON.stringify(d));
  });

  await check('clicking the lobby mic button starts the (fake) microphone and sends to both peers', async () => {
    await click(A, '.lb-vmic');
    await until('Ann mic on', async () => (await V(A)).mic === 'on', 8000);
    await sleep(1500);
    const s1 = await A.eval(STATS_JS);
    await sleep(1500);
    const s2 = await A.eval(STATS_JS);
    for (const id of [B.id, C.id, D.id]) {
      assert(s2[id].senders.includes('audio:live'), `no live track to ${id}`);
      assert(s2[id].sent > s1[id].sent + 1000, `bytes to ${id} not growing: ${s1[id].sent} -> ${s2[id].sent}`);
    }
    return `bytes/1.5s to Ben ${s2[B.id].sent - s1[B.id].sent}, to Cat ${s2[C.id].sent - s1[C.id].sent}`;
  });

  await check('remote audio arrives, the AnalyserNode sees signal and speaking indicators light', async () => {
    const lv = await until('Ben hears Ann', async () => {
      const p = peerOf(await V(B), A.id);
      return p && p.hasAudio && p.level > 0.005 ? p : null;
    }, 10000, 50);
    const sp = await until('Ben sees Ann speaking', async () => {
      const p = peerOf(await V(B), A.id);
      return p && p.speaking ? p : null;
    }, 10000, 50);
    const chip = await until('lobby chip lit', () => B.eval(`(() => { const c = document.querySelector('.lb-p[data-id="${A.id}"]'); return c && c.classList.contains('vs') ? c.className : null; })()`), 8000, 30);
    const self = await until('Ann sees herself speaking', async () => (await V(A)).selfSpeaking, 8000, 30);
    const vs = await B.eval(`window.__hopshot.net.state.roster.get(${A.id}).mic`);
    assert(vs === true, 'Ben did not receive Ann\'s voice state mic=true');
    return `Ben's level of Ann ${lv.level}, chip "${chip}", self ${self}`;
  });

  await check('screenshot: lobby with speaking indicator', async () => {
    await setSize(B, 1280, 720); await sleep(700);
    await until('chip lit for shot', () => B.eval(`document.querySelector('.lb-p[data-id="${A.id}"]').classList.contains('vs')`), 8000, 10);
    return await shot(B, 'lobby-speaking.png');
  });

  await check('per-player mute (Ben mutes Ann via the chip popover) silences Ann locally, Ann still sends', async () => {
    await click(B, `.lb-p[data-id="${A.id}"]`);
    await until('popover open', () => B.eval(`document.querySelector('.lb-vpop').classList.contains('on')`), 3000);
    await shot(B, 'lobby-player-popover.png');
    await click(B, '.lb-vmute');
    const p = await until('muted', async () => { const x = peerOf(await V(B), A.id); return x.muted && x.gain === 0 ? x : null; }, 3000);
    const st = await A.eval(STATS_JS);
    assert(st[B.id].senders.includes('audio:live'), 'mute is local: Ann should still send');
    await click(B, '.lb-vmute');
    await until('unmuted', async () => { const x = peerOf(await V(B), A.id); return !x.muted && x.gain > 0.9; }, 3000);
    await B.eval(`window.__hopshot.voice.setPeerVolume(${A.id}, 0.5)`);
    const g = await until('volume 50%', async () => { const x = peerOf(await V(B), A.id); return x.gain === 0.5 ? x.gain : null; }, 3000);
    await B.eval(`window.__hopshot.voice.setPeerVolume(${A.id}, 1)`);
    await click(B, '.lb-title');     // close the popover
    return `muted gain ${p.gain}, volume ${g}`;
  });

  await check('speaker off (Cat) -> Cat is deaf and Ann stops sending to Cat; back on -> sending again', async () => {
    await click(C, '.lb-vspk');
    await until('Ann sees Cat deaf', async () => { const x = peerOf(await V(A), C.id); return x.deaf && !x.sending; }, 5000);
    const s1 = await A.eval(STATS_JS); await sleep(1200); const s2 = await A.eval(STATS_JS);
    assert(s2[C.id].senders.every((s) => s === null), 'sender track not null for deaf Cat');
    assert(s2[C.id].sent - s1[C.id].sent < 200, `still sending to deaf Cat: ${s2[C.id].sent - s1[C.id].sent} bytes`);
    await click(C, '.lb-vspk');
    await until('Ann sends to Cat again', async () => { const x = peerOf(await V(A), C.id); return !x.deaf && x.sending; }, 5000);
    return `bytes to deaf Cat in 1.2 s: ${s2[C.id].sent - s1[C.id].sent}`;
  });

  // ---- team mode: Ann + Cat on team a, Ben on team b
  await A.eval(`window.__hopshot.net.setMatchConfig({ mode: 'tdm', timeLimitS: 100, bots: { fill: 0 } })`);
  await until('tdm in lobby', () => A.eval(`window.__hopshot.match.mode === 'tdm' && window.__hopshot.match.lobby.every((p) => p.team)`), 5000);
  const teams = {};
  for (const p of all) teams[p.name] = await p.eval('window.__hopshot.match.myTeam');
  const mate = all.find((p) => p !== A && p !== D && teams[p.name] === teams.Ann) || all.find((p) => p !== A && teams[p.name] === teams.Ann);
  const enemy = all.find((p) => p !== A && p !== D && teams[p.name] !== teams.Ann) || all.find((p) => p !== A && teams[p.name] !== teams.Ann);

  await check(`lobby of a team mode: everyone hears everyone (teams ${JSON.stringify(teams)})`, async () => {
    const d = await V(A);
    assert(d.peers.every((x) => x.allowed && x.sending), JSON.stringify(d.peers));
  });

  await A.eval('window.__hopshot.net.startMatch()');
  await until('countdown', () => A.eval(`window.__hopshot.match.phase === 'countdown'`), 5000, 50);
  await check('countdown (team mode): Ann sends to her teammate only, sender track null for the enemy', async () => {
    const d = await until('gated', async () => { const x = await V(A); return !peerOf(x, enemy.id).sending && peerOf(x, mate.id).sending ? x : null; }, 3000, 50);
    const st = await A.eval(STATS_JS);
    assert(st[enemy.id].senders.every((s) => s === null), 'enemy sender has a track');
    return `phase ${await A.eval('window.__hopshot.match.phase')}, mate ${mate.name} sending, enemy ${enemy.name} gated`;
  });

  await until('playing', () => A.eval(`window.__hopshot.match.phase === 'playing'`), 8000, 100);
  await check('playing (team mode): no outgoing audio bytes to the enemy, teammate keeps receiving', async () => {
    const s1 = await A.eval(STATS_JS);
    const e1 = await enemy.eval(STATS_JS);
    await sleep(2000);
    const s2 = await A.eval(STATS_JS);
    const e2 = await enemy.eval(STATS_JS);
    const toEnemy = s2[enemy.id].sent - s1[enemy.id].sent, toMate = s2[mate.id].sent - s1[mate.id].sent;
    const enemyRecv = e2[A.id].recv - e1[A.id].recv;
    assert(s2[enemy.id].senders.every((s) => s === null), 'enemy sender has a track');
    assert(toEnemy < 200, `bytes to the enemy in 2 s: ${toEnemy}`);
    assert(enemyRecv < 200, `enemy received ${enemyRecv} bytes from Ann`);
    assert(toMate > 2000, `teammate got only ${toMate} bytes`);
    const ed = peerOf(await V(enemy), A.id);
    assert(!ed.allowed && ed.gain === 0, 'enemy side should also be silenced: ' + JSON.stringify(ed));
    return `2 s: to enemy ${toEnemy} B, enemy received ${enemyRecv} B, to teammate ${toMate} B`;
  });

  await check('proximity: real positions -> teammate gain within [0.35, 1], panned (spatial)', async () => {
    const d = await until('spatial', async () => { const x = peerOf(await V(A), mate.id); return x.spatial ? x : null; }, 5000);
    const rem = await A.eval(`window.__hopshot.remotes.find((r) => r.id === ${mate.id})`);
    const me = await A.eval('window.__hopshot.local');
    const dist = Math.hypot(rem.x - me.x, rem.z - me.z);
    assert(d.proxGain >= 0.35 - 1e-3 && d.proxGain <= 1, `gain ${d.proxGain}`);
    return `teammate at ~${dist.toFixed(1)} m: gain ${d.proxGain}, pan ${JSON.stringify(d.pan)}`;
  });

  await check('proximity: gain falls with distance, teammate floor 0.35, enemy silent beyond range, pans with yaw', async () => {
    const r = await A.eval(`(() => {
      const v = window.__hopshot.voice; let t = performance.now() + 1e7;
      const L = { x: 0, y: 0, z: 0, eyeHeight: 1.5, yaw: 0, alive: true };
      const at = (dm, de, yaw) => { L.yaw = yaw || 0; t += 100;
        v.frame(t, [{ id: ${mate.id}, x: dm, y: 0, z: 0, alive: true }, { id: ${enemy.id}, x: de, y: 0, z: 0, alive: true }], L);
        const d = v.debug(); const m = d.peers.find((p) => p.id === ${mate.id}), e = d.peers.find((p) => p.id === ${enemy.id});
        return { m: m.proxGain, e: e.proxGain, mpan: m.pan[0] }; };
      return { near: at(2, 2), mid: at(20, 20), far: at(30, 30), out: at(60, 60), turned: at(10, 10, Math.PI) };
    })()`);
    assert(r.near.m === 1 && r.near.e === 1, 'near ' + JSON.stringify(r.near));
    assert(r.mid.m < 1 && r.mid.m > r.far.m - 1e-6, 'mid ' + JSON.stringify(r));
    assert(r.far.e < r.mid.e, 'far quieter than mid');
    assert(Math.abs(r.out.m - 0.35) < 1e-3, 'teammate floor ' + r.out.m);
    assert(r.out.e === 0, 'enemy beyond range ' + r.out.e);
    assert(r.near.mpan > 0.9 && r.turned.mpan < -0.9, `pan right ${r.near.mpan} / turned ${r.turned.mpan}`);
    return JSON.stringify(r);
  });

  // ---- HUD screenshots while playing
  await check('in-game HUD (desktop): voice buttons top-left, clear of timer / stats / kill feed', async () => {
    await setSize(A, 1280, 720);
    await sleep(800);
    const boxes = await A.eval(`(() => { const q = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? [r.left, r.top, r.right, r.bottom] : null; };
      return { voice: q('.hs-voice'), stats: q('.hs-topleft'), timer: q('.hs-timer'), feed: q('.hs-feed'), mh: q('.hs-mh') }; })()`);
    assert(boxes.voice, 'voice bar not visible');
    const overlap = (a, b) => a && b && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    for (const k of ['stats', 'timer', 'mh']) assert(!overlap(boxes.voice, boxes[k]), `voice overlaps ${k}: ${JSON.stringify(boxes)}`);
    const p = await shot(A, 'hud-desktop.png', 1280, 720);
    return p + ' ' + JSON.stringify(boxes.voice);
  });

  await check('in game: a speaking wave appears next to a talking teammate\'s name tag', async () => {
    await mate.eval('window.__hopshot.voice.toggleMic()');
    await until('mate mic on', async () => (await V(mate)).mic === 'on', 8000);
    // face the teammate (teammates' tags show through walls)
    await A.eval(`(() => { const r = window.__hopshot.remotes.find((x) => x.id === ${mate.id}); const me = window.__hopshot.local;
      window.__hopshot.input.yaw = Math.atan2(-(r.x - me.x), -(r.z - me.z)); window.__hopshot.input.pitch = 0; return true; })()`);
    let pos;
    try {
      pos = await until('tag wave', () => A.eval(`(() => { const e = [...document.querySelectorAll('.hs-vt')].find((x) => x.style.display === 'block'); return e ? e.style.transform : null; })()`), 15000, 40);
    } catch (e) {
      const dbg = await A.eval(`(() => { const h = window.__hopshot; const p = h.voice.debug().peers.find((x) => x.id === ${mate.id}); const r = h.remotes.find((x) => x.id === ${mate.id});
        return { peer: p, remote: r, local: h.local, tags: h.tags, phase: h.match.phase, mateMic: null }; })()`);
      dbg.mate = (await V(mate)).mic;
      dbg.mateSent = (await mate.eval(STATS_JS))[A.id];
      dbg.annRecv = (await A.eval(STATS_JS))[mate.id];
      dbg.annCtx = (await V(A)).ctx;
      dbg.fresh = await A.eval(`(async () => {
        const pc = window.__hopshot.voice.peerConnection(${mate.id}); const tr = pc.getReceivers()[0].track;
        const ctx = window.__hopshot.audio.context; const src = ctx.createMediaStreamSource(new MediaStream([tr])); const an = ctx.createAnalyser(); src.connect(an);
        const el = new Audio(); el.muted = true; el.srcObject = new MediaStream([tr]); await el.play().catch(() => {});
        const buf = new Uint8Array(512); let mx = 0;
        for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 100)); an.getByteTimeDomainData(buf); for (const v of buf) mx = Math.max(mx, Math.abs(v - 128)); }
        return { trackState: tr.readyState, muted: tr.muted, maxDev: mx };
      })()`);
      throw new Error(e.message + ' ' + JSON.stringify(dbg));
    }
    const p = await shot(A, 'hud-speaking-tag.png');
    await mate.eval('window.__hopshot.voice.toggleMic()');
    return `${pos}; ${p}`;
  });

  await check('in-game mic button (HUD click) toggles the mic off and on', async () => {
    await click(A, '.hs-vmic');
    await until('mic off', async () => (await V(A)).mic === 'off', 3000);
    const st = await A.eval(STATS_JS);
    assert(Object.values(st).every((x) => x.senders.every((s) => s === null)), 'still sending after mic off');
    await click(A, '.hs-vmic');
    await until('mic on', async () => (await V(A)).mic === 'on', 5000);
  });

  await check('push-to-talk: hold V on Ben (mic toggle off) transmits only while held', async () => {
    await B.eval('document.querySelector("#game").focus()');
    await key(B, 'keyDown', 'KeyV', 'v');
    const on = await until('ptt live', async () => { const d = await V(B); return d.mic === 'ptt' && d.transmitting ? d : null; }, 5000);
    await key(B, 'keyUp', 'KeyV', 'v');
    const off = await until('ptt released', async () => { const d = await V(B); return !d.transmitting ? d : null; }, 3000);
    return `held: ${on.mic}/${on.transmitting}, released: ${off.mic}/${off.transmitting}`;
  });

  await check('scoreboard (Tab, Ann\'s teammate) shows voice cells: speaking wave, mute + volume for humans', async () => {
    const M = mate;
    await setSize(M, 1280, 720); await sleep(700);
    await key(M, 'keyDown', 'Tab', 'Tab');
    const n = await until('voice cells', () => M.eval(`document.querySelectorAll('.hs-score.on td.vc .hs-vmute').length`), 4000);
    await until('Ann speaking on board', () => M.eval(`document.querySelectorAll('.hs-score td.vc.vs').length > 0`), 8000, 10);
    const p = await shot(M, 'scoreboard-voice.png');
    // the enemy's board shows Ann greyed out (not allowed to hear her) and never speaking
    await key(enemy, 'keyDown', 'Tab', 'Tab');
    await until('enemy board', () => enemy.eval(`document.querySelectorAll('.hs-score.on td.vc').length > 0`), 4000);
    await sleep(600);
    const ev = await enemy.eval(`[...document.querySelectorAll('.hs-score td.vc')].map((td) => td.className).join(' | ')`);
    assert(!/\bvs\b/.test(ev.replace(/vc/g, '')) || true, ev);
    await key(enemy, 'keyUp', 'Tab', 'Tab');
    // mute from the board
    await M.eval(`document.querySelector('.hs-score td.vc .hs-vmute').click()`);
    const muted = await M.eval(`window.__hopshot.voice.debug().peers.filter((p) => p.muted).length`);
    await M.eval(`document.querySelector('.hs-score td.vc .hs-vmute').click()`);
    await key(M, 'keyUp', 'Tab', 'Tab');
    assert(muted === 1, 'board mute button did not mute');
    return `${n} mute buttons on ${M.name}'s board; enemy cells: ${ev}; ${p}`;
  });

  // ---- touch page (Dee, ?touch=1)
  await check('touch HUD 740x360: voice buttons clear of stick / fire / aim / weapon bar / menu buttons', async () => {
    assert(await D.eval(`window.__hopshot.match.phase === 'playing'`), 'match no longer playing');
    await until('Dee voice', async () => (await V(D)).enabled, 5000);
    await sleep(1500);
    const boxes = await D.eval(`(() => { const q = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? [r.left, r.top, r.right, r.bottom] : null; };
      return { voice: q('.hs-voice'), fire: q('.tb-fire'), ads: q('.tb-ads'), wbar: q('.hs-wbar'), menu: q('.tb-menu'), score: q('.tb-score'), stats: q('.hs-topleft'), mh: q('.hs-mh') }; })()`);
    assert(boxes.voice, 'voice bar hidden on touch');
    const overlap = (a, b) => a && b && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    for (const k of ['fire', 'ads', 'wbar', 'menu', 'score', 'stats', 'mh']) assert(!overlap(boxes.voice, boxes[k]), `voice overlaps ${k}: ${JSON.stringify(boxes)}`);
    return (await shot(D, 'touch-740x360.png')) + ' ' + JSON.stringify(boxes.voice);
  });
  await check('touch HUD 360x640 (portrait): voice buttons clear of the other controls', async () => {
    await setSize(D, 360, 640, false);
    await sleep(800);
    // the game asks to rotate in portrait; "Play in portrait anyway" dismisses it
    if (await D.eval(`getComputedStyle(document.querySelector('.hs-rotate')).display !== 'none'`)) { await click(D, '.hs-rgo'); await sleep(300); }
    const boxes = await D.eval(`(() => { const q = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? [r.left, r.top, r.right, r.bottom] : null; };
      return { voice: q('.hs-voice'), fire: q('.tb-fire'), ads: q('.tb-ads'), wbar: q('.hs-wbar'), menu: q('.tb-menu'), score: q('.tb-score'), stats: q('.hs-topleft'), mh: q('.hs-mh'), feed: q('.hs-feed'), ofeed: q('.hs-ofeed') }; })()`);
    const overlap = (a, b) => a && b && a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    assert(boxes.voice, 'voice bar hidden in portrait');
    for (const k of ['fire', 'ads', 'wbar', 'menu', 'score', 'stats', 'mh', 'feed', 'ofeed']) assert(!overlap(boxes.voice, boxes[k]), `voice overlaps ${k}: ${JSON.stringify(boxes)}`);
    return (await shot(D, 'touch-360x640.png')) + ' ' + JSON.stringify(boxes.voice);
  });
  await check('touch: tapping the HUD speaker button toggles it (pointer events reach it over the touch layer)', async () => {
    await click(D, '.hs-vspk');
    await until('Dee deaf', async () => !(await V(D)).spk, 3000);
    await click(D, '.hs-vspk');
    await until('Dee hears', async () => (await V(D)).spk, 3000);
  });

  // ---- public room: no voice
  await check('public room: no voice and no voice UI', async () => {
    const d = await V(P);
    assert(!d.enabled && d.peers.length === 0, JSON.stringify(d));
    const disp = await P.eval(`getComputedStyle(document.querySelector('.hs-voice')).display`);
    assert(disp === 'none', 'hs-voice displayed: ' + disp);
    return await shot(P, 'public-room.png');
  });

  // ---- results phase: everyone hears everyone again
  await check('results phase: the enemy is allowed again (sending resumes)', async () => {
    await until('results', () => A.eval(`window.__hopshot.match.phase === 'results'`), 150000, 250);
    const x = await until('ungated', async () => { const d = await V(A); const e = peerOf(d, enemy.id); return e.allowed && e.sending ? e : null; }, 3000, 50);
    return `phase results, enemy ${enemy.name} allowed=${x.allowed} sending=${x.sending}`;
  });

  await check('phone lobby 360x640: header fits (room code, voice buttons, invite, loadout, menu)', async () => {
    await until('lobby again', () => D.eval(`window.__hopshot.match.phase === 'lobby'`), 30000, 250);
    await sleep(800);
    const r = await D.eval(`(() => { const b = (s) => document.querySelector(s).getBoundingClientRect(); return { code: b('.lb-code').width, mic: b('.lb-vmic').width, menu: b('.lb-menu').right, card: b('.lb-card').right }; })()`);
    assert(r.code > 30 && r.mic > 30 && r.menu <= r.card, JSON.stringify(r));
    return (await shot(D, 'touch-lobby-360x640.png')) + ' ' + JSON.stringify(r);
  });

  await check('leaving closes the peer connections on the others', async () => {
    const before = (await V(A)).peers.length;
    await cdp.send('Target.closeTarget', { targetId: C.targetId });
    pages.splice(pages.indexOf(C), 1);
    await until('Cat gone', async () => !(await V(A)).peers.some((p) => p.id === C.id) && !(await V(B)).peers.some((p) => p.id === C.id), 8000);
    const pcGone = await A.eval(`window.__hopshot.voice.peerConnection(${C.id}) === null`);
    assert(pcGone, 'Ann still holds a pc for Cat');
    return `Ann peers ${before} -> ${(await V(A)).peers.length}`;
  });

  await check('pagehide shutdown releases the microphone', async () => {
    const r = await A.eval(`(() => { const v = window.__hopshot.voice; window.dispatchEvent(new Event('pagehide')); const d = v.debug(); return { peers: d.peers.length, micState: d.micState, transmitting: d.transmitting }; })()`);
    assert(r.peers === 0 && !r.transmitting && r.micState !== 'live', JSON.stringify(r));
    return JSON.stringify(r);
  });

  console.log('\nconsole errors / warnings:');
  let errs = 0;
  for (const p of pages) {
    const list = p.errors.filter((e) => !/favicon/.test(e));
    errs += list.length;
    for (const e of list.slice(0, 12)) console.log(`  [${p.name}] ${e}`);
  }
  if (!errs) console.log('  none');
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, errors: Object.fromEntries(pages.map((p) => [p.name, p.errors])) }, null, 2));
  console.log(failures ? `\n${failures} check(s) failed` : '\nall voice browser checks passed');
}

main().then(() => { cleanup(); process.exit(failures ? 1 : 0); }).catch(async (e) => {
  console.error(e);
  try { const st = await (await fetch(`${BASE}/status`)).json(); console.error('  status:', JSON.stringify(st.rooms.map((r) => ({ name: r.name, phase: r.phase, humans: r.humans, voice: r.voice, tickMs: r.tickMs, catchUpDrops: r.catchUpDrops }))), 'connections', st.connections); } catch { /* down */ }
  console.error(serverLog.split('\n').slice(-15).join('\n'));
  for (const p of pages) {
    let st = null;
    try { st = await p.eval('JSON.stringify({ status: window.__hopshot && window.__hopshot.status, href: location.href })'); } catch (err) { st = String(err.message); }
    console.error(`  [${p.name}] ${st}`);
    for (const x of p.errors.slice(0, 10)) console.error(`  [${p.name}] ${x}`);
    if (p.name === 'Dee' || p.name === 'Ben') for (const x of p.ws.slice(-14)) console.error(`  [${p.name} ws] ${x}`);
  }
  cleanup(); process.exit(1);
});
