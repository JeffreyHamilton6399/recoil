// Canvas 2D renderer in a toon / cel-shaded style: flat colour bands, thick
// ink outlines, hard shadows and comic impact bursts. Everything is drawn
// procedurally. World units are converted to pixels so the full arena is
// always visible, whatever the screen shape.

import * as C from '../shared/constants.js';
import { clamp, lerp } from '../shared/sim.js';
import type { GameEvent, Phase, PlayerIndex, RoundResult, SlotStatus } from '../shared/types.js';

/** Outline colour used for everything. */
const INK = '#1b1030';
export const PLAYER_COLORS: readonly [string, string] = ['#ff5a5f', '#4d8bff'];
const PLAYER_SHADES: readonly [string, string] = ['#c22f4c', '#2b4fc2'];
const PLAYER_LIGHTS: readonly [string, string] = ['#ffc4c0', '#c6daff'];
export const PLAYER_NAMES: readonly [string, string] = ['RED', 'BLUE'];

const ICE_TOP = '#c9f1ff';
const ICE_SHADE = '#94d3f0';
const ICE_SIDE = '#4f9ccc';
const ICE_SIDE_SHADE = '#35729f';
const YELLOW = '#ffd93d';

/** World-space outline widths. */
const LINE_THICK = 0.14;
const LINE = 0.075;
const LINE_THIN = 0.045;

export interface ViewPlayer {
  x: number;
  y: number;
  aim: number;
  charge: number;
  damage: number;
  /** -1 while standing. */
  fallTime: number;
}

export interface ViewBullet {
  id: number;
  owner: PlayerIndex;
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
}

export interface View {
  phase: Phase;
  phaseTime: number;
  arenaRadius: number;
  shrinking: boolean;
  players: [ViewPlayer, ViewPlayer];
  bullets: ViewBullet[];
  scores: [number, number];
  roundResult: RoundResult | null;
  matchWinner: PlayerIndex | null;
  slots: [SlotStatus, SlotStatus];
  mySlot: PlayerIndex | -1;
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

interface PlayerFx {
  /** Squash-and-stretch spring: deformation, its velocity, and its axis. */
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

interface Crack {
  points: [number, number][];
}

/** Deterministic PRNG so the star field and ice cracks look the same every load. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = clamp(t, 0, 1);
  return `rgb(${Math.round(lerp(ca[0], cb[0], k))},${Math.round(lerp(ca[1], cb[1], k))},${Math.round(lerp(ca[2], cb[2], k))})`;
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
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

const FONT = '"Arial Black", "Arial Rounded MT Bold", "Helvetica Neue", Helvetica, system-ui, sans-serif';

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
  private readonly cracks: Crack[] = [];
  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private pows: Pow[] = [];
  private readonly fx: [PlayerFx, PlayerFx] = [newFx(), newFx()];
  private trauma = 0;
  private flash = 0;
  private time = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not supported');
    this.ctx = ctx;

    const rand = prng(7);
    for (let i = 0; i < 120; i++) {
      this.stars.push({ x: rand(), y: rand(), size: 1 + rand() * 2.2, phase: rand() * Math.PI * 2, depth: 0.2 + rand() * 0.8 });
    }
    for (let i = 0; i < 8; i++) {
      const pts: [number, number][] = [];
      let a = rand() * Math.PI * 2;
      const r = 0.15 + rand() * 0.65;
      let x = Math.cos(a) * r;
      let y = Math.sin(a) * r;
      pts.push([x, y]);
      const segs = 2 + Math.floor(rand() * 3);
      for (let s = 0; s < segs; s++) {
        a += (rand() - 0.5) * 1.4;
        const len = 0.06 + rand() * 0.1;
        x += Math.cos(a) * len;
        y += Math.sin(a) * len;
        if (Math.hypot(x, y) > 0.92) break;
        pts.push([x, y]);
      }
      this.cracks.push({ points: pts });
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
    // Fit the largest arena plus room for the slab edge and damage labels.
    this.scale = Math.min(w, h) / (2 * (C.ARENA_START_RADIUS + 1.1));
    this.cx = left + w / 2;
    this.cy = top + h / 2;
  }

  // -------------------------------------------------------------------------
  // Effects, driven by simulation events
  // -------------------------------------------------------------------------

  /** Reacts to an event. Returns true for a heavy hit so the caller can hit-stop. */
  onEvent(ev: GameEvent, players: [ViewPlayer, ViewPlayer]): boolean {
    switch (ev.k) {
      case 'fire': {
        const f = this.fx[ev.p];
        f.squashAngle = ev.a;
        f.squashVel -= 5 + 7 * ev.c;
        this.burst(ev.x, ev.y, 4 + Math.round(6 * ev.c), '#ffffff', 3 + 5 * ev.c, ev.a, 0.7, 0.07, 0.22);
        this.burst(ev.x, ev.y, 3 + Math.round(5 * ev.c), YELLOW, 2 + 4 * ev.c, ev.a, 1, 0.08, 0.3);
        if (ev.c > 0.6) this.pows.push({ x: ev.x, y: ev.y, size: 0.25 + 0.2 * ev.c, rot: ev.a, life: 0.12, maxLife: 0.12, color: '#ffffff' });
        this.addTrauma(0.08 + 0.2 * ev.c);
        return false;
      }
      case 'hit': {
        const f = this.fx[ev.p];
        f.squashAngle = ev.a;
        f.squashVel -= 4 + ev.f * 0.7;
        f.dmgPop = 1;
        const heavy = ev.f >= C.HEAVY_HIT_IMPULSE;
        const n = 8 + Math.round(ev.f * 1.2);
        this.burst(ev.x, ev.y, n, PLAYER_COLORS[ev.p], 3 + ev.f * 0.5, ev.a, 1.3, 0.1, 0.45);
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
        this.rings.push({ x: ev.x, y: ev.y, r0: 0.2, r1: 0.8 + ev.f * 0.08, life: 0.28, maxLife: 0.28 });
        this.addTrauma(Math.min(0.9, 0.15 + ev.f * 0.045));
        return heavy;
      }
      case 'cancel':
        this.burst(ev.x, ev.y, 12, '#e6f8ff', 5, 0, Math.PI * 2, 0.08, 0.3);
        this.pows.push({ x: ev.x, y: ev.y, size: ev.r + 0.35, rot: Math.random(), life: 0.18, maxLife: 0.18, color: '#bfeaff' });
        this.addTrauma(0.12);
        return false;
      case 'bump': {
        for (const i of [0, 1] as const) {
          const f = this.fx[i];
          f.squashAngle = ev.a;
          f.squashVel -= 3 + ev.f * 0.8;
        }
        this.burst(ev.x, ev.y, 7, '#ffffff', 2 + ev.f * 0.3, ev.a + Math.PI / 2, Math.PI * 2, 0.07, 0.3);
        this.addTrauma(Math.min(0.5, 0.05 + ev.f * 0.03));
        return false;
      }
      case 'fall': {
        const p = players[ev.p];
        this.burst(p.x, p.y, 16, ICE_TOP, 3, Math.atan2(p.y, p.x), 1.4, 0.09, 0.55);
        this.addTrauma(0.35);
        return false;
      }
      case 'ko':
        this.flash = 0.5;
        this.addTrauma(0.6);
        return false;
    }
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
    if (this.particles.length > 500) this.particles.splice(0, this.particles.length - 500);
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

    const visible = (i: PlayerIndex): boolean => view.attract || view.slots[i] !== 0;

    // Falling players drop "under" the ice, so draw them first.
    for (const i of [0, 1] as const) if (visible(i) && view.players[i].fallTime >= 0) this.drawPlayer(view, i);
    this.drawArena(view);
    for (const i of [0, 1] as const) if (visible(i) && view.players[i].fallTime < 0) this.drawShadow(view.players[i]);
    for (const i of [0, 1] as const) if (visible(i) && view.players[i].fallTime < 0) this.drawTrail(i);
    for (const i of [0, 1] as const) if (visible(i) && view.players[i].fallTime < 0) this.drawPlayer(view, i);
    this.drawBullets(view);
    this.drawParticles();

    // Screen space.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, sx * this.dpr, sy * this.dpr);
    for (const i of [0, 1] as const) if (visible(i) && !view.attract) this.drawDamage(view, i);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawVignette();
    if (!view.attract) this.drawHud(view);
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

    for (const i of [0, 1] as const) {
      const f = this.fx[i];
      const p = view.players[i];
      // Springy squash and stretch, substepped so slow frames stay stable.
      for (let rem = dt; rem > 0; rem -= 1 / 120) {
        const h = Math.min(rem, 1 / 120);
        f.squashVel += (-320 * f.squash - 16 * f.squashVel) * h;
        f.squash = clamp(f.squash + f.squashVel * h, -0.35, 0.35);
      }
      f.dmgPop = Math.max(0, f.dmgPop - dt * 4);

      if (dt > 0) {
        const inst = Math.hypot(p.x - f.lastX, p.y - f.lastY) / dt;
        f.speed = inst > 60 ? f.speed : lerp(f.speed, inst, 0.3); // ignore teleports on round reset
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
    ctx.fillStyle = '#140e38';
    ctx.fillRect(0, 0, this.width, this.height);

    // Flat, hard-edged bands of colour instead of a smooth gradient.
    const m = Math.max(this.width, this.height);
    const bands = ['#1a1348', '#201757', '#261c66'];
    bands.forEach((color, n) => {
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
        // Four-point cartoon sparkle.
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

  private drawArena(view: View): void {
    const ctx = this.ctx;
    const R = view.arenaRadius;
    const slab = 0.45;

    // Hard-edged drop shadow far below: the disc floats.
    ctx.fillStyle = 'rgba(8,4,24,0.45)';
    ctx.beginPath();
    ctx.ellipse(0.45, 1.5, R * 1.02, R * 0.98, 0, 0, Math.PI * 2);
    ctx.fill();

    // Slab side: two flat tones and an ink outline.
    ctx.fillStyle = ICE_SIDE;
    ctx.beginPath();
    ctx.arc(0, slab, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, slab, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = ICE_SIDE_SHADE;
    ctx.fillRect(R * 0.35, -R, R, R * 2 + slab); // shadow side, away from the light
    ctx.restore();
    ctx.strokeStyle = INK;
    ctx.lineWidth = LINE_THICK;
    ctx.beginPath();
    ctx.arc(0, slab, R, 0, Math.PI * 2);
    ctx.stroke();

    // Top surface: shadow band, lit face, highlight streaks.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = ICE_SHADE;
    ctx.fillRect(-R, -R, R * 2, R * 2);
    ctx.fillStyle = ICE_TOP;
    ctx.beginPath();
    ctx.arc(-R * 0.07, -R * 0.09, R * 0.97, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = rgba(INK, 0.18);
    ctx.lineWidth = LINE_THIN;
    const CR = C.ARENA_START_RADIUS;
    for (const c of this.cracks) {
      ctx.beginPath();
      c.points.forEach(([x, y], n) => (n === 0 ? ctx.moveTo(x * CR, y * CR) : ctx.lineTo(x * CR, y * CR)));
      ctx.stroke();
    }

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
    ctx.restore();

    // Where the arena will end up.
    if (!view.attract && R > C.ARENA_END_RADIUS + 0.05) {
      ctx.setLineDash([0.2, 0.25]);
      ctx.strokeStyle = rgba(INK, 0.22);
      ctx.lineWidth = 0.07;
      ctx.beginPath();
      ctx.arc(0, 0, C.ARENA_END_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Bright rim inside the ink outline. It flashes red while the arena shrinks.
    const on = view.shrinking && Math.sin(this.time * 10) > 0;
    ctx.strokeStyle = on ? '#ff3b4e' : '#ffffff';
    ctx.lineWidth = on ? 0.2 : 0.12;
    ctx.beginPath();
    ctx.arc(0, 0, R - LINE_THICK / 2 - (on ? 0.1 : 0.06), 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = INK;
    ctx.lineWidth = LINE_THICK;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.stroke();
  }

  // -------------------------------------------------------------------------
  // Players and bullets
  // -------------------------------------------------------------------------

  private drawShadow(p: ViewPlayer): void {
    const ctx = this.ctx;
    ctx.fillStyle = rgba(INK, 0.22);
    ctx.beginPath();
    ctx.ellipse(p.x + 0.12, p.y + 0.2, C.PLAYER_RADIUS, C.PLAYER_RADIUS * 0.82, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawTrail(i: PlayerIndex): void {
    const f = this.fx[i];
    if (f.trail.length < 2) return;
    const ctx = this.ctx;
    // Cartoon speed streak: a fat flat stroke that thins out.
    ctx.strokeStyle = rgba(PLAYER_LIGHTS[i], 0.55);
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

  private drawPlayer(view: View, i: PlayerIndex): void {
    const ctx = this.ctx;
    const p = view.players[i];
    const f = this.fx[i];
    const R = C.PLAYER_RADIUS;
    const falling = p.fallTime >= 0;
    const ft = falling ? clamp(p.fallTime / C.FALL_DURATION, 0, 1) : 0;
    if (ft >= 1) return;
    const size = 1 - ft * 0.85;
    const spin = ft * ft * 14;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = 1 - ft;

    if (!falling && i === view.mySlot) {
      // "You" marker: a marching dashed ring.
      ctx.strokeStyle = PLAYER_COLORS[i];
      ctx.lineWidth = 0.08;
      ctx.setLineDash([0.16, 0.14]);
      ctx.lineDashOffset = -this.time * 0.5;
      ctx.beginPath();
      ctx.arc(0, 0, R + 0.3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Squash and stretch along the last impulse axis.
    const rel = f.squashAngle;
    ctx.rotate(rel);
    ctx.scale((1 + f.squash) * size, (1 - f.squash * 0.7) * size);
    ctx.rotate(-rel);

    // Barrel: grows and turns white as you charge.
    const c = p.charge;
    ctx.save();
    ctx.rotate(p.aim + spin);
    const barrelLen = R + 0.32 + 0.3 * c;
    const bw = 0.14 + 0.05 * c;
    ctx.fillStyle = mix('#3b3160', '#ffffff', c);
    ctx.strokeStyle = INK;
    ctx.lineWidth = LINE;
    ctx.beginPath();
    ctx.roundRect(0, -bw, barrelLen, bw * 2, 0.07);
    ctx.fill();
    ctx.stroke();
    if (c > 0.02) {
      const pulse = c >= 1 ? 1 + 0.18 * Math.sin(this.time * 30) : 1;
      ctx.fillStyle = c >= 1 ? YELLOW : '#ffffff';
      spikyPath(ctx, barrelLen + 0.05, 0, bw * (1.1 + 0.9 * c) * pulse, bw * 0.6 * pulse, 6, this.time * 4);
      ctx.fill();
      ctx.lineWidth = LINE_THIN;
      ctx.stroke();
    }
    ctx.restore();

    // Body: flat shadow tone, lit tone offset toward the light, a hard highlight.
    ctx.save();
    ctx.rotate(spin);
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = PLAYER_SHADES[i];
    ctx.fillRect(-R, -R, R * 2, R * 2);
    ctx.fillStyle = PLAYER_COLORS[i];
    ctx.beginPath();
    ctx.arc(-R * 0.16, -R * 0.2, R * 0.93, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = PLAYER_LIGHTS[i];
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
    ctx.restore();
  }

  private drawBullets(view: View): void {
    const ctx = this.ctx;
    for (const b of view.bullets) {
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 0.1) {
        // Speed lines behind the bullet.
        const nx = b.vx / sp;
        const ny = b.vy / sp;
        const len = Math.min(1.3, sp * 0.06);
        ctx.strokeStyle = rgba(PLAYER_LIGHTS[b.owner], 0.8);
        ctx.lineWidth = b.r * 0.9;
        ctx.beginPath();
        ctx.moveTo(b.x - nx * (b.r + len), b.y - ny * (b.r + len));
        ctx.lineTo(b.x - nx * b.r * 0.5, b.y - ny * b.r * 0.5);
        ctx.stroke();
      }
      ctx.fillStyle = PLAYER_COLORS[b.owner];
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
      ctx.strokeStyle = '#ffffff';
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

  private drawDamage(view: View, i: PlayerIndex): void {
    const p = view.players[i];
    if (p.fallTime >= 0) return;
    const f = this.fx[i];
    const x = this.cx + p.x * this.scale;
    const y = this.cy + (p.y - C.PLAYER_RADIUS - 0.6) * this.scale;
    const size = Math.max(13, this.scale * 0.46) * (1 + 0.5 * f.dmgPop);
    this.toonText(`${Math.round(p.damage)}%`, x, y, size, mix('#ffffff', '#ff2d3d', p.damage / 150));
  }

  private drawHud(view: View): void {
    const ctx = this.ctx;
    const w = this.width;
    const big = clamp(Math.min(w, this.height) * 0.075, 28, 52);
    const top = 12;
    const bw = big * 1.3;
    const bh = big * 1.15;

    // Score badges.
    for (const i of [0, 1] as const) {
      const x = i === 0 ? w / 2 - 8 - bw : w / 2 + 8;
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.roundRect(x + 4, top + 5, bw, bh, 12);
      ctx.fill();
      ctx.fillStyle = PLAYER_COLORS[i];
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(x, top, bw, bh, 12);
      ctx.fill();
      ctx.stroke();
      this.toonText(String(view.scores[i]), x + bw / 2, top + bh / 2 + 1, big * 0.85, '#ffffff');
    }

    // First-to-5 pips.
    const pipY = top + bh + 14;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    for (const i of [0, 1] as const) {
      for (let n = 0; n < C.WIN_SCORE; n++) {
        const off = 14 + n * 13;
        const x = w / 2 + (i === 0 ? -off : off);
        ctx.beginPath();
        ctx.arc(x, pipY, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = n < view.scores[i] ? PLAYER_COLORS[i] : '#3a2f6b';
        ctx.fill();
        ctx.stroke();
      }
    }

    if (view.mySlot === -1) this.toonText('SPECTATING', w / 2, pipY + 22, 13, '#e6e0ff');
    else this.toonText(`YOU ARE ${PLAYER_NAMES[view.mySlot]}`, w / 2, pipY + 22, 13, PLAYER_LIGHTS[view.mySlot]);

    // Centre banners. Placed above the middle so they don't cover players.
    const bannerY = this.cy - this.scale * 2.2;
    if (view.phase === 'countdown') {
      const n = Math.max(1, Math.ceil(C.COUNTDOWN_TIME - view.phaseTime));
      const frac = C.COUNTDOWN_TIME - view.phaseTime - (n - 1); // 1 -> 0 within each number
      this.banner(String(n), '#ffffff', bannerY, 1 + 0.5 * Math.pow(frac, 6), 0.4 + 0.6 * Math.min(1, frac * 3), null);
    } else if (view.phase === 'playing' && view.phaseTime < C.FIGHT_BANNER_TIME) {
      const k = view.phaseTime / C.FIGHT_BANNER_TIME;
      this.banner('FIGHT!', YELLOW, bannerY, 1.3 - 0.3 * Math.min(1, k * 4), 1 - Math.pow(k, 3), '#ff5a5f');
    } else if (view.phase === 'roundEnd' && view.roundResult !== null) {
      const pop = Math.min(1, view.phaseTime * 5);
      if (view.roundResult === -1) this.banner('DOUBLE KO!', '#ffffff', bannerY, 0.6 + 0.4 * pop, pop, YELLOW);
      else this.banner(`${PLAYER_NAMES[view.roundResult]} SCORES!`, PLAYER_COLORS[view.roundResult], bannerY, 0.6 + 0.4 * pop, pop, YELLOW);
    } else if (view.phase === 'matchEnd' && view.matchWinner !== null) {
      const pop = Math.min(1, view.phaseTime * 4);
      const w0 = view.matchWinner;
      const title = view.mySlot === -1 ? `${PLAYER_NAMES[w0]} WINS!` : view.mySlot === w0 ? 'YOU WIN!' : 'YOU LOSE';
      this.banner(title, PLAYER_COLORS[w0], bannerY, (0.7 + 0.3 * pop) * (1 + 0.04 * Math.sin(this.time * 4)), pop, YELLOW);
      this.toonText(`${view.scores[0]} – ${view.scores[1]}`, w / 2, bannerY + big * 1.6, big * 0.6, '#ffffff');
    }
  }

  /** Big tilted comic banner, optionally with a starburst behind it. */
  private banner(text: string, color: string, y: number, scale: number, alpha: number, burst: string | null): void {
    const ctx = this.ctx;
    const size = clamp(Math.min(this.width, this.height) * 0.12, 38, 100) * scale;
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.translate(this.width / 2, y);
    ctx.rotate(-0.06);
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
}

function newFx(): PlayerFx {
  return { squash: 0, squashVel: 0, squashAngle: 0, trail: [], lastX: 0, lastY: 0, speed: 0, dmgPop: 0 };
}
