# RECOIL

A first-person online party brawler for 2 to 8 players, played in the
browser. Run and jump around a rooftop, and knock everyone else off it. Every
shot kicks you backwards, so shoot the floor to rocket-jump or shoot behind you
to boost. Hits knock people back harder the more damage they've taken, and the
roof keeps shrinking. The last player standing wins the round, and the first to
5 round wins takes the match.

- **Quick play:** jump into a public room with anyone online. It starts by
  itself 20 seconds after a second player arrives, and a spinner picks a
  random map every round.
- **Private games:** share a 4-letter code or a link. The host picks the map
  from a carousel (or picks Random for the spinner) and starts the match.
- **Rooms** hold up to 8 players plus spectators. You can warm up in the
  lobby while you wait, and pick a name and colour.
- **12 rooftop maps:** Helipad, Skylight, Arcade Roof, The Block,
  Vent Farm, Chimneys, Hex Plaza, Billboard, Sky Garden, Split Level, Parking
  Deck, and Solar Farm. Arenas can be circles, squares, hexagons, or diamonds,
  with open vents to fall through and bouncy pillars.
- **Charged shots:** hold to charge, release to fire. A full charge is a big,
  fast shot with heavy knockback and heavy recoil.
- **Power-ups:** Rapid Fire, Triple Shot, Mega Shot, Shield, and Heal.
- **3D comic look, all made in code with three.js:** cel-shaded players with
  ink outlines, a city at dusk with lit windows, each map's rooftop art,
  hazard stripes that pulse while the roof shrinks, and comic "POW!" words on
  big hits. There are no asset files.
- **Crisp WebAudio sound, all synthesized:** UI clicks, shots, hits, jumps,
  bumper boings, and a jingle for each power-up.
- **Netcode:** a server-authoritative 30 Hz simulation over WebSockets
  (`ws`). Your own movement is predicted in the browser with the same
  `shared/sim.ts` code the server runs, then corrected by replaying unconfirmed
  inputs on each server snapshot, so it feels instant even with lag. Other
  players are interpolated.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5173 in two browser tabs. Click **Create private game** in one tab,
then paste the link (or type the 4-letter code) into the others. With 2 or more
players in the room, the host can press **Start match**.

To test on your phone, connect it to the same Wi-Fi and open the `Network:` URL
that Vite prints, for example `http://192.168.1.20:5173`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Game server on :3000 plus the Vite dev server on :5173 (which proxies `/ws`) |
| `npm test` | Headless simulation test: random ticks, a scripted duel, full matches, movement, and prediction |
| `npm run typecheck` | Type-checks the client, server and shared code |
| `npm run build` | Builds the client to `dist/client` and the server to `dist/server` |
| `npm start` | Serves the built game (client and WebSocket) on one port, `$PORT` or 3000 |

## Controls

| | Keyboard | Touch |
| --- | --- | --- |
| Move | `W` `A` `S` `D` or arrow keys | Stick, bottom left |
| Look | Mouse (click the game to capture it, `Esc` to let go) | Drag anywhere |
| Jump | `Space` | JUMP button |
| Charge and fire | Hold the left mouse button (or `F`), then release | Hold the big FIRE button, then release |
| Mute | `M` | Speaker icon, top right |

## Project layout

```
shared/   constants.ts (all tuning values), maps.ts (map layouts), types.ts,
          sim.ts (the simulation), sim.test.ts
server/   index.ts: HTTP static server, rooms, 30 Hz fixed-step loop
client/   main.ts (network, prediction, interpolation), scene.ts (three.js),
          hud.ts, art.ts, surfaces.ts, input.ts, audio.ts, ui.ts, net.ts,
          index.html
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
