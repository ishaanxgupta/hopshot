#!/usr/bin/env node
// The optional memory layer in a real browser: headless Chrome over the DevTools protocol (same
// minimal CDP client as tools/voice.browser.test.js; no extra dependencies).
//
//   node tools/memory.browser.test.js [--port 3113] [--live] [--code <player code>] [--chrome PATH] [--out DIR]
//
// Memory ON (default: SUPERMEMORY_MOCK=1; --live: the real Supermemory API with the key from the
// environment / .env and the container tag prefix hopshot_dev_test_browser_, history seeded first
// through the real game code path when the code has fewer than 3 recorded matches):
//   - the menu learns memory is on from /health and shows the Player code settings group; a code is
//     pasted there (the real UI) and used for the join
//   - the private-room lobby offers the AI bot level; (live, with history) the host sees the suggested
//     mode + map with its reason, taps it to apply, and the Loadout tab shows its tip line
//   - a short match with AI bots and ?autoplay=1 is played; the server writes the match summary and the
//     state (checked in /status and, live, by reading the state document back from Supermemory)
//   - after a reload the suggestions are there again
// Memory OFF (MEMORY_ENABLED=0): no Player code group, no AI option, no suggestions, a match still runs.
// Every page's console errors / exceptions fail the test. Screenshots go to --out.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const PORT = parseInt(arg('port', '3113'), 10);
const CDP_PORT = PORT + 6200;
const LIVE = args.includes('--live');
const CHROME = arg('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'hopshot-memory')));
const BASE = `http://127.0.0.1:${PORT}`;
const PREFIX = 'hopshot_dev_test_browser_';
const CODE = arg('code', 'BrowserTest_' + Math.random().toString(36).slice(2, 14) + '_hopshot_dev');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

if (LIVE && !process.env.SUPERMEMORY_API_KEY && typeof process.loadEnvFile === 'function' && fs.existsSync(path.join(ROOT, '.env'))) {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* ignore */ }
}
if (LIVE && !process.env.SUPERMEMORY_API_KEY) { console.log('memory.browser.test --live: SKIPPED (no SUPERMEMORY_API_KEY)'); process.exit(0); }

let server = null, chrome = null, profile = null;
function stopServer() { if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); server = null; }
function cleanup() {
  stopServer();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGKILL');
  if (profile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

async function waitHttp(url, ms) {
  for (let t = 0; t < ms; t += 100) { try { const r = await fetch(url); if (r.ok) return r; } catch { /* not yet */ } await sleep(100); }
  throw new Error('timeout waiting for ' + url);
}
async function startServer(memory) {
  const env = { ...process.env, HOPSHOT_DOTENV: '0', PORT: String(PORT), BOTS: '0', COUNTDOWN_MS: '1500', RESULTS_MS: '3000' };
  if (memory) {
    env.MEMORY_ENABLED = '1'; env.MEMORY_TAG_PREFIX = PREFIX;
    if (!LIVE) env.SUPERMEMORY_MOCK = '1';
  } else env.MEMORY_ENABLED = '0';
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { if (/memory|error/i.test(String(d))) process.stdout.write(`    [server] ${d}`); });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitHttp(`${BASE}/status`, 15000);
}
async function startChrome() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hopshot-chrome-'));
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
    '--window-size=1280,720', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', () => {});
  const r = await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`, 15000);
  return (await r.json()).webSocketDebuggerUrl;
}

// ------------------------------------------------------------------ minimal CDP client (as in voice.browser.test.js)
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
async function openPage(cdp, name, url, w = 1180, h = 664) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);
  const page = { name, targetId, sessionId, send, errors: [] };
  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') page.errors.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') page.errors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon\.ico/.test(m.params.entry.url || '')) page.errors.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  page.eval = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  page.go = async (u) => { await send('Page.navigate', { url: u }); await sleep(300); };
  return page;
}
async function shot(page, file) {
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, file);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}
async function click(page, selector) {
  const box = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
  if (!box || !box.w) throw new Error(`${page.name}: ${selector} not clickable`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(120);
}
async function typeInto(page, selector, text) {
  await click(page, selector);
  await page.send('Input.insertText', { text });
}
async function until(desc, fn, ms = 15000, every = 250) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
    await sleep(every);
  }
  throw new Error(`timeout: ${desc} (last: ${JSON.stringify(last)})`);
}
let failures = 0;
async function check(name, fn) {
  try { const info = await fn(); console.log(`  ok    ${name}${info ? '  ' + info : ''}`); } catch (e) { failures++; console.log(`  FAIL  ${name}\n        ${e && e.message}`); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };
const visible = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.hidden) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'; })()`;
const text = (sel) => `(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`;
const status = async () => (await (await fetch(`${BASE}/status`)).json());

// ------------------------------------------------------------------ live: history + read-back
let api = null, tag = '';
async function liveSetup() {
  const M = await import('../server/memory/index.js');
  const { createSupermemoryClient } = await import('../server/memory/api.js');
  api = createSupermemoryClient({ apiKey: process.env.SUPERMEMORY_API_KEY });
  tag = M.tagForCode(CODE, PREFIX);
  const n = await storedMatches();
  if (n >= 3) { console.log(`  history: ${n} recorded matches for ${tag}`); return; }
  console.log(`  seeding history for ${tag} through the real game code path (${4 - n} matches)...`);
  process.env.COUNTDOWN_MS = '200'; process.env.RESULTS_MS = '300'; process.env.BOTS = '0';
  const { Room } = await import('../server/room.js');
  const { Bot } = await import('../server/bots.js');
  const { MAPS } = await import('../shared/maps/index.js');
  Bot.prewarm(MAPS, true);
  const mem = M.createMemory({ apiKey: process.env.SUPERMEMORY_API_KEY, prefix: PREFIX }, { log: (...a) => console.log('    [memory]', ...a) });
  const ws = { readyState: 1, bufferedAmount: 0, send() {}, terminate() {} };
  for (let i = n; i < 4; i++) {
    const room = new Room('seed' + i, { isPrivate: true, memory: mem, config: { mode: 'ffa', mapId: 'crate_cove', bots: { fill: 4, level: i === 3 ? 'ai' : 'easy' }, timeLimitS: 150 } });
    const p = room.addHuman(ws, 'Tester', 0, CODE);
    for (let k = 0; k < 400 && p.mem.rec.status === 'loading'; k++) await sleep(20);
    const b = new Bot(room, p); b.ai = null; b.fixedLevel = { skill: 1, decay: 0.97, sway: 0.012, turn: 0.3, view: 70, burst: 1 }; b.skill = 0.96; p.botBrain = b;
    room.requestStart(p);
    for (let t = 0; t < 60 * 155; t++) room.step();
    await new Promise((r) => setImmediate(r)); await mem.flush();
    room.destroy();
  }
  mem.close();
  console.log(`  history: ${await storedMatches()} recorded matches`);
}
async function storedMatches() {
  const { parseState, STATE_DOC_ID } = await import('../server/memory/state.js');
  const d = await api.getDocument(tag, STATE_DOC_ID);
  const st = d && d.metadata && parseState(d.metadata.state);
  return st ? st.n : 0;
}

// ------------------------------------------------------------------ run
async function memoryOn(cdp) {
  console.log(`\n== memory ON (${LIVE ? 'real Supermemory API, prefix ' + PREFIX : 'in-process mock store'}) ==`);
  if (LIVE) await liveSetup();
  await startServer(true);
  const before = LIVE ? await storedMatches() : 0;
  const room = 'mem' + Math.floor(Math.random() * 1e6).toString(36);
  const P = await openPage(cdp, 'Tester', `${BASE}/health`);
  // the low graphics preset keeps software WebGL (SwiftShader) light
  await until('health page', () => P.eval(`location.pathname === '/health'`), 10000);
  await P.eval(`localStorage.setItem('hopshot.settings', JSON.stringify({ quality: 'low' })), true`);
  await P.go(`${BASE}/?name=Tester`);
  await check('menu: /health says memory is on -> Player code group in Settings', async () => {
    await until('settings', () => P.eval(`!!document.querySelector('.hs-pcode') && !document.querySelector('.hs-pcode').hidden`), 15000);
    await click(P, '.hs-tabs [data-tab=settings]');
    await click(P, '.hs-pcode summary');
    const masked = await P.eval(`document.querySelector('.hs-pcval').type === 'password' && document.querySelector('.hs-pcval').value.length >= 43`);
    assert(masked, 'own generated code shown masked');
    await shot(P, 'mem-settings-player-code.png');
    return 'generated code shown masked, Show / Copy / paste';
  });
  await check('paste a player code from "another device" (the Settings UI)', async () => {
    await typeInto(P, '.hs-pcin', CODE);
    const typed = await P.eval(`document.querySelector('.hs-pcin').value`);
    await click(P, '.hs-pcuse');
    const msg = await P.eval(text('.hs-pcmsg'));
    const stored = await P.eval(`JSON.parse(localStorage.getItem('hopshot.playerCode'))`);
    assert(stored === CODE, `stored ${stored}, typed "${typed}", message "${msg}"`);
    return `"${msg}"`;
  });
  await P.go(`${BASE}/?room=${room}&play=1&name=Tester&autoplay=1`);
  await until('connected', () => P.eval('!!(window.__hopshot && window.__hopshot.connected)'), 20000);
  await check('lobby: AI bot level offered (memory on)', async () => {
    await until('lobby', () => P.eval(visible('.lb-start')), 10000);
    assert(await P.eval('window.__hopshot.memory.enabled === true'), 'welcome memory');
    await click(P, '.lb-chip[data-k=bots]');
    await click(P, '.lb-seg [data-b=fill]');
    assert(await P.eval(visible('.lb-ai')), 'AI button visible');
    await click(P, '.lb-ai');
    await until('level ai', () => P.eval(`window.__hopshot.match.config.bots.level === 'ai'`), 5000);
    await click(P, '.lb-title');                  // a tap outside closes the popover
    return `chip "${await P.eval(text('.lb-chip[data-k=bots] span'))}"`;
  });
  if (LIVE) {
    await check('lobby: the host sees a suggested mode + map with its reason (from history)', async () => {
      const t = await until('suggestion', async () => (await P.eval(visible('.lb-sug'))) && P.eval(`document.querySelector('.lb-sug').textContent`), 15000);
      assert(/won \d+ of \d+/.test(t), t);
      await shot(P, 'mem-lobby-suggestion.png');
      return `"${t.replace(/\s+/g, ' ').trim()}"`;
    });
    await check('tap the suggestion -> config applied, suggestion goes away', async () => {
      const h = await P.eval('window.__hopshot.memory.host');
      await click(P, '.lb-sug');
      await until('applied', () => P.eval(`(() => { const c = window.__hopshot.match.config; return c.mode === ${JSON.stringify(h.mode)} && c.mapId === ${JSON.stringify(h.mapId)}; })()`), 5000);
      await until('hidden', async () => !(await P.eval(visible('.lb-sug'))), 5000);
      return `${h.mode} on ${h.mapId}`;
    });
    await check('Loadout tab: one tip line from history', async () => {
      await click(P, '.lb-loadout');
      const t = await until('tip', async () => (await P.eval(visible('.hs-lo-hint'))) && P.eval(text('.hs-lo-hint')), 8000);
      await shot(P, 'mem-loadout-tip.png');
      await click(P, '.hs-lo-play');                // back to the lobby
      await until('menu closed', async () => !(await P.eval(visible('.hs-menu.on'))), 5000);
      return `"${t}"`;
    });
  } else {
    await check('no history -> no suggestions (never made up)', async () => {
      await sleep(1500);
      const m = await P.eval('window.__hopshot.memory');
      assert(!m.host && !m.lobby && !m.loadout && !(await P.eval(visible('.lb-sug'))) && !(await P.eval(visible('.lb-tip'))), JSON.stringify(m));
      return 'host / lobby / loadout empty';
    });
  }
  const st0 = await status();
  await check('play a short match with AI bots (?autoplay=1)', async () => {
    await P.eval(`window.__hopshot.net.setMatchConfig({ timeLimitS: 60 }), true`);
    await sleep(500);
    await click(P, '.lb-start');
    await until('playing', () => P.eval(`window.__hopshot.match.phase === 'playing'`), 15000);
    const bots = await P.eval(`window.__hopshot.match.lobby.filter((p) => p.bot).length`);
    await sleep(8000);
    await shot(P, 'mem-match.png');
    await until('results', () => P.eval(`window.__hopshot.match.phase === 'results' || window.__hopshot.match.phase === 'lobby'`), 90000, 1000);
    const k = await P.eval(`(() => { const r = window.__hopshot.match.result; const me = r && r.rows.find((x) => x.id === window.__hopshot.net.state.id); return me ? me.kills + '/' + me.deaths : '?'; })()`);
    return `${bots} AI bots, Tester K/D ${k}`;
  });
  await check('the server wrote the match summary + state', async () => {
    const st = await until('written', async () => { const s = await status(); return s.memory.summaries > st0.memory.summaries && s.memory.stateWrites > st0.memory.stateWrites ? s : null; }, 30000, 500);
    let extra = '';
    if (LIVE) {
      const n = await until('state n', async () => { const n = await storedMatches(); return n > before ? n : null; }, 20000, 1000);
      extra = `; Supermemory state document now has ${n} matches (was ${before})`;
    }
    return `summaries ${st.memory.summaries}, state writes ${st.memory.stateWrites}, failures ${st.memory.writeFailures}${extra}`;
  });
  await check('reload -> suggestions appear again', async () => {
    await P.go(`${BASE}/?room=${room}x&play=1&name=Tester&autoplay=1`);
    await until('connected', () => P.eval('!!(window.__hopshot && window.__hopshot.connected)'), 20000);
    if (!LIVE) { await sleep(1500); return 'mock: 1 match recorded, below the 3-match threshold -> ' + JSON.stringify(await P.eval('window.__hopshot.memory')); }
    const m = await until('memory', async () => { const m = await P.eval('window.__hopshot.memory'); return m.host || m.loadout ? m : null; }, 15000);
    await until('drawn', () => P.eval(visible('.lb-sug')), 5000).catch(() => {});
    await shot(P, 'mem-lobby-after-reload.png');
    return JSON.stringify({ host: m.host && m.host.text, lobby: m.lobby, loadout: m.loadout });
  });
  await check('no console errors (memory on)', async () => { assert(!P.errors.length, P.errors.slice(0, 5).join(' | ')); return ''; });
  await cdp.send('Target.closeTarget', { targetId: P.targetId });
  stopServer();
  await sleep(500);
}

async function memoryOff(cdp) {
  console.log('\n== memory OFF (MEMORY_ENABLED=0) ==');
  await startServer(false);
  const room = 'off' + Math.floor(Math.random() * 1e6).toString(36);
  const P = await openPage(cdp, 'Off', `${BASE}/?name=Offy`);
  await check('menu: no Player code group', async () => {
    await until('health', () => P.eval(`document.querySelector('.hs-server').dataset.state === 'online'`), 15000);
    assert(await P.eval(`document.querySelector('.hs-pcode').hidden === true`), 'hidden');
    const h = await (await fetch(`${BASE}/health`)).json();
    assert(h.memory === undefined, '/health has no memory flag');
    return '';
  });
  await P.go(`${BASE}/?room=${room}&play=1&name=Offy&autoplay=1`);
  await until('connected', () => P.eval('!!(window.__hopshot && window.__hopshot.connected)'), 20000);
  await check('lobby: no AI option, no suggestions', async () => {
    await until('lobby', () => P.eval(visible('.lb-start')), 10000);
    await click(P, '.lb-chip[data-k=bots]');
    await click(P, '.lb-seg [data-b=fill]');
    assert(!(await P.eval(visible('.lb-ai'))), 'AI button must be hidden');
    const lv = await P.eval(`[...document.querySelectorAll('.lb-lvl button')].filter((b) => !b.hidden).map((b) => b.textContent).join(',')`);
    assert(lv === 'Easy,Normal,Hard', lv);
    assert(!(await P.eval(visible('.lb-sug'))) && !(await P.eval(visible('.lb-tip'))), 'suggestion UI hidden');
    assert((await P.eval('window.__hopshot.memory.enabled')) === false, 'memory flag');
    // a hand-made 'ai' request is downgraded by the server
    await P.eval(`window.__hopshot.net.setMatchConfig({ bots: { fill: 4, level: 'ai' } }), true`);
    await sleep(800);
    const level = await P.eval('window.__hopshot.match.config.bots.level');
    assert(level === 'hard', 'level ' + level);
    await click(P, '.lb-title');
    await shot(P, 'off-lobby.png');
    return `levels ${lv}; 'ai' request -> ${level}`;
  });
  await check('a match still runs as before', async () => {
    await P.eval(`window.__hopshot.net.setMatchConfig({ timeLimitS: 20 }), true`);
    await sleep(500);
    await click(P, '.lb-start');
    await until('playing', () => P.eval(`window.__hopshot.match.phase === 'playing'`), 15000);
    await until('results', () => P.eval(`window.__hopshot.match.phase === 'results' || window.__hopshot.match.phase === 'lobby'`), 45000, 1000);
    const s = await status();
    assert(s.memory.enabled === false, 'status memory');
    return 'playing -> results; /status memory.enabled false';
  });
  await check('no console errors (memory off)', async () => { assert(!P.errors.length, P.errors.slice(0, 5).join(' | ')); return ''; });
  stopServer();
}

async function main() {
  console.log(`memory browser test (${LIVE ? 'live' : 'mock'}), server :${PORT}, screenshots -> ${OUT}`);
  const cdp = await connectCdp(await startChrome());
  await memoryOn(cdp);
  await memoryOff(cdp);
  console.log(`\nRESULT: ${failures ? failures + ' FAILED' : 'all memory browser checks passed'}`);
  if (LIVE) console.log(`(test namespace: ${tag})`);
  cleanup();
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); cleanup(); process.exit(1); });
