// DOM overlays: menu, lobby, banners, match-end buttons, HUD and touch
// controls. The game itself is drawn on the canvas by render.ts.

import type { Insets } from './render.js';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing from index.html`);
  return node as T;
}

export interface UiHandlers {
  onCreate(): void;
  onJoin(code: string): void;
  onLeave(): void;
  onRematch(): void;
  onToggleMute(): void;
}

export class UI {
  readonly touchButtons = { left: el('t-left'), right: el('t-right'), fire: el('t-fire') };

  private readonly menu = el('menu');
  private readonly home = el('menu-home');
  private readonly lobby = el('menu-lobby');
  private readonly menuError = el('menu-error');
  private readonly codeInput = el<HTMLInputElement>('code-input');
  private readonly lobbyCode = el('lobby-code');
  private readonly lobbyUrl = el('lobby-url');
  private readonly copyBtn = el<HTMLButtonElement>('btn-copy');
  private readonly banner = el('banner');
  private readonly matchEnd = el('match-end');
  private readonly rematchBtn = el<HTMLButtonElement>('btn-rematch');
  private readonly hud = el('hud');
  private readonly ping = el('ping');
  private readonly roomTag = el('room-tag');
  private readonly muteBtn = el<HTMLButtonElement>('btn-mute');
  private readonly touch = el('touch');
  private touchEnabled = false;
  private shareUrl = '';

  constructor(handlers: UiHandlers) {
    el('btn-create').addEventListener('click', () => handlers.onCreate());
    el<HTMLFormElement>('join-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = this.codeInput.value.trim().toUpperCase();
      if (/^[A-Z]{4}$/.test(code)) handlers.onJoin(code);
      else this.setMenuError('Room codes are 4 letters.');
    });
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    });
    this.copyBtn.addEventListener('click', () => void this.copyLink());
    el('btn-lobby-leave').addEventListener('click', () => handlers.onLeave());
    el('btn-leave').addEventListener('click', () => handlers.onLeave());
    el('btn-menu').addEventListener('click', () => handlers.onLeave());
    this.rematchBtn.addEventListener('click', () => handlers.onRematch());
    this.muteBtn.addEventListener('click', () => handlers.onToggleMute());

    // No pinch-zoom, double-tap zoom or rubber-band scrolling on mobile.
    const stop = (e: Event): void => e.preventDefault();
    document.addEventListener('gesturestart', stop);
    document.addEventListener('dblclick', stop);
    document.addEventListener(
      'touchmove',
      (e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      },
      { passive: false },
    );
    this.touch.addEventListener('touchstart', stop, { passive: false });

    if (window.matchMedia('(pointer: coarse)').matches) this.enableTouch();
  }

  enableTouch(): void {
    this.touchEnabled = true;
  }

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  showMenu(error = ''): void {
    this.menu.classList.remove('hidden');
    this.home.classList.remove('hidden');
    this.lobby.classList.add('hidden');
    this.hud.classList.add('hidden');
    this.matchEnd.classList.add('hidden');
    this.touch.classList.add('hidden');
    this.setBanner(null);
    this.setMenuError(error);
  }

  setMenuError(msg: string): void {
    this.menuError.textContent = msg;
  }

  /** Shows the room code and share link while waiting for an opponent. */
  showLobby(code: string): void {
    this.shareUrl = `${location.origin}/?room=${code}`;
    this.lobbyCode.textContent = code;
    this.lobbyUrl.textContent = this.shareUrl;
    this.menu.classList.remove('hidden');
    this.home.classList.add('hidden');
    this.lobby.classList.remove('hidden');
    this.hud.classList.remove('hidden');
  }

  /** Hides the menu and shows the in-game HUD. */
  showGame(code: string, isPlayer: boolean): void {
    this.menu.classList.add('hidden');
    this.hud.classList.remove('hidden');
    this.roomTag.textContent = code;
    this.touch.classList.toggle('hidden', !(this.touchEnabled && isPlayer));
  }

  get touchVisible(): boolean {
    return !this.touch.classList.contains('hidden');
  }

  setBanner(text: string | null): void {
    this.banner.classList.toggle('hidden', text === null);
    this.banner.textContent = text ?? '';
  }

  setMatchEnd(visible: boolean, isPlayer: boolean, iVoted: boolean, theyVoted: boolean): void {
    this.matchEnd.classList.toggle('hidden', !visible);
    if (!visible) return;
    this.rematchBtn.classList.toggle('hidden', !isPlayer);
    this.rematchBtn.disabled = iVoted;
    this.rematchBtn.textContent = iVoted ? 'Waiting for opponent…' : theyVoted ? 'Rematch (opponent is ready)' : 'Rematch';
  }

  setPing(ms: number | null): void {
    if (ms === null) {
      this.ping.textContent = '– ms';
      this.ping.dataset.q = 'bad';
      return;
    }
    this.ping.textContent = `${Math.round(ms)} ms`;
    this.ping.dataset.q = ms < 80 ? 'good' : ms < 160 ? 'ok' : 'bad';
  }

  setMuted(muted: boolean): void {
    this.muteBtn.classList.toggle('muted', muted);
    this.muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  }

  /** Screen areas covered by UI, so the renderer can keep the arena clear of them. */
  insets(): Insets {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const top = Math.min(110, Math.max(80, Math.min(w, h) * 0.16));
    if (!this.touchVisible) return { top, right: 12, bottom: 12, left: 12 };
    if (h >= w) return { top, right: 8, bottom: 170, left: 8 };
    return { top: Math.min(top, 70), right: 170, bottom: 8, left: 170 };
  }

  private async copyLink(): Promise<void> {
    let ok = false;
    try {
      await navigator.clipboard.writeText(this.shareUrl);
      ok = true;
    } catch {
      // Clipboard API needs HTTPS; fall back to the old way.
      const ta = document.createElement('textarea');
      ta.value = this.shareUrl;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
    }
    this.copyBtn.textContent = ok ? 'Copied!' : 'Copy failed: select the link above';
    window.setTimeout(() => (this.copyBtn.textContent = 'Copy link'), 1800);
  }
}
