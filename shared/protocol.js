// Hopshot network protocol. Pure ESM, shared by the Node server and the browser client.
// Owned by the server agent. EVERY encode and decode for BOTH directions lives here.
//
// ============================================================================================
// TRANSPORT
//   One WebSocket per client at  ws(s)://<host>/ws . Binary frames carry the hot path (input
//   and snapshots); text frames carry rare events as JSON. All binary numbers are LITTLE-ENDIAN.
//   The first byte of every binary frame is the message type (MSG.*).
//   Client: set `ws.binaryType = 'arraybuffer'`.
//
// TIME BASE
//   "Server time" is measured in ROOM TICKS (1 tick = 1/60 s). Snapshots carry the integer
//   tick at which they were taken; pong carries the server's current fractional tick. Remote
//   players are rendered at   renderTick = estimatedServerTick - INTERP_DELAY_MS * 60 / 1000
//   and that renderTick is sent back in every input packet so the server can rewind other
//   players for lag compensation (see "Clock sync" below).
//
// ---------------------------------------------------------------- client -> server (binary)
// INPUT  (MSG.INPUT = 1), sent once per client tick (60 Hz), size = 14 + 11 * count bytes
//   u8   type = 1
//   f64  renderTick     server tick (fractional) the client was rendering remote players at
//                       when it produced the NEWEST cmd in this packet
//   u32  newestSeq      seq of the last cmd in the list
//   u8   count          1..INPUT_MAX_CMDS; cmds are consecutive, OLDEST FIRST, so cmd i has
//                       seq = newestSeq - (count - 1 - i). Redundancy: the client resends its
//                       last INPUT_REDUNDANCY cmds every packet, the server ignores seqs it has.
//   count x {
//     u16 buttons      BTN bitmask (masked with BTN_MASK)
//     f32 yaw          radians
//     f32 pitch        radians (clamped to +-PITCH_LIMIT)
//     u8  weapon       desired weapon id
//   }
//   For an older cmd i the server uses renderTick - (count - 1 - i) as its render time.
//
// ---------------------------------------------------------------- server -> client (binary)
// SNAPSHOT  (MSG.SNAPSHOT = 2), 30 Hz, one per client
//   u8   type = 2
//   u32  tick            server tick the snapshot was taken at (after that tick's simulation)
//   u32  ackSeq          last cmd seq of YOURS the server has processed (0 = none yet)
//   u8   youId
//   u8   youFlags        bit0 alive, bit1 hasAck (ackSeq is valid), (v4) bit2 spawn-protected,
//                        bits3-4 team (0 none / ffa, 1 'a', 2 'b'), bit5 carrying the enemy flag
//   u8   health         0..100 (rounded)
//   u16  respawnTicks    ticks until respawn while dead, else 0
//   u8   inputBuffer     (v2) server-side input jitter buffer depth for you, smoothed, 1/8 ticks
//   u8   inputTarget     (v2) the depth the server is steering you to, 1/8 ticks
//   i8   timeScale       (v2) server-driven time dilation for your simulation, in 1/1000:
//                        run your fixed-step clock at (1 + timeScale/1000) x real time.
//                        Always within +-MAX_DILATION_PERMILLE; it only moves queue depth,
//                        the server never processes more than one cmd per tick on average.
//   u8   starved         (v2) wrapping counter of server ticks that had no cmd of yours
//   STATE_BYTES          your full physics state (physics.writeState). This is ALWAYS the
//                        state right after cmd ackSeq (never includes guessed ticks).
//   WSTATE_BYTES         your full weapon state (weapons.writeWeaponState; v3: 10 bytes with
//                        u16 reload, aim and heat)
//   u8   playerCount     OTHER players (you are not in this list), then playerCount x 14 bytes:
//     u8  id
//     i16 x, i16 y, i16 z    feet position * POS_SCALE (1/128 m)
//     u16 yaw                (yaw mod 2pi) * 65536 / 2pi
//     i16 pitch              pitch * 32767 / (pi/2)
//     u8  flags              bit0 alive, bit1 crouching, bit2 sliding, bit3 onGround,
//                            bit4 ads, bit5 reloading, bits6-7 weapon SLOT (0..2)
//     u8  health | gunB << 7  (v3) bits0-6 health 0..100, bit7 = the slot holds gun B, so
//                            gun id = slot * 2 + bit7 (weapons.GUNS)
//     u8  extra              (v4) bits0-1 team (0 none, 1 'a', 2 'b'), bit2 spawn-protected,
//                            bit3 carrying the enemy flag
//   u8   shotCount       tracers fired since the previous snapshot (ALL shooters, including you),
//                        then shotCount x 9 bytes - one entry per pellet:
//     u8  shooter id
//     u8  flags              bits0-1 kind (SHOT.MISS / WORLD / BODY / HEAD),
//                            bits2-4 impact normal axis (0 +x,1 -x,2 +y,3 -y,4 +z,5 -z,7 none),
//                            bits5-6 weapon SLOT, bit7 (v3) gun B -> gun id = slot * 2 + bit7
//     u8  victim id (0 = none)
//     i16 x, i16 y, i16 z    impact / end point * POS_SCALE
//   The tracer starts at the shooter's (interpolated) eye; for your own shots draw your
//   predicted tracer instead and ignore entries whose shooter === youId.
//
// ---------------------------------------------------------------- text frames (JSON)
// Every text frame is one JSON object with a string field `t`. Max 2048 bytes client->server.
// LOADOUTS (v3): a loadout travels as its integer code `lo` (weapons.encodeLoadout: one byte
//   per slot, variant | attachmentMask << 1). The server sanitises every code it receives.
//   A player's loadout is chosen on join and may be changed at any time; a change is PENDING
//   and becomes ACTIVE at that player's next spawn (never mid-life). Everyone learns a player's
//   active loadout from the roster entry (`lo`) and from every 'spawn' event (`lo`); the gun in
//   hand is also in every snapshot entry (slot + gun B bit), so models/sounds never lag.
//
// client -> server:
//   { t:'join', v:PROTOCOL_VERSION, name:'Bob', room?:'abc', bots?:n, lo?:<loadout code> }
//                                                                 first message after connect
//   { t:'loadout', lo:<loadout code> }    (v3) set the pending loadout (applies at next spawn)
//   { t:'ping', c:<client ms>, rtt?:<last measured rtt ms> }      ~ every 1 s
// server -> client:
//   { t:'welcome', v, id, room, tick, tickRate, snapshotEvery, map, lo /* your pending code */,
//     players:[{ id, name, bot, kills, deaths, ping, lo }], round:{ phase, endsTick } }
//   { t:'pong', c, tick }                 c echoed; tick = server tick (fractional) when sent
//   { t:'join', player:{ id, name, bot, kills, deaths, ping, lo } }
//   { t:'leave', id }
//   { t:'loadout', lo }                   (v3) reply to a client 'loadout': the sanitised code now
//                                         pending for you (it becomes active at your next spawn)
//   { t:'kill', killer /* id or 0 for world/suicide */, victim, weapon /* slot */,
//     gun /* gun id, v3 */, headshot, respawnTicks }
//   { t:'hit', victim, damage, headshot, kill }               only to the shooter
//   { t:'damage', attacker, from:[x,y,z], damage, health }    only to the victim
//   { t:'spawn', id, x, y, z, yaw, lo }   broadcast on (re)spawn; lo = (v3) the loadout code that
//                                         is ACTIVE for this life (for the local player: predict
//                                         with getKit(lo) from now on)
//   { t:'round', phase:'playing'|'intermission', endsTick,
//     winner? /* id */, rows? }                               rows = scoreboard (as 'scores')
//   { t:'scores', rows:[{ id, kills, deaths, ping }] }       ~ every 1 s
//   { t:'error', code, message }                              e.g. room_full, bad_version
//
// MODES, TEAMS, LOBBY, MAPS (v4; rules and config in shared/modes.js)
//   Teams are 'a' / 'b' ('' = none, free-for-all). Every room plays one map (config.mapId,
//   shared/maps getMap); clients build their prediction world from that id.
//   Phases: 'lobby' -> 'countdown' -> 'playing' -> 'results' -> 'lobby' (private rooms) or
//   'playing' -> 'results' -> 'countdown' (next map/mode) -> 'playing' (public rooms, no lobby).
//   Nobody is alive in lobby / countdown / results; everyone (re)spawns when 'playing' starts.
//   endsTick: countdown = tick play starts; playing = time-limit tick; results = tick the
//   results end; lobby = 0.
// client -> server:
//   { t:'config', cfg:<MatchConfig, may be partial> }   host only, lobby only (re-sanitised)
//   { t:'start' }                                         host only, lobby only -> countdown
//   { t:'team', team:'a'|'b' }                            lobby only, team modes, not co-op
//   { t:'lobby' }                                         host only, private rooms: abort the
//                                                         countdown / match / results -> lobby
// server -> client:
//   welcome gains: private, mapId, map (name), match:<match>, lobby:<lobby>, obj:<obj|null>;
//   roster entries ('welcome'.players, 'join'.player) gain team ('' | 'a' | 'b') and obj (the
//   player's objective score: captures in ctf, seconds in the zone in hardpoint, else 0).
//   { t:'match', phase, mode, mapId, map, config, private, hostId, startTick, endsTick,
//     scores:{a,b}, result:<result|null> }        on every change + every 2 s (refresh)
//   { t:'lobby', hostId, players:[{ id, name, team, bot }] }    on change (+ every 2 s in lobby)
//   { t:'team', id, team }                        a player's team changed
//   { t:'obj', mode, scores:{a,b}, flags:{a:<flag>, b:<flag>}|null, hp:<zone>|null }
//                                                 objective state, on change + every 1 s while
//                                                 playing (ctf / hardpoint / tdm)
//     <flag> = { state:'home'|'carried'|'dropped', carrier:<id|0>, pos:[x,y,z] (stand, drop
//                point, or the carrier's position when sent), returnTick:<tick|0> (dropped) }
//              flags.a is TEAM A's flag (it stands at map.flags.a; team B steals it)
//     <zone> = { index, name, min:[x,y,z], max:[x,y,z], owner:''|'a'|'b'|'contested',
//                rotateTick, next:<index of the next zone>, count:{a,b} (players inside) }
//   { t:'ev', e, ... }                            objective / match events:
//     e:'flag_taken'    team (whose flag), player              (also from a dropped flag)
//     e:'flag_dropped'  team, player (the carrier), pos, returnTick
//     e:'flag_returned' team, player (0 = timed out / fell out of the world)
//     e:'flag_captured' team (the CAPTURED flag's team), player, scorer (scoring team), scores
//     e:'zone_rotated'  index, name, rotateTick
//     e:'zone_taken'    team         e:'zone_contested'        e:'zone_neutral'
//     e:'match_start'   mode, mapId, endsTick        e:'match_end'  <result fields>
//   { t:'result', ...<result> }                   match over (also kept in 'match'.result)
//     <result> = { mode, mapId, winner:'a'|'b'|<player id>|null, draw, winnerName,
//                  scores:{a,b}, reason:'score'|'time', endsTick /* results end */,
//                  rows:[{ id, name, team, bot, kills, deaths, obj }] }
//   { t:'scores', rows:[{ id, kills, deaths, ping, team, obj }] }   ~ every 1 s
//   'spawn' gains team and prot (spawn-protection ticks; it ends early when that player fires).
//   'kill' only scores while playing: kills / deaths / team points count in phase 'playing'.
//   'round' is still sent for old clients: phase 'playing' while playing, else 'intermission'.
//   { t:'error', code, message }  also non-fatal: not_host, bad_phase, bad_team, bad_config
//
// VOICE CHAT (v5) - peer-to-peer WebRTC audio between the humans of a PRIVATE room. The server
//   only relays signaling (it never sees audio). Public rooms have no voice at all: the server
//   drops every 'rtc' / 'voice' message there and sends no ICE servers.
//   welcome gains: voice (bool, true in private rooms) and ice (RTCIceServer list, private rooms
//   only: public STUN, plus TURN when the server has TURN_URLS / TURN_USER / TURN_PASS set).
//   Roster entries ('welcome'.players, 'join'.player) in private rooms gain mic and deaf (bools).
// client -> server:
//   { t:'rtc', to:<player id>, d:<signal> }   relayed to `to` ONLY if sender and target are both
//                                             humans in the SAME private room (else dropped)
//     <signal> = { k:'sdp', type:'offer'|'answer', sdp:<string, <= MAX_SDP_CHARS> }
//              | { k:'ice', c:{ candidate, sdpMid, sdpMLineIndex, usernameFragment } | null }
//     The whole frame is at most MAX_SIGNAL_BYTES; the server re-builds the signal from these
//     fields only (anything else is dropped) and rate-limits signaling per connection.
//   { t:'voice', mic:<bool>, deaf:<bool> }    your voice state: mic = you are transmitting (mic
//                                             toggle on or push-to-talk held), deaf = you turned
//                                             your speaker off (others may stop sending to you)
// server -> client:
//   { t:'rtc', from:<player id>, d:<signal> }
//   { t:'voice', id, mic, deaf }              a player's voice state changed (private rooms)
//   Who may hear whom is decided by each SENDER's client (shared rule voiceAllowed() below):
//   team modes in phase countdown / playing -> teammates only; otherwise everyone in the room.
//   A client never sends its microphone track to a peer that is not allowed to hear it.
//
// CLOCK SYNC (client side; client/net.js implements all of this)
//   v2: the render clock for remote players is derived from SNAPSHOT ARRIVAL TIMES, not from
//   the ping clock: base = max over a few seconds of (snapshot.tick - arrivalMs / TICK_MS)
//   (the least-delayed arrival), renderTick = nowMs / TICK_MS + base - delayTicks, where
//   delayTicks covers the measured arrival jitter. This is immune to asymmetric routes and
//   keeps the buffer from running dry at any ping. The ping clock below is only used for
//   serverTick() (timers) and the displayed RTT.
//   - Send {t:'ping', c: performance.now(), rtt} about once a second (and 3-5 times quickly at
//     start). On pong: rtt = now - c;  sample = pong.tick + (rtt / 2) / TICK_MS - now / TICK_MS
//     is the offset "serverTick - clientMs/TICK_MS". Keep the sample with the lowest rtt over
//     the last ~10 pongs (or smooth it), then
//         serverTickNow  = now / TICK_MS + offset
//         renderTick     = serverTickNow - INTERP_DELAY_MS / TICK_MS
//   - Optionally nudge the offset so the newest snapshot tick stays >= renderTick + 1 (so the
//     interpolation buffer never runs dry).
//   - Interpolate remote players between the two buffered snapshots whose ticks straddle
//     renderTick and send exactly that renderTick in the next encodeInput call. The server
//     rewinds other players to the same time (capped at MAX_REWIND_MS), so what you saw is
//     what you hit.
//
// PREDICTION RULES
//   - Pass every cmd through sanitizeCmd() BEFORE using it for local prediction. It applies
//     the exact same float32 rounding and clamping the server applies after decoding, so the
//     predicted stepPlayer/stepWeapon results match the server bit-for-bit.
//   - Keep yaw within [-pi, pi] on the client (wrap it in input handling).
//   - Per cmd: mult = moveSpeedMult(kit, ws); stepPlayer(state, cmd, world, mult);
//     stepWeapon(ws, cmd, kit) - with kit = getKit(the lo of your latest own 'spawn').
// ============================================================================================

import { BTN_MASK, PITCH_LIMIT, MAX_DILATION_PERMILLE } from './constants.js';
import {
  SLOT_COUNT, WSTATE_BYTES, writeWeaponState, readWeaponState, createWeaponState, sanitizeLoadoutCode,
} from './weapons.js';
import { STATE_BYTES, writeState, readState, createPlayerState } from './physics.js';

export const PROTOCOL_VERSION = 5;   // v2: input-buffer feedback + dilation; v3: guns + loadouts; v4: modes, teams, lobby, maps; v5: voice chat signaling
export const MSG = { INPUT: 1, SNAPSHOT: 2 };
export const SHOT = { MISS: 0, WORLD: 1, BODY: 2, HEAD: 3 };
export const PFLAG = { ALIVE: 1, CROUCHING: 2, SLIDING: 4, ON_GROUND: 8, ADS: 16, RELOADING: 32 };
export const POS_SCALE = 128;
/** Team <-> wire code (snapshot team bits). '' = no team (free-for-all). */
export const TEAM_CODES = ['', 'a', 'b'];
export function teamCode(t) { return t === 'a' ? 1 : t === 'b' ? 2 : 0; }
export const TICK_MS = 1000 / 60;

export const INPUT_REDUNDANCY = 4;     // cmds the client should send per packet
export const INPUT_MAX_CMDS = 8;       // most cmds a packet may carry
export const INPUT_HEADER_BYTES = 14;
export const INPUT_CMD_BYTES = 11;
export const INPUT_MAX_BYTES = INPUT_HEADER_BYTES + INPUT_CMD_BYTES * INPUT_MAX_CMDS;
export const MAX_TEXT_BYTES = 2048;
// (v5) voice signaling: an SDP offer / answer is bigger than ordinary text messages
export const MAX_SIGNAL_BYTES = 8192;
export const MAX_SDP_CHARS = 7600;

export const SNAP_HEADER_BYTES = 18;   // type..starved
export const SNAP_SELF_BYTES = SNAP_HEADER_BYTES + STATE_BYTES + WSTATE_BYTES;
export const PLAYER_ENTRY_BYTES = 14;
export const SHOT_ENTRY_BYTES = 9;
export const MAX_SNAP_PLAYERS = 255;
export const MAX_SNAP_SHOTS = 255;

const TWO_PI = Math.PI * 2;
const F_PITCH_LIMIT = Math.fround(PITCH_LIMIT);

// ------------------------------------------------------------------------------- helpers

function toView(data) {
  if (data instanceof ArrayBuffer) return new DataView(data);
  if (ArrayBuffer.isView(data)) return new DataView(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function q16(v) {
  let n = Math.round(v * POS_SCALE);
  if (!(n >= -32768)) n = -32768; // also catches NaN
  else if (n > 32767) n = 32767;
  return n;
}

/** Quantised yaw/pitch exactly as the snapshot stores them (useful for tests). */
export function packYaw(yaw) {
  let a = yaw % TWO_PI;
  if (a < 0) a += TWO_PI;
  if (!(a >= 0)) a = 0;
  return Math.round(a * (65536 / TWO_PI)) & 0xffff;
}
export function unpackYaw(u) {
  const a = u * (TWO_PI / 65536);
  return a > Math.PI ? a - TWO_PI : a; // [-pi, pi]
}
function packPitch(p) {
  let n = Math.round(p * (32767 / (Math.PI / 2)));
  if (!(n >= -32767)) n = -32767;
  else if (n > 32767) n = 32767;
  return n;
}
function unpackPitch(n) { return n * ((Math.PI / 2) / 32767); }

function normalToAxis(n) {
  if (!n) return 7;
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (ax >= ay && ax >= az && ax > 0.5) return n[0] > 0 ? 0 : 1;
  if (ay >= az && ay > 0.5) return n[1] > 0 ? 2 : 3;
  if (az > 0.5) return n[2] > 0 ? 4 : 5;
  return 7;
}
const AXIS_NORMALS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], null, null];

// ------------------------------------------------------------------------------- commands

export function createCmd() {
  return { seq: 0, buttons: 0, yaw: 0, pitch: 0, weapon: 0 };
}

/**
 * Make a cmd exactly what the server will see after the wire round trip: float32 yaw/pitch,
 * pitch clamped, buttons masked, weapon in range (invalid -> 0), seq as uint32.
 * Mutates and returns cmd. Returns null if yaw/pitch are not finite.
 */
export function sanitizeCmd(cmd) {
  let yaw = Math.fround(cmd.yaw);
  let pitch = Math.fround(cmd.pitch);
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;
  if (yaw > 64 || yaw < -64) yaw = Math.fround(yaw % TWO_PI);
  if (pitch > F_PITCH_LIMIT) pitch = F_PITCH_LIMIT;
  else if (pitch < -F_PITCH_LIMIT) pitch = -F_PITCH_LIMIT;
  cmd.yaw = yaw;
  cmd.pitch = pitch;
  cmd.buttons = (cmd.buttons | 0) & BTN_MASK;
  const w = cmd.weapon | 0;
  cmd.weapon = w >= 0 && w < SLOT_COUNT ? w : 0;
  cmd.seq = cmd.seq >>> 0;
  return cmd;
}

// ------------------------------------------------------------------------------- INPUT

const inputScratch = new ArrayBuffer(INPUT_MAX_BYTES);
const inputView = new DataView(inputScratch);
const inputBytes = new Uint8Array(inputScratch);

/**
 * CLIENT. Encode an input packet.
 *   cmds: array of cmds in increasing seq order (newest last); only the trailing run of
 *         consecutive seqs, at most `maxCmds` (default INPUT_REDUNDANCY), is sent.
 *   renderTick: server tick the client is rendering remote players at (see CLOCK SYNC).
 * Returns a NEW Uint8Array (safe to hand to ws.send), or null if cmds is empty.
 */
export function encodeInput(cmds, renderTick, maxCmds = INPUT_REDUNDANCY) {
  const n = cmds ? cmds.length : 0;
  if (n === 0) return null;
  const limit = Math.max(1, Math.min(maxCmds | 0, INPUT_MAX_CMDS));
  const newest = cmds[n - 1];
  const newestSeq = newest.seq >>> 0;
  let count = 1;
  while (count < limit && count < n && ((cmds[n - 1 - count].seq >>> 0) === ((newestSeq - count) >>> 0))) count++;
  const v = inputView;
  v.setUint8(0, MSG.INPUT);
  v.setFloat64(1, Number.isFinite(renderTick) ? renderTick : 0, true);
  v.setUint32(9, newestSeq, true);
  v.setUint8(13, count);
  let o = INPUT_HEADER_BYTES;
  for (let i = n - count; i < n; i++) {
    const c = cmds[i];
    v.setUint16(o, (c.buttons | 0) & BTN_MASK, true);
    v.setFloat32(o + 2, c.yaw, true);
    v.setFloat32(o + 6, c.pitch, true);
    v.setUint8(o + 10, c.weapon | 0);
    o += INPUT_CMD_BYTES;
  }
  return inputBytes.slice(0, o);
}

/** Reusable output object for decodeInput. */
export function createInputPacket() {
  const cmds = [];
  for (let i = 0; i < INPUT_MAX_CMDS; i++) cmds.push(createCmd());
  return { renderTick: 0, count: 0, cmds };
}

/**
 * SERVER. Decode + validate an input packet into `out` (createInputPacket()).
 * cmds[0..count-1] are oldest first and already sanitised (sanitizeCmd).
 * Returns out, or null for anything malformed (never throws).
 */
export function decodeInput(data, out = createInputPacket()) {
  const v = toView(data);
  if (!v || v.byteLength < INPUT_HEADER_BYTES + INPUT_CMD_BYTES || v.byteLength > INPUT_MAX_BYTES) return null;
  if (v.getUint8(0) !== MSG.INPUT) return null;
  const count = v.getUint8(13);
  if (count < 1 || count > INPUT_MAX_CMDS) return null;
  if (v.byteLength !== INPUT_HEADER_BYTES + count * INPUT_CMD_BYTES) return null;
  const renderTick = v.getFloat64(1, true);
  if (!Number.isFinite(renderTick)) return null;
  const newestSeq = v.getUint32(9, true);
  let o = INPUT_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    const c = out.cmds[i];
    c.seq = (newestSeq - (count - 1 - i)) >>> 0;
    c.buttons = v.getUint16(o, true);
    c.yaw = v.getFloat32(o + 2, true);
    c.pitch = v.getFloat32(o + 6, true);
    c.weapon = v.getUint8(o + 10);
    if (sanitizeCmd(c) === null) return null;
    o += INPUT_CMD_BYTES;
  }
  out.renderTick = renderTick;
  out.count = count;
  return out;
}

// ------------------------------------------------------------------------------- SNAPSHOT
// Low-level writers (used by the server's zero-garbage snapshot builder and by encodeSnapshot).

/**
 * Write header + self block at `offset`. you = { id, alive, health, respawnTicks, state, weapon,
 * inputBuffer, inputTarget (ticks, fractional), timeScale (permille), starved (counter),
 * (v4) protected (bool), team ('' | 'a' | 'b'), carrier (bool) }.
 * ackSeq < 0 or null means "no cmd processed yet". Returns new offset (offset + SNAP_SELF_BYTES).
 */
export function writeSnapshotSelf(view, offset, tick, ackSeq, you) {
  view.setUint8(offset, MSG.SNAPSHOT);
  view.setUint32(offset + 1, tick >>> 0, true);
  const hasAck = ackSeq !== null && ackSeq !== undefined && ackSeq >= 0;
  view.setUint32(offset + 5, hasAck ? ackSeq >>> 0 : 0, true);
  view.setUint8(offset + 9, you.id & 0xff);
  view.setUint8(offset + 10, (you.alive ? 1 : 0) | (hasAck ? 2 : 0) | (you.protected ? 4 : 0) |
    (teamCode(you.team) << 3) | (you.carrier ? 32 : 0));
  view.setUint8(offset + 11, clampU8(Math.round(you.health)));
  view.setUint16(offset + 12, Math.max(0, Math.min(65535, you.respawnTicks | 0)), true);
  view.setUint8(offset + 14, clampU8(Math.round((+you.inputBuffer || 0) * 8)));
  view.setUint8(offset + 15, clampU8(Math.round((+you.inputTarget || 0) * 8)));
  const ts = Math.round(+you.timeScale || 0);
  view.setInt8(offset + 16, ts > MAX_DILATION_PERMILLE ? MAX_DILATION_PERMILLE : ts < -MAX_DILATION_PERMILLE ? -MAX_DILATION_PERMILLE : ts);
  view.setUint8(offset + 17, (you.starved | 0) & 0xff);
  let o = writeState(view, offset + SNAP_HEADER_BYTES, you.state);
  o = writeWeaponState(view, o, you.weapon);
  return o;
}

/**
 * Write one compact player entry. p = { id, x, y, z, yaw, pitch, alive, crouching, sliding,
 * onGround, ads, reloading, weapon (slot), gun (gun id; only bit0 = gun B is sent), health,
 * (v4) team ('' | 'a' | 'b'), protected (bool), carrier (bool) }.
 * Returns offset + PLAYER_ENTRY_BYTES.
 */
export function writePlayerEntry(view, o, p) {
  view.setUint8(o, p.id & 0xff);
  view.setInt16(o + 1, q16(p.x), true);
  view.setInt16(o + 3, q16(p.y), true);
  view.setInt16(o + 5, q16(p.z), true);
  view.setUint16(o + 7, packYaw(p.yaw), true);
  view.setInt16(o + 9, packPitch(p.pitch), true);
  view.setUint8(o + 11,
    (p.alive ? 1 : 0) | (p.crouching ? 2 : 0) | (p.sliding ? 4 : 0) | (p.onGround ? 8 : 0) |
    (p.ads ? 16 : 0) | (p.reloading ? 32 : 0) | ((p.weapon & 3) << 6));
  const hp = clampU8(Math.round(p.health));
  view.setUint8(o + 12, (hp > 127 ? 127 : hp) | ((p.gun & 1) << 7));
  view.setUint8(o + 13, teamCode(p.team) | (p.protected ? 4 : 0) | (p.carrier ? 8 : 0));
  return o + PLAYER_ENTRY_BYTES;
}

/**
 * Write one tracer entry. s = { shooter, weapon (slot), gun (gun id), kind (SHOT.*), victim (0 = none),
 * x, y, z (end point), normal: [nx,ny,nz] | null | axis index (number) }.
 */
export function writeShotEntry(view, o, s) {
  const axis = typeof s.normal === 'number' ? (s.normal & 7) : normalToAxis(s.normal);
  view.setUint8(o, s.shooter & 0xff);
  view.setUint8(o + 1, (s.kind & 3) | (axis << 2) | ((s.weapon & 3) << 5) | ((s.gun & 1) << 7));
  view.setUint8(o + 2, s.victim & 0xff);
  view.setInt16(o + 3, q16(s.x), true);
  view.setInt16(o + 5, q16(s.y), true);
  view.setInt16(o + 7, q16(s.z), true);
  return o + SHOT_ENTRY_BYTES;
}

export { normalToAxis };

function clampU8(n) { return n < 0 ? 0 : n > 255 ? 255 : (n | 0); }

/**
 * Convenience encoder (allocates; the server uses the low-level writers instead).
 * snap = { tick, ackSeq, you:{ id, alive, health, respawnTicks, state, weapon }, players:[...], shots:[...] }
 */
export function encodeSnapshot(snap) {
  const np = Math.min(snap.players.length, MAX_SNAP_PLAYERS);
  const ns = Math.min(snap.shots.length, MAX_SNAP_SHOTS);
  const size = SNAP_SELF_BYTES + 1 + np * PLAYER_ENTRY_BYTES + 1 + ns * SHOT_ENTRY_BYTES;
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  let o = writeSnapshotSelf(v, 0, snap.tick, snap.ackSeq, snap.you);
  v.setUint8(o++, np);
  for (let i = 0; i < np; i++) o = writePlayerEntry(v, o, snap.players[i]);
  v.setUint8(o++, ns);
  for (let i = 0; i < ns; i++) o = writeShotEntry(v, o, snap.shots[i]);
  return buf;
}

function createRemotePlayer() {
  return { id: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: false, crouching: false, sliding: false,
    onGround: false, ads: false, reloading: false, weapon: 0, gun: 0, health: 0, team: '', protected: false, carrier: false };
}
function createShot() {
  return { shooter: 0, weapon: 0, gun: 0, kind: 0, victim: 0, x: 0, y: 0, z: 0, normal: null };
}

/**
 * Reusable output object for decodeSnapshot:
 * { tick, ackSeq /* -1 = none *\/, you:{ id, alive, health, respawnTicks, inputBuffer, inputTarget,
 *   timeScale /* permille *\/, starved, state, weapon, protected, team, carrier },
 *   players:[{ id,x,y,z,yaw,pitch,alive,crouching,sliding,onGround,ads,reloading,weapon,gun,health,
 *              team /* '' | 'a' | 'b' *\/, protected, carrier }],
 *   shots:[{ shooter, weapon, gun, kind, victim, x,y,z, normal:[x,y,z]|null }] }
 * weapon = slot (0..2), gun = gun id (slot * 2 + variant, see weapons.GUNS).
 * The arrays/objects are reused by the next decode into the same `out` - copy what you keep
 * (e.g. into your interpolation buffer) or use a ring of several snapshot objects.
 */
export function createSnapshot() {
  return {
    tick: 0, ackSeq: -1,
    you: { id: 0, alive: false, health: 0, respawnTicks: 0, inputBuffer: 0, inputTarget: 0, timeScale: 0, starved: 0,
      protected: false, team: '', carrier: false, state: createPlayerState(), weapon: createWeaponState() },
    players: [], shots: [],
    _pp: [], _sp: [],
  };
}

/**
 * CLIENT. Decode a snapshot (ArrayBuffer or typed array/Buffer) into `out`.
 * Returns out, or null if malformed (never throws).
 */
export function decodeSnapshot(data, out = createSnapshot()) {
  const v = toView(data);
  if (!v || v.byteLength < SNAP_SELF_BYTES + 2 || v.getUint8(0) !== MSG.SNAPSHOT) return null;
  try {
    const flags = v.getUint8(10);
    out.tick = v.getUint32(1, true);
    out.ackSeq = (flags & 2) ? v.getUint32(5, true) : -1;
    const you = out.you;
    you.id = v.getUint8(9);
    you.alive = (flags & 1) !== 0;
    you.protected = (flags & 4) !== 0;
    you.team = TEAM_CODES[(flags >> 3) & 3] || '';
    you.carrier = (flags & 32) !== 0;
    you.health = v.getUint8(11);
    you.respawnTicks = v.getUint16(12, true);
    you.inputBuffer = v.getUint8(14) / 8;
    you.inputTarget = v.getUint8(15) / 8;
    you.timeScale = v.getInt8(16);
    you.starved = v.getUint8(17);
    let o = readState(v, SNAP_HEADER_BYTES, you.state);
    o = readWeaponState(v, o, you.weapon);
    if (o !== SNAP_SELF_BYTES) return null;
    const np = v.getUint8(o++);
    if (o + np * PLAYER_ENTRY_BYTES + 1 > v.byteLength) return null;
    const pp = out._pp;
    while (pp.length < np) pp.push(createRemotePlayer());
    out.players.length = 0;
    for (let i = 0; i < np; i++) {
      const p = pp[i];
      p.id = v.getUint8(o);
      p.x = v.getInt16(o + 1, true) / POS_SCALE;
      p.y = v.getInt16(o + 3, true) / POS_SCALE;
      p.z = v.getInt16(o + 5, true) / POS_SCALE;
      p.yaw = unpackYaw(v.getUint16(o + 7, true));
      p.pitch = unpackPitch(v.getInt16(o + 9, true));
      const f = v.getUint8(o + 11);
      p.alive = (f & 1) !== 0; p.crouching = (f & 2) !== 0; p.sliding = (f & 4) !== 0;
      p.onGround = (f & 8) !== 0; p.ads = (f & 16) !== 0; p.reloading = (f & 32) !== 0;
      p.weapon = (f >> 6) & 3;
      if (p.weapon >= SLOT_COUNT) p.weapon = 0;
      const hb = v.getUint8(o + 12);
      p.health = hb & 0x7f;
      p.gun = p.weapon * 2 + (hb >> 7);
      const xb = v.getUint8(o + 13);
      p.team = TEAM_CODES[xb & 3] || '';
      p.protected = (xb & 4) !== 0;
      p.carrier = (xb & 8) !== 0;
      out.players.push(p);
      o += PLAYER_ENTRY_BYTES;
    }
    const ns = v.getUint8(o++);
    if (o + ns * SHOT_ENTRY_BYTES !== v.byteLength) return null;
    const sp = out._sp;
    while (sp.length < ns) sp.push(createShot());
    out.shots.length = 0;
    for (let i = 0; i < ns; i++) {
      const s = sp[i];
      s.shooter = v.getUint8(o);
      const f = v.getUint8(o + 1);
      s.kind = f & 3;
      s.normal = AXIS_NORMALS[(f >> 2) & 7];
      s.weapon = (f >> 5) & 3;
      if (s.weapon >= SLOT_COUNT) s.weapon = 0;
      s.gun = s.weapon * 2 + (f >> 7);
      s.victim = v.getUint8(o + 2);
      s.x = v.getInt16(o + 3, true) / POS_SCALE;
      s.y = v.getInt16(o + 5, true) / POS_SCALE;
      s.z = v.getInt16(o + 7, true) / POS_SCALE;
      out.shots.push(s);
      o += SHOT_ENTRY_BYTES;
    }
    return out;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------- TEXT (JSON)

/** Encode any text message ({ t: '...', ... }) -> string. */
export function encodeText(msg) { return JSON.stringify(msg); }

/**
 * Decode a text frame (string, or Buffer/typed array of UTF-8). Returns a plain object with a
 * string `t`, or null if it is not valid JSON / too big / has no type. Never throws.
 */
export function decodeText(data, maxBytes = MAX_TEXT_BYTES) {
  let str = data;
  if (typeof str !== 'string') {
    const v = toView(data);
    if (!v || v.byteLength > maxBytes) return null;
    try { str = new TextDecoder().decode(v); } catch { return null; }
  }
  if (str.length > maxBytes) return null;
  let msg;
  try { msg = JSON.parse(str); } catch { return null; }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return null;
  return msg;
}

// Typed constructors for client -> server text messages.
export function encodeJoin(name, room, bots, loadoutCode) {
  const m = { t: 'join', v: PROTOCOL_VERSION, name: String(name ?? '') };
  if (room) m.room = String(room);
  // Optional: minimum participants to keep by adding bots (0 = no bots). Only honoured when
  // this join creates a private room; later joiners cannot change it.
  if (Number.isFinite(bots)) m.bots = bots | 0;
  // Optional (v3): loadout code (weapons.encodeLoadout) for the first life.
  if (Number.isInteger(loadoutCode)) m.lo = sanitizeLoadoutCode(loadoutCode);
  return JSON.stringify(m);
}
/** (v3) Set the pending loadout; it becomes active at the next spawn. */
export function encodeSetLoadout(loadoutCode) {
  return JSON.stringify({ t: 'loadout', lo: sanitizeLoadoutCode(loadoutCode | 0) });
}
/**
 * Server-side: a client-supplied loadout code -> canonical code, or `fallback` when it is
 * missing / not an integer in range (never throws).
 */
export function parseLoadoutCode(v, fallback) {
  return Number.isInteger(v) && v >= 0 && v <= 0xffffff ? sanitizeLoadoutCode(v) : fallback;
}
/** (v4) Host: set the match config (lobby only). cfg may be partial; the server re-sanitises it. */
export function encodeMatchConfig(cfg) { return JSON.stringify({ t: 'config', cfg: cfg && typeof cfg === 'object' ? cfg : {} }); }
/** (v4) Host: start the match (lobby -> countdown). */
export function encodeStart() { return '{"t":"start"}'; }
/** (v4) Switch team in the lobby. */
export function encodeTeam(team) { return JSON.stringify({ t: 'team', team: team === 'b' ? 'b' : 'a' }); }
/** (v4) Host: back to the lobby (private rooms). */
export function encodeReturnToLobby() { return '{"t":"lobby"}'; }
/** Server-side: 'a' | 'b' or null. */
export function parseTeam(v) { return v === 'a' || v === 'b' ? v : null; }

// ------------------------------------------------------------------------------- VOICE (v5)

/**
 * Who may hear whom (the sender enforces it). teams = the room plays a team mode, phase = match
 * phase, a / b = the two players' teams. Team modes during countdown / playing: same team only;
 * free-for-all and the lobby / results phases of any mode: everyone.
 */
export function voiceAllowed(teams, phase, a, b) {
  if (teams && (phase === 'countdown' || phase === 'playing')) return (a === 'a' || a === 'b') && a === b;
  return true;
}

/** CLIENT. A signaling message for peer `to`: d = { k:'sdp', type, sdp } | { k:'ice', c }. */
export function encodeRtc(to, d) { return JSON.stringify({ t: 'rtc', to: to | 0, d }); }
/** CLIENT. Your voice state (mic = transmitting, deaf = speaker off). */
export function encodeVoiceState(mic, deaf) { return JSON.stringify({ t: 'voice', mic: !!mic, deaf: !!deaf }); }

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
/**
 * Validate a signal (the `d` of an 'rtc' message) and rebuild it from the known fields only.
 * Returns the clean signal or null. Used by the server before relaying and by the client on receipt.
 */
export function sanitizeSignal(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (d.k === 'sdp') {
    if (d.type !== 'offer' && d.type !== 'answer') return null;
    const sdp = str(d.sdp, MAX_SDP_CHARS);
    if (!sdp || !sdp.startsWith('v=0')) return null;
    return { k: 'sdp', type: d.type, sdp };
  }
  if (d.k === 'ice') {
    if (d.c === null || d.c === undefined) return { k: 'ice', c: null };
    const c = d.c;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    const candidate = str(c.candidate, 600);
    if (candidate === null) return null;
    const out = { candidate };
    if (c.sdpMid !== undefined && c.sdpMid !== null) { const m = str(c.sdpMid, 32); if (m === null) return null; out.sdpMid = m; } else out.sdpMid = null;
    if (c.sdpMLineIndex !== undefined && c.sdpMLineIndex !== null) {
      if (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 63) return null;
      out.sdpMLineIndex = c.sdpMLineIndex;
    } else out.sdpMLineIndex = null;
    if (c.usernameFragment !== undefined && c.usernameFragment !== null) { const u = str(c.usernameFragment, 256); if (u === null) return null; out.usernameFragment = u; }
    return { k: 'ice', c: out };
  }
  return null;
}

export function encodePing(clientMs, rtt) {
  const m = { t: 'ping', c: clientMs };
  if (Number.isFinite(rtt)) m.rtt = rtt;
  return JSON.stringify(m);
}

/** Server-side name sanitiser (also usable by the client to preview the name). */
export function sanitizeName(name) {
  let s = typeof name === 'string' ? name : '';
  s = s.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').trim().slice(0, 16);
  return s || 'Player';
}
export function sanitizeRoomName(room) {
  if (typeof room !== 'string') return '';
  return room.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
}
