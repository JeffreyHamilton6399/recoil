// Shared toon materials: the cel-shading ramp, the inverted-hull ink
// outline, and a soft glow sprite texture.

import * as THREE from 'three';
import { INK } from './art.js';

/** Three-step ramp for cel shading. */
function toonRamp(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([70, 160, 255]), 3, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
export const TOON = toonRamp();

/** Inverted-hull ink outline, shared by everything. */
export const OUTLINE = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });

export function toon(color: THREE.ColorRepresentation, map?: THREE.Texture): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: TOON, map: map ?? null });
}

/** Adds a slightly larger back-face copy of a mesh in ink: a thick drawn outline. */
export function outlined<T extends THREE.Mesh>(mesh: T, thickness = 1.06): T {
  const o = new THREE.Mesh(mesh.geometry, OUTLINE);
  o.scale.setScalar(thickness);
  mesh.add(o);
  return mesh;
}

function glowTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 64;
  const ctx = cv.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
export const GLOW = glowTexture();

export function glowSprite(color: THREE.ColorRepresentation, size: number): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.setScalar(size);
  return s;
}

/** Disposes geometries, materials and their textures under a node (shared resources are kept). */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    for (const m of mats) {
      if (m === OUTLINE) continue;
      for (const v of Object.values(m)) if (v instanceof THREE.Texture && v !== TOON && v !== GLOW) v.dispose();
      m.dispose();
    }
  });
}
