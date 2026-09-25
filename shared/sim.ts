// The RECOIL simulation. Pure functions over plain data: no timers, no I/O.
// Randomness (map picks, power-up spawns, pellet spread) comes from a seeded
// PRNG stored in the state, so a given seed and input sequence always plays
// out the same. The server runs it authoritatively. The client runs
// controlPlayer and movePlayer on its own player to predict movement
// without waiting for the server.
//
// The world is 3D: x and y are horizontal, z is up, and the roof is at z = 0.

import * as C from './constants.js';
import { MAPS, floorAt, hillSpots, inBlock, isOffMap, rampHeight, scaledBlocks, scaledBumpers, scaledPads, scaledRamps, scaledTurrets, spawnAt, spawnPoint, type MapDef } from './maps.js';
import {
  FX_AIM,
  FX_AIR_JUMPED,
  FX_FIRE_HELD,
  FX_GRAPPLE_HELD,
  FX_JUMP_HELD,
  FX_SPEED,
  FX_SLIDE_LOCK,
  FX_GROUNDED,
  FX_MEGA,
  FX_KNIFE,
  FX_OFF_HELD,
  FX_RECOIL,
  FX_RAPID,
  FX_SHIELD,
  FX_TRIPLE,
  POWERUP_KINDS,
  type Bullet,
  type Flag,
  type GameEvent,
  type GameState,
  type Hill,
  type InputState,
  type PlayerId,
  type PlayerSnap,
  type PlayerState,
  type PowerupKind,
  type Turret,
} from './types.js';
import { BOMB_OWNER, BOMB_WEAPON, OFFHANDS, SHOCK_WEAPON, TURRET_OWNER, TURRET_WEAPON, WEAPONS, weaponDef } from './weapons.js';

export const NO_INPUT: InputState = Object.freeze({
  forward: 0,
  strafe: 0,
  jump: false,
  firing: false,
  sprint: false,
  crouch: false,
  aim: false,
  offhand: false,
  knife: false,
  recoil: false,
  grapple: false,
  yaw: 0,
  pitch: 0,
});

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wraps an angle into [-PI, PI). */
export function wrapAngle(a: number): number {
  const TAU = Math.PI * 2;
  return ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

/** Shortest signed difference from angle a to angle b. */
export function angleDiff(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** mulberry32 step: returns a float in [0, 1) and advances the state's PRNG. */
export function random(s: GameState): number {
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Unit vector for a look direction. */
export function aimDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: Math.cos(yaw) * cp, y: Math.sin(yaw) * cp, z: Math.sin(pitch) };
}

/** Arena radius after a given number of seconds of active play. */
export function arenaRadiusAt(playTime: number): number {
  const t = clamp(playTime / C.ARENA_SHRINK_TIME, 0, 1);
  return lerp(C.ARENA_START_RADIUS, C.ARENA_END_RADIUS, t);
}

export function currentMap(s: GameState): MapDef {
  return MAPS[s.mapIndex] ?? MAPS[0];
}

/** What a player may do right now. */
export interface Rules {
  canMove: boolean;
  canFire: boolean;
  /** The room's no-jump rule: the only way up is recoil (and jump pads). */
  noJump: boolean;
}

/** What a player may do in each phase. */
export function phaseRules(phase: GameState['phase'], noJump = false): Rules {
  const canFire = phase === 'lobby' || phase === 'playing';
  return { canMove: canFire || phase === 'roundEnd' || phase === 'matchEnd', canFire, noJump };
}

/** Running speed for a player right now. */
export function runSpeed(p: PlayerState, input: InputState): number {
  const move = p.knifeOut ? C.KNIFE_MOVE_MULT : weaponDef(p.weapon).moveMult;
  if (p.aiming) return C.MOVE_SPEED * move * C.AIM_MOVE_MULT;
  const sprint = input.sprint && input.forward > 0 ? C.SPRINT_MULT : 1;
  return C.MOVE_SPEED * move * sprint * (p.speed > 0 ? C.SPEED_MULT : 1);
}

// ---------------------------------------------------------------------------
// Setup and flow
// ---------------------------------------------------------------------------

export function createPlayer(id: PlayerId, weapon = 0): PlayerState {
  return {
    id,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    grounded: true,
    weapon,
    nextWeapon: weapon,
    slide: 0,
    slideCd: 0,
    slideLock: false,
    aiming: false,
    wallTop: -1,
    wallNx: 0,
    wallNy: 0,
    fireHeld: false,
    cooldown: 0,
    damage: 0,
    falling: false,
    fallTime: 0,
    inRound: false,
    spawnIndex: 0,
    rapid: 0,
    triple: 0,
    mega: 0,
    shield: 0,
    ack: 0,
    offhand: C.OFFHAND_KNIFE,
    nextOffhand: C.OFFHAND_KNIFE,
    offCd: 0,
    offHeld: false,
    knifeOut: false,
    recoilMode: false,
    offUse: false,
    team: 0,
    grappleX: 0,
    grappleY: 0,
    grappleZ: 0,
    grappleT: -1,
    grappleCd: 0,
    grappleHeld: false,
    jumpHeld: false,
    airJumped: false,
    speed: 0,
  };
}

/** Capture the flag: each team's side of the roof (Red towards -x, Blue towards +x). */
const teamAngle = (team: number): number => Math.PI + team * Math.PI;

/** Capture the flag: where team t's flag stands (its base). */
export function flagBase(map: MapDef, team: number): { x: number; y: number } {
  const sp = spawnAt(map, teamAngle(team));
  return { x: sp.x, y: sp.y };
}

/** Capture the flag: spread out beside your team's flag, never on it. */
function ctfSpawn(s: GameState, p: PlayerState): { x: number; y: number; yaw: number } {
  const mates = s.players.filter((q) => q.team === p.team).sort((a, b) => a.id - b.id);
  const k = Math.max(0, mates.indexOf(p));
  const off = (k % 2 === 0 ? 1 : -1) * 0.22 * (Math.floor(k / 2) + 1);
  return spawnAt(currentMap(s), teamAngle(p.team) + off);
}

function resetAtSpawn(s: GameState, p: PlayerState, index: number, count: number): void {
  const sp = s.ctf || (s.koth && s.teams) ? ctfSpawn(s, p) : spawnPoint(currentMap(s), index, count);
  p.x = sp.x;
  p.y = sp.y;
  p.z = 0;
  p.yaw = wrapAngle(sp.yaw);
  p.pitch = 0;
  p.vx = 0;
  p.vy = 0;
  p.vz = 0;
  p.grounded = true;
  p.weapon = p.nextWeapon;
  p.offhand = p.nextOffhand;
  p.offCd = 0;
  p.slide = 0;
  p.slideCd = 0;
  p.wallTop = -1;
  p.fireHeld = false;
  p.cooldown = 0;
  p.damage = 0;
  p.falling = false;
  p.fallTime = 0;
  p.spawnIndex = index;
  p.rapid = 0;
  p.triple = 0;
  p.mega = 0;
  p.shield = 0;
  p.offCd = 0;
  p.offUse = false;
  p.grappleT = -1;
  p.grappleCd = 0;
  p.airJumped = false;
  p.speed = 0;
}

/** Puts every player in the round, evenly spaced on the spawn ring (teams side by side). */
function placeAll(s: GameState): void {
  const n = s.players.length;
  const order = s.teams ? [...s.players].sort((a, b) => a.team - b.team || a.id - b.id) : s.players;
  order.forEach((p, i) => {
    p.inRound = true;
    resetAtSpawn(s, p, i, n);
  });
  s.flags = s.ctf ? [0, 1].map((team) => ({ team, ...flagBase(currentMap(s), team), z: 0, carrier: -1 })) : [];
  s.hill = s.koth ? newHill(s, 0) : null;
  s.turrets = (currentMap(s).turrets ?? []).map((_, i): Turret => ({ yaw: i * 1.7, pitch: 0, cd: 1, hp: C.TURRET_HP, down: 0, target: -1, retarget: 0 }));
  s.bombIn = 0;
}

/** King of the hill: the hill on spot i of the map's hill spots. */
function newHill(s: GameState, i: number): Hill {
  const spots = hillSpots(currentMap(s), s.arenaRadius);
  const spot = ((i % spots.length) + spots.length) % spots.length;
  return { ...spots[spot], owner: -1, moveIn: C.HILL_MOVE, spot };
}

/**
 * King of the hill: whoever is the only one (or the only team) standing on
 * the hill gets the time. Two sides on it at once is contested: nobody
 * scores. The hill moves every HILL_MOVE seconds.
 */
function updateHill(s: GameState, dt: number, events: GameEvent[], scoring: boolean): void {
  const hill = s.hill;
  if (!hill) return;
  hill.moveIn -= dt;
  if (hill.moveIn <= 0) {
    s.hill = newHill(s, hill.spot + 1);
    events.push({ k: 'hill', x: s.hill.x, y: s.hill.y, z: s.hill.z });
    return;
  }
  const on = s.players.filter(
    (p) => p.inRound && !p.falling && Math.hypot(p.x - hill.x, p.y - hill.y) < C.HILL_RADIUS && p.z > hill.z - 0.6 && p.z < hill.z + 3.5,
  );
  const sides = new Set(on.map((p) => (s.teams ? p.team : p.id)));
  hill.owner = sides.size === 0 ? -1 : sides.size > 1 ? -2 : [...sides][0];
  if (scoring && hill.owner >= 0) s.hillScores[hill.owner] += dt;
}

/** Nothing solid between two points (the roof, blocks and ramps all block the view). */
function lineOfSight(map: MapDef, R: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 0.6);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    const z = z0 + (z1 - z0) * t;
    if ((z <= 0 && !isOffMap(map, R, x, y)) || inBlock(map, R, x, y, z)) return false;
  }
  return true;
}

/**
 * Turrets: each one finds the nearest player it can see, swings round to
 * lead them, and fires a heavy slug when it's lined up. Everyone is fair
 * game. Knocked-out turrets come back after a while.
 */
function updateTurrets(s: GameState, dt: number, events: GameEvent[]): void {
  const map = currentMap(s);
  const R = s.arenaRadius;
  const spots = scaledTurrets(map, R);
  const w = weaponDef(TURRET_WEAPON);
  s.turrets.forEach((t, i) => {
    const at = spots[i];
    if (!at) return;
    if (t.down > 0) {
      t.down = Math.max(0, t.down - dt);
      if (t.down === 0) t.hp = C.TURRET_HP;
      return;
    }
    t.cd = Math.max(0, t.cd - dt);
    t.retarget -= dt;
    let target = t.target >= 0 ? getPlayer(s, t.target) : undefined;
    if (target && (!target.inRound || target.falling)) target = undefined;
    if (t.retarget <= 0) {
      t.retarget = 0.4;
      let best: PlayerState | undefined;
      let bestD = C.TURRET_RANGE;
      for (const p of s.players) {
        if (!p.inRound || p.falling) continue;
        const d = Math.hypot(p.x - at.x, p.y - at.y, p.z + 1 - at.z);
        if (d < bestD && lineOfSight(map, R, at.x, at.y, at.z, p.x, p.y, p.z + 1)) {
          best = p;
          bestD = d;
        }
      }
      target = best;
      t.target = best?.id ?? -1;
    }
    let wantYaw = t.yaw + 0.6;
    let wantPitch = 0;
    if (target) {
      const lead = (Math.hypot(target.x - at.x, target.y - at.y) / w.speed) * 0.7;
      const tx = target.x + target.vx * lead;
      const ty = target.y + target.vy * lead;
      const tz = target.z + 1 + target.vz * lead * 0.5;
      wantYaw = Math.atan2(ty - at.y, tx - at.x);
      wantPitch = Math.atan2(tz - at.z, Math.hypot(tx - at.x, ty - at.y));
    }
    const turn = C.TURRET_TURN * dt;
    t.yaw = wrapAngle(t.yaw + clamp(angleDiff(t.yaw, wantYaw), -turn, turn));
    t.pitch += clamp(wantPitch - t.pitch, -turn, turn);
    if (target && t.cd <= 0 && Math.abs(angleDiff(t.yaw, wantYaw)) < 0.06 && Math.abs(wantPitch - t.pitch) < 0.06) {
      t.cd = C.TURRET_COOLDOWN;
      const d = aimDir(t.yaw, t.pitch);
      const off = C.TURRET_RADIUS + 0.2;
      s.bullets.push({
        id: s.nextId++,
        owner: TURRET_OWNER,
        team: -1,
        weapon: TURRET_WEAPON,
        x: at.x + d.x * off,
        y: at.y + d.y * off,
        z: at.z + d.z * off,
        vx: d.x * w.speed,
        vy: d.y * w.speed,
        vz: d.z * w.speed,
        radius: w.radius,
        knockback: w.knockback,
        damage: w.damage,
        age: 0,
      });
      events.push({ k: 'tfire', i, x: at.x, y: at.y, z: at.z });
    }
  });
}

/** The working turret a shot at (x, y, z) hits, or -1. */
function turretAt(s: GameState, x: number, y: number, z: number, r: number): number {
  const spots = scaledTurrets(currentMap(s), s.arenaRadius);
  for (let i = 0; i < s.turrets.length; i++) {
    const at = spots[i];
    if (!at || s.turrets[i].down > 0) continue;
    const rr = C.TURRET_RADIUS + r;
    const dx = x - at.x;
    const dy = y - at.y;
    const dz = z - (at.z - 0.3);
    if (dx * dx + dy * dy + dz * dz < rr * rr) return i;
  }
  return -1;
}

function damageTurret(s: GameState, i: number, amount: number, events: GameEvent[]): void {
  const t = s.turrets[i];
  if (!t || t.down > 0) return;
  t.hp -= amount;
  events.push({ k: 'thit', i });
  if (t.hp <= 0) {
    const at = scaledTurrets(currentMap(s), s.arenaRadius)[i];
    t.down = C.TURRET_DOWN_TIME;
    t.target = -1;
    events.push({ k: 'tdown', i, x: at?.x ?? 0, y: at?.y ?? 0, z: at?.z ?? 0 });
  }
}

/**
 * Sudden death: a round that runs past BOMB_TIME gets bombs dropped on it,
 * faster and faster, mostly near people.
 */
function updateBombs(s: GameState, dt: number, events: GameEvent[]): void {
  if (s.playTime < C.BOMB_TIME) return;
  if (s.playTime - dt < C.BOMB_TIME) events.push({ k: 'sudden' });
  s.bombIn -= dt;
  if (s.bombIn > 0) return;
  const over = s.playTime - C.BOMB_TIME;
  s.bombIn = Math.max(C.BOMB_EVERY_MIN, C.BOMB_EVERY - over * 0.025);
  const map = currentMap(s);
  const R = s.arenaRadius;
  const alive = s.players.filter((p) => p.inRound && !p.falling);
  let x = 0;
  let y = 0;
  if (alive.length > 0 && random(s) < 0.6) {
    const p = alive[Math.floor(random(s) * alive.length)];
    const a = random(s) * Math.PI * 2;
    const r = random(s) * 4;
    x = p.x + Math.cos(a) * r;
    y = p.y + Math.sin(a) * r;
  } else {
    for (let tries = 0; tries < 8; tries++) {
      const a = random(s) * Math.PI * 2;
      const r = Math.sqrt(random(s)) * R * 0.9;
      x = Math.cos(a) * r;
      y = Math.sin(a) * r;
      if (!isOffMap(map, R, x, y)) break;
    }
  }
  const w = weaponDef(BOMB_WEAPON);
  s.bullets.push({
    id: s.nextId++,
    owner: BOMB_OWNER,
    team: -1,
    weapon: BOMB_WEAPON,
    x,
    y,
    z: C.BOMB_HEIGHT,
    vx: 0,
    vy: 0,
    vz: -14,
    radius: w.radius,
    knockback: w.knockback,
    damage: w.damage,
    age: 0,
  });
  events.push({ k: 'bomb', x, y });
}

/** Capture the flag: a flag goes back to its base. */
function homeFlag(s: GameState, f: Flag): void {
  const base = flagBase(currentMap(s), f.team);
  f.x = base.x;
  f.y = base.y;
  f.z = 0;
  f.carrier = -1;
}

/**
 * Capture the flag: grab the other team's flag by touching it, and bring it
 * to your own flag (while yours is at home) to score. If the carrier falls,
 * the flag goes straight home. Captures only count in a match.
 */
function updateFlags(s: GameState, events: GameEvent[], scoring: boolean): void {
  for (const f of s.flags) {
    if (f.carrier >= 0) {
      const c = getPlayer(s, f.carrier);
      if (!c || !c.inRound || c.falling || c.team === f.team) {
        events.push({ k: 'flag', a: 'back', t: f.team, p: f.carrier });
        homeFlag(s, f);
        continue;
      }
      f.x = c.x;
      f.y = c.y;
      f.z = c.z;
      const own = s.flags[c.team];
      if (own && own.carrier < 0 && Math.hypot(c.x - own.x, c.y - own.y) < C.FLAG_RADIUS && Math.abs(c.z - own.z) < 1.5) {
        events.push({ k: 'flag', a: 'cap', t: f.team, p: c.id });
        homeFlag(s, f);
        if (scoring) {
          s.teamScores[c.team]++;
          s.scores[c.id]++;
        }
      }
    } else {
      for (const p of s.players) {
        if (!p.inRound || p.falling || p.team === f.team) continue;
        if (Math.hypot(p.x - f.x, p.y - f.y) < C.FLAG_RADIUS && Math.abs(p.z - f.z) < 1.5) {
          f.carrier = p.id;
          events.push({ k: 'flag', a: 'take', t: f.team, p: p.id });
          break;
        }
      }
    }
  }
}

export function createGame(seed: number): GameState {
  return {
    tick: 0,
    phase: 'lobby',
    phaseTime: 0,
    playTime: 0,
    arenaRadius: C.ARENA_START_RADIUS,
    mapIndex: 0,
    mapChoice: -1,
    players: [],
    bullets: [],
    powerups: [],
    nextId: 1,
    scores: new Array<number>(C.MAX_PLAYERS).fill(0),
    roundWinner: null,
    matchWinner: null,
    powerupTimer: C.POWERUP_FIRST_DELAY,
    rng: seed >>> 0 || 1,
    noJump: false,
    teams: false,
    ctf: false,
    flags: [],
    turrets: [],
    bombIn: 0,
    koth: false,
    hill: null,
    hillScores: new Array<number>(C.MAX_PLAYERS).fill(0),
    teamScores: [0, 0],
    roundTeam: null,
    matchTeam: null,
  };
}

export function getPlayer(s: GameState, id: PlayerId): PlayerState | undefined {
  return s.players.find((p) => p.id === id);
}

/** Adds a player. In the lobby they join the warm-up; mid-match they watch until the next round. */
export function addPlayer(s: GameState, id: PlayerId, weapon = 0): void {
  if (getPlayer(s, id)) return;
  const p = createPlayer(id, WEAPONS[weapon] ? weapon : 0);
  // Team mode: join whichever team is short.
  p.team = teamSize(s, 1) < teamSize(s, 0) ? 1 : 0;
  s.players.push(p);
  s.players.sort((a, b) => a.id - b.id);
  if (s.phase === 'lobby') placeAll(s);
  else if ((s.ctf || s.koth) && (s.phase === 'countdown' || s.phase === 'playing')) {
    // Capture the flag and king of the hill have respawns, so late arrivals jump straight in.
    p.inRound = true;
    resetAtSpawn(s, p, 0, 1);
  }
}

export function removePlayer(s: GameState, id: PlayerId): void {
  s.players = s.players.filter((p) => p.id !== id);
  s.scores[id] = 0;
  if (s.phase === 'lobby') placeAll(s);
}

/** Are these two on the same team (team mode only)? */
export function allies(s: GameState, a: PlayerState, b: PlayerState): boolean {
  return s.teams && a.id !== b.id && a.team === b.team;
}

function teamSize(s: GameState, team: number): number {
  return s.players.filter((p) => p.team === team).length;
}

/** Evens the teams out, moving the newest players across as needed. */
function balanceTeams(s: GameState): void {
  for (;;) {
    const red = teamSize(s, 0);
    const blue = teamSize(s, 1);
    if (Math.abs(red - blue) <= 1) return;
    const from = red > blue ? 0 : 1;
    const mover = [...s.players].reverse().find((p) => p.team === from);
    if (!mover) return;
    mover.team = 1 - from;
  }
}

/** Switches team mode on or off (between matches). Turning it on splits everyone evenly. */
export function setTeams(s: GameState, on: boolean): void {
  if (!on) s.ctf = false;
  if (s.teams === on) {
    if (s.phase === 'lobby') placeAll(s);
    return;
  }
  s.teams = on;
  if (on) s.players.forEach((p, i) => (p.team = i % 2));
  if (s.phase === 'lobby') placeAll(s);
}

/** Switches king of the hill on or off (between matches). It works with or without teams. */
export function setKoth(s: GameState, on: boolean): void {
  if (on) s.ctf = false;
  if (s.koth === on) return;
  s.koth = on;
  if (s.phase === 'lobby') placeAll(s);
}

/** Switches capture the flag on or off (between matches). It's a team mode, so it turns teams on too. */
export function setCtf(s: GameState, on: boolean): void {
  if (on && !s.teams) setTeams(s, true);
  if (on) s.koth = false;
  if (s.ctf === on) return;
  s.ctf = on;
  if (s.phase === 'lobby') placeAll(s);
}

/** Team mode: moves a player to a team, in the lobby. */
export function setTeam(s: GameState, id: PlayerId, team: number): void {
  const p = getPlayer(s, id);
  if (!p || !s.teams || s.phase !== 'lobby' || (team !== 0 && team !== 1) || p.team === team) return;
  p.team = team;
  placeAll(s);
}

/** Picks a weapon. In the lobby it's yours right away; mid-match, from your next spawn. */
export function setWeapon(s: GameState, id: PlayerId, weapon: number): void {
  const p = getPlayer(s, id);
  if (!p || !WEAPONS[weapon]) return;
  p.nextWeapon = weapon;
  if (s.phase === 'lobby') {
    p.weapon = weapon;
    p.cooldown = 0;
  }
}

/**
 * Picks an offhand (knife or shock grenade). In the lobby it's yours right
 * away; mid-match, from your next spawn (so swapping can't skip a cooldown).
 */
export function setOffhand(s: GameState, id: PlayerId, offhand: number): void {
  const p = getPlayer(s, id);
  if (!p || !OFFHANDS[offhand]) return;
  p.nextOffhand = offhand;
  if (s.phase === 'lobby') {
    p.offhand = offhand;
    p.offCd = 0;
  }
}

/** Back to the lobby warm-up, on the picked map. Scores are kept for display until the next match. */
export function enterLobby(s: GameState): void {
  s.phase = 'lobby';
  s.phaseTime = 0;
  s.playTime = 0;
  s.arenaRadius = C.ARENA_START_RADIUS;
  s.mapIndex = s.mapChoice >= 0 ? s.mapChoice : 0;
  s.bullets = [];
  s.powerups = [];
  s.powerupTimer = C.POWERUP_FIRST_DELAY;
  s.roundWinner = null;
  s.matchWinner = null;
  s.roundTeam = null;
  s.matchTeam = null;
  placeAll(s);
}

/** Sets the map for the next rounds (-1 = random). In the lobby the warm-up switches to it right away. */
export function setMapChoice(s: GameState, choice: number): void {
  s.mapChoice = Number.isInteger(choice) && choice >= 0 && choice < MAPS.length ? choice : -1;
  if (s.phase === 'lobby') {
    s.mapIndex = s.mapChoice >= 0 ? s.mapChoice : 0;
    s.bullets = [];
    s.powerups = [];
    placeAll(s);
  }
}

/**
 * Starts a round on the picked map, or on random a new map (never the same
 * one twice in a row), and goes straight to the countdown.
 */
export function startRound(s: GameState): void {
  const n = MAPS.length;
  const isRandom = s.mapChoice < 0;
  if (isRandom) {
    let idx = Math.floor(random(s) * (n - 1));
    if (idx >= s.mapIndex) idx++;
    s.mapIndex = n > 1 ? idx % n : 0;
  } else {
    s.mapIndex = s.mapChoice;
  }
  s.arenaRadius = C.ARENA_START_RADIUS;
  s.playTime = 0;
  s.bullets = [];
  s.powerups = [];
  s.powerupTimer = C.POWERUP_FIRST_DELAY;
  s.roundWinner = null;
  s.roundTeam = null;
  s.bombIn = 0;
  // Someone left and a team is empty: even it out so there's a fight.
  if (s.teams && (teamSize(s, 0) === 0 || teamSize(s, 1) === 0)) balanceTeams(s);
  placeAll(s);
  s.phase = 'countdown';
  s.phaseTime = 0;
}

/** Resets scores and starts round one. */
export function startMatch(s: GameState): void {
  s.scores.fill(0);
  s.teamScores = [0, 0];
  s.hillScores.fill(0);
  s.matchWinner = null;
  s.matchTeam = null;
  startRound(s);
}

// ---------------------------------------------------------------------------
// Controls (shared with client prediction)
// ---------------------------------------------------------------------------

/**
 * Applies one tick of input to a player: look, fire, slide, climb, jump and
 * run. Returns true if a shot was fired this tick. The shot's recoil is
 * applied here; the caller spawns the bullets. Jumps, slides and climbs are
 * reported in `events` when given.
 */
/**
 * Where a grappling hook fired from (x, y, z) along d would bite: the first
 * roof, block or ramp within reach, or null if it hits nothing.
 */
export function hookRay(map: MapDef, arenaRadius: number, x: number, y: number, z: number, d: Vec3): Vec3 | null {
  for (let t = 1; t <= C.GRAPPLE_RANGE; t += 0.3) {
    const px = x + d.x * t;
    const py = y + d.y * t;
    const pz = z + d.z * t;
    if (pz < -1.5) return null;
    if (pz <= 0 && !isOffMap(map, arenaRadius, px, py)) return { x: px, y: py, z: 0 };
    if (inBlock(map, arenaRadius, px, py, pz)) return { x: px, y: py, z: pz };
  }
  return null;
}

/**
 * The grappling hook: a fresh press fires it along your aim; hold the button
 * to be reeled in (it carries some of your weight), let go to fly on with
 * the speed you've built up.
 */
function grapple(p: PlayerState, input: InputState, dt: number, canMove: boolean, map: MapDef | undefined, arenaRadius: number, events?: GameEvent[]): void {
  p.grappleCd = Math.max(0, p.grappleCd - dt);
  const press = input.grapple && !p.grappleHeld;
  p.grappleHeld = input.grapple;
  if (p.grappleT >= 0) {
    p.grappleT += dt;
    const dx = p.grappleX - p.x;
    const dy = p.grappleY - p.y;
    const dz = p.grappleZ - (p.z + 1);
    const dist = Math.hypot(dx, dy, dz) || 1e-6;
    if (!input.grapple || !canMove || p.grappleT > C.GRAPPLE_TIME || dist < C.GRAPPLE_LET_GO) {
      p.grappleT = -1;
      p.grappleCd = C.GRAPPLE_COOLDOWN;
      return;
    }
    const ux = dx / dist;
    const uy = dy / dist;
    const uz = dz / dist;
    const along = p.vx * ux + p.vy * uy + p.vz * uz;
    if (along < C.GRAPPLE_MAX_SPEED) {
      const a = Math.min(C.GRAPPLE_PULL * dt, C.GRAPPLE_MAX_SPEED - along);
      p.vx += ux * a;
      p.vy += uy * a;
      p.vz += uz * a;
    }
    p.vz += C.GRAVITY * 0.6 * dt;
    if (p.grounded && uz > 0.05) {
      p.grounded = false;
      p.vz = Math.max(p.vz, 3);
      p.slide = 0;
    }
    // Swinging on the rope gives you your double jump back.
    p.airJumped = false;
  } else if (press && canMove && p.grappleCd <= 0 && map) {
    const eyeZ = p.z + (p.slide > 0 ? C.SLIDE_EYE_HEIGHT : C.EYE_HEIGHT);
    const hit = hookRay(map, arenaRadius, p.x, p.y, eyeZ, aimDir(p.yaw, p.pitch));
    if (hit) {
      p.grappleX = hit.x;
      p.grappleY = hit.y;
      p.grappleZ = hit.z;
      p.grappleT = 0;
      events?.push({ k: 'hook', p: p.id, x: hit.x, y: hit.y, z: hit.z });
    } else p.grappleCd = 0.25;
  }
}

export function controlPlayer(
  p: PlayerState,
  input: InputState,
  dt: number,
  rules: Rules,
  events?: GameEvent[],
  map?: MapDef,
  arenaRadius: number = C.ARENA_START_RADIUS,
): boolean {
  const { canMove, canFire } = rules;
  // With the no-jump rule, the jump button does nothing: recoil is the way up.
  const jump = input.jump && !rules.noJump;
  const jumpPress = jump && !p.jumpHeld;
  p.jumpHeld = jump;
  if (p.falling) {
    p.grappleT = -1;
    return false;
  }
  const w = weaponDef(p.weapon);

  p.aiming = input.aim && canMove;
  p.yaw = wrapAngle(Number.isFinite(input.yaw) ? input.yaw : p.yaw);
  p.pitch = clamp(Number.isFinite(input.pitch) ? input.pitch : p.pitch, -C.PITCH_LIMIT, C.PITCH_LIMIT);
  p.cooldown = Math.max(0, p.cooldown - dt);

  // The knife is in your hand instead of the gun (knife players only).
  const knifeWas = p.knifeOut;
  p.knifeOut = input.knife && p.offhand === C.OFFHAND_KNIFE;
  p.recoilMode = input.recoil;
  // No aiming down sights with a knife.
  if (p.knifeOut) p.aiming = false;
  if (p.knifeOut !== knifeWas) events?.push({ k: 'draw', p: p.id, knife: p.knifeOut });

  // Shooting (or slashing, with the knife out). Semi-automatic guns need a
  // fresh click for each shot; automatic ones keep firing while held.
  let fired = false;
  const freshPress = input.firing && !p.fireHeld;
  p.fireHeld = input.firing;
  p.offCd = Math.max(0, p.offCd - dt);
  p.offUse = false;
  if (p.knifeOut) {
    if (canFire && input.firing && p.offCd <= 0) {
      // A slash whenever you like, one swing at a time. It lunges you forward
      // here (so your own prediction feels it at once); the tick resolves the hit.
      p.offUse = true;
      p.vx += Math.cos(p.yaw) * C.KNIFE_LUNGE;
      p.vy += Math.sin(p.yaw) * C.KNIFE_LUNGE;
      p.offCd = C.KNIFE_SWING;
    }
  } else if (canFire && p.cooldown <= 0 && (w.mode === 'auto' ? input.firing : freshPress)) {
    fired = true;
    p.cooldown = w.cooldown * (p.rapid > 0 ? 0.5 : 1);
  }
  if (fired) {
    // A kick opposite where you aim: small normally, huge in recoil mode.
    const d = aimDir(p.yaw, p.pitch);
    const kick = p.recoilMode ? w.boost : w.recoil;
    p.vx -= d.x * kick;
    p.vy -= d.y * kick;
    p.vz -= d.z * kick;
    if (p.vz > 0) p.grounded = false;
  }

  // The shock grenade: a fresh press of the offhand throws one when ready.
  // (Knife players use the offhand button to pull the knife out instead.)
  if (canFire && p.offhand === C.OFFHAND_SHOCK && input.offhand && !p.offHeld && p.offCd <= 0) {
    p.offUse = true;
    p.offCd = C.SHOCK_COOLDOWN;
  }
  p.offHeld = input.offhand;

  grapple(p, input, dt, canMove, map, arenaRadius, events);

  // Crouch while moving on the ground slides: tap it, or hold it through a
  // landing. One slide per hold; letting go (or jumping) re-arms it, so you
  // can hold crouch and slide-hop. A slide runs its course unless you leave the ground.
  p.slideCd = Math.max(0, p.slideCd - dt);
  if (p.slide > 0) {
    p.slide = Math.max(0, p.slide - dt);
    if (!p.grounded || !canMove) p.slide = 0;
    if (p.slide === 0) p.slideCd = C.SLIDE_COOLDOWN;
  }
  if (!input.crouch || !p.grounded) p.slideLock = false;
  const flat = Math.hypot(p.vx, p.vy);
  if (canMove && input.crouch && !p.slideLock && p.grounded && p.slide <= 0 && p.slideCd <= 0 && flat > C.SLIDE_MIN_SPEED) {
    // Always a clear kick over your current speed, up to a cap.
    const k = Math.max(flat, Math.min(Math.max(flat + C.SLIDE_BOOST, C.SLIDE_SPEED), C.SLIDE_MAX)) / flat;
    p.vx *= k;
    p.vy *= k;
    p.slide = C.SLIDE_TIME;
    p.slideLock = true;
    events?.push({ k: 'slide', p: p.id });
  }

  if (!canMove) {
    if (p.grounded) {
      p.vx = 0;
      p.vy = 0;
    }
    return fired;
  }

  // Wish direction from the keys, turned to face where you look.
  let f = clamp(input.forward, -1, 1);
  let r = clamp(input.strafe, -1, 1);
  const len = Math.hypot(f, r);
  if (len > 1) {
    f /= len;
    r /= len;
  }
  const cy = Math.cos(p.yaw);
  const sy = Math.sin(p.yaw);
  // Forward is (cos yaw, sin yaw); right is (sin yaw, -cos yaw).
  const wx = cy * f + sy * r;
  const wy = sy * f - cy * r;
  const wishing = len > 0;
  const target = runSpeed(p, input);

  // Climb: pushing forward into a ledge you can reach, and jumping (or already in the air).
  if (p.wallTop >= 0 && f > 0 && (jump || !p.grounded) && p.vz < 4) {
    const rise = p.wallTop - p.z;
    const facing = -(wx * p.wallNx + wy * p.wallNy);
    if (rise > C.STEP_HEIGHT && rise <= C.MANTLE_MAX && facing > 0.3) {
      p.vz = Math.sqrt(2 * C.GRAVITY * (rise + 0.35));
      p.vx = -p.wallNx * 3.5;
      p.vy = -p.wallNy * 3.5;
      p.grounded = false;
      p.slide = 0;
      p.wallTop = -1;
      events?.push({ k: 'mantle', p: p.id });
      return fired;
    }
  }

  if (p.grounded) {
    p.airJumped = false;
    const speed = Math.hypot(p.vx, p.vy);
    if (p.slide > 0) {
      // Sliding: keep your speed a while, steer a little.
      const decay = Math.exp(-C.SLIDE_DECAY * dt);
      p.vx *= decay;
      p.vy *= decay;
      if (wishing) {
        p.vx += wx * C.SLIDE_ACCEL * 0.5 * dt;
        p.vy += wy * C.SLIDE_ACCEL * 0.5 * dt;
      }
    } else if (speed <= target * 1.05) {
      // Running: move the velocity straight towards the wish velocity.
      const tx = wx * target - p.vx;
      const ty = wy * target - p.vy;
      const dist = Math.hypot(tx, ty);
      const step = C.GROUND_ACCEL * dt;
      if (dist <= step) {
        p.vx = wx * target;
        p.vy = wy * target;
      } else {
        p.vx += (tx / dist) * step;
        p.vy += (ty / dist) * step;
      }
    } else {
      // Skidding after a knockback, a boost or a slide: the extra speed bleeds away.
      const decay = Math.exp(-C.SLIDE_FRICTION * dt);
      const k = Math.max(decay, (target * 0.9) / speed);
      p.vx *= k;
      p.vy *= k;
      if (wishing) {
        p.vx += wx * C.SLIDE_ACCEL * dt;
        p.vy += wy * C.SLIDE_ACCEL * dt;
      }
    }
    if (jump && p.vz <= 0) {
      // Jumping out of a slide keeps its speed: slide-hop.
      p.vz = C.JUMP_SPEED;
      p.grounded = false;
      if (p.slide > 0) p.slideCd = C.SLIDE_COOLDOWN;
      p.slide = 0;
      events?.push({ k: 'jump', p: p.id });
    }
  } else {
    if (jumpPress && !p.airJumped && p.grappleT < 0) {
      // Double jump: once in the air, with a nudge towards where you steer.
      p.airJumped = true;
      p.vz = Math.max(p.vz, C.AIR_JUMP_SPEED);
      if (wishing) {
        p.vx += wx * C.AIR_JUMP_NUDGE;
        p.vy += wy * C.AIR_JUMP_NUDGE;
      }
      events?.push({ k: 'jump', p: p.id, air: true });
    }
    const drag = Math.exp(-C.AIR_DRAG * dt);
    p.vx *= drag;
    p.vy *= drag;
    if (wishing) {
      // Quake-style air control: add speed along the wish direction up to running speed.
      const along = p.vx * wx + p.vy * wy;
      const add = Math.min(C.AIR_ACCEL * dt, target - along);
      if (add > 0) {
        p.vx += wx * add;
        p.vy += wy * add;
      }
    }
  }
  return fired;
}

/**
 * Moves a player for one physics substep: gravity, the roof and blocks
 * underfoot, block sides, the walls under the roof's edges, bumper pillars
 * and jump pads. Shared with client prediction.
 */
export function movePlayer(p: PlayerState, h: number, map: MapDef, arenaRadius: number, events?: GameEvent[]): void {
  if (p.falling) {
    p.vz -= C.GRAVITY * h;
    p.x += p.vx * h;
    p.y += p.vy * h;
    p.z += p.vz * h;
    return;
  }

  const speed = Math.hypot(p.vx, p.vy, p.vz);
  if (speed > C.MAX_PLAYER_SPEED) {
    const k = C.MAX_PLAYER_SPEED / speed;
    p.vx *= k;
    p.vy *= k;
    p.vz *= k;
  }

  if (p.grounded) {
    const under = floorAt(map, arenaRadius, p.x, p.y, p.z + C.STEP_HEIGHT);
    if (p.vz > 0 || under < p.z - 0.05) p.grounded = false;
  }
  if (!p.grounded) p.vz -= C.GRAVITY * h;

  const px = p.x;
  const py = p.y;
  const pz = p.z;
  p.x += p.vx * h;
  p.y += p.vy * h;
  p.z += p.vz * h;

  // Bump your head on a roof or bridge you jump up into.
  const blocks = scaledBlocks(map, arenaRadius);
  if (p.vz > 0) {
    for (const b of blocks) {
      if (b.bottom <= 0) continue;
      const inside = p.x > b.minX && p.x < b.maxX && p.y > b.minY && p.y < b.maxY;
      if (inside && p.z + C.PLAYER_HEIGHT > b.bottom && pz + C.PLAYER_HEIGHT <= b.bottom + 0.05) {
        p.z = b.bottom - C.PLAYER_HEIGHT;
        p.vz = 0;
      }
    }
  }

  // Block sides: push out, and remember the ledge for climbing. A slab only
  // gets in the way if it overlaps you top to bottom (you walk under roofs).
  let touched = false;
  const sides: { minX: number; maxX: number; minY: number; maxY: number; top: number; low: boolean }[] = [];
  for (const b of blocks) {
    if (p.z >= b.top - C.STEP_HEIGHT || p.z + C.PLAYER_HEIGHT <= b.bottom) continue;
    sides.push({ ...b, low: false });
  }
  // Ramps are walls from the side and the tall end, and a slope from the low end.
  for (const r of scaledRamps(map, arenaRadius)) {
    const top = rampHeight(r, clamp(p.x, r.minX, r.maxX), clamp(p.y, r.minY, r.maxY));
    if (p.z >= top - C.STEP_HEIGHT || p.z + C.PLAYER_HEIGHT <= r.base) continue;
    sides.push({ minX: r.minX, maxX: r.maxX, minY: r.minY, maxY: r.maxY, top: r.h, low: true });
  }
  for (const b of sides) {
    const cx = clamp(p.x, b.minX, b.maxX);
    const cy = clamp(p.y, b.minY, b.maxY);
    let nx = p.x - cx;
    let ny = p.y - cy;
    let d = Math.hypot(nx, ny);
    if (d >= C.PLAYER_RADIUS) continue;
    if (d < 1e-6) {
      // Centre inside the box: leave by the nearest side.
      const exits = [
        [p.x - b.minX, -1, 0],
        [b.maxX - p.x, 1, 0],
        [p.y - b.minY, 0, -1],
        [b.maxY - p.y, 0, 1],
      ].sort((a, c) => a[0] - c[0])[0];
      nx = exits[1];
      ny = exits[2];
      d = -exits[0];
    } else {
      nx /= d;
      ny /= d;
    }
    const push = C.PLAYER_RADIUS - d;
    p.x += nx * push;
    p.y += ny * push;
    const vn = p.vx * nx + p.vy * ny;
    if (vn < 0) {
      p.vx -= vn * nx;
      p.vy -= vn * ny;
    }
    if (!b.low && (!touched || b.top > p.wallTop)) {
      p.wallTop = b.top;
      p.wallNx = nx;
      p.wallNy = ny;
      touched = true;
    }
  }
  if (!touched) p.wallTop = -1;

  if (p.grounded) {
    // Stay on the floor, stepping up onto low things.
    const floor = floorAt(map, arenaRadius, p.x, p.y, p.z + C.STEP_HEIGHT);
    if (floor > -Infinity) {
      p.z = Math.max(p.z, floor);
      if (floor > pz - 0.05) p.z = floor;
    }
    p.vz = 0;
  } else {
    const floor = floorAt(map, arenaRadius, p.x, p.y, Math.max(pz, p.z) + C.STEP_HEIGHT);
    if (p.vz <= 0 && floor > -Infinity && p.z <= floor && pz >= floor - 0.35) {
      // Landed.
      p.z = floor;
      p.vz = 0;
      p.grounded = true;
    } else if (p.z < -0.35 && !isOffMap(map, arenaRadius, p.x, p.y)) {
      // Below the roof, inside a hole or past the edge: the building's walls stop you.
      p.x = px;
      p.y = py;
      p.vx *= -0.2;
      p.vy *= -0.2;
    }
  }

  // Bumper pillars push you away, like pinball.
  if (p.z < C.BUMPER_HEIGHT) {
    for (const bp of scaledBumpers(map, arenaRadius)) {
      const dx = p.x - bp.x;
      const dy = p.y - bp.y;
      const dist = Math.hypot(dx, dy) || 1e-6;
      const min = bp.r + C.PLAYER_RADIUS;
      if (dist >= min) continue;
      const nx = dx / dist;
      const ny = dy / dist;
      p.x = bp.x + nx * min;
      p.y = bp.y + ny * min;
      const vn = p.vx * nx + p.vy * ny;
      if (vn < 0) {
        p.vx -= (1 + C.BUMPER_RESTITUTION) * vn * nx;
        p.vy -= (1 + C.BUMPER_RESTITUTION) * vn * ny;
        if (-vn > 1.5) events?.push({ k: 'bump', p: p.id, q: -1, x: bp.x + nx * bp.r, y: bp.y + ny * bp.r, z: p.z + 1, f: -vn });
      }
      const out = p.vx * nx + p.vy * ny;
      if (out < C.BUMPER_MIN_BOUNCE) {
        p.vx += (C.BUMPER_MIN_BOUNCE - out) * nx;
        p.vy += (C.BUMPER_MIN_BOUNCE - out) * ny;
      }
    }
  }

  // Jump pads.
  if (p.grounded && p.z < 0.05) {
    for (const pad of scaledPads(map, arenaRadius)) {
      if (Math.hypot(p.x - pad.x, p.y - pad.y) >= pad.r) continue;
      p.vz = pad.v ?? C.PAD_SPEED;
      p.vx *= C.PAD_BOOST;
      p.vy *= C.PAD_BOOST;
      p.grounded = false;
      p.slide = 0;
      events?.push({ k: 'pad', p: p.id, x: pad.x, y: pad.y });
      break;
    }
  }
}

/** True once a player has dropped too far below the roof to get back. */
export function hasFallen(p: PlayerState): boolean {
  return !p.falling && p.z < C.FALL_Z;
}

// ---------------------------------------------------------------------------
// Shooting and power-ups
// ---------------------------------------------------------------------------

function spawnBullets(s: GameState, p: PlayerState, events: GameEvent[]): void {
  const w = weaponDef(p.weapon);
  let { radius, knockback, damage } = w;
  if (p.mega > 0) {
    radius *= C.MEGA_RADIUS_MULT;
    knockback *= C.MEGA_KNOCKBACK_MULT;
    damage *= C.MEGA_DAMAGE_MULT;
    p.mega--;
  }
  const volleys = p.triple > 0 ? [-C.TRIPLE_SPREAD, 0, C.TRIPLE_SPREAD] : [0];
  const offset = C.PLAYER_RADIUS + radius + C.MUZZLE_GAP;
  const eyeZ = p.z + (p.slide > 0 ? C.SLIDE_EYE_HEIGHT : C.EYE_HEIGHT);
  for (const volley of volleys) {
    for (let i = 0; i < w.pellets; i++) {
      // Pellets scatter in a cone; single-shot guns only wobble by their spread.
      const spread = w.spread * (p.aiming ? C.AIM_SPREAD_MULT : 1);
      const u = spread > 0 ? (random(s) * 2 - 1) * spread : 0;
      const v = spread > 0 ? (random(s) * 2 - 1) * spread * 0.7 : 0;
      const d = aimDir(p.yaw + volley + u, p.pitch + v);
      s.bullets.push({
        id: s.nextId++,
        owner: p.id,
        team: p.team,
        weapon: p.weapon,
        x: p.x + d.x * offset,
        y: p.y + d.y * offset,
        z: eyeZ + d.z * offset,
        vx: d.x * w.speed,
        vy: d.y * w.speed,
        vz: d.z * w.speed,
        radius,
        knockback,
        damage,
        age: 0,
      });
    }
  }
  const d = aimDir(p.yaw, p.pitch);
  events.push({ k: 'fire', p: p.id, w: p.weapon, x: p.x + d.x * offset, y: p.y + d.y * offset, z: eyeZ + d.z * offset, a: p.yaw, b: p.pitch });
}

/** Resolves an offhand use: a knife slash in front of you, or a thrown shock grenade. */
function useOffhand(s: GameState, p: PlayerState, events: GameEvent[]): void {
  const eyeZ = p.z + (p.slide > 0 ? C.SLIDE_EYE_HEIGHT : C.EYE_HEIGHT);
  if (p.offhand === C.OFFHAND_KNIFE) {
    const fx = Math.cos(p.yaw);
    const fy = Math.sin(p.yaw);
    let hit = false;
    for (const q of s.players) {
      if (q.id === p.id || !q.inRound || q.falling || allies(s, p, q)) continue;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const flat = Math.hypot(dx, dy);
      const dz = q.z + C.PLAYER_HEIGHT / 2 - (p.z + C.PLAYER_HEIGHT / 2);
      if (flat > C.KNIFE_RANGE + C.PLAYER_RADIUS || Math.abs(dz) > 1.6) continue;
      // In front of you (anyone overlapping you counts too).
      if (flat > C.PLAYER_RADIUS * 2 && (dx * fx + dy * fy) / flat < C.KNIFE_CONE) continue;
      hit = true;
      const cz = q.z + C.PLAYER_HEIGHT / 2;
      if (q.shield > 0) {
        q.shield = 0;
        events.push({ k: 'block', p: q.id, x: q.x, y: q.y, z: cz });
        continue;
      }
      const impulse = C.KNIFE_KNOCKBACK * (1 + q.damage / C.DAMAGE_SCALE);
      knock(q, flat > 1e-3 ? dx : fx, flat > 1e-3 ? dy : fy, 0.35, impulse);
      q.damage += C.KNIFE_DAMAGE;
      events.push({ k: 'hit', p: q.id, o: p.id, x: q.x, y: q.y, z: cz, f: impulse, d: C.KNIFE_DAMAGE });
    }
    events.push({ k: 'melee', p: p.id, x: p.x + fx * 0.8, y: p.y + fy * 0.8, z: eyeZ - 0.3, a: p.yaw, hit });
    return;
  }
  // Shock grenade: lobbed from the eye, carrying some of your own speed.
  const w = weaponDef(SHOCK_WEAPON);
  const d = aimDir(p.yaw, Math.min(C.PITCH_LIMIT, p.pitch + C.SHOCK_LOFT));
  const offset = C.PLAYER_RADIUS + w.radius + C.MUZZLE_GAP;
  s.bullets.push({
    id: s.nextId++,
    owner: p.id,
    team: p.team,
    weapon: SHOCK_WEAPON,
    x: p.x + d.x * offset,
    y: p.y + d.y * offset,
    z: eyeZ + d.z * offset,
    vx: d.x * w.speed + p.vx * 0.5,
    vy: d.y * w.speed + p.vy * 0.5,
    vz: d.z * w.speed + Math.max(0, p.vz) * 0.5,
    radius: w.radius,
    knockback: w.knockback,
    damage: w.damage,
    age: 0,
  });
  events.push({ k: 'throw', p: p.id });
}

function applyPowerup(p: PlayerState, kind: PowerupKind): void {
  switch (kind) {
    case 'rapid':
      p.rapid = C.RAPID_TIME;
      break;
    case 'triple':
      p.triple = C.TRIPLE_TIME;
      break;
    case 'mega':
      p.mega = C.MEGA_SHOTS;
      break;
    case 'shield':
      p.shield = C.SHIELD_TIME;
      break;
    case 'heal':
      p.damage = 0;
      break;
    case 'speed':
      p.speed = C.SPEED_TIME;
      break;
  }
}

function updatePowerups(s: GameState, dt: number, events: GameEvent[]): void {
  const map = currentMap(s);
  const R = s.arenaRadius;
  const bumpers = scaledBumpers(map, R);
  const pads = scaledPads(map, R);

  for (const u of s.powerups) u.age += dt;
  s.powerups = s.powerups.filter((u) => u.age < C.POWERUP_LIFETIME && !isOffMap(map, R, u.x, u.y));

  // Pickups.
  const taken = new Set<number>();
  for (const u of s.powerups) {
    for (const p of s.players) {
      if (!p.inRound || p.falling) continue;
      const dz = C.POWERUP_HEIGHT - p.z;
      if (dz < -0.5 || dz > C.PLAYER_HEIGHT + 0.5) continue;
      if (Math.hypot(p.x - u.x, p.y - u.y) < C.PLAYER_RADIUS + C.POWERUP_RADIUS) {
        applyPowerup(p, u.kind);
        taken.add(u.id);
        events.push({ k: 'pickup', p: p.id, u: u.kind, x: u.x, y: u.y });
        break;
      }
    }
  }
  if (taken.size > 0) s.powerups = s.powerups.filter((u) => !taken.has(u.id));

  // Spawns.
  s.powerupTimer -= dt;
  if (s.powerupTimer > 0) return;
  s.powerupTimer = lerp(C.POWERUP_INTERVAL[0], C.POWERUP_INTERVAL[1], random(s));
  if (s.powerups.length >= C.POWERUP_MAX) return;
  const edge = C.POWERUP_RADIUS + 0.5;
  for (let tries = 0; tries < 12; tries++) {
    const a = random(s) * Math.PI * 2;
    const r = Math.sqrt(random(s)) * R * 0.72;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (isOffMap(map, R, x, y)) continue;
    // Keep clear of hole edges, bumpers, blocks, pads and players.
    if (isOffMap(map, R, x + edge, y) || isOffMap(map, R, x - edge, y) || isOffMap(map, R, x, y + edge) || isOffMap(map, R, x, y - edge)) continue;
    if (bumpers.some((b) => Math.hypot(x - b.x, y - b.y) < b.r + edge)) continue;
    if (pads.some((b) => Math.hypot(x - b.x, y - b.y) < b.r + edge)) continue;
    if (inBlock(map, R, x, y, 0, edge)) continue;
    if (s.players.some((p) => p.inRound && Math.hypot(x - p.x, y - p.y) < 3)) continue;
    const kind = POWERUP_KINDS[Math.floor(random(s) * POWERUP_KINDS.length)];
    s.powerups.push({ id: s.nextId++, kind, x, y, age: 0 });
    events.push({ k: 'spawn', u: kind, x, y });
    return;
  }
}

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------

/** Squared distance from a point to a player's body (a vertical capsule; shorter while sliding). */
function capsuleDist2(p: PlayerState, x: number, y: number, z: number): number {
  const height = p.slide > 0 ? C.SLIDE_EYE_HEIGHT + 0.3 : C.PLAYER_HEIGHT;
  const lo = p.z + C.PLAYER_RADIUS;
  const hi = p.z + Math.max(C.PLAYER_RADIUS, height - C.PLAYER_RADIUS);
  const cz = clamp(z, lo, hi);
  const dx = x - p.x;
  const dy = y - p.y;
  const dz = z - cz;
  return dx * dx + dy * dy + dz * dz;
}

/** Pushes a player by an impulse along a direction and adds damage. */
function knock(p: PlayerState, dx: number, dy: number, dz: number, impulse: number): void {
  const flat = Math.hypot(dx, dy);
  const len = Math.hypot(dx, dy, dz) || 1;
  if (flat > 1e-6) {
    // Knocked along the direction, and always a little off your feet.
    const k = impulse * Math.max(0.6, flat / len);
    p.vx += (dx / flat) * k;
    p.vy += (dy / flat) * k;
  }
  p.vz += impulse * C.KNOCKBACK_LIFT + Math.max(0, (dz / len) * impulse);
  p.grounded = false;
  p.slide = 0;
}

/** A bomb bursting: everyone nearby is thrown away from it, the shooter too (without damage). */
function explode(s: GameState, b: Bullet, x: number, y: number, z: number, events: GameEvent[]): void {
  const radius = weaponDef(b.weapon).splash;
  events.push({ k: 'boom', p: b.owner, x, y, z, r: radius, w: b.weapon });
  if (b.owner >= 0) {
    const spots = scaledTurrets(currentMap(s), s.arenaRadius);
    spots.forEach((at, i) => {
      const d = Math.hypot(at.x - x, at.y - y, at.z - z);
      if (d < radius + C.TURRET_RADIUS) damageTurret(s, i, b.damage * 2 * Math.max(0.3, 1 - d / radius), events);
    });
  }
  for (const p of s.players) {
    if (!p.inRound || p.falling) continue;
    const cz = p.z + C.PLAYER_HEIGHT / 2;
    const dx = p.x - x;
    const dy = p.y - y;
    const dz = cz - z;
    const d = Math.hypot(dx, dy, dz);
    if (d >= radius) continue;
    const falloff = 1 - d / radius;
    if (p.id === b.owner) {
      knock(p, dx, dy, dz + 0.5, b.knockback * falloff * C.SELF_SPLASH);
      continue;
    }
    if (s.teams && p.team === b.team) continue;
    if (p.shield > 0) {
      p.shield = 0;
      events.push({ k: 'block', p: p.id, x: p.x, y: p.y, z: cz });
      continue;
    }
    const impulse = b.knockback * falloff * (1 + p.damage / C.DAMAGE_SCALE);
    knock(p, dx, dy, dz + 0.3, impulse);
    p.damage += b.damage * falloff;
    events.push({ k: 'hit', p: p.id, o: b.owner, x: p.x, y: p.y, z: cz, f: impulse, d: b.damage * falloff });
  }
}

/**
 * Moves one bullet for a substep, in small hops so even the fastest shots
 * can't skip past a player. Returns false once the bullet is gone.
 */
function moveBullet(s: GameState, b: Bullet, h: number, standing: PlayerState[], events: GameEvent[]): boolean {
  const map = currentMap(s);
  const R = s.arenaRadius;
  const w = weaponDef(b.weapon);
  b.vz -= w.gravity * h;
  const hops = Math.max(1, Math.ceil((Math.hypot(b.vx, b.vy, b.vz) * h) / 0.3));
  const hh = h / hops;
  for (let n = 0; n < hops; n++) {
    b.x += b.vx * hh;
    b.y += b.vy * hh;
    b.z += b.vz * hh;

    // Turrets (players' shots only).
    if (b.owner >= 0 && s.turrets.length > 0) {
      const ti = turretAt(s, b.x, b.y, b.z, b.radius);
      if (ti >= 0) {
        if (w.splash > 0) explode(s, b, b.x, b.y, b.z, events);
        else {
          damageTurret(s, ti, b.damage, events);
          events.push({ k: 'cancel', x: b.x, y: b.y, z: b.z, r: b.radius });
        }
        return false;
      }
    }

    // Players. A piercing shot hits each one once and carries on.
    for (const p of standing) {
      if (p.id === b.owner || (s.teams && p.team === b.team)) continue;
      if (w.pierce && b.hits?.includes(p.id)) continue;
      const rr = C.PLAYER_RADIUS + b.radius;
      if (capsuleDist2(p, b.x, b.y, b.z) >= rr * rr) continue;
      if (w.splash > 0) {
        explode(s, b, b.x, b.y, b.z, events);
        return false;
      }
      if (p.shield > 0) {
        p.shield = 0;
        events.push({ k: 'block', p: p.id, x: b.x, y: b.y, z: b.z });
        if (w.pierce) {
          (b.hits ??= []).push(p.id);
          continue;
        }
        return false;
      }
      const impulse = b.knockback * (1 + p.damage / C.DAMAGE_SCALE);
      knock(p, b.vx, b.vy, b.vz, impulse);
      p.damage += b.damage;
      events.push({ k: 'hit', p: p.id, o: b.owner, x: b.x, y: b.y, z: b.z, f: impulse, d: b.damage });
      if (w.pierce) {
        (b.hits ??= []).push(p.id);
        continue;
      }
      return false;
    }

    // Blocks and the roof.
    const onRoof = b.z < b.radius * 0.5 && b.z > -1.5 && !isOffMap(map, R, b.x, b.y);
    const inWall = !onRoof && inBlock(map, R, b.x, b.y, b.z, b.radius * 0.5);
    if (w.bounce && (onRoof || inWall)) {
      // Grenades bounce: step back out, then flip whichever way it hit.
      b.x -= b.vx * hh;
      b.y -= b.vy * hh;
      b.z -= b.vz * hh;
      const floor = floorAt(map, R, b.x, b.y, b.z + 0.05);
      if (onRoof || (floor > -Infinity && b.z - floor < 0.3 && b.vz < 0)) {
        b.vz = -b.vz * w.bounce;
        b.vx *= 0.7;
        b.vy *= 0.7;
      } else if (inBlock(map, R, b.x + b.vx * hh, b.y, b.z, b.radius * 0.5)) {
        b.vx = -b.vx * w.bounce;
      } else {
        b.vy = -b.vy * w.bounce;
      }
      continue;
    }
    if (onRoof || inWall) {
      if (w.splash > 0) explode(s, b, b.x, b.y, Math.max(b.z, 0.05), events);
      else events.push({ k: 'cancel', x: b.x, y: b.y, z: Math.max(b.z, 0.05), r: b.radius });
      return false;
    }

    // Bumper pillars bounce bullets.
    if (b.z < C.BUMPER_HEIGHT) {
      for (const bp of scaledBumpers(map, R)) {
        const dx = b.x - bp.x;
        const dy = b.y - bp.y;
        const dist = Math.hypot(dx, dy) || 1e-6;
        const min = bp.r + b.radius;
        if (dist >= min) continue;
        const nx = dx / dist;
        const ny = dy / dist;
        b.x = bp.x + nx * min;
        b.y = bp.y + ny * min;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          b.vx -= 2 * vn * nx;
          b.vy -= 2 * vn * ny;
        }
      }
    }
  }
  return true;
}

function integrate(s: GameState, h: number, events: GameEvent[]): void {
  const map = currentMap(s);
  const R = s.arenaRadius;
  const active = s.players.filter((p) => p.inRound);
  for (const p of active) movePlayer(p, h, map, R, events);

  const standing = active.filter((p) => !p.falling);
  for (let i = 0; i < standing.length; i++) {
    for (let j = i + 1; j < standing.length; j++) collidePlayers(standing[i], standing[j], events);
  }

  const dead = new Set<number>();
  for (const b of s.bullets) if (!moveBullet(s, b, h, standing, events)) dead.add(b.id);

  // Bullets from different players cancel each other out.
  for (let a = 0; a < s.bullets.length; a++) {
    const ba = s.bullets[a];
    if (dead.has(ba.id)) continue;
    for (let c = a + 1; c < s.bullets.length; c++) {
      const bb = s.bullets[c];
      if (dead.has(bb.id) || bb.owner === ba.owner || (s.teams && bb.team === ba.team)) continue;
      // Sudden-death bombs can't be shot down.
      if (ba.weapon === BOMB_WEAPON || bb.weapon === BOMB_WEAPON) continue;
      const rr = ba.radius + bb.radius;
      const dx = bb.x - ba.x;
      const dy = bb.y - ba.y;
      const dz = bb.z - ba.z;
      if (dx * dx + dy * dy + dz * dz < rr * rr) {
        dead.add(ba.id);
        dead.add(bb.id);
        events.push({ k: 'cancel', x: (ba.x + bb.x) / 2, y: (ba.y + bb.y) / 2, z: (ba.z + bb.z) / 2, r: Math.max(ba.radius, bb.radius) });
        break;
      }
    }
  }

  if (dead.size > 0) s.bullets = s.bullets.filter((b) => !dead.has(b.id));
}

function collidePlayers(a: PlayerState, b: PlayerState, events: GameEvent[]): void {
  if (Math.abs(a.z - b.z) >= C.PLAYER_HEIGHT) return;
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let dist = Math.hypot(dx, dy);
  const minDist = C.PLAYER_RADIUS * 2;
  if (dist >= minDist) return;
  if (dist < 1e-6) {
    dx = 1;
    dy = 0;
    dist = 1e-6;
  }
  const nx = dx / dist;
  const ny = dy / dist;
  // Push apart so they no longer overlap.
  const overlap = (minDist - dist) / 2;
  a.x -= nx * overlap;
  a.y -= ny * overlap;
  b.x += nx * overlap;
  b.y += ny * overlap;
  // Equal-mass impulse along the contact normal.
  const approach = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  if (approach <= 0) return;
  const j = ((1 + C.PLAYER_RESTITUTION) * approach) / 2;
  a.vx -= nx * j;
  a.vy -= ny * j;
  b.vx += nx * j;
  b.vy += ny * j;
  if (j > 1.5) {
    events.push({ k: 'bump', p: a.id, q: b.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 + 1, f: j });
  }
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

/**
 * Advances the game by one tick and returns what happened. Mutates `s`.
 * `inputs` maps each player id to their input for this tick; missing ids get no input.
 */
export function step(s: GameState, inputs: ReadonlyMap<PlayerId, InputState>, dt: number = C.TICK_DT): GameEvent[] {
  const events: GameEvent[] = [];
  s.tick++;
  s.phaseTime += dt;

  const lobby = s.phase === 'lobby';
  const playing = s.phase === 'playing';
  const rules = phaseRules(s.phase, s.noJump);

  for (const p of s.players) {
    if (!p.inRound) continue;
    const input = inputs.get(p.id) ?? { ...NO_INPUT, yaw: p.yaw, pitch: p.pitch };
    if (controlPlayer(p, input, dt, rules, events, currentMap(s), s.arenaRadius)) spawnBullets(s, p, events);
    if (p.offUse) useOffhand(s, p, events);
    p.rapid = Math.max(0, p.rapid - dt);
    p.triple = Math.max(0, p.triple - dt);
    p.shield = Math.max(0, p.shield - dt);
    p.speed = Math.max(0, p.speed - dt);
  }

  if (playing) {
    s.playTime += dt;
    // Capture the flag keeps the whole roof: the bases stay put.
    if (!s.ctf && !s.koth) s.arenaRadius = arenaRadiusAt(s.playTime);
  }
  if (lobby || playing) updatePowerups(s, dt, events);
  if (lobby || playing) updateTurrets(s, dt, events);
  if (playing && !s.ctf && !s.koth) updateBombs(s, dt, events);

  const h = dt / C.PHYSICS_SUBSTEPS;
  for (let n = 0; n < C.PHYSICS_SUBSTEPS; n++) integrate(s, h, events);

  const cullRadius = s.arenaRadius + C.BULLET_CULL_MARGIN;
  s.bullets = s.bullets.filter((b) => {
    b.age += dt;
    const w = weaponDef(b.weapon);
    if (b.age >= w.lifetime) {
      // Grenades burst when their fuse runs out; bullets just fizzle.
      if (w.fuse) explode(s, b, b.x, b.y, b.z, events);
      return false;
    }
    return Math.hypot(b.x, b.y) < cullRadius && b.z > -30;
  });

  // Falling off the edge or into a hole.
  const inRound = s.players.filter((p) => p.inRound);
  for (const p of inRound) {
    if (p.falling) {
      p.fallTime += dt;
      // Back on the roof after a moment in the warm-up and in capture the flag.
      const wait = lobby ? C.LOBBY_RESPAWN_DELAY : playing && (s.ctf || s.koth) ? C.CTF_RESPAWN_DELAY : -1;
      if (wait >= 0 && p.fallTime > C.FALL_DURATION + wait) {
        resetAtSpawn(s, p, p.spawnIndex, inRound.length);
        events.push({ k: 'respawn', p: p.id });
      }
    } else if (hasFallen(p)) {
      p.falling = true;
      p.fallTime = 0;
      p.slide = 0;
      events.push({ k: 'fall', p: p.id, x: p.x, y: p.y });
    }
  }

  if (s.ctf && (lobby || playing)) updateFlags(s, events, playing);
  if (s.koth && (lobby || playing)) updateHill(s, dt, events, playing);

  if (playing && s.koth) {
    // King of the hill: first to HILL_WIN seconds on the hill, or the most when time runs out.
    const n = s.teams ? 2 : C.MAX_PLAYERS;
    let best = -1;
    let tie = false;
    for (let i = 0; i < n; i++) {
      if (!s.teams && !getPlayer(s, i)) continue;
      if (best < 0 || s.hillScores[i] > s.hillScores[best]) {
        best = i;
        tie = false;
      } else if (s.hillScores[i] === s.hillScores[best]) tie = true;
    }
    const won = best >= 0 && s.hillScores[best] >= C.HILL_WIN;
    if (won || s.playTime >= C.HILL_TIME) {
      const winner = best < 0 || (tie && !won) ? -1 : best;
      if (s.teams) {
        s.roundTeam = winner;
        s.matchTeam = winner;
        s.roundWinner = -1;
        s.matchWinner = -1;
      } else {
        s.roundWinner = winner;
        s.matchWinner = winner;
        if (winner >= 0) s.scores[winner] = Math.min(C.WIN_SCORE, s.scores[winner] + 1);
      }
      s.phase = 'matchEnd';
      s.phaseTime = 0;
      events.push({ k: 'ko', w: s.teams ? -1 : winner });
    }
  } else if (playing && s.ctf) {
    // Capture the flag is one long round: first to CTF_CAPTURES, or the most captures when time runs out.
    const won = s.teamScores.findIndex((v) => v >= C.CTF_CAPTURES);
    if (won >= 0 || s.playTime >= C.CTF_TIME) {
      const [red, blue] = s.teamScores;
      const team = won >= 0 ? won : red === blue ? -1 : red > blue ? 0 : 1;
      s.roundTeam = team;
      s.matchTeam = team;
      s.roundWinner = -1;
      s.matchWinner = -1;
      s.phase = 'matchEnd';
      s.phaseTime = 0;
      events.push({ k: 'ko', w: -1 });
    }
  } else if (playing && s.teams) {
    // Team mode: the round is over once only one team is left standing.
    const standing = new Set(inRound.filter((p) => !p.falling).map((p) => p.team));
    if (standing.size <= 1) {
      const team = standing.size === 1 ? [...standing][0] : -1;
      if (team >= 0) {
        s.teamScores[team]++;
        for (const p of s.players) if (p.team === team) s.scores[p.id]++;
      }
      s.roundTeam = team;
      s.roundWinner = -1;
      s.phase = 'roundEnd';
      s.phaseTime = 0;
      events.push({ k: 'ko', w: -1 });
    }
  } else if (playing) {
    const alive = inRound.filter((p) => !p.falling);
    if (alive.length <= 1) {
      const winner: PlayerId = alive.length === 1 ? alive[0].id : -1;
      if (winner >= 0) s.scores[winner]++;
      s.roundWinner = winner;
      s.phase = 'roundEnd';
      s.phaseTime = 0;
      events.push({ k: 'ko', w: winner });
    }
  } else if (s.phase === 'countdown' && s.phaseTime >= C.COUNTDOWN_TIME) {
    s.phase = 'playing';
    s.phaseTime = 0;
  } else if (s.phase === 'roundEnd' && s.phaseTime >= C.ROUND_END_TIME && s.teams) {
    const best = s.teamScores[0] >= s.teamScores[1] ? 0 : 1;
    if (s.teamScores[best] >= C.WIN_SCORE) {
      s.phase = 'matchEnd';
      s.phaseTime = 0;
      s.matchTeam = best;
      s.matchWinner = -1;
    } else {
      startRound(s);
    }
  } else if (s.phase === 'roundEnd' && s.phaseTime >= C.ROUND_END_TIME) {
    let best: PlayerId = -1;
    for (const p of s.players) if (best === -1 || s.scores[p.id] > s.scores[best]) best = p.id;
    if (best !== -1 && s.scores[best] >= C.WIN_SCORE) {
      s.phase = 'matchEnd';
      s.phaseTime = 0;
      s.matchWinner = best;
    } else {
      startRound(s);
    }
  } else if (s.phase === 'matchEnd' && s.phaseTime >= C.MATCH_END_TIME) {
    enterLobby(s);
  }

  return events;
}

// ---------------------------------------------------------------------------
// Network form
// ---------------------------------------------------------------------------

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Compact network form of a player. */
export function playerSnap(p: PlayerState): PlayerSnap {
  const fx =
    (p.shield > 0 ? FX_SHIELD : 0) |
    (p.rapid > 0 ? FX_RAPID : 0) |
    (p.triple > 0 ? FX_TRIPLE : 0) |
    (p.mega > 0 ? FX_MEGA : 0) |
    (p.grounded ? FX_GROUNDED : 0) |
    (p.fireHeld ? FX_FIRE_HELD : 0) |
    (p.slideLock ? FX_SLIDE_LOCK : 0) |
    (p.aiming ? FX_AIM : 0) |
    (p.offHeld ? FX_OFF_HELD : 0) |
    (p.knifeOut ? FX_KNIFE : 0) |
    (p.recoilMode ? FX_RECOIL : 0) |
    (p.grappleHeld ? FX_GRAPPLE_HELD : 0) |
    (p.jumpHeld ? FX_JUMP_HELD : 0) |
    (p.airJumped ? FX_AIR_JUMPED : 0) |
    (p.speed > 0 ? FX_SPEED : 0);
  return [
    p.id,
    round3(p.x),
    round3(p.y),
    round3(p.z),
    round3(p.vx),
    round3(p.vy),
    round3(p.vz),
    round3(p.yaw),
    round3(p.pitch),
    Math.round(p.damage * 10) / 10,
    p.falling ? round3(p.fallTime) : -1,
    fx,
    round3(p.cooldown),
    p.ack,
    p.weapon,
    round3(p.slide),
    round3(p.slideCd),
    p.offhand,
    round3(p.offCd),
    round3(p.grappleX),
    round3(p.grappleY),
    round3(p.grappleZ),
    p.grappleT >= 0 ? round3(p.grappleT) : -1,
    round3(p.grappleCd),
  ];
}

/** Rebuilds the parts of a player that client prediction needs from a snapshot. */
export function playerFromSnap(s: PlayerSnap): PlayerState {
  const p = createPlayer(s[0], s[14]);
  p.x = s[1];
  p.y = s[2];
  p.z = s[3];
  p.vx = s[4];
  p.vy = s[5];
  p.vz = s[6];
  p.yaw = s[7];
  p.pitch = s[8];
  p.damage = s[9];
  p.falling = s[10] >= 0;
  p.fallTime = Math.max(0, s[10]);
  const fx = s[11];
  p.shield = fx & FX_SHIELD ? 1 : 0;
  p.rapid = fx & FX_RAPID ? 1 : 0;
  p.triple = fx & FX_TRIPLE ? 1 : 0;
  p.mega = fx & FX_MEGA ? 1 : 0;
  p.grounded = (fx & FX_GROUNDED) !== 0;
  p.fireHeld = (fx & FX_FIRE_HELD) !== 0;
  p.slideLock = (fx & FX_SLIDE_LOCK) !== 0;
  p.aiming = (fx & FX_AIM) !== 0;
  p.cooldown = s[12];
  p.ack = s[13];
  p.slide = s[15];
  p.slideCd = s[16];
  p.offhand = s[17];
  p.offCd = s[18];
  p.offHeld = (fx & FX_OFF_HELD) !== 0;
  p.knifeOut = (fx & FX_KNIFE) !== 0;
  p.recoilMode = (fx & FX_RECOIL) !== 0;
  p.grappleHeld = (fx & FX_GRAPPLE_HELD) !== 0;
  p.jumpHeld = (fx & FX_JUMP_HELD) !== 0;
  p.airJumped = (fx & FX_AIR_JUMPED) !== 0;
  p.speed = fx & FX_SPEED ? 1 : 0;
  p.grappleX = s[19];
  p.grappleY = s[20];
  p.grappleZ = s[21];
  p.grappleT = s[22];
  p.grappleCd = s[23];
  p.inRound = true;
  return p;
}
