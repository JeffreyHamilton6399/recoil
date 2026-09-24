// Shared types: simulation state, events and the network protocol.
// Coordinates: x and y are horizontal, z is up, and the roof is at z = 0.

/** Seat number in a room, 0 .. MAX_PLAYERS - 1. */
export type PlayerId = number;

export type Phase = 'lobby' | 'mapPick' | 'countdown' | 'playing' | 'roundEnd' | 'matchEnd';

export type PowerupKind = 'rapid' | 'triple' | 'mega' | 'shield' | 'heal';
export const POWERUP_KINDS: readonly PowerupKind[] = ['rapid', 'triple', 'mega', 'shield', 'heal'];

/** One tick of a player's controls. */
export interface InputState {
  /** Forward (+1) or back (-1). */
  forward: number;
  /** Right (+1) or left (-1). */
  strafe: number;
  jump: boolean;
  firing: boolean;
  /** Look direction in radians. Yaw 0 faces +x, and yaw grows counter-clockwise seen from above. */
  yaw: number;
  /** Radians above the horizon (negative looks down). */
  pitch: number;
}

export interface PlayerState {
  id: PlayerId;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  /** Standing on the roof. */
  grounded: boolean;
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
  /** Sequence number of the last input the server applied (for client prediction). */
  ack: number;
}

export interface Bullet {
  id: number;
  owner: PlayerId;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
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
  /** a is yaw, b is pitch, c is charge. */
  | { k: 'fire'; p: PlayerId; c: number; x: number; y: number; z: number; a: number; b: number }
  /** f is the knockback strength, d the damage added. */
  | { k: 'hit'; p: PlayerId; o: PlayerId; x: number; y: number; z: number; f: number; d: number }
  | { k: 'block'; p: PlayerId; x: number; y: number; z: number }
  /** Two bullets cancelling out, or a bullet hitting the roof. */
  | { k: 'cancel'; x: number; y: number; z: number; r: number }
  /** q is the other player, or -1 for a bumper. */
  | { k: 'bump'; p: PlayerId; q: PlayerId; x: number; y: number; z: number; f: number }
  | { k: 'fall'; p: PlayerId; x: number; y: number }
  | { k: 'respawn'; p: PlayerId }
  | { k: 'jump'; p: PlayerId }
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

/** Status bits in PlayerSnap. */
export const FX_SHIELD = 1;
export const FX_RAPID = 2;
export const FX_TRIPLE = 4;
export const FX_MEGA = 8;
export const FX_GROUNDED = 16;
export const FX_CHARGING = 32;

/**
 * [id, x, y, z, vx, vy, vz, yaw, pitch, charge, damage,
 *  fallTime (-1 while standing), fx bits, cooldown, input ack]
 */
export type PlayerSnap = [
  number, number, number, number, number, number, number, number,
  number, number, number, number, number, number, number,
];

/** [id, owner, x, y, z, radius] */
export type BulletSnap = [number, number, number, number, number, number];

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
  /** One tick of input: sequence number, forward, strafe, jump, fire, yaw, pitch. */
  | { t: 'input'; s: number; f: number; r: number; j: boolean; x: boolean; a: number; b: number }
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
