// The city around the tower you're fighting on, seen from straight above at
// dusk. It doesn't scroll: the arena is the roof of a tower standing in its
// own plaza in the middle of the map. The street grid is tilted and uneven,
// with wide avenues and a canal cutting across it under bridges. Streets
// that reach the plaza dive into tunnels under the tower.
//
// Traffic obeys signals. Every intersection has lights on its own cycle.
// Cars keep their distance, stop at red, only enter an intersection if the
// green lasts long enough to clear it, and never stop inside one, so cross
// traffic never collides. Everything moves "on twos" (12 fps) for a
// hand-animated, comic-book feel.

import { clamp } from '../shared/sim.js';

const INK = '#1b1030';
const ROOFS = ['#43307a', '#2e4a86', '#5b3383', '#235c78', '#763266', '#34336b', '#4b3f8f', '#2a6b6b'];
const CAR_COLORS = ['#ff2e88', '#00d9ff', '#e8e8ff', '#ff4f4f', '#7cff6b', '#9a7bff', '#2e7bff', '#3a3550'];
const ASPHALT = '#1e1438';
const SIDEWALK = '#34275c';
const STEP = 1 / 12;
/** How far the whole street grid is turned, so nothing lines up with the screen. */
const GRID_ANGLE = 0.21;
/** Extra city painted around the screen so shake never shows an edge. */
const MARGIN = 40;

/** Signal cycle (seconds): rows green, all red, columns green, all red. */
const CYCLE = 12;
const ROWS_GREEN_END = 5;
const COLS_GREEN_START = 6;
const COLS_GREEN_END = 11;

type CarKind = 'sedan' | 'taxi' | 'truck' | 'bus';

/** Where the arena tower stands, in screen pixels. */
export interface TowerSpot {
  x: number;
  y: number;
  r: number;
}

interface Street {
  pos: number;
  width: number;
  avenue: boolean;
}

interface Crossing {
  /** Distance along the lane to the middle of the intersection. */
  t: number;
  /** Half the width of the crossing street. */
  half: number;
  /** Signal index of this intersection. */
  signal: number;
}

interface Lane {
  /** Start point and unit direction, in the (untilted) grid frame. */
  ox: number;
  oy: number;
  dx: number;
  dy: number;
  len: number;
  /** True for lanes along a row (they go on the rows' green). */
  horizontal: boolean;
  crossings: Crossing[];
  /** Cars in order of distance along the lane. */
  cars: Car[];
}

interface Car {
  t: number;
  maxSpeed: number;
  kind: CarKind;
  color: string;
  len: number;
}

interface Signal {
  x: number;
  y: number;
  offset: number;
  colHalf: number;
  rowHalf: number;
}

interface Cloud {
  x: number;
  y: number;
  size: number;
  speed: number;
}

/** Deterministic PRNG so the city looks the same every visit. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (n: number, sh: number): number => (n >> sh) & 255;
  const m = (sh: number): number => Math.round(ch(pa, sh) + (ch(pb, sh) - ch(pa, sh)) * t);
  return `rgb(${m(16)},${m(8)},${m(0)})`;
}

const CLOUD_PUFFS: readonly [number, number, number][] = [
  [0, 0, 1],
  [0.85, 0.12, 0.72],
  [-0.85, 0.18, 0.68],
  [0.35, -0.48, 0.7],
  [-0.38, -0.36, 0.6],
  [1.45, 0.3, 0.45],
];

const CAR_SIZE: Record<CarKind, [number, number]> = {
  sedan: [18, 9],
  taxi: [18, 9],
  truck: [26, 10],
  bus: [36, 11],
};

export class City {
  private canvas: HTMLCanvasElement | null = null;
  /** City size in CSS pixels (screen plus a margin), and its pixel resolution. */
  private w = 0;
  private h = 0;
  private res = 1;
  private lanes: Lane[] = [];
  private signals: Signal[] = [];
  private clouds: Cloud[] = [];
  private stepAcc = 0;
  private clock = 0;
  private builtFor = '';
  /** Tower plaza (grid frame): traffic runs through tunnels beneath it. */
  private plaza = { x: 0, y: 0, r: 0 };

  /** Rebuilds the city if the screen size or the tower's spot changed. */
  ensure(viewW: number, viewH: number, dpr: number, tower: TowerSpot): void {
    const key = [viewW, viewH, dpr, Math.round(tower.x / 4), Math.round(tower.y / 4), Math.round(tower.r / 4)].join(',');
    if (key === this.builtFor) return;
    this.builtFor = key;
    this.w = viewW + MARGIN * 2;
    this.h = viewH + MARGIN * 2;
    this.res = Math.min(dpr, 1.5);
    const cv = document.createElement('canvas');
    cv.width = Math.round(this.w * this.res);
    cv.height = Math.round(this.h * this.res);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(this.res, this.res);
    this.paint(ctx, clamp(Math.min(viewW, viewH) / 4.2, 110, 190), { x: tower.x + MARGIN, y: tower.y + MARGIN, r: tower.r });
    this.canvas = cv;
    if (this.clouds.length === 0) {
      const rand = prng(99);
      for (let i = 0; i < 5; i++) {
        this.clouds.push({ x: rand() * 1.3 - 0.15, y: rand(), size: 22 + rand() * 26, speed: 5 + rand() * 9 });
      }
    }
  }

  /** City canvas point <-> untilted grid frame. */
  private toGrid(x: number, y: number): [number, number] {
    const cx = this.w / 2;
    const cy = this.h / 2;
    const c = Math.cos(-GRID_ANGLE);
    const s = Math.sin(-GRID_ANGLE);
    return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
  }

  private fromGrid(x: number, y: number): [number, number] {
    const cx = this.w / 2;
    const cy = this.h / 2;
    const c = Math.cos(GRID_ANGLE);
    const s = Math.sin(GRID_ANGLE);
    return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
  }

  /** Paints the static city, and sets up lanes, signals and traffic. */
  private paint(ctx: CanvasRenderingContext2D, P: number, towerCity: TowerSpot): void {
    const rand = prng(1234);
    const cx = this.w / 2;
    const cy = this.h / 2;
    // Paint beyond the canvas so the tilted grid covers every corner.
    const E = Math.hypot(this.w, this.h) / 2 + 80;
    const [tx, ty] = this.toGrid(towerCity.x, towerCity.y);
    const tr = towerCity.r;

    // Streets at uneven spacing, but never so close that a bus can't wait
    // between two intersections.
    const streets = (center: number): Street[] => {
      const out: Street[] = [];
      let prev: Street | null = null;
      for (let p = center - E; p < center + E; ) {
        const avenue = rand() < 0.28;
        const width = P * (avenue ? 0.34 : 0.19);
        if (prev) p = Math.max(p, prev.pos + prev.width / 2 + width / 2 + 64);
        const s: Street = { pos: p, width, avenue };
        out.push(s);
        prev = s;
        p += P * (0.8 + rand() * 0.75);
      }
      return out;
    };
    const cols = streets(cx);
    const rows = streets(cy);
    const plazaR = tr + 26;
    this.plaza = { x: tx, y: ty, r: plazaR };

    // A canal cutting diagonally across the grid, well clear of the tower.
    const ca = 0.64;
    const cnx = -Math.sin(ca);
    const cny = Math.cos(ca);
    const canal = { x: tx + cnx * (tr + P * 0.9), y: ty + cny * (tr + P * 0.9), width: P * 0.36 };
    const distToCanal = (x: number, y: number): number => Math.abs((x - canal.x) * cnx + (y - canal.y) * cny);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(GRID_ANGLE);
    ctx.translate(-cx, -cy);

    ctx.fillStyle = ASPHALT;
    ctx.fillRect(cx - E, cy - E, E * 2, E * 2);

    // Lane markings: dashed centre lines, double yellow on avenues.
    const markLine = (x0: number, y0: number, x1: number, y1: number, avenue: boolean): void => {
      if (avenue) {
        ctx.strokeStyle = 'rgba(255,217,61,0.6)';
        ctx.lineWidth = 1.5;
        const nx = y1 - y0;
        const ny = x0 - x1;
        const n = Math.hypot(nx, ny) || 1;
        for (const off of [-2, 2]) {
          ctx.beginPath();
          ctx.moveTo(x0 + (nx / n) * off, y0 + (ny / n) * off);
          ctx.lineTo(x1 + (nx / n) * off, y1 + (ny / n) * off);
          ctx.stroke();
        }
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([8, 10]);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    };
    for (const c of cols) markLine(c.pos, cy - E, c.pos, cy + E, c.avenue);
    for (const r of rows) markLine(cx - E, r.pos, cx + E, r.pos, r.avenue);

    // Blocks: sidewalks, then the tower plaza, parks or building lots.
    interface Lot {
      x: number;
      y: number;
      w: number;
      h: number;
      height: number;
      roof: string;
    }
    const lots: Lot[] = [];
    const blocked = (x: number, y: number, pad: number): boolean =>
      distToCanal(x, y) < canal.width / 2 + pad || Math.hypot(x - tx, y - ty) < tr + pad + 10;

    const bounds = (list: Street[], center: number): [number, number][] => {
      const out: [number, number][] = [];
      const edges = [{ pos: center - E - 200, width: 0 }, ...list, { pos: center + E + 200, width: 0 }];
      for (let i = 0; i < edges.length - 1; i++) out.push([edges[i].pos + edges[i].width / 2, edges[i + 1].pos - edges[i + 1].width / 2]);
      return out;
    };
    for (const [x0, x1] of bounds(cols, cx)) {
      for (const [y0, y1] of bounds(rows, cy)) {
        const bw = x1 - x0;
        const bh = y1 - y0;
        if (bw < 10 || bh < 10) continue;
        ctx.fillStyle = SIDEWALK;
        ctx.fillRect(x0, y0, bw, bh);
        const mid = Math.hypot(bw, bh) / 2;
        if (rand() < 0.12 && !blocked(x0 + bw / 2, y0 + bh / 2, mid)) {
          this.paintPark(ctx, x0, y0, bw, bh, rand);
          continue;
        }
        const nx = Math.max(1, Math.round(bw / (P * 0.42)));
        const ny = Math.max(1, Math.round(bh / (P * 0.42)));
        const gap = 6;
        const lw = (bw - gap * (nx + 1)) / nx;
        const lh = (bh - gap * (ny + 1)) / ny;
        for (let a = 0; a < nx; a++) {
          for (let b = 0; b < ny; b++) {
            const inset = rand() * 5;
            const lot: Lot = {
              x: x0 + gap + a * (lw + gap) + inset,
              y: y0 + gap + b * (lh + gap) + inset,
              w: lw - inset * 2,
              h: lh - inset * 2,
              height: 0.25 + rand() * 0.9,
              roof: ROOFS[Math.floor(rand() * ROOFS.length)],
            };
            if (lot.w < 8 || lot.h < 8) continue;
            if (!blocked(lot.x + lot.w / 2, lot.y + lot.h / 2, Math.hypot(lot.w, lot.h) / 2 + 4)) lots.push(lot);
          }
        }
      }
    }

    // The canal, with bridges carrying every street over it.
    const L = E * 3;
    ctx.save();
    ctx.translate(canal.x, canal.y);
    ctx.rotate(ca);
    ctx.fillStyle = '#6a5a8f';
    ctx.fillRect(-L / 2, -canal.width / 2 - 6, L, canal.width + 12);
    ctx.fillStyle = '#2b5ea8';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.fillRect(-L / 2, -canal.width / 2, L, canal.width);
    ctx.strokeRect(-L / 2, -canal.width / 2, L, canal.width);
    ctx.strokeStyle = 'rgba(160,220,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([10, 14]);
    for (const off of [-0.25, 0.05, 0.3]) {
      ctx.beginPath();
      ctx.moveTo(-L / 2, off * canal.width);
      ctx.lineTo(L / 2, off * canal.width);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
    const bridge = (x0: number, y0: number, x1: number, y1: number, width: number, avenue: boolean): void => {
      ctx.save();
      ctx.save();
      ctx.translate(canal.x, canal.y);
      ctx.rotate(ca);
      ctx.beginPath();
      ctx.rect(-L / 2, -canal.width / 2 - 6, L, canal.width + 12);
      ctx.restore();
      ctx.clip();
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.strokeStyle = INK;
      ctx.lineWidth = width + 8;
      ctx.stroke();
      ctx.strokeStyle = '#8f86ad';
      ctx.lineWidth = width + 5;
      ctx.stroke();
      ctx.strokeStyle = ASPHALT;
      ctx.lineWidth = width;
      ctx.stroke();
      markLine(x0, y0, x1, y1, avenue);
      ctx.restore();
    };
    for (const c of cols) bridge(c.pos, cy - E, c.pos, cy + E, c.width, c.avenue);
    for (const r of rows) bridge(cx - E, r.pos, cx + E, r.pos, r.width, r.avenue);

    // Stop lines before every intersection (drivers keep right).
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (const c of cols) {
      for (const r of rows) {
        ctx.fillRect(c.pos - c.width / 2, r.pos - r.width / 2 - 6, c.width / 2, 2);
        ctx.fillRect(c.pos, r.pos + r.width / 2 + 4, c.width / 2, 2);
        ctx.fillRect(c.pos + c.width / 2 + 4, r.pos - r.width / 2, 2, r.width / 2);
        ctx.fillRect(c.pos - c.width / 2 - 6, r.pos, 2, r.width / 2);
      }
    }

    // The tower's plaza on top of the streets, with tunnel mouths where they dive under it.
    this.paintPlaza(ctx, tx, ty, tr);
    const portal = (px: number, py: number, angle: number, width: number): void => {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(angle);
      ctx.fillStyle = '#0d0722';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(-6, -width / 2 - 3, 12, width + 6, 4);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#8f86ad';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(6, -width / 2 - 3);
      ctx.lineTo(6, width / 2 + 3);
      ctx.stroke();
      ctx.restore();
    };
    for (const c of cols) {
      const d = c.pos - tx;
      if (Math.abs(d) >= plazaR) continue;
      const half = Math.sqrt(plazaR * plazaR - d * d);
      portal(c.pos, ty - half, -Math.PI / 2, c.width);
      portal(c.pos, ty + half, Math.PI / 2, c.width);
    }
    for (const r of rows) {
      const d = r.pos - ty;
      if (Math.abs(d) >= plazaR) continue;
      const half = Math.sqrt(plazaR * plazaR - d * d);
      portal(tx - half, r.pos, Math.PI, r.width);
      portal(tx + half, r.pos, 0, r.width);
    }

    // Buildings: sides first (they lean away from the tower, like looking
    // straight down from above it), then roofs on top.
    for (const b of lots) {
      const k = b.height * 0.1;
      const dx = (b.x + b.w / 2 - tx) * k;
      const dy = (b.y + b.h / 2 - ty) * k;
      const base: [number, number][] = [
        [b.x, b.y],
        [b.x + b.w, b.y],
        [b.x + b.w, b.y + b.h],
        [b.x, b.y + b.h],
      ];
      const sideShades = [mixHex(b.roof, '#000000', 0.25), mixHex(b.roof, '#000000', 0.5), mixHex(b.roof, '#000000', 0.55), mixHex(b.roof, '#000000', 0.3)];
      for (let e = 0; e < 4; e++) {
        const [ax, ay] = base[e];
        const [bx2, by2] = base[(e + 1) % 4];
        ctx.fillStyle = sideShades[e];
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx2, by2);
        ctx.lineTo(bx2 + dx, by2 + dy);
        ctx.lineTo(ax + dx, ay + dy);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,214,110,0.55)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 4]);
        for (const f of [0.35, 0.7]) {
          ctx.beginPath();
          ctx.moveTo(ax + dx * f, ay + dy * f);
          ctx.lineTo(bx2 + dx * f, by2 + dy * f);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      const rx = b.x + dx;
      const ry = b.y + dy;
      ctx.fillStyle = b.roof;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.fillRect(rx, ry, b.w, b.h);
      ctx.strokeRect(rx, ry, b.w, b.h);
      ctx.strokeStyle = mixHex(b.roof, '#ffffff', 0.25);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(rx + 4, ry + 4, b.w - 8, b.h - 8);
      const details = Math.floor(rand() * 3);
      for (let d = 0; d < details; d++) {
        const s = 5 + rand() * 7;
        const px = rx + 6 + rand() * Math.max(1, b.w - 12 - s);
        const py = ry + 6 + rand() * Math.max(1, b.h - 12 - s);
        ctx.fillStyle = mixHex(b.roof, '#ffffff', 0.35);
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.2;
        ctx.fillRect(px, py, s, s);
        ctx.strokeRect(px, py, s, s);
      }
      if (rand() < 0.2 && b.w > 26 && b.h > 26) {
        ctx.fillStyle = '#b4633a';
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(rx + b.w * 0.7, ry + b.h * 0.3, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();

    // Push it back: dusk tint and comic halftone dots over everything.
    ctx.fillStyle = 'rgba(58,20,110,0.34)';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.fillStyle = 'rgba(255,46,136,0.12)';
    for (let y = 0; y < this.h; y += 7) {
      for (let x = (y / 7) % 2 === 0 ? 0 : 3.5; x < this.w; x += 7) {
        ctx.fillRect(x, y, 1.6, 1.6);
      }
    }

    this.setupTraffic(cols, rows, cx, cy, E, rand);
  }

  /** The plaza at the tower's foot: paving rings and a ring of trees. */
  private paintPlaza(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
    ctx.fillStyle = '#4a3d78';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r + 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    for (let rr = 18; rr < r + 26; rr += 16) {
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2;
      const px = x + Math.cos(a) * (r + 14);
      const py = y + Math.sin(a) * (r + 14);
      ctx.fillStyle = '#44b37a';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  private paintPark(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rand: () => number): void {
    ctx.fillStyle = '#2d7a5a';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
    ctx.strokeRect(x + 4, y + 4, w - 8, h - 8);
    ctx.strokeStyle = '#c9b98f';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + 6, y + h * 0.3);
    ctx.quadraticCurveTo(x + w * 0.5, y + h * 0.9, x + w - 6, y + h * 0.55);
    ctx.stroke();
    const trees = Math.round((w * h) / 1400);
    for (let i = 0; i < trees; i++) {
      const tx = x + 12 + rand() * (w - 24);
      const ty = y + 12 + rand() * (h - 24);
      const r = 5 + rand() * 6;
      ctx.fillStyle = '#1f5c43';
      ctx.beginPath();
      ctx.arc(tx + 2, ty + 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#44b37a';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(tx, ty, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // -------------------------------------------------------------------------
  // Traffic
  // -------------------------------------------------------------------------

  private setupTraffic(cols: Street[], rows: Street[], cx: number, cy: number, E: number, rand: () => number): void {
    this.signals = [];
    const signalAt: number[][] = cols.map((c) =>
      rows.map((r) => {
        this.signals.push({ x: c.pos, y: r.pos, offset: rand() * CYCLE, colHalf: c.width / 2, rowHalf: r.width / 2 });
        return this.signals.length - 1;
      }),
    );

    this.lanes = [];
    // Lanes start and end well outside the outermost streets, so a car that
    // loops back to the start never reappears inside an intersection.
    const run = E + 160;
    const len = run * 2;
    // Keep right, with enough room between opposite lanes that cars never touch.
    const laneOffset = (width: number): number => Math.max(width * 0.25, 7);
    cols.forEach((c, i) => {
      for (const dir of [1, -1]) {
        // Southbound on the west half, northbound on the east half.
        const x = c.pos - dir * laneOffset(c.width);
        const oy = dir === 1 ? cy - run : cy + run;
        const crossings = rows.map((r, j) => ({ t: (r.pos - oy) * dir, half: r.width / 2, signal: signalAt[i][j] }));
        this.lanes.push({ ox: x, oy, dx: 0, dy: dir, len, horizontal: false, crossings: crossings.sort((a, b) => a.t - b.t), cars: [] });
      }
    });
    rows.forEach((r, j) => {
      for (const dir of [1, -1]) {
        const y = r.pos + dir * laneOffset(r.width);
        const ox = dir === 1 ? cx - run : cx + run;
        const crossings = cols.map((c, i) => ({ t: (c.pos - ox) * dir, half: c.width / 2, signal: signalAt[i][j] }));
        this.lanes.push({ ox, oy: y, dx: dir, dy: 0, len, horizontal: true, crossings: crossings.sort((a, b) => a.t - b.t), cars: [] });
      }
    });

    // Spread cars along each lane, never overlapping and never inside an intersection.
    for (const lane of this.lanes) {
      let t = rand() * 80;
      while (t < lane.len - 60) {
        const roll = rand();
        const kind: CarKind = roll < 0.55 ? 'sedan' : roll < 0.75 ? 'taxi' : roll < 0.9 ? 'truck' : 'bus';
        const carLen = CAR_SIZE[kind][0];
        for (const c of lane.crossings) {
          if (t + carLen / 2 > c.t - c.half - 8 && t - carLen / 2 < c.t + c.half + 8) t = c.t + c.half + 8 + carLen / 2;
        }
        if (t >= lane.len - 60) break;
        lane.cars.push({
          t,
          maxSpeed: kind === 'bus' ? 30 + rand() * 8 : 36 + rand() * 26,
          kind,
          color: kind === 'taxi' ? '#ffd21a' : kind === 'bus' ? (rand() < 0.5 ? '#ff7a1a' : '#2e7bff') : CAR_COLORS[Math.floor(rand() * CAR_COLORS.length)],
          len: carLen,
        });
        t += carLen + 90 + rand() * 260;
      }
    }
  }

  /** Seconds of green left for this direction at a signal (0 = red). */
  private green(signal: number, horizontal: boolean): number {
    const s = this.signals[signal];
    const local = (((this.clock + s.offset) % CYCLE) + CYCLE) % CYCLE;
    if (horizontal) return local < ROWS_GREEN_END ? ROWS_GREEN_END - local : 0;
    return local >= COLS_GREEN_START && local < COLS_GREEN_END ? COLS_GREEN_END - local : 0;
  }

  private stepTraffic(): void {
    for (const lane of this.lanes) {
      const cars = lane.cars;
      const n = cars.length;
      const leadRear = (k: number): number => {
        const lead = cars[(k + 1) % n];
        return lead.t - lead.len / 2 + (k === n - 1 ? lane.len : 0);
      };
      // Front to back, so each car sees where its leader ended up.
      for (let k = n - 1; k >= 0; k--) {
        const car = cars[k];
        const front = car.t + car.len / 2;
        let advance = car.maxSpeed * STEP;

        // Keep a gap behind the car ahead.
        if (n > 1) advance = Math.min(advance, leadRear(k) - front - 6);

        // Signals: stop at the line unless it's green long enough to clear the
        // intersection and there's room on the far side (don't block the box).
        const idx = lane.crossings.findIndex((c) => c.t - c.half - 6 >= front - 0.5);
        if (idx !== -1) {
          const c = lane.crossings[idx];
          const stopLine = c.t - c.half - 6;
          if (stopLine - front < advance + 1) {
            const left = this.green(c.signal, lane.horizontal);
            const clearTime = (c.half * 2 + car.len + 14) / car.maxSpeed + 0.3;
            const exit = c.t + c.half;
            const next = lane.crossings[idx + 1];
            let room = next ? next.t - next.half - 6 - exit : Infinity;
            if (n > 1 && leadRear(k) > stopLine) room = Math.min(room, leadRear(k) - exit);
            if (left < clearTime || room < car.len + 10) advance = Math.min(advance, stopLine - front);
          }
        }
        car.t += Math.max(0, advance);
      }
      // Cars that drive off the far end come back in at the start of the lane.
      while (cars.length > 0 && cars[cars.length - 1].t > lane.len) {
        const last = cars.pop();
        if (!last) break;
        last.t -= lane.len;
        cars.unshift(last);
      }
    }
  }

  /** Advances traffic, signals and clouds in 12 fps steps. */
  update(dt: number): void {
    this.stepAcc += Math.min(dt, 0.5);
    while (this.stepAcc >= STEP) {
      this.stepAcc -= STEP;
      this.clock += STEP;
      this.stepTraffic();
      for (const cl of this.clouds) {
        cl.x += (cl.speed * STEP) / 1000;
        if (cl.x > 1.3) cl.x -= 1.6;
      }
    }
  }

  /** Draws the city, traffic lights and traffic in screen space. */
  draw(ctx: CanvasRenderingContext2D, viewW: number, viewH: number, shakeX: number, shakeY: number): void {
    if (!this.canvas) {
      ctx.fillStyle = ASPHALT;
      ctx.fillRect(0, 0, viewW, viewH);
      return;
    }
    const sx = MARGIN - shakeX * 0.15;
    const sy = MARGIN - shakeY * 0.15;
    ctx.drawImage(this.canvas, sx * this.res, sy * this.res, viewW * this.res, viewH * this.res, 0, 0, viewW, viewH);

    const onScreen = (px: number, py: number, pad: number): boolean => px > -pad && py > -pad && px < viewW + pad && py < viewH + pad;

    // Signal heads at the corners of each intersection.
    const lightColor = (left: number): string => (left <= 0 ? '#ff3b4e' : left < 1.6 ? '#ffd93d' : '#3cff7a');
    for (let i = 0; i < this.signals.length; i++) {
      const s = this.signals[i];
      const [px0, py0] = this.fromGrid(s.x, s.y);
      if (!onScreen(px0 - sx, py0 - sy, 30) || this.underPlaza(s.x, s.y, 20)) continue;
      const rowsColor = lightColor(this.green(i, true));
      const colsColor = lightColor(this.green(i, false));
      const corners: [number, number, string][] = [
        [s.x + s.colHalf + 4, s.y - s.rowHalf - 4, colsColor],
        [s.x - s.colHalf - 4, s.y + s.rowHalf + 4, colsColor],
        [s.x - s.colHalf - 4, s.y - s.rowHalf - 4, rowsColor],
        [s.x + s.colHalf + 4, s.y + s.rowHalf + 4, rowsColor],
      ];
      for (const [gx, gy, color] of corners) {
        const [px, py] = this.fromGrid(gx, gy);
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.arc(px - sx, py - sy, 3.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px - sx, py - sy, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (const lane of this.lanes) {
      const angle = Math.atan2(lane.dy, lane.dx) + GRID_ANGLE;
      for (const c of lane.cars) {
        const gx = lane.ox + lane.dx * c.t;
        const gy = lane.oy + lane.dy * c.t;
        if (this.underPlaza(gx, gy, 2)) continue; // in the tunnel
        const [px, py] = this.fromGrid(gx, gy);
        if (!onScreen(px - sx, py - sy, 40)) continue;
        ctx.save();
        ctx.translate(px - sx, py - sy);
        ctx.rotate(angle);
        drawVehicle(ctx, c.kind, c.color);
        ctx.restore();
      }
    }
  }

  private underPlaza(x: number, y: number, pad: number): boolean {
    return Math.hypot(x - this.plaza.x, y - this.plaza.y) < this.plaza.r + pad;
  }

  /** Toon clouds drifting between the city and the rooftops (screen space). */
  drawClouds(ctx: CanvasRenderingContext2D, viewW: number, viewH: number, shakeX: number, shakeY: number): void {
    for (const cl of this.clouds) {
      const x = cl.x * viewW + shakeX * 0.4;
      const y = cl.y * viewH + shakeY * 0.4;
      const s = cl.size;
      ctx.globalAlpha = 0.78;
      // Outline trick: stroke every puff thick, then fill every puff on top.
      ctx.strokeStyle = INK;
      ctx.lineWidth = 5;
      for (const [px, py, r] of CLOUD_PUFFS) {
        ctx.beginPath();
        ctx.arc(x + px * s, y + py * s, r * s, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = '#c9b3ef';
      for (const [px, py, r] of CLOUD_PUFFS) {
        ctx.beginPath();
        ctx.arc(x + px * s, y + py * s, r * s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#f7efff';
      for (const [px, py, r] of CLOUD_PUFFS) {
        ctx.beginPath();
        ctx.arc(x + px * s - s * 0.08, y + py * s - s * 0.13, r * s * 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
}

/** A top-down vehicle facing +x: shadow, wheels, body, glass, lights. */
function drawVehicle(ctx: CanvasRenderingContext2D, kind: CarKind, color: string): void {
  const [L, W] = CAR_SIZE[kind];
  const hl = L / 2;
  const hw = W / 2;
  const glass = '#26345e';

  // Headlight beams on the road.
  ctx.fillStyle = 'rgba(255,240,170,0.2)';
  ctx.beginPath();
  ctx.moveTo(hl, -hw * 0.6);
  ctx.lineTo(hl + 15, -hw - 3);
  ctx.lineTo(hl + 15, hw + 3);
  ctx.lineTo(hl, hw * 0.6);
  ctx.fill();

  // Drop shadow and wheels.
  ctx.fillStyle = 'rgba(10,4,25,0.45)';
  ctx.beginPath();
  ctx.roundRect(-hl + 1.5, -hw + 2, L, W, 3);
  ctx.fill();
  ctx.fillStyle = INK;
  const axles = kind === 'bus' ? [-hl * 0.65, hl * 0.6] : kind === 'truck' ? [-hl * 0.6, -hl * 0.25, hl * 0.6] : [-hl * 0.55, hl * 0.55];
  for (const ax of axles) {
    ctx.fillRect(ax - 2.2, -hw - 1, 4.4, 2);
    ctx.fillRect(ax - 2.2, hw - 1, 4.4, 2);
  }

  // Body.
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(-hl, -hw, L, W, kind === 'sedan' || kind === 'taxi' ? W * 0.42 : 2);
  ctx.fill();
  ctx.stroke();

  if (kind === 'sedan' || kind === 'taxi') {
    // Roof, windscreen and rear window.
    ctx.fillStyle = mixHex(color, '#ffffff', 0.2);
    ctx.fillRect(-L * 0.16, -hw * 0.72, L * 0.26, W * 0.72);
    ctx.fillStyle = glass;
    ctx.beginPath();
    ctx.moveTo(L * 0.1, -hw * 0.78);
    ctx.lineTo(L * 0.3, -hw * 0.6);
    ctx.lineTo(L * 0.3, hw * 0.6);
    ctx.lineTo(L * 0.1, hw * 0.78);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-L * 0.16, -hw * 0.78);
    ctx.lineTo(-L * 0.3, -hw * 0.6);
    ctx.lineTo(-L * 0.3, hw * 0.6);
    ctx.lineTo(-L * 0.16, hw * 0.78);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(L * 0.14, -hw * 0.5);
    ctx.lineTo(L * 0.24, -hw * 0.3);
    ctx.stroke();
    if (kind === 'taxi') {
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 0.9;
      ctx.fillRect(-L * 0.06, -hw * 0.35, L * 0.1, W * 0.35);
      ctx.strokeRect(-L * 0.06, -hw * 0.35, L * 0.1, W * 0.35);
    }
  } else if (kind === 'truck') {
    // Cargo box behind a coloured cab.
    ctx.fillStyle = '#ebe6f5';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2;
    ctx.fillRect(-hl, -hw, L * 0.68, W);
    ctx.strokeRect(-hl, -hw, L * 0.68, W);
    ctx.strokeStyle = 'rgba(27,16,48,0.3)';
    ctx.lineWidth = 0.8;
    for (let x = -hl + 4; x < -hl + L * 0.68; x += 4) {
      ctx.beginPath();
      ctx.moveTo(x, -hw + 1);
      ctx.lineTo(x, hw - 1);
      ctx.stroke();
    }
    ctx.fillStyle = glass;
    ctx.fillRect(hl - 5, -hw * 0.7, 3, W * 0.7);
  } else {
    // Bus: long roof with AC units and a windscreen strip.
    ctx.fillStyle = mixHex(color, '#ffffff', 0.25);
    ctx.fillRect(-hl + 2, -hw * 0.55, L - 6, W * 0.55);
    ctx.fillStyle = '#d9d4e6';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.9;
    for (const ax of [-L * 0.2, L * 0.1]) {
      ctx.fillRect(ax, -hw * 0.35, 6, W * 0.35);
      ctx.strokeRect(ax, -hw * 0.35, 6, W * 0.35);
    }
    ctx.fillStyle = glass;
    ctx.fillRect(hl - 3.5, -hw * 0.8, 2.5, W * 0.8);
  }

  // Headlights and tail lights.
  ctx.fillStyle = '#fff6b0';
  ctx.beginPath();
  ctx.arc(hl - 1.3, -hw * 0.62, 1.2, 0, Math.PI * 2);
  ctx.arc(hl - 1.3, hw * 0.62, 1.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ff2e4e';
  ctx.fillRect(-hl, -hw * 0.8, 1.4, 2);
  ctx.fillRect(-hl, hw * 0.8 - 2, 1.4, 2);
}
