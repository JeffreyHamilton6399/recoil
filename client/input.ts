// Keyboard and touch input. Both are always active, so the game works on
// any device. Emits the combined state whenever it changes.

import type { InputState } from '../shared/types.js';

type Action = 'left' | 'right' | 'fire';

const KEY_ACTIONS: Record<string, Action> = {
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'fire',
  KeyW: 'fire',
  ArrowUp: 'fire',
};

export class Input {
  state: InputState = { aimLeft: false, aimRight: false, firing: false };
  /** Called with the new state whenever it changes. */
  onChange: (s: InputState) => void = () => {};
  /** Called on the first touch, so the UI can reveal the touch controls. */
  onTouchDetected: () => void = () => {};

  private readonly keys = new Map<string, Action>();
  private readonly pointers: Record<Action, Set<number>> = {
    left: new Set(),
    right: new Set(),
    fire: new Set(),
  };

  constructor(buttons: Record<Action, HTMLElement>) {
    window.addEventListener('keydown', (e) => {
      const action = KEY_ACTIONS[e.code];
      if (!action || isTyping(e.target)) return;
      e.preventDefault();
      if (e.repeat) return;
      this.keys.set(e.code, action);
      this.update();
    });
    window.addEventListener('keyup', (e) => {
      if (this.keys.delete(e.code)) this.update();
    });
    // Never leave a key "stuck" when the tab loses focus.
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });

    for (const action of Object.keys(buttons) as Action[]) this.bindButton(buttons[action], action);

    window.addEventListener(
      'touchstart',
      () => {
        this.onTouchDetected();
      },
      { once: true, passive: true },
    );
  }

  /** Hooks up one on-screen button. Each finger is tracked separately, so aim and fire work together. */
  private bindButton(el: HTMLElement, action: Action): void {
    const set = this.pointers[action];
    const release = (e: PointerEvent): void => {
      if (set.delete(e.pointerId)) {
        el.classList.toggle('pressed', set.size > 0);
        this.update();
      }
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (e.pointerType === 'touch') this.onTouchDetected();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Some browsers refuse capture for synthetic pointers; holding still works.
      }
      set.add(e.pointerId);
      el.classList.add('pressed');
      this.update();
    });
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  releaseAll(): void {
    this.keys.clear();
    for (const set of Object.values(this.pointers)) set.clear();
    document.querySelectorAll('.pressed').forEach((el) => el.classList.remove('pressed'));
    this.update();
  }

  private held(action: Action): boolean {
    if (this.pointers[action].size > 0) return true;
    for (const a of this.keys.values()) if (a === action) return true;
    return false;
  }

  private update(): void {
    const next: InputState = { aimLeft: this.held('left'), aimRight: this.held('right'), firing: this.held('fire') };
    const s = this.state;
    if (next.aimLeft === s.aimLeft && next.aimRight === s.aimRight && next.firing === s.firing) return;
    this.state = next;
    this.onChange(next);
  }
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}
