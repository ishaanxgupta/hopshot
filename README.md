# Hopshot

An original browser arena FPS prototype: slide-hop movement, hitscan guns, free-for-all
deathmatch, up to 20 players per room on an authoritative server.

## Run locally

    npm install
    npm start

Then open http://localhost:3000. `npm test` runs the physics suite, `node tools/client.test.js`
the netcode test, and `npm run loadtest -- --spawn --port 3101` a 20-client load test.

## Play with friends

Click **Create private room** in the menu and share the invite link. Everyone who opens it
joins the same room.

## Hosting

One Node process serves the page and the WebSocket (`/ws`), so it needs a host that runs a
long-lived Node server with WebSockets. `render.yaml` describes a free Render web service
(build `npm install`, start `npm start`, health check `/health`). The server reads `PORT`;
`BOTS` sets the bot fill level for public rooms (default 4, `0` disables).

## Optional long-term memory (AI bots + suggestions)

Off by default; with it off the game behaves exactly as without it (no network calls, no AI
bots, no suggestions). When on, it is powered by [Supermemory](https://supermemory.ai):

| Variable | Meaning |
| --- | --- |
| `MEMORY_ENABLED` | `1` turns it on (needs `SUPERMEMORY_API_KEY`, or `SUPERMEMORY_MOCK=1`) |
| `SUPERMEMORY_API_KEY` | Supermemory API key. Only read from the environment; never logged |
| `SUPERMEMORY_MOCK` | `1` = in-process mock store instead of the API (offline tests) |
| `MEMORY_TAG_PREFIX` | container tag prefix, default `hopshot_player_` (tests use `hopshot_dev_test_...`) |

A `.env` file in the project root is loaded at start when present (it is git-ignored). On Render,
set the variables in the service's Environment settings instead.

What it adds:

- **Player code** (Settings): a random secret kept in the browser is the only identity. The server
  hashes it into the player's Supermemory container tag and never stores or shows the code. Copy
  it to play on another device; clearing browser data without saving it loses your history.
- **AI bots** (lobby bot level "AI"): adapt to each human opponent (aiming, reaction, sight range,
  ... between Easy and a little above Hard, so fights against them settle near a 1.0 K/D) and
  remember who beat them (grudges change who they target and hunt, nothing is shown).
- **Suggestions**: a mode + map for the host's group, one personal lobby tip and one Loadout tip,
  only when there is enough recorded history.

At the end of each match the server writes one summary per human (instant ingestion, with the
player's entity context) plus a small structured state document; on join it reads the state and
runs a few hybrid searches. Tests: `npm run test:memory` (offline, mock), `npm run test:memory:live`
(real API, `hopshot_dev_test_` tags only), `npm run test:memory:browser` (headless Chrome; `-- --live`
for the real API). Code: `server/memory/`.

See `ARCHITECTURE.md` for how the pieces fit together.
