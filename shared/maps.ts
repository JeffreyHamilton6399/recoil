// Map definitions. Positions and sizes are for the full-size arena
// (radius ARENA_START_RADIUS) and scale down with it as it shrinks.

import * as C from './constants.js';

export interface Circle {
  x: number;
  y: number;
  r: number;
}

/** What the rooftop is covered with (drawn by the client). */
export type Surface =
  | 'helipad'
  | 'gravel'
  | 'neon'
  | 'tar'
  | 'plate'
  | 'tiles'
  | 'paving'
  | 'billboard'
  | 'garden'
  | 'plywood'
  | 'parking'
  | 'solar';

export interface MapTheme {
  /** Lit rooftop surface. */
  top: string;
  /** Shadowed rooftop surface. */
  shade: string;
  /** Building facade under the roof. */
  side: string;
  /** Facade in shadow. */
  sideShade: string;
  surface: Surface;
  /** Bumper colour (pinball bumpers, chimneys, traffic cones...). */
  bumper: string;
}

/** Arena outline. Hex and diamond are regular polygons scaled to feel about as big as the circle. */
export type MapShape = 'circle' | 'square' | 'hex' | 'diamond';

export interface MapDef {
  name: string;
  blurb: string;
  shape: MapShape;
  /** Open vents / skylights: fall in if your centre is inside one. */
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
    name: 'Helipad',
    blurb: 'A clean landing pad. Pure skill.',
    shape: 'circle',
    holes: [],
    bumpers: [],
    theme: { top: '#b9c3d6', shade: '#8d98b3', side: '#5b5f86', sideShade: '#3f4166', surface: 'helipad', bumper: '#ff3d8b' },
  },
  {
    name: 'Skylight',
    blurb: "Don't fall through the skylight.",
    shape: 'circle',
    holes: [{ x: 0, y: 0, r: 2 }],
    bumpers: [],
    theme: { top: '#d8cfc4', shade: '#b3a797', side: '#7a5f6e', sideShade: '#5a4152', surface: 'gravel', bumper: '#ff3d8b' },
  },
  {
    name: 'Arcade Roof',
    blurb: 'Neon pinball bumpers fling you. Hard.',
    shape: 'circle',
    holes: [],
    bumpers: [{ x: 0, y: 0, r: 1 }, polar(6.3, 0, 0.8), polar(6.3, 90, 0.8), polar(6.3, 180, 0.8), polar(6.3, 270, 0.8)],
    theme: { top: '#3b2a6b', shade: '#2a1d52', side: '#2c2158', sideShade: '#1b1440', surface: 'neon', bumper: '#ff2e88' },
  },
  {
    name: 'The Block',
    blurb: 'A tar roof. Corners are a trap.',
    shape: 'square',
    holes: [],
    bumpers: [],
    theme: { top: '#55566d', shade: '#3e3f55', side: '#6b4a5a', sideShade: '#4d3342', surface: 'tar', bumper: '#ff3d8b' },
  },
  {
    name: 'Vent Farm',
    blurb: 'Open vents everywhere. Watch your step.',
    shape: 'circle',
    holes: [polar(2.4, 90, 0.9), polar(2.4, 210, 0.9), polar(2.4, 330, 0.9), polar(6.8, 30, 0.8), polar(6.8, 150, 0.8), polar(6.8, 270, 0.8)],
    bumpers: [],
    theme: { top: '#a9b8c6', shade: '#8293a8', side: '#4f6a82', sideShade: '#374d63', surface: 'plate', bumper: '#ff3d8b' },
  },
  {
    name: 'Chimneys',
    blurb: 'Terracotta tiles and chimneys to hide behind.',
    shape: 'square',
    holes: [],
    bumpers: [polar(2.6, 0, 0.75), polar(2.6, 90, 0.75), polar(2.6, 180, 0.75), polar(2.6, 270, 0.75)],
    theme: { top: '#e08462', shade: '#b85e44', side: '#6d4a6a', sideShade: '#4f324d', surface: 'tiles', bumper: '#9c3b31' },
  },
  {
    name: 'Hex Plaza',
    blurb: 'Six sides, six ways to go out.',
    shape: 'hex',
    holes: [],
    bumpers: [],
    theme: { top: '#e3d8c4', shade: '#c2b39b', side: '#7d6a8a', sideShade: '#5d4c6b', surface: 'paving', bumper: '#ff3d8b' },
  },
  {
    name: 'Billboard',
    blurb: 'Fight on top of an ad. Sharp corners.',
    shape: 'diamond',
    holes: [],
    bumpers: [{ x: 0, y: 0, r: 0.9 }],
    theme: { top: '#ffd93d', shade: '#f0b21e', side: '#3a3f7a', sideShade: '#282b5c', surface: 'billboard', bumper: '#ff2e88' },
  },
  {
    name: 'Sky Garden',
    blurb: 'Mind the open drains around the lawn.',
    shape: 'circle',
    holes: [0, 1, 2, 3, 4, 5, 6, 7].map((k) => polar(6.6, 22.5 + k * 45, 0.8)),
    bumpers: [],
    theme: { top: '#74d27e', shade: '#4fa85c', side: '#5a6a8a', sideShade: '#3f4d6b', surface: 'garden', bumper: '#ff3d8b' },
  },
  {
    name: 'Split Level',
    blurb: 'A construction gap splits the roof in two.',
    shape: 'circle',
    holes: [-5.8, -3.5, -1.2, 1.2, 3.5, 5.8].map((y) => ({ x: 0, y, r: 1.05 })),
    bumpers: [],
    theme: { top: '#e6bb7e', shade: '#c4955a', side: '#6a5a7a', sideShade: '#4c3f5c', surface: 'plywood', bumper: '#ff3d8b' },
  },
  {
    name: 'Parking Deck',
    blurb: 'Six traffic cones. Total chaos.',
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
    theme: { top: '#5c5f74', shade: '#46485c', side: '#8a8fa3', sideShade: '#666a80', surface: 'parking', bumper: '#ff7a1a' },
  },
  {
    name: 'Solar Farm',
    blurb: 'Panels, open hatches and a pylon in the middle.',
    shape: 'hex',
    holes: [0, 1, 2, 3, 4, 5].map((k) => polar(6.2, 30 + k * 60, 0.85)),
    bumpers: [{ x: 0, y: 0, r: 0.85 }],
    theme: { top: '#3a5ea3', shade: '#29467f', side: '#56607a', sideShade: '#3c455c', surface: 'solar', bumper: '#ffd93d' },
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
