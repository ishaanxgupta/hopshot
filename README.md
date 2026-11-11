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

See `ARCHITECTURE.md` for how the pieces fit together.
