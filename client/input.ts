// Keyboard, mouse and touch input for first-person play.
// Keyboard: WASD or arrows to move, Space to jump, Shift to sprint, C to
// slide. Mouse: look (with pointer lock) and hold the left button to fire.
// Touch: a move stick on the left (push it all the way to sprint), drag
// anywhere else to look, and FIRE / JUMP / SLIDE buttons.
//
// The look direction changes every frame; everything else is sampled once
// per simulation tick with sample(), so short taps are never lost.

import * as C from '../shared/constants.js';
import { clamp, wrapAngle } from '../shared/sim.js';
import type { InputState } from '../shared/types.js';

type Key = 'forward' | 'back' | 'left' | 'right' | 'jump' | 'fire' | 'sprint' | 'crouch';

const KEYS: Record<string, Key> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  KeyF: 'fire',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  KeyC: 'crouch',
};

/** Radians per pixel of touch drag. */
const TOUCH_LOOK = 0.006;
/** Pixels of stick travel for full speed. */
const STICK_RANGE = 48;

export interface TouchElements {
  stick: HTMLElement;
  knob: HTMLElement;
  look: HTMLElement;
  fire: HTMLElement;
  jump: HTMLElement;
  slide: HTMLElement;
}

export class Input {
  yaw = 0;
  pitch = 0;
  /** Called on the first touch, so the UI can reveal the touch controls. */
  onTouchDetected: () => void = () => {};
  /** Called when fire is pressed or released (for instant sound feedback). */
  onFireChange: (down: boolean) => void = () => {};
  onLockChange: (locked: boolean) => void = () => {};

  private readonly keys = new Map<string, Key>();
  private mouseFire = false;
  private touchFire = new Set<number>();
  private touchJump = new Set<number>();
  private touchSlide = new Set<number>();
  /** Presses since the last sample, so a tap shorter than a tick still counts. */
  private fireLatch = false;
  private jumpLatch = false;
  private crouchLatch = false;
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stick = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private wasFiring = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly touch: TouchElements,
  ) {
    window.addEventListener('keydown', (e) => {
      const key = KEYS[e.code];
      if (!key || isTyping(e.target)) return;
      e.preventDefault();
      if (e.repeat) return;
      this.keys.set(e.code, key);
      if (key === 'jump') this.jumpLatch = true;
      if (key === 'fire') this.fireLatch = true;
      if (key === 'crouch') this.crouchLatch = true;
      this.fireChanged();
    });
    window.addEventListener('keyup', (e) => {
      if (this.keys.delete(e.code)) this.fireChanged();
    });

    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !this.locked) return;
      this.mouseFire = true;
      this.fireLatch = true;
      this.fireChanged();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button !== 0 || !this.mouseFire) return;
      this.mouseFire = false;
      this.fireChanged();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.turn(-e.movementX * C.MOUSE_SENSITIVITY, -e.movementY * C.MOUSE_SENSITIVITY);
    });
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked) {
        this.mouseFire = false;
        this.fireChanged();
      }
      this.onLockChange(this.locked);
    });

    // Never leave a key "stuck" when the tab loses focus.
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });

    this.bindTouch();
    window.addEventListener('touchstart', () => this.onTouchDetected(), { once: true, passive: true });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  requestLock(): void {
    if (this.locked) return;
    try {
      const r = this.canvas.requestPointerLock() as unknown;
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      // Not allowed right now (for example, too soon after Esc). The next click retries.
    }
  }

  exitLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  /** Points the view somewhere (on spawn, the server faces you at the centre). */
  setLook(yaw: number, pitch: number): void {
    this.yaw = wrapAngle(yaw);
    this.pitch = clamp(pitch, -C.PITCH_LIMIT, C.PITCH_LIMIT);
  }

  private turn(dYaw: number, dPitch: number): void {
    this.yaw = wrapAngle(this.yaw + dYaw);
    this.pitch = clamp(this.pitch + dPitch, -C.PITCH_LIMIT, C.PITCH_LIMIT);
  }

  get firing(): boolean {
    if (this.mouseFire || this.touchFire.size > 0) return true;
    for (const k of this.keys.values()) if (k === 'fire') return true;
    return false;
  }

  private held(key: Key): boolean {
    for (const k of this.keys.values()) if (k === key) return true;
    return false;
  }

  private fireChanged(): void {
    const f = this.firing;
    if (f !== this.wasFiring) {
      this.wasFiring = f;
      this.onFireChange(f);
    }
  }

  /** This tick's input. Clears the tap latches. */
  sample(): InputState {
    let forward = (this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0);
    let strafe = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    let sprint = this.held('sprint');
    if (this.stickId !== null) {
      sprint = -this.stick.y / STICK_RANGE > 0.9;
      forward = clamp(-this.stick.y / STICK_RANGE, -1, 1);
      strafe = clamp(this.stick.x / STICK_RANGE, -1, 1);
      // Round to 2 decimals to keep messages small; tiny wobbles are dead zone.
      forward = Math.abs(forward) < 0.15 ? 0 : Math.round(forward * 100) / 100;
      strafe = Math.abs(strafe) < 0.15 ? 0 : Math.round(strafe * 100) / 100;
    }
    const s: InputState = {
      forward,
      strafe,
      jump: this.held('jump') || this.touchJump.size > 0 || this.jumpLatch,
      firing: this.firing || this.fireLatch,
      sprint,
      crouch: this.held('crouch') || this.touchSlide.size > 0 || this.crouchLatch,
      yaw: Math.round(this.yaw * 10000) / 10000,
      pitch: Math.round(this.pitch * 10000) / 10000,
    };
    this.fireLatch = false;
    this.jumpLatch = false;
    this.crouchLatch = false;
    return s;
  }

  releaseAll(): void {
    this.keys.clear();
    this.mouseFire = false;
    this.touchFire.clear();
    this.touchJump.clear();
    this.touchSlide.clear();
    this.stickId = null;
    this.lookId = null;
    this.stick = { x: 0, y: 0 };
    this.touch.knob.style.transform = '';
    document.querySelectorAll('.pressed').forEach((el) => el.classList.remove('pressed'));
    this.fireChanged();
  }

  // -------------------------------------------------------------------------
  // Touch
  // -------------------------------------------------------------------------

  private bindTouch(): void {
    const { stick, knob, look, fire, jump, slide } = this.touch;

    const capture = (el: HTMLElement, e: PointerEvent): void => {
      e.preventDefault();
      if (e.pointerType === 'touch') this.onTouchDetected();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Some browsers refuse capture for synthetic pointers; holding still works.
      }
    };

    stick.addEventListener('pointerdown', (e) => {
      capture(stick, e);
      this.stickId = e.pointerId;
      const r = stick.getBoundingClientRect();
      this.stickOrigin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      this.moveStick(e);
    });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickId) this.moveStick(e);
    });
    const endStick = (e: PointerEvent): void => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.stick = { x: 0, y: 0 };
      knob.style.transform = '';
    };
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) stick.addEventListener(t, endStick);

    look.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      capture(look, e);
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
    });
    look.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      this.turn(-(e.clientX - this.lookLast.x) * TOUCH_LOOK, -(e.clientY - this.lookLast.y) * TOUCH_LOOK);
      this.lookLast = { x: e.clientX, y: e.clientY };
    });
    const endLook = (e: PointerEvent): void => {
      if (e.pointerId === this.lookId) this.lookId = null;
    };
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) look.addEventListener(t, endLook);

    const button = (el: HTMLElement, set: Set<number>, onDown: () => void): void => {
      // Dragging on a button also looks around, so you can aim while charging.
      let last = { x: 0, y: 0 };
      el.addEventListener('pointerdown', (e) => {
        capture(el, e);
        set.add(e.pointerId);
        last = { x: e.clientX, y: e.clientY };
        el.classList.add('pressed');
        onDown();
        this.fireChanged();
      });
      el.addEventListener('pointermove', (e) => {
        if (!set.has(e.pointerId)) return;
        this.turn(-(e.clientX - last.x) * TOUCH_LOOK, -(e.clientY - last.y) * TOUCH_LOOK);
        last = { x: e.clientX, y: e.clientY };
      });
      const release = (e: PointerEvent): void => {
        if (!set.delete(e.pointerId)) return;
        el.classList.toggle('pressed', set.size > 0);
        this.fireChanged();
      };
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) el.addEventListener(t, release);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    button(fire, this.touchFire, () => (this.fireLatch = true));
    button(jump, this.touchJump, () => (this.jumpLatch = true));
    button(slide, this.touchSlide, () => (this.crouchLatch = true));
  }

  private moveStick(e: PointerEvent): void {
    let dx = e.clientX - this.stickOrigin.x;
    let dy = e.clientY - this.stickOrigin.y;
    const len = Math.hypot(dx, dy);
    if (len > STICK_RANGE) {
      dx = (dx / len) * STICK_RANGE;
      dy = (dy / len) * STICK_RANGE;
    }
    this.stick = { x: dx, y: dy };
    this.touch.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}
