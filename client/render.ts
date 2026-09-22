// Canvas 2D renderer in a toon / cel-shaded style: flat colour bands, thick
// ink outlines, hard shadows and comic impact bursts. Everything is drawn
// procedurally. World units are converted to pixels so the full arena is
// always visible, whatever the screen shape.

import * as C from '../shared/constants.js';
import { MAPS, mapScale, scaledBumpers, type MapDef } from '../shared/maps.js';
import { clamp, lerp } from '../shared/sim.js';
import {
  FX_MEGA,
  FX_RAPID,
  FX_SHIELD,
  FX_TRIPLE,
  type GameEvent,
  type Phase,
  type PlayerId,
  type PowerupKind,
  type RosterEntry,
} from '../shared/types.js';

/** Outline colour used for everything. */
export const INK = '#1b1030';
const YELLOW = '#ffd93d';
const BUMPER_TOP = '#ff3d8b';
const BUMPER_SHADE = '#b81f5e';
const VOID = '#140e38';

/** World-space outline widths. */
const LINE_THICK = 0.14;
const LINE = 0.075;
const LINE_THIN = 0.045;

export const POWERUP_STYLE: Record<PowerupKind, { color: string; label: string }> = {
  rapid: { color: '#ffd93d', label: 'RAPID FIRE' },
  triple: { color: '#3ccf6e', label: 'TRIPLE SHOT' },
  mega: { color: '#ff8a3d', label: 'MEGA SHOT' },
  shield: { color: '#7fd8ff', label: 'SHIELD' },
  heal: { color: '#ff6fc1', label: 'HEAL' },
};

export interface ViewPlayer {
  id: PlayerId;
  x: number;
  y: number;
  aim: number;
  charge: number;
  damage: number;
  /** -1 while standing. */
  fallTime: number;
  /** Power-up bits (FX_*). */
  fx: number;
}

export interface ViewBullet {
  id: number;
  owner: PlayerId;
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
}

export interface ViewPowerup {
  id: number;
  kind: PowerupKind;
  x: number;
  y: number;
  age: number;
}

export interface View {
  phase: Phase;
  phaseTime: number;
  arenaRadius: number;
  mapIndex: number;
  shrinking: boolean;
  players: ViewPlayer[];
  bullets: ViewBullet[];
  powerups: ViewPowerup[];
  roster: RosterEntry[];
  roundWinner: PlayerId | null;
  matchWinner: PlayerId | null;
  myId: PlayerId | -1;
  /** True on the menu, before joining a room. */
  attract: boolean;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  drag: number;
}

interface Ring {
  x: number;
  y: number;
  r0: number;
  r1: number;
  life: number;
  maxLife: number;
  color: string;
}

/** Comic "POW" starburst. */
interface Pow {
  x: number;
  y: number;
  size: number;
  rot: number;
  life: number;
  maxLife: number;
  color: string;
}

/** Floating text such as "SHIELD!" after a pickup (world position). */
interface Popup {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
}

interface PlayerFx {
  squash: number;
  squashVel: number;
  squashAngle: number;
  trail: { x: number; y: number; age: number }[];
  lastX: number;
  lastY: number;
  speed: number;
  dmgPop: number;
}

interface Star {
  x: number;
  y: number;
  size: number;
  phase: number;
  depth: number;
}

export interface PlayerLook {
  base: string;
  shade: string;
  light: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Colour and shape helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
}

export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = clamp(t, 0, 1);
  return toHex(lerp(ca[0], cb[0], k), lerp(ca[1], cb[1], k), lerp(ca[2], cb[2], k));
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Base, shadow and highlight tones for a palette colour. */
export function paletteLook(color: number, name: string): PlayerLook {
  const base = C.PLAYER_PALETTE[color] ?? C.PLAYER_PALETTE[0];
  return { base, shade: mix(base, INK, 0.32), light: mix(base, '#ffffff', 0.6), name };
}

/** Spiky star outline, used for impact bursts and sparkles. */
function spikyPath(ctx: CanvasRenderingContext2D, x: number, y: number, outer: number, inner: number, points: number, rot: number): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rot + (i * Math.PI) / points;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** Arena outline path (circle or rounded square) at a given radius and vertical offset. */
function arenaPath(ctx: CanvasRenderingContext2D, map: MapDef, R: number, dy: number): void {
  ctx.beginPath();
  if (map.shape === 'circle') {
    ctx.arc(0, dy, R, 0, Math.PI * 2);
  } else {
    const h = R * C.SQUARE_HALF_SCALE;
    ctx.roundRect(-h, -h + dy, h * 2, h * 2, h * 0.14);
  }
}

export const FONT = '"Arial Black", "Arial Rounded MT Bold", "Helvetica Neue", Helvetica, system-ui, sans-serif';

/**
 * Paints a map in world units at the current transform: shadow, slab,
 * cel-shaded ice, holes and bumpers. Shared by the game and the thumbnails.
 */
function paintMap(ctx: CanvasRenderingContext2D, map: MapDef, R: number, rimFlash: boolean, time: number): void {
  const t = map.theme;
  const slab = 0.45;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Hard-edged drop shadow far below: the ice floats.
  ctx.save();
  ctx.translate(0.45, 1.5);
  ctx.fillStyle = 'rgba(8,4,24,0.45)';
  arenaPath(ctx, map, R * 1.01, 0);
  ctx.fill();
  ctx.restore();

  // Slab side: two flat tones and an ink outline.
  ctx.fillStyle = t.side;
  arenaPath(ctx, map, R, slab);
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = t.sideShade;
  ctx.fillRect(R * 0.35, -R * 2, R * 2, R * 4);
  ctx.restore();
  ctx.strokeStyle = INK;
  ctx.lineWidth = LINE_THICK;
  arenaPath(ctx, map, R, slab);
  ctx.stroke();

  // Top surface: shadow band, lit face, highlight streaks.
  ctx.save();
  arenaPath(ctx, map, R, 0);
  ctx.clip();
  ctx.fillStyle = t.shade;
  ctx.fillRect(-R * 1.5, -R * 1.5, R * 3, R * 3);
  ctx.fillStyle = t.top;
  ctx.save();
  ctx.translate(-R * 0.07, -R * 0.09);
  arenaPath(ctx, map, R * 0.97, 0);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.32;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.8, Math.PI * 1.08, Math.PI * 1.32);
  ctx.stroke();
  ctx.lineWidth = 0.18;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.8, Math.PI * 1.38, Math.PI * 1.44);
  ctx.stroke();
  ctx.lineWidth = 0.14;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.66, Math.PI * 1.12, Math.PI * 1.24);
  ctx.stroke();

  // Holes: you can see the far wall of the slab inside each one.
  const s = mapScale(R);
  for (const hole of map.holes) {
    const hx = hole.x * s;
    const hy = hole.y * s;
    const hr = hole.r * s;
    ctx.save();
    ctx.beginPath();
    ctx.arc(hx, hy, hr, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = t.sideShade;
    ctx.fillRect(hx - hr, hy - hr, hr * 2, hr * 2);
    ctx.fillStyle = VOID;
    ctx.beginPath();
    ctx.arc(hx, hy + slab * s + 0.1, hr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = INK;
    ctx.lineWidth = LINE;
    ctx.beginPath();
    ctx.arc(hx, hy, hr, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // Bright rim inside the ink outline. It flashes red while the arena shrinks.
  const on = rimFlash && Math.sin(time * 10) > 0;
  ctx.strokeStyle = on ? '#ff3b4e' : '#ffffff';
  ctx.lineWidth = on ? 0.2 : 0.12;
  arenaPath(ctx, map, R - LINE_THICK / 2 - (on ? 0.1 : 0.06), 0);
  ctx.stroke();
  ctx.strokeStyle = INK;
  ctx.lineWidth = LINE_THICK;
  arenaPath(ctx, map, R, 0);
  ctx.stroke();

  // Bumpers: chunky yellow posts.
  for (const b of scaledBumpers(map, R)) {
    const post = 0.3 * s + 0.08;
    ctx.fillStyle = rgba(INK, 0.25);
    ctx.beginPath();
    ctx.ellipse(b.x + 0.12, b.y + post + 0.12, b.r, b.r * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = BUMPER_SHADE;
    ctx.strokeStyle = INK;
    ctx.lineWidth = LINE;
    ctx.beginPath();
    ctx.arc(b.x, b.y + post, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = BUMPER_TOP;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Pinball-bumper rings, so they never look like a power-up.
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = b.r * 0.16;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = LINE_THIN;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

/** A square thumbnail of a map, for carousels. */
export function makeMapThumb(index: number, px: number): HTMLCanvasElement {
  const map = MAPS[index] ?? MAPS[0];
  const cv = document.createElement('canvas');
  cv.width = px;
  cv.height = px;
  const ctx = cv.getContext('2d');
  if (!ctx) return cv;
  ctx.fillStyle = '#261c66';
  ctx.fillRect(0, 0, px, px);
  const k = px / (2 * (C.ARENA_START_RADIUS + 1.4));
  ctx.setTransform(k, 0, 0, k, px / 2 - 0.2 * k, px / 2 - 0.5 * k);
  paintMap(ctx, map, C.ARENA_START_RADIUS, false, 0);
  return cv;
}

/** Carousel position (in cards travelled) during the map pick. Integer = a card is centred. */
export function carouselPosition(phaseTime: number, target: number): { pos: number; done: boolean } {
  const n = MAPS.length;
  const u = clamp(phaseTime / (C.MAP_PICK_TIME * 0.72), 0, 1);
  const e = 1 - Math.pow(1 - u, 3);
  return { pos: e * (3 * n + target), done: u >= 1 };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private scale = 1;
  private cx = 0;
  private cy = 0;
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

  private readonly stars: Star[] = [];
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private pows: Pow[] = [];
  private popups: Popup[] = [];
  private readonly fx = new Map<PlayerId, PlayerFx>();
  private readonly thumbs = new Map<number, HTMLCanvasElement>();
  private looks = new Map<PlayerId, PlayerLook>();
  private trauma = 0;
  private flash = 0;
  private time = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not supported');
    this.ctx = ctx;

    let seed = 7;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 120; i++) {
      this.stars.push({ x: rand(), y: rand(), size: 1 + rand() * 2.2, phase: rand() * Math.PI * 2, depth: 0.2 + rand() * 0.8 });
    }
    this.resize();
  }

  setInsets(insets: Insets): void {
    this.insets = insets;
    this.layout();
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.layout();
  }

  private layout(): void {
    const { top, right, bottom, left } = this.insets;
    const w = Math.max(100, this.width - left - right);
    const h = Math.max(100, this.height - top - bottom);
    // Fit the largest arena plus room for the slab edge and labels.
    this.scale = Math.min(w, h) / (2 * (C.ARENA_START_RADIUS + 1.2));
    this.cx = left + w / 2;
    this.cy = top + h / 2;
  }

  private fxFor(id: PlayerId): PlayerFx {
    let f = this.fx.get(id);
    if (!f) {
      f = { squash: 0, squashVel: 0, squashAngle: 0, trail: [], lastX: 0, lastY: 0, speed: 0, dmgPop: 0 };
      this.fx.set(id, f);
    }
    return f;
  }

  private look(id: PlayerId): PlayerLook {
    return this.looks.get(id) ?? paletteLook(id % C.PLAYER_PALETTE.length, `P${id + 1}`);
  }

  private thumb(index: number): HTMLCanvasElement {
    let t = this.thumbs.get(index);
    if (!t) {
      t = makeMapThumb(index, 240);
      this.thumbs.set(index, t);
    }
    return t;
  }

  // -------------------------------------------------------------------------
  // Effects, driven by simulation events
  // -------------------------------------------------------------------------

  /** Reacts to an event. Returns true for a heavy hit so the caller can hit-stop. */
  onEvent(ev: GameEvent, view: View): boolean {
    const find = (id: PlayerId): ViewPlayer | undefined => view.players.find((p) => p.id === id);
    switch (ev.k) {
      case 'fire': {
        const f = this.fxFor(ev.p);
        f.squashAngle = ev.a;
        f.squashVel -= 5 + 7 * ev.c;
        this.burst(ev.x, ev.y, 4 + Math.round(6 * ev.c), '#ffffff', 3 + 5 * ev.c, ev.a, 0.7, 0.07, 0.22);
        this.burst(ev.x, ev.y, 3 + Math.round(5 * ev.c), YELLOW, 2 + 4 * ev.c, ev.a, 1, 0.08, 0.3);
        if (ev.c > 0.6) this.pows.push({ x: ev.x, y: ev.y, size: 0.25 + 0.2 * ev.c, rot: ev.a, life: 0.12, maxLife: 0.12, color: '#ffffff' });
        this.addTrauma(ev.p === view.myId ? 0.08 + 0.2 * ev.c : 0.04 + 0.08 * ev.c);
        return false;
      }
      case 'hit': {
        const f = this.fxFor(ev.p);
        f.squashAngle = ev.a;
        f.squashVel -= 4 + ev.f * 0.7;
        f.dmgPop = 1;
        const heavy = ev.f >= C.HEAVY_HIT_IMPULSE;
        const n = 8 + Math.round(ev.f * 1.2);
        this.burst(ev.x, ev.y, n, this.look(ev.p).base, 3 + ev.f * 0.5, ev.a, 1.3, 0.1, 0.45);
        this.burst(ev.x, ev.y, Math.round(n / 2), '#ffffff', 4 + ev.f * 0.4, ev.a, 1.8, 0.07, 0.3);
        this.pows.push({
          x: ev.x,
          y: ev.y,
          size: 0.45 + ev.f * 0.045,
          rot: Math.random() * Math.PI,
          life: heavy ? 0.3 : 0.2,
          maxLife: heavy ? 0.3 : 0.2,
          color: heavy ? YELLOW : '#ffffff',
        });
        this.rings.push({ x: ev.x, y: ev.y, r0: 0.2, r1: 0.8 + ev.f * 0.08, life: 0.28, maxLife: 0.28, color: '#ffffff' });
        this.addTrauma(Math.min(0.9, 0.12 + ev.f * 0.04));
        return heavy;
      }
      case 'block':
        this.burst(ev.x, ev.y, 12, POWERUP_STYLE.shield.color, 5, 0, Math.PI * 2, 0.08, 0.35);
        this.rings.push({ x: ev.x, y: ev.y, r0: 0.3, r1: 1.4, life: 0.35, maxLife: 0.35, color: POWERUP_STYLE.shield.color });
        this.popupAt(ev.p, view, 'BLOCKED!', POWERUP_STYLE.shield.color);
        this.addTrauma(0.15);
        return false;
      case 'cancel':
        this.burst(ev.x, ev.y, 12, '#e6f8ff', 5, 0, Math.PI * 2, 0.08, 0.3);
        this.pows.push({ x: ev.x, y: ev.y, size: ev.r + 0.35, rot: Math.random(), life: 0.18, maxLife: 0.18, color: '#bfeaff' });
        this.addTrauma(0.1);
        return false;
      case 'bump': {
        for (const id of [ev.p, ev.q]) {
          if (id < 0) continue;
          const f = this.fxFor(id);
          f.squashAngle = ev.a;
          f.squashVel -= 3 + ev.f * 0.8;
        }
        if (ev.q < 0) this.rings.push({ x: ev.x, y: ev.y, r0: 0.3, r1: 1.2, life: 0.25, maxLife: 0.25, color: YELLOW });
        this.burst(ev.x, ev.y, 7, '#ffffff', 2 + ev.f * 0.3, ev.a + Math.PI / 2, Math.PI * 2, 0.07, 0.3);
        this.addTrauma(Math.min(0.5, 0.05 + ev.f * 0.03));
        return false;
      }
      case 'fall': {
        const p = find(ev.p);
        const x = p?.x ?? ev.x;
        const y = p?.y ?? ev.y;
        this.burst(x, y, 16, '#dff6ff', 3, Math.atan2(y, x), 1.4, 0.09, 0.55);
        this.addTrauma(view.phase === 'lobby' ? 0.15 : 0.35);
        return false;
      }
      case 'respawn': {
        const p = find(ev.p);
        if (p) this.rings.push({ x: p.x, y: p.y, r0: 0.2, r1: 1.2, life: 0.35, maxLife: 0.35, color: this.look(ev.p).base });
        return false;
      }
      case 'spawn':
        this.rings.push({ x: ev.x, y: ev.y, r0: 0.1, r1: 1.1, life: 0.4, maxLife: 0.4, color: POWERUP_STYLE[ev.u].color });
        this.burst(ev.x, ev.y, 8, POWERUP_STYLE[ev.u].color, 3, 0, Math.PI * 2, 0.07, 0.35);
        return false;
      case 'pickup': {
        const style = POWERUP_STYLE[ev.u];
        this.burst(ev.x, ev.y, 14, style.color, 4, 0, Math.PI * 2, 0.09, 0.4);
        this.pows.push({ x: ev.x, y: ev.y, size: 0.6, rot: 0, life: 0.2, maxLife: 0.2, color: style.color });
        this.popupAt(ev.p, view, `${style.label}!`, style.color);
        return false;
      }
      case 'ko':
        if (view.phase !== 'lobby') {
          this.flash = 0.5;
          this.addTrauma(0.6);
        }
        return false;
    }
  }

  private popupAt(id: PlayerId, view: View, text: string, color: string): void {
    const p = view.players.find((q) => q.id === id);
    if (p) this.popups.push({ x: p.x, y: p.y - 1.2, text, color, life: 1, maxLife: 1 });
  }

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  private burst(x: number, y: number, count: number, color: string, speed: number, angle: number, spread: number, size: number, life: number): void {
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * spread;
      const s = speed * (0.35 + Math.random() * 0.9);
      const l = life * (0.5 + Math.random() * 0.7);
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: l,
        maxLife: l,
        size: size * (0.6 + Math.random() * 0.9),
        color,
        drag: 3 + Math.random() * 2,
      });
    }
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  /**
   * Draws a frame. `dt` is the effects time step (0 during hit-stop) and
   * `realDt` is wall-clock time, used for things that should never freeze.
   */
  draw(view: View, dt: number, realDt: number): void {
    this.time += realDt;
    this.looks = new Map(view.roster.map((r) => [r.id, paletteLook(r.color, r.name)]));
    this.update(view, dt, realDt);

    const ctx = this.ctx;
    const shake = this.trauma * this.trauma * C.SHAKE_MAX_PX;
    const sx = shake * Math.sin(this.time * 71.3) * Math.cos(this.time * 13.1);
    const sy = shake * Math.cos(this.time * 63.7) * Math.sin(this.time * 17.9);

    this.drawBackground(sx * 0.3, sy * 0.3);

    // World space: 1 unit = this.scale CSS pixels.
    const k = this.scale * this.dpr;
    ctx.setTransform(k, 0, 0, k, (this.cx + sx) * this.dpr, (this.cy + sy) * this.dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const map = MAPS[view.mapIndex] ?? MAPS[0];
    const standing = view.players.filter((p) => p.fallTime < 0);
    // Falling players drop "under" the ice, so draw them first.
    for (const p of view.players) if (p.fallTime >= 0) this.drawPlayer(view, p);
    paintMap(ctx, map, view.arenaRadius, view.shrinking, this.time);
    if (!view.attract && view.arenaRadius > C.ARENA_END_RADIUS + 0.05 && view.phase !== 'lobby') {
      // Where the arena will end up.
      ctx.setLineDash([0.2, 0.25]);
      ctx.strokeStyle = rgba(INK, 0.22);
      ctx.lineWidth = 0.07;
      arenaPath(ctx, map, C.ARENA_END_RADIUS, 0);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    this.drawPowerups(view);
    for (const p of standing) this.drawShadow(p);
    for (const p of standing) this.drawTrail(p.id);
    for (const p of standing) this.drawPlayer(view, p);
    this.drawBullets(view);
    this.drawParticles();

    // Screen space.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, sx * this.dpr, sy * this.dpr);
    if (!view.attract) {
      for (const p of standing) this.drawLabels(view, p);
      this.drawPopups();
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawVignette();
    if (!view.attract) this.drawHud(view);
    if (view.phase === 'mapPick') this.drawCarousel(view);
    if (this.flash > 0.001) {
      ctx.fillStyle = `rgba(255,250,230,${this.flash})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  private update(view: View, dt: number, realDt: number): void {
    this.trauma = Math.max(0, this.trauma - C.SHAKE_DECAY * realDt);
    this.flash = Math.max(0, this.flash - 2.5 * realDt);

    for (const p of this.particles) {
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const r of this.rings) r.life -= dt;
    this.rings = this.rings.filter((r) => r.life > 0);
    for (const p of this.pows) p.life -= dt;
    this.pows = this.pows.filter((p) => p.life > 0);
    for (const p of this.popups) {
      p.life -= realDt;
      p.y -= realDt * 0.8;
    }
    this.popups = this.popups.filter((p) => p.life > 0);

    for (const p of view.players) {
      const f = this.fxFor(p.id);
      // Springy squash and stretch, substepped so slow frames stay stable.
      for (let rem = dt; rem > 0; rem -= 1 / 120) {
        const h = Math.min(rem, 1 / 120);
        f.squashVel += (-320 * f.squash - 16 * f.squashVel) * h;
        f.squash = clamp(f.squash + f.squashVel * h, -0.35, 0.35);
      }
      f.dmgPop = Math.max(0, f.dmgPop - dt * 4);

      if (dt > 0) {
        const inst = Math.hypot(p.x - f.lastX, p.y - f.lastY) / dt;
        f.speed = inst > 60 ? f.speed : lerp(f.speed, inst, 0.3); // ignore teleports (respawns, new rounds)
        if (inst > 60) f.trail = [];
        f.lastX = p.x;
        f.lastY = p.y;
        for (const t of f.trail) t.age += dt;
        f.trail = f.trail.filter((t) => t.age < 0.2);
        if (f.speed > C.TRAIL_MIN_SPEED && p.fallTime < 0) f.trail.push({ x: p.x, y: p.y, age: 0 });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Scenery
  // -------------------------------------------------------------------------

  private drawBackground(ox: number, oy: number): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = VOID;
    ctx.fillRect(0, 0, this.width, this.height);

    // Flat, hard-edged bands of colour instead of a smooth gradient.
    const m = Math.max(this.width, this.height);
    ['#1a1348', '#201757', '#261c66'].forEach((color, n) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(this.width / 2, this.height * 0.5, m * (0.85 - n * 0.2), 0, Math.PI * 2);
      ctx.fill();
    });

    for (const s of this.stars) {
      const tw = 0.5 + 0.5 * Math.sin(this.time * (0.8 + s.depth) + s.phase);
      const x = s.x * this.width + ox * s.depth;
      const y = s.y * this.height + oy * s.depth;
      if (s.size > 2.6) {
        const r = s.size * (1.2 + 0.8 * tw);
        ctx.fillStyle = '#fff3b0';
        spikyPath(ctx, x, y, r, r * 0.3, 4, 0);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(220,215,255,${0.3 + 0.5 * tw * s.depth})`;
        ctx.beginPath();
        ctx.arc(x, y, s.size * 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawVignette(): void {
    const ctx = this.ctx;
    const r = Math.hypot(this.width, this.height) / 2;
    const g = ctx.createRadialGradient(this.width / 2, this.height / 2, r * 0.6, this.width / 2, this.height / 2, r);
    g.addColorStop(0, 'rgba(10,6,30,0)');
    g.addColorStop(1, 'rgba(10,6,30,0.45)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  // -------------------------------------------------------------------------
  // Power-ups, players and bullets
  // -------------------------------------------------------------------------

  private drawPowerups(view: View): void {
    const ctx = this.ctx;
    for (const u of view.powerups) {
      // Blink when about to vanish.
      if (u.age > C.POWERUP_LIFETIME - 3 && Math.floor(this.time * 7) % 2 === 0) continue;
      const pop = u.age < 0.35 ? 1 + Math.sin((u.age / 0.35) * Math.PI) * 0.35 : 1;
      const r = C.POWERUP_RADIUS * pop * Math.min(1, u.age * 6 + 0.2);
      const bob = Math.sin(this.time * 4 + u.id) * 0.08;
      const x = u.x;
      const y = u.y + bob;
      const style = POWERUP_STYLE[u.kind];

      ctx.fillStyle = rgba(INK, 0.25);
      ctx.beginPath();
      ctx.ellipse(u.x + 0.08, u.y + 0.22, r * 0.9, r * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = style.color;
      ctx.strokeStyle = INK;
      ctx.lineWidth = LINE;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      ctx.ellipse(x - r * 0.35, y - r * 0.4, r * 0.25, r * 0.14, -0.7, 0, Math.PI * 2);
      ctx.fill();
      this.drawPowerupIcon(u.kind, x, y, r * 0.62);
    }
  }

  /** Little icon for each power-up kind, drawn with shapes. */
  private drawPowerupIcon(kind: PowerupKind, x: number, y: number, s: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = INK;
    ctx.lineWidth = LINE_THIN;
    ctx.beginPath();
    switch (kind) {
      case 'rapid': // lightning bolt
        ctx.moveTo(x + s * 0.15, y - s);
        ctx.lineTo(x - s * 0.55, y + s * 0.15);
        ctx.lineTo(x - s * 0.05, y + s * 0.15);
        ctx.lineTo(x - s * 0.2, y + s);
        ctx.lineTo(x + s * 0.55, y - s * 0.2);
        ctx.lineTo(x + s * 0.05, y - s * 0.2);
        ctx.closePath();
        break;
      case 'triple': // three dots in a fan
        for (const a of [-0.6, 0, 0.6]) {
          ctx.moveTo(x + Math.sin(a) * s * 0.7 + s * 0.3, y - Math.cos(a) * s * 0.55);
          ctx.arc(x + Math.sin(a) * s * 0.7, y - Math.cos(a) * s * 0.55, s * 0.3, 0, Math.PI * 2);
        }
        ctx.moveTo(x + s * 0.25, y + s * 0.55);
        ctx.arc(x, y + s * 0.55, s * 0.25, 0, Math.PI * 2);
        break;
      case 'mega': // big star
        spikyPath(ctx, x, y, s, s * 0.45, 5, -Math.PI / 2);
        break;
      case 'shield': // shield crest
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s * 0.8, y - s * 0.6);
        ctx.quadraticCurveTo(x + s * 0.75, y + s * 0.5, x, y + s);
        ctx.quadraticCurveTo(x - s * 0.75, y + s * 0.5, x - s * 0.8, y - s * 0.6);
        ctx.closePath();
        break;
      case 'heal': {
        // Plus sign as one outline, so no lines cross in the middle.
        const t = s * 0.35;
        const pts: [number, number][] = [
          [-t, -s], [t, -s], [t, -t], [s, -t], [s, t], [t, t],
          [t, s], [-t, s], [-t, t], [-s, t], [-s, -t], [-t, -t],
        ];
        pts.forEach(([px, py], n) => (n === 0 ? ctx.moveTo(x + px, y + py) : ctx.lineTo(x + px, y + py)));
        ctx.closePath();
        break;
      }
    }
    ctx.fill();
    ctx.stroke();
  }

  private drawShadow(p: ViewPlayer): void {
    const ctx = this.ctx;
    ctx.fillStyle = rgba(INK, 0.22);
    ctx.beginPath();
    ctx.ellipse(p.x + 0.12, p.y + 0.2, C.PLAYER_RADIUS, C.PLAYER_RADIUS * 0.82, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawTrail(id: PlayerId): void {
    const f = this.fxFor(id);
    if (f.trail.length < 2) return;
    const ctx = this.ctx;
    ctx.strokeStyle = rgba(this.look(id).light, 0.55);
    for (let n = 1; n < f.trail.length; n++) {
      const a = f.trail[n - 1];
      const b = f.trail[n];
      const k = 1 - b.age / 0.2;
      ctx.lineWidth = C.PLAYER_RADIUS * 1.6 * k;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  private drawPlayer(view: View, p: ViewPlayer): void {
    const ctx = this.ctx;
    const f = this.fxFor(p.id);
    const look = this.look(p.id);
    const R = C.PLAYER_RADIUS;
    const falling = p.fallTime >= 0;
    const ft = falling ? clamp(p.fallTime / C.FALL_DURATION, 0, 1) : 0;
    if (ft >= 1) return;
    const size = 1 - ft * 0.85;
    const spin = ft * ft * 14;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = 1 - ft;

    if (!falling && p.id === view.myId) {
      // "You" marker: a marching dashed ring.
      ctx.strokeStyle = look.base;
      ctx.lineWidth = 0.08;
      ctx.setLineDash([0.16, 0.14]);
      ctx.lineDashOffset = -this.time * 0.5;
      ctx.beginPath();
      ctx.arc(0, 0, R + 0.32, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Rapid Fire: little sparks orbiting the player.
    if (!falling && p.fx & FX_RAPID) {
      ctx.fillStyle = POWERUP_STYLE.rapid.color;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 0.03;
      for (let n = 0; n < 3; n++) {
        const a = this.time * 5 + (n * Math.PI * 2) / 3;
        spikyPath(ctx, Math.cos(a) * (R + 0.45), Math.sin(a) * (R + 0.45), 0.13, 0.05, 4, a);
        ctx.fill();
        ctx.stroke();
      }
    }

    // Squash and stretch along the last impulse axis.
    const rel = f.squashAngle;
    ctx.rotate(rel);
    ctx.scale((1 + f.squash) * size, (1 - f.squash * 0.7) * size);
    ctx.rotate(-rel);

    // Barrel(s): grow and turn white as you charge.
    const c = p.charge;
    const mega = (p.fx & FX_MEGA) !== 0;
    const spreads = p.fx & FX_TRIPLE ? [-C.TRIPLE_SPREAD * 1.4, C.TRIPLE_SPREAD * 1.4, 0] : [0];
    for (const spread of spreads) {
      ctx.save();
      ctx.rotate(p.aim + spin + spread);
      const side = spread !== 0;
      const barrelLen = R + (side ? 0.2 : 0.32) + 0.3 * c;
      const bw = (side ? 0.09 : 0.14) + 0.05 * c + (mega ? 0.06 : 0);
      ctx.fillStyle = mix(mega ? POWERUP_STYLE.mega.color : '#3b3160', '#ffffff', c);
      ctx.strokeStyle = INK;
      ctx.lineWidth = LINE;
      ctx.beginPath();
      ctx.roundRect(0, -bw, barrelLen, bw * 2, 0.07);
      ctx.fill();
      ctx.stroke();
      if (c > 0.02 && !side) {
        const pulse = c >= 1 ? 1 + 0.18 * Math.sin(this.time * 30) : 1;
        ctx.fillStyle = c >= 1 ? YELLOW : '#ffffff';
        spikyPath(ctx, barrelLen + 0.05, 0, bw * (1.1 + 0.9 * c) * pulse, bw * 0.6 * pulse, 6, this.time * 4);
        ctx.fill();
        ctx.lineWidth = LINE_THIN;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Body: flat shadow tone, lit tone offset toward the light, a hard highlight.
    ctx.save();
    ctx.rotate(spin);
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = look.shade;
    ctx.fillRect(-R, -R, R * 2, R * 2);
    ctx.fillStyle = look.base;
    ctx.beginPath();
    ctx.arc(-R * 0.16, -R * 0.2, R * 0.93, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = look.light;
    ctx.beginPath();
    ctx.ellipse(-R * 0.42, -R * 0.46, R * 0.2, R * 0.12, -0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = INK;
    ctx.lineWidth = LINE;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Big cartoon eyes that look where you aim.
    ctx.save();
    ctx.rotate(p.aim + spin);
    for (const side of [-1, 1]) {
      const ea = side * 0.55;
      const ex = Math.cos(ea) * R * 0.45;
      const ey = Math.sin(ea) * R * 0.45;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = INK;
      ctx.lineWidth = LINE_THIN;
      ctx.beginPath();
      ctx.ellipse(ex, ey, R * 0.27, R * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (falling) {
        ctx.lineWidth = 0.06;
        const s = R * 0.13;
        ctx.beginPath();
        ctx.moveTo(ex - s, ey - s);
        ctx.lineTo(ex + s, ey + s);
        ctx.moveTo(ex + s, ey - s);
        ctx.lineTo(ex - s, ey + s);
        ctx.stroke();
      } else {
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.arc(ex + R * 0.1, ey, R * 0.14, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(ex + R * 0.06, ey - R * 0.05, R * 0.05, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // Charge ring: ink under white, like a comic power meter.
    if (c > 0.02 && !falling) {
      const a0 = p.aim - Math.PI * c;
      const a1 = p.aim + Math.PI * c;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 0.14;
      ctx.beginPath();
      ctx.arc(0, 0, R + 0.16, a0, a1);
      ctx.stroke();
      ctx.strokeStyle = c >= 1 ? YELLOW : '#ffffff';
      ctx.lineWidth = 0.07;
      ctx.beginPath();
      ctx.arc(0, 0, R + 0.16, a0, a1);
      ctx.stroke();
    }

    // Shield bubble.
    if (!falling && p.fx & FX_SHIELD) {
      const wob = 1 + 0.04 * Math.sin(this.time * 6);
      ctx.fillStyle = rgba(POWERUP_STYLE.shield.color, 0.22);
      ctx.strokeStyle = POWERUP_STYLE.shield.color;
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.arc(0, 0, (R + 0.24) * wob, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.07;
      ctx.beginPath();
      ctx.arc(0, 0, (R + 0.1) * wob, Math.PI * 1.1, Math.PI * 1.4);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawBullets(view: View): void {
    const ctx = this.ctx;
    for (const b of view.bullets) {
      const look = this.look(b.owner);
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 0.1) {
        const nx = b.vx / sp;
        const ny = b.vy / sp;
        const len = Math.min(1.3, sp * 0.06);
        ctx.strokeStyle = rgba(look.light, 0.8);
        ctx.lineWidth = b.r * 0.9;
        ctx.beginPath();
        ctx.moveTo(b.x - nx * (b.r + len), b.y - ny * (b.r + len));
        ctx.lineTo(b.x - nx * b.r * 0.5, b.y - ny * b.r * 0.5);
        ctx.stroke();
      }
      ctx.fillStyle = look.base;
      ctx.strokeStyle = INK;
      ctx.lineWidth = LINE_THIN + b.r * 0.12;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    for (const r of this.rings) {
      const k = 1 - r.life / r.maxLife;
      const rad = lerp(r.r0, r.r1, 1 - (1 - k) * (1 - k));
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 0.12;
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 0.06;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const p of this.pows) {
      const k = 1 - p.life / p.maxLife;
      const s = p.size * (k < 0.3 ? 0.6 + (k / 0.3) * 0.5 : 1.1 - (k - 0.3) * 0.6);
      ctx.fillStyle = p.color;
      ctx.strokeStyle = INK;
      ctx.lineWidth = LINE;
      spikyPath(ctx, p.x, p.y, s, s * 0.5, 9, p.rot);
      ctx.fill();
      ctx.stroke();
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = LINE_THIN * 0.8;
    for (const p of this.particles) {
      const k = p.life / p.maxLife;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.3 + 0.7 * k), 0, Math.PI * 2);
      ctx.fill();
      if (p.size > 0.07) ctx.stroke();
    }
  }

  // -------------------------------------------------------------------------
  // Text and HUD (screen space, CSS pixels)
  // -------------------------------------------------------------------------

  /** Chunky outlined text with a hard offset shadow. */
  private toonText(text: string, x: number, y: number, size: number, fill: string, align: CanvasTextAlign = 'center'): void {
    const ctx = this.ctx;
    ctx.font = `900 ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const stroke = Math.max(3, size * 0.16);
    const off = Math.max(2, size * 0.07);
    ctx.lineWidth = stroke;
    ctx.strokeStyle = INK;
    ctx.fillStyle = INK;
    ctx.strokeText(text, x + off, y + off);
    ctx.fillText(text, x + off, y + off);
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  private toScreen(x: number, y: number): [number, number] {
    return [this.cx + x * this.scale, this.cy + y * this.scale];
  }

  /** Damage above each player, name below. */
  private drawLabels(view: View, p: ViewPlayer): void {
    const f = this.fxFor(p.id);
    const look = this.look(p.id);
    const [x, yTop] = this.toScreen(p.x, p.y - C.PLAYER_RADIUS - 0.6);
    const [, yBottom] = this.toScreen(p.x, p.y + C.PLAYER_RADIUS + 0.55);
    const size = Math.max(12, this.scale * 0.42) * (1 + 0.5 * f.dmgPop);
    this.toonText(`${Math.round(p.damage)}%`, x, yTop, size, mix('#ffffff', '#ff2d3d', p.damage / 150));
    const name = p.id === view.myId ? 'YOU' : look.name.toUpperCase();
    this.toonText(name, x, yBottom, Math.max(10, this.scale * 0.27), look.light);
  }

  private drawPopups(): void {
    for (const p of this.popups) {
      const [x, y] = this.toScreen(p.x, p.y);
      const k = p.life / p.maxLife;
      this.ctx.globalAlpha = Math.min(1, k * 3);
      this.toonText(p.text, x, y, Math.max(12, this.scale * 0.36) * (k > 0.85 ? 1 + (k - 0.85) * 3 : 1), p.color);
    }
    this.ctx.globalAlpha = 1;
  }

  private drawHud(view: View): void {
    const w = this.width;
    const top = 12;

    if (view.phase === 'lobby') {
      this.toonText('WARM-UP', w / 2, top + 20, 20, YELLOW);
      return;
    }

    // Scoreboard: one badge per seated player.
    const ctx = this.ctx;
    const entries = view.roster;
    const n = Math.max(1, entries.length);
    const bw = clamp((w - 120) / n - 8, 34, 64);
    const bh = bw * 0.9;
    const total = n * bw + (n - 1) * 8;
    let x = w / 2 - total / 2;
    for (const r of entries) {
      const look = this.look(r.id);
      const lead = view.phase === 'matchEnd' && view.matchWinner === r.id;
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.roundRect(x + 3, top + 4, bw, bh, 10);
      ctx.fill();
      ctx.fillStyle = r.online ? look.base : '#6b6385';
      ctx.strokeStyle = lead ? YELLOW : INK;
      ctx.lineWidth = lead ? 4 : 3;
      ctx.beginPath();
      ctx.roundRect(x, top, bw, bh, 10);
      ctx.fill();
      ctx.stroke();
      this.toonText(String(r.score), x + bw / 2, top + bh / 2, bw * 0.5, '#ffffff');
      const label = r.id === view.myId ? 'YOU' : r.name.slice(0, 7).toUpperCase();
      this.toonText(label, x + bw / 2, top + bh + 13, 10, r.id === view.myId ? YELLOW : '#e6e0ff');
      x += bw + 8;
    }

    const myIn = view.players.some((p) => p.id === view.myId);
    if (!myIn) {
      const msg = view.myId === -1 ? 'SPECTATING' : "SPECTATING: YOU'LL JOIN NEXT ROUND";
      this.toonText(msg, w / 2, top + bh + 34, 12, '#e6e0ff');
    }

    // Centre banners. Placed above the middle so they don't cover players.
    const bannerY = this.cy - this.scale * 2.4;
    const map = MAPS[view.mapIndex] ?? MAPS[0];
    const nameOf = (id: PlayerId): string => (id === view.myId ? 'YOU' : this.look(id).name.toUpperCase());
    if (view.phase === 'countdown') {
      const cnt = Math.max(1, Math.ceil(C.COUNTDOWN_TIME - view.phaseTime));
      const frac = C.COUNTDOWN_TIME - view.phaseTime - (cnt - 1); // 1 -> 0 within each number
      const numSize = clamp(Math.min(w, this.height) * 0.12, 34, 100);
      this.toonText(map.name.toUpperCase(), w / 2, bannerY - numSize * 0.9, clamp(numSize * 0.3, 13, 24), YELLOW);
      this.banner(String(cnt), '#ffffff', bannerY, 1 + 0.5 * Math.pow(frac, 6), 0.4 + 0.6 * Math.min(1, frac * 3), null);
    } else if (view.phase === 'playing' && view.phaseTime < C.FIGHT_BANNER_TIME) {
      const k = view.phaseTime / C.FIGHT_BANNER_TIME;
      this.banner('FIGHT!', YELLOW, bannerY, 1.3 - 0.3 * Math.min(1, k * 4), 1 - Math.pow(k, 3), '#ff5a5f');
    } else if (view.phase === 'roundEnd' && view.roundWinner !== null) {
      const pop = Math.min(1, view.phaseTime * 5);
      if (view.roundWinner === -1) this.banner('NO SURVIVORS!', '#ffffff', bannerY, 0.6 + 0.4 * pop, pop, YELLOW);
      else {
        const who = view.roundWinner;
        this.banner(who === view.myId ? 'YOU SCORE!' : `${nameOf(who)} SCORES!`, this.look(who).base, bannerY, 0.6 + 0.4 * pop, pop, YELLOW);
      }
    } else if (view.phase === 'matchEnd' && view.matchWinner !== null) {
      const pop = Math.min(1, view.phaseTime * 4);
      const who = view.matchWinner;
      const title = who === view.myId ? 'YOU WIN!' : `${nameOf(who)} WINS!`;
      this.banner(title, this.look(who).base, bannerY, (0.7 + 0.3 * pop) * (1 + 0.04 * Math.sin(this.time * 4)), pop, YELLOW);
      const left = Math.max(0, Math.ceil(C.MATCH_END_TIME - view.phaseTime));
      this.toonText(`BACK TO LOBBY IN ${left}`, w / 2, bannerY + this.scale * 2, 16, '#ffffff');
    }
  }

  /** Big tilted comic banner, optionally with a starburst behind it. */
  private banner(text: string, color: string, y: number, scale: number, alpha: number, burst: string | null): void {
    const ctx = this.ctx;
    let size = clamp(Math.min(this.width, this.height) * 0.12, 34, 100) * scale;
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.translate(this.width / 2, y);
    ctx.rotate(-0.06);
    ctx.font = `900 ${size}px ${FONT}`;
    // Shrink long names so the banner always fits on screen.
    const maxW = this.width * 0.9;
    const measured = ctx.measureText(text).width;
    if (measured > maxW) size *= maxW / measured;
    if (burst) {
      ctx.font = `900 ${size}px ${FONT}`;
      const tw = ctx.measureText(text).width;
      ctx.save();
      ctx.scale(1, 0.55);
      ctx.fillStyle = burst;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 5;
      spikyPath(ctx, 0, 0, tw * 0.62 + size * 0.5, tw * 0.5 + size * 0.2, 14, this.time * 0.6);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    this.toonText(text, 0, 0, size, color);
    ctx.restore();
  }

  /** The spinning map carousel shown before each round. */
  private drawCarousel(view: View): void {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const n = MAPS.length;
    const { pos, done } = carouselPosition(view.phaseTime, view.mapIndex);

    ctx.fillStyle = rgba(INK, 0.6);
    ctx.fillRect(0, 0, w, h);

    const cw = clamp(Math.min(w * 0.34, h * 0.32), 110, 220);
    const ch = cw * 1.22;
    const gap = cw * 0.14;
    const step = cw + gap;
    const cy = h / 2;
    this.toonText(done ? 'NEXT MAP!' : 'SPINNING…', w / 2, cy - ch * 0.58 - 48, clamp(w * 0.05, 18, 34), '#ffffff');

    const first = Math.floor(pos - w / 2 / step) - 1;
    const last = Math.ceil(pos + w / 2 / step) + 1;
    for (let k = first; k <= last; k++) {
      const idx = ((k % n) + n) % n;
      const x = w / 2 + (k - pos) * step;
      const centre = Math.abs(k - pos) < 0.5;
      const chosen = done && centre;
      const sc = chosen ? 1.08 + 0.03 * Math.sin(this.time * 8) : centre ? 1.02 : 0.9;
      ctx.save();
      ctx.translate(x, cy);
      ctx.scale(sc, sc);
      ctx.rotate(chosen ? -0.03 : 0);
      // Card with a hard shadow.
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.roundRect(-cw / 2 + 6, -ch / 2 + 7, cw, ch, 16);
      ctx.fill();
      ctx.fillStyle = chosen ? YELLOW : '#fff6e0';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.roundRect(-cw / 2, -ch / 2, cw, ch, 16);
      ctx.fill();
      ctx.stroke();
      const pad = cw * 0.08;
      const img = cw - pad * 2;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(-img / 2, -ch / 2 + pad, img, img, 10);
      ctx.clip();
      ctx.drawImage(this.thumb(idx), -img / 2, -ch / 2 + pad, img, img);
      ctx.restore();
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(-img / 2, -ch / 2 + pad, img, img, 10);
      ctx.stroke();
      ctx.font = `900 ${Math.round(cw * 0.1)}px ${FONT}`;
      ctx.fillStyle = INK;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(MAPS[idx].name.toUpperCase(), 0, ch / 2 - (ch - img - pad) / 2 + pad * 0.3);
      ctx.restore();
    }

    // Game-show frame: a pointer above and below the winning slot, with chasing lights.
    const fw = cw * 1.2;
    const fh = ch * 1.16;
    ctx.strokeStyle = YELLOW;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.roundRect(w / 2 - fw / 2, cy - fh / 2, fw, fh, 22);
    ctx.stroke();
    const bulbs = 22;
    for (let i = 0; i < bulbs; i++) {
      const u = i / bulbs;
      // Walk the frame's perimeter.
      const per = 2 * (fw + fh);
      let d = u * per;
      let bx: number;
      let by: number;
      if (d < fw) [bx, by] = [w / 2 - fw / 2 + d, cy - fh / 2];
      else if ((d -= fw) < fh) [bx, by] = [w / 2 + fw / 2, cy - fh / 2 + d];
      else if ((d -= fh) < fw) [bx, by] = [w / 2 + fw / 2 - d, cy + fh / 2];
      else [bx, by] = [w / 2 - fw / 2, cy + fh / 2 - (d - fw)];
      const lit = done ? Math.floor(this.time * 8) % 2 === 0 : (i + Math.floor(this.time * 18)) % 3 === 0;
      ctx.fillStyle = lit ? '#ffffff' : '#ff5a5f';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bx, by, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    for (const dir of [-1, 1]) {
      const ty = cy + dir * (fh / 2 + 6);
      ctx.fillStyle = YELLOW;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(w / 2, ty - dir * 4);
      ctx.lineTo(w / 2 - 16, ty + dir * 20);
      ctx.lineTo(w / 2 + 16, ty + dir * 20);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    if (done) {
      const map = MAPS[view.mapIndex] ?? MAPS[0];
      this.toonText(map.blurb, w / 2, cy + fh / 2 + 44, clamp(w * 0.035, 14, 22), '#ffffff');
    }
  }
}
