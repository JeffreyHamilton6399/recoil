// Weapons. Every player picks one in the lobby. Semi-automatic guns fire once
// per click; automatic guns fire for as long as the trigger is held.
// Heavier guns hit harder: more damage, and more knockback.

export type FireMode = 'semi' | 'auto';

export interface WeaponDef {
  name: string;
  blurb: string;
  mode: FireMode;
  /** Seconds after a shot before the next one. */
  cooldown: number;
  /** Bullets per shot, fanned out by `spread` radians (random within it for pellets). */
  pellets: number;
  spread: number;
  speed: number;
  radius: number;
  /** Knockback per bullet. */
  knockback: number;
  /** Damage percentage per bullet. */
  damage: number;
  /** Kick back on the shooter normally (kept small: getting hit is what sends you flying). */
  recoil: number;
  /** Kick back on the shooter in recoil mode, per shot. */
  boost: number;
  /** How far the view punches up when you fire (radians; visual only). */
  viewKick: number;
  /** Explosion radius when the bullet lands (0 = no explosion). */
  splash: number;
  /** Bullet drop (units per second squared). */
  gravity: number;
  /** Seconds before a bullet fizzles out (sets the range). */
  lifetime: number;
  /** Running speed multiplier. */
  moveMult: number;
  /** Field of view (degrees) while aiming down sights. */
  adsFov: number;
  /** Aiming shows a scope overlay instead of the gun. */
  scope: boolean;
  /** 1..5 bars for the weapon picker. */
  stats: { power: number; rate: number; range: number; mobility: number };
  /** Accent colour for the picker and the gun. */
  accent: string;
  /** Bounces off the roof and walls with this restitution instead of stopping (grenades). */
  bounce?: number;
  /** Bursts when its lifetime runs out instead of fizzling (grenades). */
  fuse?: boolean;
  /** Goes straight through players, hitting each one once. */
  pierce?: boolean;
}

export const WEAPONS: readonly WeaponDef[] = [
  {
    name: 'Revolver',
    blurb: 'Six-shooter. Every click is a solid shove. The all-rounder.',
    mode: 'semi',
    cooldown: 0.3,
    pellets: 1,
    spread: 0,
    speed: 95,
    radius: 0.16,
    knockback: 12,
    damage: 12,
    recoil: 1,
    boost: 18,
    viewKick: 0.05,
    splash: 0,
    gravity: 0,
    lifetime: 1.1,
    moveMult: 1,
    adsFov: 58,
    scope: false,
    stats: { power: 3, rate: 3, range: 4, mobility: 3 },
    accent: '#00e1ff',
  },
  {
    name: 'Scatter',
    blurb: 'Pump shotgun. A fistful of pellets: brutal up close, useless far away.',
    mode: 'semi',
    cooldown: 0.8,
    pellets: 7,
    spread: 0.1,
    speed: 75,
    radius: 0.1,
    knockback: 4.2,
    damage: 3,
    recoil: 2.2,
    boost: 26,
    viewKick: 0.09,
    splash: 0,
    gravity: 0,
    lifetime: 0.2,
    moveMult: 1.05,
    adsFov: 66,
    scope: false,
    stats: { power: 5, rate: 2, range: 1, mobility: 4 },
    accent: '#ff8a3d',
  },
  {
    name: 'Longshot',
    blurb: 'Bolt-action sniper. Slow, but one clean hit sends them flying.',
    mode: 'semi',
    cooldown: 1.1,
    pellets: 1,
    spread: 0,
    speed: 240,
    radius: 0.14,
    knockback: 26,
    damage: 30,
    recoil: 1.2,
    boost: 30,
    viewKick: 0.13,
    splash: 0,
    gravity: 0,
    lifetime: 0.7,
    moveMult: 0.92,
    adsFov: 26,
    scope: true,
    stats: { power: 5, rate: 1, range: 5, mobility: 2 },
    accent: '#a45cff',
  },
  {
    name: 'Boomer',
    blurb: 'Launcher. Lobs a bomb that bursts on impact and blasts everyone nearby.',
    mode: 'semi',
    cooldown: 0.85,
    pellets: 1,
    spread: 0,
    speed: 26,
    radius: 0.32,
    knockback: 20,
    damage: 15,
    recoil: 1,
    boost: 23,
    viewKick: 0.08,
    splash: 3.4,
    gravity: 7,
    lifetime: 3,
    moveMult: 0.95,
    adsFov: 60,
    scope: false,
    stats: { power: 4, rate: 2, range: 3, mobility: 3 },
    accent: '#ff3d8b',
  },
  {
    name: 'Pepper',
    blurb: 'SMG. Hold the trigger for a stream of little pokes.',
    mode: 'auto',
    cooldown: 0.085,
    pellets: 1,
    spread: 0.03,
    speed: 85,
    radius: 0.09,
    knockback: 2.6,
    damage: 2.2,
    recoil: 0.2,
    boost: 2.6,
    viewKick: 0.012,
    splash: 0,
    gravity: 0,
    lifetime: 0.57,
    moveMult: 1.1,
    adsFov: 58,
    scope: false,
    stats: { power: 1, rate: 5, range: 3, mobility: 4 },
    accent: '#3ccf6e',
  },
  {
    name: 'Minigun',
    blurb: 'Spins up a storm. Tiny shoves, but so many of them. Slow to run with.',
    mode: 'auto',
    cooldown: 0.055,
    pellets: 1,
    spread: 0.055,
    speed: 105,
    radius: 0.11,
    knockback: 3.1,
    damage: 1.5,
    recoil: 0.15,
    boost: 2.4,
    viewKick: 0.007,
    splash: 0,
    gravity: 0,
    lifetime: 0.55,
    moveMult: 0.8,
    adsFov: 62,
    scope: false,
    stats: { power: 1, rate: 5, range: 2, mobility: 1 },
    accent: '#ff5a5f',
  },
  {
    name: 'Railgun',
    blurb: 'A slug that goes straight through everyone in a line. Slow to reload.',
    mode: 'semi',
    cooldown: 1.35,
    pellets: 1,
    spread: 0,
    speed: 320,
    radius: 0.13,
    knockback: 27,
    damage: 18,
    recoil: 3,
    boost: 34,
    viewKick: 0.1,
    splash: 0,
    gravity: 0,
    lifetime: 0.35,
    moveMult: 0.92,
    adsFov: 40,
    scope: false,
    stats: { power: 5, rate: 1, range: 5, mobility: 3 },
    accent: '#7fe7ff',
    pierce: true,
  },
  {
    name: 'Flak',
    blurb: 'Shells that burst in the air. Catch people mid-jump.',
    mode: 'semi',
    cooldown: 0.75,
    pellets: 1,
    spread: 0,
    speed: 48,
    radius: 0.2,
    knockback: 15,
    damage: 7,
    recoil: 1.4,
    boost: 20,
    viewKick: 0.05,
    splash: 3.8,
    gravity: 5,
    lifetime: 0.5,
    moveMult: 1,
    adsFov: 56,
    scope: false,
    stats: { power: 3, rate: 3, range: 3, mobility: 4 },
    accent: '#ffb13d',
    fuse: true,
  },
];

/**
 * The shock grenade, thrown with the offhand. It isn't in the weapon picker;
 * bullets from it use this index.
 */
export const SHOCK_WEAPON = 9;
export const SHOCK_GRENADE: WeaponDef = {
  name: 'Shock grenade',
  blurb: 'Bounces, then bursts into a shockwave that throws everyone nearby. Hardly any damage.',
  mode: 'semi',
  cooldown: 0,
  pellets: 1,
  spread: 0,
  speed: 19,
  radius: 0.2,
  knockback: 23,
  damage: 4,
  recoil: 0,
  boost: 0,
  viewKick: 0,
  splash: 6,
  gravity: 20,
  lifetime: 1.1,
  moveMult: 1,
  adsFov: 60,
  scope: false,
  stats: { power: 4, rate: 1, range: 3, mobility: 3 },
  accent: '#7fe7ff',
  bounce: 0.45,
  fuse: true,
};

/** Turret shots and sudden-death bombs: not in the picker either. */
export const TURRET_WEAPON = 10;
export const TURRET_GUN: WeaponDef = {
  name: 'Turret',
  blurb: 'An automatic turret.',
  mode: 'semi',
  cooldown: 0,
  pellets: 1,
  spread: 0,
  speed: 60,
  radius: 0.22,
  knockback: 12,
  damage: 6,
  recoil: 0,
  boost: 0,
  viewKick: 0,
  splash: 0,
  gravity: 0,
  lifetime: 0.7,
  moveMult: 1,
  adsFov: 60,
  scope: false,
  stats: { power: 3, rate: 2, range: 4, mobility: 1 },
  accent: '#ff9f1c',
};
export const BOMB_WEAPON = 11;
export const SKY_BOMB: WeaponDef = {
  name: 'Bomb',
  blurb: 'Sudden death.',
  mode: 'semi',
  cooldown: 0,
  pellets: 1,
  spread: 0,
  speed: 0,
  radius: 0.45,
  knockback: 30,
  damage: 16,
  recoil: 0,
  boost: 0,
  viewKick: 0,
  splash: 5.5,
  gravity: 20,
  lifetime: 5,
  moveMult: 1,
  adsFov: 60,
  scope: false,
  stats: { power: 5, rate: 1, range: 1, mobility: 1 },
  accent: '#ff3b4e',
};
/** Bullets from things that aren't players: owner -1 for a turret, -2 for a sudden-death bomb. */
export const TURRET_OWNER = -1;
export const BOMB_OWNER = -2;

export function weaponDef(index: number): WeaponDef {
  if (index === SHOCK_WEAPON) return SHOCK_GRENADE;
  if (index === TURRET_WEAPON) return TURRET_GUN;
  if (index === BOMB_WEAPON) return SKY_BOMB;
  return WEAPONS[index] ?? WEAPONS[0];
}

/** Offhands for the lobby picker (index = offhand id). */
export const OFFHANDS: readonly { name: string; blurb: string; accent: string }[] = [
  { name: 'Knife', blurb: 'Press E to pull it out, then slash as often as you like. A big shove up close.', accent: '#e8e4f2' },
  { name: 'Shock grenade', blurb: 'Bounces, then bursts into a shockwave that throws everyone nearby.', accent: '#7fe7ff' },
];

export function isOffhand(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < OFFHANDS.length;
}

export function isWeapon(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < WEAPONS.length;
}
