// What Hopshot tells Supermemory: the per-player supporting context (entity context: who the
// entity is + exactly what to extract and what to ignore) and the natural-language match summary
// the server writes for every human at the end of a match. Pure functions.
//
// Why a TOTALS block: memories are created with dreaming 'instant', which extracts each document
// on its own, so a single match can never yield "wins most CTF on Skyline". The server knows the
// exact running totals (state.js), so every summary carries them; the supporting context says that
// newer totals replace older ones, and Supermemory's update chain keeps the latest version.

import { GUNS, ATTACHMENTS } from '../../shared/weapons.js';
import { MODES } from '../../shared/modes.js';
import { MAPS } from '../../shared/maps/index.js';

export const RANGE_NAMES = ['close range (under 10 m)', 'mid range (10-30 m)', 'long range (over 30 m)'];
export const RANGE_SHORT = ['close', 'mid', 'long'];
export function rangeBand(d) { return d < 10 ? 0 : d < 30 ? 1 : 2; }

const mapName = (id) => (MAPS.find((m) => m.id === id) || {}).name || id;
const modeName = (id) => (MODES[id] || {}).name || id;
const gunName = (g) => (GUNS[g] || {}).name || 'unknown gun';
const GUN_BY_KEY = Object.fromEntries(GUNS.map((g) => [g.key, g]));
const GUN_CLASS = { assault: 'assault rifle', sniper: 'sniper rifle', shotgun: 'shotgun' };
const cleanNick = (n) => String(n || '').replace(/["\\\n\r]/g, '').slice(0, 16);

/**
 * Supporting context for one player's namespace (Supermemory caps it at 1500 characters). Sent
 * with every match summary; it persists on the namespace (v5: supportingContext = v3 entityContext).
 */
export function entityContext(nick) {
  const who = nick ? `"${cleanNick(nick)}"` : 'this player';
  return [
    `Memory of ONE player of Hopshot, a browser arena FPS: the player ${who} (the nickname may change). Everything is written by the game server after each match, with exact numbers.`,
    'Game: modes Free-for-all, Team Deathmatch, Capture the Flag, Hardpoint; maps Crate Cove, Hollow Pines, Maple Street, Metro Line, Prism Yard, Skyline; guns Maul, Vireo (assault rifles), Kestrel, Halberd (snipers), Breaker, Squall (shotguns); attachments Prism Optic, Extended Mag, Heavy Rounds, Long Barrel, Light Stock, Quick Hands. Opponents are humans, or bots with names like Pixel or Nova. Ranges: close under 10 m, mid 10-30 m, long over 30 m.',
    'Each document has TOTALS (cumulative over all recorded matches; a newer document\'s totals replace older ones) and THIS MATCH.',
    'Make one short memory per durable fact, always naming the player and with its numbers. From TOTALS (say "as of" the date): best and worst guns and attachments and at which range, results per mode and map, what the player dies to, human teammates and how that group does, AI bots beaten and lost to, skill rating against AI bots and its trend. From THIS MATCH: only the result and what stands out, with mode, map and date.',
    'Skip: match length, room type, shot counts, other players\' scores, anything outside the game or personal. Never guess beyond the numbers. Refer to the player by nickname, never as he or she.',
  ].join('\n').slice(0, 1500);
}

function pct(n, d) { return d > 0 ? Math.round((100 * n) / d) + '%' : 'n/a'; }
function median(a) {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function plural(n, one, many = one + 's') { return `${n} ${n === 1 ? one : many}`; }
function list(items) {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}
export function attachmentNames(mask) {
  const out = [];
  for (const a of ATTACHMENTS) if (mask & (1 << a.id)) out.push(a.name);
  return out;
}
function counted(obj) {
  return Object.entries(obj || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}
function bandList(b) {
  const out = [];
  for (let i = 0; i < 3; i++) if (b[i]) out.push(`${b[i]} at ${RANGE_SHORT[i]} range`);
  return out.join(', ');
}
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
const sum3 = (b) => (b ? b[0] + b[1] + b[2] : 0);
/** The band with strictly the most entries, or -1 on a tie. */
const mostBand = (b) => { const m = Math.max(b[0], b[1], b[2]); const i = b.indexOf(m); return b.indexOf(m, i + 1) >= 0 ? -1 : i; };

/** TOTALS sentences from a state (state.js): exact cumulative numbers, only what has data, each a full sentence naming the player. */
export function totalsLines(st, nick, date) {
  const L = [];
  if (!st || !(st.n > 0)) return L;
  const [w, l, dr] = st.wl || [0, 0, 0];
  L.push(`- As of ${date}, ${nick} has won ${w} and lost ${l}${dr ? ` (${dr} drawn)` : ''} of ${plural(st.n, 'recorded Hopshot match', 'recorded Hopshot matches')}.`);
  const mm = Object.entries(st.mm || {}).filter(([, v]) => v[1] >= 2).sort((a, b) => b[1][1] - a[1][1] || b[1][0] - a[1][0]).slice(0, 3);
  for (const [k, v] of mm) { const [mo, mp] = k.split('|'); L.push(`- ${nick} has won ${v[0]} of ${v[1]} ${modeName(mo)} matches on ${mapName(mp)}.`); }
  const guns = Object.entries(st.g || {}).map(([k, g]) => ({ k, g, kills: sum3(g.k), deaths: sum3(g.d) })).filter((x) => x.kills + x.deaths >= 4)
    .sort((a, b) => b.kills - a.kills).slice(0, 3);
  for (const x of guns) {
    const G = GUN_BY_KEY[x.k];
    let line = `- ${nick} has ${x.kills} kills in total with the ${G.name} ${GUN_CLASS[G.cls]}`;
    if (x.kills) { const mb = mostBand(x.g.k); line += mb >= 0 ? `, mostly at ${RANGE_SHORT[mb]} range (${bandList(x.g.k)})` : ` (${bandList(x.g.k)})`; }
    if (x.g.s) line += `, hit rate ${pct(x.g.h, x.g.s)}`;
    if (x.deaths) line += `, and died ${plural(x.deaths, 'time')} holding it (${bandList(x.g.d)})`;
    L.push(line + '.');
  }
  const gm = [];
  for (const [mp, row] of Object.entries(st.gm || {})) for (const [k, kd] of Object.entries(row)) if (kd[0] + kd[1] >= 6) gm.push({ mp, k, kd });
  gm.sort((a, b) => (b.kd[0] - b.kd[1]) - (a.kd[0] - a.kd[1]));
  for (const x of gm.slice(0, 2)) L.push(`- With the ${GUN_BY_KEY[x.k].name} on ${mapName(x.mp)}, ${nick} has ${x.kd[0]} kills to ${x.kd[1]} deaths in total.`);
  const db = Object.entries(st.db || {}).map(([k, b]) => ({ k, b, n: sum3(b) })).filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 3);
  if (db.length) L.push(`- In total ${nick} was killed ${list(db.map((x) => `${x.n} times by the ${GUN_BY_KEY[x.k].name} (${bandList(x.b)})`))}.`);
  const tm = Object.entries(st.tm || {}).filter(([, v]) => v[1] >= 2).sort((a, b) => b[1][1] - a[1][1]).slice(0, 3);
  for (const [n, v] of tm) L.push(`- ${nick} has won ${v[0]} of ${v[1]} matches with human teammate "${n}".`);
  const bb = Object.entries(st.bb || {}).filter(([, v]) => v[0] + v[1] >= 2);
  if (bb.length) {
    const beat = bb.filter(([, v]) => v[0] > 0).sort((a, b) => b[1][0] - a[1][0]).slice(0, 3).map(([n, v]) => `${n} ${plural(v[0], 'time')}`);
    const lost = bb.filter(([, v]) => v[1] > 0).sort((a, b) => b[1][1] - a[1][1]).slice(0, 3).map(([n, v]) => `${n} ${plural(v[1], 'time')}`);
    L.push(`- Against AI bots in total, ${nick} ${beat.length ? 'beat ' + list(beat) : 'has not beaten any yet'}${lost.length ? ' and was killed by ' + list(lost) : ''}.`);
  }
  if (st.sk && st.sk.n >= 5) {
    const t = st.sk.t || '';
    const recent = t.length >= 6 ? `; ${t.split('').filter((c) => c === '1').length} of the last ${t.length} fights won` : '';
    L.push(`- ${nick}'s skill rating against AI bots is ${st.sk.v.toFixed(2)} (0 = easy, 1 = hard) after ${st.sk.n} fights${recent}.`);
  }
  return L;
}

/**
 * The match summary for one human. d = {
 *   nick, date (YYYY-MM-DD), mode, mapId, team ('' | 'a' | 'b'), coop,
 *   result: 'won' | 'lost' | 'draw', place (ffa: 1-based rank), players (ffa: count),
 *   teamScore, enemyScore, scoreUnit, kills, deaths, obj,
 *   teammates: [{ name, bot }], botLevel ('easy'|'normal'|'hard'|'ai'|''),
 *   guns: [{ gun, mask, shots, hits, kills, killDists: [m], deaths: [c, m, l] }],
 *   deathsBy: [{ gun, bands: [c, m, l] }], fell,
 *   beat: { botName: n }, lostTo: { botName: n }   (AI bots only)
 *   skill: null | { before, after, wins, losses }   (AI bots only)
 * }
 * totals: the player's state AFTER this match was folded in (state.js), or null (then no TOTALS).
 */
export function matchSummary(d, totals) {
  const nick = cleanNick(d.nick) || 'The player';
  const mode = modeName(d.mode), map = mapName(d.mapId);
  const L = [`Hopshot match summary for player "${nick}", ${d.date}.`];
  const T = totalsLines(totals, nick, d.date);
  if (T.length) L.push(`TOTALS as of ${d.date} (exact, over all of ${nick}'s recorded matches; they replace older totals):`, ...T);

  const on = `On ${d.date} (${mode} on ${map})`;
  const vs = d.botLevel === 'ai' ? ' against adaptive AI bots' : d.botLevel ? ` with ${d.botLevel} bots` : '';
  L.push(`THIS MATCH: ${mode} on ${map}, ${d.date}${vs}.`);
  const mates = (d.teammates || []).filter((t) => !t.bot).map((t) => `"${cleanNick(t.name)}"`);
  if (d.team) {
    const res = d.result === 'won' ? 'won' : d.result === 'lost' ? 'lost' : 'drew';
    let line = `- On ${d.date} ${nick}'s team ${res} ${mode} on ${map} ${d.teamScore}-${d.enemyScore} (${d.scoreUnit})`;
    if (mates.length) line += ` with human teammate${mates.length > 1 ? 's' : ''} ${list(mates)}`;
    if (d.coop) line += ', humans against bots';
    L.push(line + '.');
  } else {
    const res = d.result === 'won' ? 'won' : d.result === 'draw' ? 'tied for first in' : `finished ${ordinal(d.place)} of ${d.players} in`;
    L.push(`- On ${d.date} ${nick} ${res} the free-for-all on ${map}${mates.length ? ` (humans ${list(mates)} also played)` : ''}.`);
  }
  let score = `- ${on} ${nick} had ${plural(d.kills, 'kill')} and ${plural(d.deaths, 'death')}`;
  if (d.mode === 'ctf' && d.obj) score += ` and ${plural(d.obj, 'flag capture')}`;
  if (d.mode === 'hardpoint' && d.obj) score += ` and held the zone for ${d.obj} s`;
  L.push(`${score}.`);
  const guns = (d.guns || []).filter((g) => g.kills > 0 || (g.deaths && sum3(g.deaths) > 0)).sort((a, b) => b.kills - a.kills || b.shots - a.shots);
  for (const g of guns.slice(0, 3)) {
    const att = attachmentNames(g.mask);
    let line = `- ${on} ${nick}'s ${gunName(g.gun)}${att.length ? ' with ' + list(att) : ''} got ${plural(g.kills, 'kill')}`;
    const m = median(g.killDists || []);
    if (Number.isFinite(m)) line += ` at a typical ${Math.round(m)} m (${RANGE_SHORT[rangeBand(m)]} range)`;
    if (g.shots >= 5) line += `, hit rate ${pct(g.hits, g.shots)}`;
    const died = sum3(g.deaths);
    if (died) line += `; ${nick} died ${plural(died, 'time')} holding it (${bandList(g.deaths)})`;
    L.push(`${line}.`);
  }
  const by = (d.deathsBy || []).filter((x) => sum3(x.bands) > 0).sort((a, b) => sum3(b.bands) - sum3(a.bands));
  if (by.length || d.fell) {
    const parts = by.slice(0, 3).map((x) => `${sum3(x.bands)} times by the ${gunName(x.gun)} (${bandList(x.bands)})`);
    if (d.fell) parts.push(`fell off the map ${plural(d.fell, 'time')}`);
    L.push(`- ${on} ${nick} was killed ${list(parts)}.`);
  }
  if (d.botLevel === 'ai') {
    const beat = counted(d.beat).slice(0, 4).map(([n, c]) => `${n} ${plural(c, 'time')}`);
    const lost = counted(d.lostTo).slice(0, 4).map(([n, c]) => `${n} ${plural(c, 'time')}`);
    if (beat.length || lost.length) L.push(`- ${on} ${nick} ${beat.length ? 'beat AI bots ' + list(beat) : 'beat no AI bot'}${lost.length ? ' and was killed by ' + list(lost) : ''}.`);
    if (d.skill) {
      const tr = d.skill.after - d.skill.before;
      const trend = tr > 0.02 ? 'rising' : tr < -0.02 ? 'falling' : 'steady';
      L.push(`- ${on} ${nick}'s skill rating against AI bots went ${d.skill.before.toFixed(2)} -> ${d.skill.after.toFixed(2)} (${trend}; ${d.skill.wins} fights won, ${d.skill.losses} lost).`);
    }
  }
  return L.join('\n');
}
