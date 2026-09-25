// Rooftop props: the blocks you climb (crates, AC units, water tanks, brick
// walls, concrete roofs and bridges, each with a sketchy hand-drawn
// texture), ramps, and the jump pads.
// Built at full arena size in three.js coordinates; the arena group scales
// them as the roof shrinks.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Block, MapDef, Ramp } from '../shared/maps.js';
import { INK } from './art.js';
import { OUTLINE, glowSprite, outlined, toon } from './toon.js';

/** Outlines are the shape grown by this much about its own centre, drawn inside out in ink. */
const OUTLINE_GROW = 1.02;

/**
 * Merges many static shapes of one look into a single mesh plus a single
 * outline mesh, so a map full of walls and floors costs two draw calls per
 * kind instead of two per piece.
 */
function merged(bodies: THREE.BufferGeometry[], outlines: THREE.BufferGeometry[], material: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  if (bodies.length === 0) return group;
  const body = new THREE.Mesh(mergeGeometries(bodies), material);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body, new THREE.Mesh(mergeGeometries(outlines), OUTLINE));
  for (const g of [...bodies, ...outlines]) g.dispose();
  return group;
}

type Kind = 'crate' | 'unit' | 'tank' | 'wall' | 'slab' | 'ramp';

function kindOf(b: Block): Kind {
  if ((b.z ?? 0) > 0) return 'slab';
  if (Math.min(b.w, b.d) / Math.max(b.w, b.d) < 0.4) return 'wall';
  if (b.h <= 1.2) return 'crate';
  if (b.h <= 2.5) return 'unit';
  return 'tank';
}

const KIND_COLOR: Record<Kind, string> = {
  crate: '#d49a5a',
  unit: '#a9b4cc',
  tank: '#7d8fb8',
  wall: '#c46a55',
  slab: '#b8b0cc',
  ramp: '#9aa3bf',
};

/** Seeded wobble, so each stroke looks drawn by hand but stays the same every frame. */
function wobbly(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

/** A pen line with a little wobble along it. */
function penLine(ctx: CanvasRenderingContext2D, rand: () => number, x0: number, y0: number, x1: number, y1: number, width: number): void {
  const steps = 6;
  ctx.lineWidth = width * (0.85 + rand() * 0.3);
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t + rand() * 3;
    const y = y0 + (y1 - y0) * t + rand() * 3;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

const textures = new Map<Kind, THREE.CanvasTexture>();
function blockTexture(kind: Kind): THREE.CanvasTexture {
  const cached = textures.get(kind);
  if (cached) return cached;
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  if (ctx) {
    const rand = wobbly(kind.length * 977);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = INK;
    ctx.lineCap = 'round';
    // Soft shading down one side, like a quick marker pass.
    const g = ctx.createLinearGradient(0, 0, size, 0);
    g.addColorStop(0, 'rgba(27,16,48,0)');
    g.addColorStop(1, 'rgba(27,16,48,0.14)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    switch (kind) {
      case 'crate':
        for (const k of [18, size - 18]) {
          penLine(ctx, rand, k, 10, k, size - 10, 6);
          penLine(ctx, rand, 10, k, size - 10, k, 6);
        }
        penLine(ctx, rand, 24, 24, size - 24, size - 24, 7);
        penLine(ctx, rand, size - 24, 24, 24, size - 24, 4);
        for (let y = 60; y < size - 30; y += 48) penLine(ctx, rand, 30, y, size - 30, y + 2, 1.5);
        break;
      case 'unit':
        penLine(ctx, rand, 12, 12, size - 12, 12, 5);
        penLine(ctx, rand, 12, size - 12, size - 12, size - 12, 5);
        for (let y = 36; y < size - 90; y += 14) penLine(ctx, rand, 30, y, size - 30, y, 3);
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(size / 2, size - 70, 42, 0, Math.PI * 2);
        ctx.stroke();
        for (let a = 0; a < 3; a++) {
          const ang = (a / 3) * Math.PI * 2;
          penLine(ctx, rand, size / 2, size - 70, size / 2 + Math.cos(ang) * 36, size - 70 + Math.sin(ang) * 36, 4);
        }
        break;
      case 'tank':
        for (let x = 20; x < size; x += 40) penLine(ctx, rand, x, 6, x + 2, size - 6, 3);
        for (const y of [30, size / 2, size - 30]) {
          penLine(ctx, rand, 4, y, size - 4, y, 6);
          ctx.fillStyle = INK;
          for (let x = 14; x < size; x += 28) {
            ctx.beginPath();
            ctx.arc(x, y - 9, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        break;
      case 'wall':
        for (let row = 0, y = 0; y < size; row++, y += 32) {
          penLine(ctx, rand, 0, y, size, y, 3);
          for (let x = row % 2 ? 32 : 0; x < size; x += 64) penLine(ctx, rand, x, y, x, y + 32, 3);
        }
        break;
      case 'slab':
        // Poured concrete: a border and a few form-board seams.
        penLine(ctx, rand, 8, 8, size - 8, 8, 5);
        penLine(ctx, rand, 8, size - 8, size - 8, size - 8, 5);
        for (let x = 64; x < size; x += 64) penLine(ctx, rand, x, 12, x + 2, size - 12, 2);
        break;
      case 'ramp':
        // Anti-slip treads.
        for (let y = 16; y < size; y += 26) penLine(ctx, rand, 10, y, size - 10, y, 4);
        break;
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  textures.set(kind, tex);
  return tex;
}

/** All the blocks on a map, at full arena size. S converts design units to metres. */
export function buildBlocks(map: MapDef, S: number): THREE.Group {
  const group = new THREE.Group();
  const byKind = new Map<Kind, { bodies: THREE.BufferGeometry[]; outlines: THREE.BufferGeometry[] }>();
  for (const b of map.blocks) {
    const kind = kindOf(b);
    const bottom = b.z ?? 0;
    const tall = b.h - bottom;
    const [x, y, z] = [b.x * S, bottom + tall / 2, -b.y * S];
    let lists = byKind.get(kind);
    if (!lists) byKind.set(kind, (lists = { bodies: [], outlines: [] }));
    lists.bodies.push(new THREE.BoxGeometry(b.w * S, tall, b.d * S).translate(x, y, z));
    lists.outlines.push(new THREE.BoxGeometry(b.w * S * OUTLINE_GROW, tall * OUTLINE_GROW, b.d * S * OUTLINE_GROW).translate(x, y, z));
  }
  for (const [kind, { bodies, outlines }] of byKind) group.add(merged(bodies, outlines, toon(KIND_COLOR[kind], blockTexture(kind))));
  return group;
}

/** A ramp: a box with its top tilted from its base (the roof, or an upper floor) up to its full height. */
function rampGeometry(r: Ramp, S: number): THREE.BufferGeometry {
  const W = r.w * S;
  const D = r.d * S;
  const base = r.z ?? 0;
  const rise = r.h - base;
  const geo = new THREE.BoxGeometry(W, rise, D).translate(0, base + rise / 2, 0);
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < base + rise / 2) continue;
    const x = pos.getX(i);
    const z = pos.getZ(i); // three.js z is -y in game coordinates
    const t =
      r.dir === 0 ? (x + W / 2) / W : r.dir === 2 ? 1 - (x + W / 2) / W : r.dir === 1 ? (-z + D / 2) / D : (z + D / 2) / D;
    pos.setY(i, Math.max(base + 0.02, base + rise * t));
  }
  geo.computeVertexNormals();
  return geo;
}

/** All the ramps on a map, at full arena size. */
export function buildRamps(map: MapDef, S: number): THREE.Group {
  const ramps = map.ramps ?? [];
  const bodies = ramps.map((r) => rampGeometry(r, S).translate(r.x * S, 0, -r.y * S));
  const outlines = ramps.map((r) => rampGeometry(r, S).scale(OUTLINE_GROW, OUTLINE_GROW, OUTLINE_GROW).translate(r.x * S, 0, -r.y * S));
  return merged(bodies, outlines, toon(KIND_COLOR.ramp, blockTexture('ramp')));
}

export interface Pads {
  group: THREE.Group;
  update(time: number): void;
}

function padTexture(): THREE.CanvasTexture {
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#12304a';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#00e1ff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 8;
    ctx.lineJoin = 'round';
    // Two chevrons pointing "up" (the texture is seen from above).
    for (const y of [60, 130]) {
      ctx.beginPath();
      ctx.moveTo(60, y + 60);
      ctx.lineTo(128, y);
      ctx.lineTo(196, y + 60);
      ctx.lineTo(196, y + 90);
      ctx.lineTo(128, y + 30);
      ctx.lineTo(60, y + 90);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Jump pads: a glowing disc with chevrons and rings that float up from it. */
export function buildPads(map: MapDef, S: number): Pads {
  const group = new THREE.Group();
  const rings: THREE.Mesh[] = [];
  const tex = padTexture();
  for (const p of map.pads) {
    const r = p.r * S;
    const pad = new THREE.Group();
    pad.position.set(p.x * S, 0, -p.y * S);
    const disc = outlined(new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.1, 0.16, 32), [toon('#1d4d73'), toon('#ffffff', tex), toon('#1d4d73')]), 1.03);
    disc.position.y = 0.08;
    disc.receiveShadow = true;
    pad.add(disc);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r, 0.07, 8, 40), new THREE.MeshBasicMaterial({ color: '#00e1ff' }));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.17;
    pad.add(rim);
    const glow = glowSprite('#00e1ff', r * 3);
    glow.position.y = 0.4;
    pad.add(glow);
    for (let k = 0; k < 2; k++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r * 0.9, 0.05, 6, 32),
        new THREE.MeshBasicMaterial({ color: '#7ff4ff', transparent: true, depthWrite: false }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.userData.phase = k * 0.5;
      pad.add(ring);
      rings.push(ring);
    }
    group.add(pad);
  }
  return {
    group,
    update(time: number): void {
      for (const ring of rings) {
        const t = (time * 0.9 + (ring.userData.phase as number)) % 1;
        ring.position.y = 0.2 + t * 2.4;
        ring.scale.setScalar(1 - t * 0.35);
        (ring.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.8;
      }
    },
  };
}
