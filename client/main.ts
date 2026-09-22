// RECOIL client entry point: connection, snapshot interpolation, own-aim
// prediction, event playback (effects and sound) and the render loop.

import * as C from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';
import { angleDiff, clamp, lerp, wrapAngle } from '../shared/sim.js';
import { POWERUP_KINDS, ROOM_CODE_PATTERN } from '../shared/types.js';
import type { GameEvent, InputState, PlayerId, PlayerSnap, RosterEntry, ServerMessage, Snapshot } from '../shared/types.js';
import { Sfx } from './audio.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { Renderer, carouselPosition, type View, type ViewBullet, type ViewPlayer, type ViewPowerup } from './render.js';
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
/** A room request to send once connected: open a private room, or quick play. */
let wantRoom: 'create' | 'quick' | null = null;
let roomPub = false;
let mapChoice = -1;
let startsIn = -1;
let myId: PlayerId | -1 = -1;
let roster: RosterEntry[] = [];
let spectators = 0;
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
let lastCarouselCard = -1;
let carouselLanded = false;
let lastPhaseSeen: Snapshot['ph'] | null = null;

const nowSec = (): number => performance.now() / 1000;

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const sfx = new Sfx();

function requestRoom(kind: 'create' | 'quick'): void {
  sfx.unlock();
  ui.setMenuError('');
  wantRoom = kind;
  roomCode = null;
  if (net.isOpen) sendHello();
  else net.connect();
}

const ui = new UI({
  onQuick: () => requestRoom('quick'),
  onCreate: () => requestRoom('create'),
  onJoin: (code) => {
    sfx.unlock();
    joinRoom(code);
  },
  onLeave: () => leaveToMenu(''),
  onStart: () => net.send({ t: 'start' }),
  onPickMap: (choice) => net.send({ t: 'map', choice }),
  onProfile: () => {
    if (roomCode && myId !== -1) net.send({ t: 'profile', name: ui.name, color: ui.color });
  },
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
      if (roomCode || wantRoom) leaveToMenu("Can't reach the game server. Try again in a moment.");
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
  if (wantRoom) {
    net.send({ t: wantRoom, id: CLIENT_ID, name: ui.name, color: ui.color });
    wantRoom = null;
  } else if (roomCode) {
    net.send({ t: 'join', code: roomCode, id: CLIENT_ID, name: ui.name, color: ui.color });
  }
}

function sendInput(): void {
  if (myId === -1) return;
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
  lastCarouselCard = -1;
  myId = -1;
  roster = [];
  spectators = 0;
}

function leaveToMenu(error: string): void {
  if (roomCode) net.send({ t: 'leave' });
  roomCode = null;
  wantRoom = null;
  lostAt = 0;
  resetRoomState();
  history.replaceState(null, '', '/');
  ui.setLobby(null);
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
      myId = msg.you;
      history.replaceState(null, '', `/?room=${msg.code}`);
      ui.setBanner(null);
      sendInput();
      break;
    case 'roster':
      roster = msg.players;
      spectators = msg.spectators;
      roomPub = msg.pub;
      mapChoice = msg.mapChoice;
      startsIn = msg.startsIn;
      refreshRoomUi();
      break;
    case 'error':
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

function refreshRoomUi(): void {
  if (!roomCode) return;
  const latest = snaps[snaps.length - 1];
  const phase = latest?.ph ?? 'lobby';
  ui.showRoom(roomCode, myId !== -1);
  ui.setLobby(phase === 'lobby' ? { code: roomCode, roster, spectators, myId, pub: roomPub, mapChoice, startsIn } : null);
  refreshLayout();
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

  const prev = snaps[snaps.length - 1];
  snaps.push(s);
  if (snaps.length > 30) snaps.splice(0, snaps.length - 30);
  for (const ev of s.e) pendingEvents.push({ time: serverTime, ev });

  if (!prev || prev.ph !== s.ph) refreshRoomUi();
  if (lostAt === 0) ui.setBanner(null);
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

function toViewPlayer(p: PlayerSnap): ViewPlayer {
  return { id: p[0], x: p[1], y: p[2], aim: p[3], charge: p[4], damage: p[5], fallTime: p[6], fx: p[7] };
}

function lerpPlayer(a: PlayerSnap, b: PlayerSnap, t: number): ViewPlayer {
  // A player who just started falling has no fall time in `a`; a respawn jumps.
  const fall = b[6] < 0 ? -1 : a[6] < 0 ? b[6] * t : lerp(a[6], b[6], t);
  const jumped = Math.hypot(b[1] - a[1], b[2] - a[2]) > 4;
  const k = jumped ? 1 : t;
  return {
    id: b[0],
    x: lerp(a[1], b[1], k),
    y: lerp(a[2], b[2], k),
    aim: a[3] + angleDiff(a[3], b[3]) * k,
    charge: lerp(a[4], b[4], t),
    damage: b[5],
    fallTime: fall,
    fx: b[7],
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
  // Don't slide players across the ice when a new round or the lobby resets them.
  if (a.ph !== b.ph && (b.ph === 'mapPick' || b.ph === 'lobby')) a = b;

  const playersA = new Map(a.p.map((p) => [p[0], p]));
  const players = b.p.map((pb) => {
    const pa = playersA.get(pb[0]);
    return pa ? lerpPlayer(pa, pb, t) : toViewPlayer(pb);
  });

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

  const powerups: ViewPowerup[] = b.u.map((u) => ({ id: u[0], kind: POWERUP_KINDS[u[1]] ?? 'heal', x: u[2], y: u[3], age: u[4] }));

  const phaseTime = a === b ? a.pt : a.ph === b.ph ? lerp(a.pt, b.pt, t) : a.pt;
  return {
    phase: a.ph,
    phaseTime,
    arenaRadius: lerp(a.r, b.r, t),
    mapIndex: a.m,
    shrinking: a.ph === 'playing' && a.r > C.ARENA_END_RADIUS + 1e-3,
    players,
    bullets,
    powerups,
    roster,
    roundWinner: a.rw,
    matchWinner: a.mw,
    myId,
    attract: false,
  };
}

/** The idle scene behind the main menu: four players wiggling on a random map. */
const attractMap = Math.floor(Math.random() * MAPS.length);
const attractRoster: RosterEntry[] = [0, 1, 2, 3].map((i) => ({
  id: i,
  name: '',
  color: (i * 2 + 1) % C.PLAYER_PALETTE.length,
  score: 0,
  online: true,
  host: false,
}));
function attractView(time: number): View {
  const players: ViewPlayer[] = attractRoster.map((r, i) => {
    const a = Math.PI + (i / 4) * Math.PI * 2 + Math.PI / 4;
    return {
      id: r.id,
      x: Math.cos(a) * C.SPAWN_DISTANCE,
      y: Math.sin(a) * C.SPAWN_DISTANCE,
      aim: a + Math.PI + Math.sin(time * (0.7 + i * 0.13) + i) * 0.7,
      charge: 0,
      damage: 0,
      fallTime: -1,
      fx: 0,
    };
  });
  return {
    phase: 'lobby',
    phaseTime: 0,
    arenaRadius: C.ARENA_START_RADIUS,
    mapIndex: attractMap,
    shrinking: false,
    players,
    bullets: [],
    powerups: [],
    roster: attractRoster,
    roundWinner: null,
    matchWinner: null,
    myId: -1,
    attract: true,
  };
}

// ---------------------------------------------------------------------------
// Local prediction: own aim (and charge, for instant visual/audio feedback)
// ---------------------------------------------------------------------------

function localCharge(t: number): number {
  return fireHeldSince === null ? 0 : clamp((t - fireHeldSince) / C.CHARGE_TIME, 0, 1);
}

function mySnap(s: Snapshot | undefined): PlayerSnap | undefined {
  return s?.p.find((p) => p[0] === myId);
}

function canAim(s: Snapshot | undefined): boolean {
  if (!s || myId === -1) return false;
  const me = mySnap(s);
  return me !== undefined && me[6] < 0 && s.ph !== 'roundEnd' && s.ph !== 'matchEnd';
}

function canFire(s: Snapshot | undefined): boolean {
  return canAim(s) && s !== undefined && (s.ph === 'playing' || s.ph === 'lobby');
}

function onLocalRelease(t: number): void {
  const latest = snaps[snaps.length - 1];
  if (!canFire(latest)) return;
  // Play the shot sound right away; the server's fire event adds the visuals.
  const me = mySnap(latest);
  sfx.fire(localCharge(t), panFor(me ? me[1] : 0));
}

function updatePrediction(dt: number, view: View): void {
  const latest = snaps[snaps.length - 1];
  const me = mySnap(latest);
  if (!latest || !me) {
    predictedAim = null;
    return;
  }
  const serverAim = me[3];
  const phaseChanged = latest.ph !== lastLatestPhase && (latest.ph === 'mapPick' || latest.ph === 'lobby');
  if (predictedAim === null || !canAim(latest) || phaseChanged) {
    predictedAim = serverAim;
  } else {
    const dir = (input.state.aimRight ? 1 : 0) - (input.state.aimLeft ? 1 : 0);
    if (dir !== 0) predictedAim = wrapAngle(predictedAim + dir * C.AIM_SPEED * dt);
    else predictedAim = wrapAngle(predictedAim + angleDiff(predictedAim, serverAim) * Math.min(1, dt * C.AIM_CORRECTION_RATE));
  }
  lastLatestPhase = latest.ph;

  const vp = view.players.find((p) => p.id === myId);
  if (vp && canAim(latest)) {
    vp.aim = predictedAim;
    if (canFire(latest)) vp.charge = localCharge(nowSec());
  }
}

// ---------------------------------------------------------------------------
// Events, sound cues and the frame loop
// ---------------------------------------------------------------------------

function panFor(x: number): number {
  return clamp(x / C.ARENA_START_RADIUS, -1, 1) * 0.7;
}

function playEvent(ev: GameEvent, view: View): void {
  const heavy = renderer.onEvent(ev, view);
  if (heavy) hitStopUntil = nowSec() + C.HIT_STOP_TIME;
  switch (ev.k) {
    case 'fire':
      if (ev.p !== myId) sfx.fire(ev.c, panFor(ev.x));
      break;
    case 'hit':
      sfx.hit(ev.f, panFor(ev.x));
      break;
    case 'block':
      sfx.block(panFor(ev.x));
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
    case 'spawn':
      sfx.powerupSpawn(panFor(ev.x));
      break;
    case 'pickup':
      sfx.pickup(panFor(ev.x));
      break;
    case 'ko':
      sfx.ko(myId === -1 || ev.w === myId);
      break;
    case 'respawn':
      break;
  }
}

function soundCues(view: View): void {
  if (view.phase === 'mapPick') {
    const { pos, done } = carouselPosition(view.phaseTime, view.mapIndex);
    const card = Math.round(pos);
    if (card !== lastCarouselCard && lastCarouselCard !== -1 && !done) sfx.carouselTick(false);
    if (done && !carouselLanded) sfx.carouselTick(true);
    lastCarouselCard = card;
    carouselLanded = done;
  } else {
    lastCarouselCard = -1;
    carouselLanded = false;
  }

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
    sfx.matchWin(myId === -1 || view.matchWinner === myId);
  }
  lastPhaseSeen = view.phase;

  const charging = new Set<number>();
  const firePhase = view.phase === 'playing' || view.phase === 'lobby';
  for (const p of view.players) {
    if (!firePhase || p.fallTime >= 0 || p.charge <= 0) continue;
    charging.add(p.id);
    sfx.setCharge(p.id, p.charge, panFor(p.x), p.id === myId ? 1 : 0.35);
  }
  sfx.silenceChargesExcept(charging);
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

    view = viewAt(renderTime) ?? attractView(now);
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
    sfx.silenceChargesExcept(new Set());
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
