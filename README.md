# RECOIL

A first-person online party brawler for 2 to 8 players, played in the
browser. Sprint, slide, climb and jump around a rooftop, and knock everyone
else off it. Every hit sends people flying, and hits knock them back harder the more damage they've taken, and
the roof keeps shrinking. The last player standing wins the round, and the
first to 5 round wins takes the match.

- **Quick play:** jump into a public room with anyone online. It starts by
  itself 20 seconds after a second player arrives, on a random map every
  round.
- **Private games:** share a 4-letter code or a link. The host picks the map
  from a carousel (or picks Random for a new map every round) and starts the
  match.
- **No-jump rule:** the host of a private game can switch off jumping, so
  recoil mode (`R`) is the only way up.
- **Rooms** hold up to 8 players plus spectators. You can warm up in the
  lobby while you wait, and pick a name and colour.
- **12 rooftop maps:** Helipad, Skylight, Arcade Roof, The Block,
  Vent Farm, Chimneys, Hex Plaza, Billboard, Sky Garden, Split Level, Parking
  Deck, and Solar Farm. Arenas can be circles, squares, hexagons, or diamonds,
  with open vents to fall through, bouncy pillars, obstacles and jump pads.
- **Movement:** run, sprint, slide (tap Ctrl while moving; jump out of a
  slide to keep the speed), aim down sights (the Longshot has a scope), and climb any ledge up to 2.7 m by jumping into it.
  Jump pads launch you into the air.
- **Five weapons**, picked in the lobby (click a card or press 1 to 5):
  - **Revolver:** every click is a solid shove. The all-rounder.
  - **Scatter:** a pump shotgun. Brutal up close.
  - **Longshot:** a bolt-action sniper. Slow, but one clean hit sends them flying.
  - **Boomer:** lobs bombs that burst on impact and blast everyone nearby.
  - **Pepper:** an SMG. Hold the trigger for a stream of little pokes.
- **Obstacles on every map:** crates, AC units, water tanks and brick walls to
  climb, stand on and hide behind.
- **Power-ups:** Rapid Fire, Triple Shot, Mega Shot, Shield, and Heal.
- **Hand-drawn toon look, all made in code with three.js:** a post-processing
  pass inks the whole frame like a comic panel. Outlines come from depth and
  colour edges and "boil" at 12 fps like redrawn animation, with pencil
  hatching in the shadows and paper grain. Cel-shaded players, sketchy props,
  a painted dusk sky over a lit-up city, and comic "POW!" words on big hits.
  There are no asset files.
- **Voice chat:** click the mic button (top right) to switch between off,
  push-to-talk (hold `V`) and open mic. You hear everyone from where they
  stand on the roof, a speaker badge shows who's talking, and anyone can be
  muted from the lobby. Audio goes peer to peer over WebRTC; the game server
  only relays the connection setup. It uses Google's public STUN servers, so
  a few very strict networks (some offices and schools) may not connect.
- **Crisp WebAudio sound, all synthesized:** UI clicks, shots, hits, jumps,
  bumper boings, and a jingle for each power-up.
- **Netcode:** a server-authoritative 30 Hz simulation over WebSockets
  (`ws`). Your own movement is predicted in the browser with the same
  `shared/sim.ts` code the server runs, then corrected by replaying unconfirmed
  inputs on each server snapshot, so it feels instant even with lag. Other
  players are interpolated.

## Bots and offhands

- **Bots:** in a private room, the host can add **Easy**, **Medium**, or
  **Hard** bots from the lobby. Bots play by exactly the same rules as
  people. They pick targets, keep their weapon's range, strafe, lead their
  shots, dodge, use their offhand, and stay away from the edge. Harder bots
  react faster, aim better, and fight smarter. In quick play, bots fill the
  room if you're alone for a few seconds, and they leave as people join.
- **Offhand (E):** pick one in the lobby.
  - **Knife:** press E to pull it out, then slash as often as you like; a big shove up close.
  - **Shock grenade:** a thrown grenade that bounces, then bursts into a
    shockwave that throws everyone nearby. You can also grenade-jump with it.

## Structures

Roofs are bigger (38 m radius) and some have buildings on them. You can run
through doorways, walk up ramps onto rooftops, cross bridges, and duck
under carports. Blocks can float (roofs, bridges), and ramps are walkable
slopes; both are set in `shared/maps.ts` using the `hut`, `pergola`, `slab`,
and `ramp` helpers. Bots find their way around walls and through doorways
(A* over a walk grid in `shared/nav.ts`), climb ramps to hold the high
ground with long guns, and chase players who camp on roofs.

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
| Sprint | Hold `Shift` | Push the stick all the way forward |
| Slide | `Ctrl` or `C` while moving | SLIDE button |
| Aim down sights | Hold the right mouse button (or `Q`) | AIM button (toggles) |
| Look | Mouse (click the game to play: it goes fullscreen and captures the mouse; hold `Esc` to let go) | Drag anywhere |
| Jump / climb | `Space` (into a ledge to climb it) | JUMP button |
| Fire | Left mouse button (or `F`): one shot per click, or hold for the Pepper | FIRE button |

Playing with the mouse goes fullscreen with the keyboard locked (Chrome and
Edge), so Ctrl+W while sliding forward can't close the tab. Other browsers ask
before leaving the page instead.
| Pick a weapon | Click a card in the lobby, or `1` to `5` | Tap a card |
| Knife | `E`, the mouse wheel, or `1`/`2` to swap gun and knife; fire to slash (as often as you like) | E button |
| Recoil mode | `R`: your shots throw you backwards hard, to fly back onto the roof | RCL button |
| Voice chat | In the menu (Esc); hold `V` to talk in push-to-talk | In the menu |
| Menu | `Esc`: room code and link, volume, mouse sensitivity, voice chat, ping, leave | ☰ button, top left |
| Mute | `M` | In the menu |

## Project layout

```
shared/   constants.ts (all tuning values), maps.ts (map layouts, obstacles,
          jump pads), weapons.ts, types.ts, sim.ts (the simulation), sim.test.ts
server/   index.ts: HTTP static server, rooms, 30 Hz fixed-step loop
client/   main.ts (network, prediction, interpolation), scene.ts (three.js),
          ink.ts (the hand-drawn pass), guns.ts, props.ts, toon.ts, hud.ts,
          voice.ts (WebRTC voice chat),
          art.ts, surfaces.ts, input.ts, audio.ts, ui.ts, net.ts, index.html
```

To change how the game feels, edit `shared/constants.ts` (movement, arena,
rounds) and `shared/weapons.ts` (each gun's stats). Every value has a comment.

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
