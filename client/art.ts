// 2D art shared by the menus and the 3D scene: fonts and colours, arena
// outlines, map thumbnails for the lobby carousel, the rooftop surface
// texture, and weapon icons.

import * as C from '../shared/constants.js';
import { MAPS, MAP_DESIGN_RADIUS, polygonPoints, scaledBumpers, type MapDef } from '../shared/maps.js';
import type { PowerupKind } from '../shared/types.js';
import { WEAPONS } from '../shared/weapons.js';
import { paintSurface } from './surfaces.js';

export const INK = '#1b1030';
export const FONT = '"Arial Black", "Arial Rounded MT Bold", "Helvetica Neue", Helvetica, system-ui, sans-serif';

export const POWERUP_STYLE: Record<PowerupKind, { color: string; label: string }> = {
  rapid: { color: '#ffd93d', label: 'RAPID FIRE' },
  triple: { color: '#3ccf6e', label: 'TRIPLE SHOT' },
  mega: { color: '#ff8a3d', label: 'MEGA SHOT' },
  shield: { color: '#7fd8ff', label: 'SHIELD' },
  heal: { color: '#ff6fc1', label: 'HEAL' },
};

/** Arena outline as a polygon (counter-clockwise), in the same units as R. */
export function arenaOutline(map: MapDef, R: number, segments = 72): [number, number][] {
  if (map.shape === 'circle') {
    const pts: [number, number][] = [];
    for (let k = 0; k < segments; k++) {
      const a = (k / segments) * Math.PI * 2;
      pts.push([Math.cos(a) * R, Math.sin(a) * R]);
    }
    return pts;
  }
  if (map.shape === 'square') {
    const h = R * C.SQUARE_HALF_SCALE;
    return [
      [-h, -h],
      [h, -h],
      [h, h],
      [-h, h],
    ];
  }
  return polygonPoints(map.shape, R);
}

function tracePolygon(ctx: CanvasRenderingContext2D, pts: [number, number][]): void {
  pts.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

/**
 * The rooftop's top surface (colour and markings) in design units, painted
 * over [-10, 10] on both axes. Canvas rows run along +y.
 */
export function makeSurfaceCanvas(map: MapDef, px: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = px;
  cv.height = px;
  const ctx = cv.getContext('2d');
  if (!ctx) return cv;
  const k = px / 20;
  ctx.setTransform(k, 0, 0, k, px / 2, px / 2);
  ctx.fillStyle = map.theme.top;
  ctx.fillRect(-10, -10, 20, 20);
  // A soft shaded band near the edge, like the 2D game's slab shading.
  ctx.save();
  ctx.beginPath();
  tracePolygon(ctx, arenaOutline(map, MAP_DESIGN_RADIUS * 1.2));
  tracePolygon(ctx, arenaOutline(map, MAP_DESIGN_RADIUS * 0.93).reverse());
  ctx.fillStyle = map.theme.shade;
  ctx.globalAlpha = 0.55;
  ctx.fill();
  ctx.restore();
  paintSurface(ctx, map, 0);
  return cv;
}

/** Top-down picture of a map for the lobby carousel. */
export function makeMapThumb(index: number, px: number): HTMLCanvasElement {
  const map = MAPS[index] ?? MAPS[0];
  const cv = document.createElement('canvas');
  cv.width = px;
  cv.height = px;
  const ctx = cv.getContext('2d');
  if (!ctx) return cv;
  ctx.fillStyle = '#261c66';
  ctx.fillRect(0, 0, px, px);
  const R = MAP_DESIGN_RADIUS;
  const k = px / (2 * (R + 1.4));
  ctx.setTransform(k, 0, 0, k, px / 2, px / 2);
  const outline = arenaOutline(map, R);

  // Drop shadow and building side.
  ctx.fillStyle = 'rgba(12,2,30,0.55)';
  ctx.beginPath();
  tracePolygon(ctx, outline.map(([x, y]) => [x + 0.5, y + 1.2]));
  ctx.fill();
  ctx.fillStyle = map.theme.side;
  ctx.beginPath();
  tracePolygon(ctx, outline.map(([x, y]) => [x, y + 0.5]));
  ctx.fill();

  // Roof surface, clipped to the outline, with holes punched out.
  ctx.save();
  ctx.beginPath();
  tracePolygon(ctx, outline);
  ctx.clip();
  ctx.fillStyle = map.theme.top;
  ctx.fillRect(-R * 1.5, -R * 1.5, R * 3, R * 3);
  paintSurface(ctx, map, 0);
  ctx.fillStyle = '#140e38';
  for (const h of map.holes) {
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.lineJoin = 'round';
  ctx.strokeStyle = INK;
  ctx.lineWidth = 0.18;
  ctx.beginPath();
  tracePolygon(ctx, outline);
  ctx.stroke();
  for (const b of scaledBumpers(map, R)) {
    ctx.fillStyle = map.theme.bumper;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  return cv;
}

/**
 * A weapon's silhouette, drawn like an ink sketch: flat colour, a thick
 * outline, and an off-register colour ghost.
 */
export function makeWeaponIcon(index: number, w: number, h: number): HTMLCanvasElement {
  const def = WEAPONS[index] ?? WEAPONS[0];
  const cv = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = w * dpr;
  cv.height = h * dpr;
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  const ctx = cv.getContext('2d');
  if (!ctx) return cv;
  ctx.scale((w * dpr) / 100, (h * dpr) / 50);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Shapes in a 100 x 50 box, gun pointing right.
  type Shape = [number, number, number, number, number];
  const parts: Record<number, { body: Shape[]; accent: Shape[] }> = {
    0: {
      body: [[14, 16, 52, 16, 6], [58, 20, 30, 8, 3], [22, 28, 14, 16, 4]],
      accent: [[40, 13, 5, 22, 2], [48, 13, 5, 22, 2]],
    },
    1: {
      body: [[8, 18, 62, 14, 5], [60, 16, 34, 7, 3], [60, 25, 34, 7, 3], [14, 28, 16, 16, 4]],
      accent: [[36, 14, 14, 22, 3]],
    },
    2: {
      body: [[6, 20, 46, 12, 5], [48, 22, 48, 6, 2], [18, 30, 12, 14, 4]],
      accent: [[24, 11, 22, 8, 3], [74, 20, 4, 10, 1]],
    },
    3: {
      body: [[10, 12, 64, 24, 12], [70, 15, 18, 18, 5], [24, 32, 12, 14, 4]],
      accent: [[30, 10, 6, 28, 2], [48, 10, 6, 28, 2]],
    },
    4: {
      body: [[16, 18, 46, 13, 4], [58, 21, 32, 6, 2], [26, 29, 11, 15, 3], [44, 29, 8, 16, 2]],
      accent: [[20, 14, 26, 5, 2]],
    },
  };
  const { body, accent } = parts[index] ?? parts[0];
  const rr = (x: number, y: number, bw: number, bh: number, r: number): void => {
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, r);
  };
  // Off-register ghost, then ink, then fill.
  ctx.fillStyle = def.accent;
  ctx.globalAlpha = 0.45;
  for (const [x, y, bw, bh, r] of body) {
    rr(x + 3, y + 3, bw, bh, r);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (const [x, y, bw, bh, r] of body) {
    rr(x, y, bw, bh, r);
    ctx.fillStyle = '#3b3070';
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3.2;
    ctx.stroke();
  }
  for (const [x, y, bw, bh, r] of accent) {
    rr(x, y, bw, bh, r);
    ctx.fillStyle = def.accent;
    ctx.fill();
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }
  // A highlight stroke, like a quick pen flick.
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 2;
  const [bx, by, bw] = body[0];
  ctx.beginPath();
  ctx.moveTo(bx + 5, by + 4);
  ctx.lineTo(bx + bw * 0.55, by + 4);
  ctx.stroke();
  return cv;
}

