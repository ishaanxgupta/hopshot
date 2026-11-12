#!/usr/bin/env node
// Game modes, teams, lobby, spawns and mode-aware bots (protocol v4). Plain Node, no framework.
//
//   node tools/modes.test.js [--port 3112] [--quick] [--skip-e2e]
//
// Part 1 (in-process, fast): a Room driven tick by tick with fake sockets.
//   config sanitising, tie rules, lobby / host / start / countdown / results -> lobby, host
//   migration, late-join team balance, co-op teams, friendly fire, spawn protection, every CTF
//   rule (take, drop, 20 s return, touch return, capture only while home), hardpoint scoring /
//   contested / rotation, time and score limits, public rotation, bots playing complete
//   shortened matches of every mode on every map (scores add up), and the spawn-visibility
//   measurement (legacy vs smart spawns, busy matches on every map).
// Part 2 (end to end): a real server child on --port with headless client/net.js clients:
//   full lobby -> countdown -> playing -> results -> lobby cycles of every mode on two maps,
//   map switching reaching the client (prediction bit-exact across map / phase changes and
//   respawns), late join, host migration and net.state.match contents.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.COUNTDOWN_MS = '500';
process.env.PUBLIC_COUNTDOWN_MS = '300';
process.env.RESULTS_MS = '1000';
process.env.BOTS = '4';

const { Room } = await import('../server/room.js');
const { Bot } = await import('../server/bots.js');
const { spawnVisible } = await import('../server/spawns.js');
const { MAPS, MAP_IDS } = await import('../shared/maps/index.js');
const { MODES, MODE_IDS, sanitizeMatchConfig, decideWinner, TIME_LIMIT_MIN_S } = await import('../shared/modes.js');
const { eyeHeight } = await import('../shared/physics.js');
const { createCmd, PLAYER_ENTRY_BYTES } = await import('../shared/protocol.js');
const { MAX_PLAYERS } = await import('../shared/constants.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const PORT = args.includes('--port') ? parseInt(args[args.indexOf('--port') + 1], 10) : 3112;
const QUICK = args.includes('--quick');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`); };
const section = (s) => console.log(`\n== ${s} ==`);

Bot.prewarm(MAPS, true);

// ------------------------------------------------------------------ in-process helpers
function fakeHuman(room, name) {
  const msgs = [];
  let bin = 0;
  const ws = {
    readyState: 1, bufferedAmount: 0,
    send(m) { if (typeof m === 'string') msgs.push(JSON.parse(m)); else bin++; },
    terminate() {},
  };
  const p = room.addHuman(ws, name);
  return { p, msgs, ws, get bin() { return bin; }, last(t) { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].t === t) return msgs[i]; return null; },
    evs(e) { return msgs.filter((m) => m.t === 'ev' && m.e === e); } };
}
function steps(room, n) { for (let i = 0; i < n; i++) { room.step(); if (room.destroyed) return; } }
function privateRoom(cfg) { return new Room('t', { isPrivate: true, config: cfg }); }
function startNow(room, host) {
  const e = room.requestStart(host);
  if (e) throw new Error(`start failed: ${e}`);
  steps(room, Math.ceil(500 / (1000 / 60)) + 2);
  if (room.phase !== 'playing') throw new Error(`not playing: ${room.phase}`);
}
function place(p, x, y, z) { p.state.x = x; p.state.y = y; p.state.z = z; p.state.vx = p.state.vy = p.state.vz = 0; }
function aimCmd(from, to) {
  const ex = from.state.x, ey = from.state.y + eyeHeight(from.state), ez = from.state.z;
  const dx = to.state.x - ex, dy = to.state.y + 1.2 - ey, dz = to.state.z - ez;
  const c = createCmd();
  c.yaw = Math.atan2(-dx, -dz); c.pitch = Math.atan2(dy, Math.hypot(dx, dz)); c.seq = 1;
  return c;
}
/** Shoot `to` from `from` with the current gun through the lag-compensated path. */
function shoot(room, from, to) {
  from.wstate.weapon = 0; from.wstate.spread = 0;
  room.fire(from, aimCmd(from, to), room.tick - 1, 0);
}

// ------------------------------------------------------------------ part 1
function testConfig() {
  section('match config (shared/modes.js)');
  const d = sanitizeMatchConfig({});
  check(d.mode === 'ffa' && MAP_IDS.includes(d.mapId) && d.bots.fill === 0 && d.coop === false && d.timeLimitS === MODES.ffa.timeLimitS && d.scoreLimit === MODES.ffa.scoreLimit,
    'empty input -> full default config');
  const c1 = sanitizeMatchConfig({ mode: 'ctf', mapId: 'nope', bots: { fill: 99 }, coop: 'yes', timeLimitS: 1, scoreLimit: 1e9 });
  check(c1.mode === 'ctf' && MAP_IDS.includes(c1.mapId) && c1.bots.fill === MAX_PLAYERS && c1.coop === false && c1.timeLimitS === TIME_LIMIT_MIN_S && c1.scoreLimit === MODES.ctf.scoreLimitMax,
    'out-of-range values clamped, unknown map / non-boolean coop ignored');
  const c2 = sanitizeMatchConfig({ mode: 'hardpoint' }, c1);
  check(c2.scoreLimit === MODES.hardpoint.scoreLimit && c2.bots.fill === MAX_PLAYERS && c2.timeLimitS === TIME_LIMIT_MIN_S, 'mode change resets the score limit to the new default, keeps the rest');
  const c3 = sanitizeMatchConfig({ coop: true, mode: 'ffa' }, c2);
  check(c3.coop === false, 'co-op is forced off in ffa');
  const c4 = sanitizeMatchConfig({ coop: true, bots: 6 }, c2);
  check(c4.coop === true && c4.bots.fill === 6 && c4.mode === 'hardpoint', 'partial edit: coop + numeric bots shorthand');
  check(sanitizeMatchConfig(null).mode === 'ffa' && sanitizeMatchConfig([1, 2]).mode === 'ffa' && sanitizeMatchConfig({ mode: { x: 1 }, timeLimitS: NaN }).timeLimitS === MODES.ffa.timeLimitS,
    'garbage input never throws');
  check(MODE_IDS.every((m) => MODES[m].id === m && typeof MODES[m].teams === 'boolean' && MODES[m].minPlayers >= 2), 'MODES table complete');
  const w1 = decideWinner('tdm', { a: 3, b: 3 }, []);
  const w2 = decideWinner('ctf', { a: 1, b: 2 }, []);
  const w3 = decideWinner('ffa', { a: 0, b: 0 }, [{ id: 1, kills: 5, deaths: 2 }, { id: 2, kills: 5, deaths: 1 }]);
  const w4 = decideWinner('ffa', { a: 0, b: 0 }, [{ id: 1, kills: 5, deaths: 1 }, { id: 2, kills: 5, deaths: 1 }]);
  check(w1.draw && w1.winner === null && w2.winner === 'b' && w3.winner === 2 && w4.draw, 'ties: team modes draw; ffa -> more kills, then fewer deaths, else draw');
}

function testLobby() {
  section('lobby, host, phases, host migration');
  const room = privateRoom({ mode: 'tdm', mapId: 'crate_cove', bots: { fill: 6 } });
  const A = fakeHuman(room, 'Ann'), B = fakeHuman(room, 'Ben');
  check(room.phase === 'lobby' && room.hostId === A.p.id, 'private room starts in the lobby; first human is host');
  const w = A.msgs[0];
  check(w.t === 'welcome' && w.match && w.match.phase === 'lobby' && w.mapId === 'crate_cove' && w.lobby.hostId === A.p.id && w.v === 4,
    'welcome carries match (phase, config), lobby roster with host, map id');
  check(room.botCount === 0 && !room.players.some((p) => p.alive), 'lobby: no bots, nobody alive');
  steps(room, 240);
  check(A.bin === 0, 'lobby: no snapshots are sent');
  check(A.p.team !== B.p.team && [A.p.team, B.p.team].every((t) => t === 'a' || t === 'b'), 'humans auto-assigned to different teams in a team mode');
  check(room.requestConfig(B.p, { mode: 'ctf' }) === 'not_host' && room.requestStart(B.p) === 'not_host', 'only the host may change the config or start');
  check(room.requestConfig(A.p, 'x') === 'bad_config' && room.requestTeam(A.p, 'c') === 'bad_team', 'bad config / team rejected');
  check(room.requestConfig(A.p, { mode: 'ctf', mapId: 'hollow_pines', timeLimitS: 30 }) === null && room.config.mode === 'ctf' && room.map.id === 'hollow_pines',
    'host config change applied (mode + map: the room world follows the map)');
  const mm = B.last('match');
  check(mm && mm.mapId === 'hollow_pines' && mm.config.mode === 'ctf' && mm.config.timeLimitS === 30, 'config change broadcast to everyone (match)');
  check(room.requestTeam(B.p, A.p.team) === null && B.p.team === A.p.team && B.last('team'), 'team switch in the lobby');
  check(room.requestStart(A.p) === null && room.phase === 'countdown', 'host starts -> countdown');
  check(Math.abs(room.teamCounts().a - room.teamCounts().b) === 0 && room.botCount === 4, `bots fill both teams evenly around the humans (a ${room.teamCounts().a} / b ${room.teamCounts().b})`);
  check(room.requestTeam(B.p, 'a') === 'bad_phase' && room.requestConfig(A.p, { mode: 'ffa' }) === 'bad_phase', 'no team switch / config edits outside the lobby');
  steps(room, 40);
  check(room.phase === 'playing' && room.players.every((p) => p.alive), 'countdown -> playing, everyone spawned');
  check(A.evs('match_start').length === 1 && A.last('obj') && A.last('obj').flags, 'match_start event + objective state sent');
  // late joiner during the match: smaller team
  const C = fakeHuman(room, 'Cid');
  const cnt = room.teamCounts(C.p);
  check(C.p.alive && C.msgs[0].match.phase === 'playing' && C.msgs[0].obj && C.msgs[0].obj.flags, 'late joiner enters the running match with full state in its welcome');
  check((C.p.team === 'a' ? cnt.ha : cnt.hb) <= (C.p.team === 'a' ? cnt.hb : cnt.ha), `late joiner put on the team with fewer humans (${C.p.team})`);
  check(room.teamCounts().a === room.teamCounts().b, 'bots rebalanced so the teams stay even');
  // host migration
  room.removePlayer(A.p);
  check(room.hostId === B.p.id && B.last('match').hostId === B.p.id, 'host leaves -> the longest-present human becomes host');
  // end on time -> results -> lobby
  steps(room, 30 * 60 + 5);
  check(room.phase === 'results' && B.last('result') && B.last('result').reason === 'time', 'time limit ends the match (results, reason time)');
  const res = B.last('result');
  check(res.draw === (res.scores.a === res.scores.b) && (res.draw || res.winner === (res.scores.a > res.scores.b ? 'a' : 'b')), `winner by score (${JSON.stringify(res.scores)} -> ${res.winner})`);
  check(!room.players.some((p) => p.alive), 'results: everyone despawned');
  steps(room, 70);
  check(room.phase === 'lobby' && room.config.mode === 'ctf' && room.map.id === 'hollow_pines' && room.botCount === 0, 'results -> back to the lobby with the same config, bots removed');
  check(room.requestLobby(C.p) === 'not_host', 'only the host returns to the lobby');
  room.requestStart(B.p); steps(room, 10);
  check(room.requestLobby(B.p) === null && room.phase === 'lobby', 'host can abort back to the lobby');
  room.removePlayer(B.p); room.removePlayer(C.p);
  check(room.destroyed, 'room destroyed when the last human leaves');
}

function testTeams() {
  section('teams: late joins, co-op, no-bot balance');
  const room = privateRoom({ mode: 'tdm', mapId: 'crate_cove', bots: { fill: 0 } });
  const hs = [fakeHuman(room, 'h0')];
  startNow(room, hs[0].p);
  for (let i = 1; i < 6; i++) hs.push(fakeHuman(room, `h${i}`));
  const c = room.teamCounts();
  check(c.ha === 3 && c.hb === 3 && room.botCount === 0, `late joiners alternate to the smaller team (${c.ha} vs ${c.hb}), fill 0 = no bots`);
  for (const h of hs) room.removePlayer(h.p);

  const co = privateRoom({ mode: 'hardpoint', mapId: 'maple_street', bots: { fill: 8 }, coop: true });
  const H = [fakeHuman(co, 'c0'), fakeHuman(co, 'c1'), fakeHuman(co, 'c2')];
  startNow(co, H[0].p);
  const humansA = H.every((h) => h.p.team === 'a');
  const bots = co.players.filter((p) => p.bot);
  check(humansA && bots.length === 5 && bots.every((b) => b.team === 'b'), `co-op: all humans on team a, ${bots.length} bots on team b (fill 8 - 3 humans)`);
  const co2 = privateRoom({ mode: 'ctf', mapId: 'crate_cove', bots: { fill: 2 }, coop: true });
  const G = [fakeHuman(co2, 'g0'), fakeHuman(co2, 'g1'), fakeHuman(co2, 'g2')];
  startNow(co2, G[0].p);
  check(co2.players.filter((p) => p.bot && p.team === 'b').length === 3, 'co-op: at least as many bots as humans');
  for (const h of [...H, ...G]) { co.removePlayer(h.p); co2.removePlayer(h.p); }

  const nb = privateRoom({ mode: 'tdm', mapId: 'crate_cove', bots: { fill: 0 } });
  const N = [fakeHuman(nb, 'n0'), fakeHuman(nb, 'n1'), fakeHuman(nb, 'n2'), fakeHuman(nb, 'n3')];
  for (const h of N) nb.requestTeam(h.p, 'a');
  nb.requestStart(N[0].p);
  const k = nb.teamCounts();
  check(k.ha === 2 && k.hb === 2, `without bots, stacked lobby teams are evened out at start (${k.ha}/${k.hb})`);
  for (const h of N) nb.removePlayer(h.p);
}

function testCombat() {
  section('friendly fire, spawn protection');
  const room = privateRoom({ mode: 'tdm', mapId: 'prism_yard', bots: { fill: 0 }, timeLimitS: 600 });
  const A = fakeHuman(room, 'A'), B = fakeHuman(room, 'B'), C = fakeHuman(room, 'C');
  room.requestTeam(C.p, A.p.team);
  startNow(room, A.p);
  check(A.p.team === C.p.team && A.p.team !== B.p.team, 'A and C teammates, B enemy');
  check(room.isProtected(A.p) && room.isProtected(B.p), 'freshly spawned players are protected');
  // line up on open floor, protection still on
  place(A.p, -3, 0, -15); place(B.p, 3, 0, -15); place(C.p, 0, 0, -12);
  steps(room, 2);
  shoot(room, A.p, B.p);
  check(B.p.health === 100 && !room.isProtected(A.p) && room.isProtected(B.p), 'shot at a protected enemy: no damage; firing ended the shooter\'s protection');
  steps(room, 95);
  check(!room.isProtected(B.p) && !room.isProtected(C.p), 'protection ends after 1.5 s');
  place(A.p, -3, 0, -15); place(B.p, 3, 0, -15); place(C.p, 0, 0, -15);
  steps(room, 2);
  // C stands between A and B: the shot passes through the teammate and hits B
  shoot(room, A.p, B.p);
  check(C.p.health === 100 && B.p.health < 100, `friendly fire off: the teammate in the line of fire is untouched, the enemy behind is hit (B ${B.p.health})`);
  place(C.p, 0, 0, -12); steps(room, 2);
  shoot(room, A.p, C.p);
  check(C.p.health === 100, 'shooting a teammate directly does nothing');
  // snapshot entry carries team + protected bits
  const p = room.players[0];
  check(PLAYER_ENTRY_BYTES === 14 && typeof p.entry.team === 'string', 'snapshot entries carry team / protected / carrier (14 bytes)');
  for (const h of [A, B, C]) room.removePlayer(h.p);
}

function testCtf() {
  section('capture the flag rules');
  const room = privateRoom({ mode: 'ctf', mapId: 'crate_cove', bots: { fill: 0 }, timeLimitS: 600, scoreLimit: 2 });
  const A = fakeHuman(room, 'A'), B = fakeHuman(room, 'B');
  startNow(room, A.p);
  const ta = A.p.team, tb = B.p.team, map = room.map;
  const fA = map.flags[ta], fB = map.flags[tb];
  const F = room.flags;
  // A takes B's flag
  place(B.p, 0, 0, 17);
  place(A.p, fB[0], fB[1], fB[2]); steps(room, 1);
  check(F[tb].state === 'carried' && F[tb].carrier === A.p.id && A.p.carrying === tb && A.evs('flag_taken').length === 1, 'touching the enemy flag picks it up (flag_taken)');
  // A dies -> drop
  place(A.p, 2, 0, 7); steps(room, 1);   // open floor on crate_cove
  room.kill(A.p, B.p, 0, false);
  check(F[tb].state === 'dropped' && Math.abs(F[tb].x - 2) < 0.01 && Math.abs(F[tb].y - 0) < 0.05 && A.p.carrying === '', 'carrier killed -> flag dropped where he died, on the ground');
  const rt = F[tb].returnTick;
  check(rt === room.tick + 20 * 60 || rt === room.tick + 20 * 60 - 0, `20 s return timer (${(rt - room.tick) / 60} s)`);
  steps(room, 20 * 60 - 5);
  check(F[tb].state === 'dropped', 'still dropped just before 20 s');
  steps(room, 10);
  check(F[tb].state === 'home' && A.evs('flag_returned').some((e) => e.player === 0), 'dropped flag returns home after 20 s (flag_returned, player 0)');
  // drop again, defender touches -> return
  steps(room, 200);         // A respawned
  place(B.p, 0, 0, 17);
  place(A.p, fB[0], fB[1], fB[2]); steps(room, 1);
  place(A.p, 0, 0, 3); steps(room, 1);
  room.kill(A.p, B.p, 0, false);
  place(B.p, 0, 0, 3); steps(room, 1);
  check(F[tb].state === 'home' && A.evs('flag_returned').some((e) => e.player === B.p.id), 'a defender touching the dropped flag returns it');
  // capture: only while own flag is home
  steps(room, 200);
  place(B.p, fA[0], fA[1], fA[2]); steps(room, 1);                // B takes A's flag
  place(B.p, 0, 0, 17); steps(room, 1);
  place(A.p, fB[0], fB[1], fB[2]); steps(room, 1);                // A takes B's flag
  place(A.p, fA[0], fA[1], fA[2]); steps(room, 3);                // A at own stand, own flag away
  check(room.scores[ta] === 0 && F[tb].state === 'carried', 'no capture while your own flag is not home');
  room.kill(B.p, A.p, 0, false);                                  // B drops A's flag
  place(A.p, F[ta].x, F[ta].y, F[ta].z); steps(room, 1);           // A returns his own flag (still carrying)
  check(F[ta].state === 'home', 'carrier can return his own dropped flag');
  place(A.p, fA[0], fA[1], fA[2]); steps(room, 1);
  check(room.scores[ta] === 1 && F[tb].state === 'home' && A.p.obj === 1 && A.evs('flag_captured').length === 1, 'carrier at own stand with own flag home -> capture (+1, flag home, flag_captured)');
  // void drop returns home
  steps(room, 10);
  place(A.p, fB[0], fB[1], fB[2]); steps(room, 1);
  A.p.state.y = map.killY - 1; room.kill(A.p, null, 0, false);
  check(F[tb].state === 'home', 'a flag carried into the void returns home');
  // second capture reaches the score limit -> results
  steps(room, 200);
  place(A.p, fB[0], fB[1], fB[2]); steps(room, 1);
  place(A.p, fA[0], fA[1], fA[2]); steps(room, 2);
  check(room.phase === 'results' && room.result.winner === ta && room.result.reason === 'score', 'score limit (2 captures) ends the match, carrier team wins');
  const caps = A.evs('flag_captured').length;
  check(caps === 2 && room.result.scores[ta] === caps, 'score equals the number of capture events');
  room.removePlayer(A.p); room.removePlayer(B.p);
}

function testHardpoint() {
  section('hardpoint rules');
  const room = privateRoom({ mode: 'hardpoint', mapId: 'crate_cove', bots: { fill: 0 }, timeLimitS: 600, scoreLimit: 500 });
  const A = fakeHuman(room, 'A'), B = fakeHuman(room, 'B');
  startNow(room, A.p);
  const ta = A.p.team, tb = B.p.team;
  const z0 = room.map.hardpoints[0];
  const cx = (z0.min[0] + z0.max[0]) / 2, cz = (z0.min[2] + z0.max[2]) / 2;
  place(B.p, 15, 0, 15);
  place(A.p, cx, z0.min[1], cz);
  steps(room, 61);
  check(room.hp.owner === ta && room.scores[ta] === 1 && A.evs('zone_taken').length >= 1, 'one team inside -> controls the zone, +1 per second');
  steps(room, 120);
  check(room.scores[ta] === 3 && A.p.obj === 3, `holding 3 s -> 3 points (player objective score ${A.p.obj})`);
  place(B.p, cx + 1, z0.min[1], cz); steps(room, 2);
  const before = { ...room.scores };
  steps(room, 180);
  check(room.hp.owner === 'contested' && room.scores[ta] === before[ta] && room.scores[tb] === before[tb] && A.evs('zone_contested').length >= 1, 'both teams inside = contested = nobody scores');
  place(A.p, 15, 0, -15); steps(room, 61);
  check(room.hp.owner === tb && room.scores[tb] === 1, 'the other team alone takes it over');
  place(B.p, 15, 0, 15); steps(room, 2);
  check(room.hp.owner === '' && A.evs('zone_neutral').length >= 1, 'empty zone -> neutral');
  const rot = room.hp.rotateTick;
  steps(room, rot - room.tick + 1);
  const ev = A.evs('zone_rotated');
  check(room.hp.index === 1 && ev.length === 1 && ev[0].index === 1 && ev[0].name === room.map.hardpoints[1].name, `zone rotates after 60 s (-> ${room.hp.index} ${room.map.hardpoints[1].name})`);
  const o = A.last('obj');
  check(o && o.hp && o.hp.index === 1 && o.hp.rotateTick === room.hp.rotateTick && o.hp.next === 2 % room.map.hardpoints.length, 'obj message carries active zone, next zone, rotation tick');
  // zone 0 no longer scores
  place(A.p, cx, z0.min[1], cz); steps(room, 120);
  check(room.hp.owner === '' || room.hp.owner === tb, 'the old zone does not count any more');
  room.removePlayer(A.p); room.removePlayer(B.p);
}

function testLimitsAndPublic() {
  section('limits, ties, public rotation');
  const room = privateRoom({ mode: 'tdm', mapId: 'crate_cove', bots: { fill: 0 }, timeLimitS: 600, scoreLimit: 2 });
  const A = fakeHuman(room, 'A'), B = fakeHuman(room, 'B');
  startNow(room, A.p);
  room.kill(B.p, A.p, 0, false); steps(room, 1);
  room.kill(A.p, A.p, 0, false); steps(room, 1);     // suicide: no score
  check(room.scores[A.p.team] === 1 && room.scores[B.p.team] === 0 && A.p.kills === 1 && A.p.deaths === 1, 'tdm: enemy kill = +1 team point, suicide = 0');
  steps(room, 200);
  room.kill(B.p, A.p, 0, false); steps(room, 1);
  check(room.phase === 'results' && room.result.winner === A.p.team && room.result.reason === 'score', 'tdm score limit ends the match');
  room.removePlayer(A.p); room.removePlayer(B.p);

  const t = privateRoom({ mode: 'tdm', mapId: 'crate_cove', bots: { fill: 0 }, timeLimitS: 10 });
  const X = fakeHuman(t, 'X'), Y = fakeHuman(t, 'Y');
  startNow(t, X.p);
  steps(t, 10 * 60 + 2);
  check(t.phase === 'results' && t.result.draw && t.result.winner === null && t.result.reason === 'time', 'time limit with equal scores -> draw');
  t.removePlayer(X.p); t.removePlayer(Y.p);

  const f = privateRoom({ mode: 'ffa', mapId: 'crate_cove', bots: { fill: 0 }, scoreLimit: 2 });
  const P = fakeHuman(f, 'P'), Q = fakeHuman(f, 'Q');
  startNow(f, P.p);
  check(P.p.team === '' && Q.p.team === '', 'ffa: no teams');
  f.kill(Q.p, P.p, 0, false); steps(f, 200); f.kill(Q.p, P.p, 0, false); steps(f, 1);
  check(f.phase === 'results' && f.result.winner === P.p.id && f.result.winnerName === 'P', 'ffa: first to the kill limit wins');
  f.removePlayer(P.p); f.removePlayer(Q.p);

  const pub = new Room('pub', { isPrivate: false, botMin: 4 });
  const U = fakeHuman(pub, 'U');
  check(pub.phase === 'playing' && U.p.alive && pub.botCount === 3, 'public room: no lobby, plays at once, bots fill to 4');
  const seen = [[pub.config.mode, pub.map.id]];
  for (let k = 0; k < 4; k++) {
    pub.endMatch('time'); steps(pub, 62);
    check(pub.phase === 'countdown', `public: results -> countdown (${pub.config.mode} on ${pub.map.id})`);
    seen.push([pub.config.mode, pub.map.id]);
    steps(pub, 22);
  }
  const modes = new Set(seen.map((s) => s[0])), maps = new Set(seen.map((s) => s[1]));
  check(modes.size === 4 && seen.every((s, i) => i === 0 || s[1] !== seen[i - 1][1] || maps.size === 1), `public rotation: every mode, map changes each match (${seen.map((s) => s.join('@')).join(', ')})`);
  check(seen.every(([, id]) => { const m = MAPS.find((x) => x.id === id); return m.size !== 'large'; }), 'public rotation picks maps suited to 4 participants (no large maps)');
  check(pub.requestConfig(U.p, { mode: 'ffa' }) === 'not_host' && pub.requestStart(U.p) === 'not_host', 'public rooms have no host');
  pub.removePlayer(U.p);
}

/** Bots-only (plus one idle human kept out of play) complete matches; returns per-map stats. */
function botMatch(mode, mapId, secs, fill, opts = {}) {
  const room = privateRoom({ mode, mapId, bots: { fill }, timeLimitS: secs, scoreLimit: opts.scoreLimit ?? MODES[mode].scoreLimitMax });
  room.spawnPolicy = opts.policy || 'smart';
  if (opts.measure) room.spawnStats = { enabled: true, spawns: 0, visible: 0, check: (r, p, pos) => spawnVisible(r, p, pos) };
  const H = fakeHuman(room, 'idle');
  room.requestStart(H.p);
  let maxTick = 0, sum = 0, n = 0;
  const kills = { a: 0, b: 0 };
  const origKill = room.kill.bind(room);
  room.kill = (v, k, ...rest) => { if (room.phase === 'playing' && k && k !== v && k.team && k.team !== v.team) kills[k.team]++; return origKill(v, k, ...rest); };
  let closest = Infinity;     // ctf: closest any bot got to the enemy flag stand
  for (let t = 0; t < (secs + 2) * 60 && room.phase !== 'results'; t++) {
    if (H.p.alive) room.despawn(H.p);                   // the idle human stays out of play
    const t0 = performance.now(); room.step(); const dt = performance.now() - t0;
    if (room.phase === 'playing') { if (dt > maxTick) maxTick = dt; sum += dt; n++; }
    if (mode === 'ctf' && room.phase === 'playing' && t % 10 === 0) {
      for (const p of room.players) {
        if (!p.bot || !p.alive) continue;
        const f = room.map.flags[p.team === 'a' ? 'b' : 'a'];
        closest = Math.min(closest, Math.hypot(p.state.x - f[0], p.state.z - f[2]));
      }
    }
  }
  const res = room.result;
  const out = { room, res, H, kills, closest, avgMs: sum / Math.max(1, n), maxMs: maxTick, spawns: room.spawnStats };
  room.removePlayer(H.p);
  return out;
}

function testBots() {
  section('bots play complete shortened matches of every mode on every map');
  const secs = QUICK ? 90 : 150;
  const rows = [];
  let ctfTakes = 0;
  for (const map of MAPS) {
    const line = [map.id.padEnd(12)];
    for (const mode of MODE_IDS) {
      const r = botMatch(mode, map.id, secs, 10);
      const res = r.res;
      const ok = res && res.reason === 'time';
      let detail = '';
      if (mode === 'ffa') {
        const best = Math.max(...res.rows.map((x) => x.kills));
        check(ok && res.rows.length >= 10 && (res.draw || res.rows.find((x) => x.id === res.winner).kills === best), `${map.id} ffa: match ran to the time limit, winner has the most kills (${best})`);
        detail = `top ${best}k`;
      } else if (mode === 'tdm') {
        const sums = { a: 0, b: 0 };
        for (const x of res.rows) if (x.team) sums[x.team] += x.kills;
        check(ok && res.scores.a === r.kills.a && res.scores.b === r.kills.b && res.scores.a === sums.a && res.scores.b === sums.b && res.scores.a + res.scores.b > 5,
          `${map.id} tdm: team scores = enemy kills = sum of members' kills (${res.scores.a}:${res.scores.b})`);
        detail = `${res.scores.a}:${res.scores.b}`;
      } else if (mode === 'ctf') {
        const caps = { a: 0, b: 0 };
        for (const x of res.rows) if (x.team) caps[x.team] += x.obj;
        const taken = r.H.evs('flag_taken').length, total = res.scores.a + res.scores.b;
        check(ok && caps.a === res.scores.a && caps.b === res.scores.b && r.H.evs('flag_captured').length === total, `${map.id} ctf: captures add up (${res.scores.a}:${res.scores.b}, ${taken} flag takes)`);
        check(taken >= 1 || r.closest < 8, `${map.id} ctf: attackers fight their way to the enemy flag (${taken} takes, ${r.H.evs('flag_returned').length} returns, closest ${r.closest.toFixed(1)} m)`);
        ctfTakes += taken;
        detail = `${res.scores.a}:${res.scores.b} caps, ${taken} takes`;
      } else {
        const zone = r.H.evs('zone_taken').length, total = res.scores.a + res.scores.b;
        const objs = res.rows.reduce((s, x) => s + x.obj, 0);
        check(ok && total > secs * 0.25 && objs >= total, `${map.id} hardpoint: bots take and hold the zone (${res.scores.a}:${res.scores.b} pts, ${zone} takes, ${r.H.evs('zone_rotated').length} rotations)`);
        detail = `${res.scores.a}:${res.scores.b} pts`;
      }
      line.push(`${mode} ${detail} (${r.avgMs.toFixed(3)} ms avg)`);
    }
    rows.push(line.join(' | '));
  }
  console.log('\n  ' + rows.join('\n  '));
  check(ctfTakes >= 8, `ctf over all five maps: bots took the enemy flag ${ctfTakes} times`);
  // a lone bot completes a full flag run on every map (pathing reaches the objectives)
  for (const map of MAPS) {
    const room = privateRoom({ mode: 'ctf', mapId: map.id, bots: { fill: 2 }, coop: true, timeLimitS: 90, scoreLimit: 3 });
    const H = fakeHuman(room, 'idle');
    room.requestStart(H.p);
    for (let t = 0; t < 92 * 60 && room.phase !== 'results'; t++) { if (H.p.alive) room.despawn(H.p); room.step(); }
    const caps = H.evs('flag_captured').length;
    check(caps >= 2, `${map.id}: a bot alone runs flag -> home -> capture (${caps} captures in ${(room.tick / 60).toFixed(0)} s)`);
    room.removePlayer(H.p);
  }
}

function testSpawns() {
  section('spawn visibility: legacy (phase 1) vs smart spawns, busy matches on every map');
  const secs = QUICK ? 60 : 120;
  const tab = [];
  let totL = [0, 0], totS = [0, 0], unav = 0, spMs = 0, spMax = 0;
  for (const map of MAPS) {
    for (const mode of ['ffa', 'tdm']) {
      const L = botMatch(mode, map.id, secs, 14, { policy: 'legacy', measure: true });
      const S = botMatch(mode, map.id, secs, 14, { policy: 'smart', measure: true });
      totL[0] += L.spawns.visible; totL[1] += L.spawns.spawns; totS[0] += S.spawns.visible; totS[1] += S.spawns.spawns;
      unav += S.spawns.unavoidable || 0;
      spMs += S.spawns.ms || 0; spMax = Math.max(spMax, S.spawns.maxMs || 0);
      tab.push(`${map.id.padEnd(12)} ${mode.padEnd(4)} legacy ${(100 * L.spawns.visible / L.spawns.spawns).toFixed(1).padStart(5)}% of ${String(L.spawns.spawns).padStart(3)}   smart ${(100 * S.spawns.visible / S.spawns.spawns).toFixed(1).padStart(5)}% of ${String(S.spawns.spawns).padStart(3)}  (unavoidable ${S.spawns.unavoidable || 0}, pick ${(1000 * (S.spawns.ms || 0) / S.spawns.spawns).toFixed(0)} us avg)`);
    }
  }
  console.log('  spawned in an enemy\'s line of sight (eye -> chest or head), 14 bots + 1, ' + secs + ' s each:\n  ' + tab.join('\n  '));
  const pl = 100 * totL[0] / totL[1], ps = 100 * totS[0] / totS[1];
  console.log(`  TOTAL legacy ${pl.toFixed(1)}% (${totL[0]}/${totL[1]})  ->  smart ${ps.toFixed(1)}% (${totS[0]}/${totS[1]}, all ${unav} of them with every candidate seen)`);
  check(ps < pl / 4 && totS[1] > 500, `smart spawns are seen far less often (${pl.toFixed(1)}% -> ${ps.toFixed(1)}%)`);
  check(totS[0] === unav, `a seen spawn happens only when every candidate is seen (${totS[0]} seen, ${unav} unavoidable)`);
  console.log(`  smart spawn selection cost: ${(1000 * spMs / totS[1]).toFixed(0)} us average, ${(1000 * spMax).toFixed(0)} us worst`);
  globalThis.SPAWN_NUMBERS = { legacy: pl, smart: ps, legacyN: totL, smartN: totS };
}

function testCost() {
  section('per-tick cost with bots (in-process, 20 players)');
  for (const mode of ['ffa', 'hardpoint', 'ctf']) {
    const r = botMatch(mode, 'prism_yard', QUICK ? 30 : 60, 20);
    console.log(`  ${mode.padEnd(9)} prism_yard 20 players (19 bots): avg ${r.avgMs.toFixed(3)} ms, max ${r.maxMs.toFixed(2)} ms per tick`);
    check(r.avgMs < 1.5, `${mode}: average tick with 19 bots well under budget (${r.avgMs.toFixed(3)} ms)`);
  }
}

// ------------------------------------------------------------------ part 2: end to end
let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), BOTS: '4', COUNTDOWN_MS: '600', RESULTS_MS: '1500', PUBLIC_COUNTDOWN_MS: '300' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error('server exited');
    try { const r = await fetch(`http://localhost:${PORT}/status`); if (r.ok) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}
function killServer() { if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); }
process.on('exit', killServer);
process.on('SIGINT', () => { killServer(); process.exit(130); });

async function e2e() {
  const { createNet } = await import('../client/net.js');
  const { createAutopilot } = await import('../client/input.js');
  const { TICK_MS } = await import('../shared/protocol.js');
  await startServer();
  section(`end to end: headless net.js clients against a server on :${PORT}`);

  class C {
    constructor(name, room) {
      this.name = name; this.room = room;
      this.net = createNet({ url: `ws://localhost:${PORT}/ws` });
      this.ap = createAutopilot({ seed: name.length * 97 + 13 });
      this.players = [];
      this.ev = []; this.maps = []; this.phases = []; this.results = []; this.spawns = 0; this.view = {};
      this.protSeen = 0; this.teamSeen = new Set(); this.flagSeen = false; this.hpSeen = false;
      const n = this.net;
      n.on('ev', (m) => this.ev.push(m));
      n.on('map', (m) => this.maps.push(m.mapId));
      n.on('phase', (p) => this.phases.push(p));
      n.on('result', (r) => this.results.push(r));
      n.on('spawn', (m) => { if (m.id === n.state.id) { this.spawns++; this.ap.setYaw(m.yaw || 0); } });
    }
    async connect() {
      this.net.connect(this.name, this.room);
      for (let i = 0; i < 100 && !this.net.state.connected; i++) await sleep(50);
      if (!this.net.state.connected) throw new Error(`${this.name} failed to connect`);
    }
    tick() {
      const n = this.net;
      if (!n.state.connected) return;
      const rt = n.renderTick();
      n.sampleRemotes(rt, this.players);
      const p = n.pred, w = n.predWeapon;
      const o = this.ap.update({ world: n.world, self: p, alive: n.state.alive, remotes: this.players.filter((r) => !r.team || r.team !== n.state.team),
        weapon: w.weapon, ammo: w.ammo[w.weapon], magSize: n.kit.slots[w.weapon].magSize });
      n.tick(o, rt);
      n.decayError(TICK_MS / 1000);
      const v = n.localView(1, this.view);
      if (v.protected) this.protSeen++;
      for (const r of this.players) if (r.team) this.teamSeen.add(r.team);
      if (n.state.match.flags) this.flagSeen = true;
      if (n.state.match.hardpoint) this.hpSeen = true;
    }
  }
  const all = [];
  let loop = null;
  const startLoop = () => {
    let acc = 0, last = performance.now();
    loop = setInterval(() => {
      const t = performance.now(); acc += Math.min(250, t - last); last = t;
      let k = 0;
      while (acc >= TICK_MS && k < 6) { for (const c of all) c.tick(); acc -= TICK_MS; k++; }
    }, 2);
  };
  startLoop();
  const waitFor = async (fn, ms) => { const end = performance.now() + ms; while (performance.now() < end) { if (fn()) return true; await sleep(40); } return fn(); };

  // ---- 1. complete cycles of every mode on two maps (8 private rooms in parallel)
  const plan = [];
  const pairs = { ffa: ['crate_cove', 'maple_street'], tdm: ['hollow_pines', 'prism_yard'], ctf: ['crate_cove', 'skyline'], hardpoint: ['maple_street', 'hollow_pines'] };
  for (const mode of MODE_IDS) for (const mapId of pairs[mode]) plan.push({ mode, mapId });
  const MATCH_S = QUICK ? 16 : 24;
  const rooms = plan.map((pl, i) => {
    const room = `m${i}${process.pid}`;
    const host = new C(`host${i}`, room), guest = new C(`guest${i}`, room);
    all.push(host, guest);
    return { ...pl, room, host, guest };
  });
  for (const r of rooms) { await r.host.connect(); await r.guest.connect(); }
  check(rooms.every((r) => r.host.net.state.match.phase === 'lobby' && r.host.net.state.match.isHost && !r.guest.net.state.match.isHost && r.guest.net.state.match.hostId === r.host.net.state.id),
    'private rooms: lobby, first client is host (isHost / hostId)');
  check(rooms.every((r) => r.host.net.state.match.lobby.length === 2 && r.host.net.state.match.lobby.some((e) => e.host && e.id === r.host.net.state.id)), 'net.state.match.lobby lists both players with the host flag');
  for (const r of rooms) r.host.net.setMatchConfig({ mode: r.mode, mapId: r.mapId, bots: { fill: 6 }, timeLimitS: MATCH_S, scoreLimit: MODES[r.mode].scoreLimitMax });
  await waitFor(() => rooms.every((r) => r.guest.net.state.match.mapId === r.mapId && r.guest.net.state.match.mode === r.mode), 3000);
  check(rooms.every((r) => r.guest.net.state.match.mapId === r.mapId && r.guest.net.world && r.guest.maps.includes(r.mapId) || r.mapId === 'prism_yard'),
    'config reaches every client; net.js switched its prediction world (map event) to the chosen map');
  for (const r of rooms) r.host.net.startMatch();
  await waitFor(() => rooms.every((r) => r.host.net.state.match.phase === 'playing' && r.guest.net.state.match.phase === 'playing'), 4000);
  check(rooms.every((r) => r.host.phases.includes('countdown') && r.host.net.state.match.phase === 'playing'), 'lobby -> countdown -> playing on every client');
  for (const c of all) { c.net.stats.corrections = 0; c.net.stats.compared = 0; }
  await waitFor(() => rooms.every((r) => r.host.net.state.match.phase === 'results'), (MATCH_S + 6) * 1000);
  const inMatchCorr = all.reduce((s, c) => s + c.net.stats.corrections, 0), compared = all.reduce((s, c) => s + c.net.stats.compared, 0);
  for (const r of rooms) {
    const res = r.host.results[r.host.results.length - 1];
    const ok = res && res.mode === r.mode && res.mapId === r.mapId && res.reason === 'time';
    let rule = true;
    if (r.mode === 'ctf') rule = r.host.ev.filter((e) => e.e === 'flag_captured').length === res.scores.a + res.scores.b;
    if (r.mode === 'tdm') { const s = { a: 0, b: 0 }; for (const x of res.rows) if (x.team) s[x.team] += x.kills; rule = s.a === res.scores.a && s.b === res.scores.b; }
    if (r.mode === 'hardpoint') rule = res.scores.a + res.scores.b > 0 && r.host.hpSeen;
    if (r.mode === 'ffa') rule = res.draw || res.rows.find((x) => x.id === res.winner).kills === Math.max(...res.rows.map((x) => x.kills));
    check(ok && rule, `${r.mode} on ${r.mapId}: full match to the time limit, result consistent (${JSON.stringify(res && res.scores)} winner ${res && res.winner})`);
  }
  check(compared > 2000 && inMatchCorr === 0, `prediction bit-exact through countdown, map switch, spawns and respawns: ${inMatchCorr} corrections in ${compared} compared states`);
  const teamRooms = rooms.filter((r) => r.mode !== 'ffa');
  check(teamRooms.every((r) => r.host.net.state.match.myTeam === '' ? false : r.host.teamSeen.size === 2) && rooms.filter((r) => r.mode === 'ffa').every((r) => r.host.teamSeen.size === 0),
    'remote players carry team (both teams seen in team modes, none in ffa)');
  check(all.every((c) => c.protSeen > 0), 'local view reports spawn protection after spawning');
  check(rooms.filter((r) => r.mode === 'ctf').every((r) => r.host.flagSeen) && rooms.filter((r) => r.mode === 'hardpoint').every((r) => r.host.hpSeen), 'net.state.match.flags / hardpoint populated in ctf / hardpoint');
  await waitFor(() => rooms.every((r) => r.host.net.state.match.phase === 'lobby'), 4000);
  check(rooms.every((r) => r.host.net.state.match.phase === 'lobby' && r.host.phases.includes('results') && r.host.net.state.match.config.mode === r.mode),
    'results -> lobby with the same config');

  // ---- 2. second match on another map in the same room + late join + host migration
  const R = rooms.find((r) => r.mode === 'ctf');
  R.host.net.setMatchConfig({ mapId: 'hollow_pines', timeLimitS: 60, bots: { fill: 4 } });
  await waitFor(() => R.guest.net.state.match.mapId === 'hollow_pines', 2000);
  check(R.guest.maps[R.guest.maps.length - 1] === 'hollow_pines' && R.guest.net.map.id === 'hollow_pines', 'map change in the lobby: net emits map with the new map object');
  R.host.net.startMatch();
  await waitFor(() => R.guest.net.state.match.phase === 'playing', 3000);
  const late = new C('late', R.room);
  all.push(late);
  await late.connect();
  await sleep(1000);
  const lm = late.net.state.match;
  const counts = { a: 0, b: 0 };
  for (const e of lm.lobby) if (!e.bot && e.team) counts[e.team]++;
  check(lm.phase === 'playing' && lm.mode === 'ctf' && lm.mapId === 'hollow_pines' && lm.flags && lm.flags.a && typeof lm.flags.a.returnInS === 'number' && lm.timeLeftS > 30,
    'late joiner: full match state within a second (phase, mode, map, flags, timers)');
  check(late.net.state.alive && lm.myTeam !== '' && Math.abs(counts.a - counts.b) <= 1, `late joiner spawned on a team, humans balanced (${counts.a}/${counts.b})`);
  const before = all.reduce((s, c) => s + c.net.stats.corrections, 0);
  R.host.net.close();
  await waitFor(() => R.guest.net.state.match.isHost, 3000);
  check(R.guest.net.state.match.isHost && !late.net.state.match.isHost && late.net.state.match.hostId === R.guest.net.state.id, 'host left -> next player is host on every client');
  R.guest.net.returnToLobby();
  await waitFor(() => late.net.state.match.phase === 'lobby', 2000);
  check(late.net.state.match.phase === 'lobby' && late.net.state.match.result === null, 'new host returned everyone to the lobby');
  R.guest.net.switchTeam(late.net.state.match.myTeam === 'a' ? 'b' : 'a');
  await sleep(400);
  const lo = late.net.state.match.lobby.find((e) => e.id === R.guest.net.state.id);
  check(lo && lo.team === R.guest.net.state.match.myTeam && lo.host, 'team switch in the lobby reaches the lobby roster');
  late.net.startMatch();
  await sleep(400);
  check(late.net.state.match.phase === 'lobby' && late.net.state.lastError && /not host/.test(late.net.state.lastError), 'non-host start rejected (error not_host)');
  const after = all.reduce((s, c) => s + c.net.stats.corrections, 0);
  check(after === before, `still no corrections after late join / host change (${after - before})`);

  // ---- 3. public room: no lobby
  const pub = new C('pub', '');
  all.push(pub);
  await pub.connect();
  await sleep(800);
  check(pub.net.state.match.phase === 'playing' && !pub.net.state.match.private && !pub.net.state.match.isHost && pub.net.state.alive, 'public room: straight into a match, no host');

  clearInterval(loop);
  for (const c of all) c.net.close();
  await sleep(500);
  const st = await (await fetch(`http://localhost:${PORT}/status`)).json();
  check(st.rooms.length === 0, 'all rooms closed after everyone left');
  killServer();
  await sleep(300);
}

// ------------------------------------------------------------------ main
const t0 = performance.now();
testConfig();
testLobby();
testTeams();
testCombat();
testCtf();
testHardpoint();
testLimitsAndPublic();
testBots();
testSpawns();
testCost();
if (!args.includes('--skip-e2e')) {
  try { await e2e(); } catch (err) { console.error(err); failures.push(`e2e crashed: ${err.message}`); killServer(); }
}
console.log(`\n${failures.length ? `RESULT: ${failures.length} FAILED\n  - ${failures.join('\n  - ')}` : 'RESULT: all mode checks passed'} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(failures.length ? 1 : 0);
