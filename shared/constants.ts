// All tuning constants for RECOIL live here. The world is 3D: x and y are
// horizontal, z is up, and the roof is at z = 0. One unit is about a metre,
// and times are in seconds, unless noted otherwise.
// Both the server and the client import this file, so changing a value
// changes the game everywhere.

// ---------------------------------------------------------------------------
// Simulation timing
// ---------------------------------------------------------------------------

/** Server simulation rate in ticks per second. Clients send one input per tick too. */
export const TICK_RATE = 30;
/** Seconds per simulation tick. */
export const TICK_DT = 1 / TICK_RATE;
/** Physics substeps per tick. More substeps mean fewer missed collisions at high speed. */
export const PHYSICS_SUBSTEPS = 3;

// ---------------------------------------------------------------------------
// Rooms and players
// ---------------------------------------------------------------------------

/** Most players in one room. Extra visitors become spectators. */
export const MAX_PLAYERS = 8;
/** Players needed before the host can start a match. */
export const MIN_PLAYERS = 2;
/** Public rooms start this many seconds after a second player arrives. */
export const PUBLIC_START_DELAY = 20;
/** ...or this soon once the room is full. */
export const PUBLIC_FULL_START_DELAY = 3;
/** Longest allowed player name. */
export const NAME_MAX = 12;
/** Player colours to pick from (one per player per room). */
export const PLAYER_PALETTE: readonly string[] = [
  '#ff5a5f', // red
  '#4d8bff', // blue
  '#3ccf6e', // green
  '#ffc93c', // yellow
  '#a45cff', // purple
  '#ff8a3d', // orange
  '#ff6fc1', // pink
  '#2ed3c6', // teal
];
export const PLAYER_COLOR_NAMES: readonly string[] = ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange', 'Pink', 'Teal'];

// ---------------------------------------------------------------------------
// Arena
// ---------------------------------------------------------------------------

/** Arena radius at the start of every round. */
export const ARENA_START_RADIUS = 38;
/** Smallest the arena ever gets. */
export const ARENA_END_RADIUS = 10;
/** Seconds of active play it takes to shrink from start to end radius. */
export const ARENA_SHRINK_TIME = 95;
/** Square maps have a half-width of radius * this. */
export const SQUARE_HALF_SCALE = 0.9;
/** Bumpers bounce players away with this restitution (>1 adds energy, like pinball). */
export const BUMPER_RESTITUTION = 1.25;
/** Minimum speed a bumper sends you away at. */
export const BUMPER_MIN_BOUNCE = 8;
/** Bumpers are pillars this tall. Players and bullets above them pass over. */
export const BUMPER_HEIGHT = 5;

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/** Player body radius (players are upright capsules). */
export const PLAYER_RADIUS = 0.45;
/** Player height, feet to top of head. */
export const PLAYER_HEIGHT = 1.8;
/** Camera and gun height above the feet. */
export const EYE_HEIGHT = 1.55;
/** Players spawn evenly spaced on a ring of this radius. */
export const SPAWN_DISTANCE = 19;
/** Running speed on the roof. */
export const MOVE_SPEED = 7.5;
/** How fast you reach running speed (units per second squared). */
export const GROUND_ACCEL = 70;
/**
 * Above running speed (after a knockback or a recoil boost) you slide, and
 * the extra speed decays like velocity *= exp(-SLIDE_FRICTION * dt).
 */
export const SLIDE_FRICTION = 2.2;
/** Steering while sliding. */
export const SLIDE_ACCEL = 14;
/** Steering in the air (Quake-style: only up to running speed along the wish direction). */
export const AIR_ACCEL = 18;
/** Air drag: velocity *= exp(-AIR_DRAG * dt). */
export const AIR_DRAG = 0.25;
/** Downward acceleration. */
export const GRAVITY = 22;
/** Upward speed of a jump. */
export const JUMP_SPEED = 8;
/** Below this height you can no longer get back up: you have fallen. */
export const FALL_Z = -2.5;
/** Pitch limit in radians (just short of straight up or down). */
export const PITCH_LIMIT = 1.5;
/** Bounciness of player-vs-player collisions (1 = perfectly elastic). */
export const PLAYER_RESTITUTION = 0.9;
/** Hard speed cap so players can't tunnel through things. */
export const MAX_PLAYER_SPEED = 45;
/** Seconds the fall is shown before you count as out. */
export const FALL_DURATION = 1.6;
/** In the lobby warm-up, seconds after the fall before you respawn. */
export const LOBBY_RESPAWN_DELAY = 0.4;

// ---------------------------------------------------------------------------
// Moving like a shooter: sprint, slide, climb, jump pads
// ---------------------------------------------------------------------------

/** Holding sprint while moving forward multiplies running speed by this. */
export const SPRINT_MULT = 1.45;
/** A slide kicks you this much faster than you were going... */
export const SLIDE_BOOST = 4.5;
/** ...and at least this fast, but a slide never pushes you past SLIDE_MAX
 * (so chaining slide-hops can't build speed forever; knockback still can)... */
export const SLIDE_SPEED = 15;
export const SLIDE_MAX = 16.5;
/** ...lasts this long... */
export const SLIDE_TIME = 0.9;
/** ...slows like velocity *= exp(-SLIDE_DECAY * dt)... */
export const SLIDE_DECAY = 0.9;
/** ...and needs you to be moving at least this fast to start. */
export const SLIDE_MIN_SPEED = 5;
/** Seconds after a slide before the next one. */
export const SLIDE_COOLDOWN = 0.45;
/** Eye height while sliding. */
export const SLIDE_EYE_HEIGHT = 0.95;
/** You walk up anything shorter than this without jumping. */
export const STEP_HEIGHT = 0.4;
/** Ledges up to this far above your feet can be climbed (hold forward and jump). */
export const MANTLE_MAX = 2.7;
/** Jump pads launch you up this fast... */
export const PAD_SPEED = 17;
/** ...and multiply your running speed by this, so you can aim the leap. */
export const PAD_BOOST = 1.35;

// ---------------------------------------------------------------------------
// Shooting (per-weapon stats are in weapons.ts)
// ---------------------------------------------------------------------------

/** Knockback also lifts you off your feet by this fraction of its strength. */
export const KNOCKBACK_LIFT = 0.5;
/** Knockback is multiplied by (1 + damage / DAMAGE_SCALE). */
export const DAMAGE_SCALE = 80;
/** Explosions push the shooter too, by this fraction and without damage. */
export const SELF_SPLASH = 0.5;
/** Aiming down sights: running speed multiplier and how much tighter the spread gets. */
export const AIM_MOVE_MULT = 0.7;
export const AIM_SPREAD_MULT = 0.35;
/** Gap between the player's edge and a freshly spawned bullet. */
export const MUZZLE_GAP = 0.05;
/** Bullets are removed once this far outside the current arena edge. */
export const BULLET_CULL_MARGIN = 40;

// ---------------------------------------------------------------------------
// Power-ups
// ---------------------------------------------------------------------------

/** Seconds into a round before the first power-up appears. */
export const POWERUP_FIRST_DELAY = 5;
/** Random gap between power-up spawns, [min, max] seconds. */
export const POWERUP_INTERVAL: readonly [number, number] = [5, 9];
/** Most power-ups on the roof at once. */
export const POWERUP_MAX = 3;
/** Pickup radius. */
export const POWERUP_RADIUS = 0.6;
/** Power-ups float this high above the roof. */
export const POWERUP_HEIGHT = 1;
/** Uncollected power-ups vanish after this many seconds. */
export const POWERUP_LIFETIME = 12;
/** Rapid Fire: duration (it halves the time between shots). */
export const RAPID_TIME = 6;
/** Triple Shot: duration and the angle between the three volleys (radians). */
export const TRIPLE_TIME = 7;
export const TRIPLE_SPREAD = 0.12;
/** Mega Shot: number of boosted shots and how much they are boosted. */
export const MEGA_SHOTS = 3;
export const MEGA_KNOCKBACK_MULT = 1.6;
export const MEGA_RADIUS_MULT = 1.5;
export const MEGA_DAMAGE_MULT = 1.4;
/** Shield: blocks the next hit, or expires after this many seconds. */
export const SHIELD_TIME = 8;

// ---------------------------------------------------------------------------
// Round and match flow
// ---------------------------------------------------------------------------

/** Seconds of 3-2-1 countdown before each round. */
export const COUNTDOWN_TIME = 3;
/** Seconds the "FIGHT!" banner shows once play starts (visual only). */
export const FIGHT_BANNER_TIME = 0.7;
/** Seconds of celebration after a round, before the next one. */
export const ROUND_END_TIME = 2.5;
/** Seconds the winner is celebrated before everyone returns to the lobby. */
export const MATCH_END_TIME = 7;
/** Round wins needed to take the match. */
export const WIN_SCORE = 5;

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

/** Seconds a room stays alive after everyone has left. */
export const ROOM_EMPTY_TTL = 60;
/** Seconds a disconnected player keeps their seat (and score) to rejoin. */
export const REJOIN_WINDOW = 60;
/** Client heartbeat/ping interval in milliseconds. */
export const PING_INTERVAL_MS = 1000;
/** Server drops sockets that have been silent this long (milliseconds). */
export const CLIENT_TIMEOUT_MS = 15000;
/** Client renders other players this many seconds behind the newest snapshot. */
export const INTERP_DELAY = 0.1;
/** Inputs the server buffers per player before it drops the oldest. */
export const INPUT_BUFFER_MAX = 6;

// ---------------------------------------------------------------------------
// Client feel ("juice"). Purely visual, never affects the simulation.
// ---------------------------------------------------------------------------

/** Knockback impulse above which a hit counts as heavy (bigger shake and a comic word). */
export const HEAVY_HIT_IMPULSE = 18;
/** Max camera shake in radians at full trauma. */
export const SHAKE_MAX_ANGLE = 0.035;
/** How fast camera shake trauma decays per second. */
export const SHAKE_DECAY = 2.4;
/** How fast a prediction correction is smoothed away (per second). */
export const CORRECTION_RATE = 12;
/** Corrections bigger than this snap instead of smoothing. */
export const CORRECTION_SNAP = 3;
/** Mouse look sensitivity in radians per pixel. */
export const MOUSE_SENSITIVITY = 0.0022;
/** Camera field of view in degrees (vertical). */
export const FOV = 80;

// ---------------------------------------------------------------------------
// Offhand (E): every player carries one, picked in the lobby
// ---------------------------------------------------------------------------

/** Offhand ids. */
export const OFFHAND_KNIFE = 0;
export const OFFHAND_SHOCK = 1;
/** Knife: pull it out with E and slash with fire as often as you like. Reach (from your centre to theirs, plus body radii)... */
export const KNIFE_RANGE = 2.3;
/** ...only in front of you (cosine of the half-angle of the swing)... */
export const KNIFE_CONE = 0.55;
/** ...a big close-range shove... */
export const KNIFE_KNOCKBACK = 15;
export const KNIFE_DAMAGE = 11;
/** ...with a small lunge forward as you swing... */
export const KNIFE_LUNGE = 4;
/** ...and one swing takes this long (hold fire to keep slashing). */
export const KNIFE_SWING = 0.4;
/** Running speed multiplier with the knife out. */
export const KNIFE_MOVE_MULT = 1.12;

/** Shock grenade: seconds before you can throw another. */
export const SHOCK_COOLDOWN = 7;
/** Extra upward angle when throwing, so it arcs. */
export const SHOCK_LOFT = 0.18;

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

/** Quick play: once someone has waited this long alone, bots fill the room... */
export const PUBLIC_BOT_DELAY = 5;
/** ...up to this many players in total (they leave as real players join). */
export const PUBLIC_BOT_FILL = 4;

