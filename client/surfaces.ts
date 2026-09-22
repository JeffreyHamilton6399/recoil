// Rooftop surface art for each map: helipad markings, gravel, neon grid,
// tar patches, diamond plate, roof tiles, paving, a billboard ad, a lawn,
// plywood, parking bays and solar panels. Drawn in full-size world units
// (arena radius 9) inside the arena clip; the caller scales it as the arena
// shrinks.

import type { MapDef, Surface } from '../shared/maps.js';

const INK = '#1b1030';

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

/** Scatter of small specks, for gravel and tar. */
function specks(ctx: CanvasRenderingContext2D, seed: number, count: number, colors: string[], size: number): void {
  const rand = prng(seed);
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[i % colors.length];
    const x = (rand() - 0.5) * 20;
    const y = (rand() - 0.5) * 20;
    const r = size * (0.5 + rand());
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function gridLines(ctx: CanvasRenderingContext2D, step: number, color: string, width: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let v = -10; v <= 10; v += step) {
    ctx.moveTo(v, -10);
    ctx.lineTo(v, 10);
    ctx.moveTo(-10, v);
    ctx.lineTo(10, v);
  }
  ctx.stroke();
}

const painters: Record<Surface, (ctx: CanvasRenderingContext2D, time: number) => void> = {
  helipad(ctx) {
    ctx.strokeStyle = '#ffd93d';
    ctx.lineWidth = 0.35;
    ctx.beginPath();
    ctx.arc(0, 0, 3.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-1.5, -1.8, 0.6, 3.6);
    ctx.fillRect(0.9, -1.8, 0.6, 3.6);
    ctx.fillRect(-1.5, -0.3, 3, 0.6);
    ctx.setLineDash([0.6, 0.5]);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 0.18;
    ctx.beginPath();
    ctx.arc(0, 0, 6.8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  },
  gravel(ctx) {
    specks(ctx, 11, 260, ['#a89a88', '#efe6da', '#8f8373'], 0.07);
  },
  neon(ctx, time) {
    const pulse = 0.35 + 0.2 * Math.sin(time * 3);
    gridLines(ctx, 1.5, `rgba(0,225,255,${pulse})`, 0.06);
    ctx.strokeStyle = `rgba(255,46,136,${pulse})`;
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    for (let v = -20; v <= 20; v += 3) {
      ctx.moveTo(v, -10);
      ctx.lineTo(v + 20, 10);
    }
    ctx.stroke();
  },
  tar(ctx) {
    const rand = prng(21);
    for (let i = 0; i < 7; i++) {
      const w = 1.2 + rand() * 2.2;
      const h = 1 + rand() * 1.8;
      const x = (rand() - 0.5) * 13;
      const y = (rand() - 0.5) * 13;
      ctx.fillStyle = 'rgba(20,16,36,0.35)';
      ctx.strokeStyle = 'rgba(27,16,48,0.6)';
      ctx.lineWidth = 0.05;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    }
    specks(ctx, 22, 160, ['#6e6f88', '#2f3044'], 0.06);
  },
  plate(ctx) {
    // Diamond plate: short raised dashes in alternating directions.
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 0.09;
    ctx.beginPath();
    for (let y = -10; y <= 10; y += 0.8) {
      for (let x = -10; x <= 10; x += 0.8) {
        const flip = (Math.round(x / 0.8) + Math.round(y / 0.8)) % 2 === 0;
        ctx.moveTo(x - 0.2, y + (flip ? 0.12 : -0.12));
        ctx.lineTo(x + 0.2, y + (flip ? -0.12 : 0.12));
      }
    }
    ctx.stroke();
  },
  tiles(ctx) {
    // Rows of scalloped terracotta tiles.
    ctx.strokeStyle = 'rgba(110,40,30,0.55)';
    ctx.lineWidth = 0.07;
    for (let y = -10; y <= 10; y += 0.7) {
      const shift = Math.round(y / 0.7) % 2 === 0 ? 0 : 0.45;
      ctx.beginPath();
      for (let x = -10 + shift; x <= 10; x += 0.9) {
        ctx.moveTo(x + 0.45, y);
        ctx.arc(x, y, 0.45, 0, Math.PI);
      }
      ctx.stroke();
    }
  },
  paving(ctx) {
    // Hexagonal paving stones.
    const r = 0.75;
    const w = Math.sqrt(3) * r;
    ctx.strokeStyle = 'rgba(90,70,60,0.45)';
    ctx.lineWidth = 0.07;
    ctx.beginPath();
    for (let row = -9; row <= 9; row++) {
      for (let col = -8; col <= 8; col++) {
        const cx = col * w + (row % 2 === 0 ? 0 : w / 2);
        const cy = row * r * 1.5;
        for (let k = 0; k < 6; k++) {
          const a = Math.PI / 6 + (k * Math.PI) / 3;
          const px = cx + Math.cos(a) * r;
          const py = cy + Math.sin(a) * r;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
      }
    }
    ctx.stroke();
  },
  billboard(ctx) {
    // A loud ad: sunburst rays and a big star.
    ctx.fillStyle = 'rgba(255,90,60,0.45)';
    for (let k = 0; k < 16; k += 2) {
      const a0 = (k * Math.PI) / 8;
      const a1 = ((k + 1) * Math.PI) / 8;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a0) * 14, Math.sin(a0) * 14);
      ctx.lineTo(Math.cos(a1) * 14, Math.sin(a1) * 14);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 3.2 : 1.4;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  },
  garden(ctx) {
    // Grass tufts, a stone path and flower planters.
    const rand = prng(33);
    ctx.strokeStyle = 'rgba(30,90,50,0.6)';
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    for (let i = 0; i < 140; i++) {
      const x = (rand() - 0.5) * 18;
      const y = (rand() - 0.5) * 18;
      ctx.moveTo(x - 0.12, y);
      ctx.lineTo(x, y - 0.22);
      ctx.lineTo(x + 0.12, y);
    }
    ctx.stroke();
    ctx.fillStyle = '#d9d2c0';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 0.06;
    for (let i = -4; i <= 4; i++) {
      ctx.beginPath();
      ctx.ellipse(i * 1.3, Math.sin(i * 0.8) * 1.2, 0.45, 0.32, 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    for (const [x, y] of [
      [-3.2, -3.4],
      [3.4, 3.2],
    ]) {
      ctx.fillStyle = '#8a5a3c';
      ctx.fillRect(x - 1, y - 0.4, 2, 0.8);
      ctx.strokeRect(x - 1, y - 0.4, 2, 0.8);
      for (let f = 0; f < 5; f++) {
        ctx.fillStyle = ['#ff6fc1', '#ffd93d', '#ffffff'][f % 3];
        ctx.beginPath();
        ctx.arc(x - 0.75 + f * 0.37, y - 0.1, 0.16, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  },
  plywood(ctx) {
    ctx.strokeStyle = 'rgba(120,80,40,0.5)';
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    for (let y = -10; y <= 10; y += 1.2) {
      ctx.moveTo(-10, y);
      ctx.lineTo(10, y);
    }
    ctx.stroke();
    // Hazard stripes along both sides of the gap.
    for (const side of [-1, 1]) {
      const x0 = side * 1.35 - 0.2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, -10, 0.4, 20);
      ctx.clip();
      ctx.fillStyle = '#ffd93d';
      ctx.fillRect(x0, -10, 0.4, 20);
      ctx.fillStyle = INK;
      for (let y = -10; y <= 10; y += 0.6) {
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + 0.4, y - 0.3);
        ctx.lineTo(x0 + 0.4, y);
        ctx.lineTo(x0, y + 0.3);
        ctx.fill();
      }
      ctx.restore();
    }
  },
  parking(ctx) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    for (const rowY of [-7.5, 3.8]) {
      for (let x = -7; x <= 7; x += 1.6) {
        ctx.moveTo(x, rowY);
        ctx.lineTo(x, rowY + 3.2);
      }
    }
    ctx.stroke();
    // Direction arrows down the middle lane.
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (const [x, dir] of [
      [-3.5, 1],
      [3.5, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x + dir * 0.9, 0);
      ctx.lineTo(x, -0.6);
      ctx.lineTo(x, -0.2);
      ctx.lineTo(x - dir * 0.9, -0.2);
      ctx.lineTo(x - dir * 0.9, 0.2);
      ctx.lineTo(x, 0.2);
      ctx.lineTo(x, 0.6);
      ctx.closePath();
      ctx.fill();
    }
  },
  solar(ctx) {
    // Rows of panels with cell grids.
    ctx.strokeStyle = INK;
    for (let y = -8; y <= 7; y += 2.4) {
      for (let x = -8; x <= 7; x += 3.3) {
        ctx.fillStyle = '#1c3266';
        ctx.lineWidth = 0.08;
        ctx.fillRect(x, y, 3, 2);
        ctx.strokeRect(x, y, 3, 2);
        ctx.strokeStyle = 'rgba(160,200,255,0.5)';
        ctx.lineWidth = 0.04;
        ctx.beginPath();
        for (let gx = 0.6; gx < 3; gx += 0.6) {
          ctx.moveTo(x + gx, y);
          ctx.lineTo(x + gx, y + 2);
        }
        ctx.moveTo(x, y + 1);
        ctx.lineTo(x + 3, y + 1);
        ctx.stroke();
        ctx.strokeStyle = INK;
      }
    }
  },
};

/** Paints the map's rooftop surface. Call inside the arena clip, scaled to the arena's size. */
export function paintSurface(ctx: CanvasRenderingContext2D, map: MapDef, time: number): void {
  ctx.save();
  painters[map.theme.surface](ctx, time);
  ctx.restore();
}

/** Lit office windows for building facades, sized in device pixels. */
const windowTiles = new WeakMap<CanvasRenderingContext2D, CanvasPattern>();
export function windowsPattern(ctx: CanvasRenderingContext2D, pxPerUnit: number): CanvasPattern | null {
  let pat = windowTiles.get(ctx);
  if (!pat) {
    const tile = document.createElement('canvas');
    tile.width = 12;
    tile.height = 10;
    const t = tile.getContext('2d');
    if (!t) return null;
    t.fillStyle = 'rgba(255,214,110,0.8)';
    t.fillRect(3, 3, 5, 4);
    t.fillStyle = 'rgba(27,16,48,0.5)';
    t.fillRect(3, 7, 5, 1);
    const p = ctx.createPattern(tile, 'repeat');
    if (!p) return null;
    pat = p;
    windowTiles.set(ctx, pat);
  }
  pat.setTransform(new DOMMatrix([1 / pxPerUnit, 0, 0, 1 / pxPerUnit, 0, 0]));
  return pat;
}
