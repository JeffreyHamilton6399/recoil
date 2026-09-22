// Shared types: simulation state, events and the network protocol.

export type PlayerIndex = 0 | 1;

export type Phase = 'waiting' | 'countdown' | 'playing' | 'roundEnd' | 'matchEnd';

/** Who won a round: a player index, or -1 for a double KO. */
export type RoundResult = PlayerIndex | -1;

export interface InputState {
  aimLeft: boolean;
  aimRight: boolean;
  firing: boolean;
}

export interface PlayerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Aim angle in radians. Screen space, so +y is down and +angle is clockwise. */
  aim: number;
  /** Charge amount, 0..1. */
  charge: number;
  charging: boolean;
  /** Seconds left before the player can charge again. */
  cooldown: number;
  /** Damage percentage. Higher means more knockback taken. */
  damage: number;
  falling: boolean;
  /** Seconds since the player started falling. */
  fallTime: number;
}

export interface Bullet {
  id: number;
  owner: PlayerIndex;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  knockback: number;
  damage: number;
  age: number;
}

/** Things that happened during a tick, sent to clients for effects and sound. */
export type GameEvent =
  | { k: 'fire'; p: PlayerIndex; c: number; x: number; y: number; a: number }
  | { k: 'hit'; p: PlayerIndex; x: number; y: number; a: number; f: number; d: number }
  | { k: 'cancel'; x: number; y: number; r: number }
  | { k: 'bump'; x: number; y: number; a: number; f: number }
  | { k: 'fall'; p: PlayerIndex; x: number; y: number }
  | { k: 'ko'; w: RoundResult };

export interface GameState {
  tick: number;
  phase: Phase;
  /** Seconds spent in the current phase. */
  phaseTime: number;
  /** Seconds of active play this round (drives the arena shrink). */
  playTime: number;
  arenaRadius: number;
  players: [PlayerState, PlayerState];
  bullets: Bullet[];
  nextBulletId: number;
  scores: [number, number];
  roundResult: RoundResult | null;
  matchWinner: PlayerIndex | null;
}

// ---------------------------------------------------------------------------
// Network protocol
// ---------------------------------------------------------------------------

/** [x, y, aim, charge, damage, fallTime] where fallTime is -1 while standing. */
export type PlayerSnap = [number, number, number, number, number, number];

/** [id, owner, x, y, radius] */
export type BulletSnap = [number, PlayerIndex, number, number, number];

/** 0 = slot empty, 1 = connected, 2 = disconnected (waiting for rejoin). */
export type SlotStatus = 0 | 1 | 2;

export interface Snapshot {
  t: 'snap';
  /** Tick number. */
  k: number;
  ph: Phase;
  /** Phase time in seconds. */
  pt: number;
  /** Arena radius. */
  r: number;
  s: [number, number];
  p: [PlayerSnap, PlayerSnap];
  b: BulletSnap[];
  e: GameEvent[];
  rr: RoundResult | null;
  mw: PlayerIndex | null;
  /** Slot status for each player. */
  sl: [SlotStatus, SlotStatus];
  /** Seconds until the room closes because a player left, or -1. */
  cl: number;
  /** Rematch votes. */
  rm: [boolean, boolean];
  /** Number of spectators. */
  sp: number;
}

export type ClientMessage =
  | { t: 'create'; id: string }
  | { t: 'join'; code: string; id: string }
  | { t: 'input'; l: boolean; r: boolean; f: boolean }
  | { t: 'ping'; c: number }
  | { t: 'rematch' }
  | { t: 'leave' };

export type ServerMessage =
  | { t: 'joined'; code: string; slot: PlayerIndex | -1 }
  | { t: 'error'; msg: string }
  | { t: 'pong'; c: number }
  | { t: 'closed'; msg: string }
  | Snapshot;

export const ROOM_CODE_PATTERN = /^[A-Z]{4}$/;
