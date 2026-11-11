# Hopshot phase 2 - contract

Phase 2 adds: a fix for laggy play on high-ping / jittery connections, touch controls for
phones, more settings, 4 new maps, team game modes with a lobby, smarter spawns, smaller name
tags and more weapons. `ARCHITECTURE.md` still describes the base game and all of its
conventions (units, yaw/pitch, cmd, determinism, no build step, no new dependencies) still apply.

Several agents work in the same folder. **Only edit files you own in your phase.** Do not run
git commands that change state (no commit, checkout, stash, reset) - the orchestrator commits.
Never touch port 3000 (the user's live local server). Test ports: 3101 (server/load tests),
3103 (client test), 3105-3109 (anything else). Always stop what you start.

Hopshot is an original game: no names, maps, art, UI or sounds copied from existing games.
Mode names like "capture the flag" and "hardpoint" are generic genre terms and are fine.

## Phase A (parallel)

| Agent | Owns |
| --- | --- |
| A1 netcode | `server/room.js` (input queue / lag-comp parts only), `shared/protocol.js`, `client/net.js`, `tools/client.test.js`, `shared/constants.js` (netcode constants only) |
| A2 maps | `shared/maps/**`, `shared/map.js`, `tools/maps.test.js` |
| A3 mobile + settings | `client/input.js`, `client/hud.js`, `client/style.css`, `client/render.js`, `client/main.js`, `client/index.html`, `client/audio.js` |

### A1 - smooth play at 150-250 ms ping with jitter

Report from play: one player at ~180 ms ping "was lagging a lot" while a player at ~80 ms was
fine. Known weak spots: the server's input queue is a small fixed jitter buffer (it starves and
repeats movement, or overflows and drops cmds, both of which cause visible corrections); the
client renders remote players at a fixed 100 ms delay and "does not nudge itself to keep the
snapshot buffer from running dry"; WebSocket is TCP, so one lost packet delivers the following
ones late and in a burst.

Goals:
- Reproduce first: extend the lag injection in `tools/client.test.js` to model a bad link (e.g.
  180 ms RTT, +/-40 ms jitter, 2-3% loss modelled as TCP would deliver it: a stall followed by a
  burst, in order) and record corrections, starved ticks, dropped cmds, remote stutter.
- Server input: adaptive per-player jitter buffer sized from measured arrival jitter, no hard
  drops in normal operation, and feedback to the client (in the snapshot) so the client can
  run its simulation slightly faster or slower (time dilation, a few percent) to keep the
  server-side buffer at its target. Starvation must become rare, not routine.
- Client: adaptive interpolation delay for remote players from measured snapshot arrival
  jitter (min 100 ms, smooth changes, bounded), still reporting the real render tick with every
  input packet; raise `MAX_REWIND_MS` if needed so fair shots at 250 ms ping are still honoured.
- Keep prediction bit-exact on a clean link (0 corrections), keep the anti-speed-hack property
  (time dilation is bounded and server-driven), keep bandwidth about where it is.
- Expose `net.state.quality = { rttMs, jitterMs, interpDelayMs, timeScale, inputBufferTicks,
  corrections10s, starved10s }` (updated ~1/s) for the HUD net-stats line.
- Report before/after numbers for: clean, 80 ms, 180 ms +/-40 with loss, 250 ms +/-60 with loss.

### A2 - maps

`shared/maps/<id>.js` each export `MAP`; `shared/maps/index.js` exports
`MAPS` (array, default first), `MAP_IDS`, `getMap(id)` (falls back to the default) and
`DEFAULT_MAP_ID`. `shared/map.js` keeps working: `export const MAP = getMap(DEFAULT_MAP_ID)`.

Map schema (everything axis-aligned, metres, feet-level positions):

```js
export const MAP = {
  id: 'prism_yard',                 // [a-z0-9_]+, equals the file name
  name: 'Prism Yard',
  blurb: 'One short line for the lobby.',
  size: 'large',                    // 'small' (2-8 players) | 'medium' (4-12) | 'large' (8-20)
  boxes: [{ min: [x,y,z], max: [x,y,z], color: 0xRRGGBB }],
  bounds: { min: [x,y,z], max: [x,y,z] },
  killY: -20,
  spawns: [{ pos: [x,y,z], yaw }],                 // free-for-all, >= 16 (>= 24 on large)
  teamSpawns: { a: [{ pos, yaw }], b: [{ pos, yaw }] },   // >= 8 each, in that team's home area
  flags: { a: [x,y,z], b: [x,y,z] },               // flag stands, inside each home area
  hardpoints: [{ name: 'Fountain', min: [x,y,z], max: [x,y,z] }],  // 3-5 zones, about 6x6 m, 3 m tall
  theme: { skyTop: 0xRRGGBB, skyBottom: 0xRRGGBB, fog: 0xRRGGBB, fogDensity: 0.006, sun: [x,y,z] },
};
```

Rules: only boxes; a closed perimeter or a deliberate void with `killY`; steps <= 0.3 m or
jump-ups <= 1.2 m for every climb; team maps are mirror-symmetric (team B = team A mirrored)
so neither side has an advantage; every spawn has solid ground under it, is not inside or
within 0.5 m of a box horizontally (unless standing on top), and **has cover**: from most
spawns you cannot see the map centre or the enemy home area in a straight line; flags and
hardpoints are reachable on foot and not inside geometry; 30-90 boxes per map.

Keep Prism Yard (add the new fields to it) and add four original maps with distinct layouts
and palettes: two `small` ones built for 2-8 players (3-4 friends should find each other fast),
one `medium`, one `large` or vertical one. `tools/maps.test.js` validates every rule above that
can be checked in code (including a line-of-sight check for spawn cover using
`raycastWorld` from `shared/physics.js`, and walking each flag/hardpoint route with
`stepPlayer`) for every map and prints a per-map summary.

### A3 - touch controls, settings, name tags

- **Touch controls** that a first-time phone player can use immediately, landscape and
  portrait-with-rotate-prompt: floating left-thumb move stick (full deflection = run), drag
  anywhere on the right half to look, large fire button that can also be dragged to aim while
  firing, jump, crouch/slide, aim, reload, weapon-cycle buttons, a menu button and a scoreboard
  button. Use Pointer Events with multi-touch (several fingers at once), `touch-action: none`,
  no page scroll/zoom/selection/callout, safe-area insets. Build the same `cmd` as the
  keyboard path. `?touch=1` forces the touch UI on desktop so it can be tested with a mouse;
  auto-detect touch devices otherwise.
- **Touch assists** (settings, on by default on touch, off on desktop): aim assist (gentle
  slow-down / pull near an enemy under the crosshair - client-side only, it just shapes
  yaw/pitch) and auto-fire when the crosshair is on a visible enemy. Tap-to-jump on the look
  area is optional.
- **Mobile performance**: lower pixel-ratio cap and cheaper effects on touch devices, a
  `quality` setting (low/medium/high), no 300 ms tap delay, fullscreen + orientation lock when
  the browser allows it, the menu and every HUD screen usable at 360x640 and in landscape
  phones (640x360).
- **Settings** (persisted): sensitivity, aim (ADS) sensitivity multiplier, invert Y, FOV,
  volume, quality, crosshair colour and size, show net stats, touch: stick side, button size,
  aim assist, auto-fire. Keep the menu tidy (tabs or collapsible sections).
- **Net stats line** (toggle): fps, ping, and when `net.state.quality` exists its jitter,
  interpolation delay and corrections. Read it defensively - it may be undefined.
- **Name tags**: currently far too big. Small, crisp, constant modest screen size, fade with
  distance, hidden when the player is behind a wall or dead, and never covering the target's
  body. Keep one draw call for all tags.

## Phase B (after phase A)

Order: B1 first, then B2 and B3 in parallel, then B4.

| Agent | Owns |
| --- | --- |
| B1 weapons + loadouts core | `shared/weapons.js`, `shared/physics.js` (speed-multiplier hook only), weapon/loadout parts of `server/room.js`, `server/bots.js`, `shared/protocol.js`, `client/net.js`, `tools/**` except `maps.test.js` |
| B2 modes + lobby (server) | `server/**`, `shared/protocol.js`, `shared/modes.js`, `client/net.js`, `tools/**` except `maps.test.js` |
| B3 weapons client (parallel with B2) | `client/render.js`, `client/audio.js`, `client/hud.js`, `client/style.css`, `client/main.js`, `client/input.js` |
| B4 modes + lobby + maps client (after B2 and B3) | `client/**` except `client/net.js` |

### Modes, lobby, spawns (B2 server, B4 client)

- Teams: `a` and `b`, shown as two colours. Friendly fire off.
- `ffa` free-for-all (today's mode). `tdm` team deathmatch: first team to the kill limit.
  `ctf` capture the flag: touch the enemy flag to carry it, bring it to your own stand while
  your flag is home to score; a carrier who dies drops it; a dropped flag returns when a
  defender touches it or after 20 s; first to 3 captures. `hardpoint`: one active zone from
  `map.hardpoints`, rotating every 60 s; a team scores 1 point per second while it has players
  inside and the other team has none; contested = nobody scores; first to 150.
  Every mode also ends on the time limit; highest score wins.
- Lobby (private rooms): the first player is the host. The lobby shows who is in, and the host
  picks mode, map, bots (off / fill to N / humans-vs-bots co-op), time limit, then starts the
  match. Late joiners enter the running match. After the match: results, then back to the
  lobby. If the host leaves, the next player becomes host. Public rooms have no lobby and
  rotate maps and modes automatically.
- Spawns: never in an enemy's line of sight when any candidate avoids it (ray from each living
  enemy's eyes to the spawn's chest and head), prefer distance from enemies and (team modes)
  the team's home spawns; 1.5 s of spawn protection that ends early when the player fires.
- Bots understand each mode at a basic level (go for the flag / zone, defend, shoot enemies
  only) and fill teams evenly.

### Weapons and loadouts (B1 core, B3 client)

The player still carries three weapons on slots 1/2/3, one per class, but now chooses which
gun fills each slot and customises it. All names are original (no real or game-specific
weapon names); the archetypes are:

| Slot / class | Gun A | Gun B |
| --- | --- | --- |
| 1 Assault | hard-hitting, slower-firing rifle with more kick (the classic "AK" role) | fast-firing, lighter, more accurate rifle |
| 2 Sniper | light bolt-action: quick to aim, two body shots or one headshot (today's scout) | heavy rifle: slow and loud, one shot to the body at full health |
| 3 Shotgun | pump shotgun: big single blasts | full-auto, hip-fire close-range bullet hose with a large magazine |

**Attachments:** six in total, one per area, and a gun can mount **at most three**. Every
attachment is clearly good at one thing and has a real cost, so no build is best at everything:

| Attachment | Area | Good at | Cost |
| --- | --- | --- | --- |
| Optic | sight | more zoom, tighter aimed spread | slower to aim, slower while aiming |
| Extended mag | magazine | about +50% rounds | slower reload |
| Heavy rounds | ammunition | more damage per hit | lower fire rate |
| Long barrel | barrel | more range before damage falloff, tighter hip spread | slower movement |
| Light stock | stock | faster movement and faster aiming | more spread |
| Quick hands | grip | faster reload and weapon swap | smaller magazine |

Exact numbers are the agent's to tune per class (an optic on a shotgun should still make
sense). Add distance damage falloff per gun. A loadout is therefore: for each of the 3 slots,
gun A or B plus a set of up to 3 attachments - it must serialise to a few bytes.

Rules for the core (B1):
- `shared/weapons.js` stays pure and deterministic and remains the single source of truth:
  gun table, attachment table, `sanitizeLoadout` (drops unknown ids, enforces the 3 limit),
  effective stats for (slot, gun, attachments), and weapon-state functions that take the
  player's loadout. Fixed-size weapon-state serialisation.
- Movement speed depends on the equipped gun and its attachments: `stepPlayer` must take that
  multiplier from the caller instead of looking it up from the gun table itself.
- The server validates and stores each player's loadout (sent on join and whenever the player
  edits it); a change applies at that player's next spawn. Other players learn each player's
  guns (for models and sounds) through the roster or snapshot.
- The client predicts with its own active loadout, bit-exact with the server as today.
- Bots get varied sensible loadouts.

Client (B3): a Loadout tab in the menu (pick the gun per slot, toggle attachments with the
3-limit and a live stat comparison showing gains and costs), six distinct first-person
viewmodels and third-person guns built from boxes, attachment visuals where cheap (optic,
long barrel, extended mag), a scope overlay whenever an optic or sniper is aimed, synthesised
sounds per gun, touch-friendly throughout.
