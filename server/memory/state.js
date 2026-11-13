// The structured per-player state: the numbers code needs exactly (skill estimate, grudges, gun /
// map counts, recent results), never derived from LLM extraction. Stored in the player's own
// namespace as ONE document with a fixed id (STATE_DOC_ID), taskType 'superrag' (so Supermemory does
// not mine it for memories), with the JSON in metadata.state (metadata comes back verbatim; a
// metadata-only PATCH merges and does not reindex). Pure functions.
//
// state = {
//   v: 1, nick, n: matches recorded, am: AI-bot matches played,
//   sk: { v, n, t } | null                skill vs AI bots (ai.js SkillTracker.snapshot)
//   gr: { botName: { k, d, m } }          grudges (ai.js updateGrudges)
//   g:  { gunKey: { k: [c, m, l], d: [c, m, l], s, h } }   kills by range band with the gun, deaths
//                                         while holding it by band, shots, hits (lifetime)
//   gm: { mapId: { gunKey: [kills, deaths] } }            per map (lifetime)
//   rm: [{ id, mo, mp, r: 'w'|'l'|'d', t: ''|'a'|'b', at }]   last RECENT_MATCHES matches (id is shared
//                                         by everybody in that match: group history)
//   wl: [won, lost, drawn]                all recorded matches
//   mm: { 'mode|mapId': [won, played] }   per mode + map (lifetime)
//   db: { gunKey: [c, m, l] }             deaths BY each enemy gun, by range band (lifetime)
//   tm: { nick: [won, played] }           with each human teammate (lifetime, top 12)
//   bb: { botName: [beaten, lostTo] }     AI bots (lifetime counts, top 16; grudges are in gr)
// }
// The cumulative fields also feed the TOTALS block of every match summary (text.js), so the memories
// Supermemory extracts carry exact running totals instead of only one match's numbers.

import { GUNS } from '../../shared/weapons.js';

export const STATE_DOC_ID = 'hopshot-state';
export const STATE_VERSION = 1;
export const RECENT_MATCHES = 40;
const GUN_KEYS = new Set(GUNS.map((g) => g.key));

export function freshState() {
  return { v: STATE_VERSION, nick: '', n: 0, am: 0, sk: null, gr: {}, g: {}, gm: {}, rm: [], wl: [0, 0, 0], mm: {}, db: {}, tm: {}, bb: {} };
}

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const arr3 = (a) => (Array.isArray(a) ? [0, 1, 2].map((i) => Math.max(0, num(a[i]) | 0)) : [0, 0, 0]);

/** Parse + validate a stored state (anything malformed falls back to defaults field by field). */
export function parseState(json) {
  const s = freshState();
  let o;
  try { o = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  if (!o || typeof o !== 'object' || o.v !== STATE_VERSION) return null;
  s.nick = typeof o.nick === 'string' ? o.nick.slice(0, 16) : '';
  s.n = Math.max(0, num(o.n) | 0);
  s.am = Math.max(0, num(o.am) | 0);
  if (o.sk && Number.isFinite(o.sk.v)) s.sk = { v: o.sk.v, n: Math.max(0, num(o.sk.n) | 0), t: typeof o.sk.t === 'string' ? o.sk.t.replace(/[^01]/g, '').slice(-10) : '' };
  for (const [name, e] of Object.entries(o.gr || {})) {
    if (typeof name === 'string' && name.length <= 16 && e && typeof e === 'object') s.gr[name] = { k: Math.max(0, num(e.k)), d: Math.max(0, num(e.d) | 0), m: Math.max(0, num(e.m) | 0) };
  }
  for (const [gun, g] of Object.entries(o.g || {})) {
    if (GUN_KEYS.has(gun) && g && typeof g === 'object') s.g[gun] = { k: arr3(g.k), d: arr3(g.d), s: Math.max(0, num(g.s) | 0), h: Math.max(0, num(g.h) | 0) };
  }
  for (const [mp, guns] of Object.entries(o.gm || {})) {
    if (typeof mp !== 'string' || !guns || typeof guns !== 'object') continue;
    const row = {};
    for (const [gun, kd] of Object.entries(guns)) if (GUN_KEYS.has(gun) && Array.isArray(kd)) row[gun] = [Math.max(0, num(kd[0]) | 0), Math.max(0, num(kd[1]) | 0)];
    s.gm[mp] = row;
  }
  if (Array.isArray(o.wl)) s.wl = arr3(o.wl);
  const pairs = (src, keyOk, max) => {
    const out = {};
    for (const [k, v] of Object.entries(src && typeof src === 'object' ? src : {}).slice(0, max)) {
      if (keyOk(k) && Array.isArray(v)) out[k] = [Math.max(0, num(v[0]) | 0), Math.max(0, num(v[1]) | 0)];
    }
    return out;
  };
  s.mm = pairs(o.mm, (k) => /^[a-z]+\|[a-z_]+$/.test(k), 60);
  s.tm = pairs(o.tm, (k) => k.length <= 16, 12);
  s.bb = pairs(o.bb, (k) => k.length <= 16, 16);
  for (const [gun, b] of Object.entries(o.db || {})) if (GUN_KEYS.has(gun)) s.db[gun] = arr3(b);
  if (Array.isArray(o.rm)) {
    for (const m of o.rm.slice(-RECENT_MATCHES)) {
      if (!m || typeof m.id !== 'string') continue;
      s.rm.push({ id: m.id.slice(0, 16), mo: String(m.mo || ''), mp: String(m.mp || ''), r: m.r === 'w' || m.r === 'l' ? m.r : 'd', t: m.t === 'a' || m.t === 'b' ? m.t : '', at: num(m.at) });
    }
  }
  return s;
}

/**
 * Fold one finished match into a state (mutates and returns it).
 * m = { id, mode, mapId, result 'won'|'lost'|'draw', team, nick, guns: [{ gun (id), kills, killBands: [c,m,l],
 *       deaths: [c,m,l], shots, hits }], ai: bool, skill: snapshot|null, grudges: object|undefined,
 *       mates: [human teammate nicks], deathsBy: [{ gun (id), bands: [c,m,l] }], beat / lostTo: { botName: n } }
 */
export function foldMatch(state, m) {
  state.nick = m.nick || state.nick;
  state.n++;
  if (m.ai) state.am++;
  if (m.skill) state.sk = m.skill;
  if (m.grudges) state.gr = m.grudges;
  for (const g of m.guns || []) {
    const key = GUNS[g.gun] && GUNS[g.gun].key;
    if (!key) continue;
    const s = state.g[key] || (state.g[key] = { k: [0, 0, 0], d: [0, 0, 0], s: 0, h: 0 });
    for (let b = 0; b < 3; b++) { s.k[b] += g.killBands[b] | 0; s.d[b] += g.deaths[b] | 0; }
    s.s += g.shots | 0; s.h += g.hits | 0;
    const kills = g.kills | 0, deaths = (g.deaths[0] + g.deaths[1] + g.deaths[2]) | 0;
    if (kills || deaths) {
      const row = state.gm[m.mapId] || (state.gm[m.mapId] = {});
      const kd = row[key] || (row[key] = [0, 0]);
      kd[0] += kills; kd[1] += deaths;
    }
  }
  const won = m.result === 'won' ? 1 : 0;
  state.wl[m.result === 'won' ? 0 : m.result === 'lost' ? 1 : 2]++;
  const mmk = `${m.mode}|${m.mapId}`;
  const mm = state.mm[mmk] || (state.mm[mmk] = [0, 0]);
  mm[0] += won; mm[1]++;
  for (const x of m.deathsBy || []) {
    const key = GUNS[x.gun] && GUNS[x.gun].key;
    if (!key || !(x.bands[0] + x.bands[1] + x.bands[2])) continue;
    const b = state.db[key] || (state.db[key] = [0, 0, 0]);
    for (let i = 0; i < 3; i++) b[i] += x.bands[i] | 0;
  }
  for (const nick of m.mates || []) {
    const t = state.tm[nick] || (state.tm[nick] = [0, 0]);
    t[0] += won; t[1]++;
  }
  state.tm = topN(state.tm, 12, (v) => v[1]);
  for (const [name, n] of Object.entries(m.beat || {})) (state.bb[name] || (state.bb[name] = [0, 0]))[0] += n | 0;
  for (const [name, n] of Object.entries(m.lostTo || {})) (state.bb[name] || (state.bb[name] = [0, 0]))[1] += n | 0;
  state.bb = topN(state.bb, 16, (v) => v[0] + v[1]);
  state.rm.push({ id: m.id, mo: m.mode, mp: m.mapId, r: m.result === 'won' ? 'w' : m.result === 'lost' ? 'l' : 'd', t: m.team || '', at: Math.round(Date.now() / 1000) });
  if (state.rm.length > RECENT_MATCHES) state.rm.splice(0, state.rm.length - RECENT_MATCHES);
  return state;
}

function topN(obj, n, weight) {
  const e = Object.entries(obj);
  if (e.length <= n) return obj;
  return Object.fromEntries(e.sort((a, b) => weight(b[1]) - weight(a[1])).slice(0, n));
}
