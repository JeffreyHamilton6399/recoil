# RECOIL

A 2-player online arena duel. You can't walk: the only way to move is to shoot,
and every shot kicks you backwards. Hits knock your opponent back harder the
more damage they've taken. The ice keeps shrinking. Knock your rival off the
edge to win the round. First to 5 wins the match.

- TypeScript everywhere, Vite for the client, Node 20+ for the server
- Canvas 2D only: every visual is drawn in code and every sound is synthesized
  with WebAudio. There are no asset files.
- Server-authoritative 30 Hz simulation over WebSockets (`ws`). The same
  `shared/sim.ts` code is used by the server and client.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5173 in two browser tabs. Click **Create game** in one tab,
then paste the link (or type the 4-letter code) into the other.

To test on your phone, connect it to the same Wi-Fi and open the `Network:` URL
that Vite prints, for example `http://192.168.1.20:5173`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Game server on :3000 plus the Vite dev server on :5173 (which proxies `/ws`) |
| `npm test` | Headless simulation test: 1000 random ticks, a scripted duel, and full matches |
| `npm run typecheck` | Type-checks the client, server and shared code |
| `npm run build` | Builds the client to `dist/client` and the server to `dist/server` |
| `npm start` | Serves the built game (client and WebSocket) on one port, `$PORT` or 3000 |

## Controls

| | Keyboard | Touch |
| --- | --- | --- |
| Aim | `A` / `D` or `←` / `→` | ◀ ▶ buttons, bottom left |
| Charge and fire | Hold `Space`, `W` or `↑`, then release | Hold the big FIRE button, then release |
| Mute | `M` | Speaker icon, top right |

## Project layout

```
shared/   constants.ts (all tuning values), types.ts, sim.ts (the simulation), sim.test.ts
server/   index.ts: HTTP static server, rooms, 30 Hz fixed-step loop
client/   main.ts (network, interpolation, prediction), render.ts, input.ts,
          audio.ts, ui.ts, net.ts, index.html
```

To change how the game feels, edit `shared/constants.ts`. Every value there
has a comment.

## Deploy

RECOIL needs a host that keeps a Node process running with WebSockets, so
Vercel and Netlify won't work: their serverless functions can't hold a
WebSocket open. Render, Railway and Fly.io all work. On **Render**, push this
repo to GitHub, choose **New → Blueprint**, and pick the repo. The included
`render.yaml` sets the build command (`npm install --include=dev && npm run
build`), the start command (`npm start`) and a `/health` check. The free plan
works, but the service sleeps when idle, so the first visit takes about 30
seconds to wake it. On **Railway**, choose **New Project → Deploy from GitHub
repo**. It detects Node and runs `npm run build` and then `npm start`. Then
under **Settings → Networking**, click **Generate Domain**. On **Fly.io**, run
`fly launch` and accept the Node defaults. Every platform provides `PORT`, and
the server uses it automatically. Rooms are kept in memory, so run a single
instance.
