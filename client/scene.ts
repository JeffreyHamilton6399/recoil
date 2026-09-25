// The 3D world, drawn with three.js and inked by ink.ts: a city at dusk,
// the tower whose roof is the arena (it shrinks with the arena), obstacles
// and jump pads, bumper pillars, players with their guns, bullets,
// power-ups, particles, comic words and your own gun in first person.
//
// Simulation coordinates are x, y horizontal and z up. three.js uses y up,
// so a sim point (x, y, z) is drawn at (x, z, -y), which keeps handedness.

import * as THREE from 'three';
import * as C from '../shared/constants.js';
import { MAPS, floorAt, mapScale, scaledBumpers, type MapDef } from '../shared/maps.js';
import { clamp, flagBase } from '../shared/sim.js';
import { FX_GROUNDED, FX_SHIELD, type GameEvent, type PlayerId, type PowerupKind, type RosterEntry } from '../shared/types.js';
import { BOMB_WEAPON, SHOCK_WEAPON, TURRET_WEAPON, weaponDef } from '../shared/weapons.js';
import { FONT, INK, POWERUP_STYLE, arenaOutline, makeSurfaceCanvas } from './art.js';
import { animateCharacter, flashCharacter, makeCharacter, type Character } from './character.js';
import { makeArms, makeGun, makeKnife, type Gun } from './guns.js';
import { Inker } from './ink.js';
import { buildBlocks, buildPads, type Pads, buildRamps } from './props.js';
import { GLOW, TOON, disposeTree, glowSprite, outlined, toon } from './toon.js';

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
  damage: number;
  /** Seconds since falling, or -1 while standing. */
  fallTime: number;
  fx: number;
  weapon: number;
  sliding: boolean;
  /** Holding the knife instead of the gun. */
  knife: boolean;
  /** Where their grappling hook is stuck, if it is. */
  hook?: { x: number; y: number; z: number } | null;
}

export interface ViewBullet {
  id: number;
  owner: PlayerId;
  weapon: number;
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
  phase: 'lobby' | 'countdown' | 'playing' | 'roundEnd' | 'matchEnd';
  phaseTime: number;
  arenaRadius: number;
  mapIndex: number;
  shrinking: boolean;
  players: ViewPlayer[];
  bullets: ViewBullet[];
  powerups: ViewPowerup[];
  roster: RosterEntry[];
  myId: PlayerId | -1;
  /** Players talking on voice chat right now. */
  speaking?: ReadonlySet<PlayerId>;
  /** Capture the flag: Red's and Blue's flags (carrier -1 when at home). */
  flags?: ViewFlag[];
  /** Turrets: [yaw, pitch, knocked out (1) or not]. */
  turrets?: [number, number, number][];
}

/** A turret on the roof: the part that turns, and its glowing eye. */
interface TurretObj {
  head: THREE.Group;
  eye: THREE.Sprite;
  muzzle: THREE.Object3D;
  yaw: number;
  pitch: number;
}

export interface ViewFlag {
  x: number;
  y: number;
  z: number;
  carrier: PlayerId | -1;
}

/** A capture-the-flag flag: pole and cloth, a light beam to find it by, and its base ring. */
interface FlagObj {
  group: THREE.Group;
  cloth: THREE.Mesh;
  beam: THREE.Mesh;
  base: THREE.Mesh;
}

/** Where the camera is: your own eyes, or circling the roof. */
export type CameraView =
  | {
      kind: 'first';
      x: number;
      y: number;
      /** Eye height (sim z). */
      z: number;
      yaw: number;
      pitch: number;
      speed: number;
      grounded: boolean;
      weapon: number;
      sprinting: boolean;
      sliding: boolean;
      /** Aiming down sights. */
      aiming: boolean;
      /** Holding the knife instead of the gun. */
      knife: boolean;
    }
  | { kind: 'orbit' };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How far the tower drops to the street. */
const TOWER_DEPTH = 90;
const SKY_TOP = new THREE.Color('#1a1446');
const SKY_MID = new THREE.Color('#5b3a8c');
const SKY_HORIZON = new THREE.Color('#ff9a86');
const FOG = new THREE.Color('#9a5a8e');
const SUN_DIR = new THREE.Vector3(-0.75, 0.22, 0.62).normalize();
const WORDS = ['POW!', 'BAM!', 'WHAM!', 'KA-POW!', 'SMASH!', 'THWACK!'];
const BOOM_WORDS = ['KABOOM!', 'BOOM!', 'KRAKOOM!'];

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Shortest signed turn from angle a to angle b. */
function angleBetween(a: number, b: number): number {
  return ((((b - a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
}

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

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

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

function textCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D | null] {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return [cv, cv.getContext('2d')];
}

/** Wraps an angle into [-PI, PI). */
function wrapAngleLocal(a: number): number {
  return ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
}

const tmpColor = new THREE.Color();

let ringTex: THREE.CanvasTexture | null = null;
/** A soft ring, for impact rings. */
function ringTexture(): THREE.CanvasTexture {
  if (ringTex) return ringTex;
  const [cv, ctx] = textCanvas(128, 128);
  if (ctx) {
    const g = ctx.createRadialGradient(64, 64, 34, 64, 64, 62);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.55, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  ringTex = new THREE.CanvasTexture(cv);
  ringTex.colorSpace = THREE.SRGBColorSpace;
  return ringTex;
}

let flashTex: THREE.CanvasTexture | null = null;
/** A spiky muzzle-flash star. */
function flashTexture(): THREE.CanvasTexture {
  if (flashTex) return flashTex;
  const [cv, ctx] = textCanvas(128, 128);
  if (ctx) {
    ctx.translate(64, 64);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 60);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,230,160,0.9)');
    g.addColorStop(1, 'rgba(255,160,60,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    const spikes = 7;
    for (let i = 0; i < spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI * 2;
      const r = i % 2 === 0 ? 60 : 18;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  }
  flashTex = new THREE.CanvasTexture(cv);
  flashTex.colorSpace = THREE.SRGBColorSpace;
  return flashTex;
}

const numberTextures = new Map<string, THREE.CanvasTexture>();
/** Damage numbers: bold, inked, white (yellow for heavy hits). */
function numberTexture(text: string, heavy: boolean): THREE.CanvasTexture {
  const key = `${text}|${heavy}`;
  let tex = numberTextures.get(key);
  if (tex) return tex;
  const [cv, ctx] = textCanvas(512, 192);
  if (ctx) {
    ctx.font = `900 110px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 20;
    ctx.strokeStyle = INK;
    ctx.strokeText(text, 256, 96);
    ctx.fillStyle = heavy ? '#ffd93d' : '#fff6e0';
    ctx.fillText(text, 256, 96);
  }
  tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  numberTextures.set(key, tex);
  return tex;
}

const wordTextures = new Map<string, THREE.CanvasTexture>();
function wordTexture(word: string): THREE.CanvasTexture {
  let tex = wordTextures.get(word);
  if (tex) return tex;
  const [cv, ctx] = textCanvas(640, 192);
  if (ctx) {
    ctx.font = `900 108px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 22;
    ctx.strokeStyle = INK;
    // Off-register cyan and magenta, like cheap comic printing.
    ctx.fillStyle = '#00e1ff';
    ctx.fillText(word, 326, 100);
    ctx.fillStyle = '#ff2e88';
    ctx.fillText(word, 314, 92);
    ctx.strokeText(word, 320, 96);
    ctx.fillStyle = '#ffd93d';
    ctx.fillText(word, 320, 96);
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
  key: string;
  group: THREE.Group;
  /** The character model (legs, torso, head); its upper body holds the gun. */
  char: Character;
  body: THREE.Group;
  gunPivot: THREE.Group;
  gun: Gun;
  shield: THREE.Mesh;
  label: THREE.Sprite;
  labelCtx: CanvasRenderingContext2D | null;
  labelTex: THREE.CanvasTexture;
  labelText: string;
  flash: number;
  lean: number;
  /** 1 at the start of a knife slash, easing to 0. */
  slash: number;
  /** Seconds of muzzle flash left. */
  muzzle: number;
}

/** What a player's model depends on: rebuilt when it changes. */
function rigKey(color: string, weapon: number, knife: boolean): string {
  return `${color}|${knife ? 'knife' : weapon}`;
}

/** The arm's sweep through a slash, from +1 (wound up) through 0 to -1 (follow-through). t runs 1 -> 0. */
function slashCurve(t: number): number {
  if (t <= 0) return 0;
  const u = 1 - t;
  // Fast swing, then a gentle return.
  return u < 0.35 ? 1 - (u / 0.35) * 2 : -1 + ((u - 0.35) / 0.65);
}

function makeRig(color: string, weapon: number, knife: boolean): Rig {
  const group = new THREE.Group();
  const char = makeCharacter(color);
  group.add(char.root);
  const body = char.upper;

  // Gun held in front of the chest in both hands (or a knife in the right),
  // pitched with the aim.
  const gunPivot = new THREE.Group();
  gunPivot.position.copy(char.chest);
  const gun = knife ? makeKnife(color) : makeGun(weapon, color);
  if (knife) {
    gun.group.position.set(0.3, -0.12, -0.42);
    gun.group.rotation.x = 0.5;
  } else {
    gun.group.position.set(0.16, -0.06, -0.46);
  }
  gunPivot.add(gun.group);
  const shoulders: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(0.33, 0.06, -0.02), new THREE.Vector3(-0.33, 0.06, -0.02)];
  const hands: [THREE.Vector3, THREE.Vector3] = knife
    ? [gun.grip.clone().add(gun.group.position), new THREE.Vector3(-0.34, -0.42, -0.2)]
    : [gun.grip.clone().add(gun.group.position), gun.fore.clone().add(gun.group.position)];
  gunPivot.add(makeArms(color, shoulders, hands, 1.25));
  body.add(gunPivot);

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

  return { key: rigKey(color, weapon, knife), group, char, body, gunPivot, gun, shield, label, labelCtx, labelTex, labelText: '', flash: 0, lean: 0, slash: 0, muzzle: 0 };
}

function drawLabel(rig: Rig, name: string, damage: number, talking: boolean): void {
  const text = `${name}|${Math.round(damage)}|${talking}`;
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
  if (talking) {
    // A little speaker badge next to the name while they talk on voice chat.
    const w = ctx.measureText(name).width;
    const x = 128 + w / 2 + 22;
    ctx.fillStyle = '#9ff0b8';
    ctx.strokeStyle = INK;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, 26, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.moveTo(x - 8, 21);
    ctx.lineTo(x - 3, 21);
    ctx.lineTo(x + 3, 15);
    ctx.lineTo(x + 3, 37);
    ctx.lineTo(x - 3, 31);
    ctx.lineTo(x - 8, 31);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x + 4, 26, 6, -0.9, 0.9);
    ctx.stroke();
  }
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
// Particles: one additive point cloud for sparks, dust and confetti
// ---------------------------------------------------------------------------

class Particles {
  readonly points: THREE.Points;
  private readonly n = 3000;
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
  weapon: number;
  /** Pool key (shooter colour and kind); finished bullets go back to their pool. */
  key: string;
  /** Already whizzed past your head. */
  whizzed: boolean;
}

/** A shell casing flying out of your gun. */
interface Casing {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  floorY: number;
  bounced: boolean;
}

/** An expanding ring where a shot landed. */
interface Ring {
  sprite: THREE.Sprite;
  life: number;
  max: number;
  size: number;
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

interface Shock {
  mesh: THREE.Mesh;
  life: number;
  radius: number;
}

export class Scene3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly inker: Inker;
  private readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(C.FOV, 1, 0.05, 2000);
  private readonly sky: THREE.Mesh;
  private readonly sun: THREE.DirectionalLight;
  private readonly particles = new Particles();

  private mapIndex = -1;
  private arena = new THREE.Group();
  private edgeMat: THREE.MeshBasicMaterial | null = null;
  private pads: Pads | null = null;

  private readonly rigs = new Map<PlayerId, Rig>();
  private readonly flagObjs: FlagObj[] = [];
  private turretObjs: TurretObj[] = [];
  /** Warning rings on the roof under falling bombs, by bullet id. */
  private readonly bombMarks = new Map<number, THREE.Mesh>();
  /** Grappling hook lines, by player. */
  private readonly ropes = new Map<PlayerId, { line: THREE.Mesh; claw: THREE.Mesh }>();
  private readonly bullets = new Map<number, BulletObj>();
  private readonly bulletPool = new Map<string, BulletObj[]>();
  private casings: Casing[] = [];
  private rings: Ring[] = [];
  /** A quick light at your muzzle when you fire (always in the scene, so no shader rebuilds). */
  private readonly muzzleLight = new THREE.PointLight('#ffd89a', 0, 7, 2);
  private readonly flashSprite: THREE.Sprite;
  private flashLife = 0;
  /** Seconds until the next slide-dust puff. */
  private dustIn = 0;
  /** Called when an enemy shot whizzes past (pan, closeness 0..1), and when a casing lands. */
  onWhizz: (pan: number, close: number) => void = () => {};
  onCasing: (pan: number) => void = () => {};
  private readonly powerups = new Map<number, PowerupObj>();
  private words: Word[] = [];
  private shocks: Shock[] = [];

  private readonly viewmodel = new THREE.Group();
  private vmGun: Gun | null = null;
  private vmArms: THREE.Group | null = null;
  /** 1 right after a weapon is drawn, easing to 0. */
  private drawT = 0;
  /** 1 at the start of your knife slash, easing to 0. */
  private slashT = 0;
  private aimT = 0;
  private vmKey = '';
  private kick = 0;
  private flashTime = 0;
  private bob = 0;
  private fov = C.FOV;
  private roll = 0;
  /** Render resolution multiplier (0.5-1), lowered automatically on slower PCs. */
  private quality = 1;
  private slowFor = 0;
  private fastFor = 0;
  private dprQuery: MediaQueryList | null = null;

  private trauma = 0;
  /** View punch from your own shots (radians), recovering to 0. */
  private punchPitch = 0;
  private punchYaw = 0;
  /** Weapon sway from turning. */
  private swayX = 0;
  private swayY = 0;
  private lastYaw: number | null = null;
  private lastPitch: number | null = null;
  /** Camera dip after a hard landing (metres), and its spring velocity. */
  private landDip = 0;
  private landVel = 0;
  private time = 0;

  private readonly bulletGeo = new THREE.SphereGeometry(1, 14, 10);
  private readonly casingGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.04, 8);
  private readonly casingMat = new THREE.MeshBasicMaterial({ color: '#e0b04a' });
  private readonly shellMat = new THREE.MeshBasicMaterial({ color: '#d8423c' });
  /** A small round, 1 unit long along +Y (scaled per weapon). */
  private readonly roundGeo = new THREE.CapsuleGeometry(0.22, 0.56, 3, 8);
  private readonly tailGeo = new THREE.ConeGeometry(1, 1, 10, 1, true).translate(0, 0.5, 0);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.inker = new Inker(this.renderer);

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
            // Banded like a painted sky, not a smooth gradient.
            float band = floor(h * 14.0) / 14.0;
            vec3 c = mix(horizon, mid, smoothstep(0.0, 0.25, band));
            c = mix(c, top, smoothstep(0.25, 0.8, band));
            c = mix(c, fogColor, smoothstep(0.02, -0.08, h));
            float sun = max(dot(vDir, sunDir), 0.0);
            c += vec3(1.0, 0.62, 0.35) * (pow(sun, 8.0) * 0.45 + step(0.9993, sun) * 2.0);
            gl_FragColor = vec4(c, 1.0);
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
    sc.left = -54;
    sc.right = 54;
    sc.top = 54;
    sc.bottom = -54;
    sc.near = 1;
    sc.far = 220;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.scene.add(this.makeCity());
    this.scene.add(this.arena);
    this.scene.add(this.particles.points);

    // Your gun, attached to the camera.
    this.viewmodel.scale.setScalar(0.48);
    this.flashSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTexture(), color: '#fff2c8', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    this.flashSprite.visible = false;
    this.flashSprite.renderOrder = 12;
    this.scene.add(this.flashSprite);
    this.camera.add(this.muzzleLight);
    this.muzzleLight.position.set(0.15, -0.1, -0.6);
    this.camera.add(this.viewmodel);
    this.scene.add(this.camera);

    this.resize();
  }

  /** How zoomed in the camera is right now (1 = normal), for scaling mouse look. */
  get zoom(): number {
    return this.fov / C.FOV;
  }

  /**
   * Fits the canvas to the window. The render resolution follows the
   * screen's pixel density (display scaling, Retina, browser zoom), capped so
   * huge 4K screens don't overload the GPU, and scaled by the auto quality.
   */
  resize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const dpr = window.devicePixelRatio || 1;
    // At most about 3.7 million pixels (2560x1440) at full quality.
    const cap = Math.sqrt(3_700_000 / (w * h));
    const ratio = Math.max(0.5, Math.min(dpr, 2, cap) * this.quality);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, true);
    this.inker.setSize(w, h, ratio);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.watchPixelRatio(dpr);
  }

  /** Re-fit when the window moves to a screen with a different pixel density. */
  private watchPixelRatio(dpr: number): void {
    const query = `(resolution: ${dpr}dppx)`;
    if (this.dprQuery?.media === query) return;
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = window.matchMedia(query);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  private readonly onDprChange = (): void => this.resize();

  /**
   * Automatic quality: if frames stay slow (under ~40 fps) the render
   * resolution steps down; with plenty of headroom it steps back up.
   */
  private adaptQuality(dt: number): void {
    if (dt <= 0 || dt > 0.25) return; // ignore tab switches and hitches
    if (dt > 1 / 40) {
      this.slowFor += dt;
      this.fastFor = 0;
    } else {
      this.slowFor = Math.max(0, this.slowFor - dt * 0.5);
      this.fastFor = dt < 1 / 55 ? this.fastFor + dt : 0;
    }
    if (this.slowFor > 1.5 && this.quality > 0.5) {
      this.quality = Math.max(0.5, this.quality - 0.15);
      this.slowFor = 0;
      this.resize();
    } else if (this.fastFor > 8 && this.quality < 1) {
      this.quality = Math.min(1, this.quality + 0.1);
      this.fastFor = 0;
      this.resize();
    }
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
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ map: streetTexture(), color: '#b8a8d8' }));
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
        // Leave room around the (bigger) arena tower.
        if (dist < C.ARENA_START_RADIUS + 26 || rand() < 0.08) continue;
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
    // A block of buildings is one tower per rooftop, and thin slabs for the bridges.
    const rect = (x0: number, y0: number, x1: number, y1: number): THREE.Vector2[] => [
      new THREE.Vector2(x0, y0),
      new THREE.Vector2(x1, y0),
      new THREE.Vector2(x1, y1),
      new THREE.Vector2(x0, y1),
    ];
    const pieces: { shape: THREE.Shape; depth: number; top?: number }[] = [];
    if (map.roofs) {
      for (const r of map.roofs) {
        const shape = new THREE.Shape(rect((r.x - r.w / 2) * S, (r.y - r.d / 2) * S, (r.x + r.w / 2) * S, (r.y + r.d / 2) * S));
        pieces.push({ shape, depth: r.bridge ? 0.6 : TOWER_DEPTH, top: r.h });
      }
    } else {
      const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
      for (const h of map.holes) {
        const path = new THREE.Path();
        path.absarc(h.x * S, h.y * S, h.r * S, 0, Math.PI * 2, true);
        shape.holes.push(path);
      }
      pieces.push({ shape, depth: TOWER_DEPTH });
    }

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
    for (const { shape, depth, top } of pieces) {
      const geo = new THREE.ExtrudeGeometry(shape, { depth: depth + (top ?? 0), bevelEnabled: false, curveSegments: 40 });
      geo.translate(0, 0, -depth);
      const tower = new THREE.Mesh(geo, [topMat, sideMat]);
      tower.receiveShadow = true;
      roof.add(tower);
    }

    // Hazard stripe around the edge (of every rooftop) and around every hole.
    this.edgeMat = new THREE.MeshBasicMaterial({ color: '#ffd93d', transparent: true, opacity: 0.9, depthWrite: false });
    const stripe = (shape: THREE.Shape, top = 0): void => {
      const edge = new THREE.Mesh(new THREE.ShapeGeometry(shape, 40), this.edgeMat ?? undefined);
      edge.position.z = top + 0.02;
      roof.add(edge);
    };
    if (map.roofs) {
      const e = 0.45;
      for (const r of map.roofs) {
        const [x0, y0, x1, y1] = [(r.x - r.w / 2) * S, (r.y - r.d / 2) * S, (r.x + r.w / 2) * S, (r.y + r.d / 2) * S];
        if (r.bridge) {
          // Just the two open sides: the ends run onto the rooftops.
          if (r.w > r.d) {
            stripe(new THREE.Shape(rect(x0, y0, x1, y0 + e)));
            stripe(new THREE.Shape(rect(x0, y1 - e, x1, y1)));
          } else {
            stripe(new THREE.Shape(rect(x0, y0, x0 + e, y1)));
            stripe(new THREE.Shape(rect(x1 - e, y0, x1, y1)));
          }
          continue;
        }
        const ring = new THREE.Shape(rect(x0, y0, x1, y1));
        ring.holes.push(new THREE.Path(rect(x0 + e, y0 + e, x1 - e, y1 - e).reverse()));
        stripe(ring, r.h ?? 0);
      }
    } else {
      const ring = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
      ring.holes.push(new THREE.Path(arenaOutline(map, R - 0.45).map(([x, y]) => new THREE.Vector2(x, y)).reverse()));
      stripe(ring);
    }
    for (const h of map.holes) {
      const hr = new THREE.Mesh(new THREE.RingGeometry(h.r * S, h.r * S + 0.4, 40), this.edgeMat);
      hr.position.set(h.x * S, h.y * S, 0.02);
      roof.add(hr);
    }
    this.arena.add(roof);

    // Obstacles and jump pads.
    this.arena.add(buildBlocks(map, S));
    this.arena.add(buildRamps(map, S));
    this.pads = buildPads(map, S);
    this.turretObjs = (map.turrets ?? []).map((t) => this.makeTurret(t.x * S, t.y * S, t.z ?? 0));
    this.arena.add(this.pads.group);

    // Bumper pillars.
    const bumperMat = toon(map.theme.bumper);
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
    if (id < 0) return id === -1 ? '#ff9f1c' : '#ff3b4e';
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
      if (rig && rig.key !== rigKey(color, p.weapon, p.knife)) {
        this.scene.remove(rig.group);
        disposeTree(rig.group);
        rig = undefined;
      }
      if (!rig) {
        rig = makeRig(color, p.weapon, p.knife);
        this.rigs.set(p.id, rig);
        this.scene.add(rig.group);
      }
      const gone = p.fallTime > C.FALL_DURATION + 0.4;
      rig.group.visible = !gone && !(cam.kind === 'first' && p.id === view.myId);
      toThree(p.x, p.y, p.z, rig.group.position);
      rig.group.rotation.set(0, p.yaw - Math.PI / 2, 0);
      // Walk, jump and slide poses; lean back into a slide.
      animateCharacter(rig.char, dt, rig.group.position, p.yaw - Math.PI / 2, (p.fx & FX_GROUNDED) !== 0, p.sliding, p.pitch);
      rig.lean += ((p.sliding ? 1 : 0) - rig.lean) * Math.min(1, dt * 12);
      rig.body.rotation.x = rig.lean * 0.9;
      rig.body.position.y -= rig.lean * 0.2;
      if (p.fallTime >= 0) {
        // Tumble as you fall.
        rig.group.rotation.x = p.fallTime * 3;
        rig.group.rotation.z = p.fallTime * 2;
      }
      rig.gunPivot.rotation.x = p.pitch - rig.lean * 0.9;
      // A knife slash sweeps the arm across from right to left.
      rig.slash = Math.max(0, rig.slash - dt / (C.KNIFE_SWING * 0.7));
      rig.gunPivot.rotation.y = p.knife ? slashCurve(rig.slash) * 1.1 : 0;
      rig.shield.visible = (p.fx & FX_SHIELD) !== 0;
      rig.flash = Math.max(0, rig.flash - dt);
      flashCharacter(rig.char, rig.flash > 0);
      // A brief muzzle flash when they fire.
      rig.muzzle = Math.max(0, rig.muzzle - dt);
      rig.gun.muzzle.scale.setScalar(rig.muzzle > 0 ? 0.6 : 0.1);
      drawLabel(rig, this.nameOf(view, p.id), p.damage, view.speaking?.has(p.id) ?? false);
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
      const w = weaponDef(b.weapon);
      // Boomer bombs and shock grenades are thrown objects, not bullets.
      const bomb = b.weapon === 3 || b.weapon === 7 || b.weapon === SHOCK_WEAPON || b.weapon === BOMB_WEAPON || b.weapon === TURRET_WEAPON;
      const key = `${this.colorOf(view, b.owner)}|${bomb ? b.weapon : 'round'}`;
      if (!obj) {
        // Reuse a finished bullet of the same look if there is one.
        const pooled = this.bulletPool.get(key)?.pop();
        if (pooled) {
          pooled.group.visible = true;
          pooled.weapon = b.weapon;
          pooled.whizzed = false;
          obj = pooled;
          this.bullets.set(b.id, obj);
        }
      }
      if (!obj) {
        const color = new THREE.Color(this.colorOf(view, b.owner));
        const accent = new THREE.Color(w.accent);
        const group = new THREE.Group();
        if (bomb) {
          // The Boomer lobs a grenade: dark, outlined, with a hot glow.
          const shell = b.weapon === SHOCK_WEAPON ? '#1d4a5c' : b.weapon === BOMB_WEAPON ? '#1a1424' : b.weapon === TURRET_WEAPON ? '#5a2a08' : b.weapon === 7 ? '#5a4410' : '#2b2250';
          const ball = new THREE.Mesh(this.bulletGeo, toon(new THREE.Color(shell)));
          outlined(ball, 1.15);
          group.add(ball);
          if (b.weapon === BOMB_WEAPON) {
            // A proper cartoon bomb: fins on top and a red warning light.
            const fin = outlined(new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.1, 1.4), toon('#3a3547')), 1.08);
            fin.position.y = 1.1;
            group.add(fin);
            const fin2 = fin.clone();
            fin2.rotation.y = Math.PI / 2;
            group.add(fin2);
          }
          group.add(glowSprite(accent, b.weapon === BOMB_WEAPON ? 3.4 : 2.6));
        } else {
          // A small brass round with a hot tip.
          const round = new THREE.Mesh(this.roundGeo, new THREE.MeshBasicMaterial({ color: '#e0b04a' }));
          group.add(round);
          group.add(glowSprite(new THREE.Color('#fff1c4'), 0.9));
        }
        // Tracer: a thin bright streak behind the round, tinted with the shooter's colour.
        const tracerColor = bomb ? accent : color.clone().lerp(new THREE.Color('#fff4d0'), 0.6);
        const tail = new THREE.Mesh(
          this.tailGeo,
          new THREE.MeshBasicMaterial({ color: tracerColor, transparent: true, opacity: bomb ? 0.5 : 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
        );
        this.scene.add(tail);
        this.scene.add(group);
        obj = { group, tail, weapon: b.weapon, key, whizzed: false };
        this.bullets.set(b.id, obj);
      }
      toThree(b.x, b.y, b.z, obj.group.position);
      const v = toThree(b.vx, b.vy, b.vz, tmpV);
      const speed = v.length();
      if (bomb) {
        obj.group.scale.setScalar(b.weapon === BOMB_WEAPON ? b.r * 1.6 : b.r * 0.8);
      } else {
        // Rounds are drawn a fixed small size (the hitbox is a bit more forgiving).
        const len = b.weapon === 2 || b.weapon === 6 ? 0.2 : b.weapon === 5 ? 0.09 : 0.12;
        obj.group.scale.setScalar(len);
        if (speed > 1e-3) obj.group.quaternion.setFromUnitVectors(UP, tmpV2.copy(v).multiplyScalar(1 / speed));
      }
      if (speed > 1e-3) {
        obj.tail.visible = true;
        obj.tail.position.copy(obj.group.position);
        obj.tail.quaternion.setFromUnitVectors(UP, v.multiplyScalar(-1 / speed));
        // Longshot rounds leave a long streak, pellets short ones.
        const len =
          b.weapon === BOMB_WEAPON
            ? Math.min(6, speed * 0.25)
            : bomb
              ? Math.min(1.5, speed * 0.04)
              : b.weapon === 6
                ? Math.min(24, speed * 0.08)
                : b.weapon === 2
                  ? Math.min(14, speed * 0.06)
                  : b.weapon === 1
                    ? Math.min(2.2, speed * 0.028)
                    : b.weapon === 5
                      ? Math.min(3, speed * 0.03)
                      : Math.min(5, speed * 0.045);
        const width = bomb ? b.r * 0.6 : b.weapon === 6 ? 0.08 : b.weapon === 2 ? 0.05 : b.weapon === 4 || b.weapon === 5 ? 0.018 : 0.026;
        obj.tail.scale.set(width, len, width);
      } else {
        obj.tail.visible = false;
      }
      if (bomb && Math.random() < 0.5) {
        // Bombs trail sparks from their fuse.
        this.particles.burst(obj.group.position, 1, tmpColor.set(w.accent), 1, 0.3, -1);
      }
      // Someone else's shot passing close by your head: a whizz.
      if (!obj.whizzed && b.owner !== view.myId && !bomb) {
        const d = obj.group.position.distanceTo(this.camera.position);
        if (d < 2.4) {
          obj.whizzed = true;
          this.onWhizz(this.panFor(b.x, b.y, b.z), 1 - d / 2.4);
        }
      }
    }
    for (const [id, obj] of this.bullets) {
      if (seen.has(id)) continue;
      // Back to the pool (a handful per look), or gone for good.
      obj.group.visible = false;
      obj.tail.visible = false;
      const pool = this.bulletPool.get(obj.key) ?? [];
      if (pool.length < 24) {
        pool.push(obj);
        this.bulletPool.set(obj.key, pool);
      } else {
        this.scene.remove(obj.group);
        this.scene.remove(obj.tail);
        for (const o of [obj.group, obj.tail]) {
          o.traverse((c) => {
            const mesh = c as THREE.Mesh;
            if (mesh.material) (mesh.material as THREE.Material).dispose();
          });
        }
      }
      this.bullets.delete(id);
    }
  }

  /** A turret: a squat base, and a head with a barrel and a red eye that turns. */
  private makeTurret(x: number, y: number, z: number): TurretObj {
    const g = new THREE.Group();
    toThree(x, y, z, g.position);
    const metal = toon('#4a4f63');
    const trim = toon('#ff9f1c');
    const base = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.6, 0.55, 16), metal), 1.06);
    base.position.y = 0.27;
    g.add(base);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 6, 20), trim);
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.45;
    g.add(band);
    const head = new THREE.Group();
    head.position.y = C.TURRET_HEIGHT;
    const shell = outlined(new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.55, 0.8), metal), 1.06);
    head.add(shell);
    const barrel = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.95, 10), toon('#2b2f3d')), 1.12);
    barrel.rotation.z = -Math.PI / 2;
    barrel.position.x = 0.8;
    head.add(barrel);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.97, 0.1, 0.82), trim);
    stripe.position.y = 0.12;
    head.add(stripe);
    const eye = glowSprite('#ff3b4e', 0.9);
    eye.position.set(0.5, 0.05, 0);
    head.add(eye);
    const muzzle = new THREE.Object3D();
    muzzle.position.x = 1.3;
    head.add(muzzle);
    g.add(head);
    this.arena.add(g);
    return { head, eye, muzzle, yaw: 0, pitch: 0 };
  }

  /** Turrets turn smoothly towards what the server says; knocked-out ones slump and smoke. */
  private syncTurrets(view: View, dt: number): void {
    const list = view.turrets ?? [];
    this.turretObjs.forEach((t, i) => {
      const [yaw, pitch, down] = list[i] ?? [t.yaw, t.pitch, 0];
      const k = Math.min(1, dt * 14);
      t.yaw += angleBetween(t.yaw, yaw) * k;
      t.pitch += ((down ? -0.55 : pitch) - t.pitch) * k;
      t.head.rotation.set(0, t.yaw, t.pitch);
      t.eye.visible = !down;
      if (down && Math.random() < 0.25) {
        t.head.getWorldPosition(tmpV);
        this.particles.burst(tmpV, 1, tmpColor.set('#3a3547'), 1.2, 0.9, -2.5);
      }
    });
  }

  /** A pulsing red ring on the roof under every falling bomb. */
  private syncBombMarks(view: View): void {
    const map = MAPS[view.mapIndex] ?? MAPS[0];
    const seen = new Set<number>();
    for (const b of view.bullets) {
      if (b.weapon !== BOMB_WEAPON) continue;
      seen.add(b.id);
      let mark = this.bombMarks.get(b.id);
      if (!mark) {
        const r = weaponDef(BOMB_WEAPON).splash;
        mark = new THREE.Mesh(
          new THREE.RingGeometry(r * 0.82, r, 40),
          new THREE.MeshBasicMaterial({ color: '#ff3b4e', transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }),
        );
        mark.rotation.x = -Math.PI / 2;
        const dot = new THREE.Mesh(
          new THREE.CircleGeometry(r * 0.25, 24),
          new THREE.MeshBasicMaterial({ color: '#ff3b4e', transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }),
        );
        mark.add(dot);
        this.scene.add(mark);
        this.bombMarks.set(b.id, mark);
      }
      const floor = floorAt(map, view.arenaRadius, b.x, b.y, b.z);
      mark.visible = floor > -Infinity;
      toThree(b.x, b.y, Math.max(0, floor) + 0.05, mark.position);
      // Tighter and faster the closer it gets.
      const near = clamp(1 - (b.z - floor) / C.BOMB_HEIGHT, 0, 1);
      const pulse = 0.5 + 0.5 * Math.sin(this.time * (8 + near * 22));
      mark.scale.setScalar(1.25 - near * 0.25 + pulse * 0.06);
      (mark.material as THREE.MeshBasicMaterial).opacity = 0.35 + near * 0.5 * pulse + 0.1;
    }
    for (const [id, mark] of this.bombMarks) {
      if (seen.has(id)) continue;
      this.scene.remove(mark);
      disposeTree(mark);
      this.bombMarks.delete(id);
    }
  }

  /** Grappling hook lines: from the hand (or just under your view) to the hook. */
  private syncRopes(view: View, cam: CameraView): void {
    const seen = new Set<PlayerId>();
    for (const p of view.players) {
      if (!p.hook || p.fallTime >= 0) continue;
      seen.add(p.id);
      let rope = this.ropes.get(p.id);
      if (!rope) {
        const line = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 6, 1, true), new THREE.MeshBasicMaterial({ color: INK }));
        line.geometry.translate(0, 0.5, 0);
        const claw = outlined(new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), toon('#c9c4d8')), 1.2);
        this.scene.add(line, claw);
        rope = { line, claw };
        this.ropes.set(p.id, rope);
      }
      const from = new THREE.Vector3();
      if (p.id === view.myId && cam.kind === 'first') from.set(0.22, -0.28, -0.45).applyMatrix4(this.camera.matrixWorld);
      else {
        // The off hand, a little in front of the chest.
        toThree(p.x + Math.cos(p.yaw) * 0.3, p.y + Math.sin(p.yaw) * 0.3, p.z + 1.3, from);
      }
      const to = toThree(p.hook.x, p.hook.y, p.hook.z);
      const d = to.clone().sub(from);
      rope.line.position.copy(from);
      rope.line.scale.set(1, d.length(), 1);
      rope.line.quaternion.setFromUnitVectors(UP, d.normalize());
      rope.claw.position.copy(to);
      rope.claw.rotation.y += 0.2;
    }
    for (const [id, rope] of this.ropes) {
      if (seen.has(id)) continue;
      this.scene.remove(rope.line, rope.claw);
      disposeTree(rope.line);
      disposeTree(rope.claw);
      this.ropes.delete(id);
    }
  }

  private makeFlag(team: number): FlagObj {
    const color = C.PLAYER_PALETTE[C.TEAM_COLORS[team]];
    const group = new THREE.Group();
    const pole = outlined(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.5, 8), toon('#e8e4f2')), 1.3);
    pole.position.y = 1.25;
    group.add(pole);
    const cloth = outlined(new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.6, 0.04), toon(color)), 1.06);
    cloth.geometry.translate(0.475, 0, 0);
    cloth.position.y = 2.15;
    group.add(cloth);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, 60, 12, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    );
    beam.position.y = 30;
    group.add(beam);
    group.add(glowSprite(color, 2));
    const base = new THREE.Mesh(
      new THREE.RingGeometry(C.FLAG_RADIUS - 0.18, C.FLAG_RADIUS, 40),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    base.rotation.x = -Math.PI / 2;
    this.scene.add(group, base);
    return { group, cloth, beam, base };
  }

  /** Capture the flag: flags at their bases, or on their carrier's back. */
  private syncFlags(view: View, cam: CameraView): void {
    const flags = view.flags ?? [];
    for (let team = 0; team < 2; team++) {
      const f = flags[team];
      let obj = this.flagObjs[team];
      if (!f) {
        if (obj) obj.group.visible = obj.base.visible = false;
        continue;
      }
      obj ??= this.flagObjs[team] = this.makeFlag(team);
      const home = flagBase(MAPS[view.mapIndex] ?? MAPS[0], team);
      obj.base.visible = true;
      toThree(home.x, home.y, 0.03, obj.base.position);
      let { x, y, z } = f;
      let lean = 0;
      const carrier = f.carrier >= 0 ? view.players.find((p) => p.id === f.carrier) : undefined;
      if (carrier) {
        // Strapped to the carrier's back, leaning with their run.
        x = carrier.x - Math.cos(carrier.yaw) * 0.35;
        y = carrier.y - Math.sin(carrier.yaw) * 0.35;
        z = carrier.z + 0.6;
        lean = 0.25;
      }
      // Your own flag-carrying back is out of view in first person.
      obj.group.visible = !(carrier && carrier.id === view.myId && cam.kind === 'first');
      toThree(x, y, z, obj.group.position);
      obj.group.rotation.set(0, carrier ? -carrier.yaw + Math.PI : 0, lean);
      obj.cloth.rotation.y = Math.sin(this.time * 4 + team) * 0.35;
      (obj.beam.material as THREE.MeshBasicMaterial).opacity = carrier ? 0.32 + 0.12 * Math.sin(this.time * 10) : 0.2;
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
        const core = outlined(new THREE.Mesh(new THREE.IcosahedronGeometry(0.38, 0), toon(color)), 1.12);
        group.add(core);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.05, 8, 32), new THREE.MeshBasicMaterial({ color }));
        group.add(ring);
        group.add(glowSprite(color, 2.2));
        this.scene.add(group);
        obj = { group, core, ring };
        this.powerups.set(u.id, obj);
      }
      const pop = Math.min(1, u.age * 4);
      const blink = u.age > C.POWERUP_LIFETIME - 2 && Math.sin(u.age * 20) < 0;
      toThree(u.x, u.y, C.POWERUP_HEIGHT + Math.sin(u.age * 3) * 0.15, obj.group.position);
      obj.group.scale.setScalar(pop * (blink ? 0.8 : 1));
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
      w.sprite.scale.set(w.size * pop, w.size * 0.3 * pop, 1);
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

  private updateShocks(dt: number): void {
    this.shocks = this.shocks.filter((s) => {
      s.life -= dt;
      if (s.life <= 0) {
        this.scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        (s.mesh.material as THREE.Material).dispose();
        return false;
      }
      const t = 1 - s.life / 0.35;
      s.mesh.scale.setScalar(s.radius * (0.3 + t * 0.9));
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.7;
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Events and feedback
  // -------------------------------------------------------------------------

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** A hard landing: the camera dips, harder the faster you came down, and dust puffs out. */
  landImpact(speed: number): void {
    if (speed < 4) return;
    this.landVel += Math.min(3.5, speed * 0.16);
    const feet = tmpV.copy(this.camera.position);
    feet.y -= C.EYE_HEIGHT - 0.1;
    this.particles.burst(feet, Math.min(40, 8 + Math.round(speed * 2)), tmpColor.set('#e9e2d6'), 3 + speed * 0.25, 0.5, 2, tmpV2.set(0, 0.2, 0), 3);
  }

  /** A brass casing (a red shell for the Scatter) flipping out of your gun. */
  private ejectCasing(weapon: number): void {
    if (weapon === 3 || !this.vmGun) return;
    let casing = this.casings.length >= 16 ? this.casings.shift() : undefined;
    if (!casing) {
      const mesh = new THREE.Mesh(this.casingGeo, this.casingMat);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      casing = { mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, floorY: 0, bounced: false };
    }
    const shell = weapon === 1;
    casing.mesh.material = shell ? this.shellMat : this.casingMat;
    casing.mesh.scale.set(shell ? 1.6 : 1, shell ? 1.8 : 1, shell ? 1.6 : 1);
    casing.mesh.visible = true;
    this.vmGun.group.getWorldPosition(casing.mesh.position);
    const right = tmpV.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = tmpV2.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    casing.mesh.position.addScaledVector(right, 0.05).addScaledVector(up, 0.04);
    casing.vel.copy(right).multiplyScalar(2.2 + Math.random()).addScaledVector(up, 1.8 + Math.random() * 0.8);
    casing.spin.set(Math.random() * 20 - 10, Math.random() * 20 - 10, Math.random() * 20 - 10);
    casing.life = 1.6;
    casing.floorY = this.camera.position.y - C.EYE_HEIGHT + 0.02;
    casing.bounced = false;
    this.casings.push(casing);
  }

  private updateCasings(dt: number): void {
    for (const c of this.casings) {
      if (c.life <= 0) continue;
      c.life -= dt;
      c.vel.y -= 14 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;
      if (c.mesh.position.y < c.floorY && c.vel.y < 0) {
        c.mesh.position.y = c.floorY;
        c.vel.y *= -0.35;
        c.vel.x *= 0.5;
        c.vel.z *= 0.5;
        c.spin.multiplyScalar(0.5);
        if (!c.bounced) {
          c.bounced = true;
          this.onCasing(0.3);
        }
      }
      if (c.life <= 0) c.mesh.visible = false;
    }
  }

  /** An expanding ring at a sim position (a shot landing). */
  private ring(x: number, y: number, z: number, color: THREE.ColorRepresentation, size: number, life = 0.25): void {
    let r = this.rings.find((q) => q.life <= 0);
    if (!r) {
      if (this.rings.length >= 24) return;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      this.scene.add(sprite);
      r = { sprite, life: 0, max: life, size };
      this.rings.push(r);
    }
    toThree(x, y, z, r.sprite.position);
    r.sprite.material.color.set(color);
    r.sprite.material.rotation = Math.random() * Math.PI;
    r.sprite.visible = true;
    r.life = r.max = life;
    r.size = size;
  }

  private updateRings(dt: number): void {
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const t = 1 - Math.max(0, r.life) / r.max;
      r.sprite.scale.setScalar(r.size * (0.3 + t * 1.2));
      r.sprite.material.opacity = (1 - t) * 0.9;
      if (r.life <= 0) r.sprite.visible = false;
    }
  }

  /** Dust and sparks from the feet of anyone sliding (you included). */
  private slideTrails(view: View, cam: CameraView, dt: number): void {
    this.dustIn -= dt;
    if (this.dustIn > 0) return;
    this.dustIn = 0.035;
    for (const p of view.players) {
      if (!p.sliding || p.fallTime >= 0) continue;
      const at = toThree(p.x, p.y, p.z + 0.08, tmpV);
      if (p.id === view.myId && cam.kind === 'first') {
        // Your own trail: a little ahead of the camera, so you see it stream past.
        const f = tmpV2.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        at.addScaledVector(f.setY(0).normalize(), 0.9);
      }
      this.particles.burst(at, 3, tmpColor.set('#efe6d8'), 2.4, 0.45, 1.5, tmpV2.set(0, 0.6, 0), 2);
      if (Math.random() < 0.5) this.particles.burst(at, 1, tmpColor.set('#ffcf6b'), 5, 0.25, 6);
    }
  }

  /** A floating "+12%" where your shot landed, rising and fading. */
  damageNumber(x: number, y: number, z: number, amount: number, heavy: boolean): void {
    const text = `+${Math.round(amount)}%`;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: numberTexture(text, heavy), transparent: true, depthTest: false, depthWrite: false }));
    toThree(x, y, z + 0.6, sprite.position);
    sprite.position.x += (Math.random() - 0.5) * 0.4;
    sprite.renderOrder = 11;
    this.scene.add(sprite);
    this.words.push({ sprite, life: 0.8, size: heavy ? 1.5 : 1.1 });
  }

  /** Your own knife slash, shown the moment you swing. */
  localSlash(): void {
    this.slashT = 1;
    this.addTrauma(0.05);
  }

  /** Your own shot, shown the moment you fire (before the server confirms it). */
  localFire(weapon: number, color: string): void {
    const def = weaponDef(weapon);
    // How heavy the gun feels, 0..1, from how hard it punches the view.
    const heavy = clamp(def.viewKick / 0.13, 0.1, 1);
    this.kick = Math.min(1.5, this.kick + 0.3 + heavy * 0.9);
    this.flashTime = 0.06;
    this.addTrauma(0.03 + heavy * 0.12);
    // The view punches up (and a touch sideways), then springs back.
    this.punchPitch += def.viewKick;
    this.punchYaw += (Math.random() - 0.5) * def.viewKick * 0.5;
    // A star-shaped flash and a quick burst of light, and a casing flips out.
    this.flashLife = 0.05 + heavy * 0.03;
    this.flashSprite.material.rotation = Math.random() * Math.PI;
    this.flashSprite.scale.setScalar(0.18 + heavy * 0.2);
    this.muzzleLight.intensity = 2.5 + heavy * 4;
    this.ejectCasing(weapon);
    if (!this.vmGun) return;
    this.vmGun.muzzle.getWorldPosition(tmpV);
    const dir = this.camera.getWorldDirection(tmpV2);
    this.particles.burst(tmpV, 6 + Math.round(heavy * 16), new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.4), 5 + heavy * 6, 0.2, 0, dir, 0.6);
  }

  /** Dust at your feet (or someone else's) when a slide starts. */
  slideDust(x: number, y: number, z: number): void {
    this.particles.burst(toThree(x, y, z + 0.1), 18, new THREE.Color('#fff6e0'), 4, 0.45, 3);
  }

  /** Plays a server event. Returns true for heavy hits. */
  onEvent(ev: GameEvent, view: View): boolean {
    const white = new THREE.Color('#ffffff');
    switch (ev.k) {
      case 'fire': {
        if (ev.p === view.myId) return false;
        const at = toThree(ev.x, ev.y, ev.z);
        const d = toThree(Math.cos(ev.a) * Math.cos(ev.b), Math.sin(ev.a) * Math.cos(ev.b), Math.sin(ev.b), tmpV2);
        const heavy = clamp(weaponDef(ev.w).viewKick / 0.13, 0.1, 1);
        this.particles.burst(at, 8 + Math.round(heavy * 12), new THREE.Color(this.colorOf(view, ev.p)), 6 + heavy * 6, 0.3, 0, d, 0.6);
        const shooter = this.rigs.get(ev.p);
        if (shooter) shooter.muzzle = 0.06;
        return false;
      }
      case 'hit': {
        const at = toThree(ev.x, ev.y, ev.z);
        const heavy = ev.f >= C.HEAVY_HIT_IMPULSE;
        this.particles.burst(at, 12 + Math.round(ev.f * 2), new THREE.Color(this.colorOf(view, ev.o)).lerp(white, 0.3), 7 + ev.f * 0.5, 0.5, 6);
        this.particles.burst(at, 8, new THREE.Color('#ffd93d'), 10, 0.25, 0);
        const rig = this.rigs.get(ev.p);
        if (rig) rig.flash = 0.12;
        this.ring(ev.x, ev.y, ev.z, this.colorOf(view, ev.o), heavy ? 2.4 : 1.4, heavy ? 0.32 : 0.22);
        if (heavy) this.addWord(at.add(tmpV.set(0, 0.8, 0)), WORDS[Math.floor(Math.random() * WORDS.length)], 2.6 + ev.f * 0.06);
        if (ev.p === view.myId) this.addTrauma(0.2 + ev.f / 35);
        return heavy;
      }
      case 'tfire': {
        const t = this.turretObjs[ev.i];
        if (!t) return false;
        t.muzzle.getWorldPosition(tmpV);
        const dir = tmpV2.set(Math.cos(t.yaw), 0, -Math.sin(t.yaw));
        this.particles.burst(tmpV, 16, new THREE.Color('#ffb347'), 7, 0.25, 0, dir, 0.5);
        this.particles.burst(tmpV, 6, new THREE.Color('#fff6e0'), 4, 0.15, 0);
        return false;
      }
      case 'thit': {
        const t = this.turretObjs[ev.i];
        if (!t) return false;
        t.head.getWorldPosition(tmpV);
        this.particles.burst(tmpV, 10, new THREE.Color('#ffe08a'), 8, 0.25, 4);
        return false;
      }
      case 'tdown': {
        const t = this.turretObjs[ev.i];
        if (!t) return false;
        t.head.getWorldPosition(tmpV);
        this.particles.burst(tmpV, 50, new THREE.Color('#ffb347'), 11, 0.6, 5);
        this.particles.burst(tmpV, 30, new THREE.Color('#3a3547'), 5, 1.2, -2);
        this.addWord(tmpV.clone().add(tmpV2.set(0, 1.2, 0)), 'KA-CHUNK!', 3);
        this.addTrauma(clamp(0.4 - tmpV.distanceTo(this.camera.position) / 30, 0, 0.4));
        return false;
      }
      case 'sudden':
        this.addTrauma(0.35);
        return false;
      case 'boom': {
        const at = toThree(ev.x, ev.y, ev.z);
        const isShock = ev.w === SHOCK_WEAPON;
        if (ev.w === BOMB_WEAPON) {
          // Sudden-death bombs: a bigger, darker blast with a smoke column.
          this.particles.burst(at, 40, new THREE.Color('#ff3b4e'), 14, 0.7, 5);
          this.particles.burst(at, 40, new THREE.Color('#2a2438'), 6, 1.4, -3);
        }
        if (isShock) {
          // A shockwave: an electric blue burst, no fire.
          this.particles.burst(at, 70, new THREE.Color('#7fe7ff'), 16, 0.5, 0);
          this.particles.burst(at, 30, new THREE.Color('#ffffff'), 10, 0.3, 0);
        } else {
          this.particles.burst(at, 60, new THREE.Color('#ffb347'), 12, 0.6, 4);
          this.particles.burst(at, 30, new THREE.Color('#fff6e0'), 7, 0.4, 0);
          this.particles.burst(at, 24, new THREE.Color(weaponDef(3).accent), 9, 0.7, 6);
        }
        const shock = new THREE.Mesh(
          new THREE.SphereGeometry(1, 24, 16),
          new THREE.MeshBasicMaterial({ color: isShock ? '#7fe7ff' : '#ffd93d', transparent: true, opacity: isShock ? 0.45 : 0.7, depthWrite: false }),
        );
        shock.position.copy(at);
        this.scene.add(shock);
        this.shocks.push({ mesh: shock, life: 0.35, radius: ev.r });
        this.addWord(at.clone().add(tmpV.set(0, 1.2, 0)), isShock ? 'WHOOM!' : BOOM_WORDS[Math.floor(Math.random() * BOOM_WORDS.length)], 3.4);
        const dist = at.distanceTo(this.camera.position);
        this.addTrauma(clamp(0.6 - dist / 25, 0, 0.6));
        return false;
      }
      case 'melee': {
        const swinger = this.rigs.get(ev.p);
        if (swinger) swinger.slash = 1;
        // A slash of sparks sweeping across in front of the swinger.
        const at = toThree(ev.x, ev.y, ev.z);
        const d = toThree(Math.cos(ev.a), Math.sin(ev.a), 0, tmpV2);
        this.particles.burst(at, ev.hit ? 26 : 12, new THREE.Color(ev.hit ? '#ffffff' : '#d8d2ee'), ev.hit ? 7 : 4, 0.25, 0, d, 1.2);
        if (ev.hit) this.addWord(at.clone().add(tmpV.set(0, 0.6, 0)), 'SLASH!', 2.4);
        return false;
      }
      case 'throw':
        return false;
      case 'pad': {
        this.particles.burst(toThree(ev.x, ev.y, 0.3), 30, new THREE.Color('#00e1ff'), 7, 0.6, -2, UP, 0.5);
        return false;
      }
      case 'slide': {
        const p = view.players.find((q) => q.id === ev.p);
        if (p && ev.p !== view.myId) this.slideDust(p.x, p.y, p.z);
        return false;
      }
      case 'block': {
        this.particles.burst(toThree(ev.x, ev.y, ev.z), 30, new THREE.Color('#7fd8ff'), 8, 0.5, 0);
        return false;
      }
      case 'cancel': {
        this.particles.burst(toThree(ev.x, ev.y, ev.z), 12, new THREE.Color('#fff6e0'), 5, 0.3, 2);
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

  /** Where the camera is and which way it faces (three.js coordinates), for voice chat's 3D audio. */
  listener(): { pos: THREE.Vector3; forward: THREE.Vector3; up: THREE.Vector3 } {
    return {
      pos: this.camera.getWorldPosition(new THREE.Vector3()),
      forward: this.camera.getWorldDirection(new THREE.Vector3()),
      up: new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion),
    };
  }

  /** A player's head position in three.js coordinates. */
  static head(x: number, y: number, z: number): THREE.Vector3 {
    return toThree(x, y, z + C.EYE_HEIGHT);
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

  private updateViewmodel(cam: Extract<CameraView, { kind: 'first' }>, myColor: string, dt: number): void {
    const key = rigKey(myColor, cam.weapon, cam.knife);
    if (key !== this.vmKey) {
      this.vmKey = key;
      for (const old of [this.vmGun?.group, this.vmArms]) {
        if (!old) continue;
        this.viewmodel.remove(old);
        disposeTree(old);
      }
      this.vmGun = cam.knife ? makeKnife(myColor) : makeGun(cam.weapon, myColor);
      // The knife is held up and angled in, blade forward.
      if (cam.knife) {
        this.vmGun.group.rotation.set(0.55, 0.25, -0.2);
        this.vmGun.group.scale.setScalar(1.4);
      }
      this.viewmodel.add(this.vmGun.group);
      // Your arms come up from below the screen to the grip and the front of the gun.
      this.vmArms = makeArms(
        myColor,
        [new THREE.Vector3(0.3, -0.62, 0.8), new THREE.Vector3(-0.55, -0.66, 0.42)],
        [this.vmGun.grip.clone(), this.vmGun.fore.clone()],
      );
      this.viewmodel.add(this.vmArms);
      // Pulling a weapon out brings it up from below.
      this.drawT = 1;
    }
    this.drawT = Math.max(0, this.drawT - dt * 5);
    this.slashT = Math.max(0, this.slashT - dt / (C.KNIFE_SWING * 0.7));
    // Aiming down sights slides the gun to the middle; a scope hides it.
    this.aimT += ((cam.aiming ? 1 : 0) - this.aimT) * Math.min(1, dt * 14);
    const a = this.aimT;
    this.viewmodel.visible = !(!cam.knife && weaponDef(cam.weapon).scope && a > 0.7);
    // Sway: the gun lags a little behind quick turns, then catches up.
    if (this.lastYaw !== null) {
      const dy = wrapAngleLocal(cam.yaw - this.lastYaw);
      const dp = cam.pitch - (this.lastPitch ?? cam.pitch);
      this.swayX = clamp(this.swayX + dy * 0.6, -0.08, 0.08);
      this.swayY = clamp(this.swayY - dp * 0.6, -0.06, 0.06);
    }
    this.lastYaw = cam.yaw;
    this.lastPitch = cam.pitch;
    const settle = Math.exp(-dt * 10);
    this.swayX *= settle;
    this.swayY *= settle;
    // Bob while running, kick after a shot, lower while sliding.
    if (cam.grounded) this.bob += dt * cam.speed * (cam.sprinting ? 1.1 : 1.4);
    const bobAmt = (cam.grounded && !cam.sliding ? Math.min(1.4, cam.speed / C.MOVE_SPEED) : 0) * (1 - a * 0.8);
    this.kick = Math.max(0, this.kick - dt * 6);
    const sprintTuck = cam.sprinting ? 1 - a : 0;
    const hip = 1 - a;
    // Knife slash: a quick sweep from upper right to lower left.
    const sw = slashCurve(this.slashT);
    const draw = this.drawT * this.drawT;
    this.viewmodel.position.set(
      0.19 * hip + Math.cos(this.bob) * 0.01 * bobAmt - sprintTuck * 0.03 - sw * 0.12 + this.swayX * hip,
      -0.2 * hip - 0.062 * a + Math.abs(Math.sin(this.bob)) * 0.012 * bobAmt - (cam.sliding ? 0.03 : 0) - draw * 0.25 + sw * 0.04 + this.swayY * hip - this.landDip * 0.05,
      -0.5 * hip - 0.4 * a + this.kick * 0.06 - Math.abs(sw) * 0.08,
    );
    this.viewmodel.rotation.set(
      this.kick * 0.18 * (1 - a * 0.6) - sprintTuck * 0.25 - draw * 0.6 - Math.abs(sw) * 0.3,
      sprintTuck * 0.35 + sw * 0.9,
      (cam.sliding ? 0.25 : 0) * hip + sw * 0.8 - this.swayX * 1.5 * hip,
    );
    if (this.vmGun) {
      this.flashTime = Math.max(0, this.flashTime - dt);
      const flash = this.flashTime > 0 ? 0.6 : 0;
      this.vmGun.muzzle.scale.setScalar(0.06 + flash);
      this.vmGun.muzzle.material.opacity = Math.min(1, 0.3 + flash);
    }
  }

  render(view: View, cam: CameraView, dt: number, myColor: string): void {
    this.time += dt;
    this.adaptQuality(dt);
    if (view.mapIndex !== this.mapIndex) {
      this.mapIndex = view.mapIndex;
      this.buildArena(MAPS[view.mapIndex] ?? MAPS[0]);
    }
    const s = view.arenaRadius / C.ARENA_START_RADIUS;
    this.arena.scale.set(s, 1, s);
    this.pads?.update(this.time);
    if (this.edgeMat) {
      // The edge pulses red while the roof shrinks.
      const warn = view.shrinking ? 0.5 + 0.5 * Math.sin(this.time * 8) : 0;
      this.edgeMat.color.set('#ffd93d').lerp(tmpColor.set('#ff3b4e'), warn);
    }

    this.syncPlayers(view, cam, dt);
    this.syncFlags(view, cam);
    this.syncTurrets(view, dt);
    this.syncBombMarks(view);
    this.syncRopes(view, cam);
    this.syncBullets(view);
    this.syncPowerups(view);
    this.particles.update(dt);
    this.updateWords(dt);
    this.updateShocks(dt);
    this.updateCasings(dt);
    this.updateRings(dt);
    this.slideTrails(view, cam, dt);
    // Muzzle flash: a star at the barrel and a quick light, gone in a blink.
    this.flashLife = Math.max(0, this.flashLife - dt);
    this.muzzleLight.intensity *= Math.exp(-dt * 30);
    this.flashSprite.visible = this.flashLife > 0 && cam.kind === 'first' && this.viewmodel.visible;
    if (this.flashSprite.visible && this.vmGun) this.vmGun.muzzle.getWorldPosition(this.flashSprite.position);

    // Camera.
    this.trauma = Math.max(0, this.trauma - C.SHAKE_DECAY * dt);
    const shake = this.trauma * this.trauma * C.SHAKE_MAX_ANGLE;
    const n = (k: number): number => Math.sin(this.time * (37 + k * 11) + k * 3) * shake;
    let fov = C.FOV;
    if (cam.kind === 'first') {
      // Wider view at speed, zoomed in while aiming, and a lean into slides.
      fov = cam.aiming ? weaponDef(cam.weapon).adsFov : C.FOV + (cam.sliding ? 12 : cam.sprinting ? 7 : 0);
      this.roll += ((cam.sliding ? 0.08 : 0) - this.roll) * Math.min(1, dt * 10);
      toThree(cam.x, cam.y, cam.z, this.camera.position);
      // Landing dip: the view drops a little and springs back up.
      this.landVel += (-this.landDip * 180 - this.landVel * 18) * dt;
      this.landDip = Math.max(-0.3, this.landDip + this.landVel * dt);
      this.camera.position.y -= this.landDip;
      // View punch from firing recovers quickly, like a real gun settling.
      const recover = Math.exp(-dt * 11);
      this.punchPitch *= recover;
      this.punchYaw *= recover;
      this.camera.rotation.set(cam.pitch + this.punchPitch + n(1), cam.yaw - Math.PI / 2 + this.punchYaw + n(2), this.roll + n(3), 'YXZ');
      this.updateViewmodel(cam, myColor, dt);
    } else {
      const t = this.time * 0.07;
      const r = 20 + view.arenaRadius * 0.9;
      this.camera.position.set(Math.cos(t) * r, 12 + view.arenaRadius * 0.45, Math.sin(t) * r);
      this.camera.lookAt(0, -1, 0);
      this.camera.rotation.z += n(3);
      this.viewmodel.visible = false;
    }
    this.fov += (fov - this.fov) * Math.min(1, dt * 12);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.sky.position.copy(this.camera.position);

    this.inker.render(this.scene, this.camera, dt);
  }
}
