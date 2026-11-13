#!/usr/bin/env node
// Optional memory layer (protocol v6): offline, deterministic where it matters, no network.
//
//   node tools/memory.test.js [--quick]
//
// Uses the in-process mock store (server/memory/api.js createMockClient) and Rooms driven tick by
// tick with fake sockets. Covers: identity hashing (the code never leaves the server, tags are
// stable), flag off (no calls, 'ai' downgraded, no memory messages), the Supermemory client
// (instant ingestion, hybrid search, entity context, retries, no key in errors), adaptive skill
// (a strong and a weak scripted human: the estimate moves the right way and K/D vs AI bots
// settles near 1), grudges (target priority, hunting, longer chase, returning bot names),
// persistence of skill + grudges across a simulated server restart, the match summary and entity
// context, suggestions only with enough history (exact counts), and a failed load never
// overwriting stored state.

process.env.COUNTDOWN_MS = '200';
process.env.PUBLIC_COUNTDOWN_MS = '200';
process.env.RESULTS_MS = '300';
process.env.BOTS = '0';

const { Room } = await import('../server/room.js');
const { Bot } = await import('../server/bots.js');
const { MAPS } = await import('../shared/maps/index.js');
const { sanitizeMatchConfig } = await import('../shared/modes.js');
const { GUNS } = await import('../shared/weapons.js');
const M = await import('../server/memory/index.js');
const { createMockStore, createMockClient, createSupermemoryClient } = await import('../server/memory/api.js');
const { SkillTracker, aiParams, grudgeStrength, updateGrudges, SKILL_DEFAULT } = await import('../server/memory/ai.js');
const { entityContext, matchSummary } = await import('../server/memory/text.js');
const { STATE_DOC_ID, freshState, parseState, foldMatch } = await import('../server/memory/state.js');
const { hostSuggestion, lobbyTip, loadoutTip } = await import('../server/memory/suggest.js');

const QUICK = process.argv.includes('--quick');
const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); };
const section = (s) => console.log(`\n== ${s} ==`);
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const T0 = performance.now();

Bot.prewarm(MAPS, true);

const CODE_A = 'Aq1-Zx9_Wv8Ut7Sr6Qp5On4Ml3Kj2Ih1Gf0Ed9Cb8a';    // 43 chars, like a real 32-byte code
const CODE_B = 'Bq1-Zx9_Wv8Ut7Sr6Qp5On4Ml3Kj2Ih1Gf0Ed9Cb8b';
const CODE_C = 'Cq1-Zx9_Wv8Ut7Sr6Qp5On4Ml3Kj2Ih1Gf0Ed9Cb8c';
const gunId = (key) => GUNS.find((g) => g.key === key).id;

function fakeWs() {
  const msgs = [], raw = [];
  return { readyState: 1, bufferedAmount: 0, msgs, raw, send(m) { if (typeof m === 'string') { raw.push(m); msgs.push(JSON.parse(m)); } }, terminate() {} };
}
function human(room, name, code) {
  const ws = fakeWs();
  const p = room.addHuman(ws, name, undefined, code);
  return { p, ws, last(t) { for (let i = ws.msgs.length - 1; i >= 0; i--) if (ws.msgs[i].t === t) return ws.msgs[i]; return null; } };
}
function steps(room, n) { for (let i = 0; i < n; i++) { room.step(); if (room.destroyed) return; } }
const LV = {
  strong: { skill: 1.0, decay: 0.97, sway: 0.012, turn: 0.3, view: 70, burst: 1 },        // ~ Hard
  weak: { skill: 0.58, decay: 0.988, sway: 0.036, turn: 0.17, view: 48, burst: 0.6 },    // between Easy and Normal
};
/** Drive a human with a bot brain of a FIXED level (a scripted player; never adaptive). */
function script(room, p, level) {
  const b = new Bot(room, p);
  b.ai = null; b.fixedLevel = LV[level]; b.skill = 0.96;
  p.botBrain = b;
  return b;
}
function startNow(room, host) {
  const e = room.requestStart(host);
  if (e) throw new Error('start: ' + e);
  steps(room, 20);
  if (room.phase !== 'playing') throw new Error('not playing: ' + room.phase);
}
/** Count the human's kills of / deaths by AI bots (wraps room.kill). */
function kdCounter(room, p) {
  const c = { k: 0, d: 0 };
  const orig = room.kill.bind(room);
  room.kill = (victim, killer, w, hs, gun) => {
    if (room.phase === 'playing' && killer && killer !== victim) {
      if (killer === p && victim.bot) c.k++;
      if (victim === p && killer.bot) c.d++;
    }
    return orig(victim, killer, w, hs, gun);
  };
  return c;
}

// ------------------------------------------------------------------ identity + config
function testIdentity() {
  section('identity, container tags, config flag');
  const t1 = M.tagForCode(CODE_A), t2 = M.tagForCode(CODE_A), t3 = M.tagForCode(CODE_B);
  check(t1 === t2 && /^hopshot_player_[0-9a-f]{32}$/.test(t1), `tag is stable and derived: ${t1}`);
  check(t1 !== t3, 'different codes -> different tags');
  check(!t1.includes(CODE_A.slice(0, 8)) && !t1.toLowerCase().includes(CODE_A.slice(0, 8).toLowerCase()), 'tag does not contain the code');
  check(M.tagForCode('short') === null && M.tagForCode('has spaces in it but long enough 1234') === null && M.tagForCode(12345) === null, 'invalid codes -> no identity');
  check(M.tagForCode(CODE_A, 'hopshot_dev_test_x_').startsWith('hopshot_dev_test_x_'), 'MEMORY_TAG_PREFIX respected');
  check(M.memoryConfigFromEnv({}) === null, 'no env -> memory off');
  check(M.memoryConfigFromEnv({ MEMORY_ENABLED: '0', SUPERMEMORY_API_KEY: 'k' }) === null, 'MEMORY_ENABLED=0 -> off even with a key');
  const e = M.memoryConfigFromEnv({ MEMORY_ENABLED: '1' });
  check(e && e.error && M.createMemory(e) === null && !/sk_|key=/.test(e.error), 'MEMORY_ENABLED=1 without key -> stays off with a clear message');
  const ok = M.memoryConfigFromEnv({ MEMORY_ENABLED: '1', SUPERMEMORY_API_KEY: 'sk_dummy', MEMORY_TAG_PREFIX: 'hopshot_dev_test_' });
  check(ok && ok.prefix === 'hopshot_dev_test_' && !ok.mock, 'MEMORY_ENABLED=1 + key -> on (real API), prefix from env');
  check(M.memoryConfigFromEnv({ MEMORY_ENABLED: '1', SUPERMEMORY_MOCK: '1' }).mock === true, 'SUPERMEMORY_MOCK=1 -> mock store, no key needed');
  check(sanitizeMatchConfig({ bots: { fill: 6, level: 'ai' } }).bots.level === 'hard', "shared sanitiser: 'ai' -> 'hard' without allowAi");
  check(sanitizeMatchConfig({ bots: { fill: 6, level: 'ai' } }, null, { allowAi: true }).bots.level === 'ai', "shared sanitiser: 'ai' kept with allowAi");
  check(sanitizeMatchConfig({ mode: 'tdm' }, { ...sanitizeMatchConfig({}), bots: { fill: 4, level: 'ai' } }).bots.level === 'hard', "a previous 'ai' level falls back to 'hard' when not allowed");
}

async function testSecretNeverLeaves() {
  section('the player code never leaves the server');
  const store = createMockStore();
  const mem = M.createMemory({ mock: true, store }, { log: () => {} });
  const room = new Room('id', { isPrivate: true, memory: mem, config: { mode: 'ffa', bots: { fill: 4, level: 'ai' } } });
  const A = human(room, 'Ann', CODE_A), B = human(room, 'Ben', CODE_B);
  await settle();
  script(room, A.p, 'strong'); script(room, B.p, 'weak');
  room.requestConfig(A.p, { timeLimitS: 60 });
  startNow(room, A.p);
  steps(room, 60 * 62);
  await settle(); await mem.flush();
  const everything = JSON.stringify(store.log) + A.ws.raw.join('') + B.ws.raw.join('') + JSON.stringify([...store.namespaces.keys()]);
  check(!everything.includes(CODE_A) && !everything.includes(CODE_B), 'no request, stored document, namespace or message (to anyone) contains a player code');
  check(!Object.values(A.p).some((v) => v === CODE_A) && !JSON.stringify(A.p.mem, (k, v) => (k === 'rec' || k === 'sub' ? undefined : v)).includes(CODE_A), 'the player object keeps only the tag');
  check([...store.namespaces.keys()].every((n) => /^hopshot_player_[0-9a-f]{32}$/.test(n)), `only hashed namespaces were written (${store.namespaces.size})`);
  check(A.ws.msgs.find((m) => m.t === 'welcome').memory === true, 'welcome says memory: true');
  mem.close();
}

async function testFlagOff() {
  section('memory off: no calls, no AI bots, no suggestions');
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...a) => { calls++; return realFetch(...a); };
  try {
    const room = new Room('off', { isPrivate: true, config: { mode: 'ffa', bots: { fill: 4, level: 'ai' } } });
    check(room.config.bots.level === 'hard' && room.mem === null, "room without memory: initial 'ai' -> 'hard'");
    const A = human(room, 'Ann', CODE_A);
    check(room.requestConfig(A.p, { bots: { fill: 4, level: 'ai' } }) === null && room.config.bots.level === 'hard', "host asks for 'ai' -> downgraded to 'hard'");
    check(A.ws.msgs.find((m) => m.t === 'welcome').memory === false, 'welcome says memory: false');
    script(room, A.p, 'strong');
    room.requestConfig(A.p, { timeLimitS: 30 });
    startNow(room, A.p);
    steps(room, 60 * 32);
    await settle();
    check(room.players.filter((q) => q.bot).every((q) => q.botBrain.ai === null), 'bots are ordinary Hard bots (no AI state)');
    check(A.p.mem === undefined && A.p.aiL === undefined, 'no per-player memory state');
    check(!A.ws.msgs.some((m) => m.t === 'memory'), "no 'memory' messages");
    check(calls === 0, `no network calls during a whole match (${calls})`);
  } finally { globalThis.fetch = realFetch; }
}

// ------------------------------------------------------------------ Supermemory client (fake fetch)
async function testClient() {
  section('Supermemory v5 client (fake fetch): params, retries, no key in errors');
  const KEY = 'sm_TEST_SECRET_KEY_123';
  const seen = [];
  let fail = 2;
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    if (url.includes('/document') && init.method === 'POST' && fail-- > 0) return new Response('{"error":"busy"}', { status: 503 });
    if (url.includes('/nope')) return new Response(JSON.stringify({ error: 'Document not found' }), { status: 404 });
    if (url.includes('/denied')) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    return new Response(JSON.stringify({ id: 'x', status: 'queued', results: [] }), { status: 200 });
  };
  const api = createSupermemoryClient({ apiKey: KEY, fetchImpl });
  const t0 = performance.now();
  await api.addDocument('hopshot_dev_test_ns', { id: 'match-1', content: 'x', dreaming: 'instant', supportingContext: entityContext('Ann') });
  const posts = seen.filter((s) => s.method === 'POST');
  check(posts.length === 3, `503 twice then OK: retried (${posts.length} attempts, ${Math.round(performance.now() - t0)} ms)`);
  check(posts[0].url === 'https://api.supermemory.ai/ns/hopshot_dev_test_ns/document' && posts[0].auth === `Bearer ${KEY}`, 'POST /ns/{namespace}/document with Bearer auth');
  check(posts[0].body.dreaming === 'instant' && posts[0].body.supportingContext.length > 200, "add: dreaming 'instant' + supportingContext");
  seen.length = 0;
  await api.search('hopshot_dev_test_ns', 'Which guns?');
  check(seen[0].url.endsWith('/ns/hopshot_dev_test_ns/search') && seen[0].body.searchMode === 'hybrid' && seen[0].body.query === 'Which guns?', "search: POST /ns/{ns}/search with searchMode 'hybrid'");
  check((await api.getDocument('hopshot_dev_test_ns', 'nope')) === undefined, 'GET a missing document -> undefined (404 is not an error)');
  let msg = '';
  try { await api.getDocument('denied', 'x'); } catch (e) { msg = String(e.message) + String(e.stack); }
  check(msg.includes('401') === false && msg.includes('Unauthorized') && !msg.includes(KEY) && !msg.includes('denied'), `errors carry route + reason only: "${msg.split('\n')[0]}"`);
}

// ------------------------------------------------------------------ adaptive skill
function runAdaptive(level, minutes, mapId, botLevel = 'ai') {
  const mem = M.createMemory({ mock: true }, { log: () => {} });
  const room = new Room('ai-' + level, { isPrivate: true, memory: mem, config: { mode: 'ffa', mapId, bots: { fill: 4, level: botLevel }, timeLimitS: 3600, scoreLimit: 200 } });
  const H = human(room, 'Scripted', level === 'strong' ? CODE_A : CODE_B);
  script(room, H.p, level);
  const kd = kdCounter(room, H.p);
  startNow(room, H.p);
  const series = [];
  let firstHalf = null;
  const total = minutes * 3600;
  for (let i = 0; i < total; i++) {
    room.step();
    if (i % 3600 === 3599) series.push(+H.p.mem.skill.v.toFixed(3));
    if (i === Math.floor(total / 2)) firstHalf = { ...kd };
  }
  const second = { k: kd.k - firstHalf.k, d: kd.d - firstHalf.d };
  mem.close();
  return { s: H.p.mem.skill.v, series, kd: kd.k / Math.max(1, kd.d), k: kd.k, d: kd.d, kd2: second.k / Math.max(1, second.d), second, fights: H.p.mem.skill.n };
}

function testAdaptive() {
  section('adaptive difficulty (scripted humans vs AI bots, FFA, 1 human + 3 AI bots)');
  const s0 = new SkillTracker(null);
  for (let i = 0; i < 12; i++) s0.fight(true, { margin: 0.8, ttkS: 1, acc: 0.5 });
  const s1 = new SkillTracker(null);
  for (let i = 0; i < 12; i++) s1.fight(false, { margin: 0.8, ttkS: 1, acc: 0.1 });
  check(s0.v > SKILL_DEFAULT + 0.3 && s1.v < SKILL_DEFAULT - 0.3, `unit: wins raise, losses lower the estimate (${s0.v.toFixed(2)} / ${s1.v.toFixed(2)})`);
  const p0 = aiParams(0), p1 = aiParams(1), pm = aiParams(9);
  check(p0.skill === 0.45 && p1.skill === 1 && pm.skill <= 1.15 && pm.view <= 76, 'parameters span Easy .. Hard, capped a little above Hard');
  const minutes = QUICK ? 14 : 24;
  for (const [level, map] of [['strong', 'crate_cove'], ['weak', 'crate_cove'], ['strong', 'prism_yard'], ['weak', 'hollow_pines']]) {
    if (QUICK && map !== 'crate_cove') continue;
    const r = runAdaptive(level, minutes, map);
    console.log(`    ${level} on ${map}: skill per minute ${r.series.join(' ')}`);
    console.log(`    ${level} on ${map}: K/D vs AI ${r.kd.toFixed(2)} (${r.k}/${r.d}), second half ${r.kd2.toFixed(2)} (${r.second.k}/${r.second.d}), ${r.fights} fights`);
    if (level === 'strong') check(r.s > 0.7, `${map}: strong human -> estimate rose from ${SKILL_DEFAULT} to ${r.s.toFixed(2)}`);
    else check(r.s < 0.4, `${map}: weak human -> estimate fell from ${SKILL_DEFAULT} to ${r.s.toFixed(2)}`);
    check(r.kd > 0.75 && r.kd < 1.33, `${map}: ${level} human's K/D vs AI bots settles near 1 (${r.kd.toFixed(2)})`);
  }
  // control: the same strong scripted human against ordinary (non-adaptive) Normal bots
  const c = runAdaptive('strong', QUICK ? 8 : 12, 'crate_cove', 'normal');
  check(c.kd > 1.5, `control: vs fixed Normal bots the strong human's K/D is far from 1 (${c.kd.toFixed(2)}), so the adaptation is what levels it`);
}

// ------------------------------------------------------------------ grudges
function testGrudges() {
  section('grudges (AI bots)');
  const mem = M.createMemory({ mock: true }, { log: () => {} });
  const room = new Room('g', { isPrivate: true, memory: mem, config: { mode: 'ffa', mapId: 'crate_cove', bots: { fill: 3, level: 'ai' }, timeLimitS: 600 } });
  const A = human(room, 'Ann', CODE_A), B = human(room, 'Ben', CODE_B);
  startNow(room, A.p);
  const bot = room.players.find((q) => q.bot);
  const brain = bot.botBrain;
  check(brain.ai !== null, 'bots in an AI room carry the AI state');
  // controlled trials: the bot sees both humans at random distances; who does it pick?
  brain.canSee = () => true;
  const trial = (grudgeA, n) => {
    A.p.mem.gr.clear(); B.p.mem.gr.clear();
    if (grudgeA) A.p.mem.gr.set(bot.name, grudgeA);
    let pickA = 0;
    for (let i = 0; i < n; i++) {
      const st = bot.state; st.x = 0; st.z = 0; brain.yaw = 0;
      for (const h of [A.p, B.p]) {
        const d = 8 + Math.random() * 32, a = (Math.random() - 0.5) * 2.4;     // in front (yaw 0 looks at -z)
        h.state.x = -Math.sin(a) * d; h.state.z = -Math.cos(a) * d; h.alive = true;
      }
      brain.target = null;
      brain.scan(room.tick);
      if (brain.target === A.p) pickA++;
    }
    return pickA / n;
  };
  const n = 2000;
  const base = trial(0, n), g1 = trial(1, n), g3 = trial(3, n);
  check(Math.abs(base - 0.5) < 0.06, `no grudge: picks Ann ${(base * 100).toFixed(1)}% of the time (same situation, random distances)`);
  check(g1 > base + 0.12 && g3 > g1 + 0.05 && g3 > 0.75, `grudge against Ann: ${(g1 * 100).toFixed(1)}% (strength 1), ${(g3 * 100).toFixed(1)}% (strength 3)`);
  // longer chase
  A.p.mem.gr.set(bot.name, 2); brain.target = null; brain.acquire(A.p, room.tick);
  const longChase = brain.lostLimit;
  B.p.mem.gr.clear(); brain.target = null; brain.acquire(B.p, room.tick);
  check(longChase > brain.lostLimit && brain.lostLimit === 40, `keeps chasing a grudge target longer (${longChase} vs ${brain.lostLimit} ticks)`);
  // hunting the last known position
  brain.target = null; brain.goal = null;
  A.p.mem.gr.set(bot.name, 3);
  bot.state.x = 0; bot.state.z = 0; A.p.state.x = 14; A.p.state.z = 9;
  room.mem.seen(A.p, room.tick);
  let hunts = 0;
  for (let i = 0; i < 20; i++) { brain.goal = null; brain.target = null; brain.decide(room.tick); if (brain.goal && brain.goal.hunt && Math.hypot(brain.goal.pos[0] - 14, brain.goal.pos[2] - 9) < 0.01) hunts++; }
  A.p.mem.gr.clear();
  let huntsNo = 0;
  for (let i = 0; i < 20; i++) { brain.goal = null; brain.target = null; brain.decide(room.tick); if (brain.goal && brain.goal.hunt) huntsNo++; }
  check(hunts >= 12 && huntsNo === 0, `idle bot hunts the grudge player's last known position (${hunts}/20 decisions; without grudge ${huntsNo}/20)`);
  // kills create grudges within the match, and they fade over AI matches
  A.p.mem.gr.clear();
  room.kill(bot, A.p, 0, false, 0);
  check(room.mem.grudge(bot.name, A.p) === 1 && room.mem.grudge(bot.name, B.p) === 0, 'killing a bot gives that bot a grudge against the killer (this match)');
  const gr = updateGrudges({}, 1, { Pixel: 3 }, {});
  check(grudgeStrength(gr.Pixel, 1) === 3 && grudgeStrength(gr.Pixel, 5) === 1.5 && grudgeStrength(gr.Pixel, 17) === 0, 'grudges fade: half after 4 AI matches without meeting, gone after ~15');
  const gr2 = updateGrudges(gr, 6, {}, { Pixel: 1 });
  check(gr2.Pixel.m === 6 && Math.abs(grudgeStrength(gr2.Pixel, 6) - 3 * 0.5 ** (4 / 4)) < 0.02, 'meeting again (even losing to it) refreshes the grudge clock');
  // non-AI bots never take any of these paths
  const room2 = new Room('h', { isPrivate: true, memory: mem, config: { mode: 'ffa', bots: { fill: 3, level: 'hard' } } });
  const C = human(room2, 'Cy', CODE_C);
  startNow(room2, C.p);
  check(room2.players.filter((q) => q.bot).every((q) => q.botBrain.ai === null && q.botBrain.lv(C.p).skill === 1), "Hard bots in a memory room stay plain Hard bots (no adaptation, no grudges)");
  mem.close();
}

// ------------------------------------------------------------------ persistence across a restart
async function playScriptedMatch(mem, code, level, seconds, mapId = 'crate_cove') {
  const room = new Room('p', { isPrivate: true, memory: mem, config: { mode: 'ffa', mapId, bots: { fill: 4, level: 'ai' }, timeLimitS: seconds } });
  const H = human(room, 'Ann', code);
  await settle();
  script(room, H.p, level);
  startNow(room, H.p);
  steps(room, 60 * (seconds + 1));
  await settle(); await mem.flush();
  return { room, H };
}

async function testPersistence() {
  section('skill + grudges persist across a simulated server restart (shared mock store)');
  const store = createMockStore();
  const mem1 = M.createMemory({ mock: true, store }, { log: () => {} });
  const { room, H } = await playScriptedMatch(mem1, CODE_A, 'strong', 150);
  const tag = M.tagForCode(CODE_A);
  const ns = store.namespaces.get(tag);
  const stateDoc = ns && ns.docs.get(STATE_DOC_ID);
  const summaries = ns ? [...ns.docs.values()].filter((d) => d.id.startsWith('match-')) : [];
  check(summaries.length === 1 && summaries[0].dreaming === 'instant', `match summary written with dreaming 'instant' (${summaries.length})`);
  const add = store.log.find((l) => l.kind === 'add' && l.payload.id && l.payload.id.startsWith('match-'));
  check(add && add.payload.supportingContext && add.payload.supportingContext.length <= 1500 && add.payload.metadata.kind === 'match', 'summary carries the supportingContext (entity context) and match metadata');
  check(stateDoc && stateDoc.taskType === 'superrag' && typeof stateDoc.metadata.state === 'string', 'state document: fixed id, taskType superrag, JSON in metadata');
  const st1 = parseState(stateDoc.metadata.state);
  const skill1 = H.p.mem.skill.v;
  check(st1 && Math.abs(st1.sk.v - skill1) < 0.001 && st1.n === 1 && st1.am === 1, `stored skill ${st1 && st1.sk.v} = live estimate ${skill1.toFixed(3)}, 1 match, 1 AI match`);
  const grNames = Object.keys(st1.gr).filter((n) => st1.gr[n].k > 0);
  check(grNames.length > 0, `grudges stored for bots the player beat: ${grNames.map((n) => n + ':' + st1.gr[n].k).join(', ')}`);
  console.log('    summary written:\n      ' + summaries[0].content.split('\n').join('\n      '));
  room.destroy(); mem1.close();

  // "restart": a brand-new service and room on the same store
  const mem2 = M.createMemory({ mock: true, store }, { log: () => {} });
  const room2 = new Room('p2', { isPrivate: true, memory: mem2, config: { mode: 'ffa', mapId: 'crate_cove', bots: { fill: 4, level: 'ai' }, timeLimitS: 120 } });
  const H2 = human(room2, 'Ann', CODE_A);
  check(Math.abs(H2.p.mem.skill.v - SKILL_DEFAULT) < 1e-9, 'before the load completes the game uses the default estimate (never waits)');
  await settle();
  check(Math.abs(H2.p.mem.skill.v - st1.sk.v) < 0.001 && Math.abs(H2.p.aiL.s - st1.sk.v) < 0.001, `after restart: skill seeded from memory (${H2.p.mem.skill.v.toFixed(3)}) and bots use it`);
  const g2 = grNames.map((n) => room2.mem.grudge(n, H2.p));
  check(g2.every((g) => g > 0), `after restart: grudges restored (${grNames.map((n, i) => n + ':' + g2[i].toFixed(2)).join(', ')})`);
  startNow(room2, H2.p);
  const botNames = room2.players.filter((q) => q.bot).map((q) => q.name);
  const back = grNames.filter((n) => botNames.includes(n));
  check(back.length === Math.min(grNames.length, botNames.length), `the same bots come back: ${botNames.join(', ')} (grudge names ${grNames.join(', ')})`);
  room2.destroy(); mem2.close();

  // a failed load never overwrites the stored state
  const base = createMockClient({ store });
  const broken = { ...base, kind: 'mock', getDocument: () => Promise.reject(new Error('timeout')), search: base.search, addDocument: base.addDocument, patchDocument: base.patchDocument };
  const mem3 = M.createMemory({ mock: true, store }, { log: () => {}, api: broken });
  const before = store.namespaces.get(tag).docs.get(STATE_DOC_ID).metadata.state;
  await playScriptedMatch(mem3, CODE_A, 'strong', 60);
  const after = store.namespaces.get(tag).docs.get(STATE_DOC_ID).metadata.state;
  const nSum = [...store.namespaces.get(tag).docs.keys()].filter((k) => k.startsWith('match-')).length;
  check(before === after && nSum === 2, `state unreadable -> summary still written (${nSum} summaries), stored state left untouched`);
  mem3.close();
}

// ------------------------------------------------------------------ summary text + entity context
function testText() {
  section('entity context + match summary text');
  const ctx = entityContext('Vega');
  check(ctx.length <= 1500 && ctx.includes('"Vega"') && /one short memory per durable fact/i.test(ctx) && /Skip:/.test(ctx) && /TOTALS/.test(ctx), `entity context: ${ctx.length} chars, names the player, says what to extract and what to skip`);
  const d = {
    nick: 'Vega', date: '2026-11-13', mode: 'ctf', mapId: 'crate_cove', private: true, durationS: 412, team: 'a', coop: false,
    result: 'won', teamScore: 3, enemyScore: 1, scoreUnit: 'captures', kills: 14, deaths: 9, obj: 2,
    teammates: [{ name: 'Orin', bot: false }, { name: 'Rook', bot: true }], botLevel: 'ai',
    guns: [{ gun: gunId('kestrel'), mask: 1 | 16, shots: 56, hits: 23, kills: 8, killDists: [31, 38, 44, 35], deaths: [2, 1, 0] },
      { gun: gunId('maul'), mask: 8 | 32, shots: 120, hits: 34, kills: 5, killDists: [12, 14, 9], deaths: [4, 1, 0] }],
    deathsBy: [{ gun: gunId('breaker'), bands: [3, 0, 0] }, { gun: gunId('maul'), bands: [0, 5, 0] }], fell: 1,
    beat: { Pixel: 4, Bolt: 3 }, lostTo: { Nova: 3 }, skill: { before: 0.62, after: 0.68, wins: 9, losses: 7 },
  };
  const st = freshState();
  const fold = (id, res) => foldMatch(st, { id, mode: d.mode, mapId: d.mapId, result: res, team: 'a', nick: 'Vega', ai: true,
    guns: d.guns.map((g) => ({ ...g, killBands: [1, 2, g.kills - 3] })), skill: { v: 0.68, n: 30, t: '1101101011' },
    mates: ['Orin'], deathsBy: d.deathsBy, beat: d.beat, lostTo: d.lostTo });
  fold('m1', 'won'); fold('m2', 'lost'); fold('m3', 'won');
  const s = matchSummary(d, st);
  console.log('      ' + s.split('\n').join('\n      '));
  check(/TOTALS as of 2026-11-13/.test(s) && /As of 2026-11-13, Vega has won 2 and lost 1 of 3 recorded Hopshot matches/.test(s) && /Vega has won 2 of 3 Capture the Flag matches on Crate Cove/.test(s), 'TOTALS: exact running results per mode + map, dated');
  check(/Vega has 24 kills in total with the Kestrel sniper rifle, mostly at long range \(3 at close range, 6 at mid range, 15 at long range\), hit rate 41%/.test(s) && /Vega has won 2 of 3 matches with human teammate "Orin"/.test(s) && /Vega beat Pixel 12 times/.test(s) && /skill rating against AI bots is 0.68/.test(s), 'TOTALS: guns by range, teammates, AI bots, skill - full sentences naming the player');
  check(/THIS MATCH: Capture the Flag on Crate Cove, 2026-11-13 against adaptive AI bots/.test(s) && /Vega's team won Capture the Flag on Crate Cove 3-1 \(captures\) with human teammate "Orin"/.test(s) && /On 2026-11-13 \(Capture the Flag on Crate Cove\) Vega's Kestrel with Prism Optic and Light Stock got 8 kills at a typical 38 m \(long range\), hit rate 41%/.test(s), 'THIS MATCH: result, teammates, guns + attachments + distance + hit rate');
  check(/3 times by the Breaker \(3 at close range\)/.test(s) && /beat AI bots Pixel 4 times and Bolt 3 times and was killed by Nova 3 times/.test(s) && /0.62 -> 0.68 \(rising/.test(s) && !/minutes|private room/.test(s), 'THIS MATCH: deaths by gun and range, bots, skill trend; no match length / room type');
  const s0 = matchSummary(d, null);
  check(!/TOTALS/.test(s0) && /THIS MATCH/.test(s0), 'without a readable state the summary has no TOTALS (never made-up numbers)');
}

// ------------------------------------------------------------------ suggestions
function mk(id, mo, mp, result, team, guns = []) { return { id, mode: mo, mapId: mp, result, team, nick: 'x', guns }; }
const G = (key, kills, killBands, deaths) => ({ gun: gunId(key), kills, killBands, deaths, shots: kills * 4, hits: kills * 2 });

async function testSuggestions() {
  section('suggestions: exact counts, only with enough history');
  // Ann: 4 CTF on Crate Cove with Ben (3 won), 3 FFA on Skyline with a strong Kestrel, a weak Maul up close
  const ann = freshState(), ben = freshState(), cy = freshState();
  const ctf = ['w', 'w', 'l', 'w'];
  ctf.forEach((r, i) => {
    const res = r === 'w' ? 'won' : 'lost';
    foldMatch(ann, mk('g' + i, 'ctf', 'crate_cove', res, 'a', [G('maul', 1, [1, 0, 0], [[3, 2, 2, 2][i], i === 0 ? 2 : 0, 0])]));
    foldMatch(ben, mk('g' + i, 'ctf', 'crate_cove', res, 'a', [G('vireo', 3, [2, 1, 0], [1, 1, 0])]));
  });
  [[6, 2], [6, 3], [6, 2]].forEach(([k, d], i) => foldMatch(ann, mk('s' + i, 'ffa', 'skyline', i === 1 ? 'won' : 'lost', '', [G('kestrel', k, [0, 1, k - 1], [0, 0, d])])));
  foldMatch(ben, mk('b9', 'tdm', 'metro_line', 'won', 'b'));
  foldMatch(cy, mk('c1', 'ffa', 'skyline', 'won', '', [G('kestrel', 12, [0, 2, 10], [0, 1, 0])]));
  foldMatch(cy, mk('c2', 'ffa', 'skyline', 'won', '', [G('kestrel', 12, [0, 2, 10], [0, 1, 0])]));

  // pure functions
  const hs = hostSuggestion([ann, ben], { mode: 'ffa', mapId: 'prism_yard' }, []);
  check(hs && hs.mode === 'ctf' && hs.mapId === 'crate_cove' && hs.text === 'Your group won 3 of 4 Capture the Flag on Crate Cove', `group suggestion: "${hs && hs.text}"`);
  check(hostSuggestion([ann, ben], { mode: 'ctf', mapId: 'crate_cove' }, []) === null, 'no suggestion when the group already has it selected');
  check(hostSuggestion([ann, ben, cy], { mode: 'ffa', mapId: 'prism_yard' }, []) === null, 'no group claim when a member never played those matches with the group');
  check(hostSuggestion([ann], { mode: 'ffa', mapId: 'prism_yard' }, []).text === 'You won 3 of 4 Capture the Flag on Crate Cove', 'solo host: "You won 3 of 4 ..."');
  check(lobbyTip(ann, 'skyline', []) === 'Your Kestrel does well on Skyline: 18 kills, 7 deaths.', `lobby tip on Skyline: "${lobbyTip(ann, 'skyline', [])}"`);
  const lt = loadoutTip(ann, []);
  check(lt === 'You lose most fights at close range with the Maul (9 deaths, 4 kills) - Quick Hands or the Vireo may help.', `loadout tip: "${lt}"`);
  check(loadoutTip(ann, ['Ann does well with the Kestrel on Skyline, 18 kills in 3 matches.']) === 'Your Kestrel does well on Skyline: 18 kills, 7 deaths.', 'memory evidence ranks candidates (a strength the memories talk about wins)');
  check(lobbyTip(cy, 'skyline', []) === '' && loadoutTip(cy, []) === '' && hostSuggestion([cy], { mode: 'tdm', mapId: 'skyline' }, []) === null, 'only 2 matches recorded (even strong ones): nothing at all');
  check(loadoutTip(freshState(), []) === '' && lobbyTip(null, 'skyline', []) === '', 'no history: nothing');

  // end to end through a room: stored states -> load -> 'memory' messages
  const store = createMockStore();
  const mem = M.createMemory({ mock: true, store }, { log: () => {} });
  for (const [code, st] of [[CODE_A, ann], [CODE_B, ben], [CODE_C, cy]]) await mem.addState(M.tagForCode(code), { kind: 'state', v: 1, state: JSON.stringify(st) });
  // Ann's memory also holds a summary (evidence for the hybrid searches)
  await mem.api.addDocument(M.tagForCode(CODE_A), { id: 'match-x', content: 'Ann won Capture the Flag on Crate Cove 3-1 with teammate "Ben". Maul assault rifle: died 3 times at close range.', dreaming: 'instant' });
  const room = new Room('s', { isPrivate: true, memory: mem, config: { mode: 'ffa', mapId: 'skyline', bots: { fill: 4, level: 'ai' } } });
  const A = human(room, 'Ann', CODE_A), B = human(room, 'Ben', CODE_B);
  await settle(10);
  const ma = A.last('memory'), mb = B.last('memory');
  check(ma && ma.host && ma.host.text === 'Your group won 3 of 4 Capture the Flag on Crate Cove', `host gets the group suggestion: "${ma && ma.host && ma.host.text}"`);
  check(ma && ma.lobby === 'Your Kestrel does well on Skyline: 18 kills, 7 deaths.', `host's own lobby tip: "${ma && ma.lobby}"`);
  check(mb && mb.host === null && mb.lobby === '' && mb.loadout === '', `Ben (not host, history but no qualifying pattern): no suggestion (${JSON.stringify(mb)})`);
  check(room.players.find((q) => q === A.p).mem.rec.evidence.length > 0, `hybrid-search evidence cached for the session (${A.p.mem.rec.evidence.length} texts)`);
  const searches = store.log.filter((l) => l.kind === 'search' && l.ns === M.tagForCode(CODE_A));
  check(searches.length === 3 && searches.every((s) => s.payload.searchMode === 'hybrid'), `3 purposeful hybrid searches per player on join (${searches.map((s) => '"' + s.payload.query.slice(0, 32) + '…"').join(', ')})`);
  room.requestConfig(A.p, { mode: 'ctf', mapId: 'crate_cove' });
  check(A.last('memory').host === null, 'host applies the suggestion -> it goes away');
  const C = human(room, 'Cy', CODE_C);
  await settle(10);
  room.requestConfig(A.p, { mode: 'ffa', mapId: 'prism_yard' });
  check(A.last('memory').host === null, 'a third human without shared history joins -> no group claim');
  const before = A.ws.msgs.filter((m) => m.t === 'memory').length;
  room.requestConfig(A.p, { timeLimitS: 300 });
  check(A.ws.msgs.filter((m) => m.t === 'memory').length === before, "unchanged suggestions are not re-sent");
  void C;
  mem.close();
}

// ------------------------------------------------------------------ run
testIdentity();
await testSecretNeverLeaves();
await testFlagOff();
await testClient();
testAdaptive();
testGrudges();
await testPersistence();
testText();
await testSuggestions();

console.log(`\nRESULT: ${failures.length ? failures.length + ' FAILED' : 'all memory checks passed'} (${Math.round((performance.now() - T0) / 1000)} s)`);
for (const f of failures) console.log('  - ' + f);
process.exit(failures.length ? 1 : 0);
