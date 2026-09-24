// Navigation for bots: a walkability grid of the roof at its current size,
// A* routes around walls and through doorways, and the ramps that lead up
// onto roofs and bridges. Grids are cached per map and arena size, so every
// bot in every room shares the work.

import * as C from './constants.js';
import { floorAt, inBlock, isOffMap, scaledRamps, type MapDef } from './maps.js';

/** Grid cell size in metres. */
const CELL = 1;

export interface NavGrid {
  /** Cells per side; cell (i, j) is centred at (ox + i + 0.5, ox + j + 0.5). */
  n: number;
  ox: number;
  /** 1 where a player can stand on the roof at ground level. */
  walk: Uint8Array;
}

/** A way up: walk to the entry, then straight along (dx, dy) up the ramp to the top. */
export interface Climb {
  entryX: number;
  entryY: number;
  dx: number;
  dy: number;
  /** A spot on the roof or bridge at the top, a little past the ramp. */
  topX: number;
  topY: number;
  /** Height of the surface at the top. */
  h: number;
}

const grids = new Map<string, NavGrid>();

/** The walkability grid for a map at an arena size (cached). */
export function navGrid(map: MapDef, arenaRadius: number): NavGrid {
  const key = `${map.name}|${Math.round(arenaRadius * 2)}`;
  const cached = grids.get(key);
  if (cached) return cached;
  const n = Math.ceil((arenaRadius * 2) / CELL) + 2;
  const ox = -n / 2;
  const walk = new Uint8Array(n * n);
  const r = C.PLAYER_RADIUS + 0.3;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = ox + i + 0.5;
      const y = ox + j + 0.5;
      let ok = !isOffMap(map, arenaRadius, x, y);
      for (let k = 0; ok && k < 8; k++) {
        const a = (k * Math.PI) / 4;
        if (isOffMap(map, arenaRadius, x + Math.cos(a) * r, y + Math.sin(a) * r)) ok = false;
      }
      // Blocked if anything is in the way at knee or head height (roofs and
      // lintels are above head height, so doorways and underpasses are open).
      if (ok && (inBlock(map, arenaRadius, x, y, 0.45, C.PLAYER_RADIUS) || inBlock(map, arenaRadius, x, y, 1.6, C.PLAYER_RADIUS))) ok = false;
      walk[j * n + i] = ok ? 1 : 0;
    }
  }
  const grid = { n, ox, walk };
  if (grids.size > 64) grids.clear();
  grids.set(key, grid);
  return grid;
}

function cellOf(g: NavGrid, x: number, y: number): [number, number] {
  return [Math.floor(x - g.ox), Math.floor(y - g.ox)];
}

function walkable(g: NavGrid, i: number, j: number): boolean {
  return i >= 0 && j >= 0 && i < g.n && j < g.n && g.walk[j * g.n + i] === 1;
}

/** True if a straight walk between two points stays on walkable cells. */
export function clearLine(g: NavGrid, x0: number, y0: number, x1: number, y1: number): boolean {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(d / (CELL * 0.5)));
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const [i, j] = cellOf(g, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    if (!walkable(g, i, j)) return false;
  }
  return true;
}

/** Nearest walkable cell to a point (searching outwards), or null. */
function nearestWalkable(g: NavGrid, x: number, y: number): [number, number] | null {
  const [ci, cj] = cellOf(g, x, y);
  for (let r = 0; r < 6; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        if (walkable(g, ci + di, cj + dj)) return [ci + di, cj + dj];
      }
    }
  }
  return null;
}

/**
 * A* route over the ground from (sx, sy) to (gx, gy), as world points (the
 * first is the next place to head for). Shortcuts are taken wherever the
 * straight line is clear. Null if there's no way.
 */
export function findPath(g: NavGrid, sx: number, sy: number, gx: number, gy: number): [number, number][] | null {
  const start = nearestWalkable(g, sx, sy);
  const goal = nearestWalkable(g, gx, gy);
  if (!start || !goal) return null;
  const n = g.n;
  const idx = (i: number, j: number): number => j * n + i;
  const gi = goal[0];
  const gj = goal[1];
  const cost = new Float32Array(n * n).fill(Infinity);
  const from = new Int32Array(n * n).fill(-1);
  const closed = new Uint8Array(n * n);
  // A small binary heap of [f, index].
  const heap: [number, number][] = [];
  const push = (f: number, k: number): void => {
    heap.push([f, k]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = (): [number, number] | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };
  const h = (i: number, j: number): number => Math.hypot(i - gi, j - gj);
  const s = idx(start[0], start[1]);
  cost[s] = 0;
  push(h(start[0], start[1]), s);
  let found = false;
  let expanded = 0;
  while (heap.length > 0 && expanded < 6000) {
    const top = pop();
    if (!top) break;
    const k = top[1];
    if (closed[k]) continue;
    closed[k] = 1;
    expanded++;
    const i = k % n;
    const j = (k - i) / n;
    if (i === gi && j === gj) {
      found = true;
      break;
    }
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di;
        const nj = j + dj;
        if (!walkable(g, ni, nj)) continue;
        // No cutting corners past walls.
        if (di && dj && (!walkable(g, i + di, j) || !walkable(g, i, j + dj))) continue;
        const nk = idx(ni, nj);
        const c = cost[k] + (di && dj ? Math.SQRT2 : 1);
        if (c < cost[nk]) {
          cost[nk] = c;
          from[nk] = k;
          push(c + h(ni, nj), nk);
        }
      }
    }
  }
  if (!found) return null;
  // Walk back, then keep only the corners we can't see past.
  const cells: [number, number][] = [];
  for (let k = idx(gi, gj); k !== -1; k = from[k]) {
    const i = k % n;
    cells.push([g.ox + i + 0.5, g.ox + (k - i) / n + 0.5]);
  }
  cells.reverse();
  cells[cells.length - 1] = [gx, gy];
  const out: [number, number][] = [];
  let ax = sx;
  let ay = sy;
  let last = 0;
  while (last < cells.length - 1) {
    let far = last + 1;
    for (let t = cells.length - 1; t > far; t--) {
      if (clearLine(g, ax, ay, cells[t][0], cells[t][1])) {
        far = t;
        break;
      }
    }
    out.push(cells[far]);
    [ax, ay] = cells[far];
    last = far;
  }
  return out;
}

/** Every ramp as a way up onto a roof or bridge. */
export function climbs(map: MapDef, arenaRadius: number): Climb[] {
  const out: Climb[] = [];
  for (const r of scaledRamps(map, arenaRadius)) {
    const cx = (r.minX + r.maxX) / 2;
    const cy = (r.minY + r.maxY) / 2;
    const [dx, dy] = r.dir === 0 ? [1, 0] : r.dir === 1 ? [0, 1] : r.dir === 2 ? [-1, 0] : [0, -1];
    const half = r.dir === 0 || r.dir === 2 ? (r.maxX - r.minX) / 2 : (r.maxY - r.minY) / 2;
    const entryX = cx - dx * (half + 1.2);
    const entryY = cy - dy * (half + 1.2);
    const topX = cx + dx * (half + 2.2);
    const topY = cy + dy * (half + 2.2);
    const h = floorAt(map, arenaRadius, topX, topY, r.h + 0.3);
    if (h < r.h - 0.5 || isOffMap(map, arenaRadius, entryX, entryY)) continue;
    out.push({ entryX, entryY, dx, dy, topX, topY, h });
  }
  return out;
}
