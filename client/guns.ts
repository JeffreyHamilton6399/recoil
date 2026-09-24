// Gun models, one per weapon, built from simple shapes with ink outlines,
// and the arms that hold them. The same model is used in your hands (first
// person) and in everyone else's. Guns point down -z, with the grip at the
// origin.

import * as THREE from 'three';
import { weaponDef } from '../shared/weapons.js';
import { glowSprite, outlined, toon } from './toon.js';

export interface Gun {
  group: THREE.Group;
  /** Sits at the barrel's tip; used for muzzle flashes and the charge glow. */
  muzzle: THREE.Sprite;
  /** Parts tinted with the player's colour. */
  tinted: THREE.MeshToonMaterial;
  /** Where the right hand holds the grip and the left hand holds the front, in gun space. */
  grip: THREE.Vector3;
  fore: THREE.Vector3;
}

const BODY = '#3b3070';
const DARK = '#241c48';

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = outlined(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat), 1.1);
  m.position.set(x, y, z);
  return m;
}

function tube(r: number, len: number, mat: THREE.Material, x = 0, y = 0, z = 0, r2 = r): THREE.Mesh {
  const m = outlined(new THREE.Mesh(new THREE.CylinderGeometry(r, r2, len, 16), mat), 1.12);
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

function ring(r: number, thick: number, mat: THREE.Material, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.TorusGeometry(r, thick, 8, 24), mat);
  m.position.z = z;
  return m;
}

export function makeGun(weapon: number, color: string): Gun {
  const def = weaponDef(weapon);
  const group = new THREE.Group();
  const body = toon(BODY);
  const dark = toon(DARK);
  const tinted = toon(color);
  const accent = new THREE.MeshBasicMaterial({ color: def.accent });
  let tip = -0.6;
  const grip = new THREE.Vector3(0, -0.14, 0.08);
  const fore = new THREE.Vector3(0, -0.06, -0.34);

  switch (weapon) {
    case 1: // Scatter: a stubby double-barrel with a pump.
      group.add(box(0.16, 0.17, 0.42, body, 0, 0, -0.1));
      group.add(tube(0.045, 0.42, dark, -0.045, 0.02, -0.5));
      group.add(tube(0.045, 0.42, dark, 0.045, 0.02, -0.5));
      group.add(box(0.2, 0.09, 0.18, tinted, 0, -0.07, -0.42));
      group.add(box(0.1, 0.18, 0.12, dark, 0, -0.13, 0.08));
      group.add(ring(0.11, 0.018, accent, -0.24));
      fore.set(0, -0.1, -0.42);
      tip = -0.72;
      break;
    case 2: // Longshot: long barrel, scope, stock.
      group.add(box(0.12, 0.14, 0.5, body, 0, 0, -0.05));
      group.add(tube(0.03, 0.75, dark, 0, 0.02, -0.65));
      group.add(tube(0.05, 0.28, tinted, 0, 0.13, -0.12));
      group.add(box(0.1, 0.16, 0.22, dark, 0, -0.04, 0.3));
      group.add(ring(0.055, 0.012, accent, -0.8));
      group.add(ring(0.055, 0.012, accent, -0.6));
      grip.set(0, -0.12, 0.05);
      fore.set(0, -0.04, -0.45);
      tip = -1.03;
      break;
    case 3: // Boomer: a fat launcher tube with a flared mouth.
      group.add(tube(0.12, 0.62, tinted, 0, 0.03, -0.25));
      group.add(tube(0.15, 0.12, dark, 0, 0.03, -0.6, 0.12));
      group.add(box(0.1, 0.2, 0.14, dark, 0, -0.14, 0));
      group.add(ring(0.125, 0.025, accent, -0.1));
      group.add(ring(0.125, 0.025, accent, -0.35));
      grip.set(0, -0.16, 0);
      fore.set(0, -0.1, -0.32);
      tip = -0.68;
      break;
    case 4: {
      // Pepper: compact, short barrel, drum magazine.
      group.add(box(0.13, 0.14, 0.4, body, 0, 0, -0.08));
      group.add(tube(0.035, 0.22, dark, 0, 0.02, -0.38));
      const drum = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 18), tinted), 1.1);
      drum.rotation.z = Math.PI / 2;
      drum.position.set(0, -0.12, -0.12);
      group.add(drum);
      group.add(box(0.08, 0.16, 0.1, dark, 0, -0.12, 0.08));
      group.add(box(0.14, 0.03, 0.3, accent, 0, 0.085, -0.08));
      fore.set(0, -0.07, -0.3);
      tip = -0.5;
      break;
    }
    default: // Blaster: sleek body, barrel, glowing coils.
      group.add(box(0.13, 0.15, 0.5, body, 0, 0, -0.08));
      group.add(tube(0.045, 0.34, dark, 0, 0.02, -0.46, 0.055));
      group.add(box(0.1, 0.17, 0.12, tinted, 0, -0.12, 0.08));
      for (const z of [-0.2, -0.06, 0.08]) group.add(ring(0.085, 0.016, accent, z));
      tip = -0.66;
      break;
  }

  const muzzle = glowSprite(color, 0.1);
  muzzle.position.set(0, 0.02, tip);
  group.add(muzzle);
  return { group, muzzle, tinted, grip, fore };
}

// ---------------------------------------------------------------------------
// Arms: a sleeve in the player's colour and a round cartoon glove.
// ---------------------------------------------------------------------------

const GLOVE = '#fff6e0';

/** A limb from a to b: a tapered tube with an ink outline. */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, mat: THREE.Material): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const m = outlined(new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 12), mat), 1.1);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

/**
 * Two arms reaching from the shoulders to the hands. Everything is in the
 * same space as the points given, so the arms move with whatever holds them.
 */
export function makeArms(
  color: string,
  shoulders: [THREE.Vector3, THREE.Vector3],
  hands: [THREE.Vector3, THREE.Vector3],
  thickness = 1,
): THREE.Group {
  const group = new THREE.Group();
  const sleeve = toon(color);
  const glove = toon(GLOVE);
  const cuff = toon('#3b3070');
  for (let i = 0; i < 2; i++) {
    const s = shoulders[i];
    const h = hands[i];
    // A little elbow: bend the arm outwards and down between shoulder and hand.
    const elbow = new THREE.Vector3().lerpVectors(s, h, 0.5);
    elbow.x += (i === 0 ? 1 : -1) * 0.08 * thickness;
    elbow.y -= 0.1 * thickness;
    group.add(limb(s, elbow, 0.075 * thickness, 0.07 * thickness, sleeve));
    group.add(limb(elbow, h, 0.07 * thickness, 0.06 * thickness, sleeve));
    const ball = outlined(new THREE.Mesh(new THREE.SphereGeometry(0.075 * thickness, 12, 10), sleeve), 1.12);
    ball.position.copy(elbow);
    group.add(ball);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.066 * thickness, 0.018 * thickness, 6, 16), cuff);
    band.position.copy(h).lerp(elbow, 0.18);
    band.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3().subVectors(elbow, h).normalize());
    group.add(band);
    const hand = outlined(new THREE.Mesh(new THREE.SphereGeometry(0.085 * thickness, 14, 12), glove), 1.12);
    hand.scale.set(1, 0.85, 1.15);
    hand.position.copy(h);
    group.add(hand);
  }
  return group;
}
