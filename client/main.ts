// RECOIL client entry point: connection, snapshot interpolation, own-aim
// prediction, event playback (effects and sound) and the render loop.

import * as C from '../shared/constants.js';
import { angleDiff, clamp, lerp, wrapAngle } from '../shared/sim.js';
import type { GameEvent, InputState, PlayerIndex, PlayerSnap, ServerMessage, Snapshot } from '../shared/types.js';
import { ROOM_CODE_PATTERN } from '../shared/types.js';
import { Sfx } from './audio.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { Renderer, type View, type ViewBullet, type ViewPlayer } from './render.js';
import { UI } from './ui.js';

// ---------------------------------------------------------------------------
// Identity: one id per browser tab, kept across reloads so you can rejoin.
// ---------------------------------------------------------------------------

function tabId(): string {
  const make = (): string => Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    const existing = sessionStorage.getItem('recoil-id');
    if (existing) return existing;
    const id = make();
    sessionStorage.setItem('recoil-id', id);
    return id;
  } catch {
    return make();
  }
}
const CLIENT_ID = tabId();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The room we're in, or trying to (re)join. */
let roomCode: string | null = null;
let wantCreate = false;
let mySlot: PlayerIndex | -1 = -1;
let lostAt = 0; // when the connection dropped while in a room (ms), 0 if connected
let connectedOnce = false; // false until the first successful connection

const snaps: Snapshot[] = [];
let clockOffset: number | null = null; // local seconds minus server seconds
let renderTime = 0; // server time we are currently drawing (seconds)
let hitStopUntil = 0;
const pendingEvents: { time: number; ev: GameEvent }[] = [];

let predictedAim: number | null = null;
let lastLatestPhase: Snapshot['ph'] | null = null;
let fireHeldSince: number | null = null; // local charge prediction (seconds)

let pingMs: number | null = null;
let lastCountdown = -1;
let lastShrinkSecond = -1;
let lastPhaseSeen: Snapshot['ph'] | null = null;

const nowSec = (): number => performance.now() / 1000;

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const sfx = new Sfx();

const ui = new UI({
  onCreate: () => {
    sfx.unlock();
    ui.setMenuError('');
    wantCreate = true;
    roomCode = null;
    if (net.isOpen) sendHello();
    else net.connect();
  },
  onJoin: (code) => {
    sfx.unlock();
    joinRoom(code);
  },
  onLeave: () => leaveToMenu(''),
  onRematch: () => net.send({ t: 'rematch' }),
  onToggleMute: () => {
    sfx.unlock();
    ui.setMuted(sfx.toggleMute());
  },
});
ui.setMuted(sfx.isMuted);

const input = new Input(ui.touchButtons);
input.onTouchDetected = () => {
  ui.enableTouch();
  refreshLayout();
};
input.onChange = (s: InputState) => {
  sfx.unlock();
  const t = nowSec();
  if (s.firing && fireHeldSince === null) fireHeldSince = t;
  if (!s.firing && fireHeldSince !== null) {
    onLocalRelease(t);
    fireHeldSince = null;
  }
  sendInput();
};

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !(e.target instanceof HTMLInputElement)) ui.setMuted(sfx.toggleMute());
});
for (const type of ['pointerdown', 'keydown', 'touchend'] as const) {
  window.addEventListener(type, () => sfx.unlock(), { passive: true });
}

const net = new Net({
  onOpen: () => {
    connectedOnce = true;
    lostAt = 0;
    sendHello();
  },
  onClose: () => {
    pingMs = null;
    ui.setPing(null);
    if (!connectedOnce) {
      // Never reached the server at all: say so instead of silently retrying.
      if (roomCode || wantCreate) leaveToMenu("Can't reach the game server. Try again in a moment.");
      return;
    }
    if (!roomCode) return;
    // Lost the connection mid-game: keep trying for the rejoin window.
    if (lostAt === 0) lostAt = performance.now();
    if (performance.now() - lostAt > C.REJOIN_WINDOW * 1000) {
      leaveToMenu('Lost connection to the server.');
      return;
    }
    ui.setBanner('Connection lost. Reconnecting…');
    window.setTimeout(() => {
      if (roomCode) net.connect();
    }, 1500);
  },
  onMessage: handleMessage,
});

function sendHello(): void {
  if (wantCreate) {
    wantCreate = false;
    net.send({ t: 'create', id: CLIENT_ID });
  } else if (roomCode) {
    net.send({ t: 'join', code: roomCode, id: CLIENT_ID });
  }
}

function sendInput(): void {
  if (mySlot === -1) return;
  const s = input.state;
  net.send({ t: 'input', l: s.aimLeft, r: s.aimRight, f: s.firing });
}

function joinRoom(code: string): void {
  roomCode = code;
  ui.setMenuError('');
  if (net.isOpen) sendHello();
  else net.connect();
}

function resetRoomState(): void {
  snaps.length = 0;
  pendingEvents.length = 0;
  clockOffset = null;
  predictedAim = null;
  lastLatestPhase = null;
  lastPhaseSeen = null;
  lastCountdown = -1;
  mySlot = -1;
}

function leaveToMenu(error: string): void {
  if (roomCode) net.send({ t: 'leave' });
  roomCode = null;
  wantCreate = false;
  lostAt = 0;
  resetRoomState();
  history.replaceState(null, '', '/');
  ui.showMenu(error);
  refreshLayout();
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function handleMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case 'joined':
      resetRoomState();
      roomCode = msg.code;
      mySlot = msg.slot;
      history.replaceState(null, '', `/?room=${msg.code}`);
      ui.setBanner(null);
      sendInput();
      break;
    case 'error':
      leaveToMenu(msg.msg);
      break;
    case 'closed':
      roomCode = null; // the server already dropped us from the room
      leaveToMenu(msg.msg);
      break;
    case 'pong': {
      const rtt = performance.now() - msg.c;
      pingMs = pingMs === null ? rtt : lerp(pingMs, rtt, 0.3);
      ui.setPing(pingMs);
      break;
    }
    case 'snap':
      onSnapshot(msg);
      break;
  }
}

function onSnapshot(s: Snapshot): void {
  if (!roomCode) return;
  const serverTime = s.k * C.TICK_DT;
  const sample = nowSec() - serverTime;
  // Track the earliest arrival: late packets are jitter, not clock drift.
  if (clockOffset === null || Math.abs(sample - clockOffset) > 1) {
    clockOffset = sample;
    renderTime = serverTime - C.INTERP_DELAY;
  } else if (sample < clockOffset) {
    clockOffset = lerp(clockOffset, sample, 0.5);
  } else {
    clockOffset = lerp(clockOffset, sample, 0.01);
  }

  snaps.push(s);
  if (snaps.length > 30) snaps.splice(0, snaps.length - 30);
  for (const ev of s.e) pendingEvents.push({ time: serverTime, ev });

  // UI that follows the newest state, not the interpolated one.
  if (s.ph === 'waiting' && mySlot !== -1) ui.showLobby(roomCode);
  else ui.showGame(roomCode, mySlot !== -1);
  refreshLayout();

  const opp: PlayerIndex | -1 = mySlot === -1 ? -1 : mySlot === 0 ? 1 : 0;
  if (lostAt === 0) {
    if (s.cl >= 0 && opp !== -1 && s.sl[opp] === 2) ui.setBanner(`Opponent disconnected, waiting… ${s.cl}s`);
    else if (s.cl >= 0) ui.setBanner(`A player disconnected, waiting… ${s.cl}s`);
    else ui.setBanner(null);
  }
  ui.setMatchEnd(s.ph === 'matchEnd', mySlot !== -1, mySlot !== -1 && s.rm[mySlot], opp !== -1 && s.rm[opp]);
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

function toViewPlayer(p: PlayerSnap): ViewPlayer {
  return { x: p[0], y: p[1], aim: p[2], charge: p[3], damage: p[4], fallTime: p[5] };
}

function lerpPlayer(a: PlayerSnap, b: PlayerSnap, t: number): ViewPlayer {
  // A player who just started falling has no fall time in `a`.
  const fall = b[5] < 0 ? -1 : a[5] < 0 ? b[5] * t : lerp(a[5], b[5], t);
  return {
    x: lerp(a[0], b[0], t),
    y: lerp(a[1], b[1], t),
    aim: a[2] + angleDiff(a[2], b[2]) * t,
    charge: lerp(a[3], b[3], t),
    damage: b[4],
    fallTime: fall,
  };
}

function viewAt(time: number): View | null {
  if (snaps.length === 0) return null;
  let a = snaps[0];
  let b = snaps[0];
  let t = 0;
  const last = snaps[snaps.length - 1];
  if (time >= last.k * C.TICK_DT) {
    a = b = last;
  } else if (time > a.k * C.TICK_DT) {
    for (let i = 0; i < snaps.length - 1; i++) {
      const ta = snaps[i].k * C.TICK_DT;
      const tb = snaps[i + 1].k * C.TICK_DT;
      if (time >= ta && time < tb) {
        a = snaps[i];
        b = snaps[i + 1];
        t = (time - ta) / (tb - ta);
        break;
      }
    }
  }
  // Don't slide players across the ice when a new round resets them.
  if (a.ph !== b.ph && b.ph === 'countdown') a = b;

  const bulletsA = new Map(a.b.map((x) => [x[0], x]));
  const bullets: ViewBullet[] = [];
  const span = Math.max(C.TICK_DT, (b.k - a.k) * C.TICK_DT);
  for (const bb of b.b) {
    const ba = bulletsA.get(bb[0]);
    if (!ba) continue; // spawns between snapshots appear on the next one
    bullets.push({
      id: bb[0],
      owner: bb[1],
      x: lerp(ba[2], bb[2], t),
      y: lerp(ba[3], bb[3], t),
      r: bb[4],
      vx: (bb[2] - ba[2]) / span,
      vy: (bb[3] - ba[3]) / span,
    });
  }

  const phaseTime = a === b ? a.pt : a.ph === b.ph ? lerp(a.pt, b.pt, t) : a.pt;
  return {
    phase: a.ph,
    phaseTime,
    arenaRadius: lerp(a.r, b.r, t),
    shrinking: a.ph === 'playing' && a.r > C.ARENA_END_RADIUS + 1e-3,
    players: [lerpPlayer(a.p[0], b.p[0], t), lerpPlayer(a.p[1], b.p[1], t)],
    bullets,
    scores: a.s,
    roundResult: a.rr,
    matchWinner: a.mw,
    slots: b.sl,
    mySlot,
    attract: false,
  };
}

/** The idle scene behind the menu. */
function attractView(time: number): View {
  const p0 = toViewPlayer([-C.SPAWN_DISTANCE, 0, Math.sin(time * 0.9) * 0.6, 0, 0, -1]);
  const p1 = toViewPlayer([C.SPAWN_DISTANCE, 0, Math.PI + Math.sin(time * 0.7 + 1) * 0.6, 0, 0, -1]);
  return {
    phase: 'waiting',
    phaseTime: 0,
    arenaRadius: C.ARENA_START_RADIUS,
    shrinking: false,
    players: [p0, p1],
    bullets: [],
    scores: [0, 0],
    roundResult: null,
    matchWinner: null,
    slots: [1, 1],
    mySlot: -1,
    attract: true,
  };
}

// ---------------------------------------------------------------------------
// Local prediction: own aim (and charge, for instant visual/audio feedback)
// ---------------------------------------------------------------------------

function localCharge(t: number): number {
  return fireHeldSince === null ? 0 : clamp((t - fireHeldSince) / C.CHARGE_TIME, 0, 1);
}

function canControl(latest: Snapshot | undefined): boolean {
  if (!latest || mySlot === -1) return false;
  return (latest.ph === 'countdown' || latest.ph === 'playing') && latest.p[mySlot][5] < 0;
}

function onLocalRelease(t: number): void {
  const latest = snaps[snaps.length - 1];
  if (!canControl(latest) || latest.ph !== 'playing' || mySlot === -1) return;
  // Play the shot sound right away; the server's fire event adds the visuals.
  sfx.fire(localCharge(t), panFor(latest.p[mySlot][0]));
}

function updatePrediction(dt: number, view: View): void {
  const latest = snaps[snaps.length - 1];
  if (mySlot === -1 || !latest) {
    predictedAim = null;
    return;
  }
  const serverAim = latest.p[mySlot][2];
  if (predictedAim === null || !canControl(latest) || (latest.ph !== lastLatestPhase && latest.ph === 'countdown')) {
    predictedAim = serverAim;
  } else {
    const dir = (input.state.aimRight ? 1 : 0) - (input.state.aimLeft ? 1 : 0);
    if (dir !== 0) predictedAim = wrapAngle(predictedAim + dir * C.AIM_SPEED * dt);
    else predictedAim = wrapAngle(predictedAim + angleDiff(predictedAim, serverAim) * Math.min(1, dt * C.AIM_CORRECTION_RATE));
  }
  lastLatestPhase = latest.ph;

  const me = view.players[mySlot];
  if (canControl(latest)) {
    me.aim = predictedAim;
    if (latest.ph === 'playing') me.charge = localCharge(nowSec());
  }
}

// ---------------------------------------------------------------------------
// Events, sound cues and the frame loop
// ---------------------------------------------------------------------------

function panFor(x: number): number {
  return clamp(x / C.ARENA_START_RADIUS, -1, 1) * 0.7;
}

function playEvent(ev: GameEvent, view: View): void {
  const heavy = renderer.onEvent(ev, view.players);
  if (heavy) hitStopUntil = nowSec() + C.HIT_STOP_TIME;
  switch (ev.k) {
    case 'fire':
      if (ev.p !== mySlot) sfx.fire(ev.c, panFor(ev.x));
      break;
    case 'hit':
      sfx.hit(ev.f, panFor(ev.x));
      break;
    case 'cancel':
      sfx.cancel(panFor(ev.x));
      break;
    case 'bump':
      sfx.bump(ev.f, panFor(ev.x));
      break;
    case 'fall':
      sfx.whoosh(panFor(ev.x));
      break;
    case 'ko':
      sfx.ko(mySlot === -1 || ev.w === mySlot);
      break;
  }
}

function soundCues(view: View): void {
  if (view.phase === 'countdown') {
    const n = Math.max(1, Math.ceil(C.COUNTDOWN_TIME - view.phaseTime));
    if (n !== lastCountdown) sfx.countdown(n);
    lastCountdown = n;
  } else {
    if (lastCountdown !== -1 && view.phase === 'playing') sfx.countdown(0);
    lastCountdown = -1;
  }

  if (view.shrinking) {
    const sec = Math.floor(view.phaseTime);
    if (sec !== lastShrinkSecond && sec > 0) sfx.shrinkTick();
    lastShrinkSecond = sec;
  } else {
    lastShrinkSecond = -1;
  }

  if (view.phase === 'matchEnd' && lastPhaseSeen !== 'matchEnd' && lastPhaseSeen !== null) {
    sfx.matchWin(mySlot === -1 || view.matchWinner === mySlot);
  }
  lastPhaseSeen = view.phase;

  for (const i of [0, 1] as const) {
    const p = view.players[i];
    const mine = i === mySlot;
    sfx.setCharge(i, view.phase === 'playing' && p.fallTime < 0 ? p.charge : 0, panFor(p.x), mine ? 1 : 0.45);
  }
}

function refreshLayout(): void {
  renderer.setInsets(ui.insets());
}

let lastFrame = nowSec();
function frame(): void {
  const now = nowSec();
  const dt = Math.min(0.1, now - lastFrame);
  lastFrame = now;
  const frozen = now < hitStopUntil;

  let view: View;
  if (roomCode && clockOffset !== null && snaps.length > 0) {
    const target = now - clockOffset - C.INTERP_DELAY;
    if (!frozen) renderTime += dt;
    if (Math.abs(target - renderTime) > 0.5) renderTime = target;
    else if (!frozen) renderTime += (target - renderTime) * Math.min(1, dt * 3);

    const current = viewAt(renderTime);
    view = current ?? attractView(now);
    // Fire effects and sounds when the interpolated time reaches them.
    while (pendingEvents.length > 0 && pendingEvents[0].time <= renderTime + 1e-6) {
      const item = pendingEvents.shift();
      if (item && renderTime - item.time < 1) playEvent(item.ev, view);
    }
    updatePrediction(dt, view);
    soundCues(view);
    // Drop snapshots we'll never interpolate from again.
    while (snaps.length > 2 && snaps[1].k * C.TICK_DT < renderTime - 0.5) snaps.shift();
  } else {
    view = attractView(now);
    sfx.setCharge(0, 0, 0, 0);
    sfx.setCharge(1, 0, 0, 0);
  }

  renderer.draw(view, frozen ? 0 : dt, dt);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

window.addEventListener('resize', () => {
  renderer.resize();
  refreshLayout();
});
window.setInterval(() => net.send({ t: 'ping', c: performance.now() }), C.PING_INTERVAL_MS);

const params = new URLSearchParams(location.search);
const fromUrl = (params.get('room') ?? '').trim().toUpperCase();
ui.showMenu('');
if (ROOM_CODE_PATTERN.test(fromUrl)) joinRoom(fromUrl);
else if (fromUrl) ui.setMenuError(`"${fromUrl}" isn't a valid room code.`);
net.connect();
refreshLayout();
requestAnimationFrame(frame);
