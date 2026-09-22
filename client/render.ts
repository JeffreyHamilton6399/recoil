// Canvas 2D renderer. Everything is drawn procedurally: gradients, shapes
// and particles. World units are converted to pixels so the full arena is
// always visible, whatever the screen shape.

import * as C from '../shared/constants.js';
import { clamp, lerp } from '../shared/sim.js';
import type { GameEvent, Phase, PlayerIndex, RoundResult, SlotStatus } from '../shared/types.js';

export const PLAYER_COLORS: readonly [string, string] = ['#ff4d5e', '#3f7bff'];
export const PLAYER_NAMES: readonly [string, string] = ['RED', 'BLUE'];

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

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

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
  private readonly fx: [PlayerFx, PlayerFx] = [newFx(), newFx()];
  private trauma = 0;
  private flash = 0;
  private time = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not supported');
    this.ctx = ctx;

    const rand = prng(7);
    for (let i = 0; i < 170; i++) {
      this.stars.push({ x: rand(), y: rand(), size: 0.4 + rand() * 1.4, phase: rand() * Math.PI * 2, depth: 0.2 + rand() * 0.8 });
    }
    for (let i = 0; i < 9; i++) {
      const pts: [number, number][] = [];
      let a = rand() * Math.PI * 2;
      let r = 0.15 + rand() * 0.7;
      let x = Math.cos(a) * r;
      let y = Math.sin(a) * r;
      pts.push([x, y]);
      const segs = 3 + Math.floor(rand() * 4);
      for (let s = 0; s < segs; s++) {
        a += (rand() - 0.5) * 1.6;
        const len = 0.05 + rand() * 0.12;
        x += Math.cos(a) * len;
        y += Math.sin(a) * len;
        r = Math.hypot(x, y);
        if (r > 0.95) break;
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
        const color = PLAYER_COLORS[ev.p];
        this.burst(ev.x, ev.y, 5 + Math.round(8 * ev.c), '#ffffff', 3 + 5 * ev.c, ev.a, 0.6, 0.06, 0.25);
        this.burst(ev.x, ev.y, 4 + Math.round(6 * ev.c), color, 2 + 4 * ev.c, ev.a, 0.9, 0.07, 0.35);
        this.addTrauma(0.08 + 0.2 * ev.c);
        return false;
      }
      case 'hit': {
        const f = this.fx[ev.p];
        f.squashAngle = ev.a;
        f.squashVel -= 4 + ev.f * 0.7;
        f.dmgPop = 1;
        const heavy = ev.f >= C.HEAVY_HIT_IMPULSE;
        const n = 10 + Math.round(ev.f * 1.5);
        this.burst(ev.x, ev.y, n, PLAYER_COLORS[ev.p], 3 + ev.f * 0.5, ev.a, 1.2, 0.08, 0.5);
        this.burst(ev.x, ev.y, Math.round(n / 2), '#ffffff', 4 + ev.f * 0.4, ev.a, 1.6, 0.05, 0.3);
        this.rings.push({ x: ev.x, y: ev.y, r0: 0.2, r1: 0.8 + ev.f * 0.08, life: 0.3, maxLife: 0.3, color: '#ffffff' });
        this.addTrauma(Math.min(0.9, 0.15 + ev.f * 0.045));
        return heavy;
      }
      case 'cancel':
        this.burst(ev.x, ev.y, 14, '#dff4ff', 5, 0, Math.PI * 2, 0.06, 0.35);
        this.rings.push({ x: ev.x, y: ev.y, r0: ev.r, r1: ev.r + 0.9, life: 0.25, maxLife: 0.25, color: '#bfe6ff' });
        this.addTrauma(0.12);
        return false;
      case 'bump': {
        for (const i of [0, 1] as const) {
          const f = this.fx[i];
          f.squashAngle = ev.a;
          f.squashVel -= 3 + ev.f * 0.8;
        }
        this.burst(ev.x, ev.y, 8, '#e8f7ff', 2 + ev.f * 0.3, ev.a + Math.PI / 2, Math.PI * 2, 0.05, 0.3);
        this.addTrauma(Math.min(0.5, 0.05 + ev.f * 0.03));
        return false;
      }
      case 'fall': {
        const p = players[ev.p];
        this.burst(p.x, p.y, 18, '#cfe9ff', 3, Math.atan2(p.y, p.x), 1.4, 0.07, 0.6);
        this.addTrauma(0.35);
        return false;
      }
      case 'ko':
        this.flash = 0.55;
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
    this.update(view, dt, realDt);

    const ctx = this.ctx;
    const shake = this.trauma * this.trauma * C.SHAKE_MAX_PX;
    const sx = shake * Math.sin(this.time * 71.3) * Math.cos(this.time * 13.1);
    const sy = shake * Math.cos(this.time * 63.7) * Math.sin(this.time * 17.9);

    this.drawBackground(sx * 0.3, sy * 0.3);

    // World space: 1 unit = this.scale CSS pixels.
    const k = this.scale * this.dpr;
    ctx.setTransform(k, 0, 0, k, (this.cx + sx) * this.dpr, (this.cy + sy) * this.dpr);

    const visible = (i: PlayerIndex): boolean => view.attract || view.slots[i] !== 0;

    // Falling players drop "under" the ice, so draw them first.
    for (const i of [0, 1] as const) if (visible(i) && view.players[i].fallTime >= 0) this.drawPlayer(view, i);
    this.drawArena(view);
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
      ctx.fillStyle = `rgba(255,255,255,${this.flash})`;
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
        f.trail = f.trail.filter((t) => t.age < 0.22);
        if (f.speed > C.TRAIL_MIN_SPEED && p.fallTime < 0) f.trail.push({ x: p.x, y: p.y, age: 0 });
      }
    }
  }

  private drawBackground(ox: number, oy: number): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const g = ctx.createRadialGradient(this.width / 2, this.height * 0.45, 0, this.width / 2, this.height / 2, Math.max(this.width, this.height) * 0.75);
    g.addColorStop(0, '#12204a');
    g.addColorStop(0.55, '#0a1230');
    g.addColorStop(1, '#04060f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.width, this.height);

    for (const s of this.stars) {
      const tw = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(this.time * (0.6 + s.depth) + s.phase));
      ctx.fillStyle = `rgba(200,220,255,${0.25 + 0.55 * tw * s.depth})`;
      const x = s.x * this.width + ox * s.depth;
      const y = s.y * this.height + oy * s.depth;
      ctx.fillRect(x, y, s.size, s.size);
    }
  }

  private drawVignette(): void {
    const ctx = this.ctx;
    const r = Math.hypot(this.width, this.height) / 2;
    const g = ctx.createRadialGradient(this.width / 2, this.height / 2, r * 0.45, this.width / 2, this.height / 2, r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,8,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  private drawArena(view: View): void {
    const ctx = this.ctx;
    const R = view.arenaRadius;
    const slab = 0.38;

    // Soft drop shadow far below, so the disc looks like it floats.
    const sh = ctx.createRadialGradient(0.3, 1.6, R * 0.5, 0.3, 1.6, R * 1.25);
    sh.addColorStop(0, 'rgba(0,0,10,0.55)');
    sh.addColorStop(1, 'rgba(0,0,10,0)');
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.arc(0.3, 1.6, R * 1.25, 0, Math.PI * 2);
    ctx.fill();

    // Slab thickness.
    const side = ctx.createLinearGradient(0, -R, 0, R + slab);
    side.addColorStop(0, '#5f8fb8');
    side.addColorStop(1, '#2d4f78');
    ctx.fillStyle = side;
    ctx.beginPath();
    ctx.arc(0, slab, R, 0, Math.PI * 2);
    ctx.fill();

    // Ice surface.
    const top = ctx.createRadialGradient(-R * 0.3, -R * 0.35, R * 0.05, 0, 0, R);
    top.addColorStop(0, '#f6fcff');
    top.addColorStop(0.55, '#d3ebfa');
    top.addColorStop(1, '#a5cdea');
    ctx.fillStyle = top;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();

    // Cracks and sheen, clipped to the disc.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.strokeStyle = 'rgba(120,170,210,0.35)';
    ctx.lineWidth = 0.04;
    ctx.lineJoin = 'round';
    const CR = C.ARENA_START_RADIUS;
    for (const c of this.cracks) {
      ctx.beginPath();
      c.points.forEach(([x, y], n) => (n === 0 ? ctx.moveTo(x * CR, y * CR) : ctx.lineTo(x * CR, y * CR)));
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 0.25;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.8, Math.PI * 1.1, Math.PI * 1.35);
    ctx.stroke();
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.68, Math.PI * 1.12, Math.PI * 1.25);
    ctx.stroke();
    ctx.restore();

    // Where the arena will end up.
    if (!view.attract && R > C.ARENA_END_RADIUS + 0.05) {
      ctx.setLineDash([0.18, 0.22]);
      ctx.strokeStyle = 'rgba(70,110,160,0.35)';
      ctx.lineWidth = 0.05;
      ctx.beginPath();
      ctx.arc(0, 0, C.ARENA_END_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Rim: bright, flashing red while the arena shrinks.
    const pulse = view.shrinking ? 0.5 + 0.5 * Math.sin(this.time * 9) : 0;
    const rim = view.shrinking ? mix('#eaf8ff', '#ff3b4e', 0.35 + 0.65 * pulse) : '#eaf8ff';
    ctx.save();
    ctx.shadowColor = view.shrinking ? `rgba(255,60,80,${0.4 + 0.5 * pulse})` : 'rgba(180,230,255,0.7)';
    ctx.shadowBlur = (view.shrinking ? 14 + 10 * pulse : 12) * this.dpr;
    ctx.strokeStyle = rim;
    ctx.lineWidth = 0.13;
    ctx.beginPath();
    ctx.arc(0, 0, R - 0.06, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  private drawTrail(i: PlayerIndex): void {
    const ctx = this.ctx;
    const f = this.fx[i];
    for (const t of f.trail) {
      const k = 1 - t.age / 0.22;
      ctx.fillStyle = rgba(PLAYER_COLORS[i], 0.28 * k);
      ctx.beginPath();
      ctx.arc(t.x, t.y, C.PLAYER_RADIUS * (0.45 + 0.5 * k), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawPlayer(view: View, i: PlayerIndex): void {
    const ctx = this.ctx;
    const p = view.players[i];
    const f = this.fx[i];
    const color = PLAYER_COLORS[i];
    const R = C.PLAYER_RADIUS;
    const falling = p.fallTime >= 0;
    const ft = falling ? clamp(p.fallTime / C.FALL_DURATION, 0, 1) : 0;
    if (ft >= 1) return;
    const size = 1 - ft * 0.85;
    const spin = ft * ft * 14;

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = 1 - ft;

    if (!falling) {
      // Contact shadow on the ice.
      ctx.fillStyle = 'rgba(30,60,100,0.25)';
      ctx.beginPath();
      ctx.ellipse(0.06, 0.16, R * 1.02, R * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();
      // "You" marker.
      if (i === view.mySlot) {
        ctx.strokeStyle = rgba(color, 0.55);
        ctx.lineWidth = 0.05;
        ctx.setLineDash([0.12, 0.1]);
        ctx.lineDashOffset = -this.time * 0.4;
        ctx.beginPath();
        ctx.arc(0, 0, R + 0.28, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Squash and stretch along the last impulse axis.
    const rel = f.squashAngle;
    ctx.rotate(rel);
    ctx.scale((1 + f.squash) * size, (1 - f.squash * 0.7) * size);
    ctx.rotate(-rel);
    ctx.rotate(p.aim + spin);

    // Barrel: grows and turns white as you charge.
    const c = p.charge;
    const barrelLen = R + 0.3 + 0.28 * c;
    const bw = 0.13 + 0.05 * c;
    ctx.fillStyle = mix('#2a3350', '#ffffff', c);
    ctx.strokeStyle = 'rgba(10,15,30,0.55)';
    ctx.lineWidth = 0.04;
    ctx.beginPath();
    ctx.roundRect(0, -bw, barrelLen, bw * 2, 0.06);
    ctx.fill();
    ctx.stroke();
    if (c > 0.02) {
      ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.5 * c})`;
      ctx.beginPath();
      ctx.arc(barrelLen, 0, bw * (0.8 + 0.6 * c) * (c >= 1 ? 1 + 0.15 * Math.sin(this.time * 30) : 1), 0, Math.PI * 2);
      ctx.fill();
    }

    // Body.
    const body = ctx.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.1, 0, 0, R);
    body.addColorStop(0, mix(color, '#ffffff', 0.45));
    body.addColorStop(0.6, color);
    body.addColorStop(1, mix(color, '#000000', 0.35));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,15,30,0.5)';
    ctx.lineWidth = 0.05;
    ctx.stroke();

    // Eyes look where you aim.
    for (const side of [-1, 1]) {
      const ea = side * 0.55;
      const ex = Math.cos(ea) * R * 0.45;
      const ey = Math.sin(ea) * R * 0.45;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex, ey, R * 0.27, 0, Math.PI * 2);
      ctx.fill();
      if (falling) {
        ctx.strokeStyle = '#141a2e';
        ctx.lineWidth = 0.05;
        const s = R * 0.12;
        ctx.beginPath();
        ctx.moveTo(ex - s, ey - s);
        ctx.lineTo(ex + s, ey + s);
        ctx.moveTo(ex + s, ey - s);
        ctx.lineTo(ex - s, ey + s);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#141a2e';
        ctx.beginPath();
        ctx.arc(ex + R * 0.1, ey, R * 0.13, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Charge ring.
    if (c > 0.02 && !falling) {
      ctx.strokeStyle = c >= 1 ? `rgba(255,255,255,${0.7 + 0.3 * Math.sin(this.time * 25)})` : 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 0.07;
      ctx.beginPath();
      ctx.arc(0, 0, R + 0.14, -Math.PI * c, Math.PI * c);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawBullets(view: View): void {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    for (const b of view.bullets) {
      const color = PLAYER_COLORS[b.owner];
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 0.1) {
        const len = Math.min(1.4, sp * 0.06);
        ctx.strokeStyle = rgba(color, 0.4);
        ctx.lineWidth = b.r * 1.5;
        ctx.beginPath();
        ctx.moveTo(b.x - (b.vx / sp) * len, b.y - (b.vy / sp) * len);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.fillStyle = rgba(color, 0.25);
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r * 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    for (const r of this.rings) {
      const k = 1 - r.life / r.maxLife;
      ctx.strokeStyle = r.color;
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.lineWidth = 0.08 * (1 - k) + 0.02;
      ctx.beginPath();
      ctx.arc(r.x, r.y, lerp(r.r0, r.r1, 1 - (1 - k) * (1 - k)), 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const p of this.particles) {
      const k = p.life / p.maxLife;
      ctx.globalAlpha = Math.min(1, k * 1.5);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * k), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawDamage(view: View, i: PlayerIndex): void {
    const p = view.players[i];
    if (p.fallTime >= 0) return;
    const ctx = this.ctx;
    const f = this.fx[i];
    const x = this.cx + p.x * this.scale;
    const y = this.cy + (p.y - C.PLAYER_RADIUS - 0.55) * this.scale;
    const size = Math.max(12, this.scale * 0.46) * (1 + 0.45 * f.dmgPop);
    ctx.font = `800 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = `${Math.round(p.damage)}%`;
    ctx.lineWidth = Math.max(3, size * 0.2);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(8,12,30,0.8)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = mix('#ffffff', '#ff2d3d', p.damage / 150);
    ctx.fillText(text, x, y);
  }

  private drawHud(view: View): void {
    const ctx = this.ctx;
    const w = this.width;
    const big = clamp(Math.min(w, this.height) * 0.09, 34, 64);
    const topY = 14 + big * 0.55;

    // Score.
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.font = `900 ${big}px ${FONT}`;
    for (const i of [0, 1] as const) {
      ctx.textAlign = i === 0 ? 'right' : 'left';
      const x = w / 2 + (i === 0 ? -big * 0.45 : big * 0.45);
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(4,6,16,0.7)';
      ctx.strokeText(String(view.scores[i]), x, topY);
      ctx.fillStyle = PLAYER_COLORS[i];
      ctx.fillText(String(view.scores[i]), x, topY);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(220,235,255,0.55)';
    ctx.font = `700 ${big * 0.5}px ${FONT}`;
    ctx.fillText('–', w / 2, topY);

    // First-to-5 pips.
    const pipY = topY + big * 0.62;
    for (const i of [0, 1] as const) {
      for (let n = 0; n < C.WIN_SCORE; n++) {
        const off = big * 0.45 + n * 11;
        const x = w / 2 + (i === 0 ? -off - 4 : off + 4);
        ctx.beginPath();
        ctx.arc(x, pipY, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = n < view.scores[i] ? PLAYER_COLORS[i] : 'rgba(200,220,255,0.18)';
        ctx.fill();
      }
    }

    if (view.mySlot === -1) {
      ctx.font = `700 12px ${FONT}`;
      ctx.fillStyle = 'rgba(200,220,255,0.6)';
      ctx.fillText('SPECTATING', w / 2, pipY + 18);
    } else {
      ctx.font = `700 12px ${FONT}`;
      ctx.fillStyle = rgba(PLAYER_COLORS[view.mySlot], 0.9);
      ctx.fillText(`YOU ARE ${PLAYER_NAMES[view.mySlot]}`, w / 2, pipY + 18);
    }

    // Centre banners. Placed above the middle so they don't cover players.
    const bannerY = this.cy - this.scale * 2.2;
    if (view.phase === 'countdown') {
      const n = Math.max(1, Math.ceil(C.COUNTDOWN_TIME - view.phaseTime));
      const frac = C.COUNTDOWN_TIME - view.phaseTime - (n - 1); // 1 -> 0 within each number
      this.banner(String(n), '#ffffff', bannerY, 1 + 0.5 * Math.pow(frac, 6), 0.4 + 0.6 * Math.min(1, frac * 3));
    } else if (view.phase === 'playing' && view.phaseTime < C.FIGHT_BANNER_TIME) {
      const k = view.phaseTime / C.FIGHT_BANNER_TIME;
      this.banner('FIGHT!', '#ffe066', bannerY, 1.3 - 0.3 * Math.min(1, k * 4), 1 - Math.pow(k, 3));
    } else if (view.phase === 'roundEnd' && view.roundResult !== null) {
      const pop = Math.min(1, view.phaseTime * 5);
      if (view.roundResult === -1) this.banner('DOUBLE KO!', '#ffffff', bannerY, 0.6 + 0.4 * pop, pop);
      else this.banner(`${PLAYER_NAMES[view.roundResult]} SCORES!`, PLAYER_COLORS[view.roundResult], bannerY, 0.6 + 0.4 * pop, pop);
    } else if (view.phase === 'matchEnd' && view.matchWinner !== null) {
      const pop = Math.min(1, view.phaseTime * 4);
      const w0 = view.matchWinner;
      const title = view.mySlot === -1 ? `${PLAYER_NAMES[w0]} WINS!` : view.mySlot === w0 ? 'YOU WIN!' : 'YOU LOSE';
      this.banner(title, PLAYER_COLORS[w0], bannerY, (0.7 + 0.3 * pop) * (1 + 0.04 * Math.sin(this.time * 4)), pop);
      ctx.font = `700 ${big * 0.4}px ${FONT}`;
      ctx.fillStyle = 'rgba(220,235,255,0.85)';
      ctx.fillText(`${view.scores[0]} – ${view.scores[1]}`, w / 2, bannerY + big * 0.9);
    }
  }

  private banner(text: string, color: string, y: number, scale: number, alpha: number): void {
    const ctx = this.ctx;
    const size = clamp(Math.min(this.width, this.height) * 0.13, 40, 110) * scale;
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.font = `900 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size * 0.14;
    ctx.strokeStyle = 'rgba(6,10,28,0.85)';
    ctx.strokeText(text, this.width / 2, y);
    ctx.fillStyle = color;
    ctx.fillText(text, this.width / 2, y);
    ctx.restore();
  }
}

function newFx(): PlayerFx {
  return { squash: 0, squashVel: 0, squashAngle: 0, trail: [], lastX: 0, lastY: 0, speed: 0, dmgPop: 0 };
}
