// The 3D world, drawn with three.js: a city at dusk, the tower whose roof is
// the arena (it shrinks with the arena), bumper pillars, players, bullets,
// power-ups, particles, comic words and the first-person gun.
//
// Simulation coordinates are x, y horizontal and z up. three.js uses y up,
// so a sim point (x, y, z) is drawn at (x, z, -y), which keeps handedness.

import * as THREE from 'three';
import * as C from '../shared/constants.js';
import { MAPS, mapScale, scaledBumpers, type MapDef } from '../shared/maps.js';
import { clamp } from '../shared/sim.js';
import { FX_SHIELD, type GameEvent, type PlayerId, type PowerupKind, type RosterEntry } from '../shared/types.js';
import { FONT, INK, POWERUP_STYLE, arenaOutline, makeSurfaceCanvas } from './art.js';

// ---------------------------------------------------------------------------
// View types (what main.ts hands the renderer each frame)
// ---------------------------------------------------------------------------

export interface ViewPlayer {
  id: PlayerId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  charge: number;
  damage: number;
  /** Seconds since falling, or -1 while standing. */
  fallTime: number;
  fx: number;
}

export interface ViewBullet {
  id: number;
  owner: PlayerId;
  x: number;
  y: number;
  z: number;
  r: number;
  vx: number;
  vy: number;
  vz: number;
}

export interface ViewPowerup {
  id: number;
  kind: PowerupKind;
  x: number;
  y: number;
  age: number;
}

export interface View {
  phase: 'lobby' | 'mapPick' | 'countdown' | 'playing' | 'roundEnd' | 'matchEnd';
  phaseTime: number;
  arenaRadius: number;
  mapIndex: number;
  shrinking: boolean;
  players: ViewPlayer[];
  bullets: ViewBullet[];
  powerups: ViewPowerup[];
  roster: RosterEntry[];
  myId: PlayerId | -1;
}

/** Where the camera is: your own eyes, or circling the roof. */
export type CameraView =
  | { kind: 'first'; x: number; y: number; z: number; yaw: number; pitch: number; speed: number; grounded: boolean; charge: number }
  | { kind: 'orbit' };

// ---------------------------------------------------------------------------
// Constants and shared resources
// ---------------------------------------------------------------------------

/** How far the tower drops to the street. */
const TOWER_DEPTH = 90;
const SKY_TOP = new THREE.Color('#1a1446');
const SKY_MID = new THREE.Color('#5b3a8c');
const SKY_HORIZON = new THREE.Color('#ff9a86');
const FOG = new THREE.Color('#9a5a8e');
const SUN_DIR = new THREE.Vector3(-0.75, 0.22, 0.62).normalize();
const WORDS = ['POW!', 'BAM!', 'WHAM!', 'KA-POW!', 'BOOM!', 'SMASH!', 'THWACK!'];

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function toThree(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, z, -y);
}

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

/** Three-step ramp for cel shading. */
function toonRamp(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([70, 160, 255]), 3, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
const TOON = toonRamp();
/** Inverted-hull ink outline. */
const OUTLINE = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });

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
const GLOW = glowTexture();

/** Office windows: a wall texture (white walls, dark frames) and a glow texture (lit windows). */
function windowTextures(seed: number, cols: number, rows: number): { wall: THREE.CanvasTexture; glow: THREE.CanvasTexture } {
  const rand = prng(seed);
  const cell = 16;
  const make = (): [HTMLCanvasElement, CanvasRenderingContext2D | null] => {
    const cv = document.createElement('canvas');
    cv.width = cols * cell;
    cv.height = rows * cell;
    return [cv, cv.getContext('2d')];
  };
  const [wallCv, wall] = make();
  const [glowCv, glow] = make();
  if (wall && glow) {
    wall.fillStyle = '#ffffff';
    wall.fillRect(0, 0, wallCv.width, wallCv.height);
    glow.fillStyle = '#000000';
    glow.fillRect(0, 0, glowCv.width, glowCv.height);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = c * cell + 4;
        const y = r * cell + 4;
        wall.fillStyle = '#6b6488';
        wall.fillRect(x - 1, y - 1, 10, 9);
        const lit = rand() < 0.45;
        const warm = rand() < 0.8;
        wall.fillStyle = lit ? (warm ? '#ffe7a8' : '#bfe8ff') : '#2a2446';
        wall.fillRect(x, y, 8, 7);
        if (lit) {
          glow.fillStyle = warm ? `rgba(255,200,110,${0.6 + rand() * 0.4})` : 'rgba(150,220,255,0.8)';
          glow.fillRect(x, y, 8, 7);
        }
      }
    }
  }
  const finish = (cv: HTMLCanvasElement): THREE.CanvasTexture => {
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.anisotropy = 4;
    return tex;
  };
  return { wall: finish(wallCv), glow: finish(glowCv) };
}

function streetTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 256;
  const ctx = cv.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#2c2345';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#1b1530';
    ctx.fillRect(0, 0, 256, 44);
    ctx.fillRect(0, 0, 44, 256);
    ctx.fillStyle = '#ffd93d';
    for (let k = 60; k < 256; k += 36) {
      ctx.fillRect(k, 20, 18, 3);
      ctx.fillRect(20, k, 3, 18);
    }
    ctx.fillStyle = 'rgba(255,220,150,0.5)';
    for (let k = 52; k < 256; k += 48) {
      ctx.beginPath();
      ctx.arc(k, 48, 3, 0, Math.PI * 2);
      ctx.arc(48, k, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function disposeTree(root: THREE.Object3D): void {
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

function outlined(mesh: THREE.Mesh, thickness = 1.06): THREE.Mesh {
  const o = new THREE.Mesh(mesh.geometry, OUTLINE);
  o.scale.setScalar(thickness);
  mesh.add(o);
  return mesh;
}

// ---------------------------------------------------------------------------
// Text sprites (name tags and comic words)
// ---------------------------------------------------------------------------

function textCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return [cv, cv.getContext('2d')];
}

const wordTextures = new Map<string, THREE.CanvasTexture>();
function wordTexture(word: string): THREE.CanvasTexture {
  let tex = wordTextures.get(word);
  if (tex) return tex;
  const [cv, ctx] = textCanvas(512, 192);
  if (ctx) {
    ctx.font = `900 112px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 22;
    ctx.strokeStyle = INK;
    // Off-register cyan and magenta, like cheap comic printing.
    ctx.fillStyle = '#00e1ff';
    ctx.fillText(word, 262, 100);
    ctx.fillStyle = '#ff2e88';
    ctx.fillText(word, 250, 92);
    ctx.strokeText(word, 256, 96);
    ctx.fillStyle = '#ffd93d';
    ctx.fillText(word, 256, 96);
  }
  tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  wordTextures.set(word, tex);
  return tex;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

interface Rig {
  group: THREE.Group;
  body: THREE.Mesh;
  bodyMat: THREE.MeshToonMaterial;
  gunPivot: THREE.Group;
  muzzleMat: THREE.MeshBasicMaterial;
  shield: THREE.Mesh;
  label: THREE.Sprite;
  labelCtx: CanvasRenderingContext2D | null;
  labelTex: THREE.CanvasTexture;
  labelText: string;
  color: string;
  flash: number;
}

function makeRig(color: string): Rig {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshToonMaterial({ color, gradientMap: TOON, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0 });
  const body = outlined(new THREE.Mesh(new THREE.CapsuleGeometry(C.PLAYER_RADIUS, C.PLAYER_HEIGHT - C.PLAYER_RADIUS * 2, 6, 16), bodyMat));
  body.position.y = C.PLAYER_HEIGHT / 2;
  body.castShadow = true;
  group.add(body);

  // Visor, facing -z (the rig's forward).
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.2, 0.3),
    new THREE.MeshStandardMaterial({ color: INK, emissive: new THREE.Color('#00e1ff'), emissiveIntensity: 0.7, roughness: 0.2 }),
  );
  visor.position.set(0, C.EYE_HEIGHT - C.PLAYER_HEIGHT / 2, -0.3);
  body.add(visor);

  // Gun on the right shoulder, pitched with the aim.
  const gunPivot = new THREE.Group();
  gunPivot.position.set(0.42, 1.2, -0.05);
  const gunMat = new THREE.MeshToonMaterial({ color: '#2b2250', gradientMap: TOON });
  const gun = outlined(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.7), gunMat), 1.12);
  gun.position.z = -0.3;
  gunPivot.add(gun);
  const muzzleMat = new THREE.MeshBasicMaterial({ color });
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.14, 12), muzzleMat);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.z = -0.68;
  gunPivot.add(muzzle);
  group.add(gunPivot);

  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(1.2, 24, 16),
    new THREE.MeshBasicMaterial({ color: '#7fd8ff', transparent: true, opacity: 0.22, depthWrite: false }),
  );
  shield.position.y = C.PLAYER_HEIGHT / 2;
  shield.visible = false;
  group.add(shield);

  const [cv, labelCtx] = textCanvas(256, 96);
  const labelTex = new THREE.CanvasTexture(cv);
  labelTex.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthWrite: false }));
  label.scale.set(1.9, 0.71, 1);
  label.position.y = C.PLAYER_HEIGHT + 0.55;
  group.add(label);

  return { group, body, bodyMat, gunPivot, muzzleMat, shield, label, labelCtx, labelTex, labelText: '', color, flash: 0 };
}

function drawLabel(rig: Rig, name: string, damage: number): void {
  const text = `${name}|${Math.round(damage)}`;
  if (text === rig.labelText || !rig.labelCtx) return;
  rig.labelText = text;
  const ctx = rig.labelCtx;
  ctx.clearRect(0, 0, 256, 96);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.font = `900 30px ${FONT}`;
  ctx.lineWidth = 7;
  ctx.strokeStyle = INK;
  ctx.fillStyle = '#fff6e0';
  ctx.strokeText(name, 128, 26);
  ctx.fillText(name, 128, 26);
  // Damage: white at 0%, through yellow, to red as knockback gets scary.
  const t = clamp(damage / 150, 0, 1);
  const col = new THREE.Color('#ffffff').lerp(new THREE.Color('#ffd93d'), clamp(t * 2, 0, 1)).lerp(new THREE.Color('#ff3b4e'), clamp(t * 2 - 1, 0, 1));
  ctx.font = `900 40px ${FONT}`;
  ctx.lineWidth = 8;
  const pct = `${Math.round(damage)}%`;
  ctx.strokeText(pct, 128, 68);
  ctx.fillStyle = `#${col.getHexString()}`;
  ctx.fillText(pct, 128, 68);
  rig.labelTex.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Particles: one additive point cloud for sparks, smoke and confetti
// ---------------------------------------------------------------------------

class Particles {
  readonly points: THREE.Points;
  private readonly n = 2500;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly base: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly max: Float32Array;
  private readonly grav: Float32Array;
  private next = 0;

  constructor() {
    this.pos = new Float32Array(this.n * 3).fill(-9999);
    this.col = new Float32Array(this.n * 3);
    this.base = new Float32Array(this.n * 3);
    this.vel = new Float32Array(this.n * 3);
    this.life = new Float32Array(this.n);
    this.max = new Float32Array(this.n).fill(1);
    this.grav = new Float32Array(this.n);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.35,
      map: GLOW,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  /** Spawns a burst at a three.js position. */
  burst(at: THREE.Vector3, count: number, color: THREE.Color, speed: number, life: number, gravity = 9, dir?: THREE.Vector3, spread = 1): void {
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.n;
      const i3 = i * 3;
      this.pos[i3] = at.x;
      this.pos[i3 + 1] = at.y;
      this.pos[i3 + 2] = at.z;
      // Random direction, optionally biased along dir.
      tmpV.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      if (dir) tmpV.multiplyScalar(spread).add(dir).normalize();
      const s = speed * (0.35 + Math.random() * 0.65);
      this.vel[i3] = tmpV.x * s;
      this.vel[i3 + 1] = tmpV.y * s;
      this.vel[i3 + 2] = tmpV.z * s;
      this.base[i3] = color.r;
      this.base[i3 + 1] = color.g;
      this.base[i3 + 2] = color.b;
      this.max[i] = life * (0.6 + Math.random() * 0.4);
      this.life[i] = this.max[i];
      this.grav[i] = gravity;
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      const i3 = i * 3;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.pos[i3 + 1] = -9999;
        this.col[i3] = this.col[i3 + 1] = this.col[i3 + 2] = 0;
        continue;
      }
      const drag = Math.exp(-2.2 * dt);
      this.vel[i3] *= drag;
      this.vel[i3 + 1] = this.vel[i3 + 1] * drag - this.grav[i] * dt;
      this.vel[i3 + 2] *= drag;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const f = this.life[i] / this.max[i];
      this.col[i3] = this.base[i3] * f;
      this.col[i3 + 1] = this.base[i3 + 1] * f;
      this.col[i3 + 2] = this.base[i3 + 2] * f;
    }
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

interface BulletObj {
  group: THREE.Group;
  tail: THREE.Mesh;
}

interface PowerupObj {
  group: THREE.Group;
  core: THREE.Mesh;
  ring: THREE.Mesh;
}

interface Word {
  sprite: THREE.Sprite;
  life: number;
  size: number;
}

export class Scene3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(C.FOV, 1, 0.05, 2000);
  private readonly sky: THREE.Mesh;
  private readonly sun: THREE.DirectionalLight;
  private readonly particles = new Particles();

  private mapIndex = -1;
  private arena = new THREE.Group();
  private edgeMat: THREE.MeshBasicMaterial | null = null;

  private readonly rigs = new Map<PlayerId, Rig>();
  private readonly bullets = new Map<number, BulletObj>();
  private readonly powerups = new Map<number, PowerupObj>();
  private words: Word[] = [];

  private readonly viewmodel = new THREE.Group();
  private readonly vmGlow: THREE.Sprite;
  private readonly vmCoilMat: THREE.MeshBasicMaterial;
  private vmColor = '';
  private kick = 0;
  private bob = 0;

  private trauma = 0;
  private time = 0;

  private readonly bulletGeo = new THREE.SphereGeometry(1, 14, 10);
  private readonly tailGeo = new THREE.ConeGeometry(1, 1, 10, 1, true).translate(0, 0.5, 0);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.fog = new THREE.Fog(FOG, 90, 700);

    // Sky dome that follows the camera.
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1500, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          top: { value: SKY_TOP },
          mid: { value: SKY_MID },
          horizon: { value: SKY_HORIZON },
          fogColor: { value: FOG },
          sunDir: { value: SUN_DIR },
        },
        vertexShader: `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform vec3 top; uniform vec3 mid; uniform vec3 horizon; uniform vec3 fogColor; uniform vec3 sunDir;
          varying vec3 vDir;
          void main() {
            float h = vDir.y;
            vec3 c = mix(horizon, mid, smoothstep(0.0, 0.25, h));
            c = mix(c, top, smoothstep(0.25, 0.8, h));
            c = mix(c, fogColor, smoothstep(0.02, -0.08, h));
            float sun = max(dot(vDir, sunDir), 0.0);
            c += vec3(1.0, 0.62, 0.35) * (pow(sun, 8.0) * 0.45 + pow(sun, 400.0) * 2.5);
            gl_FragColor = vec4(c, 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    );
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);
    this.scene.add(this.makeStars());

    this.scene.add(new THREE.HemisphereLight('#a8b8ff', '#40285a', 0.85));
    this.sun = new THREE.DirectionalLight('#ffd2a8', 1.5);
    this.sun.position.copy(SUN_DIR).multiplyScalar(80);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -30;
    sc.right = 30;
    sc.top = 30;
    sc.bottom = -30;
    sc.near = 1;
    sc.far = 220;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.scene.add(this.makeCity());
    this.scene.add(this.arena);
    this.scene.add(this.particles.points);

    // First-person gun, attached to the camera.
    const vmGunMat = new THREE.MeshToonMaterial({ color: '#2b2250', gradientMap: TOON });
    const body = outlined(new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.15, 0.55), vmGunMat), 1.08);
    body.position.z = -0.05;
    this.viewmodel.add(body);
    const barrel = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.35, 12), vmGunMat), 1.12);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.02, -0.45);
    this.viewmodel.add(barrel);
    this.vmCoilMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    for (const z of [-0.12, 0.02, 0.16]) {
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.022, 8, 20), this.vmCoilMat);
      coil.position.set(0, 0, z);
      this.viewmodel.add(coil);
    }
    this.vmGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.vmGlow.position.set(0, 0.02, -0.66);
    this.viewmodel.add(this.vmGlow);
    this.viewmodel.position.set(0.2, -0.19, -0.5);
    this.viewmodel.scale.setScalar(0.6);
    this.camera.add(this.viewmodel);
    this.scene.add(this.camera);

    this.resize();
  }

  resize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------------
  // World building
  // -------------------------------------------------------------------------

  private makeStars(): THREE.Points {
    const rand = prng(3);
    const n = 500;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = rand() * Math.PI * 2;
      const h = 0.25 + rand() * 0.75;
      const r = Math.sqrt(1 - h * h);
      pos.set([Math.cos(a) * r * 1200, h * 1200, Math.sin(a) * r * 1200], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: '#fff6e0', size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8 }));
    stars.renderOrder = -1;
    return stars;
  }

  private makeCity(): THREE.Group {
    const city = new THREE.Group();
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshLambertMaterial({ map: streetTexture(), color: '#b8a8d8' }),
    );
    const gmap = (ground.material as THREE.MeshLambertMaterial).map;
    if (gmap) gmap.repeat.set(4000 / 32, 4000 / 32);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -TOWER_DEPTH;
    city.add(ground);

    const { wall, glow } = windowTextures(11, 6, 14);
    const mat = new THREE.MeshLambertMaterial({ map: wall, emissive: new THREE.Color('#ffffff'), emissiveMap: glow, emissiveIntensity: 1.1 });
    const rand = prng(1234);
    const spots: { x: number; z: number; w: number; d: number; h: number }[] = [];
    const step = 32;
    for (let gx = -640; gx <= 640; gx += step) {
      for (let gz = -640; gz <= 640; gz += step) {
        const x = gx + (rand() - 0.5) * 6;
        const z = gz + (rand() - 0.5) * 6;
        const dist = Math.hypot(x, z);
        if (dist < 44 || rand() < 0.08) continue;
        const w = 12 + rand() * 12;
        const d = 12 + rand() * 12;
        // Near the tower, buildings stay below the roof so you can see out.
        const h = dist < 140 ? 20 + rand() * (TOWER_DEPTH - 30) : 30 + rand() * rand() * 190;
        spots.push({ x, z, w, d, h });
      }
    }
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const inst = new THREE.InstancedMesh(geo, mat, spots.length);
    const m = new THREE.Matrix4();
    const palette = ['#6a5a9a', '#5a6a9a', '#8a5a7a', '#4d5580', '#7a6a8a', '#556a7a'].map((c) => new THREE.Color(c));
    spots.forEach((s, i) => {
      m.makeScale(s.w, s.h, s.d);
      m.setPosition(s.x, -TOWER_DEPTH, s.z);
      inst.setMatrixAt(i, m);
      inst.setColorAt(i, palette[Math.floor(rand() * palette.length)]);
    });
    city.add(inst);
    return city;
  }

  private buildArena(map: MapDef): void {
    this.scene.remove(this.arena);
    disposeTree(this.arena);
    this.arena = new THREE.Group();
    this.scene.add(this.arena);

    const R = C.ARENA_START_RADIUS;
    const S = mapScale(R);
    const outline = arenaOutline(map, R);

    // The tower: the roof outline with its holes, extruded down to the street.
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const h of map.holes) {
      const path = new THREE.Path();
      path.absarc(h.x * S, h.y * S, h.r * S, 0, Math.PI * 2, true);
      shape.holes.push(path);
    }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: TOWER_DEPTH, bevelEnabled: false, curveSegments: 40 });
    geo.translate(0, 0, -TOWER_DEPTH);

    const surface = new THREE.CanvasTexture(makeSurfaceCanvas(map, 1024));
    surface.colorSpace = THREE.SRGBColorSpace;
    surface.flipY = false;
    surface.anisotropy = 8;
    // Cap UVs are the shape's own coordinates; the art covers [-10, 10] design units.
    surface.repeat.set(1 / (20 * S), 1 / (20 * S));
    surface.offset.set(0.5, 0.5);
    const topMat = new THREE.MeshToonMaterial({ map: surface, gradientMap: TOON });

    const { wall, glow } = windowTextures(map.name.length * 97, 8, 8);
    for (const t of [wall, glow]) t.repeat.set(1 / 24, 1 / 24);
    const sideMat = new THREE.MeshLambertMaterial({
      color: map.theme.side,
      map: wall,
      emissive: new THREE.Color('#ffffff'),
      emissiveMap: glow,
      emissiveIntensity: 0.9,
    });

    const roof = new THREE.Group();
    roof.rotation.x = -Math.PI / 2; // shape (x, y) -> world (x, -z); extrusion -> up
    const tower = new THREE.Mesh(geo, [topMat, sideMat]);
    tower.receiveShadow = true;
    roof.add(tower);

    // Hazard stripe around the edge and around every hole.
    this.edgeMat = new THREE.MeshBasicMaterial({ color: '#ffd93d', transparent: true, opacity: 0.9, depthWrite: false });
    const ring = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    const inner = new THREE.Path(
      arenaOutline(map, R - 0.45)
        .map(([x, y]) => new THREE.Vector2(x, y))
        .reverse(),
    );
    ring.holes.push(inner);
    const edge = new THREE.Mesh(new THREE.ShapeGeometry(ring, 40), this.edgeMat);
    edge.position.z = 0.02;
    roof.add(edge);
    for (const h of map.holes) {
      const hr = new THREE.Mesh(new THREE.RingGeometry(h.r * S, h.r * S + 0.4, 40), this.edgeMat);
      hr.position.set(h.x * S, h.y * S, 0.02);
      roof.add(hr);
    }
    this.arena.add(roof);

    // Bumper pillars.
    const bumperMat = new THREE.MeshToonMaterial({ color: map.theme.bumper, gradientMap: TOON });
    const capMat = new THREE.MeshBasicMaterial({ color: '#fff6e0' });
    for (const b of scaledBumpers(map, R)) {
      const g = new THREE.Group();
      g.position.copy(toThree(b.x, b.y, 0));
      const pillar = outlined(new THREE.Mesh(new THREE.CylinderGeometry(b.r, b.r * 1.08, C.BUMPER_HEIGHT, 32), bumperMat), 1.04);
      pillar.position.y = C.BUMPER_HEIGHT / 2;
      pillar.castShadow = true;
      pillar.receiveShadow = true;
      g.add(pillar);
      for (const y of [0.9, C.BUMPER_HEIGHT - 0.3]) {
        const band = new THREE.Mesh(new THREE.TorusGeometry(b.r * 1.02, 0.09, 8, 40), capMat);
        band.rotation.x = Math.PI / 2;
        band.position.y = y;
        g.add(band);
      }
      this.arena.add(g);
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame sync
  // -------------------------------------------------------------------------

  private colorOf(view: View, id: PlayerId): string {
    const r = view.roster.find((q) => q.id === id);
    return C.PLAYER_PALETTE[r?.color ?? id % C.PLAYER_PALETTE.length] ?? C.PLAYER_PALETTE[0];
  }

  private nameOf(view: View, id: PlayerId): string {
    return view.roster.find((q) => q.id === id)?.name ?? `Player ${id + 1}`;
  }

  private syncPlayers(view: View, cam: CameraView, dt: number): void {
    const seen = new Set<PlayerId>();
    for (const p of view.players) {
      seen.add(p.id);
      const color = this.colorOf(view, p.id);
      let rig = this.rigs.get(p.id);
      if (rig && rig.color !== color) {
        this.scene.remove(rig.group);
        disposeTree(rig.group);
        rig = undefined;
      }
      if (!rig) {
        rig = makeRig(color);
        this.rigs.set(p.id, rig);
        this.scene.add(rig.group);
      }
      const gone = p.fallTime > C.FALL_DURATION + 0.4;
      rig.group.visible = !gone && !(cam.kind === 'first' && p.id === view.myId);
      toThree(p.x, p.y, p.z, rig.group.position);
      rig.group.rotation.set(0, p.yaw - Math.PI / 2, 0);
      if (p.fallTime >= 0) {
        // Tumble as you fall.
        rig.group.rotation.x = p.fallTime * 3;
        rig.group.rotation.z = p.fallTime * 2;
      }
      rig.gunPivot.rotation.x = p.pitch;
      rig.shield.visible = (p.fx & FX_SHIELD) !== 0;
      rig.flash = Math.max(0, rig.flash - dt);
      rig.bodyMat.emissiveIntensity = rig.flash > 0 ? 0.8 : 0;
      const glow = new THREE.Color(color).lerp(new THREE.Color('#ffffff'), p.charge * 0.8);
      rig.muzzleMat.color.copy(glow);
      drawLabel(rig, this.nameOf(view, p.id), p.damage);
    }
    for (const [id, rig] of this.rigs) {
      if (seen.has(id)) continue;
      this.scene.remove(rig.group);
      disposeTree(rig.group);
      this.rigs.delete(id);
    }
  }

  private syncBullets(view: View): void {
    const seen = new Set<number>();
    for (const b of view.bullets) {
      seen.add(b.id);
      let obj = this.bullets.get(b.id);
      if (!obj) {
        const color = new THREE.Color(this.colorOf(view, b.owner));
        const bright = color.clone().lerp(new THREE.Color('#ffffff'), 0.55);
        const group = new THREE.Group();
        group.add(new THREE.Mesh(this.bulletGeo, new THREE.MeshBasicMaterial({ color: bright })));
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        glow.scale.setScalar(4.5);
        group.add(glow);
        const tail = new THREE.Mesh(
          this.tailGeo,
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
        );
        this.scene.add(tail);
        this.scene.add(group);
        obj = { group, tail };
        this.bullets.set(b.id, obj);
      }
      toThree(b.x, b.y, b.z, obj.group.position);
      obj.group.scale.setScalar(b.r);
      const v = toThree(b.vx, b.vy, b.vz, tmpV);
      const speed = v.length();
      if (speed > 1e-3) {
        obj.tail.visible = true;
        obj.tail.position.copy(obj.group.position);
        obj.tail.quaternion.setFromUnitVectors(UP, v.multiplyScalar(-1 / speed));
        obj.tail.scale.set(b.r * 0.9, Math.min(4, speed * 0.06), b.r * 0.9);
      } else {
        obj.tail.visible = false;
      }
    }
    for (const [id, obj] of this.bullets) {
      if (seen.has(id)) continue;
      this.scene.remove(obj.group);
      this.scene.remove(obj.tail);
      for (const o of [obj.group, obj.tail]) {
        o.traverse((c) => {
          const mesh = c as THREE.Mesh;
          if (mesh.material) (mesh.material as THREE.Material).dispose();
        });
      }
      this.bullets.delete(id);
    }
  }

  private syncPowerups(view: View): void {
    const seen = new Set<number>();
    for (const u of view.powerups) {
      seen.add(u.id);
      let obj = this.powerups.get(u.id);
      if (!obj) {
        const color = POWERUP_STYLE[u.kind].color;
        const group = new THREE.Group();
        const core = outlined(new THREE.Mesh(new THREE.IcosahedronGeometry(0.38, 0), new THREE.MeshToonMaterial({ color, gradientMap: TOON })), 1.12);
        group.add(core);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.05, 8, 32), new THREE.MeshBasicMaterial({ color }));
        group.add(ring);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        glow.scale.setScalar(2.2);
        group.add(glow);
        this.scene.add(group);
        obj = { group, core, ring };
        this.powerups.set(u.id, obj);
      }
      const pop = Math.min(1, u.age * 4);
      const fade = u.age > C.POWERUP_LIFETIME - 2 ? (Math.sin(u.age * 20) > 0 ? 1 : 0.3) : 1;
      toThree(u.x, u.y, C.POWERUP_HEIGHT + Math.sin(u.age * 3) * 0.15, obj.group.position);
      obj.group.scale.setScalar(pop * (fade > 0.5 ? 1 : 0.8));
      obj.core.rotation.set(u.age * 1.3, u.age * 2, 0);
      obj.ring.rotation.set(Math.PI / 2 + Math.sin(u.age) * 0.4, u.age * 1.7, 0);
    }
    for (const [id, obj] of this.powerups) {
      if (seen.has(id)) continue;
      this.scene.remove(obj.group);
      disposeTree(obj.group);
      this.powerups.delete(id);
    }
  }

  private updateWords(dt: number): void {
    this.words = this.words.filter((w) => {
      w.life -= dt;
      if (w.life <= 0) {
        this.scene.remove(w.sprite);
        w.sprite.material.dispose();
        return false;
      }
      const age = 0.8 - w.life;
      const pop = age < 0.12 ? age / 0.12 : 1 + (age - 0.12) * 0.25;
      w.sprite.scale.set(w.size * pop, w.size * 0.375 * pop, 1);
      w.sprite.material.opacity = Math.min(1, w.life / 0.25);
      w.sprite.position.y += dt * 0.8;
      return true;
    });
  }

  private addWord(at: THREE.Vector3, word: string, size: number): void {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: wordTexture(word), transparent: true, depthTest: false, depthWrite: false }));
    sprite.position.copy(at);
    sprite.material.rotation = (Math.random() - 0.5) * 0.4;
    sprite.renderOrder = 10;
    this.scene.add(sprite);
    this.words.push({ sprite, life: 0.8, size });
  }

  // -------------------------------------------------------------------------
  // Events and feedback
  // -------------------------------------------------------------------------

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Your own shot, shown the moment you release (before the server confirms it). */
  localFire(charge: number, color: string): void {
    this.kick = Math.min(1.5, this.kick + 0.5 + charge);
    this.addTrauma(0.08 + charge * 0.2);
    this.vmGlow.getWorldPosition(tmpV);
    const dir = this.camera.getWorldDirection(tmpV2);
    this.particles.burst(tmpV, 10 + Math.round(charge * 16), new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.4), 6 + charge * 6, 0.25, 0, dir, 0.6);
  }

  /** Plays a server event. Returns true for heavy hits. */
  onEvent(ev: GameEvent, view: View): boolean {
    const white = new THREE.Color('#ffffff');
    switch (ev.k) {
      case 'fire': {
        if (ev.p === view.myId) return false;
        const at = toThree(ev.x, ev.y, ev.z);
        const d = toThree(Math.cos(ev.a) * Math.cos(ev.b), Math.sin(ev.a) * Math.cos(ev.b), Math.sin(ev.b), tmpV2);
        this.particles.burst(at, 8 + Math.round(ev.c * 12), new THREE.Color(this.colorOf(view, ev.p)), 6 + ev.c * 6, 0.3, 0, d, 0.6);
        return false;
      }
      case 'hit': {
        const at = toThree(ev.x, ev.y, ev.z);
        const heavy = ev.f >= C.HEAVY_HIT_IMPULSE;
        this.particles.burst(at, 18 + Math.round(ev.f * 2), new THREE.Color(this.colorOf(view, ev.o)).lerp(white, 0.3), 7 + ev.f * 0.5, 0.5, 6);
        this.particles.burst(at, 10, new THREE.Color('#ffd93d'), 10, 0.25, 0);
        const rig = this.rigs.get(ev.p);
        if (rig) rig.flash = 0.12;
        if (heavy) this.addWord(at.add(tmpV.set(0, 0.8, 0)), WORDS[Math.floor(Math.random() * WORDS.length)], 2.4 + ev.f * 0.06);
        if (ev.p === view.myId) this.addTrauma(0.25 + ev.f / 30);
        return heavy;
      }
      case 'block': {
        this.particles.burst(toThree(ev.x, ev.y, ev.z), 30, new THREE.Color('#7fd8ff'), 8, 0.5, 0);
        return false;
      }
      case 'cancel': {
        this.particles.burst(toThree(ev.x, ev.y, ev.z), 16, new THREE.Color('#fff6e0'), 5, 0.35, 2);
        return false;
      }
      case 'bump': {
        const color = ev.q < 0 ? new THREE.Color(MAPS[view.mapIndex]?.theme.bumper ?? '#ff3d8b') : white;
        this.particles.burst(toThree(ev.x, ev.y, ev.z), 10 + Math.round(ev.f), color, 5 + ev.f * 0.3, 0.35, 4);
        if (ev.p === view.myId || ev.q === view.myId) this.addTrauma(0.15);
        return false;
      }
      case 'fall': {
        this.addWord(toThree(ev.x, ev.y, -1), 'BYE!', 3);
        return false;
      }
      case 'spawn': {
        this.particles.burst(toThree(ev.x, ev.y, C.POWERUP_HEIGHT), 24, new THREE.Color(POWERUP_STYLE[ev.u].color), 5, 0.6, -2);
        return false;
      }
      case 'pickup': {
        this.particles.burst(toThree(ev.x, ev.y, C.POWERUP_HEIGHT), 40, new THREE.Color(POWERUP_STYLE[ev.u].color), 7, 0.7, -4);
        return false;
      }
      case 'respawn': {
        const p = view.players.find((q) => q.id === ev.p);
        if (p) this.particles.burst(toThree(p.x, p.y, 1), 30, new THREE.Color(this.colorOf(view, p.id)), 6, 0.6, -3);
        return false;
      }
      default:
        return false;
    }
  }

  /** Stereo pan (-1..1) for a sound at a sim position, relative to the camera. */
  panFor(x: number, y: number, z: number): number {
    const rel = toThree(x, y, z, tmpV).sub(this.camera.position);
    const right = tmpV2.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    return clamp(rel.dot(right) / Math.max(4, rel.length()), -1, 1) * 0.8;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  render(view: View, cam: CameraView, dt: number, myColor: string): void {
    this.time += dt;
    if (view.mapIndex !== this.mapIndex) {
      this.mapIndex = view.mapIndex;
      this.buildArena(MAPS[view.mapIndex] ?? MAPS[0]);
    }
    const s = view.arenaRadius / C.ARENA_START_RADIUS;
    this.arena.scale.set(s, 1, s);
    if (this.edgeMat) {
      // The edge pulses red while the roof shrinks.
      const warn = view.shrinking ? 0.5 + 0.5 * Math.sin(this.time * 8) : 0;
      this.edgeMat.color.set('#ffd93d').lerp(new THREE.Color('#ff3b4e'), warn);
    }

    this.syncPlayers(view, cam, dt);
    this.syncBullets(view);
    this.syncPowerups(view);
    this.particles.update(dt);
    this.updateWords(dt);

    // Camera.
    this.trauma = Math.max(0, this.trauma - C.SHAKE_DECAY * dt);
    const shake = this.trauma * this.trauma * C.SHAKE_MAX_ANGLE;
    const n = (k: number): number => Math.sin(this.time * (37 + k * 11) + k * 3) * shake;
    if (cam.kind === 'first') {
      toThree(cam.x, cam.y, cam.z, this.camera.position);
      this.camera.rotation.set(cam.pitch + n(1), cam.yaw - Math.PI / 2 + n(2), n(3), 'YXZ');
      this.viewmodel.visible = true;
      // Gun bob while running, recoil kick after a shot, glow while charging.
      if (cam.grounded) this.bob += dt * cam.speed * 1.4;
      const bobAmt = cam.grounded ? Math.min(1, cam.speed / C.MOVE_SPEED) : 0;
      this.kick = Math.max(0, this.kick - dt * 6);
      this.viewmodel.position.set(0.2 + Math.cos(this.bob) * 0.01 * bobAmt, -0.19 + Math.abs(Math.sin(this.bob)) * 0.012 * bobAmt - cam.charge * 0.012, -0.5 + this.kick * 0.06);
      this.viewmodel.rotation.set(this.kick * 0.18, 0, cam.charge * 0.05);
      if (myColor !== this.vmColor) {
        this.vmColor = myColor;
        this.vmCoilMat.color.set(myColor);
        this.vmGlow.material.color.set(myColor);
      }
      const pulse = cam.charge >= 1 ? 1 + Math.sin(this.time * 30) * 0.15 : 1;
      this.vmGlow.scale.setScalar((0.08 + cam.charge * 0.35) * pulse);
      this.vmGlow.material.opacity = 0.35 + cam.charge * 0.65;
    } else {
      const t = this.time * 0.07;
      const r = 20 + view.arenaRadius * 0.9;
      this.camera.position.set(Math.cos(t) * r, 12 + view.arenaRadius * 0.45, Math.sin(t) * r);
      this.camera.lookAt(0, -1, 0);
      this.camera.rotation.z += n(3);
      this.viewmodel.visible = false;
    }
    this.sky.position.copy(this.camera.position);
    // Keep the shadow map centred on the action.
    this.sun.target.position.set(0, 0, 0);
    this.sun.position.copy(SUN_DIR).multiplyScalar(80);

    this.renderer.render(this.scene, this.camera);
  }
}
