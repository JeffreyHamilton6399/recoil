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
  /** Holds the legs; turns towards the way you're moving, so strafing side-steps. */
  hips: THREE.Group;
  /** Everything above the hips: leans into slides and bobs with the walk. */
  upper: THREE.Group;
  head: THREE.Group;
  legs: [THREE.Group, THREE.Group];
  /** Where the gun pivot goes, in `upper` space (chest height). */
  chest: THREE.Vector3;
  /** Materials that flash white when this player is hit. */
  flashMats: THREE.MeshToonMaterial[];
  /** Walk cycle phase, and a smoothed estimate of speed and direction from movement. */
  phase: number;
  speed: number;
  vx: number;
  vz: number;
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
  const hips = new THREE.Group();
  root.add(hips);

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
    hips.add(leg);
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
    hips,
    upper,
    head,
    legs: [legs[0], legs[1]],
    chest: new THREE.Vector3(0, 0.46, 0),
    flashMats: [suit, pants, helmet],
    phase: 0,
    speed: 0,
    vx: 0,
    vz: 0,
    prev: null,
  };
}

/** Moves a value towards a target by a fraction per second. */
function ease(v: number, target: number, rate: number, dt: number): number {
  return v + (target - v) * Math.min(1, dt * rate);
}

/**
 * Animates a character from how it's moving:
 *  - walking: the legs stride in the direction of travel. The hips turn
 *    towards it, so strafing side-steps and backing up backpedals, and the
 *    body leans into the strafe.
 *  - in the air: a tucked jump pose.
 *  - sliding: low to the ground, lead leg out straight, back leg tucked.
 * `facing` is the model's yaw (its rotation.y); the head follows the aim.
 */
export function animateCharacter(c: Character, dt: number, pos: THREE.Vector3, facing: number, grounded: boolean, sliding: boolean, pitch: number): void {
  // Velocity from how far the model moved (other players are interpolated, so this is smooth).
  if (c.prev && dt > 0) {
    const vx = (pos.x - c.prev.x) / dt;
    const vz = (pos.z - c.prev.z) / dt;
    const k = Math.min(1, dt * 10);
    c.vx += (Math.max(-20, Math.min(20, vx)) - c.vx) * k;
    c.vz += (Math.max(-20, Math.min(20, vz)) - c.vz) * k;
    c.speed = Math.hypot(c.vx, c.vz);
  }
  c.prev = (c.prev ?? new THREE.Vector3()).copy(pos);

  // Movement relative to where the model faces (it looks down -z, turned by `facing`).
  const fx = -Math.sin(facing);
  const fz = -Math.cos(facing);
  const along = c.vx * fx + c.vz * fz;
  const side = c.vx * -fz + c.vz * fx; // + is to the model's right
  const moving = c.speed > 0.6;

  const [l, r] = c.legs;
  if (sliding) {
    // Slide: drop low, lead leg straight out, back leg folded under.
    c.root.position.y = ease(c.root.position.y, -0.32, 16, dt);
    c.hips.rotation.y = ease(c.hips.rotation.y, 0.25, 12, dt);
    l.rotation.x = ease(l.rotation.x, -1.5, 18, dt);
    r.rotation.x = ease(r.rotation.x, -0.55, 18, dt);
    l.rotation.z = ease(l.rotation.z, 0, 18, dt);
    r.rotation.z = ease(r.rotation.z, 0.25, 18, dt);
    c.upper.rotation.z = ease(c.upper.rotation.z, 0.12, 10, dt);
  } else {
    c.root.position.y = ease(c.root.position.y, 0, 12, dt);
    l.rotation.z = ease(l.rotation.z, 0, 12, dt);
    r.rotation.z = ease(r.rotation.z, 0, 12, dt);
    if (!grounded) {
      // A tucked jump pose.
      l.rotation.x = ease(l.rotation.x, -0.7, 12, dt);
      r.rotation.x = ease(r.rotation.x, 0.35, 12, dt);
      c.hips.rotation.y = ease(c.hips.rotation.y, 0, 8, dt);
    } else {
      // Which way the legs point: the travel direction, flipped when backing up
      // (then the stride runs backwards: a backpedal).
      let angle = moving ? Math.atan2(side, along) : 0;
      let dir = 1;
      if (angle > Math.PI * 0.6) {
        angle -= Math.PI;
        dir = -1;
      } else if (angle < -Math.PI * 0.6) {
        angle += Math.PI;
        dir = -1;
      }
      c.hips.rotation.y = ease(c.hips.rotation.y, -Math.max(-1.2, Math.min(1.2, angle)), 10, dt);
      // Stride length and cadence grow with speed.
      if (moving) c.phase += dt * (4 + c.speed * 0.9) * dir;
      const amp = Math.min(0.75, c.speed * 0.09);
      const swing = Math.sin(c.phase) * amp;
      l.rotation.x = ease(l.rotation.x, swing, 20, dt);
      r.rotation.x = ease(r.rotation.x, -swing, 20, dt);
    }
    // Lean into strafes and runs.
    c.upper.rotation.z = ease(c.upper.rotation.z, grounded ? -Math.max(-1, Math.min(1, side / 8)) * 0.14 : 0, 8, dt);
  }
  // A small bob with each step.
  const bob = grounded && !sliding ? Math.abs(Math.sin(c.phase)) * 0.035 * Math.min(1, c.speed / 6) : 0;
  c.upper.position.y = HIPS + bob;
  c.head.rotation.x = pitch * 0.45;
}

/** Hit flash: the suit flashes white. */
export function flashCharacter(c: Character, on: boolean): void {
  for (const m of c.flashMats) m.emissiveIntensity = on ? 0.8 : 0;
}
