// The RECOIL simulation. Pure functions over plain data: no timers, no I/O.
// Randomness (map picks, power-up spawns) comes from a seeded PRNG stored in
// the state, so a given seed and input sequence always plays out the same.
// The server runs it authoritatively. The client runs controlPlayer and
// movePlayer on its own player to predict movement without waiting for the
// server.
//
// The world is 3D: x and y are horizontal, z is up, and the roof is at z = 0.

import * as C from './constants.js';
import { MAPS, isOffMap, scaledBumpers, spawnPoint, type MapDef } from './maps.js';
import {
  FX_CHARGING,
  FX_GROUNDED,
  FX_MEGA,
  FX_RAPID,
  FX_SHIELD,
  FX_TRIPLE,
  POWERUP_KINDS,
  type Bullet,
  type GameEvent,
  type GameState,
  type InputState,
  type PlayerId,
  type PlayerSnap,
  type PlayerState,
  type PowerupKind,
} from './types.js';

export const NO_INPUT: InputState = Object.freeze({ forward: 0, strafe: 0, jump: false, firing: false, yaw: 0, pitch: 0 });

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

export interface ChargeStats {
  radius: number;
  speed: number;
  knockback: number;
  damage: number;
  recoil: number;
}

/** Bullet properties for a given charge (0..1). */
export function chargeStats(charge: number): ChargeStats {
  const c = clamp(charge, 0, 1);
  return {
    radius: lerp(C.BULLET_RADIUS[0], C.BULLET_RADIUS[1], c),
    speed: lerp(C.BULLET_SPEED[0], C.BULLET_SPEED[1], c),
    knockback: lerp(C.BULLET_KNOCKBACK[0], C.BULLET_KNOCKBACK[1], c),
    damage: lerp(C.BULLET_DAMAGE[0], C.BULLET_DAMAGE[1], c),
    recoil: lerp(C.SHOT_RECOIL[0], C.SHOT_RECOIL[1], c),
  };
}

/** Arena radius after a given number of seconds of active play. */
export function arenaRadiusAt(playTime: number): number {
  const t = clamp(playTime / C.ARENA_SHRINK_TIME, 0, 1);
  return lerp(C.ARENA_START_RADIUS, C.ARENA_END_RADIUS, t);
}

export function currentMap(s: GameState): MapDef {
  return MAPS[s.mapIndex] ?? MAPS[0];
}

/** What a player may do in each phase. */
export function phaseRules(phase: GameState['phase']): { canMove: boolean; canFire: boolean } {
  const canFire = phase === 'lobby' || phase === 'playing';
  return { canMove: canFire || phase === 'roundEnd' || phase === 'matchEnd', canFire };
}

// ---------------------------------------------------------------------------
// Setup and flow
// ---------------------------------------------------------------------------

export function createPlayer(id: PlayerId): PlayerState {
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
    charge: 0,
    charging: false,
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
  };
}

function resetAtSpawn(s: GameState, p: PlayerState, index: number, count: number): void {
  const sp = spawnPoint(currentMap(s), index, count);
  p.x = sp.x;
  p.y = sp.y;
  p.z = 0;
  p.yaw = wrapAngle(sp.yaw);
  p.pitch = 0;
  p.vx = 0;
  p.vy = 0;
  p.vz = 0;
  p.grounded = true;
  p.charge = 0;
  p.charging = false;
  p.cooldown = 0;
  p.damage = 0;
  p.falling = false;
  p.fallTime = 0;
  p.spawnIndex = index;
  p.rapid = 0;
  p.triple = 0;
  p.mega = 0;
  p.shield = 0;
}

/** Puts every player in the round, evenly spaced on the spawn ring. */
function placeAll(s: GameState): void {
  const n = s.players.length;
  s.players.forEach((p, i) => {
    p.inRound = true;
    resetAtSpawn(s, p, i, n);
  });
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
  };
}

export function getPlayer(s: GameState, id: PlayerId): PlayerState | undefined {
  return s.players.find((p) => p.id === id);
}

/** Adds a player. In the lobby they join the warm-up; mid-match they watch until the next round. */
export function addPlayer(s: GameState, id: PlayerId): void {
  if (getPlayer(s, id)) return;
  const p = createPlayer(id);
  s.players.push(p);
  s.players.sort((a, b) => a.id - b.id);
  if (s.phase === 'lobby') placeAll(s);
}

export function removePlayer(s: GameState, id: PlayerId): void {
  s.players = s.players.filter((p) => p.id !== id);
  s.scores[id] = 0;
  if (s.phase === 'lobby') placeAll(s);
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
 * Starts a round. With a picked map it goes straight to the countdown;
 * on random it picks a map (never the same one twice in a row) and runs the spinner.
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
  placeAll(s);
  s.phase = isRandom ? 'mapPick' : 'countdown';
  s.phaseTime = 0;
}

/** Resets scores and starts round one. */
export function startMatch(s: GameState): void {
  s.scores.fill(0);
  s.matchWinner = null;
  startRound(s);
}

// ---------------------------------------------------------------------------
// Controls (shared with client prediction)
// ---------------------------------------------------------------------------

/**
 * Applies one tick of input to a player: look, charge and fire, jump, and
 * running. Returns the charge of the shot fired this tick, or -1. The shot's
 * recoil is applied here; the caller spawns the bullets (see spawnBullets).
 */
export function controlPlayer(p: PlayerState, input: InputState, dt: number, canMove: boolean, canFire: boolean): number {
  if (p.falling) return -1;

  p.yaw = wrapAngle(Number.isFinite(input.yaw) ? input.yaw : p.yaw);
  p.pitch = clamp(Number.isFinite(input.pitch) ? input.pitch : p.pitch, -C.PITCH_LIMIT, C.PITCH_LIMIT);
  p.cooldown = Math.max(0, p.cooldown - dt);

  let fired = -1;
  if (!canFire) {
    p.charging = false;
    p.charge = 0;
  } else if (input.firing) {
    if (p.charging) {
      const rate = p.rapid > 0 ? C.RAPID_CHARGE_MULT : 1;
      p.charge = Math.min(1, p.charge + (dt * rate) / C.CHARGE_TIME);
    } else if (p.cooldown <= 0) {
      p.charging = true;
      p.charge = 0;
    }
  } else if (p.charging) {
    fired = p.charge;
    // Recoil: shoot down to rocket-jump, shoot behind you to boost forward.
    const d = aimDir(p.yaw, p.pitch);
    const kick = chargeStats(p.charge).recoil;
    p.vx -= d.x * kick;
    p.vy -= d.y * kick;
    p.vz -= d.z * kick;
    if (p.vz > 0) p.grounded = false;
    p.charging = false;
    p.charge = 0;
    p.cooldown = p.rapid > 0 ? C.RAPID_COOLDOWN : C.FIRE_COOLDOWN;
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

  if (p.grounded) {
    const speed = Math.hypot(p.vx, p.vy);
    if (speed <= C.MOVE_SPEED * 1.05) {
      // Running: move the velocity straight towards the wish velocity.
      const tx = wx * C.MOVE_SPEED - p.vx;
      const ty = wy * C.MOVE_SPEED - p.vy;
      const dist = Math.hypot(tx, ty);
      const step = C.GROUND_ACCEL * dt;
      if (dist <= step) {
        p.vx = wx * C.MOVE_SPEED;
        p.vy = wy * C.MOVE_SPEED;
      } else {
        p.vx += (tx / dist) * step;
        p.vy += (ty / dist) * step;
      }
    } else {
      // Sliding after a knockback or boost: the extra speed bleeds away.
      const decay = Math.exp(-C.SLIDE_FRICTION * dt);
      const k = Math.max(decay, (C.MOVE_SPEED * 0.9) / speed);
      p.vx *= k;
      p.vy *= k;
      if (wishing) {
        p.vx += wx * C.SLIDE_ACCEL * dt;
        p.vy += wy * C.SLIDE_ACCEL * dt;
      }
    }
    if (input.jump && p.vz <= 0) {
      p.vz = C.JUMP_SPEED;
      p.grounded = false;
    }
  } else {
    const drag = Math.exp(-C.AIR_DRAG * dt);
    p.vx *= drag;
    p.vy *= drag;
    if (wishing) {
      // Quake-style air control: add speed along the wish direction up to running speed.
      const along = p.vx * wx + p.vy * wy;
      const add = Math.min(C.AIR_ACCEL * dt, C.MOVE_SPEED - along);
      if (add > 0) {
        p.vx += wx * add;
        p.vy += wy * add;
      }
    }
  }
  return fired;
}

/**
 * Moves a player for one physics substep: gravity, the roof, the walls
 * under its edges, and the bumper pillars. Shared with client prediction.
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

  if (p.grounded && (p.vz > 0 || isOffMap(map, arenaRadius, p.x, p.y))) p.grounded = false;
  if (!p.grounded) p.vz -= C.GRAVITY * h;

  const px = p.x;
  const py = p.y;
  const pz = p.z;
  p.x += p.vx * h;
  p.y += p.vy * h;
  p.z += p.vz * h;

  if (p.grounded) {
    p.z = 0;
    p.vz = 0;
  } else if (p.z <= 0 && pz >= -0.35 && p.vz <= 0 && !isOffMap(map, arenaRadius, p.x, p.y)) {
    // Landed on the roof.
    p.z = 0;
    p.vz = 0;
    p.grounded = true;
  } else if (p.z < -0.35 && !isOffMap(map, arenaRadius, p.x, p.y)) {
    // Below the roof, inside a hole or past the edge: the building's walls stop you.
    p.x = px;
    p.y = py;
    p.vx *= -0.2;
    p.vy *= -0.2;
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
}

/** True once a player has dropped too far below the roof to get back. */
export function hasFallen(p: PlayerState): boolean {
  return !p.falling && p.z < C.FALL_Z;
}

// ---------------------------------------------------------------------------
// Shooting and power-ups
// ---------------------------------------------------------------------------

function spawnBullets(s: GameState, p: PlayerState, charge: number, events: GameEvent[]): void {
  const st = chargeStats(charge);
  let { radius, knockback, damage } = st;
  if (p.mega > 0) {
    radius *= C.MEGA_RADIUS_MULT;
    knockback *= C.MEGA_KNOCKBACK_MULT;
    damage *= C.MEGA_DAMAGE_MULT;
    p.mega--;
  }
  const spreads = p.triple > 0 ? [-C.TRIPLE_SPREAD, 0, C.TRIPLE_SPREAD] : [0];
  const offset = C.PLAYER_RADIUS + radius + C.MUZZLE_GAP;
  const eyeZ = p.z + C.EYE_HEIGHT;
  for (const spread of spreads) {
    const d = aimDir(p.yaw + spread, p.pitch);
    const bullet: Bullet = {
      id: s.nextId++,
      owner: p.id,
      x: p.x + d.x * offset,
      y: p.y + d.y * offset,
      z: eyeZ + d.z * offset,
      vx: d.x * st.speed,
      vy: d.y * st.speed,
      vz: d.z * st.speed,
      radius,
      knockback,
      damage,
      age: 0,
    };
    s.bullets.push(bullet);
  }
  const d = aimDir(p.yaw, p.pitch);
  events.push({ k: 'fire', p: p.id, c: charge, x: p.x + d.x * offset, y: p.y + d.y * offset, z: eyeZ + d.z * offset, a: p.yaw, b: p.pitch });
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
  }
}

function updatePowerups(s: GameState, dt: number, events: GameEvent[]): void {
  const map = currentMap(s);
  const R = s.arenaRadius;
  const bumpers = scaledBumpers(map, R);

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
    // Keep clear of hole edges, bumpers and players.
    if (isOffMap(map, R, x + edge, y) || isOffMap(map, R, x - edge, y) || isOffMap(map, R, x, y + edge) || isOffMap(map, R, x, y - edge)) continue;
    if (bumpers.some((b) => Math.hypot(x - b.x, y - b.y) < b.r + edge)) continue;
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

/** Squared distance from a point to a player's body (a vertical capsule). */
function capsuleDist2(p: PlayerState, x: number, y: number, z: number): number {
  const lo = p.z + C.PLAYER_RADIUS;
  const hi = p.z + C.PLAYER_HEIGHT - C.PLAYER_RADIUS;
  const cz = clamp(z, lo, hi);
  const dx = x - p.x;
  const dy = y - p.y;
  const dz = z - cz;
  return dx * dx + dy * dy + dz * dz;
}

function integrate(s: GameState, h: number, events: GameEvent[]): void {
  const map = currentMap(s);
  const R = s.arenaRadius;
  const active = s.players.filter((p) => p.inRound);
  for (const p of active) movePlayer(p, h, map, R, events);
  for (const b of s.bullets) {
    b.x += b.vx * h;
    b.y += b.vy * h;
    b.z += b.vz * h;
  }

  const standing = active.filter((p) => !p.falling);
  for (let i = 0; i < standing.length; i++) {
    for (let j = i + 1; j < standing.length; j++) collidePlayers(standing[i], standing[j], events);
  }

  const dead = new Set<number>();

  // Bullets bounce off bumper pillars and splat on the roof.
  const bumpers = scaledBumpers(map, R);
  for (const b of s.bullets) {
    if (b.z < C.BUMPER_HEIGHT) {
      for (const bp of bumpers) {
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
    if (b.z < b.radius * 0.5 && b.z > -1.5 && !isOffMap(map, R, b.x, b.y)) {
      dead.add(b.id);
      events.push({ k: 'cancel', x: b.x, y: b.y, z: 0.05, r: b.radius });
    }
  }

  // Bullets from different players cancel each other out.
  for (let a = 0; a < s.bullets.length; a++) {
    const ba = s.bullets[a];
    if (dead.has(ba.id)) continue;
    for (let c = a + 1; c < s.bullets.length; c++) {
      const bb = s.bullets[c];
      if (dead.has(bb.id) || bb.owner === ba.owner) continue;
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

  // Bullets hitting other players.
  for (const b of s.bullets) {
    if (dead.has(b.id)) continue;
    for (const p of standing) {
      if (p.id === b.owner) continue;
      const rr = C.PLAYER_RADIUS + b.radius;
      if (capsuleDist2(p, b.x, b.y, b.z) >= rr * rr) continue;
      dead.add(b.id);
      if (p.shield > 0) {
        p.shield = 0;
        events.push({ k: 'block', p: p.id, x: b.x, y: b.y, z: b.z });
        break;
      }
      const speed = Math.hypot(b.vx, b.vy, b.vz) || 1;
      const flat = Math.hypot(b.vx, b.vy);
      const impulse = b.knockback * (1 + p.damage / C.DAMAGE_SCALE);
      if (flat > 1e-6) {
        // Knocked along the bullet's path, and always a little off your feet.
        const k = impulse * Math.max(0.6, flat / speed);
        p.vx += (b.vx / flat) * k;
        p.vy += (b.vy / flat) * k;
      }
      p.vz += impulse * C.KNOCKBACK_LIFT + Math.max(0, (b.vz / speed) * impulse);
      p.grounded = false;
      p.damage += b.damage;
      events.push({ k: 'hit', p: p.id, o: b.owner, x: b.x, y: b.y, z: b.z, f: impulse, d: b.damage });
      break;
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
  const { canMove, canFire } = phaseRules(s.phase);

  for (const p of s.players) {
    if (!p.inRound) continue;
    const input = inputs.get(p.id) ?? { ...NO_INPUT, yaw: p.yaw, pitch: p.pitch };
    const wasGrounded = p.grounded;
    const charge = controlPlayer(p, input, dt, canMove, canFire);
    if (charge >= 0) spawnBullets(s, p, charge, events);
    if (wasGrounded && !p.grounded && input.jump && charge < 0) events.push({ k: 'jump', p: p.id });
    p.rapid = Math.max(0, p.rapid - dt);
    p.triple = Math.max(0, p.triple - dt);
    p.shield = Math.max(0, p.shield - dt);
  }

  if (playing) {
    s.playTime += dt;
    s.arenaRadius = arenaRadiusAt(s.playTime);
  }
  if (lobby || playing) updatePowerups(s, dt, events);

  const h = dt / C.PHYSICS_SUBSTEPS;
  for (let n = 0; n < C.PHYSICS_SUBSTEPS; n++) integrate(s, h, events);

  const cullRadius = s.arenaRadius + C.BULLET_CULL_MARGIN;
  s.bullets = s.bullets.filter((b) => {
    b.age += dt;
    return b.age < C.BULLET_LIFETIME && Math.hypot(b.x, b.y) < cullRadius && b.z > -30;
  });

  // Falling off the edge or into a hole.
  const inRound = s.players.filter((p) => p.inRound);
  for (const p of inRound) {
    if (p.falling) {
      p.fallTime += dt;
      if (lobby && p.fallTime > C.FALL_DURATION + C.LOBBY_RESPAWN_DELAY) {
        resetAtSpawn(s, p, p.spawnIndex, inRound.length);
        events.push({ k: 'respawn', p: p.id });
      }
    } else if (hasFallen(p)) {
      p.falling = true;
      p.fallTime = 0;
      p.charging = false;
      p.charge = 0;
      events.push({ k: 'fall', p: p.id, x: p.x, y: p.y });
    }
  }

  if (playing) {
    const alive = inRound.filter((p) => !p.falling);
    if (alive.length <= 1) {
      const winner: PlayerId = alive.length === 1 ? alive[0].id : -1;
      if (winner >= 0) s.scores[winner]++;
      s.roundWinner = winner;
      s.phase = 'roundEnd';
      s.phaseTime = 0;
      events.push({ k: 'ko', w: winner });
    }
  } else if (s.phase === 'mapPick' && s.phaseTime >= C.MAP_PICK_TIME) {
    s.phase = 'countdown';
    s.phaseTime = 0;
  } else if (s.phase === 'countdown' && s.phaseTime >= C.COUNTDOWN_TIME) {
    s.phase = 'playing';
    s.phaseTime = 0;
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
    (p.charging ? FX_CHARGING : 0);
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
    round3(p.charge),
    Math.round(p.damage * 10) / 10,
    p.falling ? round3(p.fallTime) : -1,
    fx,
    round3(p.cooldown),
    p.ack,
  ];
}

/** Rebuilds the parts of a player that client prediction needs from a snapshot. */
export function playerFromSnap(s: PlayerSnap): PlayerState {
  const p = createPlayer(s[0]);
  p.x = s[1];
  p.y = s[2];
  p.z = s[3];
  p.vx = s[4];
  p.vy = s[5];
  p.vz = s[6];
  p.yaw = s[7];
  p.pitch = s[8];
  p.charge = s[9];
  p.damage = s[10];
  p.falling = s[11] >= 0;
  p.fallTime = Math.max(0, s[11]);
  const fx = s[12];
  p.shield = fx & FX_SHIELD ? 1 : 0;
  p.rapid = fx & FX_RAPID ? 1 : 0;
  p.triple = fx & FX_TRIPLE ? 1 : 0;
  p.mega = fx & FX_MEGA ? 1 : 0;
  p.grounded = (fx & FX_GROUNDED) !== 0;
  p.charging = (fx & FX_CHARGING) !== 0;
  p.cooldown = s[13];
  p.ack = s[14];
  p.inRound = true;
  return p;
}
