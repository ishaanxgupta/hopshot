// Hopshot's optional long-term memory layer (powered by Supermemory). OFF unless the server env has
// MEMORY_ENABLED=1 and SUPERMEMORY_API_KEY (or SUPERMEMORY_MOCK=1: an in-process store, for tests).
// Off = createMemory returns null and nothing here runs: no network, no AI bots, no suggestions.
//
// Identity: no accounts, no database. The browser sends a random secret player code on join; the
// server derives the player's namespace (Supermemory container tag) = MEMORY_TAG_PREFIX +
// sha256(code)[0..32 hex] and forgets the code at once (it is never stored, logged or sent on).
// One namespace per player holds:
//   - "match-<date>-<id>" documents: one natural-language summary per match (text.js), ingested
//     with dreaming 'instant' and the player's supportingContext (entity context + extraction rules)
//   - "hopshot-state": the structured numbers (state.js), JSON in metadata, taskType 'superrag'
// Retrieval: on join (any room) the state document is read (GET, 3 s timeout) and three purposeful
// hybrid searches run (3 s each); everything is cached per player for the session and the game
// never waits for it - skill seeds, grudges and suggestions simply apply when they arrive.
// Writes: once per match per human (summary + state), asynchronously after the match, through
// api.js (timeouts, retries, max 3 in flight). Failures are logged without secrets.
//
// Per room (MemoryRoom): the AI-bot state (per-human SkillTracker, grudges, last known positions),
// the per-match stats the summaries are built from (O(1) hooks from room.js), and the suggestions
// sent to each identified human as { t:'memory', host, lobby, loadout } whenever they change.

import crypto from 'node:crypto';
import { createSupermemoryClient, createMockClient, createMockStore } from './api.js';
import { SkillTracker, aiParams, grudgeStrength, updateGrudges, grudgeFactor, SKILL_DEFAULT, GRUDGE_MAX } from './ai.js';
import { entityContext, matchSummary, rangeBand } from './text.js';
import { STATE_DOC_ID, freshState, parseState, foldMatch } from './state.js';
import { hostSuggestion, lobbyTip, loadoutTip } from './suggest.js';
import { parsePlayerCode, encodeText } from '../../shared/protocol.js';
import { MODES, isTeamMode } from '../../shared/modes.js';
import { TICK_RATE } from '../../shared/constants.js';
import { GUNS } from '../../shared/weapons.js';

export const DEFAULT_TAG_PREFIX = 'hopshot_player_';
export const SEARCH_QUERIES = Object.freeze({
  guns: 'Which guns and attachments does this player do well with, on which maps and at what range?',
  weak: 'At which range and with which gun does this player lose fights or die most?',
  group: 'Which modes and maps does this player win or lose, and with which teammates?',
});
const MIN_PRESENT_S = 45;              // a human must have played this long for a summary
const RETRY_LOAD_MS = 30000;
const EVIDENCE_REFRESH_MS = 40000;     // re-search after a write (instant extraction takes ~30 s)
const RECORD_IDLE_MS = 30 * 60000;
const GUN_N = GUNS.length;

/** Env -> null (memory off), { error } (misconfigured: stays off) or the config. */
export function memoryConfigFromEnv(env = process.env) {
  const on = (v) => v === '1' || v === 'true' || v === 'yes';
  if (!on(env.MEMORY_ENABLED)) return null;
  const mock = on(env.SUPERMEMORY_MOCK);
  const apiKey = env.SUPERMEMORY_API_KEY || '';
  if (!mock && !apiKey) return { error: 'MEMORY_ENABLED=1 but SUPERMEMORY_API_KEY is not set - memory stays off' };
  const p = env.MEMORY_TAG_PREFIX;
  const prefix = typeof p === 'string' && /^[a-zA-Z0-9_:-]{1,60}$/.test(p) ? p : DEFAULT_TAG_PREFIX;
  return { mock, apiKey, prefix };
}

/** The container tag for a player code (or null for an invalid code). */
export function tagForCode(code, prefix = DEFAULT_TAG_PREFIX) {
  const c = parsePlayerCode(code);
  if (!c) return null;
  return prefix + crypto.createHash('sha256').update(c, 'utf8').digest('hex').slice(0, 32);
}

/**
 * cfg from memoryConfigFromEnv (or { mock: true, store } in tests). opts: { log, api (inject),
 * fetchImpl }. Returns a MemoryService, or null when cfg is null / has an error.
 */
export function createMemory(cfg, opts = {}) {
  if (!cfg || cfg.error) return null;
  const stats = { enabled: true, mock: !!cfg.mock, requests: 0, failures: 0, retries: 0, loads: 0, searches: 0, summaries: 0, stateWrites: 0, writeFailures: 0, lastError: '' };
  const api = opts.api || (cfg.mock
    ? createMockClient({ store: cfg.store || createMockStore(), latencyMs: cfg.latencyMs || 0, stats })
    : createSupermemoryClient({ apiKey: cfg.apiKey, fetchImpl: opts.fetchImpl, stats }));
  return new MemoryService(api, cfg.prefix || DEFAULT_TAG_PREFIX, stats, opts.log || defaultLog);
}

function defaultLog(...a) { console.log(new Date().toISOString(), 'memory:', ...a); }
const short = (tag) => '…' + String(tag).slice(-6);

export class MemoryService {
  constructor(api, prefix, stats, log) {
    this.api = api; this.prefix = prefix; this.stats = stats; this.log = log;
    this.records = new Map();           // tag -> record
    this.sweeper = setInterval(() => this.sweep(), 5 * 60000);
    if (this.sweeper.unref) this.sweeper.unref();
  }

  get kind() { return this.api.kind; }
  tagFor(code) { return tagForCode(code, this.prefix); }
  createRoom(room) { return new MemoryRoom(this, room); }
  status() { return { ...this.stats, pending: this.api.pending, players: this.records.size }; }
  close() { clearInterval(this.sweeper); }

  record(tag) {
    let r = this.records.get(tag);
    if (!r) {
      r = { tag, status: 'idle', state: null, stateExists: false, evidence: [], failedAt: 0, refs: 0, subs: new Set(), chain: Promise.resolve(), touched: Date.now(), refreshTimer: null };
      this.records.set(tag, r);
    }
    r.touched = Date.now();
    return r;
  }

  sweep() {
    const now = Date.now();
    for (const [tag, r] of this.records) if (r.refs <= 0 && r.status !== 'loading' && now - r.touched > RECORD_IDLE_MS) this.records.delete(tag);
  }

  notify(r) { for (const fn of r.subs) { try { fn(r); } catch (e) { this.log('subscriber failed:', e && e.message); } } }

  /** Start loading a record if needed (never throws, never awaited by the game loop). */
  ensureLoaded(r) {
    if (r.status === 'ready' || r.status === 'loading') return;
    if (r.status === 'failed' && Date.now() - r.failedAt < RETRY_LOAD_MS) return;
    r.status = 'loading';
    this.stats.loads++;
    this.api.getDocument(r.tag, STATE_DOC_ID).then((doc) => {
      if (doc === undefined) { r.state = freshState(); r.stateExists = false; }
      else {
        const st = parseState(doc && doc.metadata && doc.metadata.state);
        r.state = st || freshState();
        r.stateExists = true;
      }
      r.status = 'ready';
      this.notify(r);
      this.searchEvidence(r);
    }).catch((e) => {
      r.status = 'failed'; r.failedAt = Date.now();
      this.noteError(`load ${short(r.tag)}: ${e && e.message}`);
      this.notify(r);
    });
  }

  /** Three purposeful hybrid searches -> r.evidence (memory / chunk texts). */
  searchEvidence(r) {
    if (!r.state || r.state.n === 0) return;        // nothing written yet: nothing to find
    const qs = Object.values(SEARCH_QUERIES);
    this.stats.searches += qs.length;
    Promise.allSettled(qs.map((q) => this.api.search(r.tag, q, { limit: 8, threshold: 0.3 }))).then((res) => {
      const texts = [];
      for (const x of res) {
        if (x.status !== 'fulfilled') { this.noteError(`search ${short(r.tag)}: ${x.reason && x.reason.message}`); continue; }
        for (const it of (x.value && x.value.results) || []) {
          if (it.metadata && it.metadata.kind === 'state') continue;
          const t = it.memory || it.chunk;
          if (typeof t === 'string' && t && !texts.includes(t)) texts.push(t.slice(0, 400));
        }
      }
      r.evidence = texts.slice(0, 30);
      r.evidenceAt = Date.now();
      this.notify(r);
    });
  }

  noteError(msg) { this.stats.lastError = msg; this.log(msg); }

  /** Queue one match's writes for a player: summary (instant) then the state document. */
  writeMatch(r, summary, stateJson, meta) {
    const tag = r.tag;
    r.chain = r.chain.then(async () => {
      try {
        await this.api.addDocument(tag, {
          id: meta.docId, content: summary, dreaming: 'instant', supportingContext: entityContext(meta.nick),
          metadata: { kind: 'match', mode: meta.mode, map: meta.mapId, result: meta.result, kills: meta.kills, deaths: meta.deaths, ai: !!meta.ai },
          date: new Date().toISOString(),
        });
        this.stats.summaries++;
      } catch (e) { this.stats.writeFailures++; this.noteError(`summary ${short(tag)}: ${e && e.message}`); }
      if (stateJson === null) return;
      const metadata = { kind: 'state', v: 1, state: stateJson, updated: new Date().toISOString() };
      try {
        if (r.stateExists) {
          try { await this.api.patchDocument(tag, STATE_DOC_ID, { metadata }); }
          catch (e) { if (e && e.status === 404) await this.addState(tag, metadata); else throw e; }
        } else await this.addState(tag, metadata);
        r.stateExists = true;
        this.stats.stateWrites++;
      } catch (e) { this.stats.writeFailures++; this.noteError(`state ${short(tag)}: ${e && e.message}`); }
    });
    // memories from an instant ingestion land within ~30 s: refresh what suggestions rank with
    clearTimeout(r.refreshTimer);
    r.refreshTimer = setTimeout(() => { if (r.refs > 0) this.searchEvidence(r); }, EVIDENCE_REFRESH_MS);
    if (r.refreshTimer.unref) r.refreshTimer.unref();
    return r.chain;
  }

  addState(tag, metadata) {
    return this.api.addDocument(tag, {
      id: STATE_DOC_ID, taskType: 'superrag',
      content: 'Hopshot game-server state for this player (machine-readable numbers in metadata; not a match).',
      metadata,
    });
  }

  /** Wait for every queued write (tests, shutdown). */
  async flush() { await Promise.all([...this.records.values()].map((r) => r.chain)); }
}

// ------------------------------------------------------------------ per human

function newMatchStats(tick) {
  const guns = [];
  for (let g = 0; g < GUN_N; g++) guns.push({ shots: 0, hits: 0, kills: 0, kb: [0, 0, 0], dists: [], deaths: [0, 0, 0], masks: new Map() });
  const deathsBy = [];
  for (let g = 0; g < GUN_N; g++) deathsBy.push([0, 0, 0]);
  return { from: tick, guns, deathsBy, fell: 0, beat: {}, lostTo: {}, shots: 0, hits: 0 };
}

class HumanMem {
  constructor(tag, rec) {
    this.tag = tag; this.rec = rec;
    this.skill = new SkillTracker(null);
    this.gr = new Map();                 // bot name -> grudge strength (persisted + this match)
    this.seen = null;                    // last known position { x, y, z, tick }
    this.st = null;                      // this match's stats
    this.lastTips = '';
    this.applied = false;                // persisted skill / grudges applied
    this.sub = null;
  }
}

// ------------------------------------------------------------------ per room

export class MemoryRoom {
  constructor(service, room) {
    this.svc = service; this.room = room;
    this.botL = aiParams(SKILL_DEFAULT);   // AI bots fighting other bots
    this.matchId = '';
    this.matchAi = false;
  }

  get ai() { return this.room.config.bots.level === 'ai'; }

  // ---- membership
  addHuman(p, code) {
    const tag = this.svc.tagFor(code);       // the code itself is not kept anywhere
    const rec = tag ? this.svc.record(tag) : null;
    const m = new HumanMem(tag, rec);
    p.mem = m;
    p.aiL = m.skill.params;
    if (this.room.phase === 'playing') m.st = newMatchStats(this.room.tick);
    if (rec) {
      rec.refs++;
      m.sub = () => this.onRecord(p);
      rec.subs.add(m.sub);
      this.svc.ensureLoaded(rec);
      if (rec.status === 'ready') this.onRecord(p);
    }
  }

  removeHuman(p) {
    const m = p.mem;
    if (!m) return;
    if (m.rec) { m.rec.refs--; m.rec.subs.delete(m.sub); }
    m.sub = null;
  }

  destroy() { for (const p of this.room.players) if (!p.bot) this.removeHuman(p); }

  /** A player's record loaded / its evidence refreshed. */
  onRecord(p) {
    const m = p.mem;
    if (!m || p.removed || !m.rec) return;
    const r = m.rec;
    if (r.status === 'ready' && !m.applied) {
      m.applied = true;
      const st = r.state;
      if (st.sk) { m.skill.seed(st.sk); aiParamsInto(m); }
      for (const [name, e] of Object.entries(st.gr || {})) {
        const g = grudgeStrength(e, st.am);
        if (g > 0) m.gr.set(name, Math.min(GRUDGE_MAX, (m.gr.get(name) || 0) + g));
      }
    }
    this.refreshTips();
  }

  // ---- AI bot queries (cheap; called from bots.js)
  grudge(botName, q) { const m = q && q.mem; return m ? m.gr.get(botName) || 0 : 0; }
  grudgeFactor(botName, q) { return grudgeFactor(this.grudge(botName, q)); }
  seen(q, tick) {
    const m = q.mem;
    if (!m) return;
    const s = m.seen || (m.seen = { x: 0, y: 0, z: 0, tick: 0 });
    s.x = q.state.x; s.y = q.state.y; s.z = q.state.z; s.tick = tick;
  }
  /** A grudge target worth hunting for this bot: its last known position, or null. */
  huntTarget(bot, tick, freshTicks) {
    const me = bot.p;
    let best = null, bestG = 0;
    for (const q of this.room.players) {
      if (q.bot || !q.mem || !q.alive || !bot.isEnemy(q)) continue;
      const g = q.mem.gr.get(me.name) || 0, s = q.mem.seen;
      if (g <= bestG || !s || tick - s.tick > freshTicks) continue;
      if (Math.hypot(s.x - me.state.x, s.z - me.state.z) < 6) continue;
      best = q; bestG = g;
    }
    if (!best || Math.random() > Math.min(0.9, 0.35 * bestG)) return null;
    return best.mem.seen;
  }
  /** AI rooms: prefer bot names that hold grudges against the humans present. */
  pickBotName() {
    const used = new Set(this.room.players.map((q) => q.name));
    const score = new Map();
    for (const q of this.room.players) {
      if (q.bot || !q.mem) continue;
      for (const [name, g] of q.mem.gr) if (!used.has(name)) score.set(name, (score.get(name) || 0) + g);
    }
    let best = '', bestS = 0;
    for (const [name, s] of score) if (s > bestS) { best = name; bestS = s; }
    return best || null;
  }

  // ---- match hooks (O(1); only called while memory is on)
  matchStart() {
    this.matchId = crypto.randomBytes(4).toString('hex');
    this.matchAi = this.ai;
    for (const p of this.room.players) {
      if (p.bot || !p.mem) continue;
      p.mem.st = newMatchStats(this.room.tick);
      p.mem.skill.start = p.mem.skill.v; p.mem.skill.wins = 0; p.mem.skill.losses = 0;
      if (p.mem.rec) this.svc.ensureLoaded(p.mem.rec);     // a load that failed at join is retried (rate-limited)
    }
  }

  shot(p, gun, mask, hit) {
    const m = p.mem;
    if (!m || !m.st) return;
    const g = m.st.guns[gun];
    g.shots++; m.st.shots++;
    if (hit) { g.hits++; m.st.hits++; }
    g.masks.set(mask, (g.masks.get(mask) || 0) + 1);
    if (this.matchAi) this.seen(p, this.room.tick);       // gunfire gives your position away
  }

  /** Before victim.lastDamageTick is updated: start a time-to-kill clock for this attacker. */
  damaged(victim, attacker) {
    const tick = this.room.tick;
    if (victim.mTtkBy !== attacker.id || tick - victim.lastDamageTick > 3 * TICK_RATE) { victim.mTtkBy = attacker.id; victim.mTtkStart = tick; }
  }

  killed(victim, killer, gun) {
    const room = this.room, tick = room.tick;
    const vm = victim.mem, km = killer && killer !== victim ? killer.mem : null;
    let dist = 0;
    if (killer && killer !== victim) dist = Math.hypot(killer.state.x - victim.state.x, killer.state.y - victim.state.y, killer.state.z - victim.state.z);
    const band = rangeBand(dist);
    if (km && km.st && (!killer.team || killer.team !== victim.team)) {
      const g = km.st.guns[gun];
      if (g) { g.kills++; g.kb[band]++; if (g.dists.length < 60) g.dists.push(dist); }
    }
    if (vm && vm.st) {
      const held = victim.kit.guns[victim.wstate.weapon];
      if (!killer || killer === victim) vm.st.fell++;
      else {
        if (vm.st.guns[held]) vm.st.guns[held].deaths[band]++;
        if (vm.st.deathsBy[gun]) vm.st.deathsBy[gun][band]++;
      }
    }
    if (!this.matchAi || !killer || killer === victim) return;
    // AI bots: fights decide the adaptive skill; kills make grudges
    const ttkS = victim.mTtkBy === killer.id ? (tick - victim.mTtkStart) / TICK_RATE : NaN;
    if (km && victim.bot) {
      const acc = km.st && km.st.shots >= 5 ? km.st.hits / km.st.shots : NaN;
      km.skill.fight(true, { margin: killer.health / 100, ttkS, acc });
      km.gr.set(victim.name, Math.min(GRUDGE_MAX, (km.gr.get(victim.name) || 0) + 1));
      if (km.st) km.st.beat[victim.name] = (km.st.beat[victim.name] || 0) + 1;
    } else if (vm && killer.bot) {
      const acc = vm.st && vm.st.shots >= 5 ? vm.st.hits / vm.st.shots : NaN;
      vm.skill.fight(false, { margin: killer.health / 100, ttkS, acc });
      if (vm.st) vm.st.lostTo[killer.name] = (vm.st.lostTo[killer.name] || 0) + 1;
    }
  }

  /** 1 Hz while playing: bots follow each estimate smoothly; bot-vs-bot tuning = humans' mean. */
  second() {
    if (!this.matchAi) return;
    let sum = 0, n = 0;
    for (const p of this.room.players) {
      if (p.bot || !p.mem) continue;
      p.mem.skill.smooth();
      sum += p.mem.skill.eff; n++;
    }
    aiParams(n ? sum / n : SKILL_DEFAULT, this.botL);
  }

  // ---- match end: summaries + state, asynchronously
  matchEnd(result) {
    const room = this.room;
    const humans = room.players.filter((p) => !p.bot && p.mem && p.mem.st);
    if (!humans.length) return;
    const snapshot = this.collect(result, humans);
    // the expensive part (strings, JSON) runs after this tick
    setImmediate(() => { try { this.persist(snapshot); } catch (e) { this.svc.noteError(`match end: ${e && e.message}`); } });
  }

  collect(result, humans) {
    const room = this.room, tick = room.tick;
    const mode = room.config.mode, team = isTeamMode(mode);
    const rows = room.players.map((p) => ({ id: p.id, kills: p.kills, deaths: p.deaths }));
    const rank = (p) => 1 + rows.filter((r) => r.kills > p.kills || (r.kills === p.kills && r.deaths < p.deaths)).length;
    const out = [];
    for (const p of humans) {
      const m = p.mem, st = m.st;
      const presentS = (tick - Math.max(st.from, room.startTick)) / TICK_RATE;
      let res;
      if (result.draw) res = 'draw';
      else if (team) res = result.winner === p.team ? 'won' : 'lost';
      else res = result.winner === p.id ? 'won' : 'lost';
      if (!team && result.draw) {
        const top = rows.reduce((b, r) => (!b || r.kills > b.kills || (r.kills === b.kills && r.deaths < b.deaths) ? r : b), null);
        res = top && top.kills === p.kills && top.deaths === p.deaths ? 'draw' : 'lost';
      }
      const mates = room.players.filter((q) => q !== p && (team ? q.team === p.team : !q.bot)).map((q) => ({ name: q.name, bot: q.bot, tag: q.mem && q.mem.tag }));
      const guns = st.guns.map((g, gun) => {
        let mask = 0, best = -1;
        for (const [mk, n] of g.masks) if (n > best) { best = n; mask = mk; }
        return { gun, mask, shots: g.shots, hits: g.hits, kills: g.kills, killBands: g.kb.slice(), killDists: g.dists.slice(), deaths: g.deaths.slice() };
      });
      out.push({
        tag: m.tag, rec: m.rec, nick: p.name, presentS,
        mode, mapId: room.map.id, private: room.isPrivate, durationS: (tick - room.startTick) / TICK_RATE,
        team: team ? p.team : '', coop: !!room.config.coop, result: res, place: rank(p), players: rows.length,
        teamScore: team ? room.scores[p.team] : p.kills, enemyScore: team ? room.scores[p.team === 'a' ? 'b' : 'a'] : 0,
        scoreUnit: (MODES[mode] || {}).scoreUnit || 'points',
        kills: p.kills, deaths: p.deaths, obj: p.obj,
        teammates: mates, botLevel: room.players.some((q) => q.bot) ? room.config.bots.level : '',
        guns, deathsBy: st.deathsBy.map((bands, gun) => ({ gun, bands: bands.slice() })), fell: st.fell,
        beat: { ...st.beat }, lostTo: { ...st.lostTo },
        ai: this.matchAi,
        skill: this.matchAi ? { before: m.skill.start, after: m.skill.v, wins: m.skill.wins, losses: m.skill.losses, snap: m.skill.snapshot() } : null,
        matchId: this.matchId,
      });
      m.st = null;
    }
    return out;
  }

  persist(list) {
    const date = new Date().toISOString().slice(0, 10);
    for (const d of list) {
      if (!d.tag || !d.rec) continue;                                   // no player code: nothing to remember
      if (d.presentS < MIN_PRESENT_S || d.kills + d.deaths < 1) continue;  // too little play to say anything
      let stateJson = null;
      const r = d.rec;
      if (r.status === 'ready' && r.state) {
        const am = r.state.am + (d.ai ? 1 : 0);
        foldMatch(r.state, {
          id: d.matchId, mode: d.mode, mapId: d.mapId, result: d.result, team: d.team, nick: d.nick, ai: d.ai,
          guns: d.guns, skill: d.skill ? d.skill.snap : null,
          grudges: d.ai ? updateGrudges(r.state.gr, am, d.beat, d.lostTo) : undefined,
          mates: d.team ? d.teammates.filter((t) => !t.bot).map((t) => t.name) : [],
          deathsBy: d.deathsBy, beat: d.beat, lostTo: d.lostTo,
        });
        stateJson = JSON.stringify(r.state);
      }   // else: the stored state could not be read; never overwrite it with a partial one
      // the summary carries the exact running totals when we have them (see text.js)
      const summary = matchSummary({ ...d, date }, stateJson ? r.state : null);
      this.svc.writeMatch(r, summary, stateJson, {
        docId: `match-${date.replace(/-/g, '')}-${d.matchId}`, nick: d.nick, mode: d.mode, mapId: d.mapId,
        result: d.result, kills: d.kills, deaths: d.deaths, ai: d.ai,
      });
    }
    this.refreshTips();
  }

  // ---- suggestions
  /** Recompute every identified human's suggestions; send the ones that changed. */
  refreshTips() {
    const room = this.room;
    if (room.destroyed) return;
    const humans = room.players.filter((p) => !p.bot && p.mem);
    const ready = (p) => p.mem.rec && p.mem.rec.status === 'ready' && p.mem.rec.state;
    const groupOk = humans.length > 0 && humans.every(ready);
    for (const p of humans) {
      const m = p.mem;
      if (!ready(p) || !p.ws) continue;
      const st = m.rec.state, ev = m.rec.evidence;
      let host = null;
      if (room.isPrivate && room.phase === 'lobby' && p.id === room.hostId && groupOk) {
        const evAll = humans.flatMap((q) => q.mem.rec.evidence || []);
        host = hostSuggestion(humans.map((q) => q.mem.rec.state), { mode: room.config.mode, mapId: room.config.mapId }, evAll);
      }
      const tips = { host, lobby: room.isPrivate ? lobbyTip(st, room.config.mapId, ev) : '', loadout: loadoutTip(st, ev) };
      const sig = JSON.stringify(tips);
      if (sig === m.lastTips) continue;
      m.lastTips = sig;
      room.sendTo(p, encodeText({ t: 'memory', ...tips }));
    }
  }
}

function aiParamsInto(m) { aiParams(m.skill.eff, m.skill.params); }
