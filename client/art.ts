// 2D art shared by the menus and the 3D scene: fonts and colours, arena
// outlines, map thumbnails for the lobby carousel, the rooftop surface
// texture, and the map spinner timing.

import * as C from '../shared/constants.js';
import { MAPS, MAP_DESIGN_RADIUS, polygonPoints, scaledBumpers, type MapDef } from '../shared/maps.js';
import { clamp } from '../shared/sim.js';
import type { PowerupKind } from '../shared/types.js';
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

/** Map spinner position (in maps travelled) during the map pick. Integer = a map is showing. */
export function carouselPosition(phaseTime: number, target: number): { pos: number; done: boolean } {
  const n = MAPS.length;
  const u = clamp(phaseTime / (C.MAP_PICK_TIME * 0.72), 0, 1);
  const e = 1 - Math.pow(1 - u, 3);
  const loops = Math.max(1, Math.round(24 / n));
  return { pos: e * (loops * n + target), done: u >= 1 };
}
