# Hopshot - architecture contract

Hopshot is an ORIGINAL browser arena FPS prototype: fast slide-hop movement, hitscan guns,
free-for-all deathmatch, up to 20 players per room on an authoritative server. It is in the
same genre as popular browser shooters but must not copy any existing game's name, art, maps,
characters, UI or sounds.

Several agents build this at the same time. This file is the contract between them.
**Only edit the files you own.** If the contract seems wrong, work around it and say so in
your final report - do not edit another owner's file.

## Stack

- Node >= 18, ESM everywhere (`"type": "module"`), **no build step, no bundler, no TypeScript**.
- Dependencies (already installed): `ws`, `three`. Do not add dependencies.
- `npm start` runs `node server/index.js` (PORT env, default 3000). The same process serves the
  static client and the WebSocket.
- The browser loads ES modules directly. `index.html` uses this import map:
  `{"imports": {"three": "/node_modules/three/build/three.module.js", "three/addons/": "/node_modules/three/examples/jsm/"}}`
- `shared/` is imported by both Node and the browser: pure ESM, no DOM, no Node APIs.

## Conventions

- Units: metres, seconds, radians. **Y is up.**
- Player position `(x, y, z)` is the **centre of the feet**. Collision volume is an axis-aligned
  box, `PLAYER.halfWidth` wide, `PLAYER.height` tall (`crouchHeight` when crouched).
- `yaw = 0` looks down **-Z**; positive yaw turns **left**. `pitch > 0` looks **up**.
  Forward = `(-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch))`, right = `(cos(yaw), 0, -sin(yaw))`.
  In three.js: `camera.rotation.order = 'YXZ'; camera.rotation.set(pitch, yaw, 0)`.
- Simulation is a fixed 60 Hz tick (`TICK_RATE`, `DT`). One input command (`cmd`) per tick:
  `cmd = { seq, buttons, yaw, pitch, weapon }` - `seq` is a uint32 that increases by 1 per tick,
  `buttons` is a `BTN` bitmask, `weapon` is the desired weapon id.
- Everything in the simulation must be deterministic: no `Math.random`, no `Date.now` inside
  `shared/` step functions.

## File ownership

| Files | Owner |
| --- | --- |
| `ARCHITECTURE.md`, `package.json`, `shared/constants.js`, `shared/weapons.js` | orchestrator (read-only for agents) |
| `shared/physics.js`, `tools/physics.test.js` | physics agent |
| `shared/protocol.js`, `server/**`, `tools/loadtest.js` | server agent |
| `shared/map.js`, `client/index.html`, `client/style.css`, `client/render.js`, `client/hud.js`, `client/audio.js`, `client/dev-preview.html` | presentation agent |
| `client/main.js`, `client/net.js`, `client/input.js` | client-core agent (phase 2, after the others finish) |

## shared/physics.js (physics agent)

Pure, deterministic, allocation-free in the hot path. Required exports:

```js
export const MOVE = { /* all movement tunables in one object */ };

export function createWorld(map);            // -> world: prebuilt colliders (+ spatial grid) from MAP
export function createPlayerState();         // -> plain object, only number/boolean fields
// REQUIRED fields on the state: x, y, z, vx, vy, vz, onGround, crouching, sliding
// plus any private fields you need (timers etc). Everything that affects future steps must be
// in the state, because the client rewinds to a server state and replays cmds from it.
export function copyState(dst, src);         // -> dst
export function spawnState(state, x, y, z);  // reset to standing still at a spawn

export function stepPlayer(state, cmd, world);   // advance exactly one tick (DT); mutates state
// uses cmd.buttons / cmd.yaw for movement, and cmd.weapon + BTN.ADS for the speed multiplier
// (WEAPONS[cmd.weapon].speedMult, and adsSpeedMult while ADS is held).

export function eyeHeight(state);            // smooth (crouch-lerped) eye height above feet
export function hitboxHeight(state);         // current collision height

// Binary form of the FULL state (everything stepPlayer reads), for snapshot reconciliation.
export const STATE_BYTES;
export function writeState(view, offset, state);  // DataView, little-endian -> new offset
export function readState(view, offset, state);   // -> new offset
// stepPlayer must give the same result from a state that went through write/read as the server
// got from its own copy (round positions/velocities with Math.fround in the step if needed, or
// serialise as float64 - your call, but replay-after-readState must not drift from the server).

// Hitscan helpers.
export function raycastWorld(world, ox, oy, oz, dx, dy, dz, maxDist, outNormal /* optional [3] */);
//   -> distance along the (unit) ray to the first solid, or Infinity
export function raycastPlayer(ox, oy, oz, dx, dy, dz, px, py, pz, height, maxDist);
//   -> null, or { t, head } against a player box at feet (px,py,pz); head = hit in the top PLAYER.headSize
```

### Movement feel targets

The goal is the snappy, momentum-based feel of fast browser arena shooters. Starting points -
tune them until it feels right, keep them all in `MOVE`:

- Ground: near-instant acceleration, strong friction, run speed about 7 m/s, crouch-walk about 3.5 m/s.
- Jump: gravity about 25 m/s^2, apex about 1.2-1.4 m; holding jump re-jumps on landing (auto-hop).
- Air: Quake-style air acceleration (small wish-speed cap, high accel) so strafing in the air
  bends and slightly gains speed; horizontal speed is otherwise preserved in the air.
- **Slide-hop:** pressing/holding crouch while moving fast on the ground, or landing with crouch
  held, starts a slide: a one-time speed boost (about x1.25), very low friction that ramps back
  up over about 0.8 s, steering limited. Jumping out of a slide keeps the momentum. Chaining
  jump -> land crouched -> slide -> jump builds speed up to a hard horizontal cap (about 17 m/s).
  A cooldown stops the boost from being re-triggered instantly on flat ground without a jump.
- Collision: player AABB vs world AABBs. No tunnelling at the speed cap, no sticking on seams
  between adjacent boxes, no jitter when resting, step-up for ledges <= 0.35 m, head bumps cancel
  upward velocity, cannot stand up under a low ceiling (stay crouched).
- Budget: `stepPlayer` should cost well under 20 microseconds on the real map (20 players x
  server + client replay of ~15 cmds per reconciliation).

`tools/physics.test.js` (`npm test`, plain Node asserts, no test framework): determinism,
write/read round trip + replay equality, resting stability, no tunnelling, step-up, slide-hop
gain and cap, raycasts, and a micro-benchmark.

## shared/weapons.js (already written - read it)

`WEAPONS`, `createWeaponState/resetWeaponState/copyWeaponState`, `stepWeapon(ws, cmd) -> fired`,
`shotSpread(weaponId, buttons)`, `shotDir(out, yaw, pitch, spread, seq, pellet)`,
`WSTATE_BYTES/writeWeaponState/readWeaponState`. Client and server both call `stepWeapon` once
per cmd, right after `stepPlayer`. When it returns true, the shot origin is the eye
(`x, y + eyeHeight(state), z`) and each pellet `p` flies along
`shotDir(out, cmd.yaw, cmd.pitch, shotSpread(ws.weapon, cmd.buttons), cmd.seq, p)`.

## Server (server agent)

- `server/index.js`: HTTP static server (serves `/` -> `client/index.html`, `/client/*`,
  `/shared/*`, and ONLY `/node_modules/three/build/*` + `/node_modules/three/examples/jsm/*`
  from node_modules; correct MIME types; no path traversal) plus a `ws` WebSocketServer on the
  same port (path `/ws`). `GET /status` returns JSON with rooms, player counts and tick timings.
- Rooms: a player joins the fullest room that still has a free slot (or a named room via
  `room` in the join message); a new room is created when all are full. `MAX_PLAYERS` per room.
  Empty rooms are destroyed. Each room has its own 60 Hz fixed-step loop that does not drift
  (accumulator on a high-resolution clock; cap catch-up steps).
- Authoritative simulation: per player a small cmd queue (jitter buffer). Each server tick
  consumes one cmd per player through `stepPlayer` + `stepWeapon`; if the queue is empty the
  last cmd's movement buttons are repeated for a few ticks, then the player idles; if the queue
  grows too long, extra cmds are consumed/dropped so latency cannot build up and nobody can
  speed-hack by sending cmds faster than 60 Hz. Validate everything from clients (finite
  numbers, clamp pitch, mask buttons, weapon range, monotonic seq, message size, rate).
- Lag compensation: keep about 1 s of per-tick position history for every player. Input packets
  carry the server time the client was rendering remote players at; when a shot is fired, test
  the ray against other players rewound to that time (interpolated between history ticks,
  rewind capped at `MAX_REWIND_MS`), and against the world with `raycastWorld`.
- Rules: FFA deathmatch. Damage, headshots, kills/deaths, respawn after `RESPAWN_MS` at the
  spawn farthest from enemies, health regen after `REGEN_DELAY_MS`, falling below `MAP.killY`
  kills. Rounds last `ROUND_MS`, then `INTERMISSION_MS` scoreboard, then scores reset.
- Snapshots at 30 Hz, binary, per client: server tick, the last cmd seq processed for that
  client, that client's full physics state (`writeState`) + weapon state + health, then every
  other player compactly (id, position, yaw, pitch, flags alive/crouching/sliding/onGround,
  weapon, health), then the shots fired since the last snapshot (shooter id, impact point, what
  was hit) so clients can draw tracers. Target well under 15 kB/s per client with 20 players.
- Rare events as JSON text frames: welcome (your id, room, roster, round state, server tick),
  player joined/left, kill feed, hit confirmation to the shooter, damage notice to the victim
  (with attacker position), round start/end, scoreboard (kills, deaths, ping), ping/pong for
  clock sync and latency.
- `shared/protocol.js`: ALL encode and decode functions for every message, both directions,
  with the wire format documented at the top. The client-core agent will only call these
  functions, so make them symmetric and easy to use (decode into plain objects; reuse buffers).
- `server/bots.js`: simple server-side bots that play through the same cmd path as humans
  (wander between spawns/waypoints, jump and slide sometimes, shoot at visible enemies with
  human-like reaction time and aim error). Default: keep at least 4 participants in a room by
  adding bots, and remove bots as humans join (`BOTS` env overrides; `BOTS=0` disables).
- `tools/loadtest.js`: spawns N headless WebSocket clients (default 20) that send realistic
  60 Hz input for a while, then prints server tick time p50/p95/p99/max (from `/status`),
  bytes/s per client down and up, and whether any tick overran 16.6 ms. Use port 3101 for your
  own test runs and always stop the servers you start.

## Client presentation (presentation agent)

Original low-poly look: flat-shaded coloured boxes, bright sky, light fog, blocky characters
built from boxes, a first-person weapon viewmodel built from boxes. Must hold 60 fps with 20
players on a laptop (merge or instance the map geometry; pool tracers/particles; no per-frame
allocations in `render`).

```js
// client/render.js
export function createRenderer(canvas, map) -> {
  resize(width, height),
  setFov(degrees),                 // base hip-fire FOV from settings
  render(frame),                   // once per animation frame
  localFire(weaponId),             // viewmodel recoil + muzzle flash
  remoteFire(playerId),            // muzzle flash on a third-person character
  tracer(from, to, opts),          // [x,y,z] arrays; opts = { local: bool }
  impact(pos, normal, opts),       // opts = { flesh: bool }
}
frame = {
  dt, time,                        // seconds
  local: { alive, x, y, z, eyeHeight, yaw, pitch, vx, vy, vz, onGround, crouching, sliding,
           weapon, ads /* 0..1 smoothed */, reloading /* bool */ },
  players: [ { id, name, x, y, z, yaw, pitch, crouching, sliding, alive, weapon, health } ],
  // remote players only, already interpolated; the array and its objects are reused each frame
}
```

The renderer owns the camera: eye at `(x, y + eyeHeight, z)`, FOV lerps from the base FOV to
`WEAPONS[weapon].adsFov` by `ads`, a little speed-based FOV kick and landing/slide camera feel
are welcome. When `local.alive` is false show a simple death camera. Remote characters: name tag
above the head, crouch/slide pose, simple leg swing from movement, weapon in hand.

```js
// client/hud.js  (pure DOM/CSS, no canvas needed)
export function createHud(rootEl) -> {
  update(state),      // every frame: { alive, health, ammo, magSize, weaponKey, weaponName,
                      //   reloading, ads, speed /* m/s */, kills, deaths, roundTimeLeft /* s */,
                      //   respawnIn /* s */, ping /* ms */, fps, players /* in room */ }
  addKill({ killerName, victimName, weaponKey, headshot, localInvolved }),
  hitmarker({ headshot, kill }),
  damageFrom(relativeAngle),      // radians, 0 = from the front, + = from the left
  setScoreboard(visible, rows),   // rows: [{ id, name, kills, deaths, ping, isLocal, isBot }]
  showMenu({ defaultName, settings, onPlay(name), onSettings(settings) }),  // settings = { sensitivity, fov, volume }
  hideMenu(),
  showRoundEnd({ winnerName, rows, nextIn }), hideRoundEnd(),
  setStatus(text),                // "Connecting...", "Disconnected - click to retry", '' to hide
}

// client/audio.js  (WebAudio, every sound synthesised in code - no audio files)
export function createAudio() -> {
  unlock(),                       // call from a user gesture
  setVolume(v),                   // 0..1
  setListener(x, y, z, yaw),
  play(name, opts),               // opts = { volume, pos: [x,y,z] } - pos omitted = non-positional
  // names: 'rifle' 'scout' 'shotgun' 'reload' 'empty' 'switch' 'hit' 'headshot' 'kill'
  //        'hurt' 'death' 'jump' 'land' 'slide' 'step'
}
```

HUD contents: crosshair (hidden while scoped), scope overlay for the scout when `ads` is near 1,
health, ammo + weapon name, speedometer, kill feed, hit marker, damage direction indicator,
round timer, own kills/deaths, ping + fps, Tab scoreboard, death screen with respawn countdown,
main menu (name field, Play button, sensitivity/FOV/volume sliders, controls list), round-end
screen. `client/index.html` contains the import map, a full-window `<canvas id="game">`, a
`<div id="hud">` root, and `<script type="module" src="/client/main.js">`. `main.js` is written
later by the client-core agent, so `client/dev-preview.html` must exercise the renderer, HUD and
audio on their own with mock data (fly camera, a few animated fake players, buttons that trigger
every HUD/audio call) - it must work from any static server at the project root.

`shared/map.js`: replace the placeholder with a real arena for 10-20 players - roughly
70 x 70 m, only axis-aligned boxes (40-90 of them), a floor, perimeter walls, mixed heights with
box "stairs" (steps <= 0.3 m) or jump-ups (<= 1.2 m), long sightlines broken by cover, room to
slide-hop in loops, no spots a player can get stuck in, at least 20 spawn points spread around
and never inside geometry. Keep the export shape exactly as in the placeholder.

## Client core (phase 2 - client-core agent)

`client/input.js` (pointer lock, key map, sensitivity, builds the cmd each tick),
`client/net.js` (WebSocket, clock sync, client-side prediction with the shared physics and
weapon code, server reconciliation by rewinding to the acknowledged state and replaying
unacknowledged cmds with visual error smoothing, 100 ms interpolation buffer for remote
players, predicted local shots), `client/main.js` (bootstraps everything, fixed-step
accumulator loop + render interpolation, drives renderer/HUD/audio, menu and settings in
localStorage). Controls: WASD move, Space jump, Shift or C crouch/slide, left mouse fire,
right mouse ADS, R reload, 1/2/3 or wheel to switch weapon, Tab scoreboard, Esc menu.
