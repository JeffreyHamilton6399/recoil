// RECOIL client entry point: connection, a fixed-rate input loop with
// client-side prediction of your own player (replayed on top of every server
// snapshot), interpolation of everyone else, event playback (effects, sound,
// HUD) and the render loop.

import * as C from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';
import { angleDiff, clamp, controlPlayer, lerp, movePlayer, phaseRules, playerFromSnap } from '../shared/sim.js';
import { FX_KNIFE, POWERUP_KINDS, ROOM_CODE_PATTERN } from '../shared/types.js';
import { SHOCK_WEAPON, weaponDef } from '../shared/weapons.js';
import type { GameEvent, InputState, PlayerId, PlayerSnap, PlayerState, RosterEntry, ServerMessage, Snapshot } from '../shared/types.js';
import { Sfx } from './audio.js';
import { Hud, type TeamInfo } from './hud.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { Scene3D, type CameraView, type View, type ViewBullet, type ViewPlayer, type ViewPowerup } from './scene.js';
import { UI } from './ui.js';
import { Voice } from './voice.js';

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
const pendingEvents: { time: number; ev: GameEvent }[] = [];

// Prediction of your own player.
interface Vec3 {
  x: number;
  y: number;
  z: number;
}
let seq = 0;
let history: { seq: number; input: InputState }[] = [];
let pred: PlayerState | null = null;
let predPrev: Vec3 = { x: 0, y: 0, z: 0 };
let correction: Vec3 = { x: 0, y: 0, z: 0 };
let tickAcc = 0;
let lookReset = true; // face where the server puts you on the next snapshot
/** Out of the round in a match (knocked off, or waiting to join): the loadout panel is up. */
let spectating = false;
let wasSpectating = false;
/** The room's no-jump rule (from the roster). */
let roomNoJump = false;
/** The room's team mode rule. */
let roomTeams = false;
/** The roster as sent (own colours), for the lobby; `roster` has team colours in team mode. */
let lobbyRoster: RosterEntry[] = [];
/** Crosshair spread from firing, easing back to 0. */
let bloom = 0;
/** Metres walked since the last footstep. */
let stepDist = 0;
/** How spread out the crosshair is right now (0..1). */
let spread = 0;
/** Seconds until the next heartbeat (when your damage is high). */
let heartIn = 0;
/** Speed-lines strength (sliding, going fast), eased. */
let rush = 0;
let lastInput: InputState | null = null;
/** Knife in hand (knife players), and recoil mode (remembered between visits). */
let holdKnife = false;
let recoilMode = loadRecoilMode();

function loadRecoilMode(): boolean {
  try {
    return localStorage.getItem('recoil-mode') === '1';
  } catch {
    return false;
  }
}

function setRecoilMode(on: boolean): void {
  recoilMode = on;
  sfx.recoilToggle(on);
  ui.touchElements.recoil.classList.toggle('pressed', on);
  try {
    localStorage.setItem('recoil-mode', on ? '1' : '0');
  } catch {
    // Not remembered, but it still works this session.
  }
}

/** Knife players swap between the gun and the knife (E, the mouse wheel, or 1 and 2). */
function setKnife(on: boolean): void {
  if (pred?.offhand !== C.OFFHAND_KNIFE || on === holdKnife) return;
  holdKnife = on;
  if (on) sfx.knifeDraw();
  else sfx.gunDraw();
}
let eyeHeight: number = C.EYE_HEIGHT;

// Feed: who last hit whom, to credit knock-offs.
const lastHitBy = new Map<PlayerId, { by: PlayerId; time: number }>();

let pingMs: number | null = null;
let lastCountdown = -1;
let lastShrinkSecond = -1;
let lastPhaseSeen: Snapshot['ph'] | null = null;

const nowSec = (): number => performance.now() / 1000;

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

const canvas = document.getElementById('game') as HTMLCanvasElement;
const scene = new Scene3D(canvas);
const sfx = new Sfx();
const hud = new Hud();
const voice = new Voice((msg) => net.send(msg));
scene.onWhizz = (pan, close) => sfx.whizz(pan, close);
scene.onCasing = (pan) => sfx.casing(pan);
voice.onChange = () => {
  ui.setVoice(voice.mode, voice.transmitting);
  refreshRoomUi();
};

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
  onNoJump: (on) => net.send({ t: 'rules', noJump: on, teams: roomTeams }),
  onTeams: (on) => net.send({ t: 'rules', noJump: roomNoJump, teams: on }),
  onPickTeam: (team) => net.send({ t: 'team', team }),
  onProfile: () => {
    if (roomCode && myId !== -1) net.send({ t: 'profile', name: ui.name, color: ui.color });
  },
  onWeapon: (w) => {
    sfx.uiPop();
    if (roomCode && myId !== -1) net.send({ t: 'weapon', w });
  },
  onOffhand: (o) => {
    sfx.uiPop();
    if (roomCode && myId !== -1) net.send({ t: 'offhand', o });
  },
  onAddBot: (d) => net.send({ t: 'addBot', d }),
  onRemoveBot: (id) => net.send({ t: 'removeBot', id }),
  onVoice: () => {
    sfx.unlock();
    void voice.cycleMode().then((err) => err && hud.addFeed([err]));
  },
  onMutePlayer: (id) => voice.toggleMute(id),
  onResume: () => {
    if (roomCode && myId !== -1 && !ui.isTouch && !spectating) input.requestLock();
  },
  onVolume: (v) => {
    sfx.unlock();
    sfx.setVolume(v);
  },
  onVoiceVolume: (v) => voice.setVolume(v),
  onSensitivity: (v) => {
    userSensitivity = v;
    try {
      localStorage.setItem('recoil-sensitivity', String(v));
    } catch {
      // Not remembered, but it still works this session.
    }
  },
  onToggleMute: () => {
    sfx.unlock();
    ui.setMuted(sfx.toggleMute());
  },
});
ui.setMuted(sfx.isMuted);
ui.setVoice(voice.mode, false);

const input = new Input(canvas, ui.touchElements);
input.onTouchDetected = () => {
  ui.enableTouch();
  refreshRoomUi();
};
/** When a mouse button last went down, and when the browser last tried to go Back (ms). */
let lastClickAt = 0;
let lastBackAt = 0;
window.addEventListener('mousedown', () => (lastClickAt = performance.now()), { capture: true });
input.onLockChange = (locked) => {
  ui.setLocked(locked);
  // Letting go of the mouse mid-match (Esc) opens the menu; not when spectating
  // (the game lets go itself so you can pick a loadout), on touch, or when the
  // mouse was lost right after a click or a Back gesture (a browser mouse
  // gesture, not you asking for the menu): then a click just carries on.
  const now = performance.now();
  const accidental = now - lastClickAt < 500 || now - lastBackAt < 500;
  if (!locked && roomCode && myId !== -1 && !spectating && !ui.isTouch && !accidental) ui.setPause(true);
  if (locked) ui.setPause(false);
};
// Esc with the mouse already free toggles the menu.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || !roomCode || input.locked) return;
  if (ui.pauseOpen) {
    ui.setPause(false);
  } else ui.setPause(true);
});
// A Back gesture (or button) while in a room should not leave the game: keep a
// history entry to fall back on, and quietly stay put.
window.addEventListener('popstate', () => {
  if (!roomCode) return;
  lastBackAt = performance.now();
  window.history.pushState({ recoil: true }, '', location.href);
});
/** Settings from the menu, remembered between visits. */
let userSensitivity = loadNumber('recoil-sensitivity', 1);
function loadNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
ui.setSettings(sfx.volume, userSensitivity, voice.volume);
ui.onPauseChange = (open) => sfx.menu(open);
input.onOffhandPress = () => setKnife(!holdKnife);
input.onWheel = () => setKnife(!holdKnife);
input.onRecoilPress = () => setRecoilMode(!recoilMode);

// Click the city to play (mouse players).
canvas.addEventListener('click', () => {
  sfx.unlock();
  if (roomCode && myId !== -1 && !ui.isTouch) input.requestLock();
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'KeyM') ui.setMuted(sfx.toggleMute());
  // Number keys pick a weapon while the lobby is up.
  if (e.code === 'KeyR' && !e.repeat && roomCode && myId !== -1) setRecoilMode(!recoilMode);
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit && spectating) {
    // Out of the round: pick the loadout for your next spawn.
    const n = Number(digit[1]);
    if (n <= 5) ui.setWeapon(n - 1);
    else if (n === 6) ui.setOffhand(C.OFFHAND_KNIFE);
    else if (n === 7) ui.setOffhand(C.OFFHAND_SHOCK);
  } else if (digit && input.locked) {
    if (digit[1] === '1') setKnife(false);
    if (digit[1] === '2') setKnife(true);
  } else if (digit && ui.inLobby && myId !== -1) ui.setWeapon(Number(digit[1]) - 1);
});
// Crisp UI sounds for every button in the menus and lobby.
document.addEventListener('click', (e) => {
  const t = e.target;
  const b = t instanceof Element ? t.closest('button') : null;
  if (!b || b.disabled) return;
  sfx.unlock();
  if (b.classList.contains('swatch') || b.classList.contains('cdot') || b.classList.contains('carousel-arrow')) sfx.uiPop();
  else if (['btn-quick', 'btn-create', 'btn-start', 'btn-copy', 'btn-pick-map'].includes(b.id) || b.type === 'submit') sfx.uiConfirm();
  else sfx.uiClick();
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
    net.send({ t: wantRoom, id: CLIENT_ID, name: ui.name, color: ui.color, w: ui.weapon });
    wantRoom = null;
  } else if (roomCode) {
    net.send({ t: 'join', code: roomCode, id: CLIENT_ID, name: ui.name, color: ui.color, w: ui.weapon });
  }
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
  lastPhaseSeen = null;
  lastCountdown = -1;
  myId = -1;
  roster = [];
  spectators = 0;
  seq = 0;
  history = [];
  pred = null;
  correction = { x: 0, y: 0, z: 0 };
  lookReset = true;
  lastHitBy.clear();
}

function leaveToMenu(error: string): void {
  if (roomCode) net.send({ t: 'leave' });
  roomCode = null;
  wantRoom = null;
  lostAt = 0;
  resetRoomState();
  void voice.setSeat(-1);
  input.exitLock();
  window.history.replaceState(null, '', '/');
  ui.setLobby(null);
  ui.showMenu(error);
  hud.setVisible(false);
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
      window.history.replaceState(null, '', `/?room=${msg.code}`);
      if (!(window.history.state as { recoil?: boolean } | null)?.recoil) window.history.pushState({ recoil: true }, '', `/?room=${msg.code}`);
      ui.setBanner(null);
      void voice.setSeat(myId).then((err) => err && hud.addFeed([err]));
      if (myId !== -1) net.send({ t: 'offhand', o: ui.offhand });
      refreshRoomUi();
      break;
    case 'roster':
      // Blip when someone arrives or leaves (not for our own first roster).
      if (roster.length > 0 && msg.players.length > roster.length) sfx.playerJoined();
      if (roster.length > 0 && msg.players.length < roster.length) sfx.playerLeft();
      // Team mode: everyone wears their team's colour in the game.
      lobbyRoster = msg.players;
      roster = msg.players.map((r) => (r.team >= 0 ? { ...r, color: C.TEAM_COLORS[r.team] ?? r.color } : r));
      voice.sync(roster);
      spectators = msg.spectators;
      roomPub = msg.pub;
      mapChoice = msg.mapChoice;
      startsIn = msg.startsIn;
      roomNoJump = msg.noJump;
      roomTeams = msg.teams === true;
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
    case 'rtc':
      void voice.handleSignal(msg.from, msg.d);
      break;
  }
}

function refreshRoomUi(): void {
  if (!roomCode) return;
  const latest = snaps[snaps.length - 1];
  const phase = latest?.ph ?? 'lobby';
  ui.showRoom(roomCode, myId !== -1);
  hud.setVisible(true);
  ui.setLobby(
    phase === 'lobby'
      ? { code: roomCode, roster: lobbyRoster, spectators, myId, pub: roomPub, mapChoice, startsIn, noJump: roomNoJump, teams: roomTeams, muted: [...voice.muted], speaking: [...voice.speaking] }
      : null,
  );
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

  // The server moved everyone to their spawn: face where it says.
  const resetPhase = prev && prev.ph !== s.ph && (s.ph === 'lobby' || s.ph === 'countdown');
  if (resetPhase || s.e.some((e) => e.k === 'respawn' && e.p === myId)) lookReset = true;

  reconcile(s);

  if (!prev || prev.ph !== s.ph) refreshRoomUi();
  if (lostAt === 0) ui.setBanner(null);
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

/** Runs one tick of your own movement, exactly as the server will. Jumps, slides, climbs and pads land in `events`. */
function advance(p: PlayerState, inp: InputState, snap: Snapshot, events?: GameEvent[]): boolean {
  const fired = controlPlayer(p, inp, C.TICK_DT, phaseRules(snap.ph, roomNoJump), events);
  const map = MAPS[snap.m] ?? MAPS[0];
  const h = C.TICK_DT / C.PHYSICS_SUBSTEPS;
  for (let n = 0; n < C.PHYSICS_SUBSTEPS; n++) movePlayer(p, h, map, snap.r, events);
  return fired;
}

/** Starts from the server's version of you and replays the inputs it hasn't seen yet. */
function reconcile(s: Snapshot): void {
  const ms = s.p.find((p) => p[0] === myId);
  if (!ms) {
    pred = null;
    return;
  }
  const server = playerFromSnap(ms);
  if (lookReset) {
    input.setLook(server.yaw, 0);
    lookReset = false;
    // Inputs already sent still carry the old look; don't replay them.
    history = [];
    pred = server;
    predPrev = { x: server.x, y: server.y, z: server.z };
    correction = { x: 0, y: 0, z: 0 };
    return;
  }
  history = history.filter((h) => h.seq > server.ack);
  for (const h of history) advance(server, h.input, s);
  if (pred) {
    const dx = pred.x - server.x;
    const dy = pred.y - server.y;
    const dz = pred.z - server.z;
    if (Math.hypot(dx, dy, dz) > C.CORRECTION_SNAP) {
      correction = { x: 0, y: 0, z: 0 };
      predPrev = { x: server.x, y: server.y, z: server.z };
    } else {
      // Keep the camera where it was and ease the difference away.
      correction = { x: correction.x + dx, y: correction.y + dy, z: correction.z + dz };
      predPrev = { x: predPrev.x - dx, y: predPrev.y - dy, z: predPrev.z - dz };
    }
  } else {
    predPrev = { x: server.x, y: server.y, z: server.z };
  }
  pred = server;
}

/** One fixed-rate input tick: sample, send, predict. */
function clientTick(): void {
  const latest = snaps[snaps.length - 1];
  if (!roomCode || myId === -1 || !net.isOpen || !latest) return;
  const inp = input.sample();
  // Without the mouse captured, don't fire or aim by accident.
  if (!input.locked && !ui.isTouch) {
    inp.firing = false;
    inp.aim = false;
  }
  seq++;
  inp.knife = holdKnife && pred?.offhand === C.OFFHAND_KNIFE;
  inp.recoil = recoilMode;
  net.send({
    t: 'input',
    s: seq,
    f: inp.forward,
    r: inp.strafe,
    j: inp.jump,
    x: inp.firing,
    k: inp.sprint,
    c: inp.crouch,
    z: inp.aim,
    o: inp.offhand,
    h: inp.knife,
    m: inp.recoil,
    a: inp.yaw,
    b: inp.pitch,
  });
  history.push({ seq, input: inp });
  lastInput = inp;
  if (history.length > 90) history.shift();
  if (!pred) return;

  predPrev = { x: pred.x, y: pred.y, z: pred.z };
  const wasGrounded = pred.grounded;
  const vzBefore = pred.vz;
  const events: GameEvent[] = [];
  const fired = advance(pred, inp, latest, events);
  if (fired) {
    sfx.shot(pred.weapon, 0);
    scene.localFire(pred.weapon, myColor());
    bloom = Math.min(1, bloom + weaponDef(pred.weapon).viewKick * 6 + 0.1);
  }
  // Your own offhand sounds right away (the server's copy is skipped).
  if (pred.offUse) {
    if (pred.offhand === C.OFFHAND_KNIFE) {
      sfx.knife(false, 0);
      scene.localSlash();
    } else sfx.throwGrenade(0);
  }
  // Your own moves sound right away; the server's copies of these events are skipped.
  for (const ev of events) {
    if (ev.k === 'jump') sfx.jump(0);
    else if (ev.k === 'slide') {
      sfx.slide(0);
      scene.slideDust(pred.x, pred.y, pred.z);
    } else if (ev.k === 'mantle') sfx.mantle(0);
    else if (ev.k === 'pad') sfx.pad(0);
  }
  if (!wasGrounded && pred.grounded) {
    sfx.land(-vzBefore);
    scene.landImpact(-vzBefore);
  }
}

function myColor(): string {
  const r = roster.find((q) => q.id === myId);
  return C.PLAYER_PALETTE[r?.color ?? 0] ?? C.PLAYER_PALETTE[0];
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

function toViewPlayer(p: PlayerSnap): ViewPlayer {
  return {
    id: p[0],
    x: p[1],
    y: p[2],
    z: p[3],
    yaw: p[7],
    pitch: p[8],
    damage: p[9],
    fallTime: p[10],
    fx: p[11],
    weapon: p[14],
    sliding: p[15] > 0,
    knife: (p[11] & FX_KNIFE) !== 0,
  };
}

function lerpPlayer(a: PlayerSnap, b: PlayerSnap, t: number): ViewPlayer {
  // A player who just started falling has no fall time in `a`; a respawn jumps.
  const fall = b[10] < 0 ? -1 : a[10] < 0 ? b[10] * t : lerp(a[10], b[10], t);
  const jumped = Math.hypot(b[1] - a[1], b[2] - a[2], b[3] - a[3]) > 6;
  const k = jumped ? 1 : t;
  return {
    id: b[0],
    x: lerp(a[1], b[1], k),
    y: lerp(a[2], b[2], k),
    z: lerp(a[3], b[3], k),
    yaw: a[7] + angleDiff(a[7], b[7]) * k,
    pitch: lerp(a[8], b[8], k),
    damage: b[9],
    fallTime: fall,
    fx: b[11],
    weapon: b[14],
    sliding: b[15] > 0,
    knife: (b[11] & FX_KNIFE) !== 0,
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
  // Don't slide players across the roof when a new round or the lobby resets them.
  if (a.ph !== b.ph && (b.ph === 'countdown' || b.ph === 'lobby')) a = b;

  const playersA = new Map(a.p.map((p) => [p[0], p]));
  const players = b.p.map((pb) => {
    const pa = playersA.get(pb[0]);
    return pa ? lerpPlayer(pa, pb, t) : toViewPlayer(pb);
  });

  const bulletsA = new Map(a.b.map((x) => [x[0], x]));
  const bullets: ViewBullet[] = [];
  const span = Math.max(C.TICK_DT, (b.k - a.k) * C.TICK_DT);
  for (const bb of b.b) {
    if (bb[1] === myId) continue; // your own shots are drawn ahead, below
    const ba = bulletsA.get(bb[0]);
    if (!ba) continue; // spawns between snapshots appear on the next one
    bullets.push({
      id: bb[0],
      owner: bb[1],
      weapon: bb[6],
      x: lerp(ba[2], bb[2], t),
      y: lerp(ba[3], bb[3], t),
      z: lerp(ba[4], bb[4], t),
      r: bb[5],
      vx: (bb[2] - ba[2]) / span,
      vy: (bb[3] - ba[3]) / span,
      vz: (bb[4] - ba[4]) / span,
    });
  }
  bullets.push(...ownBullets());

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
    myId,
  };
}

/**
 * Your own bullets, pushed forward to "now" from the newest snapshot, so
 * they leave your gun without the interpolation delay everyone else has.
 */
function ownBullets(): ViewBullet[] {
  const n = snaps.length;
  if (n < 2 || clockOffset === null || myId === -1) return [];
  const last = snaps[n - 1];
  const prev = new Map(snaps[n - 2].b.map((x) => [x[0], x]));
  const dt = Math.max(C.TICK_DT, (last.k - snaps[n - 2].k) * C.TICK_DT);
  const ahead = clamp(nowSec() - clockOffset - last.k * C.TICK_DT + (pingMs ?? 60) / 2000, 0, 0.3);
  const out: ViewBullet[] = [];
  for (const b of last.b) {
    if (b[1] !== myId) continue;
    const p = prev.get(b[0]);
    if (!p) continue;
    const vx = (b[2] - p[2]) / dt;
    const vy = (b[3] - p[3]) / dt;
    const vz = (b[4] - p[4]) / dt;
    out.push({ id: b[0], owner: b[1], weapon: b[6], x: b[2] + vx * ahead, y: b[3] + vy * ahead, z: b[4] + vz * ahead, r: b[5], vx, vy, vz });
  }
  return out;
}

/** The idle scene behind the main menu: four players on a random map. */
const attractMap = Math.floor(Math.random() * MAPS.length);
const attractRoster: RosterEntry[] = [0, 1, 2, 3].map((i) => ({
  id: i,
  name: ['Zip', 'Boom', 'Kick', 'Pow'][i],
  color: (i * 2 + 1) % C.PLAYER_PALETTE.length,
  weapon: i % 5,
  offhand: i % 2,
  bot: 0,
  voice: false,
  team: -1,
  score: 0,
  online: true,
  host: false,
}));
function attractView(time: number): View {
  const players: ViewPlayer[] = attractRoster.map((r, i) => {
    const a = Math.PI + (i / 4) * Math.PI * 2 + Math.PI / 4 + time * 0.05;
    const hop = Math.max(0, Math.sin(time * 2.2 + i * 1.7)) * 1.2;
    return {
      id: r.id,
      x: Math.cos(a) * C.SPAWN_DISTANCE,
      y: Math.sin(a) * C.SPAWN_DISTANCE,
      z: hop,
      yaw: a + Math.PI + Math.sin(time * (0.7 + i * 0.13) + i) * 0.7,
      pitch: Math.sin(time * 0.9 + i) * 0.3,
      damage: (i * 37) % 120,
      fallTime: -1,
      fx: 0,
      weapon: i % 5,
      sliding: false,
      knife: false,
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
    myId: -1,
  };
}

// ---------------------------------------------------------------------------
// Events, sound cues and the frame loop
// ---------------------------------------------------------------------------

function colorOf(id: PlayerId): string {
  const r = roster.find((q) => q.id === id);
  return C.PLAYER_PALETTE[r?.color ?? id] ?? C.PLAYER_PALETTE[0];
}
function nameOf(id: PlayerId): string {
  return roster.find((q) => q.id === id)?.name ?? `Player ${id + 1}`;
}

function playEvent(ev: GameEvent, view: View, time: number): void {
  const heavy = scene.onEvent(ev, view);
  switch (ev.k) {
    case 'fire':
      if (ev.p !== myId) sfx.shot(ev.w, scene.panFor(ev.x, ev.y, ev.z), 0.7);
      break;
    case 'boom':
      if (ev.w === SHOCK_WEAPON) sfx.shockwave(scene.panFor(ev.x, ev.y, ev.z));
      else sfx.boom(ev.r, scene.panFor(ev.x, ev.y, ev.z));
      break;
    case 'draw':
      if (ev.p !== myId) {
        const p = view.players.find((q) => q.id === ev.p);
        const pan = p ? scene.panFor(p.x, p.y, p.z) : 0;
        if (ev.knife) sfx.knifeDraw(pan, 0.5);
        else sfx.gunDraw(pan, 0.5);
      }
      break;
    case 'melee':
      if (ev.p !== myId) sfx.knife(ev.hit, scene.panFor(ev.x, ev.y, ev.z));
      else if (ev.hit) sfx.knife(true, 0);
      break;
    case 'throw': {
      if (ev.p === myId) break;
      const p = view.players.find((q) => q.id === ev.p);
      sfx.throwGrenade(p ? scene.panFor(p.x, p.y, p.z) : 0, 0.6);
      break;
    }
    case 'pad':
      if (ev.p !== myId) sfx.pad(scene.panFor(ev.x, ev.y, 0));
      break;
    case 'slide':
    case 'mantle': {
      if (ev.p === myId) break;
      const p = view.players.find((q) => q.id === ev.p);
      const pan = p ? scene.panFor(p.x, p.y, p.z) : 0;
      if (ev.k === 'slide') sfx.slide(pan, 0.5);
      else sfx.mantle(pan, 0.5);
      break;
    }
    case 'hit':
      sfx.hit(ev.f, scene.panFor(ev.x, ev.y, ev.z));
      lastHitBy.set(ev.p, { by: ev.o, time });
      if (ev.o === myId && ev.p !== myId) {
        // Your hit: a tick, a marker and a number where it landed.
        hud.hitMarker();
        sfx.hitmarker(heavy);
        scene.damageNumber(ev.x, ev.y, ev.z, ev.d, heavy);
      }
      if (ev.p === myId) {
        hud.hurt(ev.f);
        sfx.hurt(ev.f);
      }
      if (heavy && ev.o === myId) scene.addTrauma(0.1);
      break;
    case 'block':
      sfx.block(scene.panFor(ev.x, ev.y, ev.z));
      if (ev.p !== myId) hud.hitMarker();
      break;
    case 'cancel':
      sfx.cancel(scene.panFor(ev.x, ev.y, ev.z));
      break;
    case 'bump':
      if (ev.q < 0) sfx.bumper(ev.f, scene.panFor(ev.x, ev.y, ev.z));
      else sfx.bump(ev.f, scene.panFor(ev.x, ev.y, ev.z));
      break;
    case 'fall': {
      sfx.whoosh(scene.panFor(ev.x, ev.y, 0));
      const last = lastHitBy.get(ev.p);
      if (last && time - last.time < 5 && last.by !== ev.p) {
        if (last.by === myId) {
          hud.hitMarker(true);
          sfx.knockoutConfirm();
        }
        hud.addFeed([[nameOf(last.by), colorOf(last.by)], ' knocked ', [nameOf(ev.p), colorOf(ev.p)], ' off']);
      } else {
        hud.addFeed([[nameOf(ev.p), colorOf(ev.p)], ' fell off']);
      }
      lastHitBy.delete(ev.p);
      break;
    }
    case 'jump':
      if (ev.p !== myId) {
        const p = view.players.find((q) => q.id === ev.p);
        if (p) sfx.jump(scene.panFor(p.x, p.y, p.z), 0.5);
      }
      break;
    case 'spawn':
      sfx.powerupSpawn(scene.panFor(ev.x, ev.y, C.POWERUP_HEIGHT));
      break;
    case 'pickup':
      sfx.pickup(ev.u, scene.panFor(ev.x, ev.y, C.POWERUP_HEIGHT));
      break;
    case 'ko': {
      const tw = snaps[snaps.length - 1]?.tw;
      const myTeam = roster.find((r) => r.id === myId)?.team ?? -1;
      sfx.ko(myId === -1 || ev.w === myId || (tw !== undefined && tw !== null && tw >= 0 && tw === myTeam));
      break;
    }
    case 'respawn': {
      const p = view.players.find((q) => q.id === ev.p);
      sfx.respawn(p ? scene.panFor(p.x, p.y, p.z) : 0);
      break;
    }
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
    if (sec !== lastShrinkSecond && sec > 0 && sec % 2 === 0) sfx.shrinkTick();
    lastShrinkSecond = sec;
  } else {
    lastShrinkSecond = -1;
  }

  if (view.phase === 'matchEnd' && lastPhaseSeen !== 'matchEnd' && lastPhaseSeen !== null) {
    sfx.matchWin(myId === -1 || snaps[snaps.length - 1]?.mw === myId);
  }
  lastPhaseSeen = view.phase;

}

let lastFrame = nowSec();
function frame(): void {
  const now = nowSec();
  const dt = Math.min(0.1, now - lastFrame);
  lastFrame = now;

  let view: View;
  let cam: CameraView = { kind: 'orbit' };
  let me: ViewPlayer | undefined;
  let roundWinner: PlayerId | null = null;
  let matchWinner: PlayerId | null = null;
  let teamInfo: TeamInfo | null = null;

  if (roomCode && clockOffset !== null && snaps.length > 0) {
    // Fixed-rate input ticks; several per frame if the tab fell behind.
    tickAcc = Math.min(tickAcc + dt, C.TICK_DT * 5);
    while (tickAcc >= C.TICK_DT) {
      tickAcc -= C.TICK_DT;
      clientTick();
    }

    const target = now - clockOffset - C.INTERP_DELAY;
    renderTime += dt;
    if (Math.abs(target - renderTime) > 0.5) renderTime = target;
    else renderTime += (target - renderTime) * Math.min(1, dt * 3);

    view = viewAt(renderTime) ?? attractView(now);
    const latest = snaps[snaps.length - 1];
    roundWinner = latest.rw;
    matchWinner = latest.mw;
    teamInfo = latest.ts ? { scores: latest.ts, round: latest.tw ?? null, match: latest.tm ?? null } : null;
    // Fire effects and sounds when the interpolated time reaches them.
    while (pendingEvents.length > 0 && pendingEvents[0].time <= renderTime + 1e-6) {
      const item = pendingEvents.shift();
      if (item && renderTime - item.time < 1) playEvent(item.ev, view, item.time);
    }

    // Your own player comes from the prediction, not the (older) snapshots.
    if (pred && myId !== -1) {
      const decay = Math.exp(-C.CORRECTION_RATE * dt);
      correction = { x: correction.x * decay, y: correction.y * decay, z: correction.z * decay };
      const a = clamp(tickAcc / C.TICK_DT, 0, 1);
      const x = lerp(predPrev.x, pred.x, a) + correction.x;
      const y = lerp(predPrev.y, pred.y, a) + correction.y;
      const z = lerp(predPrev.z, pred.z, a) + correction.z;
      const serverMe = view.players.find((p) => p.id === myId);
      me = {
        id: myId,
        x,
        y,
        z,
        yaw: input.yaw,
        pitch: input.pitch,
        damage: serverMe?.damage ?? pred.damage,
        fallTime: pred.falling ? pred.fallTime : -1,
        fx: serverMe?.fx ?? 0,
        weapon: pred.weapon,
        sliding: pred.slide > 0,
        knife: pred.knifeOut,
      };
      view.players = view.players.map((p) => (p.id === myId && me ? me : p));
      const out = pred.falling && pred.fallTime > C.FALL_DURATION * 0.7;
      // Duck smoothly into a slide and back up.
      const eyeTarget = pred.slide > 0 ? C.SLIDE_EYE_HEIGHT : C.EYE_HEIGHT;
      eyeHeight += (eyeTarget - eyeHeight) * Math.min(1, dt * 14);
      const speed = Math.hypot(pred.vx, pred.vy);
      const sprinting = (lastInput?.sprint ?? false) && pred.grounded && speed > C.MOVE_SPEED * 1.1;
      // Footsteps: one every couple of metres on the ground (none while sliding).
      if (pred.grounded && pred.slide <= 0 && speed > 1.5 && !out) {
        stepDist += speed * dt;
        if (stepDist > (sprinting ? 2.9 : 2.3)) {
          stepDist = 0;
          sfx.step(sprinting);
        }
      } else {
        stepDist = 1.6; // the first step comes quickly once you start moving
      }
      // Speed lines: on in a slide or at high speed (flying after a hit, a jump pad...).
      const flying = Math.hypot(pred.vx, pred.vy, pred.vz);
      const rushTarget = pred.slide > 0 ? 1 : Math.max(0, Math.min(1, (flying - 12) / 10));
      rush += (rushTarget - rush) * Math.min(1, dt * 8);
      // A heartbeat once your damage gets dangerous: faster the worse it is.
      heartIn -= dt;
      if (!out && me.damage >= 100 && heartIn <= 0) {
        sfx.heartbeat();
        heartIn = Math.max(0.55, 1.1 - (me.damage - 100) / 200);
      }
      // Crosshair spread: wider when moving fast or in the air, tighter aiming down sights.
      bloom = Math.max(0, bloom - dt * 2.5);
      const moving = Math.min(1, speed / (C.MOVE_SPEED * C.SPRINT_MULT));
      spread = Math.min(1, (moving * 0.45 + (pred.grounded ? 0 : 0.4) + bloom) * (pred.aiming ? 0.3 : 1));
      if (!out) {
        cam = {
          kind: 'first',
          x,
          y,
          z: z + eyeHeight,
          yaw: input.yaw,
          pitch: input.pitch,
          speed,
          grounded: pred.grounded,
          weapon: pred.weapon,
          sprinting,
          sliding: pred.slide > 0,
          aiming: pred.aiming,
          knife: pred.knifeOut,
        };
      }
    }
    soundCues(view);
    // Drop snapshots we'll never interpolate from again.
    while (snaps.length > 3 && snaps[1].k * C.TICK_DT < renderTime - 0.5) snaps.shift();
  } else {
    view = attractView(now);
  }

  view.speaking = voice.speaking;
  scene.render(view, cam, dt, myColor());
  if (voice.active) {
    const heads = new Map(view.players.filter((p) => p.fallTime < 0).map((p) => [p.id, Scene3D.head(p.x, p.y, p.z)] as const));
    voice.update(scene.listener(), heads);
  }
  // Slower look while zoomed in, so aiming stays steady.
  input.sensitivity = scene.zoom * userSensitivity;
  // The loadout panel while you're out of a round.
  const phase = snaps[snaps.length - 1]?.ph ?? 'lobby';
  spectating = !!roomCode && myId !== -1 && phase !== 'lobby' && (!pred || (pred.falling && pred.fallTime > C.FALL_DURATION * 0.5));
  if (spectating && !wasSpectating) input.releaseMouse();
  wasSpectating = spectating;
  ui.setLoadout(spectating);
  if (roomCode) {
    hud.update(
      {
        view,
        me,
        firstPerson: cam.kind === 'first',
        locked: input.locked || ui.isTouch,
        touch: ui.isTouch,
        roundWinner,
        matchWinner,
        teams: teamInfo,
        weapon: pred?.weapon ?? 0,
        spread,
        rush,
        aiming: cam.kind === 'first' && cam.aiming,
        ready: pred ? 1 - Math.min(1, pred.cooldown / Math.max(0.05, weaponDef(pred.weapon).cooldown)) : 1,
        offhand: pred?.offhand ?? ui.offhand,
        offLeft: pred?.offCd ?? 0,
        knife: pred?.knifeOut ?? false,
        recoil: recoilMode,
      },
      dt,
    );
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

window.addEventListener('resize', () => scene.resize());
// Ask before leaving mid-game (a stray Ctrl+W while sliding, say).
window.addEventListener('beforeunload', (e) => {
  if (!roomCode || myId === -1) return;
  e.preventDefault();
  e.returnValue = '';
});
window.setInterval(() => net.send({ t: 'ping', c: performance.now() }), C.PING_INTERVAL_MS);

const params = new URLSearchParams(location.search);
const fromUrl = (params.get('room') ?? '').trim().toUpperCase();
ui.showMenu('');
hud.setVisible(false);
if (ROOM_CODE_PATTERN.test(fromUrl)) joinRoom(fromUrl);
else if (fromUrl) ui.setMenuError(`"${fromUrl}" isn't a valid room code.`);
net.connect();
requestAnimationFrame(frame);
