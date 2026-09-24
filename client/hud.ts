// The first-person HUD: crosshair with a charge ring, hit marker, damage
// percentage and power-ups, scoreboard, big comic banners (countdown,
// FIGHT!, round and match winners), the knock-off feed, the
// "click to play" hint and a red flash when you get hit.

import * as C from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';
import { FX_MEGA, FX_RAPID, FX_SHIELD, FX_TRIPLE, type PlayerId, type RosterEntry } from '../shared/types.js';
import { OFFHANDS, weaponDef } from '../shared/weapons.js';
import { POWERUP_STYLE } from './art.js';
import type { View, ViewPlayer } from './scene.js';

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing from index.html`);
  return node;
}

const RING = 2 * Math.PI * 20;

export interface HudInfo {
  view: View;
  /** Your player (predicted), or undefined when watching. */
  me: ViewPlayer | undefined;
  firstPerson: boolean;
  /** Mouse captured for play (always true on touch devices). */
  locked: boolean;
  touch: boolean;
  roundWinner: PlayerId | null;
  matchWinner: PlayerId | null;
  /** Your weapon, and how ready it is to fire again (0..1). */
  weapon: number;
  ready: number;
  aiming: boolean;
  /** Your offhand, and seconds until it's ready (0 = ready). */
  offhand: number;
  /** Holding the knife, and whether recoil mode is on. */
  knife: boolean;
  recoil: boolean;
  offLeft: number;
}

export class Hud {
  private readonly root = el('fps');
  private readonly crosshair = el('crosshair');
  private readonly ring = el('charge-ring');
  private readonly hit = el('hitmarker');
  private readonly scorebar = el('scorebar');
  private readonly center = el('center-text');
  private readonly sub = el('sub-text');
  private readonly feed = el('feed');
  private readonly vitals = el('vitals');
  private readonly dmg = el('dmg');
  private readonly chips = el('chips');
  private readonly lockHint = el('lock-hint');
  private readonly vignette = el('vignette');
  private readonly scope = el('scope');

  private hurtLevel = 0;
  private hitTimer = 0;
  private lastScoreKey = '';
  private lastChips = '';
  private lastDmg = -1;
  private lastCenter = '';
  private lastSub = '';

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  hitMarker(): void {
    this.hit.classList.add('on');
    this.hitTimer = 0.12;
  }

  hurt(force: number): void {
    this.hurtLevel = Math.min(1, this.hurtLevel + 0.35 + force / 30);
  }

  /** Adds a line to the feed. Parts are plain text or [text, colour] for a player name. */
  addFeed(parts: (string | [string, string])[]): void {
    const line = document.createElement('div');
    line.className = 'feed-line';
    for (const part of parts) {
      if (typeof part === 'string') {
        line.append(part);
      } else {
        const b = document.createElement('b');
        b.textContent = part[0];
        b.style.setProperty('--c', part[1]);
        line.append(b);
      }
    }
    this.feed.prepend(line);
    while (this.feed.children.length > 5) this.feed.lastElementChild?.remove();
    window.setTimeout(() => line.remove(), 5000);
  }

  update(info: HudInfo, dt: number): void {
    const { view, me } = info;
    this.root.classList.toggle('touch', info.touch);

    // Hit marker and hurt flash.
    this.hitTimer -= dt;
    if (this.hitTimer <= 0) this.hit.classList.remove('on');
    this.hurtLevel = Math.max(0, this.hurtLevel - dt * 2.5);
    this.vignette.style.opacity = this.hurtLevel.toFixed(3);

    // Crosshair ring: the charge for charge weapons, the reload for automatic ones.
    this.crosshair.classList.toggle('hidden', !info.firstPerson);
    const def = weaponDef(info.weapon);
    const fill = def.mode === 'charge' ? (me?.charge ?? 0) : info.ready;
    this.ring.setAttribute('stroke-dashoffset', (RING * (1 - fill)).toFixed(1));
    this.crosshair.classList.toggle('full', def.mode === 'charge' && fill >= 1);
    this.root.classList.toggle('aiming', info.aiming);
    this.scope.classList.toggle('hidden', !(info.aiming && def.scope));

    // Damage and power-ups.
    const alive = me !== undefined && me.fallTime < 0;
    this.vitals.classList.toggle('hidden', !alive);
    if (me) {
      const d = Math.round(me.damage);
      if (d !== this.lastDmg) {
        this.lastDmg = d;
        this.dmg.innerHTML = `${d}<small>%</small>`;
        const t = Math.min(1, d / 150);
        this.dmg.style.color = t < 0.5 ? `hsl(${50 - t * 40}, 100%, ${100 - t * 80}%)` : `hsl(${50 - t * 50}, 100%, ${70 - (t - 0.5) * 20}%)`;
      }
      const fx = me.fx & (FX_SHIELD | FX_RAPID | FX_TRIPLE | FX_MEGA);
      const offLeft = Math.ceil(info.offLeft);
      const isKnife = info.offhand === C.OFFHAND_KNIFE;
      // The knife never cools down (a swing is quick), so only the grenade shows a countdown.
      const offWait = isKnife ? 0 : offLeft;
      const chipKey = `${fx}|${info.weapon}|${info.offhand}|${offWait}|${info.knife}|${info.recoil}`;
      if (chipKey !== this.lastChips) {
        this.lastChips = chipKey;
        this.chips.textContent = '';
        const off = OFFHANDS[info.offhand] ?? OFFHANDS[0];
        // What's in your hand first, then what E does.
        const held = document.createElement('div');
        held.className = 'chip';
        held.style.setProperty('--c', info.knife ? off.accent : def.accent);
        held.textContent = info.knife ? 'KNIFE' : def.name.toUpperCase();
        this.chips.append(held);
        const offChip = document.createElement('div');
        offChip.className = offWait > 0 ? 'chip cooling' : 'chip';
        offChip.style.setProperty('--c', isKnife ? def.accent : off.accent);
        offChip.textContent = isKnife
          ? `E  ${info.knife ? def.name.toUpperCase() : 'KNIFE'}`
          : offWait > 0
            ? `E  ${off.name.toUpperCase()}  ${offWait}s`
            : `E  ${off.name.toUpperCase()}`;
        this.chips.append(offChip);
        const recoil = document.createElement('div');
        recoil.className = info.recoil ? 'chip' : 'chip cooling';
        recoil.style.setProperty('--c', '#ffd93d');
        recoil.textContent = info.recoil ? 'R  RECOIL ON' : 'R  RECOIL OFF';
        this.chips.append(recoil);
        const add = (bit: number, kind: keyof typeof POWERUP_STYLE): void => {
          if (!(fx & bit)) return;
          const chip = document.createElement('div');
          chip.className = 'chip';
          chip.style.setProperty('--c', POWERUP_STYLE[kind].color);
          chip.textContent = POWERUP_STYLE[kind].label;
          this.chips.append(chip);
        };
        add(FX_SHIELD, 'shield');
        add(FX_RAPID, 'rapid');
        add(FX_TRIPLE, 'triple');
        add(FX_MEGA, 'mega');
      }
    }

    this.updateScorebar(view);
    this.updateBanners(info);

    // Click-to-play hint for mouse players.
    const player = view.myId !== -1;
    const showHint = player && !info.touch && !info.locked;
    this.lockHint.classList.toggle('hidden', !showHint);
    if (showHint) this.lockHint.textContent = view.phase === 'lobby' ? 'Click to warm up · Esc frees the mouse' : 'Click to play';
  }

  private updateScorebar(view: View): void {
    const inMatch = view.phase !== 'lobby';
    const outIds = new Set(view.players.filter((p) => p.fallTime >= 0).map((p) => p.id));
    const inRound = new Set(view.players.map((p) => p.id));
    const key = inMatch ? JSON.stringify([view.roster, [...outIds], [...inRound], view.myId]) : '';
    if (key === this.lastScoreKey) return;
    this.lastScoreKey = key;
    this.scorebar.textContent = '';
    if (!inMatch) return;
    for (const r of view.roster) {
      const item = document.createElement('div');
      item.className = 'sb';
      item.classList.toggle('me', r.id === view.myId);
      item.classList.toggle('out', outIds.has(r.id) || !inRound.has(r.id));
      const dot = document.createElement('span');
      dot.className = 'pdot';
      dot.style.setProperty('--c', C.PLAYER_PALETTE[r.color] ?? C.PLAYER_PALETTE[0]);
      const name = document.createElement('span');
      name.textContent = r.name;
      const pts = document.createElement('span');
      pts.className = 'pts';
      pts.textContent = '●'.repeat(Math.min(r.score, C.WIN_SCORE)) + '○'.repeat(Math.max(0, C.WIN_SCORE - r.score));
      item.append(dot, name, pts);
      this.scorebar.append(item);
    }
  }

  private updateBanners(info: HudInfo): void {
    const { view, me } = info;
    const nameOf = (id: PlayerId | null): string => view.roster.find((r: RosterEntry) => r.id === id)?.name ?? 'Nobody';
    let center = '';
    let small = false;
    let sub = '';
    switch (view.phase) {
      case 'countdown':
        center = String(Math.max(1, Math.ceil(C.COUNTDOWN_TIME - view.phaseTime)));
        sub = `${MAPS[view.mapIndex]?.name ?? ''} · ${MAPS[view.mapIndex]?.blurb ?? ''}`;
        break;
      case 'playing':
        if (view.phaseTime < C.FIGHT_BANNER_TIME) center = 'FIGHT!';
        else if (me && me.fallTime >= 0) {
          center = 'KNOCKED OFF!';
          small = true;
          sub = 'Watching until the next round';
        } else if (view.myId === -1) {
          sub = 'The room is full, so you are watching';
        }
        break;
      case 'roundEnd':
        center = info.roundWinner === null || info.roundWinner < 0 ? 'NOBODY WINS' : `${nameOf(info.roundWinner).toUpperCase()} WINS!`;
        small = true;
        sub = info.roundWinner === view.myId ? 'Round point for you!' : 'Next round coming up';
        break;
      case 'matchEnd':
        center = `${nameOf(info.matchWinner).toUpperCase()} TAKES IT!`;
        small = true;
        sub = info.matchWinner === view.myId ? 'Champion of the rooftops!' : 'Back to the lobby soon';
        break;
      case 'lobby':
        break;
    }
    const key = `${center}|${small}`;
    if (key !== this.lastCenter) {
      this.lastCenter = key;
      this.center.textContent = center;
      this.center.classList.toggle('small', small);
    }
    if (sub !== this.lastSub) {
      this.lastSub = sub;
      this.sub.textContent = sub;
      this.sub.classList.toggle('hidden', sub === '');
    }
  }
}
