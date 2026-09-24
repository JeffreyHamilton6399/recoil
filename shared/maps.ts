// Map definitions. Positions and sizes are in "design units", for an arena
// of radius MAP_DESIGN_RADIUS. They are scaled up to the real arena size
// (ARENA_START_RADIUS) and shrink with it.

import * as C from './constants.js';

/** Arena radius the map layouts (and the client's surface art) are drawn for. */
export const MAP_DESIGN_RADIUS = 9;

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

/**
 * A solid box: crates, AC units, walls, planters, or (with z) a floating
 * slab such as a building's roof or a bridge. x, y, w (along x) and d (along
 * y) are design units; z (its underside, default 0) and h (its top) are
 * metres above the roof. You can stand on it, climb it if it's low enough,
 * and walk under it if it's high enough.
 */
export interface Block {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  z?: number;
}

/**
 * A ramp: a wedge you can walk up, rising from 0 to h metres towards `dir`
 * (0 = +x, 1 = +y, 2 = -x, 3 = -y). Footprint in design units, like a Block.
 */
export interface Ramp {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  dir: 0 | 1 | 2 | 3;
}

export interface MapDef {
  name: string;
  blurb: string;
  shape: MapShape;
  /** Open vents / skylights: fall in if your centre is inside one. */
  holes: Circle[];
  /** Bouncy posts that knock players (and bullets) away. */
  bumpers: Circle[];
  /** Obstacles to climb, hide behind and stand on (and buildings to run through). */
  blocks: Block[];
  /** Ramps up onto buildings and bridges. */
  ramps?: Ramp[];
  /** Jump pads: step on one to be launched into the air. */
  pads: Circle[];
  theme: MapTheme;
}

const polar = (r: number, deg: number, size: number): Circle => {
  const a = (deg * Math.PI) / 180;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r, r: size };
};

/** A square box centred at a polar position. */
const crate = (r: number, deg: number, size: number, h: number): Block => {
  const c = polar(r, deg, 0);
  return { x: c.x, y: c.y, w: size, d: size, h };
};

/** A wall at a polar position, running around the centre (tangent to the ring). */
const wall = (r: number, deg: number, len: number, thick: number, h: number): Block => {
  const c = polar(r, deg, 0);
  const radial = Math.abs(Math.cos((deg * Math.PI) / 180)) > 0.7;
  return radial ? { x: c.x, y: c.y, w: thick, d: len, h } : { x: c.x, y: c.y, w: len, d: thick, h };
};

const pad = (r: number, deg: number): Circle => polar(r, deg, 0.55);

// ---------------------------------------------------------------------------
// Buildings: walls with doorways, roofs you can stand on, bridges, ramps
// ---------------------------------------------------------------------------

/** Wall height, and the roof slab that sits on top of the walls (metres). */
const WALL_H = 2.6;
const ROOF_TOP = 2.95;
/** Doorway: design-unit width and headroom in metres (players are 1.8 m). */
const DOOR_W = 0.55;
const DOOR_H = 2.1;
/** Wall thickness (design units). */
const WALL_T = 0.09;

/**
 * A small building: four walls with doorways on the listed sides ('n' +y,
 * 's' -y, 'e' +x, 'w' -x) and a flat roof you can stand on.
 */
function hut(x: number, y: number, w: number, d: number, doors: string): Block[] {
  const out: Block[] = [];
  const side = (cx: number, cy: number, len: number, alongX: boolean, door: boolean): void => {
    const box = (ox: number, l: number, z = 0, h = WALL_H): Block =>
      alongX ? { x: cx + ox, y: cy, w: l, d: WALL_T, h, z } : { x: cx, y: cy + ox, w: WALL_T, d: l, h, z };
    if (!door) {
      out.push(box(0, len));
      return;
    }
    const seg = (len - DOOR_W) / 2;
    out.push(box(-(DOOR_W + seg) / 2, seg), box((DOOR_W + seg) / 2, seg));
    out.push(box(0, DOOR_W, DOOR_H)); // lintel over the doorway
  };
  side(x, y + d / 2, w, true, doors.includes('n'));
  side(x, y - d / 2, w, true, doors.includes('s'));
  side(x + w / 2, y, d - WALL_T, false, doors.includes('e'));
  side(x - w / 2, y, d - WALL_T, false, doors.includes('w'));
  out.push({ x, y, w: w + WALL_T, d: d + WALL_T, z: WALL_H, h: ROOF_TOP });
  return out;
}

/** A roof on four posts: open underneath, somewhere to stand on top. */
function pergola(x: number, y: number, w: number, d: number): Block[] {
  const post = 0.14;
  const out: Block[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) out.push({ x: x + sx * (w / 2 - post / 2), y: y + sy * (d / 2 - post / 2), w: post, d: post, h: WALL_H });
  }
  out.push({ x, y, w, d, z: WALL_H, h: ROOF_TOP });
  return out;
}

/** A raised walkway slab (a bridge or a carport roof). */
function slab(x: number, y: number, w: number, d: number, top = ROOF_TOP): Block {
  return { x, y, w, d, z: top - (ROOF_TOP - WALL_H), h: top };
}

/** A ramp rising to a roof or bridge. */
function ramp(x: number, y: number, w: number, d: number, dir: 0 | 1 | 2 | 3, h = ROOF_TOP): Ramp {
  return { x, y, w, d, h, dir };
}

export const MAPS: readonly MapDef[] = [
  {
    name: 'Helipad',
    blurb: 'A clean landing pad. Pure skill.',
    shape: 'circle',
    holes: [],
    bumpers: [],
    blocks: [...[0, 1, 2, 3].map((k) => crate(6.5, 45 + k * 90, 0.8, 1.1)), ...hut(6.3, 0, 1.4, 2.4, 'ns'), ...hut(-6.3, 0, 1.4, 2.4, 'ns')],
    ramps: [ramp(4.9, 0, 1.4, 0.55, 0), ramp(-4.9, 0, 1.4, 0.55, 2)],
    pads: [pad(2.3, 90), pad(2.3, 270)],
    theme: { top: '#b9c3d6', shade: '#8d98b3', side: '#5b5f86', sideShade: '#3f4166', surface: 'helipad', bumper: '#ff3d8b' },
  },
  {
    name: 'Skylight',
    blurb: "Don't fall through the skylight.",
    shape: 'circle',
    holes: [{ x: 0, y: 0, r: 2 }],
    bumpers: [],
    blocks: [wall(6.4, 0, 1.6, 0.45, 2.2), wall(6.4, 90, 1.6, 0.45, 2.2), wall(6.4, 180, 1.6, 0.45, 2.2), wall(6.4, 270, 1.6, 0.45, 2.2)],
    pads: [pad(6.6, 45), pad(6.6, 225)],
    theme: { top: '#d8cfc4', shade: '#b3a797', side: '#7a5f6e', sideShade: '#5a4152', surface: 'gravel', bumper: '#ff3d8b' },
  },
  {
    name: 'Arcade Roof',
    blurb: 'Neon pinball bumpers fling you. Hard.',
    shape: 'circle',
    holes: [],
    bumpers: [{ x: 0, y: 0, r: 1 }, polar(6.3, 0, 0.8), polar(6.3, 90, 0.8), polar(6.3, 180, 0.8), polar(6.3, 270, 0.8)],
    blocks: [crate(3.2, 0, 0.6, 1), crate(3.2, 180, 0.6, 1)],
    pads: [0, 1, 2, 3].map((k) => pad(3.6, 45 + k * 90)),
    theme: { top: '#3b2a6b', shade: '#2a1d52', side: '#2c2158', sideShade: '#1b1440', surface: 'neon', bumper: '#ff2e88' },
  },
  {
    name: 'The Block',
    blurb: 'A tar roof. Corners are a trap.',
    shape: 'square',
    holes: [],
    bumpers: [],
    blocks: [
      ...hut(0, 0, 2.6, 2.6, 'nsw'),
      { x: -3.2, y: -3.2, w: 1.2, d: 1.2, h: 1.6 },
      { x: 3.2, y: -3.2, w: 1.2, d: 1.2, h: 1.6 },
      { x: -3.2, y: 3.2, w: 1.2, d: 1.2, h: 1.6 },
      { x: 3.2, y: 3.2, w: 1.2, d: 1.2, h: 1.6 },
    ],
    ramps: [ramp(2.0, 0, 1.4, 0.55, 2)],
    pads: [pad(6.3, 90), pad(6.3, 270)],
    theme: { top: '#55566d', shade: '#3e3f55', side: '#6b4a5a', sideShade: '#4d3342', surface: 'tar', bumper: '#ff3d8b' },
  },
  {
    name: 'Vent Farm',
    blurb: 'Open vents everywhere. Watch your step.',
    shape: 'circle',
    holes: [polar(2.4, 90, 0.9), polar(2.4, 210, 0.9), polar(2.4, 330, 0.9), polar(6.8, 30, 0.8), polar(6.8, 150, 0.8), polar(6.8, 270, 0.8)],
    bumpers: [],
    blocks: [crate(6.8, 90, 0.75, 1.1), crate(6.8, 210, 0.75, 1.1), crate(6.8, 330, 0.75, 1.1), crate(0, 0, 0.9, 2.2)],
    pads: [],
    theme: { top: '#a9b8c6', shade: '#8293a8', side: '#4f6a82', sideShade: '#374d63', surface: 'plate', bumper: '#ff3d8b' },
  },
  {
    name: 'Chimneys',
    blurb: 'Terracotta tiles and chimneys to hide behind.',
    shape: 'square',
    holes: [],
    bumpers: [polar(2.6, 0, 0.75), polar(2.6, 90, 0.75), polar(2.6, 180, 0.75), polar(2.6, 270, 0.75)],
    blocks: [wall(6, 0, 2.6, 0.45, 1.4), wall(6, 180, 2.6, 0.45, 1.4)],
    pads: [0, 1, 2, 3].map((k) => pad(7, 45 + k * 90)),
    theme: { top: '#e08462', shade: '#b85e44', side: '#6d4a6a', sideShade: '#4f324d', surface: 'tiles', bumper: '#9c3b31' },
  },
  {
    name: 'Hex Plaza',
    blurb: 'Six sides, six ways to go out.',
    shape: 'hex',
    holes: [],
    bumpers: [],
    blocks: [...[0, 1, 2, 3, 4, 5].map((k) => crate(2.5, 30 + k * 60, 0.8, 1)), ...hut(0, 0, 1.8, 1.8, 'nsew')],
    pads: [],
    theme: { top: '#e3d8c4', shade: '#c2b39b', side: '#7d6a8a', sideShade: '#5d4c6b', surface: 'paving', bumper: '#ff3d8b' },
  },
  {
    name: 'Billboard',
    blurb: 'Fight on top of an ad. Sharp corners.',
    shape: 'diamond',
    holes: [],
    bumpers: [{ x: 0, y: 0, r: 0.9 }],
    blocks: [
      { x: 0, y: -2.6, w: 2.6, d: 0.4, h: 2.2 },
      { x: 0, y: 2.6, w: 2.6, d: 0.4, h: 2.2 },
    ],
    pads: [pad(6, 0), pad(6, 180)],
    theme: { top: '#ffd93d', shade: '#f0b21e', side: '#3a3f7a', sideShade: '#282b5c', surface: 'billboard', bumper: '#ff2e88' },
  },
  {
    name: 'Sky Garden',
    blurb: 'Mind the open drains around the lawn.',
    shape: 'circle',
    holes: [0, 1, 2, 3, 4, 5, 6, 7].map((k) => polar(6.6, 22.5 + k * 45, 0.8)),
    bumpers: [],
    blocks: [
      ...[0, 90, 180, 270].map((deg) => wall(2.4, deg, 1.8, 0.5, 1.2)),
      ...[45, 135, 225, 315].map((deg) => crate(6.2, deg, 0.7, 3.6)),
      ...pergola(0, 0, 4.2, 4.2),
    ],
    pads: [],
    theme: { top: '#74d27e', shade: '#4fa85c', side: '#5a6a8a', sideShade: '#3f4d6b', surface: 'garden', bumper: '#ff3d8b' },
  },
  {
    name: 'Split Level',
    blurb: 'A construction gap splits the roof in two.',
    shape: 'circle',
    holes: [-5.8, -3.5, -1.2, 1.2, 3.5, 5.8].map((y) => ({ x: 0, y, r: 1.05 })),
    bumpers: [],
    blocks: [
      slab(0, 0, 6, 0.7),
      { x: 1.9, y: 0, w: 0.15, d: 0.15, h: 2.6 },
      { x: -1.9, y: 0, w: 0.15, d: 0.15, h: 2.6 },
    ],
    ramps: [ramp(4.2, 0, 2.4, 0.7, 2), ramp(-4.2, 0, 2.4, 0.7, 0)],
    pads: [pad(2.3, 45), pad(2.3, 135), pad(2.3, 225), pad(2.3, 315)],
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
    blocks: [
      { x: -5.6, y: -2.4, w: 1, d: 2, h: 1.2 },
      { x: 5.6, y: -2.4, w: 1, d: 2, h: 1.2 },
      { x: -5.6, y: 2.4, w: 1, d: 2, h: 1.2 },
      { x: 5.6, y: 2.4, w: 1, d: 2, h: 1.2 },
      ...pergola(0, 7.1, 4.4, 1.6),
      ...pergola(0, -7.1, 4.4, 1.6),
    ],
    ramps: [ramp(3.1, 7.1, 1.8, 0.6, 2), ramp(3.1, -7.1, 1.8, 0.6, 2)],
    pads: [],
    theme: { top: '#5c5f74', shade: '#46485c', side: '#8a8fa3', sideShade: '#666a80', surface: 'parking', bumper: '#ff7a1a' },
  },
  {
    name: 'Solar Farm',
    blurb: 'Panels, open hatches and a pylon in the middle.',
    shape: 'hex',
    holes: [0, 1, 2, 3, 4, 5].map((k) => polar(6.2, 30 + k * 60, 0.85)),
    bumpers: [{ x: 0, y: 0, r: 0.85 }],
    blocks: [0, 1, 2, 3, 4, 5].map((k) => crate(2.6, k * 60, 0.9, 0.9)),
    pads: [0, 1, 2, 3, 4, 5].map((k) => pad(6.3, k * 60)),
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

/** How much the map features are scaled (from design units) at a given arena radius. */
export function mapScale(arenaRadius: number): number {
  return arenaRadius / MAP_DESIGN_RADIUS;
}

/** True if a point is off the roof: past the edge or over a hole. */
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

export interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Height of the top face above the roof. */
  top: number;
  /** Height of the underside (0 for things standing on the roof). */
  bottom: number;
}

/** Blocks at the current arena size, as boxes in world units. */
export function scaledBlocks(map: MapDef, arenaRadius: number): Box[] {
  const s = mapScale(arenaRadius);
  return map.blocks.map((b) => ({
    minX: (b.x - b.w / 2) * s,
    maxX: (b.x + b.w / 2) * s,
    minY: (b.y - b.d / 2) * s,
    maxY: (b.y + b.d / 2) * s,
    top: b.h,
    bottom: b.z ?? 0,
  }));
}

export interface RampBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  h: number;
  dir: 0 | 1 | 2 | 3;
}

/** Ramps at the current arena size, in world units. */
export function scaledRamps(map: MapDef, arenaRadius: number): RampBox[] {
  const s = mapScale(arenaRadius);
  return (map.ramps ?? []).map((r) => ({
    minX: (r.x - r.w / 2) * s,
    maxX: (r.x + r.w / 2) * s,
    minY: (r.y - r.d / 2) * s,
    maxY: (r.y + r.d / 2) * s,
    h: r.h,
    dir: r.dir,
  }));
}

/** Height of a ramp's surface at (x, y) (clamped to its footprint). */
export function rampHeight(r: RampBox, x: number, y: number): number {
  const tx = clamp01((x - r.minX) / (r.maxX - r.minX));
  const ty = clamp01((y - r.minY) / (r.maxY - r.minY));
  const t = r.dir === 0 ? tx : r.dir === 1 ? ty : r.dir === 2 ? 1 - tx : 1 - ty;
  return r.h * t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Jump pads at the current arena size. */
export function scaledPads(map: MapDef, arenaRadius: number): Circle[] {
  const s = mapScale(arenaRadius);
  return map.pads.map((p) => ({ x: p.x * s, y: p.y * s, r: p.r * s }));
}

/**
 * Height of whatever you would stand on at (x, y): the tallest block top no
 * higher than maxTop, else the roof (0), else -Infinity over a hole or past
 * the edge.
 */
export function floorAt(map: MapDef, arenaRadius: number, x: number, y: number, maxTop: number): number {
  let floor = isOffMap(map, arenaRadius, x, y) ? -Infinity : 0;
  for (const b of scaledBlocks(map, arenaRadius)) {
    if (b.top > maxTop || b.top <= floor) continue;
    // A little give at the edges, so you don't slip off a crate you're standing on.
    if (x >= b.minX - 0.15 && x <= b.maxX + 0.15 && y >= b.minY - 0.15 && y <= b.maxY + 0.15) floor = b.top;
  }
  for (const r of scaledRamps(map, arenaRadius)) {
    if (x < r.minX || x > r.maxX || y < r.minY || y > r.maxY) continue;
    const h = rampHeight(r, x, y);
    if (h <= maxTop && h > floor) floor = h;
  }
  return floor;
}

/** True if a point is inside a block or a ramp. */
export function inBlock(map: MapDef, arenaRadius: number, x: number, y: number, z: number, margin = 0): boolean {
  for (const b of scaledBlocks(map, arenaRadius)) {
    if (z < b.top + margin && z > b.bottom - margin && x > b.minX - margin && x < b.maxX + margin && y > b.minY - margin && y < b.maxY + margin) return true;
  }
  for (const r of scaledRamps(map, arenaRadius)) {
    if (x > r.minX - margin && x < r.maxX + margin && y > r.minY - margin && y < r.maxY + margin && z < rampHeight(r, x, y) + margin) return true;
  }
  return false;
}

/** True if a player can stand here safely: on the roof, clear of hole edges, bumpers, blocks and pads. */
function spawnIsSafe(map: MapDef, arenaRadius: number, x: number, y: number): boolean {
  if (inBlock(map, arenaRadius, x, y, 0, C.PLAYER_RADIUS + 0.5)) return false;
  if (scaledPads(map, arenaRadius).some((p) => Math.hypot(x - p.x, y - p.y) < p.r + C.PLAYER_RADIUS + 0.5)) return false;
  const m = C.PLAYER_RADIUS + 0.8;
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    if (isOffMap(map, arenaRadius, x + Math.cos(a) * m, y + Math.sin(a) * m)) return false;
  }
  if (isOffMap(map, arenaRadius, x, y)) return false;
  return !scaledBumpers(map, arenaRadius).some((b) => Math.hypot(x - b.x, y - b.y) < b.r + C.PLAYER_RADIUS + 0.8);
}

/**
 * Evenly spaced spawn point `index` of `count`, facing the centre (yaw). If
 * the ideal spot is over a hole or a bumper, it slides along the ring to the
 * nearest safe spot.
 */
export function spawnPoint(map: MapDef, index: number, count: number): { x: number; y: number; yaw: number } {
  const n = Math.max(1, count);
  const base = Math.PI + (index / n) * Math.PI * 2;
  const R = C.ARENA_START_RADIUS;
  for (const dr of [0, -2, 2, -4, 4, -6]) {
    for (const da of [0, 0.12, -0.12, 0.25, -0.25, 0.4, -0.4]) {
      const a = base + da;
      const r = C.SPAWN_DISTANCE + dr;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (spawnIsSafe(map, R, x, y)) return { x, y, yaw: Math.atan2(-y, -x) };
    }
  }
  const x = Math.cos(base) * C.SPAWN_DISTANCE;
  const y = Math.sin(base) * C.SPAWN_DISTANCE;
  return { x, y, yaw: base + Math.PI };
}
