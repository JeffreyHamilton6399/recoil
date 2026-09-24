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
  /** Kick back on the shooter. */
  recoil: readonly [number, number];
  /** Explosion radius when the bullet lands (0 = no explosion). */
  splash: number;
  /** Bullet drop (units per second squared). */
  gravity: number;
  /** Seconds before a bullet fizzles out (sets the range). */
  lifetime: number;
  /** Running speed multiplier. */
  moveMult: number;
  /** 1..5 bars for the weapon picker. */
  stats: { power: number; rate: number; range: number; mobility: number };
  /** Accent colour for the picker and the gun. */
  accent: string;
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
    speed: [34, 52],
    radius: [0.2, 0.42],
    knockback: [4.5, 11],
    damage: [6, 20],
    recoil: [1, 3],
    splash: 0,
    gravity: 0,
    lifetime: 2,
    moveMult: 1,
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
    speed: [36, 36],
    radius: [0.13, 0.13],
    knockback: [2.4, 2.4],
    damage: [3, 3],
    recoil: [4.5, 4.5],
    splash: 0,
    gravity: 0,
    lifetime: 0.42,
    moveMult: 1.05,
    stats: { power: 5, rate: 2, range: 1, mobility: 4 },
    accent: '#ff8a3d',
  },
  {
    name: 'Longshot',
    blurb: 'Charge a lightning-fast bolt. Hits like a train.',
    mode: 'charge',
    chargeTime: 1.1,
    cooldown: 0.5,
    pellets: 1,
    spread: 0,
    speed: [90, 150],
    radius: [0.14, 0.22],
    knockback: [3, 15],
    damage: [8, 30],
    recoil: [0.5, 2],
    splash: 0,
    gravity: 0,
    lifetime: 1.2,
    moveMult: 0.92,
    stats: { power: 5, rate: 1, range: 5, mobility: 2 },
    accent: '#a45cff',
  },
  {
    name: 'Boomer',
    blurb: 'Lobs a bomb that bursts on impact. Shoot your feet to fly.',
    mode: 'auto',
    chargeTime: 0,
    cooldown: 0.85,
    pellets: 1,
    spread: 0,
    speed: [26, 26],
    radius: [0.32, 0.32],
    knockback: [12, 12],
    damage: [15, 15],
    recoil: [1.5, 1.5],
    splash: 3.4,
    gravity: 7,
    lifetime: 3,
    moveMult: 0.95,
    stats: { power: 4, rate: 2, range: 3, mobility: 5 },
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
    speed: [44, 44],
    radius: [0.12, 0.12],
    knockback: [1.5, 1.5],
    damage: [2.2, 2.2],
    recoil: [0.25, 0.25],
    splash: 0,
    gravity: 0,
    lifetime: 1.1,
    moveMult: 1.1,
    stats: { power: 1, rate: 5, range: 3, mobility: 4 },
    accent: '#3ccf6e',
  },
];

export function weaponDef(index: number): WeaponDef {
  return WEAPONS[index] ?? WEAPONS[0];
}

export function isWeapon(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < WEAPONS.length;
}
