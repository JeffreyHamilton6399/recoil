// The first-person HUD: crosshair (with a ring while your gun readies and
// ticks that spread as you move and fire), hit and kill markers, damage
// percentage and power-ups, scoreboard, big comic banners (countdown,
// FIGHT!, round and match winners), the knock-off feed, the
// "click to play" hint and a red flash when you get hit.

import * as C from '../shared/constants.js';
import { MAPS, mapScale } from '../shared/maps.js';
import { FX_MEGA, FX_SPEED, FX_RAPID, FX_SHIELD, FX_TRIPLE, type PlayerId, type RosterEntry } from '../shared/types.js';
import { BOMB_WEAPON, OFFHANDS, weaponDef } from '../shared/weapons.js';
import { POWERUP_STYLE } from './art.js';
import type { View, ViewPlayer } from './scene.js';

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing from index.html`);
  return node;
}

const RING = 2 * Math.PI * 20;

/** Team mode: Red and Blue round wins, and who won the round and the match (-1 nobody, null not yet). */
export interface TeamInfo {
  scores: number[];
  round: number | null;
  match: number | null;
  /** Points to win (round wins, or captures). */
  target: number;
  /** Capture the flag: who carries each team's flag (-1 at home), and seconds left. */
  flags?: number[];
  timeLeft?: number;
}

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
  /** Team mode info, or null when it's everyone for themselves. */
  teams: TeamInfo | null;
  /** Your weapon, and how ready it is to fire again (0..1). */
  weapon: number;
  ready: number;
  aiming: boolean;
  /** How spread out the crosshair is (0 = tight). */
  spread: number;
  /** How much of a rush you're in (sliding, going fast): 0..1, for speed lines. */
  rush: number;
  /** Your offhand, and seconds until it's ready (0 = ready). */
  offhand: number;
  /** Holding the knife, and whether recoil mode is on. */
  knife: boolean;
  recoil: boolean;
  offLeft: number;
  /** Grappling hook: seconds until it's ready, and whether it's hooked on now. */
  hookLeft: number;
  hooked: boolean;
}

export class Hud {
  private readonly root = el('fps');
  private readonly crosshair = el('crosshair');
  private readonly ring = el('ready-ring');
  private readonly ticks = [...document.querySelectorAll<SVGPathElement>('#xh-ticks .tick')];
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
  private readonly speedlines = el('speedlines');
  private readonly scope = el('scope');
  private readonly clock = el('round-clock');
  private readonly koPop = el('ko-pop');
  private readonly mini = el('minimap') as HTMLCanvasElement;
  private miniIn = 0;
  private lastClock = '';
  /** A big line in the middle of the screen for a moment (sudden death). */
  private flash: { text: string; sub: string; until: number } | null = null;
  private clockTime = 0;

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

  hitMarker(kill = false): void {
    this.hit.classList.add('on');
    this.hit.classList.toggle('kill', kill);
    this.hitTimer = kill ? 0.35 : 0.12;
  }

  /** You knocked someone off: a pop-up under the crosshair. */
  knockout(name: string, color: string): void {
    this.koPop.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = 'KNOCKED OFF';
    const who = document.createElement('b');
    who.textContent = name.toUpperCase();
    who.style.setProperty('--c', color);
    this.koPop.append(label, who);
    this.koPop.classList.remove('on');
    void this.koPop.offsetWidth;
    this.koPop.classList.add('on');
  }

  /** A big message across the middle for a few seconds. */
  flashCenter(text: string, sub: string, seconds: number): void {
    this.flash = { text, sub, until: this.clockTime + seconds };
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
    this.clockTime += dt;
    this.root.classList.toggle('touch', info.touch);
    this.updateClock(info);
    this.miniIn -= dt;
    if (this.miniIn <= 0) {
      this.miniIn = 1 / 15;
      this.drawMinimap(info);
    }

    // Hit marker and hurt flash.
    this.hitTimer -= dt;
    if (this.hitTimer <= 0) this.hit.classList.remove('on', 'kill');
    this.hurtLevel = Math.max(0, this.hurtLevel - dt * 2.5);
    this.vignette.style.opacity = this.hurtLevel.toFixed(3);
    this.speedlines.style.opacity = (info.firstPerson ? info.rush * 0.55 : 0).toFixed(2);

    // Crosshair: a ring fills while a slow gun readies its next shot (hidden
    // once ready), and the ticks spread with movement and firing.
    this.crosshair.classList.toggle('hidden', !info.firstPerson);
    const def = weaponDef(info.weapon);
    const fill = info.knife ? 1 : info.ready;
    this.ring.setAttribute('stroke-dashoffset', (RING * (1 - fill)).toFixed(1));
    this.crosshair.classList.toggle('ready', fill >= 1 || def.mode === 'auto');
    const gap = info.spread * 9;
    const dirs: [number, number][] = [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ];
    this.ticks.forEach((t, i) => t.setAttribute('transform', `translate(${(dirs[i][0] * gap).toFixed(1)} ${(dirs[i][1] * gap).toFixed(1)})`));
    this.root.classList.toggle('aiming', info.aiming);
    this.scope.classList.toggle('hidden', !(info.aiming && def.scope));

    // Damage and power-ups.
    const alive = me !== undefined && me.fallTime < 0;
    this.vitals.classList.toggle('hidden', !alive);
    if (me) {
      const d = Math.round(me.damage);
      if (d !== this.lastDmg) {
        // The number punches up when it rises.
        if (d > this.lastDmg && this.lastDmg >= 0) {
          this.dmg.classList.remove('bump');
          void this.dmg.offsetWidth;
          this.dmg.classList.add('bump');
        }
        this.lastDmg = d;
        this.dmg.innerHTML = `${d}<small>%</small>`;
        const t = Math.min(1, d / 150);
        this.dmg.style.color = t < 0.5 ? `hsl(${50 - t * 40}, 100%, ${100 - t * 80}%)` : `hsl(${50 - t * 50}, 100%, ${70 - (t - 0.5) * 20}%)`;
      }
      const fx = me.fx & (FX_SHIELD | FX_RAPID | FX_TRIPLE | FX_MEGA | FX_SPEED);
      const hookWait = info.hooked ? -1 : Math.ceil(info.hookLeft * 2) / 2;
      const offLeft = Math.ceil(info.offLeft);
      const isKnife = info.offhand === C.OFFHAND_KNIFE;
      // The knife never cools down (a swing is quick), so only the grenade shows a countdown.
      const offWait = isKnife ? 0 : offLeft;
      const chipKey = `${fx}|${info.weapon}|${info.offhand}|${offWait}|${info.knife}|${info.recoil}|${hookWait}`;
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
        const hook = document.createElement('div');
        hook.className = hookWait > 0 ? 'chip cooling' : 'chip';
        hook.style.setProperty('--c', '#c9c4d8');
        hook.textContent = hookWait < 0 ? 'Q  HOOKED' : hookWait > 0 ? `Q  HOOK  ${hookWait.toFixed(1)}s` : 'Q  HOOK';
        this.chips.append(hook);
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
        add(FX_SPEED, 'speed');
      }
    }

    this.updateScorebar(view, info.teams);
    this.updateBanners(info);

    // Click-to-play hint for mouse players.
    const player = view.myId !== -1;
    const showHint = player && !info.touch && !info.locked;
    this.lockHint.classList.toggle('hidden', !showHint);
    if (showHint) this.lockHint.textContent = view.phase === 'lobby' ? 'Click to warm up · Esc frees the mouse' : 'Click to play';
  }

  private updateScorebar(view: View, teams: TeamInfo | null): void {
    const inMatch = view.phase !== 'lobby';
    const outIds = new Set(view.players.filter((p) => p.fallTime >= 0).map((p) => p.id));
    const inRound = new Set(view.players.map((p) => p.id));
    const key = inMatch ? JSON.stringify([view.roster, [...outIds], [...inRound], view.myId, teams?.scores, teams?.flags]) : '';
    if (key === this.lastScoreKey) return;
    this.lastScoreKey = key;
    this.scorebar.textContent = '';
    if (!inMatch) return;
    if (teams) {
      // Team mode: one line per team, its players' names and the team's points.
      for (const team of [0, 1]) {
        const members = view.roster.filter((r) => r.team === team);
        const item = document.createElement('div');
        item.className = 'sb';
        item.classList.toggle('me', members.some((r) => r.id === view.myId));
        item.classList.toggle('out', members.every((r) => outIds.has(r.id) || !inRound.has(r.id)));
        const dot = document.createElement('span');
        dot.className = 'pdot';
        dot.style.setProperty('--c', C.PLAYER_PALETTE[C.TEAM_COLORS[team]]);
        const name = document.createElement('span');
        const taken = (teams.flags?.[team] ?? -1) >= 0 ? ' · flag taken!' : '';
        name.textContent = `${C.TEAM_NAMES[team]}: ${members.map((r) => r.name).join(', ') || '—'}${taken}`;
        const score = teams.scores[team] ?? 0;
        const pts = document.createElement('span');
        pts.className = 'pts';
        pts.textContent = (teams.flags ? '⚑' : '●').repeat(Math.min(score, teams.target)) + '○'.repeat(Math.max(0, teams.target - score));
        item.append(dot, name, pts);
        this.scorebar.append(item);
      }
      return;
    }
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

  /**
   * The round clock by the menu button: time played, a countdown to the
   * bombs, then SUDDEN DEATH (or, in capture the flag, the time left).
   */
  private updateClock(info: HudInfo): void {
    const { view } = info;
    const fmt = (t: number): string => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    let text = '';
    let mode = '';
    if (view.phase === 'playing') {
      const t = view.phaseTime;
      if (info.teams?.flags) {
        const left = Math.max(0, info.teams.timeLeft ?? 0);
        text = `⚑ ${fmt(left)} left`;
        mode = left <= 30 ? 'warn' : '';
      } else if (t < C.BOMB_TIME) {
        const toBombs = C.BOMB_TIME - t;
        text = toBombs <= 15 ? `💣 Bombs in ${Math.ceil(toBombs)}` : `⏱ ${fmt(t)}`;
        mode = toBombs <= 15 ? 'warn' : '';
      } else {
        text = '💣 SUDDEN DEATH';
        mode = 'sudden';
      }
    }
    const key = `${text}|${mode}`;
    if (key === this.lastClock) return;
    this.lastClock = key;
    this.clock.textContent = text;
    this.clock.className = mode;
    this.clock.classList.toggle('hidden', text === '');
    this.root.classList.toggle('sudden', mode === 'sudden');
  }

  /**
   * A small top-down map: the rooftops (taller ones lighter), blocks, pads,
   * turrets, flags, falling bombs, everyone as a dot, and you as an arrow.
   */
  private drawMinimap(info: HudInfo): void {
    const { view } = info;
    const cv = this.mini;
    const show = view.myId !== -1 && view.phase !== 'lobby' ? true : view.myId !== -1;
    cv.classList.toggle('hidden', !show);
    if (!show) return;
    const px = cv.clientWidth || 140;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(px * dpr)) {
      cv.width = Math.round(px * dpr);
      cv.height = Math.round(px * dpr);
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const map = MAPS[view.mapIndex] ?? MAPS[0];
    const R = view.arenaRadius;
    const S = mapScale(R);
    const k = cv.width / 2 / (C.ARENA_START_RADIUS * 1.02);
    const cx = cv.width / 2;
    const X = (x: number): number => cx + x * k;
    const Y = (y: number): number => cx - y * k;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = 'rgba(13, 9, 24, 0.6)';
    ctx.beginPath();
    ctx.arc(cx, cx, cx - 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cx, cx - 2, 0, Math.PI * 2);
    ctx.clip();
    // Rooftops.
    ctx.fillStyle = map.theme.top;
    ctx.globalAlpha = 0.75;
    if (map.roofs) {
      for (const r of map.roofs) {
        ctx.fillStyle = (r.h ?? 0) > 0 ? '#e6e0f5' : map.theme.top;
        ctx.globalAlpha = (r.h ?? 0) > 0 ? 0.55 + Math.min(0.35, (r.h ?? 0) / 20) : 0.6;
        ctx.fillRect(X((r.x - r.w / 2) * S), Y((r.y + r.d / 2) * S), r.w * S * k, r.d * S * k);
      }
    } else if (map.shape === 'circle') {
      ctx.beginPath();
      ctx.arc(cx, cx, R * k, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const h = map.shape === 'square' ? R * C.SQUARE_HALF_SCALE : R * 0.95;
      ctx.fillRect(X(-h), Y(h), 2 * h * k, 2 * h * k);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(13, 9, 24, 0.9)';
    for (const hole of map.holes) {
      ctx.beginPath();
      ctx.arc(X(hole.x * S), Y(hole.y * S), hole.r * S * k, 0, Math.PI * 2);
      ctx.fill();
    }
    // Blocks and pads.
    ctx.fillStyle = 'rgba(40, 30, 70, 0.8)';
    for (const b of map.blocks) {
      if (Math.max(b.w, b.d) < 0.2) continue;
      ctx.fillRect(X((b.x - b.w / 2) * S), Y((b.y + b.d / 2) * S), Math.max(1, b.w * S * k), Math.max(1, b.d * S * k));
    }
    ctx.fillStyle = '#7fe7ff';
    for (const p of map.pads) {
      ctx.beginPath();
      ctx.arc(X(p.x * S), Y(p.y * S), Math.max(1.5, p.r * S * k), 0, Math.PI * 2);
      ctx.fill();
    }
    // Turrets.
    (map.turrets ?? []).forEach((t, i) => {
      const down = view.turrets?.[i]?.[2] === 1;
      ctx.fillStyle = down ? '#6b6680' : '#ff9f1c';
      const x = X(t.x * S);
      const y = Y(t.y * S);
      const r = 4 * dpr;
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r * 0.8);
      ctx.lineTo(x - r, y + r * 0.8);
      ctx.fill();
    });
    // Falling bombs.
    ctx.strokeStyle = '#ff3b4e';
    ctx.lineWidth = 2 * dpr;
    for (const b of view.bullets) {
      if (b.weapon !== BOMB_WEAPON) continue;
      ctx.beginPath();
      ctx.arc(X(b.x), Y(b.y), weaponDef(BOMB_WEAPON).splash * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Flags.
    view.flags?.forEach((f, team) => {
      ctx.fillStyle = C.PLAYER_PALETTE[C.TEAM_COLORS[team]];
      ctx.fillRect(X(f.x) - 3 * dpr, Y(f.y) - 7 * dpr, 6 * dpr, 5 * dpr);
      ctx.fillRect(X(f.x) - 3 * dpr, Y(f.y) - 7 * dpr, 1.5 * dpr, 10 * dpr);
    });
    // Everyone else, then you.
    for (const p of view.players) {
      if (p.id === view.myId || p.fallTime >= 0) continue;
      const r = view.roster.find((q) => q.id === p.id);
      ctx.fillStyle = C.PLAYER_PALETTE[r?.color ?? 0] ?? '#fff';
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), 3.2 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0d0918';
      ctx.lineWidth = 1 * dpr;
      ctx.stroke();
    }
    const me = view.players.find((p) => p.id === view.myId);
    if (me && me.fallTime < 0) {
      const x = X(me.x);
      const y = Y(me.y);
      const a = -me.yaw;
      const r = 6 * dpr;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#0d0918';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      ctx.lineTo(x + Math.cos(a + 2.5) * r * 0.8, y + Math.sin(a + 2.5) * r * 0.8);
      ctx.lineTo(x + Math.cos(a - 2.5) * r * 0.8, y + Math.sin(a - 2.5) * r * 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cx, cx - 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  private updateBanners(info: HudInfo): void {
    const { view, me } = info;
    const nameOf = (id: PlayerId | null): string => view.roster.find((r: RosterEntry) => r.id === id)?.name ?? 'Nobody';
    const myTeam = view.roster.find((r: RosterEntry) => r.id === view.myId)?.team ?? -1;
    let center = '';
    let small = false;
    let sub = '';
    switch (view.phase) {
      case 'countdown':
        center = String(Math.max(1, Math.ceil(C.COUNTDOWN_TIME - view.phaseTime)));
        sub = `${MAPS[view.mapIndex]?.name ?? ''} · ${MAPS[view.mapIndex]?.blurb ?? ''}`;
        break;
      case 'playing': {
        const flags = info.teams?.flags;
        if (this.flash && this.clockTime < this.flash.until) {
          center = this.flash.text;
          sub = this.flash.sub;
        } else if (view.phaseTime < C.FIGHT_BANNER_TIME) center = flags ? 'CAPTURE THE FLAG!' : 'FIGHT!';
        else if (me && me.fallTime >= 0) {
          center = 'KNOCKED OFF!';
          small = true;
          sub = flags ? 'Back in a moment' : 'Watching until the next round';
        } else if (view.myId === -1) {
          sub = 'The room is full, so you are watching';
        } else if (flags && myTeam >= 0) {
          const left = Math.max(0, Math.ceil(info.teams?.timeLeft ?? Infinity));
          if (flags[1 - myTeam] === view.myId) sub = `You have the ${C.TEAM_NAMES[1 - myTeam]} flag! Bring it home`;
          else if (flags[myTeam] >= 0) sub = 'Your flag has been taken! Knock them off';
          else if (left <= 30) sub = `${left}s left`;
        }
        break;
      }
      case 'roundEnd':
        if (info.teams) {
          const t = info.teams.round;
          center = t === null || t < 0 ? 'NOBODY WINS' : `${C.TEAM_NAMES[t].toUpperCase()} TEAM WINS!`;
          small = true;
          sub = t !== null && t >= 0 && t === myTeam ? 'Round point for your team!' : 'Next round coming up';
          break;
        }
        center = info.roundWinner === null || info.roundWinner < 0 ? 'NOBODY WINS' : `${nameOf(info.roundWinner).toUpperCase()} WINS!`;
        small = true;
        sub = info.roundWinner === view.myId ? 'Round point for you!' : 'Next round coming up';
        break;
      case 'matchEnd':
        if (info.teams) {
          const t = info.teams.match ?? -1;
          center = t < 0 ? "IT'S A DRAW!" : `${C.TEAM_NAMES[t].toUpperCase()} TEAM TAKES IT!`;
          small = true;
          sub = t === myTeam ? 'Champions of the rooftops!' : 'Back to the lobby soon';
          break;
        }
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
