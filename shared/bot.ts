// Bot players. A bot looks at the game state each tick and produces the same
// InputState a person would, so it moves, jumps, slides and shoots under
// exactly the same rules. Nothing is faked: bots can't see through walls,
// turn instantly or aim perfectly, and they fall off the roof like anyone.
//
// One brain, three skill levels. Difficulty only changes how quickly a bot
// reacts, how accurately and how fast it aims, how well it leads moving
// targets, how smart its charged shots are, how often it dodges, and how
// cleverly it uses its offhand and the arena's edge.

import * as C from './constants.js';
import { floorAt, inBlock, isOffMap, type MapDef } from './maps.js';
import { clearLine, climbs, findPath, navGrid, type Climb, type NavGrid } from './nav.js';
import { NO_INPUT, angleDiff, clamp, currentMap, phaseRules, wrapAngle } from './sim.js';
import type { GameState, InputState, PlayerId, PlayerState } from './types.js';
import { weaponDef } from './weapons.js';

/** 1 easy, 2 medium, 3 hard. */
export type BotLevel = 1 | 2 | 3;

export const BOT_LEVEL_NAMES: Record<BotLevel, string> = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };

export function isBotLevel(v: unknown): v is BotLevel {
  return v === 1 || v === 2 || v === 3;
}

interface Skill {
  /** Seconds between something happening and the bot reacting to it. */
  reaction: number;
  /** Typical aim wobble in radians. */
  aimError: number;
  /** How fast it can turn, radians per second. */
  turnRate: number;
  /** 0..1: how well it leads a moving target. */
  lead: number;
  /** Fires only when its aim is within this many radians of the target. */
  fireCone: number;
  /** Chance per incoming shot of trying to dodge it. */
  dodge: number;
  /** 0..1: how readily and cleverly it uses its offhand. */
  offhand: number;
  /** 0..1: how carefully it keeps away from the edge. */
  caution: number;
  /** 0..1: how well it picks the charge for each shot. */
  chargeSense: number;
  /** 0..1: how much it strafes, hops and slides to be hard to hit. */
  agility: number;
  /** 0..1: how often it takes the high ground (roofs and bridges) or chases people up there. */
  highGround: number;
}

const SKILLS: Record<BotLevel, Skill> = {
  1: { reaction: 0.55, aimError: 0.13, turnRate: 3, lead: 0.2, fireCone: 0.18, dodge: 0, offhand: 0.15, caution: 0.55, chargeSense: 0.2, agility: 0.2, highGround: 0.15 },
  2: { reaction: 0.28, aimError: 0.055, turnRate: 6, lead: 0.7, fireCone: 0.1, dodge: 0.35, offhand: 0.55, caution: 0.85, chargeSense: 0.65, agility: 0.6, highGround: 0.5 },
  3: { reaction: 0.13, aimError: 0.02, turnRate: 11, lead: 1, fireCone: 0.06, dodge: 0.8, offhand: 1, caution: 1, chargeSense: 1, agility: 1, highGround: 0.85 },
};

/** Preferred fighting distance per weapon (Blaster, Scatter, Longshot, Boomer, Pepper). */
const RANGE = [11, 5, 20, 12, 10];

interface Seen {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export class BotBrain {
  readonly level: BotLevel;
  private readonly skill: Skill;
  private yaw = 0;
  private pitch = 0;
  private started = false;
  private targetId: PlayerId = -1;
  private retargetIn = 0;
  private strafeDir = 1;
  private strafeIn = 0;
  private noiseYaw = 0;
  private noisePitch = 0;
  private noiseIn = 0;
  private wantCharge = 0;
  private chargeFor = 0;
  private offPressed = false;
  private hopIn = 1;
  private lastCrouch = false;
  /** 'fight' as usual, 'climb' heading up a ramp, 'high' holding a roof or bridge. */
  private mode: 'fight' | 'climb' | 'high' = 'fight';
  private modeFor = 0;
  private decideIn = 2;
  private holdFor = 0;
  private climb: Climb | null = null;
  /** Route waypoints (A*), and where it goes. */
  private route: [number, number][] = [];
  private routeTo: [number, number] = [0, 0];
  private replanIn = 0;
  private stuckFor = 0;
  private lastX = 0;
  private lastY = 0;
  /** What the bot has seen of each player recently, oldest first (for reaction delay). */
  private readonly memory = new Map<PlayerId, Seen[]>();

  constructor(level: BotLevel) {
    this.level = level;
    this.skill = SKILLS[level];
  }

  /** One tick of controls for bot player `me`. */
  think(s: GameState, me: PlayerState, dt: number = C.TICK_DT): InputState {
    const sk = this.skill;
    if (!this.started || s.phase === 'mapPick' || (s.phase === 'countdown' && s.phaseTime < 0.1)) {
      // New round: start from where the server faced us.
      this.yaw = me.yaw;
      this.pitch = me.pitch;
      this.started = true;
    }
    const idle: InputState = { ...NO_INPUT, yaw: this.yaw, pitch: this.pitch };
    if (!me.inRound || me.falling) return idle;

    const map = currentMap(s);
    const R = s.arenaRadius;
    const { canMove, canFire } = phaseRules(s.phase);
    const enemies = s.players.filter((p) => p.id !== me.id && p.inRound && !p.falling);
    this.remember(s);

    // ---- Target ---------------------------------------------------------
    this.retargetIn -= dt;
    let target = enemies.find((p) => p.id === this.targetId);
    if (!target || this.retargetIn <= 0) {
      target = this.pickTarget(me, enemies, map, R) ?? undefined;
      this.targetId = target?.id ?? -1;
      this.retargetIn = 0.6 + Math.random() * 0.8;
    }
    const seen = target ? this.perceive(target.id) : null;

    // ---- Aim ------------------------------------------------------------
    const w = weaponDef(me.weapon);
    const eyeZ = me.z + (me.slide > 0 ? C.SLIDE_EYE_HEIGHT : C.EYE_HEIGHT);
    let dist = Infinity;
    let visible = false;
    if (seen) {
      dist = Math.hypot(seen.x - me.x, seen.y - me.y);
      const charge = w.mode === 'charge' ? Math.max(me.charge, this.wantCharge) : 1;
      const speed = w.speed[0] + (w.speed[1] - w.speed[0]) * charge;
      const t = (dist / speed) * sk.lead;
      const ax = seen.x + seen.vx * t;
      const ay = seen.y + seen.vy * t;
      // Aim at the chest; lead jumps a little too.
      const az = seen.z + 1.05 + (seen.vz > 0 ? seen.vz * t * 0.5 : 0);
      const flat = Math.hypot(ax - me.x, ay - me.y) || 1e-3;
      let wantPitch = Math.atan2(az - eyeZ, flat);
      if (w.gravity > 0) {
        // Lob: raise the aim so the drop over the flight lands on target.
        const tf = flat / speed;
        wantPitch = Math.atan2(az - eyeZ + 0.5 * w.gravity * tf * tf, flat);
      }
      const wantYaw = Math.atan2(ay - me.y, ax - me.x);

      // Aim wobble that drifts rather than jitters, worse at long range.
      this.noiseIn -= dt;
      if (this.noiseIn <= 0) {
        const amp = sk.aimError * (0.6 + Math.min(1.5, dist / 15));
        this.noiseYaw = (Math.random() * 2 - 1) * amp;
        this.noisePitch = (Math.random() * 2 - 1) * amp * 0.5;
        this.noiseIn = 0.25 + Math.random() * 0.4;
      }
      this.turnTowards(wantYaw + this.noiseYaw, wantPitch + this.noisePitch, dt);
      visible = this.lineOfSight(map, R, me.x, me.y, eyeZ, ax, ay, az);
    } else {
      // Nobody to fight: look around the middle of the roof.
      this.turnTowards(Math.atan2(-me.y, -me.x), 0, dt);
    }
    const aimErr = seen ? Math.abs(angleDiff(this.yaw, Math.atan2(seen.y - me.y, seen.x - me.x))) : Math.PI;

    // ---- Move -----------------------------------------------------------
    let wx = 0;
    let wy = 0;
    let jump = false;
    let crouch = false;
    let sprint = false;
    const grid = navGrid(map, R);
    const fromCentre = Math.hypot(me.x, me.y);
    const up = me.z > 1.2; // standing on a roof, bridge or ramp
    // Where our momentum takes us in a moment.
    const aheadX = me.x + me.vx * 0.45;
    const aheadY = me.y + me.vy * 0.45;
    const danger = this.edgeDanger(map, R, aheadX, aheadY) || fromCentre > R * (0.95 - 0.35 * sk.caution);

    // Plans: now and then, head for the high ground, or chase someone up there.
    this.decideIn -= dt;
    if (this.mode === 'fight' && this.decideIn <= 0 && me.grounded && !up) {
      this.decideIn = 2 + Math.random() * 3;
      const ways = climbs(map, R);
      if (ways.length > 0 && Math.random() < sk.highGround) {
        const nearest = enemies.reduce((m, p) => Math.min(m, Math.hypot(p.x - me.x, p.y - me.y)), Infinity);
        const longGun = me.weapon === 0 || me.weapon === 2 || me.weapon === 4;
        const targetUp = target !== undefined && target.z > 1.2;
        if ((longGun && nearest > 9) || (targetUp && (!longGun || !visible))) {
          // Chasing: the way up nearest them. Otherwise: the way up nearest us.
          const [rx, ry] = targetUp && target ? [target.x, target.y] : [me.x, me.y];
          this.climb = ways.reduce((best, c) => (Math.hypot(c.topX - rx, c.topY - ry) < Math.hypot(best.topX - rx, best.topY - ry) ? c : best));
          this.mode = 'climb';
          this.modeFor = 0;
          this.route = [];
        }
      }
    }
    this.modeFor += dt;

    if (!me.grounded) {
      // In the air (jumping or knocked back): steer home if we're drifting out.
      if (danger || fromCentre > R * 0.5) [wx, wy] = unit(-me.x, -me.y);
    } else if (danger && !up) {
      this.mode = 'fight';
      [wx, wy] = this.goto(grid, me, 0, 0, dt);
      sprint = true;
    } else if (this.mode === 'climb' && this.climb) {
      const c = this.climb;
      if (me.z >= c.h - 0.3) {
        // Made it: hold the high ground for a while.
        this.mode = 'high';
        this.modeFor = 0;
        this.holdFor = 5 + Math.random() * 10 * sk.highGround;
      } else if (this.modeFor > 14) {
        this.mode = 'fight';
      } else if (me.z > 0.15 || Math.hypot(c.entryX - me.x, c.entryY - me.y) < 1.2) {
        // On the ramp: straight up it.
        wx = c.dx;
        wy = c.dy;
        sprint = true;
      } else {
        [wx, wy] = this.goto(grid, me, c.entryX, c.entryY, dt);
        sprint = true;
      }
    } else if (this.mode === 'high' && this.climb) {
      const c = this.climb;
      this.holdFor -= dt;
      if (!up || this.holdFor <= 0 || (seen !== null && dist < 4 && me.weapon !== 1)) {
        // Knocked off, bored, or someone's too close: back to the fight.
        this.mode = 'fight';
        this.decideIn = 3 + Math.random() * 3;
      } else {
        // Stay near the top spot, strafing a little, but never step off the edge.
        const toTop = Math.hypot(c.topX - me.x, c.topY - me.y);
        if (toTop > 2) [wx, wy] = unit(c.topX - me.x, c.topY - me.y);
        else if (seen) {
          const [tx, ty] = unit(seen.x - me.x, seen.y - me.y);
          wx = -ty * this.strafeDir * 0.5;
          wy = tx * this.strafeDir * 0.5;
        }
      }
    } else if (seen) {
      this.mode = 'fight';
      const want = RANGE[me.weapon] ?? 10;
      const [tx, ty] = unit(seen.x - me.x, seen.y - me.y);
      // Close in or back off to our weapon's range...
      const along = dist > want + 3 ? 1 : dist < want - 2 ? -0.8 : 0;
      // ...while strafing, switching direction now and then.
      this.strafeIn -= dt;
      if (this.strafeIn <= 0) {
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
        this.strafeIn = 0.6 + Math.random() * (2.4 - sk.agility * 1.4);
      }
      const side = 0.35 + sk.agility * 0.65;
      wx = tx * along + -ty * this.strafeDir * side;
      wy = ty * along + tx * this.strafeDir * side;
      // Drift back towards the middle as the roof shrinks.
      const pull = clamp((fromCentre / R - 0.45) * 2, 0, 1) * sk.caution;
      wx += (-me.x / (fromCentre || 1)) * pull;
      wy += (-me.y / (fromCentre || 1)) * pull;
      sprint = along > 0 && dist > want + 6;
      // Can't see them, or the way is blocked: take the route around.
      if (!up && (!visible || along > 0) && !clearLine(grid, me.x, me.y, seen.x, seen.y)) {
        [wx, wy] = this.goto(grid, me, seen.x, seen.y, dt);
        sprint = true;
      }
    } else {
      // Wander gently around the middle.
      if (fromCentre > R * 0.35) [wx, wy] = this.goto(grid, me, 0, 0, dt);
    }

    if (me.grounded && (wx !== 0 || wy !== 0)) {
      if (up) {
        // On a roof: don't walk off unless we mean to (leaving the high ground).
        const [ux, uy] = unit(wx, wy);
        const below = floorAt(map, R, me.x + ux * 0.9, me.y + uy * 0.9, me.z + C.STEP_HEIGHT);
        if (this.mode === 'high' && below < me.z - 0.8) {
          wx = 0;
          wy = 0;
        }
      } else {
        // Never walk into a hole or off the edge; step around walls or climb them.
        const onRamp = this.mode === 'climb' && me.z > 0.05;
        const safe = onRamp ? unit(wx, wy) : this.safeHeading(map, R, me, wx, wy);
        if (safe) {
          [wx, wy] = safe;
          const wall = !onRamp && inBlock(map, R, me.x + wx * 0.9, me.y + wy * 0.9, me.z + 0.5);
          if (wall) {
            const top = floorAt(map, R, me.x + wx * 0.9, me.y + wy * 0.9, me.z + C.MANTLE_MAX);
            if (top - me.z > C.STEP_HEIGHT && top - me.z <= C.MANTLE_MAX) jump = true;
            else [wx, wy] = rotate(wx, wy, this.strafeDir * 1.1);
          }
        } else {
          [wx, wy] = unit(-me.x, -me.y);
        }
      }
    }

    // Stuck (pushing but not moving)? Replan, hop, and try another way.
    const moved = Math.hypot(me.x - this.lastX, me.y - this.lastY);
    this.lastX = me.x;
    this.lastY = me.y;
    if (me.grounded && canMove && (wx !== 0 || wy !== 0) && moved < 0.02) this.stuckFor += dt;
    else this.stuckFor = Math.max(0, this.stuckFor - dt * 2);
    if (this.stuckFor > 0.7) {
      this.stuckFor = 0;
      this.route = [];
      this.strafeDir = -this.strafeDir;
      jump = true;
      [wx, wy] = rotate(wx, wy, this.strafeDir * 1.5);
      if (this.mode !== 'fight' && this.modeFor > 4) this.mode = 'fight';
    }

    // Dodge shots heading our way; hop around when fighting.
    if (me.grounded && canMove) {
      const threat = this.incoming(s, me);
      if (threat && Math.random() < sk.dodge * 0.35 && this.mode !== 'high') {
        const [bx, by] = unit(threat.vx, threat.vy);
        // Side-step across the shot's path, towards the middle if we can.
        const sideX = -by;
        const sideY = bx;
        const toward = sideX * -me.x + sideY * -me.y >= 0 ? 1 : -1;
        wx = sideX * toward;
        wy = sideY * toward;
        if (Math.random() < sk.dodge * 0.5) jump = true;
      }
      this.hopIn -= dt;
      if (seen && this.hopIn <= 0 && this.mode === 'fight') {
        this.hopIn = 1.2 + Math.random() * (4 - sk.agility * 2.5);
        if (!danger && Math.random() < sk.agility * 0.6) jump = true;
        else if (!danger && Math.random() < sk.agility * 0.5 && Math.hypot(me.vx, me.vy) > C.SLIDE_MIN_SPEED) crouch = true;
      }
    }
    // A slide needs a fresh press.
    if (crouch && this.lastCrouch) crouch = false;
    this.lastCrouch = crouch;

    // Wish direction -> forward / strafe relative to where we look.
    const fx = Math.cos(this.yaw);
    const fy = Math.sin(this.yaw);
    let forward = wx * fx + wy * fy;
    let strafe = wx * fy - wy * fx;
    const len = Math.hypot(forward, strafe);
    if (len > 1) {
      forward /= len;
      strafe /= len;
    }
    sprint = sprint && forward > 0.6;

    // ---- Shoot ----------------------------------------------------------
    let firing = false;
    let aim = false;
    const range = ((w.speed[0] + w.speed[1]) / 2) * w.lifetime * 0.9;
    const canShoot = canFire && seen !== null && visible && dist < range;
    // The Boomer's blast would hurt us too up close.
    const tooClose = w.splash > 0 && dist < w.splash * 0.9 && sk.chargeSense > 0.5;
    if (w.mode === 'charge') {
      if (me.charging) {
        this.chargeFor += dt;
        // Release once charged enough and lined up (or if we've held too long).
        const ready = me.charge >= this.wantCharge && aimErr < sk.fireCone;
        firing = !(ready || this.chargeFor > 2.5 || !canFire);
      } else if (canShoot && !tooClose && aimErr < sk.fireCone * 2.5 && me.cooldown <= 0) {
        this.wantCharge = this.chooseCharge(dist, target, R);
        this.chargeFor = 0;
        firing = true;
      }
      aim = me.weapon === 2 && me.charging && dist > 14 && sk.chargeSense > 0.5;
    } else {
      firing = canShoot && !tooClose && aimErr < sk.fireCone;
    }

    // ---- Offhand --------------------------------------------------------
    let offhand = false;
    if (this.offPressed) {
      this.offPressed = false; // release, so the next use is a fresh press
    } else if (canFire && seen && target && me.offCd <= 0 && Math.random() < sk.offhand * 0.25) {
      if (me.offhand === C.OFFHAND_KNIFE) {
        offhand = dist < C.KNIFE_RANGE + 0.2 && aimErr < 0.5;
      } else {
        // Shock grenade: best on someone near the edge, or on a crowd.
        const tFromCentre = Math.hypot(target.x, target.y);
        const crowd = enemies.filter((p) => Math.hypot(p.x - target.x, p.y - target.y) < 5).length;
        const edgy = tFromCentre > R * 0.55;
        offhand = dist > 5 && dist < 17 && visible && aimErr < 0.2 && (edgy || crowd >= 2 || sk.offhand < 0.5);
      }
      this.offPressed = offhand;
    }

    return {
      forward: Math.round(forward * 100) / 100,
      strafe: Math.round(strafe * 100) / 100,
      jump,
      firing,
      sprint,
      crouch,
      aim,
      offhand,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  // -------------------------------------------------------------------------

  /** Direction to walk towards a point: straight if clear, else along an A* route. */
  private goto(grid: NavGrid, me: PlayerState, gx: number, gy: number, dt: number): [number, number] {
    if (clearLine(grid, me.x, me.y, gx, gy)) {
      this.route = [];
      return unit(gx - me.x, gy - me.y);
    }
    this.replanIn -= dt;
    const moved = Math.hypot(gx - this.routeTo[0], gy - this.routeTo[1]);
    if (this.route.length === 0 || this.replanIn <= 0 || moved > 2) {
      this.route = findPath(grid, me.x, me.y, gx, gy) ?? [];
      this.routeTo = [gx, gy];
      this.replanIn = 0.7;
    }
    while (this.route.length > 1 && Math.hypot(this.route[0][0] - me.x, this.route[0][1] - me.y) < 0.9) this.route.shift();
    const next = this.route[0];
    return next ? unit(next[0] - me.x, next[1] - me.y) : unit(gx - me.x, gy - me.y);
  }

  /** Records where everyone is, so perception can lag by the reaction time. */
  private remember(s: GameState): void {
    const keep = Math.max(2, Math.ceil(this.skill.reaction / C.TICK_DT) + 1);
    for (const p of s.players) {
      if (!p.inRound) continue;
      let list = this.memory.get(p.id);
      if (!list) {
        list = [];
        this.memory.set(p.id, list);
      }
      list.push({ x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz });
      if (list.length > keep) list.splice(0, list.length - keep);
    }
  }

  /** Where the bot thinks a player is: how they were `reaction` seconds ago. */
  private perceive(id: PlayerId): Seen | null {
    const list = this.memory.get(id);
    return list && list.length > 0 ? list[0] : null;
  }

  /** Chooses who to fight: close, visible, and (for good bots) easy to knock off. */
  private pickTarget(me: PlayerState, enemies: PlayerState[], map: MapDef, R: number): PlayerState | null {
    let best: PlayerState | null = null;
    let bestScore = Infinity;
    for (const p of enemies) {
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      let score = d;
      if (!this.lineOfSight(map, R, me.x, me.y, me.z + C.EYE_HEIGHT, p.x, p.y, p.z + 1)) score += 12;
      // Smarter bots go after players who are already near the edge or badly hurt.
      score -= this.skill.chargeSense * ((Math.hypot(p.x, p.y) / R) * 8 + p.damage * 0.04);
      if (p.id === this.targetId) score -= 3; // don't flip-flop
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  /** Charge for a shot: full for long range or a finishing blow, a quick tap up close. */
  private chooseCharge(dist: number, target: PlayerState | undefined, R: number): number {
    const sk = this.skill;
    if (Math.random() > sk.chargeSense) return 0.15 + Math.random() * 0.7;
    const nearEdge = target ? Math.hypot(target.x, target.y) > R * 0.6 : false;
    if (dist > 12 || nearEdge || (target?.damage ?? 0) > 60) return 1;
    return dist < 5 ? 0.25 : 0.6;
  }

  /** Turns towards a direction no faster than this bot can. */
  private turnTowards(yaw: number, pitch: number, dt: number): void {
    const max = this.skill.turnRate * dt;
    this.yaw = wrapAngle(this.yaw + clamp(angleDiff(this.yaw, yaw), -max, max));
    this.pitch = clamp(this.pitch + clamp(pitch - this.pitch, -max, max), -C.PITCH_LIMIT, C.PITCH_LIMIT);
  }

  /** True if nothing solid is in the way between two points. */
  private lineOfSight(map: MapDef, R: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const d = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const n = Math.max(1, Math.ceil(d / 0.6));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (inBlock(map, R, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t)) return false;
    }
    return true;
  }

  /** True if a point is off the roof, over a hole, or right at the edge. */
  private edgeDanger(map: MapDef, R: number, x: number, y: number): boolean {
    if (isOffMap(map, R, x, y)) return true;
    const m = 1 + this.skill.caution;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      if (isOffMap(map, R, x + Math.cos(a) * m, y + Math.sin(a) * m)) return true;
    }
    return false;
  }

  /** The wish direction, or the nearest turn of it that doesn't lead into a hole or off the edge. */
  private safeHeading(map: MapDef, R: number, me: PlayerState, wx: number, wy: number): [number, number] | null {
    [wx, wy] = unit(wx, wy);
    for (const turn of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.4, -2.4]) {
      const [x, y] = rotate(wx, wy, turn);
      let ok = true;
      for (const d of [0.8, 1.8, 2.8]) {
        if (isOffMap(map, R, me.x + x * d, me.y + y * d)) {
          ok = false;
          break;
        }
      }
      if (ok) return [x, y];
    }
    return null;
  }

  /** A bullet that will pass through us very soon, if any. */
  private incoming(s: GameState, me: PlayerState): { vx: number; vy: number } | null {
    const cz = me.z + C.PLAYER_HEIGHT / 2;
    for (const b of s.bullets) {
      if (b.owner === me.id) continue;
      const rx = me.x - b.x;
      const ry = me.y - b.y;
      const rz = cz - b.z;
      const v2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
      if (v2 < 1) continue;
      const t = (rx * b.vx + ry * b.vy + rz * b.vz) / v2;
      if (t < 0 || t > 0.45) continue;
      const mx = rx - b.vx * t;
      const my = ry - b.vy * t;
      const mz = rz - b.vz * t;
      if (Math.hypot(mx, my, mz) < C.PLAYER_RADIUS + b.radius + 0.6) return { vx: b.vx, vy: b.vy };
    }
    return null;
  }
}

function unit(x: number, y: number): [number, number] {
  const l = Math.hypot(x, y);
  return l > 1e-6 ? [x / l, y / l] : [0, 0];
}

function rotate(x: number, y: number, a: number): [number, number] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}
