// The player character: a chunky cartoon trooper built from simple shapes
// with ink outlines. A helmet with a glowing visor, a rounded torso with a
// belt, a chest badge and a backpack, and two legs with boots. The arms and
// the gun are added by the scene (they follow the aim).
//
// Feet are at y = 0 and the model faces -z. It stands about 1.9 m tall,
// matching the 1.8 m capsule the simulation uses for hits.

import * as THREE from 'three';
import { INK } from './art.js';
import { TOON, outlined, toon } from './toon.js';

export interface Character {
  root: THREE.Group;
  /** Everything above the hips: leans into slides and bobs with the walk. */
  upper: THREE.Group;
  head: THREE.Group;
  legs: [THREE.Group, THREE.Group];
  /** Where the gun pivot goes, in `upper` space (chest height). */
  chest: THREE.Vector3;
  /** Materials that flash white when this player is hit. */
  flashMats: THREE.MeshToonMaterial[];
  /** Walk cycle phase, and a smoothed estimate of speed from movement. */
  phase: number;
  speed: number;
  prev: THREE.Vector3 | null;
}

const HIPS = 0.82;

function mat(color: THREE.ColorRepresentation): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: TOON, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0 });
}

export function makeCharacter(color: string): Character {
  const main = new THREE.Color(color);
  const suit = mat(main);
  const pants = mat(main.clone().lerp(new THREE.Color(INK), 0.45));
  const helmet = mat(main.clone().lerp(new THREE.Color('#ffffff'), 0.18));
  const dark = toon('#2b2250');
  const cream = toon('#fff6e0');

  const root = new THREE.Group();

  // Legs: pivot at the hips so they swing.
  const legs: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(side * 0.15, HIPS, 0);
    const thigh = outlined(new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.5, 4, 12), pants), 1.08);
    thigh.position.y = -0.37;
    thigh.castShadow = true;
    leg.add(thigh);
    const boot = outlined(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.13, 0.3), dark), 1.08);
    boot.position.set(0, -0.76, -0.05);
    boot.castShadow = true;
    leg.add(boot);
    root.add(leg);
    legs.push(leg);
  }

  // Upper body, pivoting at the hips.
  const upper = new THREE.Group();
  upper.position.y = HIPS;
  root.add(upper);

  const torso = outlined(new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.26, 6, 16), suit), 1.05);
  torso.position.y = 0.36;
  torso.scale.set(1.05, 1, 0.85);
  torso.castShadow = true;
  upper.add(torso);
  // Belt and buckle.
  const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.315, 0.315, 0.07, 20), dark);
  belt.scale.set(1.05, 1, 0.85);
  belt.position.y = 0.1;
  upper.add(belt);
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.04), cream);
  buckle.position.set(0, 0.1, -0.27);
  upper.add(buckle);
  // Chest badge: a round emblem with a ring.
  const badge = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.03, 18), cream), 1.15);
  badge.rotation.x = Math.PI / 2;
  badge.position.set(0.12, 0.45, -0.27);
  upper.add(badge);
  // Backpack.
  const pack = outlined(new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.42, 0.18), pants), 1.06);
  pack.position.set(0, 0.4, 0.3);
  pack.castShadow = true;
  upper.add(pack);
  const flap = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.02), cream);
  flap.position.set(0, 0.52, 0.4);
  upper.add(flap);

  // Head: a round helmet with a glowing visor and ear pads.
  const head = new THREE.Group();
  head.position.y = 0.84;
  upper.add(head);
  const dome = outlined(new THREE.Mesh(new THREE.SphereGeometry(0.27, 20, 16), helmet), 1.06);
  dome.castShadow = true;
  head.add(dome);
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.15, 0.12),
    new THREE.MeshStandardMaterial({ color: INK, emissive: new THREE.Color('#00e1ff'), emissiveIntensity: 0.75, roughness: 0.2 }),
  );
  visor.position.set(0, 0.02, -0.21);
  head.add(outlined(visor, 1.08));
  for (const side of [-1, 1]) {
    const ear = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.07, 14), dark), 1.1);
    ear.rotation.z = Math.PI / 2;
    ear.position.set(side * 0.27, 0, 0.02);
    head.add(ear);
  }
  // A little stripe over the top of the helmet.
  const stripe = new THREE.Mesh(new THREE.TorusGeometry(0.272, 0.03, 6, 24, Math.PI), cream);
  stripe.rotation.y = Math.PI / 2;
  head.add(stripe);

  return {
    root,
    upper,
    head,
    legs: [legs[0], legs[1]],
    chest: new THREE.Vector3(0, 0.46, 0),
    flashMats: [suit, pants, helmet],
    phase: 0,
    speed: 0,
    prev: null,
  };
}

/**
 * Animates a character: a walk cycle from how fast it's moving, legs tucked
 * in the air, legs out front in a slide, and the head following the aim.
 */
export function animateCharacter(c: Character, dt: number, pos: THREE.Vector3, grounded: boolean, sliding: boolean, pitch: number): void {
  // Speed from how far the model moved (other players are interpolated, so this is smooth).
  if (c.prev && dt > 0) {
    const flat = Math.hypot(pos.x - c.prev.x, pos.z - c.prev.z) / dt;
    c.speed += (Math.min(flat, 20) - c.speed) * Math.min(1, dt * 10);
  }
  c.prev = (c.prev ?? new THREE.Vector3()).copy(pos);

  const [l, r] = c.legs;
  let swing = 0;
  if (sliding) {
    l.rotation.x = r.rotation.x = -1.25;
  } else if (!grounded) {
    // A tucked jump pose.
    l.rotation.x += (-0.7 - l.rotation.x) * Math.min(1, dt * 12);
    r.rotation.x += (0.35 - r.rotation.x) * Math.min(1, dt * 12);
  } else {
    // Walk: stride length grows with speed; cadence too.
    if (c.speed > 0.4) c.phase += dt * (4 + c.speed * 0.9);
    const amp = Math.min(0.75, c.speed * 0.09);
    swing = Math.sin(c.phase) * amp;
    l.rotation.x += (swing - l.rotation.x) * Math.min(1, dt * 20);
    r.rotation.x += (-swing - r.rotation.x) * Math.min(1, dt * 20);
  }
  // A small bob with each step, and a lean into the run.
  c.upper.position.y = HIPS + Math.abs(Math.sin(c.phase)) * 0.035 * Math.min(1, c.speed / 6) * (grounded && !sliding ? 1 : 0);
  c.head.rotation.x = pitch * 0.45;
}

/** Hit flash: the suit flashes white. */
export function flashCharacter(c: Character, on: boolean): void {
  for (const m of c.flashMats) m.emissiveIntensity = on ? 0.8 : 0;
}
