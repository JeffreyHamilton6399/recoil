// Weapons. Every player picks one in the lobby. Each pair is [min charge,
// full charge] for charge weapons; automatic weapons always fire at full
// (so both values are the same).

export type FireMode = 'charge' | 'auto';

export interface WeaponDef {
  name: string;
  blurb: string;
  mode: FireMode;
  /** Charge weapons: seconds to full charge. */
  chargeTime: number;
  /** Seconds after a shot before the next one. */
  cooldown: number;
  /** Bullets per shot, fanned out by `spread` radians (random within it for pellets). */
  pellets: number;
  spread: number;
  speed: readonly [number, number];
  radius: readonly [number, number];
  /** Knockback per bullet. */
  knockback: readonly [number, number];
  /** Damage percentage per bullet. */
  damage: readonly [number, number];
  /** Kick back on the shooter (kept small: getting hit is what sends you flying). */
  recoil: readonly [number, number];
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
}

export const WEAPONS: readonly WeaponDef[] = [
  {
    name: 'Blaster',
    blurb: 'Hold to charge a big shove. The all-rounder.',
    mode: 'charge',
    chargeTime: 0.7,
    cooldown: 0.15,
    pellets: 1,
    spread: 0,
    speed: [70, 100],
    radius: [0.15, 0.26],
    knockback: [8, 19],
    damage: [6, 20],
    recoil: [0.3, 0.8],
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
    blurb: 'A fistful of pellets. Brutal up close, useless far away.',
    mode: 'auto',
    chargeTime: 0,
    cooldown: 0.8,
    pellets: 7,
    spread: 0.1,
    speed: [75, 75],
    radius: [0.1, 0.1],
    knockback: [4.2, 4.2],
    damage: [3, 3],
    recoil: [1.2, 1.2],
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
    blurb: 'Charge a high-velocity round. Hits like a train.',
    mode: 'charge',
    chargeTime: 1.1,
    cooldown: 0.5,
    pellets: 1,
    spread: 0,
    speed: [170, 240],
    radius: [0.11, 0.15],
    knockback: [5, 26],
    damage: [8, 30],
    recoil: [0.2, 0.6],
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
    blurb: 'Lobs a bomb that bursts on impact and blasts everyone nearby.',
    mode: 'auto',
    chargeTime: 0,
    cooldown: 0.85,
    pellets: 1,
    spread: 0,
    speed: [26, 26],
    radius: [0.32, 0.32],
    knockback: [20, 20],
    damage: [15, 15],
    recoil: [0.5, 0.5],
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
    blurb: 'Hold the trigger for a stream of little pokes.',
    mode: 'auto',
    chargeTime: 0,
    cooldown: 0.085,
    pellets: 1,
    spread: 0.03,
    speed: [85, 85],
    radius: [0.09, 0.09],
    knockback: [2.6, 2.6],
    damage: [2.2, 2.2],
    recoil: [0.1, 0.1],
    splash: 0,
    gravity: 0,
    lifetime: 0.57,
    moveMult: 1.1,
    adsFov: 58,
    scope: false,
    stats: { power: 1, rate: 5, range: 3, mobility: 4 },
    accent: '#3ccf6e',
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
  mode: 'auto',
  chargeTime: 0,
  cooldown: 0,
  pellets: 1,
  spread: 0,
  speed: [19, 19],
  radius: [0.2, 0.2],
  knockback: [23, 23],
  damage: [4, 4],
  recoil: [0, 0],
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

export function weaponDef(index: number): WeaponDef {
  if (index === SHOCK_WEAPON) return SHOCK_GRENADE;
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
