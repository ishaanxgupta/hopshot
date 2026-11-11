# Handoff: finishing Hopshot phase 2 without the user's laptop

The user is asleep with the laptop off and chose: **keep building in the cloud and deploy to
the live game as soon as automated tests pass.** Read `PHASE2.md` (the contract) and
`ARCHITECTURE.md` first.

## Where things stand

- Live game: https://hopshot.onrender.com (Render free web service, Singapore, auto-deploys on
  every push to `main`). `main` = batch 1 (lag fix, touch controls, settings, map registry,
  small name tags), verified live.
- This branch `phase2-wip` = `main` + a **half-finished** guns/loadouts core (agent "B1" in
  PHASE2.md was stopped mid-task). Never push this branch's state to `main` until it passes
  the gate below.
- B1 state when stopped: `shared/weapons.js` rewritten (6 guns, 6 attachments, loadouts,
  effective stats, display stats), `shared/physics.js` speed-multiplier hook, protocol v3,
  loadout handling in `server/room.js` / `server/index.js` / `server/bots.js`, loadout +
  prediction in `client/net.js`, new `tools/weapons.test.js` and `tools/weapons.report.js`.
  It was about to update `tools/client.test.js` (per-client loadouts, exact prediction) and
  had NOT yet run the full test suite or the load test, and had not reported its balance
  numbers. Everything parses, the physics suite passes, the server boots.

## Remaining work, in order

1. **Finish B1** (guns core): review the diff against the B1 rules in PHASE2.md, finish the
   client test, get every test green, check the balance report makes sense.
2. **B3** (weapons client): Loadout tab in the menu with the 3-attachment limit and live stat
   comparison, six first-person viewmodels and third-person guns, attachment visuals, scope
   overlay, sounds per gun, touch-friendly. Files: `client/*` except `client/net.js`.
3. **Deploy guns** (gate below), then verify the live site.
4. **B2** (server): game modes (ffa, tdm, ctf, hardpoint), lobby for private rooms with host
   controls and humans-vs-bots co-op, map selection per room from `shared/maps`, spawns out of
   enemy line of sight with 1.5 s spawn protection, mode-aware bots.
5. **B4** (client): lobby UI, mode HUD (team scores, flag and zone indicators), renderer map
   switching and per-map `theme`, team colours, name-tag rules for teams, all touch-friendly.
   Also fix: the net-stats line overlaps the round timer on narrow windows.
6. **Deploy batch 2** (same gate), verify live.

The user asked for Opus agents for the hard engineering (netcode, server, rules) and Sonnet
agents for presentation work; use subagents the same way if they are available, with disjoint
file ownership per agent as in PHASE2.md.

## Deploy gate - all of these, every time

- `node tools/physics.test.js`, `node tools/maps.test.js`, `node tools/weapons.test.js`
- `node tools/client.test.js --port 3109` (all four link profiles; clean profile must show 0
  position corrections)
- `node tools/loadtest.js --spawn --port 3101 --clients 20 --duration 15` (no tick overruns,
  p99 in the low milliseconds)
- `node --check` on every JS file, and the server must boot and answer `/health`
- **A real browser smoke test.** There is no built-in browser pane in the cloud, so use a
  headless browser if one can be installed (e.g. Playwright Chromium): load the game against
  a local server with `?autoplay=1`, wait ~15 s, and require `window.__hopshot.connected`,
  zero console errors, and kills/hits counters increasing; also load `/?touch=1` at 740x360
  and the plain menu, open every menu tab, and check for console errors. If no headless
  browser can be run, do NOT deploy client UI changes blind - leave them on the branch, open
  a pull request, and say so clearly in the final message.

To deploy: fast-forward `main` to the tested commit and push `main` (that triggers Render).
Then wait for `https://hopshot.onrender.com/health`, confirm the new `PROTOCOL_VERSION` is
served at `/shared/protocol.js`, and run a short remote check
(`node tools/loadtest.js --url https://hopshot.onrender.com --clients 4 --duration 10`).
If the live site is broken after a deploy, revert `main` to the previous good commit
(batch 1 is `f5948ed`) and push. If pushing to `main` is not permitted from the cloud, open a
pull request instead and say that the deploy needs the user's merge.

## Things to know

- No build step, no new runtime dependencies (a headless browser for testing is a dev-only
  tool: do not add it to `package.json`).
- Render free tier: 0.1 CPU, sleeps after ~15 idle minutes. Every deploy restarts the server
  and ends running matches - fine overnight.
- Original game only: original gun and map names, no assets or names from existing games.
- The user's last explicit choices: second shotgun = full-auto hip-fire close-range hose;
  three weapon slots by class (assault / sniper / shotgun) with gun A or B per slot; six
  attachments, max three per gun, each with a real cost.
- Finish with a short, honest summary for the user: what is live, what was verified and how,
  what was not, and anything left on a branch.
