// AI bots (bot level 'ai', memory on): per-human adaptive difficulty and grudges. Pure logic, no I/O.
//
// Adaptive difficulty. Every human has a skill estimate s (0 = Easy .. 1 = Hard .. SKILL_MAX = a bit
// above Hard). An AI bot fighting human X aims, reacts, sways, turns, sees and bursts with
// aiParams(X's smoothed estimate): the existing Easy / Normal / Hard tunings are the anchors and
// the values in between are interpolated, so nothing is ever outside the range the game already
// has (plus a small, capped step above Hard). The estimate is seeded from the player's memory and
// updated after every fight against an AI bot:
//     s += step(n) * (win ? +1 : -1) * closeness * trend
//   step(n)    large for a new player (finds the level within a few fights), ~0.02 later (stable:
//              in simulation the estimate settles with a spread of about +-0.05..0.1)
//   closeness  0.85..1.15 from how one-sided the fight was: the winner's health left, the time
//              to kill and the human's hit rate (a fast, clean win counts a bit more, a scrappy
//              one a bit less; the same for losses), so the SIGN only comes from win / loss and
//              the fixed point stays at winning half of the fights (K/D vs AI bots ~ 1)
//   trend      up to x1.7 while the last 10 fights are one-sided (7+ of 10), so a player who
//              improves (or tilts) is followed quickly; 1 otherwise
// Bots never read s directly: `eff` follows s with a 1 Hz exponential smoothing (about 3 s), so a
// single fight never makes the next bot jump, and nothing oscillates within a fight.
//
// Grudges. A bot (identified by its NAME, so the same bots "come back") holds a grudge against a
// human who killed it: strength = kills (max 5), fading by half every GRUDGE_HALF_LIFE AI matches
// in which that bot and player did not meet (persisted per player: { k, d, m }), plus every kill
// in the current match. Behaviour only (nothing is ever shown): higher target priority when
// visible, a longer chase, and hunting the player's last known position when idle.

import { BOT_LEVEL } from '../bots.js';

export const SKILL_MIN = 0;
export const SKILL_MAX = 1.15;
export const SKILL_DEFAULT = 0.55;
export const GRUDGE_HALF_LIFE = 4;      // AI matches without meeting
export const GRUDGE_MAX = 5;
const RECENT_N = 10;

// difficulty anchors: s -> the existing levels (+ a capped "hard+")
const ANCHORS = [
  [0, BOT_LEVEL.easy],
  [0.5, BOT_LEVEL.normal],
  [1.0, BOT_LEVEL.hard],
  [SKILL_MAX, { skill: 1.15, decay: 0.962, sway: 0.009, turn: 0.34, view: 76, burst: 1 }],
];
const KEYS = ['skill', 'decay', 'sway', 'turn', 'view', 'burst'];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Bot tuning for skill estimate s (the shape of bots.js BOT_LEVEL entries). */
export function aiParams(s, out = {}) {
  s = clamp(Number.isFinite(s) ? s : SKILL_DEFAULT, SKILL_MIN, SKILL_MAX);
  let i = 0;
  while (i < ANCHORS.length - 2 && s > ANCHORS[i + 1][0]) i++;
  const [s0, a] = ANCHORS[i], [s1, b] = ANCHORS[i + 1];
  const f = (s - s0) / (s1 - s0);
  for (const k of KEYS) out[k] = a[k] + (b[k] - a[k]) * f;
  out.s = s;
  return out;
}

export class SkillTracker {
  /** seed = persisted { v, n, t } (t: recent outcomes as a '0'/'1' string) or null. */
  constructor(seed) {
    this.v = SKILL_DEFAULT; this.n = 0; this.recent = [];
    this.seeded = false;
    if (seed) this.seed(seed);
    this.eff = this.v;
    this.start = this.v;
    this.params = aiParams(this.eff);
    this.wins = 0; this.losses = 0;      // this match
  }

  /** Apply a persisted estimate (also when it arrives after the match started). */
  seed(seed) {
    if (!seed || !Number.isFinite(seed.v)) return;
    const v = clamp(seed.v, SKILL_MIN, SKILL_MAX);
    const n = Number.isFinite(seed.n) ? Math.max(0, seed.n | 0) : 0;
    if (this.n === 0) { this.v = v; this.eff = v; this.start = v; }
    else this.v = clamp(v + (this.v - SKILL_DEFAULT), SKILL_MIN, SKILL_MAX);   // keep what this match already learned
    this.n += n;
    if (typeof seed.t === 'string') this.recent = seed.t.slice(-RECENT_N).split('').map((c) => (c === '1' ? 1 : 0)).concat(this.recent).slice(-RECENT_N);
    this.seeded = true;
  }

  step() { return 0.018 + 0.1 / (1 + this.n / 5); }

  /**
   * One finished fight against an AI bot. win = the human killed the bot.
   * info: { margin (winner's health left 0..1), ttkS (winner's time to kill, s, or NaN), acc (human hit rate 0..1 or NaN) }
   */
  fight(win, info = {}) {
    const margin = clamp(Number.isFinite(info.margin) ? info.margin : 0.5, 0, 1);
    const speed = Number.isFinite(info.ttkS) ? clamp((3 - info.ttkS) / 3, 0, 1) : 0.5;
    const accN = Number.isFinite(info.acc) ? clamp((info.acc - 0.15) / 0.45, 0, 1) : 0.5;
    const dom = 0.5 * margin + 0.25 * speed + 0.25 * (win ? accN : 1 - accN);
    const closeness = 0.85 + 0.3 * dom;
    this.recent.push(win ? 1 : 0);
    if (this.recent.length > RECENT_N) this.recent.shift();
    let trend = 1;
    if (this.recent.length >= 6) {
      const w = this.recent.reduce((a, b) => a + b, 0) / this.recent.length;
      if ((win && w >= 0.7) || (!win && w <= 0.3)) trend = 1 + (Math.abs(w - 0.5) - 0.15) * 2;
    }
    this.v = clamp(this.v + this.step() * (win ? 1 : -1) * closeness * trend, SKILL_MIN, SKILL_MAX);
    this.n++;
    if (win) this.wins++; else this.losses++;
  }

  /** 1 Hz: bots follow the estimate smoothly. Returns true when the bot tuning changed. */
  smooth() {
    const d = this.v - this.eff;
    if (Math.abs(d) < 1e-4) return false;
    this.eff += d * 0.3;
    aiParams(this.eff, this.params);
    return true;
  }

  snapshot() { return { v: Math.round(this.v * 1000) / 1000, n: this.n, t: this.recent.join('') }; }
}

/** Persisted grudge entry -> current strength (0 = none). am = the player's AI-match counter. */
export function grudgeStrength(e, am) {
  if (!e || !(e.k > 0)) return 0;
  const age = Math.max(0, (am | 0) - (e.m | 0));
  const s = Math.min(GRUDGE_MAX, e.k) * 0.5 ** (age / GRUDGE_HALF_LIFE);
  return s < 0.3 ? 0 : s;
}

/** Fold one AI match into the persisted grudges of a player (beat / lostTo: { botName: n }). */
export function updateGrudges(gr, am, beat, lostTo) {
  const out = {};
  // fade everything first (so entries are stored at their current strength), then add this match
  for (const [name, e] of Object.entries(gr || {})) {
    const s = grudgeStrength(e, am - 1);
    if (s > 0) out[name] = { k: Math.round(s * 100) / 100, d: e.d | 0, m: am - 1 };
  }
  const names = new Set([...Object.keys(beat || {}), ...Object.keys(lostTo || {})]);
  for (const name of names) {
    const e = out[name] || { k: 0, d: 0, m: am };
    e.k = Math.min(GRUDGE_MAX, Math.round((e.k + (beat[name] | 0)) * 100) / 100);
    e.d = Math.min(99, (e.d | 0) + (lostTo[name] | 0));
    e.m = am;          // they met: the grudge is fresh again
    if (e.k > 0 || e.d > 0) out[name] = e;
  }
  // keep the 24 strongest (a handful of bot names ever matter)
  const keep = Object.entries(out).sort((a, b) => b[1].k - a[1].k || b[1].m - a[1].m).slice(0, 24);
  return Object.fromEntries(keep);
}

/** Priority factor for a target with grudge strength g: its squared distance is divided by f^2. */
export function grudgeFactor(g) { return g > 0 ? 1 + Math.min(1.2, 0.45 * g) : 1; }
