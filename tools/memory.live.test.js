#!/usr/bin/env node
// Live check of the memory layer against the real Supermemory API (v5). Runs ONLY when a key is
// present (SUPERMEMORY_API_KEY in the environment or in the project's .env); otherwise it skips.
//
//   node tools/memory.live.test.js [--run live1] [--read-only] [--quiet]
//
// Every namespace it touches starts with hopshot_dev_test_ (never a real player's), and it never
// deletes anything. Namespaces: hopshot_dev_test_<run>_vega, hopshot_dev_test_<run>_brick (two
// fake players with clearly different play styles) and hopshot_dev_test_<run>_game (a scripted
// match through the real game code path: Room -> MemoryRoom -> MemoryService -> API).
//
// What it does:
//   1. writes 5 realistic match summaries per fake player (server/memory/text.js, dreaming 'instant',
//      the player's supportingContext) and the structured state document, then waits until
//      Supermemory has extracted the memories (dreamingStatus done)
//   2. prints every extracted memory, the namespace's supportingContext and the profile
//   3. runs the game's three hybrid searches and checks that the facts the suggestions rely on come
//      back for the right player (Vega: Kestrel / Skyline / CTF with Orin; Brick: shotguns up close,
//      Maul losing at long range)
//   4. reads the state document back and checks the JSON in metadata is byte-identical
//   5. plays one scripted AI-bot match in-process with the real API and checks its summary + state landed
// The key is only read from process.env and never printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.SUPERMEMORY_API_KEY && typeof process.loadEnvFile === 'function' && fs.existsSync(path.join(ROOT, '.env'))) {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* ignore */ }
}
if (!process.env.SUPERMEMORY_API_KEY) { console.log('memory.live.test: SKIPPED (no SUPERMEMORY_API_KEY)'); process.exit(0); }

process.env.COUNTDOWN_MS = '200'; process.env.RESULTS_MS = '300'; process.env.BOTS = '0';
const { createSupermemoryClient } = await import('../server/memory/api.js');
const { entityContext, matchSummary } = await import('../server/memory/text.js');
const { STATE_DOC_ID, freshState, foldMatch, parseState } = await import('../server/memory/state.js');
const M = await import('../server/memory/index.js');
const { GUNS } = await import('../shared/weapons.js');

const args = process.argv.slice(2);
const RUN = args.includes('--run') ? args[args.indexOf('--run') + 1].replace(/[^a-z0-9]/gi, '') : 'live1';
const READ_ONLY = args.includes('--read-only');
const QUIET = args.includes('--quiet');
const PREFIX = `hopshot_dev_test_${RUN}_`;
const api = createSupermemoryClient({ apiKey: process.env.SUPERMEMORY_API_KEY });
const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gun = (k) => GUNS.find((g) => g.key === k).id;
const MASK = { optic: 1, extmag: 2, heavy: 4, barrel: 8, stock: 16, quick: 32 };

// ------------------------------------------------------------------ two fake players
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
function dists(n, lo, hi) { return Array.from({ length: n }, () => Math.round(lo + rnd() * (hi - lo))); }

function vegaMatch(i) {
  // sniper: Kestrel + Prism Optic dominant at long range, wins CTF on Skyline with Orin, dies up close to shotguns
  const maps = ['skyline', 'skyline', 'prism_yard', 'skyline', 'maple_street'];
  const mode = i === 2 || i === 4 ? 'tdm' : 'ctf';
  const kk = ri(8, 12), mk = ri(2, 4);
  const won = i !== 4;
  return {
    nick: 'Vega', date: `2026-11-0${3 + i}`, mode, mapId: maps[i], private: true, durationS: ri(330, 560), team: 'a', coop: false,
    result: won ? 'won' : 'lost', teamScore: mode === 'ctf' ? (won ? 3 : 1) : (won ? 50 : 41), enemyScore: mode === 'ctf' ? (won ? 1 : 3) : (won ? 38 : 50),
    scoreUnit: mode === 'ctf' ? 'captures' : 'kills', kills: kk + mk, deaths: ri(6, 9), obj: mode === 'ctf' ? ri(1, 2) : 0,
    teammates: [{ name: 'Orin', bot: false }, { name: 'Rook', bot: true }, { name: 'Moss', bot: true }], botLevel: 'ai',
    guns: [
      { gun: gun('kestrel'), mask: MASK.optic | MASK.stock, shots: ri(30, 45), hits: ri(17, 24), kills: kk, killDists: dists(kk, 32, 55), deaths: [ri(2, 4), 1, 0] },
      { gun: gun('vireo'), mask: MASK.extmag, shots: ri(60, 90), hits: ri(14, 22), kills: mk, killDists: dists(mk, 12, 22), deaths: [ri(1, 2), 1, 0] },
    ],
    deathsBy: [{ gun: gun('breaker'), bands: [ri(2, 3), 0, 0] }, { gun: gun('squall'), bands: [ri(1, 2), 0, 0] }, { gun: gun('maul'), bands: [0, ri(1, 2), 0] }],
    fell: 0, beat: { Pixel: ri(2, 4), Nova: ri(1, 3) }, lostTo: { Rook: ri(2, 3) },
    skill: { before: 0.7 + i * 0.04, after: 0.74 + i * 0.04, wins: kk + mk - 2, losses: ri(5, 7) },
  };
}
function brickMatch(i) {
  // close-range brawler: Squall / Breaker win on Crate Cove + Metro Line, Maul loses at long range, struggles on Skyline
  const maps = ['crate_cove', 'metro_line', 'crate_cove', 'skyline', 'crate_cove'];
  const sky = maps[i] === 'skyline';
  const sk = sky ? ri(2, 3) : ri(9, 13), mk = ri(1, 2);
  const won = !sky && i !== 1;
  return {
    nick: 'Brick', date: `2026-11-0${3 + i}`, mode: 'ffa', mapId: maps[i], private: false, durationS: 300, team: '', coop: false,
    result: won ? 'won' : 'lost', place: won ? 1 : ri(3, 6), players: 8, teamScore: sk + mk, enemyScore: 0, scoreUnit: 'kills',
    kills: sk + mk, deaths: sky ? ri(11, 14) : ri(6, 8), obj: 0, teammates: [{ name: 'Juno', bot: false }], botLevel: 'hard',
    guns: [
      { gun: gun('squall'), mask: MASK.extmag | MASK.heavy, shots: ri(40, 60), hits: ri(30, 44), kills: sk, killDists: dists(sk, 2, 8), deaths: [1, 0, 0] },
      { gun: gun('maul'), mask: 0, shots: ri(60, 80), hits: ri(9, 14), kills: mk, killDists: dists(mk, 14, 24), deaths: [0, ri(1, 2), sky ? ri(6, 8) : ri(3, 4)] },
    ],
    deathsBy: [{ gun: gun('kestrel'), bands: [0, 0, sky ? ri(5, 7) : ri(2, 3)] }, { gun: gun('halberd'), bands: [0, 0, ri(1, 2)] }, { gun: gun('vireo'), bands: [0, ri(1, 2), 0] }],
    fell: sky ? 1 : 0, beat: {}, lostTo: {}, skill: null,
  };
}

async function waitDone(ns, ids, maxMs = 240000) {
  const t0 = Date.now();
  const pending = new Set(ids);
  while (pending.size && Date.now() - t0 < maxMs) {
    for (const id of [...pending]) {
      const d = await api.getDocument(ns, id).catch(() => null);
      const s = d && d.system;
      if (s && s.status === 'done' && s.dreamingStatus === 'done') pending.delete(id);
      else if (s && s.status === 'failed') { console.log(`    ${id}: processing FAILED`); pending.delete(id); }
    }
    if (pending.size) await sleep(3000);
  }
  return { ms: Date.now() - t0, left: pending.size };
}

async function writePlayer(nick, build) {
  const ns = PREFIX + nick.toLowerCase();
  const state = freshState();
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const d = build(i);
    const id = `match-${d.date.replace(/-/g, '')}-${RUN}${i}`;
    ids.push(id);
    // exactly what the server does: fold the match into the state, then write the summary with the totals
    foldMatch(state, { id: RUN + i, mode: d.mode, mapId: d.mapId, result: d.result, team: d.team, nick, ai: d.botLevel === 'ai',
      guns: d.guns.map((g) => ({ ...g, killBands: [g.killDists.filter((x) => x < 10).length, g.killDists.filter((x) => x >= 10 && x < 30).length, g.killDists.filter((x) => x >= 30).length] })),
      skill: d.skill ? { v: d.skill.after, n: 20 * (i + 1), t: '1101101101' } : null,
      mates: d.team ? d.teammates.filter((t) => !t.bot).map((t) => t.name) : [], deathsBy: d.deathsBy, beat: d.beat, lostTo: d.lostTo });
    const content = matchSummary(d, state);
    if (!READ_ONLY) {
      await api.addDocument(ns, { id, content, dreaming: 'instant', supportingContext: entityContext(nick),
        metadata: { kind: 'match', mode: d.mode, map: d.mapId, result: d.result, kills: d.kills, deaths: d.deaths, ai: d.botLevel === 'ai' }, date: `${d.date}T20:00:00.000Z` });
    }
    if (i === 4 && !QUIET) console.log(`    last summary for ${nick}:\n      ` + content.split('\n').join('\n      '));
  }
  const json = JSON.stringify(state);
  if (!READ_ONLY) await api.addDocument(ns, { id: STATE_DOC_ID, taskType: 'superrag', content: 'Hopshot game-server state for this player (machine-readable numbers in metadata; not a match).', metadata: { kind: 'state', v: 1, state: json } });
  return { ns, ids, json };
}

function textOf(results) { return (results || []).filter((r) => !(r.metadata && r.metadata.kind === 'state')).map((r) => r.memory || r.chunk || ''); }
const has = (texts, ...words) => texts.some((t) => words.every((w) => t.toLowerCase().includes(w)));

// ------------------------------------------------------------------ run
const T0 = Date.now();
console.log(`memory live test (run "${RUN}", namespaces ${PREFIX}*)${READ_ONLY ? ' [read-only]' : ''}`);
console.log('\n== write summaries (instant) + state documents ==');
const vega = await writePlayer('Vega', vegaMatch);
const brick = await writePlayer('Brick', brickMatch);
const w1 = await waitDone(vega.ns, vega.ids), w2 = await waitDone(brick.ns, brick.ids);
check(w1.left === 0 && w2.left === 0, `all 10 summaries processed (status + dreaming done) in ${Math.round(Math.max(w1.ms, w2.ms) / 1000)} s`);

for (const p of [vega, brick]) {
  console.log(`\n== ${p.ns}: extracted memories ==`);
  const nsInfo = await api.getNamespace(p.ns);
  check(nsInfo && typeof nsInfo.supportingContext === 'string' && nsInfo.supportingContext.includes('Hopshot'), `supportingContext stored on the namespace (${nsInfo && nsInfo.supportingContext ? nsInfo.supportingContext.length : 0} chars)`);
  const list = await api.listMemories(p.ns, 100);
  const mems = (list && list.memories) || [];
  for (const m of mems) console.log(`    - ${m.memory}${m.isStatic ? '  [static]' : ''}${m.isInference ? '  [inferred]' : ''}`);
  check(mems.length >= 10, `${mems.length} memories extracted`);
  const prof = await api.profile(p.ns);
  if (prof && prof.profile) {
    console.log(`    profile: ${prof.profile.static.length} static, ${prof.profile.dynamic.length} dynamic`);
    for (const s of prof.profile.static.slice(0, 8)) console.log(`      static: ${s.memory || s}`);
  }
  const st = await api.getDocument(p.ns, STATE_DOC_ID);
  check(st && st.metadata && (READ_ONLY || st.metadata.state === p.json) && parseState(st.metadata.state), `state document: metadata.state reads back ${READ_ONLY ? '' : 'byte-identical '}and parses`);
}

console.log('\n== hybrid searches (the queries the game runs) ==');
const searches = {};
for (const p of [vega, brick]) {
  searches[p.ns] = {};
  for (const [k, q] of Object.entries(M.SEARCH_QUERIES)) {
    const r = await api.search(p.ns, q, { limit: 8, threshold: 0.3 });
    const t = textOf(r && r.results);
    searches[p.ns][k] = t;
    if (!QUIET) {
      console.log(`  ${p.ns} / ${k}: "${q}"`);
      for (const x of t.slice(0, 5)) console.log(`      ${x.replace(/\s+/g, ' ').slice(0, 170)}`);
    }
  }
}
const V = searches[vega.ns], B = searches[brick.ns];
check(has(V.guns, 'kestrel') && (has(V.guns, 'kestrel', 'skyline') || has(V.guns, 'kestrel', 'long')), 'Vega / guns query: Kestrel (on Skyline / at long range) comes back');
check(has(V.weak, 'close') && (has(V.weak, 'breaker') || has(V.weak, 'shotgun') || has(V.weak, 'squall')), 'Vega / weak query: dying up close to shotguns comes back');
check(has(V.group, 'orin') || has(V.group, 'capture the flag', 'skyline') || has(V.group, 'ctf', 'skyline'), 'Vega / group query: CTF on Skyline (with Orin) comes back');
check(has(B.guns, 'squall') || has(B.guns, 'breaker'), 'Brick / guns query: the shotgun comes back');
check(has(B.weak, 'maul', 'long') || has(B.weak, 'long range'), 'Brick / weak query: losing at long range (Maul) comes back');
check(!has(V.guns.concat(V.weak, V.group), 'brick') && !has(B.guns.concat(B.weak, B.group), 'vega'), 'no cross-player leakage between namespaces');

// ------------------------------------------------------------------ the real game code path
if (!READ_ONLY) {
  console.log('\n== one scripted AI-bot match through Room -> MemoryService -> API ==');
  const { Room } = await import('../server/room.js');
  const { Bot } = await import('../server/bots.js');
  const { MAPS } = await import('../shared/maps/index.js');
  Bot.prewarm(MAPS, true);
  const mem = M.createMemory({ apiKey: process.env.SUPERMEMORY_API_KEY, prefix: PREFIX + 'game_' }, { log: (...a) => console.log('    [memory]', ...a) });
  const room = new Room('live', { isPrivate: true, memory: mem, config: { mode: 'ffa', mapId: 'crate_cove', bots: { fill: 4, level: 'ai' }, timeLimitS: 90 } });
  const ws = { readyState: 1, bufferedAmount: 0, send() {}, terminate() {} };
  const code = 'LiveTest_' + RUN + '_0123456789abcdefghijklmnop';
  const p = room.addHuman(ws, 'Scripted', undefined, code);
  for (let i = 0; i < 300 && p.mem.rec.status === 'loading'; i++) await sleep(20);
  const b = new Bot(room, p); b.ai = null; b.fixedLevel = { skill: 1, decay: 0.97, sway: 0.012, turn: 0.3, view: 70, burst: 1 }; b.skill = 0.96; p.botBrain = b;
  room.requestStart(p);
  for (let i = 0; i < 60 * 95; i++) room.step();
  await new Promise((r) => setImmediate(r));
  await mem.flush();
  const tag = mem.tagFor(code);
  check(tag.startsWith(PREFIX + 'game_'), `tag ${tag}`);
  const st = await api.getDocument(tag, STATE_DOC_ID);
  const parsed = st && parseState(st.metadata.state);
  check(parsed && parsed.n >= 1 && parsed.sk && Math.abs(parsed.sk.v - p.mem.skill.v) < 0.002, `state written by the game: ${parsed ? parsed.n : 0} match(es), skill ${parsed && parsed.sk ? parsed.sk.v : '-'}`);
  check(mem.stats.summaries >= 1 && mem.stats.writeFailures === 0, `summary written by the game (${mem.stats.summaries}), ${mem.stats.requests} requests, ${mem.stats.failures} failures`);
  room.destroy(); mem.close();
}

console.log(`\nnamespaces used: ${[vega.ns, brick.ns].join(', ')}${READ_ONLY ? '' : ', ' + PREFIX + 'game_<hash>'}`);
console.log(`RESULT: ${failures.length ? failures.length + ' FAILED' : 'all live memory checks passed'} (${Math.round((Date.now() - T0) / 1000)} s)`);
for (const f of failures) console.log('  - ' + f);
process.exit(failures.length ? 1 : 0);
