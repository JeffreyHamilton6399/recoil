// DOM overlays: main menu (name + colour), lobby panel (players, colours,
// weapon picker, map carousel, start), banners, the room HUD and touch controls. The game
// itself is drawn on the canvas by scene.ts; the in-game HUD is hud.ts.

import * as C from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';
import type { PlayerId, RosterEntry } from '../shared/types.js';
import { WEAPONS } from '../shared/weapons.js';
import { FONT, INK, makeMapThumb, makeWeaponIcon } from './art.js';
import type { TouchElements } from './input.js';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing from index.html`);
  return node as T;
}

export interface UiHandlers {
  onQuick(): void;
  onCreate(): void;
  onJoin(code: string): void;
  onLeave(): void;
  onStart(): void;
  /** Host picked a map (-1 = random). */
  onPickMap(choice: number): void;
  /** Name or colour changed. */
  onProfile(): void;
  /** Picked a weapon. */
  onWeapon(weapon: number): void;
  /** Voice button: cycle off / push-to-talk / open mic. */
  onVoice(): void;
  /** Mute or unmute one player's voice. */
  onMutePlayer(id: PlayerId): void;
  onToggleMute(): void;
}

export interface LobbyInfo {
  code: string;
  roster: RosterEntry[];
  spectators: number;
  myId: PlayerId | -1;
  pub: boolean;
  /** Map index, or -1 for random with the spinner. */
  mapChoice: number;
  /** Public rooms: seconds until the match starts, or -1. */
  startsIn: number;
  /** Players you've muted, and who is talking right now. */
  muted: PlayerId[];
  speaking: PlayerId[];
}

type LobbyMode = 'public' | 'host' | 'guest';

const PROFILE_KEY = 'recoil-profile';

export class UI {
  readonly touchElements: TouchElements = {
    stick: el('t-stick'),
    knob: el('t-knob'),
    look: el('t-look'),
    fire: el('t-fire'),
    jump: el('t-jump'),
    slide: el('t-slide'),
    aim: el('t-aim'),
  };

  private readonly menu = el('menu');
  private readonly menuError = el('menu-error');
  private readonly codeInput = el<HTMLInputElement>('code-input');
  private readonly nameInput = el<HTMLInputElement>('name-input');
  private readonly menuColors = el('menu-colors');
  private readonly lobby = el('lobby');
  private readonly lobbyCode = el('lobby-code');
  private readonly lobbyUrl = el('lobby-url');
  private readonly copyBtn = el<HTMLButtonElement>('btn-copy');
  private readonly playerList = el('player-list');
  private readonly lobbyColors = el('lobby-colors');
  private readonly lobbyName = el<HTMLInputElement>('lobby-name');
  private readonly weaponList = el('weapon-list');
  private readonly weaponsSection = el('weapons-section');
  private readonly startBtn = el<HTMLButtonElement>('btn-start');
  private readonly lobbyStatus = el('lobby-status');
  private readonly carouselTrack = el('carousel-track');
  private readonly carouselDots = el('carousel-dots');
  private readonly carousel = el('carousel');
  private readonly mapsTitle = el('maps-title');
  private readonly pickMapBtn = el<HTMLButtonElement>('btn-pick-map');
  private readonly banner = el('banner');
  private readonly hud = el('hud');
  private readonly ping = el('ping');
  private readonly roomTag = el('room-tag');
  private readonly muteBtn = el<HTMLButtonElement>('btn-mute');
  private readonly voiceBtn = el<HTMLButtonElement>('btn-voice');
  private readonly touch = el('touch');

  private touchEnabled = false;
  private shareUrl = '';
  private carouselIndex = 0;
  private carouselTimer = 0;
  private takenColors = new Set<number>();
  private lastLobbyKey = '';
  /** Carousel card 0 is "Random", card k is map k - 1. */
  private mode: LobbyMode = 'public';
  private mapChoice = -1;

  name = '';
  color = 0;
  weapon = 0;

  constructor(private readonly handlers: UiHandlers) {
    this.loadProfile();
    this.nameInput.value = this.name;
    this.lobbyName.value = this.name;

    el('btn-quick').addEventListener('click', () => handlers.onQuick());
    el('btn-create').addEventListener('click', () => handlers.onCreate());
    this.pickMapBtn.addEventListener('click', () => handlers.onPickMap(this.carouselIndex - 1));
    el<HTMLFormElement>('join-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = this.codeInput.value.trim().toUpperCase();
      if (/^[A-Z]{4}$/.test(code)) handlers.onJoin(code);
      else this.setMenuError('Room codes are 4 letters.');
    });
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    });
    for (const input of [this.nameInput, this.lobbyName]) {
      input.maxLength = C.NAME_MAX;
      input.addEventListener('input', () => this.setName(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
    }
    this.copyBtn.addEventListener('click', () => void this.copyLink());
    this.startBtn.addEventListener('click', () => handlers.onStart());
    el('btn-lobby-leave').addEventListener('click', () => handlers.onLeave());
    el('btn-leave').addEventListener('click', () => handlers.onLeave());
    el('btn-lobby-toggle').addEventListener('click', () => {
      this.lobby.classList.toggle('collapsed');
    });
    this.muteBtn.addEventListener('click', () => handlers.onToggleMute());
    this.voiceBtn.addEventListener('click', () => handlers.onVoice());

    this.buildSwatches(this.menuColors);
    this.buildSwatches(this.lobbyColors);
    this.buildCarousel();
    this.buildWeapons();

    // No pinch-zoom, double-tap zoom or rubber-band scrolling on mobile.
    const stop = (e: Event): void => e.preventDefault();
    document.addEventListener('gesturestart', stop);
    document.addEventListener('dblclick', stop);
    document.addEventListener(
      'touchmove',
      (e) => {
        const t = e.target;
        if (t instanceof Element && t.closest('input, .scroll')) return;
        e.preventDefault();
      },
      { passive: false },
    );
    this.touch.addEventListener('touchstart', stop, { passive: false });

    if (window.matchMedia('(pointer: coarse)').matches) this.enableTouch();
  }

  enableTouch(): void {
    this.touchEnabled = true;
  }

  get isTouch(): boolean {
    return this.touchEnabled;
  }

  /** While the mouse is captured for play, the lobby panel gets out of the way. */
  setLocked(locked: boolean): void {
    this.lobby.classList.toggle('locked', locked);
  }

  // -------------------------------------------------------------------------
  // Profile (name + colour), remembered between visits
  // -------------------------------------------------------------------------

  private loadProfile(): void {
    this.color = Math.floor(Math.random() * C.PLAYER_PALETTE.length);
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (raw) {
        const v: unknown = JSON.parse(raw);
        if (typeof v === 'object' && v !== null) {
          const o = v as Record<string, unknown>;
          if (typeof o.name === 'string') this.name = o.name.slice(0, C.NAME_MAX);
          if (typeof o.color === 'number' && o.color >= 0 && o.color < C.PLAYER_PALETTE.length) this.color = o.color;
          if (typeof o.weapon === 'number' && WEAPONS[o.weapon]) this.weapon = o.weapon;
        }
      }
    } catch {
      // Storage unavailable: use defaults.
    }
  }

  private saveProfile(): void {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: this.name, color: this.color, weapon: this.weapon }));
    } catch {
      // Storage unavailable: the profile just isn't remembered.
    }
  }

  private setName(name: string): void {
    this.name = name.slice(0, C.NAME_MAX);
    if (this.nameInput.value !== this.name) this.nameInput.value = this.name;
    if (this.lobbyName.value !== this.name) this.lobbyName.value = this.name;
    this.saveProfile();
    this.handlers.onProfile();
  }

  private setColor(color: number): void {
    if (this.takenColors.has(color)) return;
    this.color = color;
    this.saveProfile();
    this.refreshSwatches();
    this.handlers.onProfile();
  }

  // -------------------------------------------------------------------------
  // Weapon picker
  // -------------------------------------------------------------------------

  private buildWeapons(): void {
    this.weaponList.textContent = '';
    WEAPONS.forEach((w, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'weapon';
      b.dataset.weapon = String(i);
      b.style.setProperty('--c', w.accent);
      const name = document.createElement('div');
      name.className = 'wname';
      name.textContent = `${i + 1}  ${w.name}`;
      const stats = document.createElement('div');
      stats.className = 'wstats';
      for (const [label, value] of [
        ['Power', w.stats.power],
        ['Rate', w.stats.rate],
        ['Range', w.stats.range],
        ['Move', w.stats.mobility],
      ] as const) {
        const l = document.createElement('span');
        l.textContent = label;
        const bars = document.createElement('span');
        bars.className = 'bars';
        for (let k = 1; k <= 5; k++) {
          const bar = document.createElement('i');
          if (k <= value) bar.className = 'on';
          bars.append(bar);
        }
        stats.append(l, bars);
      }
      const blurb = document.createElement('div');
      blurb.className = 'wblurb';
      blurb.textContent = w.blurb;
      b.append(makeWeaponIcon(i, 76, 38), name, stats, blurb);
      b.addEventListener('click', () => this.setWeapon(i));
      this.weaponList.append(b);
    });
    this.refreshWeapons();
  }

  private refreshWeapons(): void {
    this.weaponList.querySelectorAll<HTMLButtonElement>('.weapon').forEach((b) => {
      b.classList.toggle('selected', Number(b.dataset.weapon) === this.weapon);
    });
  }

  /** Picks a weapon (from a click or the number keys). */
  setWeapon(weapon: number): void {
    if (!WEAPONS[weapon] || weapon === this.weapon) return;
    this.weapon = weapon;
    this.saveProfile();
    this.refreshWeapons();
    this.handlers.onWeapon(weapon);
  }

  /** True while the lobby panel (and so the weapon picker) is up. */
  get inLobby(): boolean {
    return !this.lobby.classList.contains('hidden');
  }

  private buildSwatches(container: HTMLElement): void {
    container.textContent = '';
    C.PLAYER_PALETTE.forEach((hex, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.style.setProperty('--c', hex);
      b.dataset.color = String(i);
      b.setAttribute('aria-label', C.PLAYER_COLOR_NAMES[i] ?? `Colour ${i + 1}`);
      b.addEventListener('click', () => this.setColor(i));
      container.appendChild(b);
    });
    this.refreshSwatches();
  }

  private refreshSwatches(): void {
    document.querySelectorAll<HTMLButtonElement>('.swatch').forEach((b) => {
      const i = Number(b.dataset.color);
      b.classList.toggle('selected', i === this.color);
      b.disabled = this.takenColors.has(i) && i !== this.color;
    });
  }

  // -------------------------------------------------------------------------
  // Map carousel in the lobby
  // -------------------------------------------------------------------------

  private buildCarousel(): void {
    const addCard = (thumb: HTMLCanvasElement, title: string, text: string, label: string, extra: string): void => {
      const card = document.createElement('div');
      card.className = `map-card ${extra}`;
      thumb.className = 'map-thumb';
      const name = document.createElement('div');
      name.className = 'map-name';
      name.textContent = title;
      const blurb = document.createElement('div');
      blurb.className = 'map-blurb';
      blurb.textContent = text;
      card.append(thumb, name, blurb);
      this.carouselTrack.appendChild(card);

      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'cdot';
      dot.setAttribute('aria-label', label);
      const index = this.carouselDots.children.length;
      dot.addEventListener('click', () => this.showCard(index, true));
      this.carouselDots.appendChild(dot);
    };
    addCard(randomThumb(180), 'Random', 'A spinner picks a new map every round.', 'Random map', 'random');
    MAPS.forEach((map, i) => addCard(makeMapThumb(i, 180), map.name, map.blurb, map.name, ''));

    el('carousel-prev').addEventListener('click', () => this.showCard(this.carouselIndex - 1, true));
    el('carousel-next').addEventListener('click', () => this.showCard(this.carouselIndex + 1, true));
    this.showCard(0, false);
    this.restartAutoRotate(3000);
  }

  /** Public rooms and random-map guests see the maps rotate; hosts browse by hand. */
  private autoRotates(): boolean {
    return this.mode === 'public' || (this.mode === 'guest' && this.mapChoice === -1);
  }

  private restartAutoRotate(ms: number): void {
    window.clearInterval(this.carouselTimer);
    this.carouselTimer = window.setInterval(() => {
      if (!this.lobby.classList.contains('hidden') && this.autoRotates()) this.showCard(this.carouselIndex + 1, false);
    }, ms);
  }

  private showCard(i: number, manual: boolean): void {
    // Public rooms are always random, so they skip the "Random" card.
    const first = this.mode === 'public' ? 1 : 0;
    const count = MAPS.length + 1 - first;
    this.carouselIndex = first + ((((i - first) % count) + count) % count);
    this.carouselTrack.style.transform = `translateX(${-this.carouselIndex * 100}%)`;
    this.carouselDots.querySelectorAll<HTMLElement>('.cdot').forEach((d, k) => {
      d.classList.toggle('on', k === this.carouselIndex);
      d.classList.toggle('hidden', k < first);
    });
    this.refreshPickButton();
    if (manual) this.restartAutoRotate(6000); // give people time to look
  }

  private refreshPickButton(): void {
    const show = this.mode === 'host';
    this.pickMapBtn.classList.toggle('hidden', !show);
    if (!show) return;
    const chosen = this.carouselIndex - 1 === this.mapChoice;
    const name = this.carouselIndex === 0 ? 'Random' : (MAPS[this.carouselIndex - 1]?.name ?? '');
    this.pickMapBtn.disabled = chosen;
    this.pickMapBtn.textContent = chosen ? `✓ ${name} selected` : this.carouselIndex === 0 ? 'Use random maps' : `Play ${name}`;
  }

  /** Updates the carousel for the room type and the host's pick. */
  private setMapMode(mode: LobbyMode, mapChoice: number): void {
    const changed = mode !== this.mode || mapChoice !== this.mapChoice;
    this.mode = mode;
    this.mapChoice = mapChoice;
    const locked = mode === 'guest' && mapChoice >= 0;
    this.carousel.classList.toggle('locked', locked);
    if (mode === 'public') this.mapsTitle.textContent = 'Maps · a spinner picks one each round';
    else if (mode === 'host') this.mapsTitle.textContent = 'Pick the map · random spins a new one each round';
    else this.mapsTitle.textContent = mapChoice >= 0 ? 'The host picked this map' : 'Random map each round';
    if (changed) {
      if (mode === 'public') this.showCard(1, false);
      else this.showCard(mapChoice + 1, false);
    } else {
      this.refreshPickButton();
    }
  }

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  showMenu(error = ''): void {
    this.menu.classList.remove('hidden');
    this.lobby.classList.add('hidden');
    this.hud.classList.add('hidden');
    this.touch.classList.add('hidden');
    this.takenColors = new Set();
    this.refreshSwatches();
    this.setBanner(null);
    this.setMenuError(error);
  }

  setMenuError(msg: string): void {
    this.menuError.textContent = msg;
  }

  /** In a room: hide the menu, show the HUD and (for players on touch devices) the controls. */
  showRoom(code: string, canPlay: boolean): void {
    this.menu.classList.add('hidden');
    this.hud.classList.remove('hidden');
    this.roomTag.textContent = code;
    this.touch.classList.toggle('hidden', !(this.touchEnabled && canPlay));
  }

  /** Shows or updates the lobby panel. Pass null to hide it. */
  setLobby(info: LobbyInfo | null): void {
    if (!info) {
      this.lobby.classList.add('hidden');
      this.lastLobbyKey = '';
      return;
    }
    this.lobby.classList.remove('hidden');
    const key = JSON.stringify(info);
    if (key === this.lastLobbyKey) return;
    this.lastLobbyKey = key;

    this.shareUrl = `${location.origin}/?room=${info.code}`;
    this.lobbyCode.textContent = info.code;
    this.lobbyUrl.textContent = this.shareUrl;

    // Player list.
    this.playerList.textContent = '';
    for (const r of info.roster) {
      const li = document.createElement('li');
      li.classList.toggle('offline', !r.online);
      li.classList.toggle('me', r.id === info.myId);
      const dot = document.createElement('span');
      dot.className = 'pdot';
      dot.style.setProperty('--c', C.PLAYER_PALETTE[r.color] ?? C.PLAYER_PALETTE[0]);
      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = r.name + (r.id === info.myId ? ' (you)' : '');
      li.append(dot, name);
      if (r.host) {
        const host = document.createElement('span');
        host.className = 'ptag host';
        host.textContent = 'HOST';
        li.appendChild(host);
      }
      if (r.voice) {
        const mic = document.createElement('span');
        mic.className = 'vicon';
        mic.classList.toggle('talking', info.speaking.includes(r.id));
        mic.textContent = info.speaking.includes(r.id) ? '🔊' : '🎙';
        mic.title = 'Voice chat on';
        li.appendChild(mic);
        if (r.id !== info.myId) {
          const mute = document.createElement('button');
          mute.type = 'button';
          const isMuted = info.muted.includes(r.id);
          mute.className = 'pmute';
          mute.classList.toggle('on', isMuted);
          mute.textContent = isMuted ? 'Unmute' : 'Mute';
          mute.addEventListener('click', () => this.handlers.onMutePlayer(r.id));
          li.appendChild(mute);
        }
      }
      if (!r.online) {
        const off = document.createElement('span');
        off.className = 'ptag';
        off.textContent = 'reconnecting';
        li.appendChild(off);
      }
      this.playerList.appendChild(li);
    }
    for (let i = info.roster.length; i < C.MAX_PLAYERS; i++) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Open seat';
      this.playerList.appendChild(li);
    }
    if (info.spectators > 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = `+ ${info.spectators} watching`;
      this.playerList.appendChild(li);
    }

    // Colours taken by other players can't be picked.
    const me = info.roster.find((r) => r.id === info.myId);
    this.takenColors = new Set(info.roster.filter((r) => r.id !== info.myId).map((r) => r.color));
    if (me) {
      this.color = me.color;
      this.weapon = me.weapon;
    }
    this.refreshSwatches();
    this.refreshWeapons();
    this.weaponsSection.classList.toggle('hidden', info.myId === -1);
    this.lobbyColors.parentElement?.classList.toggle('hidden', info.myId === -1);

    // Map carousel mode, start button for the host, status for everyone else.
    const online = info.roster.filter((r) => r.online).length;
    const isHost = me?.host === true;
    const enough = online >= C.MIN_PLAYERS;
    this.setMapMode(info.pub ? 'public' : isHost ? 'host' : 'guest', info.mapChoice);
    this.startBtn.classList.toggle('hidden', !isHost);
    this.startBtn.disabled = !enough;
    this.startBtn.textContent = enough ? `Start match (${online} players)` : 'Start match';
    if (info.myId === -1) this.lobbyStatus.textContent = 'The room is full, so you are watching.';
    else if (info.pub && info.startsIn >= 0) this.lobbyStatus.textContent = `Match starts in ${info.startsIn}s. Click the city to warm up!`;
    else if (info.pub) this.lobbyStatus.textContent = 'Public game. Waiting for another player to join…';
    else if (!enough) this.lobbyStatus.textContent = 'Waiting for more players… share the link!';
    else if (isHost) this.lobbyStatus.textContent = 'Everyone in? Hit start. Click the city to warm up in the meantime!';
    else this.lobbyStatus.textContent = 'Waiting for the host to start. Click the city to warm up!';
  }

  setBanner(text: string | null): void {
    this.banner.classList.toggle('hidden', text === null);
    this.banner.textContent = text ?? '';
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

  /** Shows the voice chat mode on the mic button, glowing while you're talking. */
  setVoice(mode: 'off' | 'ptt' | 'open', live: boolean): void {
    const b = this.voiceBtn;
    b.dataset.mode = mode;
    b.classList.toggle('live', live);
    const tag = b.querySelector('.vtag');
    if (tag) tag.textContent = mode === 'ptt' ? 'V' : mode === 'open' ? 'ON' : '';
    const label = mode === 'off' ? 'Voice chat: off (click to turn on)' : mode === 'ptt' ? 'Voice chat: hold V to talk (click for open mic)' : 'Voice chat: open mic (click to turn off)';
    b.title = label;
    b.setAttribute('aria-label', label);
  }

  setMuted(muted: boolean): void {
    this.muteBtn.classList.toggle('muted', muted);
    this.muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
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
    this.copyBtn.textContent = ok ? 'Copied!' : 'Copy failed';
    window.setTimeout(() => (this.copyBtn.textContent = 'Copy link'), 1800);
  }
}

/** Thumbnail for the "Random" card: four little maps and a big question mark. */
function randomThumb(px: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = px;
  cv.height = px;
  const ctx = cv.getContext('2d');
  if (!ctx) return cv;
  ctx.fillStyle = '#261c66';
  ctx.fillRect(0, 0, px, px);
  const half = px / 2;
  [0, 2, 4, 5].forEach((mapIndex, k) => {
    ctx.drawImage(makeMapThumb(mapIndex, half), (k % 2) * half, Math.floor(k / 2) * half, half, half);
  });
  ctx.font = `900 ${px * 0.62}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = px * 0.07;
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.strokeText('?', half + px * 0.04, half + px * 0.06);
  ctx.fillText('?', half + px * 0.04, half + px * 0.06);
  ctx.strokeText('?', half, half);
  ctx.fillStyle = '#ffd93d';
  ctx.fillText('?', half, half);
  return cv;
}
