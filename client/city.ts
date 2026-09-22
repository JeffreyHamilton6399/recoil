// The city far below the floating ice, seen from straight above at dusk:
// rooftops leaning away from the centre (top-down perspective), streets with
// moving cars, parks, and toon clouds drifting between the city and the ice.
// Static parts are painted once into an offscreen canvas; cars and clouds
// move "on twos" (12 fps) for a hand-animated, comic-book feel.

import { clamp } from '../shared/sim.js';

const INK = '#1b1030';
const ROOFS = ['#43307a', '#2e4a86', '#5b3383', '#235c78', '#763266', '#34336b', '#4b3f8f', '#2a6b6b'];
const CAR_COLORS = ['#ff2e88', '#00d9ff', '#ffd93d', '#ff7a3d', '#8cff66', '#ffffff'];
const STEP = 1 / 12;

interface Car {
  horizontal: boolean;
  /** The street the car drives along (city px). */
  line: number;
  pos: number;
  speed: number;
  color: string;
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

const CLOUD_PUFFS: readonly [number, number, number][] = [
  [0, 0, 1],
  [0.85, 0.12, 0.72],
  [-0.85, 0.18, 0.68],
  [0.35, -0.48, 0.7],
  [-0.38, -0.36, 0.6],
  [1.45, 0.3, 0.45],
];

export class City {
  private canvas: HTMLCanvasElement | null = null;
  /** City size in CSS pixels, and its pixel resolution. */
  private w = 0;
  private h = 0;
  private res = 1;
  private pitch = 120;
  private cars: Car[] = [];
  private clouds: Cloud[] = [];
  private stepAcc = 0;
  private panTime = 0;

  /** Rebuilds the city for a new screen size. */
  build(viewW: number, viewH: number, dpr: number): void {
    this.w = Math.round(viewW * 1.35 + 240);
    this.h = Math.round(viewH * 1.35 + 240);
    this.res = Math.min(dpr, 1.5);
    this.pitch = clamp(Math.min(viewW, viewH) / 4.2, 110, 190);
    const cv = document.createElement('canvas');
    cv.width = Math.round(this.w * this.res);
    cv.height = Math.round(this.h * this.res);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(this.res, this.res);
    this.paint(ctx);
    this.canvas = cv;
    this.spawnTraffic();
    if (this.clouds.length === 0) {
      const rand = prng(99);
      for (let i = 0; i < 5; i++) {
        this.clouds.push({ x: rand() * 1.3 - 0.15, y: rand(), size: 22 + rand() * 26, speed: 5 + rand() * 9 });
      }
    }
  }

  private paint(ctx: CanvasRenderingContext2D): void {
    const rand = prng(1234);
    const P = this.pitch;
    const street = P * 0.2;
    const cx = this.w / 2;
    const cy = this.h / 2;

    // Asphalt.
    ctx.fillStyle = '#1e1438';
    ctx.fillRect(0, 0, this.w, this.h);

    // Lane markings down the middle of every street.
    ctx.strokeStyle = 'rgba(255,217,61,0.45)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 10]);
    for (let x = 0; x <= this.w; x += P) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.h);
      ctx.stroke();
    }
    for (let y = 0; y <= this.h; y += P) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.w, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    interface Lot {
      x: number;
      y: number;
      w: number;
      h: number;
      height: number;
      roof: string;
    }
    const lots: Lot[] = [];

    for (let bx = 0; bx * P < this.w; bx++) {
      for (let by = 0; by * P < this.h; by++) {
        const x0 = bx * P + street / 2;
        const y0 = by * P + street / 2;
        const size = P - street;
        // Sidewalk.
        ctx.fillStyle = '#34275c';
        ctx.fillRect(x0, y0, size, size);
        if (rand() < 0.12) {
          this.paintPark(ctx, x0, y0, size, rand);
          continue;
        }
        const nx = rand() < 0.5 ? 1 : 2;
        const ny = rand() < 0.5 ? 1 : 2;
        const gap = 6;
        const lw = (size - gap * (nx + 1)) / nx;
        const lh = (size - gap * (ny + 1)) / ny;
        for (let i = 0; i < nx; i++) {
          for (let j = 0; j < ny; j++) {
            const inset = rand() * 5;
            lots.push({
              x: x0 + gap + i * (lw + gap) + inset,
              y: y0 + gap + j * (lh + gap) + inset,
              w: lw - inset * 2,
              h: lh - inset * 2,
              height: 0.25 + rand() * 0.9,
              roof: ROOFS[Math.floor(rand() * ROOFS.length)],
            });
          }
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
        // Rows of lit windows along the side.
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
      // Roof.
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
      // Rooftop clutter: AC boxes and the odd water tower.
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

    // Push it back: dusk tint and comic halftone dots over everything.
    ctx.fillStyle = 'rgba(58,20,110,0.38)';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.fillStyle = 'rgba(255,46,136,0.12)';
    for (let y = 0; y < this.h; y += 7) {
      for (let x = (y / 7) % 2 === 0 ? 0 : 3.5; x < this.w; x += 7) {
        ctx.fillRect(x, y, 1.6, 1.6);
      }
    }
  }

  private paintPark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, rand: () => number): void {
    ctx.fillStyle = '#2d7a5a';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.fillRect(x + 4, y + 4, size - 8, size - 8);
    ctx.strokeRect(x + 4, y + 4, size - 8, size - 8);
    // A winding path.
    ctx.strokeStyle = '#c9b98f';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + 6, y + size * 0.3);
    ctx.quadraticCurveTo(x + size * 0.5, y + size * 0.9, x + size - 6, y + size * 0.55);
    ctx.stroke();
    for (let i = 0; i < 9; i++) {
      const tx = x + 12 + rand() * (size - 24);
      const ty = y + 12 + rand() * (size - 24);
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

  private spawnTraffic(): void {
    const rand = prng(7);
    const P = this.pitch;
    this.cars = [];
    const lanes = P * 0.05;
    for (let i = 0; i < 46; i++) {
      const horizontal = rand() < 0.5;
      const count = Math.floor((horizontal ? this.h : this.w) / P);
      const street = Math.floor(rand() * (count + 1)) * P;
      const dir = rand() < 0.5 ? 1 : -1;
      this.cars.push({
        horizontal,
        line: street + dir * lanes,
        pos: rand() * (horizontal ? this.w : this.h),
        speed: dir * (25 + rand() * 35),
        color: CAR_COLORS[Math.floor(rand() * CAR_COLORS.length)],
      });
    }
  }

  /** Advances cars, clouds and the slow camera drift, in 12 fps steps. */
  update(dt: number): void {
    this.stepAcc += dt;
    while (this.stepAcc >= STEP) {
      this.stepAcc -= STEP;
      this.panTime += STEP;
      for (const c of this.cars) {
        const len = c.horizontal ? this.w : this.h;
        c.pos = (((c.pos + c.speed * STEP) % len) + len) % len;
      }
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
      ctx.fillStyle = '#1e1438';
      ctx.fillRect(0, 0, viewW, viewH);
      return;
    }
    const [ox, oy] = this.offset(viewW, viewH);
    const sx = ox - shakeX * 0.15;
    const sy = oy - shakeY * 0.15;
    ctx.drawImage(this.canvas, sx * this.res, sy * this.res, viewW * this.res, viewH * this.res, 0, 0, viewW, viewH);

    // Cars with headlights and tail lights.
    for (const c of this.cars) {
      const cxp = (c.horizontal ? c.pos : c.line) - sx;
      const cyp = (c.horizontal ? c.line : c.pos) - sy;
      if (cxp < -20 || cyp < -20 || cxp > viewW + 20 || cyp > viewH + 20) continue;
      ctx.save();
      ctx.translate(cxp, cyp);
      if (!c.horizontal) ctx.rotate(Math.PI / 2);
      if (c.speed < 0) ctx.rotate(Math.PI);
      ctx.fillStyle = 'rgba(255,240,170,0.35)';
      ctx.beginPath();
      ctx.moveTo(6, -2);
      ctx.lineTo(22, -6);
      ctx.lineTo(22, 6);
      ctx.lineTo(6, 2);
      ctx.fill();
      ctx.fillStyle = c.color;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.2;
      ctx.fillRect(-6, -3, 12, 6);
      ctx.strokeRect(-6, -3, 12, 6);
      ctx.fillStyle = '#fff6b0';
      ctx.fillRect(4.5, -2.5, 1.5, 1.6);
      ctx.fillRect(4.5, 0.9, 1.5, 1.6);
      ctx.fillStyle = '#ff2e4e';
      ctx.fillRect(-6, -2.5, 1.2, 1.6);
      ctx.fillRect(-6, 0.9, 1.2, 1.6);
      ctx.restore();
    }
  }

  /** Toon clouds drifting between the city and the ice (screen space). */
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

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (n: number, sh: number): number => (n >> sh) & 255;
  const m = (sh: number): number => Math.round(ch(pa, sh) + (ch(pb, sh) - ch(pa, sh)) * t);
  return `rgb(${m(16)},${m(8)},${m(0)})`;
}
