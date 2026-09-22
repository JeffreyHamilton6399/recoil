// Map definitions. Positions and sizes are for the full-size arena
// (radius ARENA_START_RADIUS) and scale down with it as it shrinks.

import * as C from './constants.js';

export interface Circle {
  x: number;
  y: number;
  r: number;
}

export interface MapTheme {
  /** Lit ice surface. */
  top: string;
  /** Shadowed ice surface. */
  shade: string;
  /** Slab side. */
  side: string;
  /** Slab side in shadow. */
  sideShade: string;
}

export interface MapDef {
  name: string;
  blurb: string;
  shape: 'circle' | 'square';
  /** Fall in if your centre is inside one. */
  holes: Circle[];
  /** Bouncy posts that knock players (and bullets) away. */
  bumpers: Circle[];
  theme: MapTheme;
}

const polar = (r: number, deg: number, size: number): Circle => {
  const a = (deg * Math.PI) / 180;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r, r: size };
};

export const MAPS: readonly MapDef[] = [
  {
    name: 'Frozen Pond',
    blurb: 'Plain ice. Pure skill.',
    shape: 'circle',
    holes: [],
    bumpers: [],
    theme: { top: '#c9f1ff', shade: '#94d3f0', side: '#4f9ccc', sideShade: '#35729f' },
  },
  {
    name: 'Donut',
    blurb: "Don't fall through the middle.",
    shape: 'circle',
    holes: [{ x: 0, y: 0, r: 2 }],
    bumpers: [],
    theme: { top: '#c8f7e1', shade: '#8fdcb8', side: '#3fa87c', sideShade: '#2c7c5b' },
  },
  {
    name: 'Pinball',
    blurb: 'Bumpers fling you. Hard.',
    shape: 'circle',
    holes: [],
    bumpers: [{ x: 0, y: 0, r: 1 }, polar(6.3, 0, 0.8), polar(6.3, 90, 0.8), polar(6.3, 180, 0.8), polar(6.3, 270, 0.8)],
    theme: { top: '#e3dcff', shade: '#b9aaf2', side: '#7a63cc', sideShade: '#5a45a3' },
  },
  {
    name: 'The Box',
    blurb: 'Corners are a trap.',
    shape: 'square',
    holes: [],
    bumpers: [],
    theme: { top: '#ffe6cc', shade: '#f5c396', side: '#d0844a', sideShade: '#a65f2d' },
  },
  {
    name: 'Swiss Ice',
    blurb: 'Full of holes. Watch your step.',
    shape: 'circle',
    holes: [polar(2.4, 90, 0.9), polar(2.4, 210, 0.9), polar(2.4, 330, 0.9), polar(6.8, 30, 0.8), polar(6.8, 150, 0.8), polar(6.8, 270, 0.8)],
    bumpers: [],
    theme: { top: '#fff4c4', shade: '#f2d98a', side: '#c9a23e', sideShade: '#9c7a26' },
  },
  {
    name: 'Pillars',
    blurb: 'A square with posts to hide behind.',
    shape: 'square',
    holes: [],
    bumpers: [polar(2.6, 0, 0.75), polar(2.6, 90, 0.75), polar(2.6, 180, 0.75), polar(2.6, 270, 0.75)],
    theme: { top: '#ffdcee', shade: '#f5aacd', side: '#cc5c93', sideShade: '#a13f70' },
  },
];

/** How much the map features are scaled at a given arena radius. */
export function mapScale(arenaRadius: number): number {
  return arenaRadius / C.ARENA_START_RADIUS;
}

/** True if a point is off the ice: past the edge or over a hole. */
export function isOffMap(map: MapDef, arenaRadius: number, x: number, y: number): boolean {
  if (map.shape === 'circle') {
    if (Math.hypot(x, y) > arenaRadius) return true;
  } else {
    const h = arenaRadius * C.SQUARE_HALF_SCALE;
    if (Math.abs(x) > h || Math.abs(y) > h) return true;
  }
  const s = mapScale(arenaRadius);
  for (const hole of map.holes) {
    if (Math.hypot(x - hole.x * s, y - hole.y * s) < hole.r * s) return true;
  }
  return false;
}

/** Bumpers at the current arena size. */
export function scaledBumpers(map: MapDef, arenaRadius: number): Circle[] {
  const s = mapScale(arenaRadius);
  return map.bumpers.map((b) => ({ x: b.x * s, y: b.y * s, r: b.r * s }));
}

/** Evenly spaced spawn point `index` of `count`, facing the centre. */
export function spawnPoint(index: number, count: number): { x: number; y: number; aim: number } {
  const n = Math.max(1, count);
  const a = Math.PI + (index / n) * Math.PI * 2;
  return { x: Math.cos(a) * C.SPAWN_DISTANCE, y: Math.sin(a) * C.SPAWN_DISTANCE, aim: a + Math.PI };
}
