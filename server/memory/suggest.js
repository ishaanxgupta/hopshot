// Suggestions from a player's history (memory on). Pure functions.
//
// "Memory proposes, numbers decide": every candidate comes from the exact counts in the player's
// structured state (the per-player state document, see state.js), and is only offered once there
// is enough history (thresholds below). The memories Supermemory extracted from the match
// summaries (hybrid search results, `evidence`) rank the candidates: a candidate whose gun / map /
// mode the player's memories talk about wins over one they never mention. Nothing is ever shown
// that the counts do not support, and the numbers in the text are the recorded ones.

import { GUNS } from '../../shared/weapons.js';
import { MODES } from '../../shared/modes.js';
import { MAPS } from '../../shared/maps/index.js';

export const MIN_MATCHES = 3;          // recorded matches before any personal tip
const GUN_MAP_MIN_KILLS = 8;
const WEAK_MIN_DEATHS = 6;
const GROUP_MIN_MATCHES = 3;

const mapName = (id) => (MAPS.find((m) => m.id === id) || {}).name || id;
const modeName = (id) => (MODES[id] || {}).name || id;
const GUN = Object.fromEntries(GUNS.map((g) => [g.key, g]));
const BAND = ['close range', 'mid range', 'long range'];
const BAND_WORDS = [['close', 'short', 'up close'], ['mid'], ['long', 'far']];

const ADVICE = {
  maul: ['Quick Hands or the Vireo may help', 'Heavy Rounds or a Long Barrel may help', 'a Prism Optic or the Kestrel may help'],
  vireo: ['a Light Stock or your shotgun may help', 'Heavy Rounds or the Maul may help', 'a Long Barrel or the Kestrel may help'],
  kestrel: ['Quick Hands or switching to your shotgun sooner may help', 'a Light Stock may help', 'a Prism Optic may help'],
  halberd: ['Quick Hands or the Kestrel may help', 'a Light Stock or the Kestrel may help', 'a Prism Optic may help'],
  breaker: ['Heavy Rounds or the Squall may help', 'a Long Barrel or switching to your rifle sooner may help', 'switching to your rifle sooner may help'],
  squall: ['Heavy Rounds or the Breaker may help', 'a Long Barrel or switching to your rifle sooner may help', 'switching to your rifle sooner may help'],
};

/** How many evidence memories mention every one of the given words (case-insensitive; any of a word's alternatives). */
function evidenceScore(evidence, groups) {
  let n = 0;
  for (const e of evidence || []) {
    const t = String(e).toLowerCase();
    if (groups.every((alts) => alts.some((w) => t.includes(w)))) n++;
  }
  return n;
}

function enough(state) { return !!state && (state.n | 0) >= MIN_MATCHES; }

/** Best gun on map `mapId` (or on any map when mapId is null): [{ gun, map, k, d, score }] sorted. */
function gunMapStrengths(state, mapId, evidence) {
  const out = [];
  for (const [mp, guns] of Object.entries(state.gm || {})) {
    if (mapId && mp !== mapId) continue;
    for (const [gun, kd] of Object.entries(guns)) {
      const [k, d] = kd;
      if (!GUN[gun] || k < GUN_MAP_MIN_KILLS || k < 1.6 * Math.max(1, d)) continue;
      const ev = evidenceScore(evidence, [[GUN[gun].name.toLowerCase()], [mapName(mp).toLowerCase()]]);
      out.push({ gun, map: mp, k, d, ev, score: ev * 10 + (k - d) / Math.max(4, d) });
    }
  }
  return out.sort((a, b) => b.score - a.score || b.k - a.k);
}

/** Range bands where the player loses most fights with a gun: [{ gun, band, k, d, score }] sorted. */
function weaknesses(state, evidence) {
  const out = [];
  for (const [gun, g] of Object.entries(state.g || {})) {
    if (!GUN[gun] || !g || !Array.isArray(g.d) || !Array.isArray(g.k)) continue;
    const total = g.d[0] + g.d[1] + g.d[2];
    for (let b = 0; b < 3; b++) {
      const d = g.d[b], k = g.k[b];
      if (d < WEAK_MIN_DEATHS || d < 0.4 * total || d < 1.5 * Math.max(1, k)) continue;
      const ev = evidenceScore(evidence, [[GUN[gun].name.toLowerCase()], BAND_WORDS[b]]);
      out.push({ gun, band: b, k, d, ev, score: ev * 10 + d / Math.max(1, k) });
    }
  }
  return out.sort((a, b) => b.score - a.score || b.d - a.d);
}

function strengthText(c) {
  return `Your ${GUN[c.gun].name} does well on ${mapName(c.map)}: ${c.k} kills, ${c.d} deaths.`;
}
function weaknessText(c) {
  return `You lose most fights at ${BAND[c.band]} with the ${GUN[c.gun].name} (${c.d} deaths, ${c.k} kills) - ${ADVICE[c.gun][c.band]}.`;
}

/** One line for the Loadout tab ('' when there is not enough history). */
export function loadoutTip(state, evidence) {
  if (!enough(state)) return '';
  const w = weaknesses(state, evidence)[0];
  const s = gunMapStrengths(state, null, evidence)[0];
  if (w && (!s || w.ev >= s.ev)) return weaknessText(w);
  if (s) return strengthText(s);
  return '';
}

/** At most one personal tip for the lobby, aware of the selected map ('' when not enough history). */
export function lobbyTip(state, mapId, evidence) {
  if (!enough(state)) return '';
  const here = gunMapStrengths(state, mapId, evidence)[0];
  if (here) return strengthText(here);
  // the player's record on this map
  const rec = { w: 0, n: 0 };
  for (const m of state.rm || []) if (m.mp === mapId) { rec.n++; if (m.r === 'w') rec.w++; }
  if (rec.n >= GROUP_MIN_MATCHES && rec.w / rec.n >= 0.6) return `You won ${rec.w} of your last ${rec.n} matches on ${mapName(mapId)}.`;
  const w = weaknesses(state, evidence)[0];
  return w ? weaknessText(w) : '';
}

/**
 * Host suggestion for the current group of humans: states = every human in the room (all must
 * have history, or the claim would not be about "your group"). Returns { mode, mapId, text } or
 * null. Matches count for the group when every member played that match on the same team (team
 * modes) - or, for one player alone, every recorded match. FFA only for a single player.
 */
export function hostSuggestion(states, current, evidence) {
  if (!states.length || states.some((s) => !s || !Array.isArray(s.rm))) return null;
  const solo = states.length === 1;
  const byId = states.map((s) => new Map(s.rm.map((m) => [m.id, m])));
  const agg = new Map();
  for (const m of states[0].rm) {
    if (!MODES[m.mo] || !MAPS.some((x) => x.id === m.mp)) continue;
    if (!solo) {
      if (!m.t) continue;
      let all = true;
      for (let i = 1; i < byId.length; i++) { const o = byId[i].get(m.id); if (!o || o.t !== m.t) { all = false; break; } }
      if (!all) continue;
    }
    const k = m.mo + '|' + m.mp;
    const a = agg.get(k) || { mode: m.mo, mapId: m.mp, w: 0, n: 0 };
    a.n++; if (m.r === 'w') a.w++;
    agg.set(k, a);
  }
  const cands = [];
  for (const a of agg.values()) {
    if (a.n < GROUP_MIN_MATCHES || a.w < 2 || a.w / a.n < 0.6) continue;
    if (current && current.mode === a.mode && current.mapId === a.mapId) continue;
    const ev = evidenceScore(evidence, [[modeName(a.mode).toLowerCase(), a.mode], [mapName(a.mapId).toLowerCase()]]);
    cands.push({ ...a, ev, score: ev * 2 + a.w / a.n + a.n * 0.02 });
  }
  cands.sort((x, y) => y.score - x.score || y.n - x.n);
  const c = cands[0];
  if (!c) return null;
  const who = solo ? 'You' : 'Your group';
  return { mode: c.mode, mapId: c.mapId, text: `${who} won ${c.w} of ${c.n} ${modeName(c.mode)} on ${mapName(c.mapId)}` };
}
