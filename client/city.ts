// The city far below the floating rooftops, seen from straight above at
// dusk. The street grid is tilted and irregular: uneven blocks, wide
// avenues, a diagonal boulevard cutting across it and a roundabout with a
// fountain. Rooftops lean away from the centre (top-down perspective).
// Traffic is sedans, taxis, box trucks and buses. Static parts are painted
// once into an offscreen canvas; cars and clouds move "on twos" (12 fps)
// for a hand-animated, comic-book feel.

import { clamp } from '../shared/sim.js';

const INK = '#1b1030';
const ROOFS = ['#43307a', '#2e4a86', '#5b3383', '#235c78', '#763266', '#34336b', '#4b3f8f', '#2a6b6b'];
const CAR_COLORS = ['#ff2e88', '#00d9ff', '#e8e8ff', '#ff4f4f', '#7cff6b', '#9a7bff', '#2e7bff', '#3a3550'];
const ASPHALT = '#1e1438';
const SIDEWALK = '#34275c';
const STEP = 1 / 12;
/** How far the whole street grid is turned, so nothing lines up with the screen. */
const GRID_ANGLE = 0.21;

type CarKind = 'sedan' | 'taxi' | 'truck' | 'bus';

interface Lane {
  /** Start point and unit direction, in the (untilted) grid frame. */
  ox: number;
  oy: number;
  dx: number;
  dy: number;
  len: number;
}

interface Car {
  lane: Lane;
  t: number;
  speed: number;
  kind: CarKind;
  color: string;
}

interface Cloud {
  x: number;
  y: number;
  size: number;
  speed: number;
}

interface Street {
  pos: number;
  width: number;
  avenue: boolean;
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
  /** City size in CSS pixels, and its pixel resolution. */
  private w = 0;
  private h = 0;
  private res = 1;
  private cars: Car[] = [];
  private clouds: Cloud[] = [];
  private stepAcc = 0;
  private panTime = 0;
  /** Roundabout island (grid frame): cars hide while crossing it. */
  private island = { x: 0, y: 0, r: 0 };

  /** Rebuilds the city for a new screen size. */
  build(viewW: number, viewH: number, dpr: number): void {
    this.w = Math.round(viewW * 1.35 + 240);
    this.h = Math.round(viewH * 1.35 + 240);
    this.res = Math.min(dpr, 1.5);
    const cv = document.createElement('canvas');
    cv.width = Math.round(this.w * this.res);
    cv.height = Math.round(this.h * this.res);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(this.res, this.res);
    const lanes = this.paint(ctx, clamp(Math.min(viewW, viewH) / 4.2, 110, 190));
    this.canvas = cv;
    this.spawnTraffic(lanes);
    if (this.clouds.length === 0) {
      const rand = prng(99);
      for (let i = 0; i < 5; i++) {
        this.clouds.push({ x: rand() * 1.3 - 0.15, y: rand(), size: 22 + rand() * 26, speed: 5 + rand() * 9 });
      }
    }
  }

  /** Paints the static city and returns the traffic lanes. */
  private paint(ctx: CanvasRenderingContext2D, P: number): Lane[] {
    const rand = prng(1234);
    const cx = this.w / 2;
    const cy = this.h / 2;
    // Paint a bit beyond the canvas so the tilted grid still covers every corner.
    const E = Math.hypot(this.w, this.h) / 2 + 60;
    const lanes: Lane[] = [];

    // Streets at uneven spacing; some are wide avenues.
    const streets = (center: number): Street[] => {
      const out: Street[] = [];
      for (let p = center - E; p < center + E + P; p += P * (0.6 + rand() * 0.95)) {
        const avenue = rand() < 0.28;
        out.push({ pos: p, width: P * (avenue ? 0.34 : 0.19), avenue });
      }
      return out;
    };
    const cols = streets(cx);
    const rows = streets(cy);

    // A diagonal boulevard through the middle, like Broadway.
    const diag = { x: cx + P * 0.3, y: cy - P * 0.25, a: 0.64, width: P * 0.38 };
    const dnx = -Math.sin(diag.a);
    const dny = Math.cos(diag.a);
    const distToDiag = (x: number, y: number): number => Math.abs((x - diag.x) * dnx + (y - diag.y) * dny);

    // A roundabout at the intersection nearest a spot left of centre.
    const ci = cols.reduce((best, c, i) => (Math.abs(c.pos - (cx - P * 1.5)) < Math.abs(cols[best].pos - (cx - P * 1.5)) ? i : best), 0);
    const ri = rows.reduce((best, r, i) => (Math.abs(r.pos - (cy + P * 1.2)) < Math.abs(rows[best].pos - (cy + P * 1.2)) ? i : best), 0);
    const round = { x: cols[ci].pos, y: rows[ri].pos, r: P * 0.6 };
    this.island = { x: round.x, y: round.y, r: round.r * 0.55 };

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
        ctx.setLineDash([]);
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

    // Blocks: sidewalks, then parks or building lots.
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
      distToDiag(x, y) < diag.width / 2 + pad || Math.hypot(x - round.x, y - round.y) < round.r + pad;

    for (let i = 0; i < cols.length - 1; i++) {
      for (let j = 0; j < rows.length - 1; j++) {
        const x0 = cols[i].pos + cols[i].width / 2;
        const x1 = cols[i + 1].pos - cols[i + 1].width / 2;
        const y0 = rows[j].pos + rows[j].width / 2;
        const y1 = rows[j + 1].pos - rows[j + 1].width / 2;
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

    // The diagonal boulevard, cut through the blocks.
    const L = E * 3;
    const ddx = Math.cos(diag.a);
    const ddy = Math.sin(diag.a);
    ctx.save();
    ctx.translate(diag.x, diag.y);
    ctx.rotate(diag.a);
    ctx.fillStyle = SIDEWALK;
    ctx.fillRect(-L / 2, -diag.width / 2 - 7, L, diag.width + 14);
    ctx.fillStyle = ASPHALT;
    ctx.fillRect(-L / 2, -diag.width / 2, L, diag.width);
    ctx.restore();
    markLine(diag.x - ddx * L / 2, diag.y - ddy * L / 2, diag.x + ddx * L / 2, diag.y + ddy * L / 2, true);

    // Roundabout with a fountain in the middle.
    ctx.fillStyle = SIDEWALK;
    ctx.beginPath();
    ctx.arc(round.x, round.y, round.r + 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ASPHALT;
    ctx.beginPath();
    ctx.arc(round.x, round.y, round.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([8, 10]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(round.x, round.y, round.r * 0.78, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#2d7a5a';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(round.x, round.y, round.r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#4fb3ff';
    ctx.beginPath();
    ctx.arc(round.x, round.y, round.r * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      ctx.beginPath();
      ctx.arc(round.x + Math.cos(a) * round.r * 0.14, round.y + Math.sin(a) * round.r * 0.14, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Zebra crossings where avenues meet.
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    for (const c of cols) {
      for (const r of rows) {
        if (!(c.avenue || r.avenue) || blocked(c.pos, r.pos, 20)) continue;
        for (let k = -3; k <= 3; k++) {
          ctx.fillRect(c.pos + k * 5 - 1.5, r.pos - r.width / 2 - 9, 3, 7);
          ctx.fillRect(c.pos + k * 5 - 1.5, r.pos + r.width / 2 + 2, 3, 7);
        }
      }
    }

    // Buildings: sides first (they lean away from the centre, like looking
    // straight down), then roofs on top.
    for (const b of lots) {
      const k = b.height * 0.1;
      const dx = (b.x + b.w / 2 - cx) * k;
      const dy = (b.y + b.h / 2 - cy) * k;
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

    // Traffic lanes: both directions on every street and the boulevard.
    const addPair = (x0: number, y0: number, dx: number, dy: number, len: number, width: number): void => {
      const off = width * 0.22;
      const nx = -dy;
      const ny = dx;
      lanes.push({ ox: x0 + nx * off, oy: y0 + ny * off, dx, dy, len });
      lanes.push({ ox: x0 - nx * off + dx * len, oy: y0 - ny * off + dy * len, dx: -dx, dy: -dy, len });
    };
    for (const c of cols) addPair(c.pos, cy - E, 0, 1, E * 2, c.width);
    for (const r of rows) addPair(cx - E, r.pos, 1, 0, E * 2, r.width);
    addPair(diag.x - ddx * E, diag.y - ddy * E, ddx, ddy, E * 2, diag.width);
    addPair(diag.x - ddx * E, diag.y - ddy * E, ddx, ddy, E * 2, diag.width * 0.45);
    return lanes;
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

  private spawnTraffic(lanes: Lane[]): void {
    const rand = prng(7);
    this.cars = [];
    for (let i = 0; i < 110 && lanes.length > 0; i++) {
      const lane = lanes[Math.floor(rand() * lanes.length)];
      const roll = rand();
      const kind: CarKind = roll < 0.55 ? 'sedan' : roll < 0.75 ? 'taxi' : roll < 0.9 ? 'truck' : 'bus';
      this.cars.push({
        lane,
        t: rand() * lane.len,
        speed: kind === 'bus' ? 22 + rand() * 10 : 28 + rand() * 34,
        kind,
        color: kind === 'taxi' ? '#ffd21a' : kind === 'bus' ? (rand() < 0.5 ? '#ff7a1a' : '#2e7bff') : CAR_COLORS[Math.floor(rand() * CAR_COLORS.length)],
      });
    }
  }

  /** Advances cars, clouds and the slow camera drift, in 12 fps steps. */
  update(dt: number): void {
    this.stepAcc += Math.min(dt, 0.5);
    while (this.stepAcc >= STEP) {
      this.stepAcc -= STEP;
      this.panTime += STEP;
      for (const c of this.cars) c.t = (c.t + c.speed * STEP) % c.lane.len;
      for (const cl of this.clouds) {
        cl.x += (cl.speed * STEP) / 1000;
        if (cl.x > 1.3) cl.x -= 1.6;
      }
    }
  }

  /** Where the visible window sits inside the (bigger) city canvas. */
  private offset(viewW: number, viewH: number): [number, number] {
    const mx = (this.w - viewW) / 2;
    const my = (this.h - viewH) / 2;
    return [mx + Math.sin(this.panTime * 0.035) * mx * 0.7, my + Math.cos(this.panTime * 0.027) * my * 0.7];
  }

  /** Draws the city and traffic in screen space (CSS pixels at the current transform). */
  draw(ctx: CanvasRenderingContext2D, viewW: number, viewH: number, shakeX: number, shakeY: number): void {
    if (!this.canvas) {
      ctx.fillStyle = ASPHALT;
      ctx.fillRect(0, 0, viewW, viewH);
      return;
    }
    const [ox, oy] = this.offset(viewW, viewH);
    const sx = ox - shakeX * 0.15;
    const sy = oy - shakeY * 0.15;
    ctx.drawImage(this.canvas, sx * this.res, sy * this.res, viewW * this.res, viewH * this.res, 0, 0, viewW, viewH);

    const cx = this.w / 2;
    const cy = this.h / 2;
    const cos = Math.cos(GRID_ANGLE);
    const sin = Math.sin(GRID_ANGLE);
    for (const c of this.cars) {
      const gx = c.lane.ox + c.lane.dx * c.t;
      const gy = c.lane.oy + c.lane.dy * c.t;
      if (Math.hypot(gx - this.island.x, gy - this.island.y) < this.island.r + 8) continue;
      // Grid frame -> city canvas (tilted about the centre) -> screen.
      const px = cx + (gx - cx) * cos - (gy - cy) * sin - sx;
      const py = cy + (gx - cx) * sin + (gy - cy) * cos - sy;
      if (px < -40 || py < -40 || px > viewW + 40 || py > viewH + 40) continue;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(Math.atan2(c.lane.dy, c.lane.dx) + GRID_ANGLE);
      drawVehicle(ctx, c.kind, c.color);
      ctx.restore();
    }
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
