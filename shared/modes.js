// Game modes and match configuration. Pure ESM, shared by the server and the client (no DOM,
// no Node APIs, deterministic).
//
// MODES[id] = { id, name, blurb, teams, scoreLimit, timeLimitS, minPlayers, scoreLimitMin,
//               scoreLimitMax, scoreLimitStep, scoreUnit }
//   teams        true for team modes (teams 'a' and 'b'), false for free-for-all
//   scoreLimit   default score limit (first to this wins immediately)
//   timeLimitS   default time limit in seconds (every mode also ends on time; highest score wins)
//   minPlayers   participants (humans + bots) the mode needs to make sense
//   scoreUnit    what a point is: 'kills' | 'captures' | 'points'
//
// Rules (implemented by server/room.js):
//   ffa        every player for themselves; +1 per kill (suicides / falls do not change kills).
//   tdm        +1 team point per enemy kill; first team to scoreLimit.
//   ctf        touch the enemy flag (home or dropped) to carry it; bring it to your own stand
//              while your own flag is home to score 1 capture. A carrier who dies drops the flag
//              where they died (on the ground below; a flag dropped into the void returns home).
//              A dropped flag returns home when a defender touches it or after FLAG_RETURN_S.
//              First to scoreLimit captures.
//   hardpoint  one active zone from map.hardpoints, in map order, rotating every
//              HARDPOINT_ROTATE_S. A team scores 1 point per full second (60 ticks) during which
//              it has living players inside the zone and the other team has none. Both teams
//              inside = contested = nobody scores. First to scoreLimit.
//   ENDING     a score limit ends the match at once (that side wins). At the time limit the
//              highest score wins. TIES: team modes -> a draw (winner null). FFA -> the player
//              with more kills, then fewer deaths wins; still equal -> a draw.
//
// sanitizeMatchConfig(input, prev?) -> a complete, valid config:
//   { mode, mapId, bots: { fill }, coop, timeLimitS, scoreLimit }
//   - mode       one of MODE_IDS (unknown -> prev.mode -> 'ffa')
//   - mapId      one of MAP_IDS (unknown -> prev.mapId -> DEFAULT_MAP_ID)
//   - bots.fill  0..MAX_PLAYERS: bots are added until there are `fill` participants (0 = no
//                bots). Team modes split the bots so both teams end up the same size.
//   - coop       humans vs bots (team modes only; forced false in ffa): every human on team 'a',
//                bots on team 'b'; the bot team has max(fill - humans, humans) bots.
//   - timeLimitS TIME_LIMIT_MIN_S..TIME_LIMIT_MAX_S (rounded to whole seconds)
//   - scoreLimit the mode's scoreLimitMin..scoreLimitMax (integer)
//   `input` may be partial: missing fields keep prev's values, except that when the MODE
//   changes and no scoreLimit is given, scoreLimit resets to the new mode's default (3
//   captures and 150 points are not interchangeable). Never throws.

import { MAX_PLAYERS } from './constants.js';
import { MAP_IDS, DEFAULT_MAP_ID } from './maps/index.js';

export const TEAMS = ['a', 'b'];
export const TEAM_NAMES = { a: 'Team A', b: 'Team B' };
export const FLAG_RETURN_S = 20;          // dropped flag returns home after this
export const HARDPOINT_ROTATE_S = 60;     // active zone moves on after this
export const SPAWN_PROTECT_MS = 1500;     // spawn protection (ends early when the player fires)
export const FLAG_TOUCH_RADIUS = 1.4;     // m, horizontal distance to touch a flag / stand
export const TIME_LIMIT_MIN_S = 10;
export const TIME_LIMIT_MAX_S = 3600;

export const MODES = Object.freeze({
  ffa: Object.freeze({
    id: 'ffa', name: 'Free-for-all', blurb: 'Everyone for themselves. Most kills wins.',
    teams: false, scoreLimit: 25, timeLimitS: 300, minPlayers: 2,
    scoreLimitMin: 1, scoreLimitMax: 200, scoreLimitStep: 5, scoreUnit: 'kills',
  }),
  tdm: Object.freeze({
    id: 'tdm', name: 'Team Deathmatch', blurb: 'Two teams, one kill count. First team to the limit wins.',
    teams: true, scoreLimit: 50, timeLimitS: 420, minPlayers: 2,
    scoreLimitMin: 1, scoreLimitMax: 500, scoreLimitStep: 10, scoreUnit: 'kills',
  }),
  ctf: Object.freeze({
    id: 'ctf', name: 'Capture the Flag', blurb: 'Grab their flag, bring it to yours while yours is home.',
    teams: true, scoreLimit: 3, timeLimitS: 600, minPlayers: 2,
    scoreLimitMin: 1, scoreLimitMax: 20, scoreLimitStep: 1, scoreUnit: 'captures',
  }),
  hardpoint: Object.freeze({
    id: 'hardpoint', name: 'Hardpoint', blurb: 'Hold the active zone alone to score. It moves every minute.',
    teams: true, scoreLimit: 150, timeLimitS: 600, minPlayers: 2,
    scoreLimitMin: 10, scoreLimitMax: 1000, scoreLimitStep: 25, scoreUnit: 'points',
  }),
});
export const MODE_IDS = Object.freeze(['ffa', 'tdm', 'ctf', 'hardpoint']);
export const DEFAULT_MODE = 'ffa';

export function isTeamMode(mode) { const m = MODES[mode]; return !!(m && m.teams); }
export function otherTeam(t) { return t === 'a' ? 'b' : t === 'b' ? 'a' : ''; }

/** Bot difficulty. 'hard' is the original tuning. */
export const BOT_LEVELS = ['easy', 'normal', 'hard'];
export const DEFAULT_BOT_LEVEL = 'hard';

export function defaultMatchConfig(mode = DEFAULT_MODE, mapId = DEFAULT_MAP_ID) {
  const m = MODES[mode] || MODES[DEFAULT_MODE];
  return { mode: m.id, mapId: MAP_IDS.includes(mapId) ? mapId : DEFAULT_MAP_ID, bots: { fill: 0, level: DEFAULT_BOT_LEVEL }, coop: false,
    timeLimitS: m.timeLimitS, scoreLimit: m.scoreLimit };
}

function int(v) { return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function sanitizeMatchConfig(input, prev) {
  const base = prev && typeof prev === 'object' ? prev : null;
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const prevMode = base && MODES[base.mode] ? base.mode : DEFAULT_MODE;
  const mode = typeof src.mode === 'string' && MODES[src.mode] ? src.mode : prevMode;
  const M = MODES[mode];
  const mapId = typeof src.mapId === 'string' && MAP_IDS.includes(src.mapId) ? src.mapId
    : base && MAP_IDS.includes(base.mapId) ? base.mapId : DEFAULT_MAP_ID;

  let fill = null;
  if (src.bots && typeof src.bots === 'object') fill = int(src.bots.fill);
  else if (typeof src.bots === 'number') fill = int(src.bots);
  if (fill === null) fill = base && base.bots ? int(base.bots.fill) : 0;
  fill = clamp(fill ?? 0, 0, MAX_PLAYERS);
  let level = src.bots && typeof src.bots === 'object' ? src.bots.level : undefined;
  if (!BOT_LEVELS.includes(level)) level = base && base.bots && BOT_LEVELS.includes(base.bots.level) ? base.bots.level : DEFAULT_BOT_LEVEL;

  let coop = typeof src.coop === 'boolean' ? src.coop : !!(base && base.coop);
  if (!M.teams) coop = false;

  let timeLimitS = int(src.timeLimitS);
  if (timeLimitS === null) timeLimitS = base ? int(base.timeLimitS) : null;
  if (timeLimitS === null) timeLimitS = M.timeLimitS;
  timeLimitS = clamp(timeLimitS, TIME_LIMIT_MIN_S, TIME_LIMIT_MAX_S);

  let scoreLimit = int(src.scoreLimit);
  if (scoreLimit === null) scoreLimit = base && base.mode === mode ? int(base.scoreLimit) : null;
  if (scoreLimit === null) scoreLimit = M.scoreLimit;
  scoreLimit = clamp(scoreLimit, M.scoreLimitMin, M.scoreLimitMax);

  return { mode, mapId, bots: { fill, level }, coop, timeLimitS, scoreLimit };
}

export function sameMatchConfig(a, b) {
  return !!a && !!b && a.mode === b.mode && a.mapId === b.mapId && a.bots.fill === b.bots.fill && a.bots.level === b.bots.level && a.coop === b.coop &&
    a.timeLimitS === b.timeLimitS && a.scoreLimit === b.scoreLimit;
}

/** Player-count range a map size is built for (map.size). */
export const MAP_SIZE_PLAYERS = Object.freeze({ small: [2, 8], medium: [4, 12], large: [8, 20] });

/**
 * Winner of a finished match. scores = { a, b } for team modes; rows = [{ id, kills, deaths }]
 * for ffa. Returns { winner: 'a' | 'b' | <player id> | null, draw }.
 */
export function decideWinner(mode, scores, rows) {
  if (isTeamMode(mode)) {
    if (scores.a > scores.b) return { winner: 'a', draw: false };
    if (scores.b > scores.a) return { winner: 'b', draw: false };
    return { winner: null, draw: true };
  }
  let best = null, tie = false;
  for (const r of rows || []) {
    if (!best || r.kills > best.kills || (r.kills === best.kills && r.deaths < best.deaths)) { best = r; tie = false; }
    else if (r.kills === best.kills && r.deaths === best.deaths) tie = true;
  }
  if (!best || tie) return { winner: null, draw: true };
  return { winner: best.id, draw: false };
}
