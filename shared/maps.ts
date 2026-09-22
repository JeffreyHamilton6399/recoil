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

/** Arena outline. Hex and diamond are regular polygons scaled to feel about as big as the circle. */
export type MapShape = 'circle' | 'square' | 'hex' | 'diamond';

export interface MapDef {
  name: string;
  blurb: string;
  shape: MapShape;
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
  {
    name: 'Hex Rink',
    blurb: 'Six sides, six ways to go out.',
    shape: 'hex',
    holes: [],
    bumpers: [],
    theme: { top: '#d9e8ff', shade: '#a9c4f0', side: '#5b7fc4', sideShade: '#3f5f9c' },
  },
  {
    name: 'Diamond',
    blurb: 'Sharp corners. Sharper players.',
    shape: 'diamond',
    holes: [],
    bumpers: [{ x: 0, y: 0, r: 0.9 }],
    theme: { top: '#d6fbff', shade: '#9fe6ef', side: '#3eb3c2', sideShade: '#2b8795' },
  },
  {
    name: 'Moat',
    blurb: 'A ring of holes guards the edge.',
    shape: 'circle',
    holes: [0, 1, 2, 3, 4, 5, 6, 7].map((k) => polar(6.6, 22.5 + k * 45, 0.8)),
    bumpers: [],
    theme: { top: '#e6ffd9', shade: '#b8eba0', side: '#6cb04a', sideShade: '#4e8a32' },
  },
  {
    name: 'Canyon',
    blurb: 'A crack splits the ice in two.',
    shape: 'circle',
    holes: [-5.8, -3.5, -1.2, 1.2, 3.5, 5.8].map((y) => ({ x: 0, y, r: 1.05 })),
    bumpers: [],
    theme: { top: '#ffe9dc', shade: '#f4c3a6', side: '#c46f45', sideShade: '#9a5230' },
  },
  {
    name: 'Bumper Alley',
    blurb: 'Six bumpers. Total chaos.',
    shape: 'square',
    holes: [],
    bumpers: [
      { x: -2.6, y: -2.6, r: 0.7 },
      { x: 2.6, y: -2.6, r: 0.7 },
      { x: -2.6, y: 2.6, r: 0.7 },
      { x: 2.6, y: 2.6, r: 0.7 },
      { x: 0, y: -5.4, r: 0.7 },
      { x: 0, y: 5.4, r: 0.7 },
    ],
    theme: { top: '#f0e0ff', shade: '#d3b3f5', side: '#9660cf', sideShade: '#7143a6' },
  },
  {
    name: 'Hive',
    blurb: 'Honeycomb holes and a sticky centre.',
    shape: 'hex',
    holes: [0, 1, 2, 3, 4, 5].map((k) => polar(6.2, 30 + k * 60, 0.85)),
    bumpers: [{ x: 0, y: 0, r: 0.85 }],
    theme: { top: '#fff1c9', shade: '#f5d68a', side: '#d19a2a', sideShade: '#a4761a' },
  },
];

/** Vertex radius and first vertex angle of the polygon shapes, relative to the arena radius. */
export const POLY_SHAPES: Record<'hex' | 'diamond', { sides: number; scale: number; rot: number }> = {
  hex: { sides: 6, scale: 1.03, rot: 0 },
  diamond: { sides: 4, scale: 1.05, rot: 0 },
};

/** Polygon corner points for a hex or diamond arena. */
export function polygonPoints(shape: 'hex' | 'diamond', arenaRadius: number): [number, number][] {
  const { sides, scale, rot } = POLY_SHAPES[shape];
  const rv = arenaRadius * scale;
  const pts: [number, number][] = [];
  for (let k = 0; k < sides; k++) {
    const a = rot + (k * Math.PI * 2) / sides;
    pts.push([Math.cos(a) * rv, Math.sin(a) * rv]);
  }
  return pts;
}

/** How much the map features are scaled at a given arena radius. */
export function mapScale(arenaRadius: number): number {
  return arenaRadius / C.ARENA_START_RADIUS;
}

/** True if a point is off the ice: past the edge or over a hole. */
export function isOffMap(map: MapDef, arenaRadius: number, x: number, y: number): boolean {
  if (map.shape === 'circle') {
    if (Math.hypot(x, y) > arenaRadius) return true;
  } else if (map.shape === 'square') {
    const h = arenaRadius * C.SQUARE_HALF_SCALE;
    if (Math.abs(x) > h || Math.abs(y) > h) return true;
  } else {
    // Inside a regular polygon: within the apothem along every edge normal.
    const { sides, scale, rot } = POLY_SHAPES[map.shape];
    const apothem = arenaRadius * scale * Math.cos(Math.PI / sides);
    for (let k = 0; k < sides; k++) {
      const a = rot + ((k + 0.5) * Math.PI * 2) / sides;
      if (x * Math.cos(a) + y * Math.sin(a) > apothem) return true;
    }
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

/** True if a player can stand here safely: on the ice, clear of hole edges and bumpers. */
function spawnIsSafe(map: MapDef, arenaRadius: number, x: number, y: number): boolean {
  const m = C.PLAYER_RADIUS + 0.3;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    if (isOffMap(map, arenaRadius, x + Math.cos(a) * m, y + Math.sin(a) * m)) return false;
  }
  if (isOffMap(map, arenaRadius, x, y)) return false;
  return !scaledBumpers(map, arenaRadius).some((b) => Math.hypot(x - b.x, y - b.y) < b.r + C.PLAYER_RADIUS + 0.3);
}

/**
 * Evenly spaced spawn point `index` of `count`, facing the centre. If the
 * ideal spot is over a hole or a bumper, it slides along the ring to the
 * nearest safe spot.
 */
export function spawnPoint(map: MapDef, index: number, count: number): { x: number; y: number; aim: number } {
  const n = Math.max(1, count);
  const base = Math.PI + (index / n) * Math.PI * 2;
  const R = C.ARENA_START_RADIUS;
  for (const dr of [0, -1, 1, -2, 1.8, -3]) {
    for (const da of [0, 0.12, -0.12, 0.25, -0.25, 0.4, -0.4]) {
      const a = base + da;
      const r = C.SPAWN_DISTANCE + dr;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (spawnIsSafe(map, R, x, y)) return { x, y, aim: Math.atan2(-y, -x) };
    }
  }
  const x = Math.cos(base) * C.SPAWN_DISTANCE;
  const y = Math.sin(base) * C.SPAWN_DISTANCE;
  return { x, y, aim: base + Math.PI };
}
