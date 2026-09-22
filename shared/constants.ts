// All tuning constants for RECOIL live here. Units are "world units" (the
// arena starts 9 units in radius) and seconds, unless noted otherwise.
// Both the server and the client import this file, so changing a value
// changes the game everywhere.

// ---------------------------------------------------------------------------
// Simulation timing
// ---------------------------------------------------------------------------

/** Server simulation rate in ticks per second. */
export const TICK_RATE = 30;
/** Seconds per simulation tick. */
export const TICK_DT = 1 / TICK_RATE;
/** Physics substeps per tick. More substeps mean fewer missed collisions at high speed. */
export const PHYSICS_SUBSTEPS = 3;

// ---------------------------------------------------------------------------
// Arena
// ---------------------------------------------------------------------------

/** Arena radius at the start of every round. */
export const ARENA_START_RADIUS = 9;
/** Smallest the arena ever gets. */
export const ARENA_END_RADIUS = 2.5;
/** Seconds of active play it takes to shrink from start to end radius. */
export const ARENA_SHRINK_TIME = 45;

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/** Player body radius. */
export const PLAYER_RADIUS = 0.5;
/** Distance from the centre at which each player spawns. */
export const SPAWN_DISTANCE = 4;
/** Aim rotation speed in radians per second (220 deg/s). */
export const AIM_SPEED = (220 * Math.PI) / 180;
/** Ice friction: velocity *= exp(-FRICTION * dt). Lower means slipperier. */
export const FRICTION = 1.6;
/** Bounciness of player-vs-player collisions (1 = perfectly elastic). */
export const PLAYER_RESTITUTION = 0.9;
/** Hard speed cap so players can't tunnel through things. */
export const MAX_PLAYER_SPEED = 45;
/** Seconds the fall animation lasts (shrink, spin, fade). */
export const FALL_DURATION = 1.1;

// ---------------------------------------------------------------------------
// Shooting. Each pair is [min charge, full charge] and is linearly
// interpolated by the charge amount (0..1).
// ---------------------------------------------------------------------------

/** Seconds of holding fire needed to reach full charge. */
export const CHARGE_TIME = 0.8;
/** Seconds after a shot before you can start charging again. */
export const FIRE_COOLDOWN = 0.15;
/** Bullet radius. */
export const BULLET_RADIUS: readonly [number, number] = [0.15, 0.35];
/** Bullet speed in units per second. */
export const BULLET_SPEED: readonly [number, number] = [9, 16];
/** Base knockback applied to the player who gets hit. */
export const BULLET_KNOCKBACK: readonly [number, number] = [4, 11];
/** Damage percentage added to the player who gets hit. */
export const BULLET_DAMAGE: readonly [number, number] = [6, 22];
/** Velocity kick applied to the shooter, opposite the aim direction. */
export const SHOT_RECOIL: readonly [number, number] = [3.5, 10];
/** Knockback is multiplied by (1 + damage / DAMAGE_SCALE). */
export const DAMAGE_SCALE = 100;
/** Gap between the player's edge and a freshly spawned bullet. */
export const MUZZLE_GAP = 0.05;
/** Bullets expire after this many seconds. */
export const BULLET_LIFETIME = 2.5;
/** Bullets are removed once this far outside the current arena edge. */
export const BULLET_CULL_MARGIN = 8;

// ---------------------------------------------------------------------------
// Round and match flow
// ---------------------------------------------------------------------------

/** Seconds of 3-2-1 countdown before each round. */
export const COUNTDOWN_TIME = 3;
/** Seconds the "FIGHT!" banner shows once play starts (visual only). */
export const FIGHT_BANNER_TIME = 0.7;
/** Seconds of celebration after a knockout, before the next round. */
export const ROUND_END_TIME = 2.5;
/** Round wins needed to take the match. */
export const WIN_SCORE = 5;

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

/** Seconds a room stays alive after everyone has left. */
export const ROOM_EMPTY_TTL = 60;
/** Seconds a disconnected player has to rejoin before the room closes. */
export const REJOIN_WINDOW = 60;
/** Client heartbeat/ping interval in milliseconds. */
export const PING_INTERVAL_MS = 1000;
/** Server drops sockets that have been silent this long (milliseconds). */
export const CLIENT_TIMEOUT_MS = 15000;
/** Client renders this many seconds behind the newest snapshot. */
export const INTERP_DELAY = 0.1;

// ---------------------------------------------------------------------------
// Client feel ("juice"). Purely visual, never affects the simulation.
// ---------------------------------------------------------------------------

/** Seconds of freeze on heavy hits. */
export const HIT_STOP_TIME = 0.06;
/** Knockback impulse above which a hit counts as heavy (triggers hit-stop). */
export const HEAVY_HIT_IMPULSE = 9;
/** Max screen shake offset in CSS pixels at full trauma. */
export const SHAKE_MAX_PX = 18;
/** How fast screen shake trauma decays per second. */
export const SHAKE_DECAY = 2.2;
/** Player speed above which a motion trail is drawn. */
export const TRAIL_MIN_SPEED = 4;
/** How fast the aim prediction eases back to the server value (per second). */
export const AIM_CORRECTION_RATE = 10;
