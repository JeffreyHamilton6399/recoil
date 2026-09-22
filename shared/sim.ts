// The RECOIL simulation. Pure functions over plain data: no timers, no I/O,
// no randomness. The server runs it authoritatively; the client only uses the
// helpers (for example chargeStats) to draw things consistently.

import * as C from './constants.js';
import type {
  Bullet,
  GameEvent,
  GameState,
  InputState,
  PlayerIndex,
  PlayerSnap,
  PlayerState,
  RoundResult,
} from './types.js';

export const PLAYERS: readonly PlayerIndex[] = [0, 1];

export const NO_INPUT: InputState = Object.freeze({ aimLeft: false, aimRight: false, firing: false });

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

export function other(i: PlayerIndex): PlayerIndex {
  return i === 0 ? 1 : 0;
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

export function createPlayer(i: PlayerIndex): PlayerState {
  const side = i === 0 ? -1 : 1;
  return {
    x: side * C.SPAWN_DISTANCE,
    y: 0,
    vx: 0,
    vy: 0,
    aim: i === 0 ? 0 : Math.PI,
    charge: 0,
    charging: false,
    cooldown: 0,
    damage: 0,
    falling: false,
    fallTime: 0,
  };
}

export function createGame(): GameState {
  return {
    tick: 0,
    phase: 'waiting',
    phaseTime: 0,
    playTime: 0,
    arenaRadius: C.ARENA_START_RADIUS,
    players: [createPlayer(0), createPlayer(1)],
    bullets: [],
    nextBulletId: 1,
    scores: [0, 0],
    roundResult: null,
    matchWinner: null,
  };
}

/** Resets positions and the arena and begins the 3-2-1 countdown. Scores are kept. */
export function startRound(s: GameState): void {
  s.players = [createPlayer(0), createPlayer(1)];
  s.bullets = [];
  s.arenaRadius = C.ARENA_START_RADIUS;
  s.playTime = 0;
  s.phase = 'countdown';
  s.phaseTime = 0;
  s.roundResult = null;
}

/** Resets scores and starts round one. */
export function startMatch(s: GameState): void {
  s.scores = [0, 0];
  s.matchWinner = null;
  startRound(s);
}

function fire(s: GameState, i: PlayerIndex, events: GameEvent[]): void {
  const p = s.players[i];
  const st = chargeStats(p.charge);
  const dx = Math.cos(p.aim);
  const dy = Math.sin(p.aim);
  const offset = C.PLAYER_RADIUS + st.radius + C.MUZZLE_GAP;
  const bullet: Bullet = {
    id: s.nextBulletId++,
    owner: i,
    x: p.x + dx * offset,
    y: p.y + dy * offset,
    vx: dx * st.speed,
    vy: dy * st.speed,
    radius: st.radius,
    knockback: st.knockback,
    damage: st.damage,
    age: 0,
  };
  s.bullets.push(bullet);
  // Recoil: the only way to move.
  p.vx -= dx * st.recoil;
  p.vy -= dy * st.recoil;
  events.push({ k: 'fire', p: i, c: p.charge, x: bullet.x, y: bullet.y, a: p.aim });
  p.charging = false;
  p.charge = 0;
  p.cooldown = C.FIRE_COOLDOWN;
}

function updateControls(
  s: GameState,
  i: PlayerIndex,
  input: InputState,
  dt: number,
  canAim: boolean,
  canFire: boolean,
  events: GameEvent[],
): void {
  const p = s.players[i];
  if (p.falling) return;

  if (canAim) {
    const dir = (input.aimRight ? 1 : 0) - (input.aimLeft ? 1 : 0);
    p.aim = wrapAngle(p.aim + dir * C.AIM_SPEED * dt);
  }

  p.cooldown = Math.max(0, p.cooldown - dt);

  if (!canFire) {
    p.charging = false;
    p.charge = 0;
    return;
  }

  if (input.firing) {
    if (p.charging) {
      p.charge = Math.min(1, p.charge + dt / C.CHARGE_TIME);
    } else if (p.cooldown <= 0) {
      p.charging = true;
      p.charge = 0;
    }
  } else if (p.charging) {
    fire(s, i, events);
  }
}

function integrate(s: GameState, h: number, events: GameEvent[]): void {
  const decay = Math.exp(-C.FRICTION * h);
  for (const p of s.players) {
    p.vx *= decay;
    p.vy *= decay;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > C.MAX_PLAYER_SPEED) {
      const k = C.MAX_PLAYER_SPEED / speed;
      p.vx *= k;
      p.vy *= k;
    }
    p.x += p.vx * h;
    p.y += p.vy * h;
  }
  for (const b of s.bullets) {
    b.x += b.vx * h;
    b.y += b.vy * h;
  }

  collidePlayers(s, events);

  // Opposing bullets cancel each other out.
  const dead = new Set<number>();
  for (let a = 0; a < s.bullets.length; a++) {
    const ba = s.bullets[a];
    if (dead.has(ba.id)) continue;
    for (let b = a + 1; b < s.bullets.length; b++) {
      const bb = s.bullets[b];
      if (dead.has(bb.id) || bb.owner === ba.owner) continue;
      const rr = ba.radius + bb.radius;
      const dx = bb.x - ba.x;
      const dy = bb.y - ba.y;
      if (dx * dx + dy * dy < rr * rr) {
        dead.add(ba.id);
        dead.add(bb.id);
        events.push({ k: 'cancel', x: (ba.x + bb.x) / 2, y: (ba.y + bb.y) / 2, r: Math.max(ba.radius, bb.radius) });
        break;
      }
    }
  }

  // Bullets hitting the opposing player.
  for (const b of s.bullets) {
    if (dead.has(b.id)) continue;
    const target: PlayerIndex = other(b.owner);
    const p = s.players[target];
    if (p.falling) continue;
    const rr = C.PLAYER_RADIUS + b.radius;
    const dx = p.x - b.x;
    const dy = p.y - b.y;
    if (dx * dx + dy * dy >= rr * rr) continue;
    dead.add(b.id);
    const speed = Math.hypot(b.vx, b.vy) || 1;
    const nx = b.vx / speed;
    const ny = b.vy / speed;
    const impulse = b.knockback * (1 + p.damage / C.DAMAGE_SCALE);
    p.vx += nx * impulse;
    p.vy += ny * impulse;
    p.damage += b.damage;
    events.push({ k: 'hit', p: target, x: b.x, y: b.y, a: Math.atan2(ny, nx), f: impulse, d: b.damage });
  }

  if (dead.size > 0) s.bullets = s.bullets.filter((b) => !dead.has(b.id));
}

function collidePlayers(s: GameState, events: GameEvent[]): void {
  const [a, b] = s.players;
  if (a.falling || b.falling) return;
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
  if (j > 0.5) {
    events.push({ k: 'bump', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, a: Math.atan2(ny, nx), f: j });
  }
}

/**
 * Advances the game by one tick and returns what happened. Mutates `s`.
 * `inputs` holds the current input state for each player.
 */
export function step(s: GameState, inputs: readonly [InputState, InputState], dt: number = C.TICK_DT): GameEvent[] {
  const events: GameEvent[] = [];
  s.tick++;
  if (s.phase === 'waiting') return events;
  s.phaseTime += dt;

  const playing = s.phase === 'playing';
  const canAim = playing || s.phase === 'countdown';
  for (const i of PLAYERS) updateControls(s, i, inputs[i], dt, canAim, playing, events);

  if (playing) {
    s.playTime += dt;
    s.arenaRadius = arenaRadiusAt(s.playTime);
  }

  const h = dt / C.PHYSICS_SUBSTEPS;
  for (let n = 0; n < C.PHYSICS_SUBSTEPS; n++) integrate(s, h, events);

  const cullRadius = s.arenaRadius + C.BULLET_CULL_MARGIN;
  s.bullets = s.bullets.filter((b) => {
    b.age += dt;
    return b.age < C.BULLET_LIFETIME && Math.hypot(b.x, b.y) < cullRadius;
  });

  // Falling off the edge.
  const fallen: PlayerIndex[] = [];
  for (const i of PLAYERS) {
    const p = s.players[i];
    if (p.falling) {
      p.fallTime += dt;
    } else if (Math.hypot(p.x, p.y) > s.arenaRadius) {
      p.falling = true;
      p.fallTime = 0;
      p.charging = false;
      p.charge = 0;
      fallen.push(i);
      events.push({ k: 'fall', p: i, x: p.x, y: p.y });
    }
  }

  if (playing && fallen.length > 0) {
    const result: RoundResult = fallen.length === 2 ? -1 : other(fallen[0]);
    if (result !== -1) s.scores[result]++;
    s.roundResult = result;
    s.phase = 'roundEnd';
    s.phaseTime = 0;
    events.push({ k: 'ko', w: result });
  } else if (s.phase === 'countdown' && s.phaseTime >= C.COUNTDOWN_TIME) {
    s.phase = 'playing';
    s.phaseTime = 0;
  } else if (s.phase === 'roundEnd' && s.phaseTime >= C.ROUND_END_TIME) {
    const best = Math.max(s.scores[0], s.scores[1]);
    if (best >= C.WIN_SCORE) {
      s.phase = 'matchEnd';
      s.phaseTime = 0;
      s.matchWinner = s.scores[0] > s.scores[1] ? 0 : 1;
    } else {
      startRound(s);
    }
  }

  return events;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Compact network form of a player. */
export function playerSnap(p: PlayerState): PlayerSnap {
  return [round3(p.x), round3(p.y), round3(p.aim), round3(p.charge), Math.round(p.damage * 10) / 10, p.falling ? round3(p.fallTime) : -1];
}
