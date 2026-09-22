// Shared types: simulation state, events and the network protocol.

/** Seat number in a room, 0 .. MAX_PLAYERS - 1. */
export type PlayerId = number;

export type Phase = 'lobby' | 'mapPick' | 'countdown' | 'playing' | 'roundEnd' | 'matchEnd';

export type PowerupKind = 'rapid' | 'triple' | 'mega' | 'shield' | 'heal';
export const POWERUP_KINDS: readonly PowerupKind[] = ['rapid', 'triple', 'mega', 'shield', 'heal'];

export interface InputState {
  aimLeft: boolean;
  aimRight: boolean;
  firing: boolean;
}

export interface PlayerState {
  id: PlayerId;
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
  /** False while spectating a round they joined in the middle of. */
  inRound: boolean;
  /** Spawn slot index for this round, so lobby respawns go back to the same place. */
  spawnIndex: number;
  /** Seconds of Rapid Fire left. */
  rapid: number;
  /** Seconds of Triple Shot left. */
  triple: number;
  /** Mega Shots left. */
  mega: number;
  /** Seconds of Shield left. */
  shield: number;
}

export interface Bullet {
  id: number;
  owner: PlayerId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  knockback: number;
  damage: number;
  age: number;
}

export interface Powerup {
  id: number;
  kind: PowerupKind;
  x: number;
  y: number;
  age: number;
}

/** Things that happened during a tick, sent to clients for effects and sound. */
export type GameEvent =
  | { k: 'fire'; p: PlayerId; c: number; x: number; y: number; a: number }
  | { k: 'hit'; p: PlayerId; x: number; y: number; a: number; f: number; d: number }
  | { k: 'block'; p: PlayerId; x: number; y: number }
  | { k: 'cancel'; x: number; y: number; r: number }
  /** q is the other player, or -1 for a bumper. */
  | { k: 'bump'; p: PlayerId; q: PlayerId; x: number; y: number; a: number; f: number }
  | { k: 'fall'; p: PlayerId; x: number; y: number }
  | { k: 'respawn'; p: PlayerId }
  | { k: 'spawn'; u: PowerupKind; x: number; y: number }
  | { k: 'pickup'; p: PlayerId; u: PowerupKind; x: number; y: number }
  /** w is the round winner, or -1 if nobody survived. */
  | { k: 'ko'; w: PlayerId };

export interface GameState {
  tick: number;
  phase: Phase;
  /** Seconds spent in the current phase. */
  phaseTime: number;
  /** Seconds of active play this round (drives the arena shrink). */
  playTime: number;
  arenaRadius: number;
  mapIndex: number;
  /** Host's map pick: a map index, or -1 for a random map (with the spinner) each round. */
  mapChoice: number;
  players: PlayerState[];
  bullets: Bullet[];
  powerups: Powerup[];
  nextId: number;
  /** Round wins, indexed by PlayerId. */
  scores: number[];
  /** Winner of the round just finished: a player, -1 for nobody, null during play. */
  roundWinner: PlayerId | null;
  matchWinner: PlayerId | null;
  /** Seconds until the next power-up spawn. */
  powerupTimer: number;
  /** PRNG state, so the simulation stays deterministic. */
  rng: number;
}

// ---------------------------------------------------------------------------
// Network protocol
// ---------------------------------------------------------------------------

/** Power-up status bits in PlayerSnap. */
export const FX_SHIELD = 1;
export const FX_RAPID = 2;
export const FX_TRIPLE = 4;
export const FX_MEGA = 8;

/** [id, x, y, aim, charge, damage, fallTime (-1 while standing), fx bits] */
export type PlayerSnap = [number, number, number, number, number, number, number, number];

/** [id, owner, x, y, radius] */
export type BulletSnap = [number, number, number, number, number];

/** [id, kind index into POWERUP_KINDS, x, y, age] */
export type PowerupSnap = [number, number, number, number, number];

export interface Snapshot {
  t: 'snap';
  /** Tick number. */
  k: number;
  ph: Phase;
  /** Phase time in seconds. */
  pt: number;
  /** Arena radius. */
  r: number;
  /** Map index into MAPS. */
  m: number;
  p: PlayerSnap[];
  b: BulletSnap[];
  u: PowerupSnap[];
  e: GameEvent[];
  rw: PlayerId | null;
  mw: PlayerId | null;
}

export interface RosterEntry {
  id: PlayerId;
  name: string;
  /** Index into PLAYER_PALETTE. */
  color: number;
  score: number;
  online: boolean;
  host: boolean;
}

export type ClientMessage =
  | { t: 'create'; id: string; name: string; color: number }
  | { t: 'join'; code: string; id: string; name: string; color: number }
  /** Quick play: join (or open) a public room. */
  | { t: 'quick'; id: string; name: string; color: number }
  /** Host of a private room picks the map (-1 = random). */
  | { t: 'map'; choice: number }
  | { t: 'profile'; name: string; color: number }
  | { t: 'start' }
  | { t: 'input'; l: boolean; r: boolean; f: boolean }
  | { t: 'ping'; c: number }
  | { t: 'leave' };

export type ServerMessage =
  | { t: 'joined'; code: string; you: PlayerId | -1 }
  | {
      t: 'roster';
      players: RosterEntry[];
      spectators: number;
      /** Public (quick play) room. */
      pub: boolean;
      mapChoice: number;
      /** Public rooms: seconds until the match starts automatically, or -1. */
      startsIn: number;
    }
  | { t: 'error'; msg: string }
  | { t: 'pong'; c: number }
  | Snapshot;

export const ROOM_CODE_PATTERN = /^[A-Z]{4}$/;
