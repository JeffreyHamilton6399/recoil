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
 * A ramp (or a flight of stairs): a wedge you can walk up, rising from z
 * (default 0, the roof) to h metres towards `dir` (0 = +x, 1 = +y, 2 = -x,
 * 3 = -y). Footprint in design units, like a Block. A ramp with a z starts
 * on an upper floor.
 */
export interface Ramp {
  x: number;
  y: number;
  w: number;
  d: number;
  h: number;
  dir: 0 | 1 | 2 | 3;
  z?: number;
}

/**
 * A separate rooftop, for maps that are a block of buildings with gaps
 * between them (design units, like a Block). Anywhere not on a rooftop is a
 * drop to the street. A bridge is a narrow walkway across a gap.
 */
export interface Roof {
  x: number;
  y: number;
  w: number;
  d: number;
  bridge?: boolean;
  /** A taller building: its rooftop is this many metres up (default 0). */
  h?: number;
}

/** An automatic turret, at (x, y) design units, standing on something z metres up. */
export interface TurretSpot {
  x: number;
  y: number;
  z?: number;
}

/** A jump pad; v is its launch speed (m/s) if it's stronger than usual. */
export interface Pad extends Circle {
  v?: number;
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
  pads: Pad[];
  /** A block of separate buildings: only these rooftops (and bridges) are solid. */
  roofs?: Roof[];
  /** Automatic turrets that shoot at anyone in range. */
  turrets?: TurretSpot[];
  theme: MapTheme;
}

/** A bridge across a gap between two rooftops. */
const bridge = (x: number, y: number, w: number, d: number): Roof => ({ x, y, w, d, bridge: true });

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

/** Second floor of a tower: its floor, its walls' top, and the roof deck on top. */
const FLOOR2 = ROOF_TOP;
const WALL2_TOP = FLOOR2 + 2.55;
const DECK_TOP = WALL2_TOP + 0.35;
/** Windows on the upper floor: width (design units), sill and head heights above the floor (m). */
const WIN_W = 0.55;
const WIN_SILL = 0.95;
const WIN_HEAD = 1.95;
/** Stairs: width and run (design units). */
const STAIR_W = 0.5;
const STAIR_RUN = 1.7;

/** A building's parts: its solid blocks and its ramps and stairs. */
export interface Parts {
  blocks: Block[];
  ramps: Ramp[];
}

/** Merges parts (towers, bridges, loose blocks and ramps) into one set. */
function parts(...list: (Parts | Block | Ramp)[]): Parts {
  const out: Parts = { blocks: [], ramps: [] };
  for (const p of list) {
    if ('blocks' in p) {
      out.blocks.push(...p.blocks);
      out.ramps.push(...p.ramps);
    } else if ('dir' in p) out.ramps.push(p);
    else out.blocks.push(p);
  }
  return out;
}

/**
 * One wall of a storey, from z0 to z1 metres, along x (alongX) or y, centred at
 * (cx, cy): solid, with a doorway, or with a window.
 */
function wallRun(out: Block[], cx: number, cy: number, len: number, alongX: boolean, kind: 'solid' | 'door' | 'window', z0: number, z1: number): void {
  const box = (off: number, l: number, lo: number, hi: number): void => {
    out.push(alongX ? { x: cx + off, y: cy, w: l, d: WALL_T, z: lo, h: hi } : { x: cx, y: cy + off, w: WALL_T, d: l, z: lo, h: hi });
  };
  if (kind === 'solid') {
    box(0, len, z0, z1);
    return;
  }
  const gap = kind === 'door' ? DOOR_W : WIN_W;
  const seg = (len - gap) / 2;
  box(-(gap + seg) / 2, seg, z0, z1);
  box((gap + seg) / 2, seg, z0, z1);
  if (kind === 'door') {
    box(0, gap, z0 + DOOR_H, z1);
  } else {
    box(0, gap, z0, z0 + WIN_SILL);
    box(0, gap, z0 + WIN_HEAD, z1);
  }
}

/** A floor slab over a rectangle, leaving a stairwell (hole) open. */
function slabWithHole(out: Block[], x0: number, x1: number, y0: number, y1: number, hole: [number, number, number, number], z: number, top: number): void {
  const [hx0, hx1, hy0, hy1] = hole;
  const rect = (a: number, b: number, c: number, d: number): void => {
    if (b - a > 0.01 && d - c > 0.01) out.push({ x: (a + b) / 2, y: (c + d) / 2, w: b - a, d: d - c, z, h: top });
  };
  rect(x0, hx0, y0, y1); // west of the hole
  rect(hx1, x1, y0, y1); // east of the hole
  rect(hx0, hx1, y0, hy0); // south of the hole
  rect(hx0, hx1, hy1, y1); // north of the hole
}

/**
 * A tall hollow building you can get into: doorways at street level on the
 * `doors` sides ('n' +y, 's' -y, 'e' +x, 'w' -x), windows on every floor
 * above, one tall open hall inside, and a skylight in the roof. A strong
 * jump pad under the skylight shoots you up through it onto the roof.
 */
function building(x: number, y: number, w: number, d: number, h: number, doors: string): { blocks: Block[]; ramps: Ramp[]; pad: Pad } {
  const blocks: Block[] = [];
  const x0 = x - w / 2;
  const x1 = x + w / 2;
  const y0 = y - d / 2;
  const y1 = y + d / 2;
  const storey = 3;
  const roofBase = h - 0.35;
  const side = (z0: number, z1: number, ground: boolean): void => {
    const kind = (dir: string): 'solid' | 'door' | 'window' => (ground ? (doors.includes(dir) ? 'door' : 'solid') : z1 - z0 >= 2 ? 'window' : 'solid');
    wallRun(blocks, x, y1, w, true, kind('n'), z0, z1);
    wallRun(blocks, x, y0, w, true, kind('s'), z0, z1);
    wallRun(blocks, x1, y, d - WALL_T, false, kind('e'), z0, z1);
    wallRun(blocks, x0, y, d - WALL_T, false, kind('w'), z0, z1);
  };
  side(0, Math.min(storey, roofBase), true);
  for (let z = storey; z < roofBase - 0.01; z += storey) side(z, Math.min(z + storey, roofBase), false);
  const hole = Math.min(w, d) * 0.32;
  slabWithHole(blocks, x0 - WALL_T / 2, x1 + WALL_T / 2, y0 - WALL_T / 2, y1 + WALL_T / 2, [x - hole / 2, x + hole / 2, y - hole / 2, y + hole / 2], roofBase, h);
  return { blocks, ramps: [], pad: { x, y, r: hole * 0.32, v: Math.sqrt(2 * C.GRAVITY * (h + 3)) } };
}

/**
 * A two-storey tower you can walk into and climb.
 *  - Ground floor: doorways on the `doors` sides ('n' +y, 'e' +x, 'w' -x; the
 *    south wall holds the stairs), and a flight of stairs along the south wall
 *    up through a stairwell to the second floor.
 *  - Second floor: windows all round, doorways on the `links` sides (for
 *    bridges), and a second flight along the north wall up to the roof deck.
 *  - Roof deck: flat, open, a long way to fall.
 */
function tower(x: number, y: number, w: number, d: number, doors: string, links = ''): Parts {
  const blocks: Block[] = [];
  const ramps: Ramp[] = [];
  const x0 = x - w / 2;
  const x1 = x + w / 2;
  const y0 = y - d / 2;
  const y1 = y + d / 2;
  const inset = WALL_T / 2 + 0.05;

  // Ground floor walls.
  wallRun(blocks, x, y1, w, true, doors.includes('n') ? 'door' : 'solid', 0, FLOOR2 - 0.35);
  wallRun(blocks, x, y0, w, true, 'solid', 0, FLOOR2 - 0.35);
  wallRun(blocks, x1, y, d - WALL_T, false, doors.includes('e') ? 'door' : 'solid', 0, FLOOR2 - 0.35);
  wallRun(blocks, x0, y, d - WALL_T, false, doors.includes('w') ? 'door' : 'solid', 0, FLOOR2 - 0.35);

  // Stairs up along the south wall, rising towards +x, under a stairwell.
  const s1x0 = x0 + inset;
  const s1y0 = y0 + inset;
  ramps.push({ x: s1x0 + STAIR_RUN / 2, y: s1y0 + STAIR_W / 2, w: STAIR_RUN, d: STAIR_W, h: FLOOR2, dir: 0 });
  slabWithHole(blocks, x0 - WALL_T / 2, x1 + WALL_T / 2, y0 - WALL_T / 2, y1 + WALL_T / 2, [s1x0 - 0.02, s1x0 + STAIR_RUN, s1y0 - 0.1, s1y0 + STAIR_W + 0.05], FLOOR2 - 0.35, FLOOR2);

  // Upper floor walls: windows, or doorways out to bridges.
  const up = (side: string): 'door' | 'window' => (links.includes(side) ? 'door' : 'window');
  wallRun(blocks, x, y1, w, true, up('n'), FLOOR2, WALL2_TOP);
  wallRun(blocks, x, y0, w, true, up('s'), FLOOR2, WALL2_TOP);
  wallRun(blocks, x1, y, d - WALL_T, false, up('e'), FLOOR2, WALL2_TOP);
  wallRun(blocks, x0, y, d - WALL_T, false, up('w'), FLOOR2, WALL2_TOP);

  // Stairs from the second floor along the north wall, rising towards -x, up to the roof deck.
  const s2x1 = x1 - inset;
  const s2y1 = y1 - inset;
  ramps.push({ x: s2x1 - STAIR_RUN / 2, y: s2y1 - STAIR_W / 2, w: STAIR_RUN, d: STAIR_W, h: DECK_TOP, dir: 2, z: FLOOR2 });
  slabWithHole(blocks, x0 - WALL_T / 2, x1 + WALL_T / 2, y0 - WALL_T / 2, y1 + WALL_T / 2, [s2x1 - STAIR_RUN, s2x1 + 0.02, s2y1 - STAIR_W - 0.05, s2y1 + 0.1], WALL2_TOP, DECK_TOP);
  return { blocks, ramps };
}

/** A sky bridge between two towers' upper floors, from x0 to x1 at y (or y0 to y1 at x). */
function skyBridge(from: number, to: number, at: number, alongX: boolean, width = 0.7): Block {
  const mid = (from + to) / 2;
  const len = Math.abs(to - from);
  return alongX
    ? { x: mid, y: at, w: len, d: width, z: FLOOR2 - 0.35, h: FLOOR2 }
    : { x: at, y: mid, w: width, d: len, z: FLOOR2 - 0.35, h: FLOOR2 };
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
  {
    name: 'Downtown',
    blurb: 'Two towers and a sky bridge. Fight up the stairs or across the gap.',
    shape: 'square',
    holes: [],
    bumpers: [],
    ...parts(
      tower(-4.6, 0, 2.4, 2.4, 'new', 'e'),
      tower(4.6, 0, 2.4, 2.4, 'new', 'w'),
      skyBridge(-3.35, 3.35, 0, true),
      // Ramps up to the bridge from both sides of the street.
      { x: 0, y: -1.45, w: 0.7, d: 2.2, h: FLOOR2, dir: 1 },
      { x: 0, y: 1.45, w: 0.7, d: 2.2, h: FLOOR2, dir: 3 },
      crate(6.4, 45, 0.7, 1.1),
      crate(6.4, 225, 0.7, 1.1),
      crate(3.2, 90, 0.8, 1.1),
      crate(3.2, 270, 0.8, 1.1),
    ),
    turrets: [{ x: -5.4, y: -0.8, z: DECK_TOP }, { x: 5.4, y: -0.8, z: DECK_TOP }],
    pads: [pad(6.2, 135), pad(6.2, 315)],
    theme: { top: '#5d5a73', shade: '#46435a', side: '#6b5a7a', sideShade: '#4d3f5c', surface: 'tar', bumper: '#ff3d8b' },
  },
  {
    name: 'High Rise',
    blurb: 'Climb the tower in the middle. Its bridges reach out over the edge.',
    shape: 'circle',
    holes: [polar(6.9, 45, 0.8), polar(6.9, 135, 0.8), polar(6.9, 225, 0.8), polar(6.9, 315, 0.8)],
    bumpers: [],
    ...parts(
      tower(0, 0, 2.6, 2.6, 'new', 'ew'),
      // Bridges out to two lookout platforms on posts, with ramps down to the roof.
      skyBridge(1.4, 5.0, 0, true),
      skyBridge(-5.0, -1.4, 0, true),
      ...pergola(5.8, 0, 1.6, 1.6),
      ...pergola(-5.8, 0, 1.6, 1.6),
      ramp(5.8, 1.9, 0.6, 2.2, 3),
      ramp(-5.8, -1.9, 0.6, 2.2, 1),
      crate(4.2, 90, 0.8, 1.1),
      crate(4.2, 270, 0.8, 1.1),
    ),
    turrets: [{ x: -0.7, y: -0.7, z: DECK_TOP }],
    pads: [pad(3.6, 45), pad(3.6, 225)],
    theme: { top: '#c9c3b6', shade: '#a59e8f', side: '#5a6a8a', sideShade: '#3f4d6b', surface: 'paving', bumper: '#ff3d8b' },
  },
  {
    name: 'City Blocks',
    blurb: 'Nine rooftops and the gaps between them. Jump across, or take a bridge.',
    shape: 'square',
    holes: [],
    bumpers: [],
    roofs: [
      { x: -5.2, y: -5.2, w: 4.3, d: 4.3 },
      { x: 0, y: -5.2, w: 4.3, d: 4.3 },
      { x: 5.2, y: -5.2, w: 4.3, d: 4.3 },
      { x: -5.2, y: 0, w: 4.3, d: 4.3 },
      { x: 0, y: 0, w: 4.3, d: 4.3 },
      { x: 5.2, y: 0, w: 4.3, d: 4.3 },
      { x: -5.2, y: 5.2, w: 4.3, d: 4.3 },
      { x: 0, y: 5.2, w: 4.3, d: 4.3 },
      { x: 5.2, y: 5.2, w: 4.3, d: 4.3 },
      // Bridges from the middle out, and a few round the outside. The other gaps are a running jump.
      bridge(2.6, 1.2, 1.2, 0.5),
      bridge(-2.6, -1.2, 1.2, 0.5),
      bridge(-1.2, 2.6, 0.5, 1.2),
      bridge(1.2, -2.6, 0.5, 1.2),
      bridge(2.6, 5.2, 1.2, 0.5),
      bridge(-2.6, -5.2, 1.2, 0.5),
      bridge(5.2, -2.6, 0.5, 1.2),
      bridge(-5.2, 2.6, 0.5, 1.2),
    ],
    ...parts(
      tower(0, 0, 2.4, 2.4, 'new'),
      // Rooftop sheds and water towers on the corners, crates to hide behind.
      ...hut(-5.6, 5.6, 1.6, 1.4, 'e'),
      ...hut(5.6, -5.6, 1.6, 1.4, 'w'),
      ...pergola(5.4, 5.4, 1.6, 1.6),
      ...pergola(-5.4, -5.4, 1.6, 1.6),
      ramp(5.4, 3.7, 0.6, 1.8, 1),
      ramp(-5.4, -3.7, 0.6, 1.8, 3),
      crate(5.2, 0, 0.8, 1.1),
      crate(5.2, 180, 0.8, 1.1),
      crate(5.6, 90, 0.7, 1.1),
      crate(5.6, 270, 0.7, 1.1),
    ),
    turrets: [{ x: -0.6, y: -0.6, z: DECK_TOP }],
    pads: [pad(7.3, 45), pad(7.3, 225)],
    theme: { top: '#8d8a9e', shade: '#6f6c80', side: '#4f5d80', sideShade: '#384463', surface: 'tar', bumper: '#ff3d8b' },
  },
  {
    name: 'Skyline',
    blurb: 'Wide gaps between tall buildings. Blast across with recoil, or climb to the high bridges.',
    shape: 'square',
    holes: [],
    bumpers: [],
    roofs: [
      { x: 0, y: 0, w: 4.0, d: 4.6 },
      { x: -5.4, y: 0, w: 3.6, d: 6.2 },
      { x: 5.4, y: 0, w: 3.6, d: 6.2 },
      { x: 0, y: 5.6, w: 5.6, d: 2.4 },
      { x: 0, y: -5.6, w: 5.6, d: 2.4 },
      { x: -5.8, y: 5.8, w: 2.2, d: 2.2 },
      { x: 5.8, y: 5.8, w: 2.2, d: 2.2 },
      { x: -5.8, y: -5.8, w: 2.2, d: 2.2 },
      { x: 5.8, y: -5.8, w: 2.2, d: 2.2 },
      // One narrow walkway to each side building; everything else is a leap.
      bridge(-2.8, 1.8, 1.8, 0.5),
      bridge(2.8, -1.8, 1.8, 0.5),
    ],
    ...parts(
      // High bridges: ramps up from the middle roof, across the gap, down onto the far roof.
      ramp(0, 1.25, 0.7, 1.9, 1),
      slab(0, 3.3, 0.7, 2.2),
      ramp(0, 5.35, 0.7, 1.9, 3),
      ramp(0, -1.25, 0.7, 1.9, 3),
      slab(0, -3.3, 0.7, 2.2),
      ramp(0, -5.35, 0.7, 1.9, 1),
      // Lookouts on the side buildings.
      ...pergola(-5.6, -2.0, 1.6, 1.6),
      ...pergola(5.6, 2.0, 1.6, 1.6),
      ramp(-5.6, -0.3, 0.6, 1.8, 3),
      ramp(5.6, 0.3, 0.6, 1.8, 1),
      crate(1.9, 0, 0.8, 1.1),
      crate(1.9, 180, 0.8, 1.1),
    ),
    // Pads by the gaps: run onto one to leap to the next building.
    pads: [
      { x: -1.5, y: -1.6, r: 0.5 },
      { x: 1.5, y: 1.6, r: 0.5 },
      { x: -5.8, y: 5.8, r: 0.5 },
      { x: 5.8, y: -5.8, r: 0.5 },
      { x: 5.8, y: 5.8, r: 0.5 },
      { x: -5.8, y: -5.8, r: 0.5 },
    ],
    theme: { top: '#b4b9c9', shade: '#9096a8', side: '#3d4f7a', sideShade: '#2b3a5c', surface: 'plate', bumper: '#ff3d8b' },
  },
  {
    name: 'Twin Bases',
    blurb: 'Two big bases, three islands between them. Made for capture the flag.',
    shape: 'square',
    holes: [],
    bumpers: [],
    roofs: [
      { x: -5.3, y: 0, w: 4.2, d: 7.0 },
      { x: 5.3, y: 0, w: 4.2, d: 7.0 },
      { x: 0, y: 0, w: 2.6, d: 2.6 },
      { x: 0, y: 4.6, w: 2.6, d: 2.4 },
      { x: 0, y: -4.6, w: 2.6, d: 2.4 },
      // The direct route: a narrow bridge each side, and bridges between the islands.
      bridge(-2.3, 0, 2.2, 0.5),
      bridge(2.3, 0, 2.2, 0.5),
      bridge(0, 2.4, 0.5, 1.4),
      bridge(0, -2.4, 0.5, 1.4),
    ],
    ...parts(
      tower(-6.0, 2.0, 2.2, 2.2, 'nwe'),
      tower(6.0, -2.0, 2.2, 2.2, 'nwe'),
      ...hut(-6.0, -2.3, 1.6, 1.4, 'n'),
      ...hut(6.0, 2.3, 1.6, 1.4, 'n'),
      crate(1.0, 90, 0.7, 1.1),
      crate(1.0, 270, 0.7, 1.1),
      crate(4.6, 90, 0.7, 1.1),
      crate(4.6, 270, 0.7, 1.1),
    ),
    // Pads at the front of each base: run onto one to fly to the islands.
    pads: [
      { x: -3.8, y: 2.6, r: 0.5 },
      { x: -3.8, y: -2.6, r: 0.5 },
      { x: 3.8, y: 2.6, r: 0.5 },
      { x: 3.8, y: -2.6, r: 0.5 },
    ],
    theme: { top: '#7f8a78', shade: '#646e5e', side: '#6a5a4a', sideShade: '#4c4034', surface: 'gravel', bumper: '#ff3d8b' },
  },
  {
    name: 'Crane Yard',
    blurb: 'A building site. Hook the crane, climb the scaffold, fly the gap.',
    shape: 'square',
    holes: [],
    bumpers: [],
    roofs: [
      { x: -3.3, y: 0, w: 7.8, d: 13.4 },
      { x: 5.2, y: 0, w: 4.4, d: 13.4 },
      bridge(1.8, -5.0, 2.6, 0.5),
    ],
    ...parts(
      // Scaffold: two open floors on posts, a ramp to the first.
      { x: -5.8, y: -5.05, w: 0.14, d: 0.14, h: 6.15 },
      { x: -3.4, y: -5.05, w: 0.14, d: 0.14, h: 6.15 },
      { x: -5.8, y: -2.55, w: 0.14, d: 0.14, h: 6.15 },
      { x: -3.4, y: -2.55, w: 0.14, d: 0.14, h: 6.15 },
      { x: -4.6, y: -3.8, w: 2.6, d: 2.6, z: 2.6, h: 2.95 },
      { x: -4.6, y: -3.8, w: 2.6, d: 2.6, z: 6.15, h: 6.5 },
      ramp(-4.6, -1.6, 0.6, 1.8, 3),
      // The tower crane: a mast, and a jib high over the gap to hook and walk along.
      { x: -1.2, y: 3.5, w: 0.5, d: 0.5, h: 10.6 },
      { x: 2.3, y: 3.5, w: 7.5, d: 0.4, z: 10.6, h: 11 },
      { x: -2.9, y: 3.5, w: 2.6, d: 0.4, z: 10.6, h: 11 },
      { x: -3.6, y: 3.5, w: 0.9, d: 0.8, z: 8.6, h: 10.6 },
      // A container hanging from the jib.
      { x: 4.4, y: 3.5, w: 1.3, d: 0.6, z: 5.2, h: 6.5 },
      // Stacked containers to climb.
      { x: -5.6, y: 5.3, w: 1.8, d: 0.8, h: 1.3 },
      { x: -5.6, y: 4.4, w: 1.8, d: 0.8, h: 2.6 },
      { x: -3.6, y: 5.6, w: 0.8, d: 1.8, h: 1.3 },
      tower(5.2, -3.8, 2.4, 2.4, 'nw'),
      { x: 5.6, y: 4.6, w: 1.6, d: 0.8, h: 1.3 },
      { x: 4.4, y: 1.8, w: 0.8, d: 0.8, h: 1.1 },
      { x: -1.6, y: -1.2, w: 0.8, d: 0.8, h: 1.1 },
    ),
    // Pads by the edge of the site: run on to fly the gap.
    turrets: [{ x: -4.6, y: -3.8, z: 6.5 }, { x: 5.2, y: -4.5, z: DECK_TOP }],
    pads: [
      { x: -0.3, y: 0.2, r: 0.5 },
      { x: 3.8, y: -1.0, r: 0.5 },
      { x: -6.6, y: -1.4, r: 0.5 },
    ],
    theme: { top: '#b8a07a', shade: '#957f5c', side: '#7a6a58', sideShade: '#5a4c3e', surface: 'plywood', bumper: '#ffb13d' },
  },
  {
    name: 'Sky Islands',
    blurb: 'Six floating rooftops round a tower. Hop the stepping stones, or hook the pylons.',
    shape: 'circle',
    holes: [],
    bumpers: [],
    roofs: [
      { x: 0, y: 0, w: 3.6, d: 3.6 },
      { x: 5.3, y: 0, w: 2.4, d: 2.4 },
      { x: 2.65, y: 4.59, w: 2.4, d: 2.4 },
      { x: -2.65, y: 4.59, w: 2.4, d: 2.4 },
      { x: -5.3, y: 0, w: 2.4, d: 2.4 },
      { x: -2.65, y: -4.59, w: 2.4, d: 2.4 },
      { x: 2.65, y: -4.59, w: 2.4, d: 2.4 },
      bridge(2.85, 0, 2.6, 0.5),
      bridge(-2.85, 0, 2.6, 0.5),
    ],
    ...parts(
      tower(0, 0, 2.4, 2.4, 'new'),
      { x: 3, y: 5.196, w: 0.45, d: 0.45, h: 7.5 },
      { x: -3, y: 5.196, w: 0.45, d: 0.45, h: 7.5 },
      { x: -3, y: -5.196, w: 0.45, d: 0.45, h: 7.5 },
      { x: 3, y: -5.196, w: 0.45, d: 0.45, h: 7.5 },
      { x: 4.59, y: 2.65, w: 1.1, d: 1.1, z: -0.8, h: 0.25 },
      { x: 0, y: 5.3, w: 1.1, d: 1.1, z: -0.8, h: 0.25 },
      { x: -4.59, y: 2.65, w: 1.1, d: 1.1, z: -0.8, h: 0.25 },
      { x: -4.59, y: -2.65, w: 1.1, d: 1.1, z: -0.8, h: 0.25 },
      { x: 0, y: -5.3, w: 1.1, d: 1.1, z: -0.8, h: 0.25 },
      { x: 4.59, y: -2.65, w: 1.1, d: 1.1, z: -0.8, h: 0.25 },
    ),
    turrets: [{ x: 3.0, y: 5.196, z: 7.5 }, { x: -3.0, y: -5.196, z: 7.5 }],
    pads: [
      { x: 1.45, y: 1.45, r: 0.4 },
      { x: -1.45, y: 1.45, r: 0.4 },
      { x: 1.45, y: -1.45, r: 0.4 },
      { x: -1.45, y: -1.45, r: 0.4 },
    ],
    theme: { top: '#3a3563', shade: '#2c2850', side: '#4a3f7a', sideShade: '#342c5a', surface: 'neon', bumper: '#ff3d8b' },
  },
  {
    name: 'Canyon Run',
    blurb: 'Two long blocks and a canyon. Cross high, cross low, or launch over.',
    shape: 'square',
    holes: [],
    bumpers: [],
    roofs: [
      { x: -4.6, y: 0, w: 6, d: 15.4 },
      { x: 4.6, y: 0, w: 6, d: 15.4 },
      bridge(0, 5.6, 3.6, 0.6),
    ],
    ...parts(
      // The high crossing: up a long ramp, over a girder, down the other side.
      ramp(-3.6, -4.2, 3.8, 0.7, 0, 4.5),
      slab(0, -4.2, 3.4, 0.7, 4.5),
      ramp(3.6, -4.2, 3.8, 0.7, 2, 4.5),
      tower(-5.4, 4.2, 2.4, 2.4, 'new'),
      tower(5.4, 4.2, 2.4, 2.4, 'new'),
      // Pylons on the canyon rim to hook.
      { x: -1.95, y: 2.2, w: 0.4, d: 0.4, h: 8 },
      { x: 1.95, y: -1.6, w: 0.4, d: 0.4, h: 8 },
      { x: -4.2, y: -1.8, w: 0.8, d: 0.8, h: 1.1 },
      { x: 4.2, y: 1.8, w: 0.8, d: 0.8, h: 1.1 },
      { x: -6.4, y: -6.4, w: 1.2, d: 1.2, h: 2.2 },
      { x: 6.4, y: -6.4, w: 1.2, d: 1.2, h: 2.2 },
      { x: -3.0, y: -6.8, w: 1.6, d: 0.7, h: 1.3 },
      { x: 3.0, y: -6.8, w: 1.6, d: 0.7, h: 1.3 },
    ),
    // Pads at the rim: sprint onto one to clear the canyon.
    turrets: [{ x: -1.95, y: 2.2, z: 8 }, { x: 1.95, y: -1.6, z: 8 }],
    pads: [
      { x: -2.35, y: 0, r: 0.45 },
      { x: 2.35, y: 0, r: 0.45 },
    ],
    theme: { top: '#6e7b8c', shade: '#56616f', side: '#8a5a4a', sideShade: '#663f33', surface: 'parking', bumper: '#ff3d8b' },
  },
  {
    name: 'Terraces',
    blurb: 'Three tiers of rooftop stepping up to a summit. Turrets hold the top.',
    shape: 'square',
    holes: [],
    bumpers: [],
    roofs: [
      { x: 0, y: 0, w: 3.6, d: 3.6, h: 4.8 },
      { x: 3.9, y: 0, w: 3.6, d: 3.6, h: 2.4 },
      { x: -3.9, y: 0, w: 3.6, d: 3.6, h: 2.4 },
      { x: 0, y: 3.9, w: 3.6, d: 3.6, h: 2.4 },
      { x: 0, y: -3.9, w: 3.6, d: 3.6, h: 2.4 },
      { x: 4.6, y: 4.6, w: 4.0, d: 4.0 },
      { x: -4.6, y: 4.6, w: 4.0, d: 4.0 },
      { x: 4.6, y: -4.6, w: 4.0, d: 4.0 },
      { x: -4.6, y: -4.6, w: 4.0, d: 4.0 },
    ],
    ...parts(
      // Ramps from the low corners up to the middle tier, across the gaps.
      { x: 4.6, y: 2.2, w: 0.7, d: 1.4, h: 2.4, dir: 3 },
      { x: -4.6, y: -2.2, w: 0.7, d: 1.4, h: 2.4, dir: 1 },
      { x: -2.2, y: 4.6, w: 1.4, d: 0.7, h: 2.4, dir: 0 },
      { x: 2.2, y: -4.6, w: 1.4, d: 0.7, h: 2.4, dir: 2 },
      // And from the middle tier up to the summit.
      { x: 2.4, y: 1.0, w: 1.8, d: 0.6, h: 4.8, dir: 2, z: 2.4 },
      { x: -2.4, y: -1.0, w: 1.8, d: 0.6, h: 4.8, dir: 0, z: 2.4 },
      // Cover on the summit and the tiers.
      { x: 0, y: 0, w: 0.9, d: 0.9, z: 4.8, h: 5.9 },
      { x: 4.2, y: -0.8, w: 0.8, d: 0.8, z: 2.4, h: 3.5 },
      { x: -4.2, y: 0.8, w: 0.8, d: 0.8, z: 2.4, h: 3.5 },
      { x: 0.8, y: 4.2, w: 0.8, d: 0.8, z: 2.4, h: 3.5 },
      { x: -0.8, y: -4.2, w: 0.8, d: 0.8, z: 2.4, h: 3.5 },
      crate(7.0, 45, 0.8, 1.1),
      crate(7.0, 225, 0.8, 1.1),
    ),
    turrets: [{ x: 1.3, y: 1.3, z: 4.8 }, { x: -1.3, y: -1.3, z: 4.8 }],
    pads: [
      { x: -3.6, y: 3.6, r: 0.45 },
      { x: 3.6, y: -3.6, r: 0.45 },
    ],
    theme: { top: '#9c8f7a', shade: '#7d725f', side: '#7a5f6e', sideShade: '#5a4452', surface: 'tiles', bumper: '#ff3d8b' },
  },
  {
    name: 'Stack City',
    blurb: 'Nine buildings, all different heights. Climb, hook and drop your way to the top.',
    shape: 'square',
    holes: [],
    bumpers: [],
    roofs: [
      { x: -5.2, y: -5.2, w: 4.3, d: 4.3 },
      { x: 0, y: -5.2, w: 4.3, d: 4.3, h: 1.2 },
      { x: 5.2, y: -5.2, w: 4.3, d: 4.3 },
      { x: -5.2, y: 0, w: 4.3, d: 4.3, h: 2.4 },
      { x: 0, y: 0, w: 4.3, d: 4.3, h: 6 },
      { x: 5.2, y: 0, w: 4.3, d: 4.3, h: 2.4 },
      { x: -5.2, y: 5.2, w: 4.3, d: 4.3 },
      { x: 0, y: 5.2, w: 4.3, d: 4.3, h: 1.2 },
      { x: 5.2, y: 5.2, w: 4.3, d: 4.3 },
    ],
    ...parts(
      // Up from the corners to the side blocks...
      { x: -5.2, y: -2.6, w: 0.6, d: 1.6, h: 2.4, dir: 1 },
      { x: 5.2, y: 2.6, w: 0.6, d: 1.6, h: 2.4, dir: 3 },
      // ...and from the side blocks up to the tall one in the middle.
      { x: 2.6, y: -1.2, w: 1.4, d: 0.6, h: 6, dir: 2, z: 2.4 },
      { x: -2.6, y: 1.2, w: 1.4, d: 0.6, h: 6, dir: 0, z: 2.4 },
      // A water tower and a shed up top, AC units lower down.
      ...pergola(0.9, 0.9, 1.4, 1.4).map((b) => ({ ...b, z: (b.z ?? 0) + 6, h: b.h + 6 })),
      { x: -1.2, y: -1.0, w: 1.0, d: 0.8, z: 6, h: 7.2 },
      { x: -5.2, y: 0.9, w: 0.9, d: 0.9, z: 2.4, h: 3.5 },
      { x: 5.2, y: -0.9, w: 0.9, d: 0.9, z: 2.4, h: 3.5 },
      { x: 0, y: -5.2, w: 1.4, d: 0.8, z: 1.2, h: 2.3 },
      { x: 0, y: 5.2, w: 1.4, d: 0.8, z: 1.2, h: 2.3 },
      crate(7.4, 45, 0.8, 1.1),
      crate(7.4, 225, 0.8, 1.1),
    ),
    turrets: [{ x: 1.5, y: -1.5, z: 6 }, { x: -1.5, y: 1.5, z: 6 }],
    pads: [
      { x: 3.6, y: -3.6, r: 0.45 },
      { x: -3.6, y: 3.6, r: 0.45 },
      { x: -6.4, y: -6.4, r: 0.45 },
      { x: 6.4, y: 6.4, r: 0.45 },
    ],
    theme: { top: '#8a8fa6', shade: '#6d7188', side: '#556b8f', sideShade: '#3d4f6d', surface: 'solar', bumper: '#ff3d8b' },
  },
  (() => {
    // Four hollow towers on the corners; two solid skyscrapers north and south.
    const towers = [
      building(-5.2, -5.2, 2.8, 2.8, 12, 'ne'),
      building(5.2, 5.2, 2.8, 2.8, 12, 'sw'),
      building(5.2, -5.2, 2.4, 2.4, 9, 'nw'),
      building(-5.2, 5.2, 2.4, 2.4, 9, 'se'),
    ];
    return {
      name: 'Skyscrapers',
      blurb: 'Walk into the towers and ride the pads up through the roof. Bridges link the tops, 12 m up.',
      shape: 'square' as const,
      holes: [],
      bumpers: [],
      roofs: [{ x: -5.2, y: -5.2, w: 4.3, d: 4.3 }, { x: 0, y: -5.2, w: 4.3, d: 4.3, h: 12 }, { x: 5.2, y: -5.2, w: 4.3, d: 4.3 }, { x: -5.2, y: 0, w: 4.3, d: 4.3 }, { x: 0, y: 0, w: 4.3, d: 4.3 }, { x: 5.2, y: 0, w: 4.3, d: 4.3 }, { x: -5.2, y: 5.2, w: 4.3, d: 4.3 }, { x: 0, y: 5.2, w: 4.3, d: 4.3, h: 12 }, { x: 5.2, y: 5.2, w: 4.3, d: 4.3 }],
      ...parts(
        ...towers,
        // High bridges from the tall corner towers to the skyscrapers...
        { x: -2.975, y: -5.2, w: 1.75, d: 0.6, z: 11.65, h: 12 },
        { x: 2.975, y: 5.2, w: 1.75, d: 0.6, z: 11.65, h: 12 },
        // ...and ramps up to them from the shorter towers.
        { x: 3.075, y: -4.6, w: 1.85, d: 0.6, h: 12, dir: 2, z: 9 },
        { x: -3.075, y: 4.6, w: 1.85, d: 0.6, h: 12, dir: 0, z: 9 },
        // Cover on the skyscraper tops and down on the street.
        { x: 0.9, y: 5.9, w: 0.8, d: 0.8, z: 12, h: 13.1 },
        { x: -0.9, y: -5.9, w: 0.8, d: 0.8, z: 12, h: 13.1 },
        { x: 0, y: 0, w: 1.0, d: 1.0, h: 1.2 },
        { x: 5.8, y: 1.3, w: 0.8, d: 0.8, h: 1.1 },
        { x: -5.8, y: -1.3, w: 0.8, d: 0.8, h: 1.1 },
      ),
      turrets: [{ x: 0, y: 5.2, z: 12 }, { x: 0, y: -5.2, z: 12 }],
      pads: [...towers.map((t) => t.pad), { x: 1.5, y: 1.5, r: 0.45 }, { x: -1.5, y: -1.5, r: 0.45 }],
      theme: { top: '#7d8296', shade: '#62667a', side: '#3f5a8a', sideShade: '#2c4066', surface: 'tar' as const, bumper: '#ff3d8b' },
    };
  })(),
  (() => {
    // Warehouses you can run through, catwalks between their roofs, and a tall hall in the middle.
    const halls = [
      building(-4.4, 3.6, 3.6, 2.6, 6, 'se'),
      building(4.4, -3.6, 3.6, 2.6, 6, 'nw'),
      building(4.4, 3.6, 2.6, 3.0, 6, 'sw'),
      building(-4.4, -3.6, 2.6, 3.0, 6, 'ne'),
      building(0, 0, 2.4, 2.4, 15, 'nsew'),
    ];
    return {
      name: 'Warehouses',
      blurb: 'Big sheds to fight through, catwalks over the top, and a 15 m hall in the middle.',
      shape: 'square' as const,
      holes: [],
      bumpers: [],
      ...parts(
        ...halls,
        { x: 0, y: 3.6, w: 5.2, d: 0.5, z: 5.65, h: 6 },
        { x: -0.25, y: -3.6, w: 5.7, d: 0.5, z: 5.65, h: 6 },
        { x: -6.8, y: 0.6, w: 1.8, d: 0.8, h: 1.3 },
        { x: 6.8, y: -0.6, w: 1.8, d: 0.8, h: 1.3 },
        { x: -2.2, y: -6.6, w: 0.8, d: 1.8, h: 2.6 },
        { x: 2.2, y: 6.6, w: 0.8, d: 1.8, h: 2.6 },
        crate(3.0, 90, 0.8, 1.1),
        crate(3.0, 270, 0.8, 1.1),
      ),
      turrets: [{ x: 0.8, y: 0.8, z: 15 }, { x: -0.8, y: -0.8, z: 15 }],
      pads: [...halls.map((h) => h.pad), { x: -6.6, y: -6.6, r: 0.45 }, { x: 6.6, y: 6.6, r: 0.45 }],
      theme: { top: '#8e8778', shade: '#716b5e', side: '#7a4f3e', sideShade: '#5a382c', surface: 'gravel' as const, bumper: '#ff3d8b' },
    };
  })(),
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
  if (map.roofs && !map.roofs.some((r) => Math.abs(x - r.x * s) <= (r.w * s) / 2 && Math.abs(y - r.y * s) <= (r.d * s) / 2)) return true;
  for (const hole of map.holes) {
    if (Math.hypot(x - hole.x * s, y - hole.y * s) < hole.r * s) return true;
  }
  return false;
}

/**
 * Keeps the last scaled copy of a map feature per map. Physics asks for them
 * many times a tick, and the arena size changes at most once a tick, so this
 * saves rebuilding the same arrays over and over. Treat the result as read-only.
 */
function memo<T>(build: (map: MapDef, s: number) => T): (map: MapDef, arenaRadius: number) => T {
  const cache = new WeakMap<MapDef, { R: number; value: T }>();
  return (map, arenaRadius) => {
    const hit = cache.get(map);
    if (hit && hit.R === arenaRadius) return hit.value;
    const value = build(map, mapScale(arenaRadius));
    cache.set(map, { R: arenaRadius, value });
    return value;
  };
}

/** Bumpers at the current arena size. */
export const scaledBumpers = memo((map, s): readonly Circle[] => map.bumpers.map((b) => ({ x: b.x * s, y: b.y * s, r: b.r * s })));

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

/** Blocks at the current arena size, as boxes in world units. Taller rooftops count as blocks reaching down to the street. */
export const scaledBlocks = memo((map, s): readonly Box[] => [
  ...map.blocks.map((b) => ({
    minX: (b.x - b.w / 2) * s,
    maxX: (b.x + b.w / 2) * s,
    minY: (b.y - b.d / 2) * s,
    maxY: (b.y + b.d / 2) * s,
    top: b.h,
    bottom: b.z ?? 0,
  })),
  ...(map.roofs ?? [])
    .filter((r) => (r.h ?? 0) > 0)
    .map((r) => ({
      minX: (r.x - r.w / 2) * s,
      maxX: (r.x + r.w / 2) * s,
      minY: (r.y - r.d / 2) * s,
      maxY: (r.y + r.d / 2) * s,
      top: r.h ?? 0,
      bottom: -60,
    })),
]);

/** Turret positions at the current arena size: x, y, and the height of the gun. */
export const scaledTurrets = memo((map, s): readonly { x: number; y: number; z: number }[] =>
  (map.turrets ?? []).map((t) => ({ x: t.x * s, y: t.y * s, z: (t.z ?? 0) + C.TURRET_HEIGHT })),
);

export interface RampBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  h: number;
  dir: 0 | 1 | 2 | 3;
  /** Height of the low end. */
  base: number;
}

/** Ramps at the current arena size, in world units. */
export const scaledRamps = memo((map, s): readonly RampBox[] =>
  (map.ramps ?? []).map((r) => ({
    minX: (r.x - r.w / 2) * s,
    maxX: (r.x + r.w / 2) * s,
    minY: (r.y - r.d / 2) * s,
    maxY: (r.y + r.d / 2) * s,
    h: r.h,
    dir: r.dir,
    base: r.z ?? 0,
  })),
);

/** Height of a ramp's surface at (x, y) (clamped to its footprint). */
export function rampHeight(r: RampBox, x: number, y: number): number {
  const tx = clamp01((x - r.minX) / (r.maxX - r.minX));
  const ty = clamp01((y - r.minY) / (r.maxY - r.minY));
  const t = r.dir === 0 ? tx : r.dir === 1 ? ty : r.dir === 2 ? 1 - tx : 1 - ty;
  return r.base + (r.h - r.base) * t;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Jump pads at the current arena size. */
export const scaledPads = memo((map, s): readonly Pad[] => map.pads.map((p) => ({ x: p.x * s, y: p.y * s, r: p.r * s, v: p.v })));

/**
 * Places the king of the hill can be: the middle and eight spots around it,
 * wherever there's roof you can walk to (not up on something too tall to
 * reach, and not inside a wall).
 */
export const hillSpots = memo((map, s): readonly { x: number; y: number; z: number }[] => {
  const R = s * MAP_DESIGN_RADIUS;
  const out: { x: number; y: number; z: number }[] = [];
  const cands: [number, number][] = [[0, 0], [0, 4.2], [4.2, 0], [0, -4.2], [-4.2, 0], [3.2, 3.2], [-3.2, -3.2], [3.2, -3.2], [-3.2, 3.2]];
  for (const [dx, dy] of cands) {
    const x = dx * s;
    const y = dy * s;
    const z = floorAt(map, R, x, y, 3.2);
    if (z === -Infinity || z > 3.1 || inBlock(map, R, x, y, z + 0.9, C.PLAYER_RADIUS)) continue;
    out.push({ x, y, z });
  }
  if (out.length === 0) out.push({ x: 0, y: 0, z: 0 });
  return out;
});

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
    if (x > r.minX - margin && x < r.maxX + margin && y > r.minY - margin && y < r.maxY + margin && z < rampHeight(r, x, y) + margin && z > r.base - margin) return true;
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
  return spawnAt(map, Math.PI + (index / n) * Math.PI * 2);
}

/** The safe spot on the spawn ring nearest the given angle, facing the centre. */
export function spawnAt(map: MapDef, base: number): { x: number; y: number; yaw: number } {
  const R = C.ARENA_START_RADIUS;
  const tries = (drs: number[], das: number[]): { x: number; y: number; yaw: number } | null => {
    for (const dr of drs) {
      for (const da of das) {
        const a = base + da;
        const r = C.SPAWN_DISTANCE + dr;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (spawnIsSafe(map, R, x, y)) return { x, y, yaw: Math.atan2(-y, -x) };
      }
    }
    return null;
  };
  const near = tries([0, -2, 2, -4, 4, -6], [0, 0.12, -0.12, 0.25, -0.25, 0.4, -0.4]);
  if (near) return near;
  // Buildings with gaps between them: look further round the ring.
  const wide: number[] = [];
  for (let da = 0.5; da <= Math.PI; da += 0.1) wide.push(da, -da);
  const far = tries([0, -3, 3, -6, 6, -9], wide);
  if (far) return far;
  const x = Math.cos(base) * C.SPAWN_DISTANCE;
  const y = Math.sin(base) * C.SPAWN_DISTANCE;
  return { x, y, yaw: base + Math.PI };
}
