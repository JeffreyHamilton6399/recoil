// Headless simulation test. Run with: npm test
// 1. 1000 ticks of lobby warm-up with 4 random players.
// 2. A scripted 2-player duel until someone wins a round.
// 3. Full 6-player matches with random inputs, back to the lobby, on every map.
// 4. Spawn points are safe on every map for every player count.
// 5. Movement: running, sprinting, sliding, jumping, climbing, jump pads,
//    a bomb-jump, and running off the edge.
// 6. Client prediction replays the same inputs to the same place as the server.
// 7. Offhands: the knife shoves someone in front of you; the shock grenade
//    bounces and its shockwave throws people.
// 8. Bots: full bot matches finish, and hard bots beat easy ones.
// 9. Structures: run up a ramp onto a roof, through a doorway, under a
//    bridge, and bump your head jumping into a slab.

import assert from 'node:assert/strict';
import * as C from './constants.js';
import { MAPS, floorAt, inBlock, isOffMap, mapScale, rampHeight, scaledBumpers, scaledTurrets, scaledRamps, spawnPoint } from './maps.js';
import {
  NO_INPUT,
  addPlayer,
  controlPlayer,
  createGame,
  currentMap,
  enterLobby,
  movePlayer,
  phaseRules,
  playerFromSnap,
  playerSnap,
  removePlayer,
  setMapChoice,
  setCtf,
  setOffhand,
  setTeam,
  setTeams,
  setWeapon,
  startMatch,
  step,
} from './sim.js';
import { BotBrain } from './bot.js';
import { SHOCK_WEAPON, WEAPONS } from './weapons.js';
import type { GameState, InputState, PlayerId, PlayerState } from './types.js';

/** Walks across a map take longer the bigger the maps are (they were laid out at 38 m). */
const SIZE = C.ARENA_START_RADIUS / 38;

/** Small seeded PRNG for test inputs, so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertSane(s: GameState): void {
  const nums: number[] = [s.arenaRadius, s.phaseTime, s.playTime, s.powerupTimer];
  for (const p of s.players) {
    nums.push(p.x, p.y, p.z, p.vx, p.vy, p.vz, p.yaw, p.pitch, p.damage, p.fallTime, p.rapid, p.triple, p.shield, p.mega);
  }
  for (const b of s.bullets) nums.push(b.x, b.y, b.z, b.vx, b.vy, b.vz, b.radius);
  for (const u of s.powerups) nums.push(u.x, u.y, u.age);
  for (const n of nums) assert.ok(Number.isFinite(n), `non-finite value at tick ${s.tick}`);
  assert.ok(s.arenaRadius <= C.ARENA_START_RADIUS + 1e-9 && s.arenaRadius >= C.ARENA_END_RADIUS - 1e-9);
  assert.ok(s.mapIndex >= 0 && s.mapIndex < MAPS.length);
  assert.ok(s.powerups.length <= C.POWERUP_MAX);
  for (const p of s.players) {
    if (p.grounded && !p.falling) {
      const onBlock = currentMap(s).blocks.some((b) => Math.abs(b.h - p.z) < 1e-9);
      const onRoof = (currentMap(s).roofs ?? []).some((r) => Math.abs((r.h ?? 0) - p.z) < 1e-9);
      const onRamp = scaledRamps(currentMap(s), s.arenaRadius).some((r) => Math.abs(rampHeight(r, p.x, p.y) - p.z) < 0.35);
      assert.ok(p.z === 0 || onBlock || onRoof || onRamp, `grounded players stand on the roof, a block or a ramp (z=${p.z})`);
    }
  }
  for (const sc of s.scores) assert.ok(sc <= C.WIN_SCORE);
}

function randomInput(rand: () => number): InputState {
  return {
    forward: Math.floor(rand() * 3) - 1,
    strafe: Math.floor(rand() * 3) - 1,
    jump: rand() < 0.1,
    firing: rand() < 0.5,
    sprint: rand() < 0.5,
    crouch: rand() < 0.15,
    aim: rand() < 0.2,
    offhand: rand() < 0.05,
    knife: rand() < 0.3,
    recoil: rand() < 0.3,
    grapple: rand() < 0.3,
    yaw: (rand() * 2 - 1) * Math.PI,
    pitch: (rand() * 2 - 1) * 1.2,
  };
}

function randomInputs(rand: () => number, s: GameState, prev: Map<PlayerId, InputState>): Map<PlayerId, InputState> {
  const next = new Map(prev);
  for (const p of s.players) if (!next.has(p.id) || rand() < 0.1) next.set(p.id, randomInput(rand));
  return next;
}

// 1. Lobby warm-up.
{
  const rand = mulberry32(1234);
  const s = createGame(42);
  for (const id of [0, 1, 2, 3]) addPlayer(s, id, id % WEAPONS.length);
  let inputs = new Map<PlayerId, InputState>();
  let shots = 0;
  let respawns = 0;
  for (let i = 0; i < 1000; i++) {
    inputs = randomInputs(rand, s, inputs);
    const ev = step(s, inputs);
    shots += ev.filter((e) => e.k === 'fire').length;
    respawns += ev.filter((e) => e.k === 'respawn').length;
    assertSane(s);
    assert.equal(s.phase, 'lobby', 'lobby should last until the host starts');
  }
  assert.equal(s.tick, 1000);
  assert.ok(shots > 0, 'expected some shots to be fired');
  console.log(`ok 1 - 1000 lobby ticks, ${shots} shots, ${respawns} respawns, ${s.powerups.length} power-ups on the roof`);
}

// 2. Scripted duel: player 0 aims at player 1's chest and clicks away with the revolver.
{
  const s = createGame(7);
  addPlayer(s, 0);
  addPlayer(s, 1);
  startMatch(s);
  let hits = 0;
  let chargeTicks = 0;
  for (let i = 0; i < 6000 && s.phase !== 'roundEnd'; i++) {
    const me = s.players[0];
    const them = s.players[1];
    const dx = them.x - me.x;
    const dy = them.y - me.y;
    const dz = them.z + 1.1 - (me.z + C.EYE_HEIGHT);
    const yaw = Math.atan2(dy, dx);
    const pitch = Math.atan2(dz, Math.hypot(dx, dy));
    // A click every other tick: the revolver fires once per fresh press.
    const firing = chargeTicks++ % 2 === 0;
    const inputs = new Map<PlayerId, InputState>([[0, { ...NO_INPUT, yaw, pitch, firing }]]);
    hits += step(s, inputs).filter((e) => e.k === 'hit' || e.k === 'block').length;
    assertSane(s);
  }
  assert.equal(s.phase, 'roundEnd', 'round should have ended');
  assert.ok(hits > 0, 'expected hits');
  console.log(`ok 2 - duel on "${MAPS[s.mapIndex].name}" ended at tick ${s.tick} after ${hits} hits, winner=${String(s.roundWinner)}`);
}

// 3. Full 6-player matches, a player leaving mid-match, and a return to the lobby.
{
  const rand = mulberry32(99);
  const s = createGame(2024);
  for (const id of [0, 1, 2, 3, 4, 5]) addPlayer(s, id, id % WEAPONS.length);
  startMatch(s);
  let inputs = new Map<PlayerId, InputState>();
  const mapsSeen = new Set<number>();
  let matches = 0;
  let pickups = 0;
  for (let i = 0; i < 2000000 && (matches < 2 || mapsSeen.size < MAPS.length); i++) {
    inputs = randomInputs(rand, s, inputs);
    const ev = step(s, inputs);
    pickups += ev.filter((e) => e.k === 'pickup').length;
    mapsSeen.add(s.mapIndex);
    assertSane(s);
    if (i === 500) removePlayer(s, 5);
    if (s.phase === 'matchEnd' && s.phaseTime <= C.TICK_DT + 1e-9) {
      const w = s.matchWinner;
      assert.ok(w !== null && s.scores[w] === C.WIN_SCORE, 'winner should have WIN_SCORE points');
      matches++;
    }
    if (s.phase === 'lobby') {
      assert.ok(matches > 0, 'only a finished match returns to the lobby');
      startMatch(s);
    }
  }
  assert.ok(matches >= 2, 'expected two full matches to complete');
  assert.equal(mapsSeen.size, MAPS.length, 'every map should come up');
  enterLobby(s);
  assert.equal(s.phase, 'lobby');
  console.log(`ok 3 - ${matches} 6-player matches by tick ${s.tick}, ${pickups} power-ups collected, all ${MAPS.length} maps played`);
}

// 4. Every map has safe spawn points for 1 to 8 players.
{
  for (const map of MAPS) {
    for (let n = 1; n <= C.MAX_PLAYERS; n++) {
      for (let i = 0; i < n; i++) {
        const sp = spawnPoint(map, i, n);
        assert.ok(!isOffMap(map, C.ARENA_START_RADIUS, sp.x, sp.y), `${map.name}: spawn ${i}/${n} is off the roof`);
        assert.ok(!inBlock(map, C.ARENA_START_RADIUS, sp.x, sp.y, 0, C.PLAYER_RADIUS), `${map.name}: spawn ${i}/${n} is inside a block`);
        for (const b of scaledBumpers(map, C.ARENA_START_RADIUS)) {
          assert.ok(Math.hypot(sp.x - b.x, sp.y - b.y) >= b.r + C.PLAYER_RADIUS, `${map.name}: spawn ${i}/${n} is inside a bumper`);
        }
      }
    }
  }
  console.log(`ok 4 - safe spawns on all ${MAPS.length} maps for 1-${C.MAX_PLAYERS} players`);
}

// 5. Movement.
{
  const s = createGame(5);
  addPlayer(s, 0);
  const p = s.players[0];
  const hold = (input: Partial<InputState>, ticks: number): number => {
    let top = p.z;
    for (let i = 0; i < ticks; i++) {
      step(s, new Map([[0, { ...NO_INPUT, yaw: p.yaw, pitch: p.pitch, ...input }]]));
      top = Math.max(top, p.z);
    }
    return top;
  };
  const place = (x: number, y: number): void => {
    Object.assign(p, { x, y, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, slide: 0, slideCd: 0 });
  };
  const speed = (): number => Math.hypot(p.vx, p.vy);

  // Helipad: run, sprint, stop.
  place(-4, 0);
  hold({ yaw: 0, forward: 1 }, 15);
  assert.ok(Math.abs(speed() - C.MOVE_SPEED) < 1e-6, 'reaches running speed');
  assert.ok(p.vx > 0 && Math.abs(p.vy) < 1e-6, 'runs where it looks');
  hold({ yaw: 0, forward: 1, sprint: true }, 15);
  assert.ok(Math.abs(speed() - C.MOVE_SPEED * C.SPRINT_MULT) < 1e-6, 'sprints faster');
  hold({ yaw: 0 }, 10);
  assert.ok(speed() < 1e-6, 'stops when the keys are released');

  // Slide: a burst of speed that lasts.
  place(-8, 0);
  hold({ yaw: 0, forward: 1, sprint: true }, 15);
  hold({ yaw: 0, forward: 1, sprint: true, crouch: true }, 1);
  assert.ok(p.slide > 0 && speed() >= C.SLIDE_SPEED * 0.9, 'crouching while sprinting slides');
  hold({ yaw: 0, forward: 1 }, 10);
  assert.ok(speed() > C.MOVE_SPEED * C.SPRINT_MULT, 'a slide is faster than sprinting');

  // Jump.
  place(-4, 0);
  hold({ jump: true }, 1);
  const jumpTop = hold({}, 40);
  assert.ok(p.grounded && p.z === 0, 'lands after a jump');
  assert.ok(jumpTop > 1, `jumps over a metre (got ${jumpTop.toFixed(2)})`);

  // Jump pad (Helipad has one at 90 degrees).
  const S = mapScale(s.arenaRadius);
  place(0, 2.3 * S);
  const padTop = hold({}, 50);
  assert.ok(padTop > 5, `a jump pad launches you high (got ${padTop.toFixed(2)})`);

  // Bomb-jump with the Boomer: shoot your feet.
  setWeapon(s, 0, 3);
  place(-4, -4);
  hold({ pitch: -C.PITCH_LIMIT, firing: true }, 1);
  const bombTop = hold({ pitch: -C.PITCH_LIMIT }, 40);
  assert.ok(bombTop > jumpTop, `a bomb-jump beats a jump (${bombTop.toFixed(2)} vs ${jumpTop.toFixed(2)})`);
  setWeapon(s, 0, 0);

  // Climb onto The Block's corner AC unit (1.6m: too tall to jump, low enough to climb).
  setMapChoice(s, 3);
  const T = mapScale(s.arenaRadius);
  const ac = MAPS[3].blocks.find((b) => b.h === 1.6 && !b.z);
  assert.ok(ac, "The Block has its corner AC units");
  place((ac.x - ac.w / 2) * T - 1.2, ac.y * T);
  hold({ yaw: 0, forward: 1 }, 8);
  hold({ yaw: 0, forward: 1, jump: true }, 1);
  hold({ yaw: 0, forward: 1 }, 10);
  hold({ yaw: 0 }, 20);
  assert.ok(p.grounded && Math.abs(p.z - ac.h) < 1e-6, `climbs onto the AC unit (z=${p.z.toFixed(2)})`);

  // Run off the edge.
  setMapChoice(s, 0);
  place(0, 0);
  const ev: string[] = [];
  for (let i = 0; i < 400 && !p.falling; i++) {
    for (const e of step(s, new Map([[0, { ...NO_INPUT, yaw: 0.3, forward: 1 }]]))) ev.push(e.k);
  }
  assert.ok(p.falling && ev.includes('fall'), 'running off the edge is a fall');
  console.log(`ok 5 - run, sprint, slide, jump (${jumpTop.toFixed(2)}m), pad (${padTop.toFixed(2)}m), bomb-jump (${bombTop.toFixed(2)}m), climb, fall`);
}

// 6. Prediction: replaying inputs on a snapshot copy matches the server (one player, no shots).
{
  const rand = mulberry32(77);
  const s = createGame(11);
  addPlayer(s, 0);
  const server = s.players[0];
  setMapChoice(s, 3); // The Block: blocks to climb and walk into
  const local = playerFromSnap(playerSnap(server));
  const map = currentMap(s);
  let maxErr = 0;
  for (let i = 0; i < 300 && !server.falling; i++) {
    const input = { ...randomInput(rand), firing: false };
    step(s, new Map([[0, input]]));
    controlPlayer(local, input, C.TICK_DT, phaseRules(s.phase), undefined, map, s.arenaRadius);
    for (let n = 0; n < C.PHYSICS_SUBSTEPS; n++) movePlayer(local, C.TICK_DT / C.PHYSICS_SUBSTEPS, map, s.arenaRadius);
    maxErr = Math.max(maxErr, Math.hypot(local.x - server.x, local.y - server.y, local.z - server.z));
  }
  assert.ok(maxErr < 1e-9, `prediction drifted by ${maxErr}`);
  console.log('ok 6 - prediction replays match the server');
}

// 7. Offhands.
{
  const s = createGame(5);
  addPlayer(s, 0);
  addPlayer(s, 1);
  const [a, b] = s.players;
  // Face each other at 1.4 m.
  a.x = 0; a.y = 0; b.x = 1.4; b.y = 0;
  a.yaw = 0;
  const noop = (p: typeof a): InputState => ({ ...NO_INPUT, yaw: p.yaw, pitch: 0 });
  // Pull the knife out: no swing yet, just the draw.
  let ev = step(s, new Map([[0, { ...noop(a), knife: true }], [1, noop(b)]]));
  assert.ok(ev.some((e) => e.k === 'draw' && e.knife) && a.knifeOut, 'knife comes out');
  assert.ok(!ev.some((e) => e.k === 'melee'), 'drawing the knife does not swing');
  ev = step(s, new Map([[0, { ...noop(a), knife: true, firing: true }], [1, noop(b)]]));
  assert.ok(ev.some((e) => e.k === 'melee' && e.hit), 'knife connects at point-blank');
  assert.ok(b.vx > 5 && b.damage > 0, `knife shoves (vx=${b.vx.toFixed(1)})`);
  assert.ok(s.bullets.length === 0, 'slashing does not shoot');
  // Keep slashing: a new swing as soon as each one finishes, with no limit.
  let swings = 1;
  for (let i = 0; i < Math.round(C.TICK_RATE * 2); i++) {
    b.x = a.x + 1.2;
    b.y = a.y;
    swings += step(s, new Map([[0, { ...noop(a), knife: true, firing: true }], [1, noop(b)]])).filter((e) => e.k === 'melee').length;
  }
  assert.ok(swings >= Math.floor(2 / C.KNIFE_SWING), `slashes keep coming (${swings} in 2 s)`);
  ev = step(s, new Map([[0, { ...noop(a) }], [1, noop(b)]]));
  assert.ok(ev.some((e) => e.k === 'draw' && !e.knife) && !a.knifeOut, 'gun back out');

  // Recoil mode: the same shot throws you far harder than it does normally.
  const r = createGame(8);
  addPlayer(r, 0);
  const rp = r.players[0];
  const kickWith = (recoil: boolean): number => {
    Object.assign(rp, { x: -3, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, fireHeld: false, cooldown: 0 });
    step(r, new Map([[0, { ...NO_INPUT, yaw: 0, pitch: 0, firing: true, recoil }]]));
    return -rp.vx;
  };
  const normal = kickWith(false);
  const boosted = kickWith(true);
  assert.ok(boosted > normal * 4 && boosted > 8, `recoil mode kicks hard (${boosted.toFixed(1)} vs ${normal.toFixed(1)} m/s)`);

  // Shock grenade thrown at someone 9 m away: it bursts and throws them.
  const g = createGame(6);
  addPlayer(g, 0);
  addPlayer(g, 1);
  setOffhand(g, 0, C.OFFHAND_SHOCK);
  const [ga, gb] = g.players;
  ga.x = -4; ga.y = 0; ga.yaw = 0; ga.pitch = -0.1;
  gb.x = 5; gb.y = 0;
  let thrown = false;
  let boom = false;
  let shoved = 0;
  for (let i = 0; i < 90 && !boom; i++) {
    const evs = step(g, new Map([[0, { ...noop(ga), pitch: -0.1, offhand: i === 0 }], [1, noop(gb)]]));
    thrown ||= evs.some((e) => e.k === 'throw');
    boom ||= evs.some((e) => e.k === 'boom' && e.w === SHOCK_WEAPON);
    shoved = Math.max(shoved, Math.hypot(gb.vx, gb.vy, gb.vz));
  }
  assert.ok(thrown && boom, 'grenade thrown and burst');
  assert.ok(shoved > 3, `shockwave throws the target (speed ${shoved.toFixed(1)})`);
  console.log(`ok 7 - knife: ${swings} slashes in 2 s; recoil mode ${boosted.toFixed(1)} m/s vs ${normal.toFixed(1)}; shockwave throw ${shoved.toFixed(1)} m/s`);
}

// 8. Bots.
{
  // Duels: hard vs easy on several maps. Hard should win most rounds.
  let hardWins = 0;
  let easyWins = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const s = createGame(seed * 97);
    addPlayer(s, 0, seed % 5);
    addPlayer(s, 1, (seed + 2) % 5);
    setOffhand(s, 0, seed % 2);
    setOffhand(s, 1, (seed + 1) % 2);
    startMatch(s);
    const bots = [new BotBrain(3), new BotBrain(1)];
    for (let i = 0; i < 30 * 60 * 6 && s.phase !== 'matchEnd'; i++) {
      const inputs = new Map<PlayerId, InputState>();
      for (const p of s.players) inputs.set(p.id, bots[p.id].think(s, p));
      step(s, inputs);
      assertSane(s);
    }
    hardWins += s.scores[0];
    easyWins += s.scores[1];
  }
  assert.ok(hardWins > easyWins * 2, `hard bots should beat easy bots (hard ${hardWins} rounds, easy ${easyWins})`);

  // A full 6-bot free-for-all finishes.
  const s = createGame(4242);
  for (let id = 0; id < 6; id++) addPlayer(s, id, id % 5);
  startMatch(s);
  const brains = [0, 1, 2, 3, 4, 5].map((i) => new BotBrain(((i % 3) + 1) as 1 | 2 | 3));
  let ticks = 0;
  for (; ticks < 30 * 60 * 15 && s.phase !== 'matchEnd'; ticks++) {
    const inputs = new Map<PlayerId, InputState>();
    for (const p of s.players) inputs.set(p.id, brains[p.id].think(s, p));
    step(s, inputs);
    assertSane(s);
  }
  assert.equal(s.phase, 'matchEnd', 'a 6-bot match finishes');
  console.log(`ok 8 - hard beat easy ${hardWins}-${easyWins} in rounds; 6-bot match done in ${(ticks / 30 / 60).toFixed(1)} min`);
}

// 9. Structures.
{
  const mapNamed = (name: string): number => MAPS.findIndex((m) => m.name === name);
  const walk = (mapName: string, x: number, y: number, yaw: number, ticks: number, extra: Partial<InputState> = {}): PlayerState => {
    const s = createGame(9);
    setMapChoice(s, mapNamed(mapName));
    addPlayer(s, 0);
    const p = s.players[0];
    p.x = x;
    p.y = y;
    p.z = 0;
    p.yaw = yaw;
    for (let i = 0; i < Math.ceil(ticks * SIZE); i++) step(s, new Map([[0, { ...NO_INPUT, forward: 1, yaw, pitch: 0, ...extra }]]));
    return p;
  };
  const S = mapScale(C.ARENA_START_RADIUS);

  // Helipad: walk from the middle up the ramp onto the east hut's roof.
  const up = walk('Helipad', 3.6 * S, 0, 0, 45);
  assert.ok(up.z > 2.8 && up.grounded, `ramp leads onto the hut roof (z=${up.z.toFixed(2)})`);

  // Helipad: run north through the hut's doorways (under the roof).
  const through = walk('Helipad', 6.3 * S, -2.2 * S, Math.PI / 2, 80);
  assert.ok(through.y > 1.4 * S && through.z < 0.01, `ran through the hut (y=${(through.y / S).toFixed(2)}, z=${through.z.toFixed(2)})`);

  // The Block: the building's east side has no door, so you can't walk in.
  const blocked = walk('The Block', 3.2 * S, 1.0 * S, Math.PI, 40);
  assert.ok(blocked.x > 1.3 * S, `a wall without a door stops you (x=${(blocked.x / S).toFixed(2)})`);

  // Split Level: walk under the bridge from one side to the other.
  const under = walk('Split Level', 2.4 * S, -0.9 * S, Math.PI / 2, 25);
  assert.ok(under.y > 0.5 * S && under.z < 0.01, `walked under the bridge (y=${(under.y / S).toFixed(2)})`);

  // Jumping into the bridge from below bumps your head.
  const s = createGame(10);
  setMapChoice(s, mapNamed('Split Level'));
  addPlayer(s, 0);
  const p = s.players[0];
  p.x = 2.4 * S;
  p.y = 0;
  p.z = 0;
  let peak = 0;
  for (let i = 0; i < 30; i++) {
    step(s, new Map([[0, { ...NO_INPUT, jump: i === 0, yaw: 0, pitch: 0 }]]));
    peak = Math.max(peak, p.z);
  }
  assert.ok(peak + C.PLAYER_HEIGHT <= 2.6 + 1e-6, `head bumps the bridge (peak feet ${peak.toFixed(2)})`);
  console.log(`ok 9 - ramp to roof (${up.z.toFixed(2)} m), through a doorway, blocked by a wall, under a bridge, head bump`);
}

// 10. Bots take the high ground: a sniper climbs onto a roof, and a close-range
// bot chases someone camping up there.
{
  const helipad = MAPS.findIndex((m) => m.name === 'Helipad');
  const S = mapScale(C.ARENA_START_RADIUS);
  const trial = (weapon: number, enemyX: number, enemyY: number, enemyZ: number, seed: number): number => {
    const s = createGame(seed);
    setMapChoice(s, helipad);
    addPlayer(s, 0, weapon);
    addPlayer(s, 1, 0);
    const me = s.players[0];
    const them = s.players[1];
    me.x = 0;
    me.y = -2 * S;
    them.x = enemyX;
    them.y = enemyY;
    them.z = enemyZ;
    const bot = new BotBrain(3);
    let top = 0;
    for (let i = 0; i < 30 * 25; i++) {
      step(s, new Map([[0, bot.think(s, me)], [1, { ...NO_INPUT, yaw: them.yaw }]]));
      if (me.grounded) top = Math.max(top, me.z);
    }
    return top;
  };
  let sniperUp = 0;
  let chaserUp = 0;
  for (let k = 0; k < 4; k++) {
    // A long gun with the enemy far off across the roof.
    if (trial(2, -0.5 * S, 7.5 * S, 0, 50 + k) > 2.5) sniperUp++;
    // A shotgun against someone on the west hut's roof.
    if (trial(1, -6.3 * S, 0, 2.95, 80 + k) > 2.5) chaserUp++;
  }
  assert.ok(sniperUp >= 2, `hard sniper bots climb onto a roof (${sniperUp}/4)`);
  assert.ok(chaserUp >= 2, `hard bots chase players onto roofs (${chaserUp}/4)`);
  console.log(`ok 10 - bots take the high ground (sniper ${sniperUp}/4, chaser ${chaserUp}/4)`);
}

// 11. Guns without charging: semi-automatics fire once per click, the sniper
//     hits hardest, and the no-jump rule leaves recoil as the way up.
{
  const g = createGame(12);
  addPlayer(g, 0);
  const p = g.players[0];
  p.x = -4;
  p.y = 0;
  // Holding the trigger on the revolver fires once; clicking again fires again.
  let shots = 0;
  for (let i = 0; i < 30; i++) shots += step(g, new Map([[0, { ...NO_INPUT, yaw: 0, firing: true }]])).filter((e) => e.k === 'fire').length;
  assert.equal(shots, 1, 'holding a semi-automatic fires once');
  step(g, new Map([[0, { ...NO_INPUT, yaw: 0 }]]));
  shots += step(g, new Map([[0, { ...NO_INPUT, yaw: 0, firing: true }]])).filter((e) => e.k === 'fire').length;
  assert.equal(shots, 2, 'a fresh click fires again');
  // Holding the Pepper keeps firing.
  setWeapon(g, 0, 4);
  let auto = 0;
  for (let i = 0; i < 30; i++) auto += step(g, new Map([[0, { ...NO_INPUT, yaw: 0, firing: true }]])).filter((e) => e.k === 'fire').length;
  assert.ok(auto >= 8, `an automatic keeps firing while held (${auto} shots in 1 s)`);
  // The sniper outhits the revolver.
  assert.ok(WEAPONS[2].knockback > WEAPONS[0].knockback * 1.8 && WEAPONS[2].damage > WEAPONS[0].damage * 2, 'the sniper hits much harder');

  // No-jump rule: the jump button does nothing, but recoil still gets you airborne.
  const n = createGame(13);
  n.noJump = true;
  addPlayer(n, 0);
  const q = n.players[0];
  Object.assign(q, { x: -4, y: 0 });
  let top = 0;
  for (let i = 0; i < 20; i++) {
    step(n, new Map([[0, { ...NO_INPUT, jump: true }]]));
    top = Math.max(top, q.z);
  }
  assert.equal(top, 0, 'no jumping under the no-jump rule');
  step(n, new Map([[0, { ...NO_INPUT, pitch: -C.PITCH_LIMIT, firing: true, recoil: true }]]));
  for (let i = 0; i < 20; i++) {
    step(n, new Map([[0, { ...NO_INPUT, pitch: -C.PITCH_LIMIT, recoil: true }]]));
    top = Math.max(top, q.z);
  }
  assert.ok(top > 1, `recoil still lifts you (${top.toFixed(2)} m)`);
  console.log(`ok 11 - semi-auto once per click, auto ${auto}/s held, sniper hits hardest, no-jump rule (recoil lift ${top.toFixed(2)} m)`);
}

// 12. Power-ups: each one is picked up and does what it says; and they spawn during play.
{
  const kinds = ['rapid', 'triple', 'mega', 'shield', 'heal'] as const;
  const results: string[] = [];
  for (const kind of kinds) {
    const g = createGame(40);
    addPlayer(g, 0);
    addPlayer(g, 1);
    const [a, b] = g.players;
    Object.assign(a, { x: -4, y: 0, damage: 50 });
    Object.assign(b, { x: 4, y: 0 });
    g.powerups.push({ id: 999, kind, x: a.x, y: a.y, age: 0 });
    const ev = step(g, new Map([[0, { ...NO_INPUT, yaw: 0 }]]));
    assert.ok(ev.some((e) => e.k === 'pickup' && e.u === kind), `${kind} is picked up`);
    assert.ok(!g.powerups.some((u) => u.id === 999), `${kind} leaves the roof`);
    const fire = (): number => {
      a.fireHeld = false;
      a.cooldown = 0;
      const before = g.bullets.length;
      step(g, new Map([[0, { ...NO_INPUT, yaw: 0, firing: true }]]));
      return g.bullets.length - before;
    };
    switch (kind) {
      case 'rapid': {
        fire();
        assert.ok(Math.abs(a.cooldown - WEAPONS[0].cooldown * 0.5) < C.TICK_DT + 1e-9, 'rapid fire halves the time between shots');
        break;
      }
      case 'triple':
        assert.equal(fire(), 3, 'triple shot fires three');
        break;
      case 'mega': {
        fire();
        const round = g.bullets[g.bullets.length - 1];
        assert.ok(round.knockback > WEAPONS[0].knockback * 1.5 && round.radius > WEAPONS[0].radius, 'mega shot is bigger and hits harder');
        assert.equal(a.mega, C.MEGA_SHOTS - 1, 'mega shot uses one charge');
        break;
      }
      case 'shield': {
        assert.ok(a.shield > 0, 'shield is up');
        // B shoots A: the shield takes it.
        b.yaw = Math.PI;
        let blocked = false;
        for (let i = 0; i < 20 && !blocked; i++) {
          b.fireHeld = false;
          b.cooldown = 0;
          blocked = step(g, new Map([[1, { ...NO_INPUT, yaw: Math.PI, pitch: -0.02, firing: i === 0 }]])).some((e) => e.k === 'block' && e.p === 0);
        }
        assert.ok(blocked && a.shield === 0, 'the shield blocks a hit and breaks');
        break;
      }
      case 'heal':
        assert.equal(a.damage, 0, 'heal clears your damage');
        break;
    }
    results.push(kind);
  }
  // They spawn by themselves during a round.
  const g = createGame(41);
  addPlayer(g, 0);
  addPlayer(g, 1);
  startMatch(g);
  let spawned = 0;
  for (let i = 0; i < C.TICK_RATE * 25; i++) spawned += step(g, new Map()).filter((e) => e.k === 'spawn').length;
  assert.ok(spawned >= 2, `power-ups spawn during play (${spawned} in 25 s)`);
  console.log(`ok 12 - power-ups work: ${results.join(', ')}; ${spawned} spawned in 25 s`);
}

// 13. Loadout changes mid-match wait for your next spawn (no skipping a cooldown by swapping).
{
  const g = createGame(50);
  addPlayer(g, 0);
  addPlayer(g, 1);
  startMatch(g);
  const p = g.players[0];
  setWeapon(g, 0, 2);
  setOffhand(g, 0, C.OFFHAND_SHOCK);
  assert.ok(p.weapon === 0 && p.offhand === C.OFFHAND_KNIFE, 'mid-match picks do not change what you hold');
  p.offCd = 5;
  // Next round: the new loadout, fresh.
  g.phase = 'roundEnd';
  g.phaseTime = C.ROUND_END_TIME;
  step(g, new Map());
  assert.deepEqual([p.weapon, p.offhand, p.offCd], [2, C.OFFHAND_SHOCK, 0], 'the new loadout arrives on the next spawn');
  console.log('ok 13 - loadout picks mid-match apply on the next spawn');
}

// 14. Towers: walk up the stairs to the second floor, up again to the roof deck,
//     and across the sky bridge to the other tower (Downtown).
{
  const idx = MAPS.findIndex((m) => m.name === 'Downtown');
  assert.ok(idx >= 0, 'Downtown exists');
  const g = createGame(60);
  addPlayer(g, 0);
  setMapChoice(g, idx);
  g.turrets = []; // nobody shooting during the walk
  const p = g.players[0];
  const S = mapScale(g.arenaRadius);
  const walk = (dx: number, dy: number, yaw: number, ticks: number, onFloor: number): number => {
    Object.assign(p, { x: dx * S, y: dy * S, vx: 0, vy: 0, vz: 0, grounded: true, falling: false });
    p.z = floorAt(MAPS[idx], g.arenaRadius, p.x, p.y, onFloor + 0.05);
    let top = p.z;
    for (let i = 0; i < Math.ceil(ticks * SIZE); i++) {
      step(g, new Map([[0, { ...NO_INPUT, yaw, forward: 1 }]]));
      top = Math.max(top, p.z);
    }
    return top;
  };
  // Ground floor: the foot of the stairs along the south wall, walking east.
  const floor2 = walk(-5.6, -0.86, 0, 40, 0);
  assert.ok(Math.abs(floor2 - 2.95) < 0.05 && p.grounded, `stairs reach the second floor (z=${p.z.toFixed(2)})`);
  // Second floor: the foot of the next flight along the north wall, walking west.
  const deck = walk(-3.6, 0.86, Math.PI, 40, 2.95);
  assert.ok(deck > 5.8, `stairs reach the roof deck (z=${p.z.toFixed(2)})`);
  // Across the sky bridge from one tower's upper floor into the other's.
  walk(-4.2, 0, 0, 160, 2.95);
  assert.ok(p.x / S > 3.6 && Math.abs(p.z - 2.95) < 0.05, `crossed the sky bridge (x=${(p.x / S).toFixed(2)}, z=${p.z.toFixed(2)})`);
  console.log(`ok 14 - tower stairs to ${floor2.toFixed(2)} m and ${deck.toFixed(2)} m, and across the sky bridge`);
}

// 15. Team mode: even teams, shots pass through teammates, and the round
//     goes to the last team standing.
{
  const g = createGame(77);
  for (let id = 0; id < 4; id++) addPlayer(g, id, 0);
  setTeams(g, true);
  const team = (id: number): number => g.players.find((p) => p.id === id)!.team;
  assert.deepEqual([0, 1, 2, 3].map(team), [0, 1, 0, 1], 'teams split evenly');
  setTeam(g, 3, 0);
  assert.equal(team(3), 0, 'a player can switch team in the lobby');
  setTeam(g, 3, 1);

  // Friendly fire is off: Red shoots Red point blank and nothing happens.
  const [a, b, c, d] = [0, 1, 2, 3].map((id) => g.players.find((p) => p.id === id)!);
  [a, b, c, d].forEach((p, i) => Object.assign(p, { x: -6 + i, y: -6, vx: 0, vy: 0, vz: 0, z: 0, damage: 0, falling: false, fallTime: 0 }));
  Object.assign(a, { x: 0, y: 0, yaw: 0 });
  Object.assign(c, { x: 2, y: 0 });
  for (let i = 0; i < 20; i++) step(g, new Map([[0, { ...NO_INPUT, yaw: 0, firing: i % 4 === 0 }]]));
  assert.equal(c.damage, 0, 'teammates cannot hurt each other');
  // ...but an enemy in the same spot gets hit.
  Object.assign(c, { x: -6, y: 6 });
  Object.assign(b, { x: 2, y: 0, vx: 0, vy: 0, vz: 0, z: 0, damage: 0 });
  a.cooldown = 0;
  for (let i = 0; i < 20; i++) step(g, new Map([[0, { ...NO_INPUT, yaw: 0, firing: i % 4 === 0 }]]));
  assert.ok(b.damage > 0, 'enemies still get hit');

  // Last team standing wins the round.
  startMatch(g);
  while (g.phase !== 'playing') step(g, new Map());
  b.falling = true;
  d.falling = true;
  step(g, new Map());
  assert.equal(g.phase, 'roundEnd');
  assert.equal(g.roundTeam, 0, 'Red wins the round');
  assert.deepEqual(g.teamScores, [1, 0]);
  // A team emptied by someone leaving gets evened out at the next round.
  removePlayer(g, 1);
  removePlayer(g, 3);
  while (g.phase === 'roundEnd') step(g, new Map());
  assert.deepEqual(g.players.map((p) => p.team).sort(), [0, 1], 'teams rebalanced');
  console.log('ok 15 - team mode');
}

// 16. Capture the flag: grab their flag, bring it home to score, lose it
//     if you're knocked off, respawn after a fall, and win at CTF_CAPTURES.
{
  const g = createGame(91);
  for (let id = 0; id < 4; id++) addPlayer(g, id, 0);
  setMapChoice(g, MAPS.findIndex((m) => m.name === 'Twin Bases'));
  setCtf(g, true);
  assert.ok(g.teams && g.flags.length === 2, 'capture the flag turns teams on and puts out two flags');
  startMatch(g);
  while (g.phase !== 'playing') step(g, new Map());
  const red = g.players.find((p) => p.team === 0)!;
  const [redFlag, blueFlag] = g.flags;
  assert.ok(redFlag.x < 0 && blueFlag.x > 0, 'Red defends the -x side, Blue the +x side');
  const moveTo = (p: PlayerState, x: number, y: number): void => {
    Object.assign(p, { x, y, z: 0, vx: 0, vy: 0, vz: 0, grounded: true });
    step(g, new Map());
  };
  const capture = (): void => {
    moveTo(red, blueFlag.x, blueFlag.y);
    assert.equal(blueFlag.carrier, red.id, 'touching their flag picks it up');
    moveTo(red, redFlag.x, redFlag.y);
  };
  capture();
  assert.deepEqual(g.teamScores, [1, 0], 'bringing it home scores');
  assert.equal(blueFlag.carrier, -1, 'and the flag goes back');
  // Knocked off with the flag: it goes home, and you're back after a moment.
  moveTo(red, blueFlag.x, blueFlag.y);
  Object.assign(red, { z: -3, grounded: false });
  step(g, new Map());
  assert.ok(red.falling && blueFlag.carrier === -1, 'the flag goes home when its carrier falls');
  for (let i = 0; i < Math.ceil((C.FALL_DURATION + C.CTF_RESPAWN_DELAY) / C.TICK_DT) + 2; i++) step(g, new Map());
  assert.ok(!red.falling && red.inRound, 'fallen players respawn in capture the flag');
  assert.ok(red.x < 0, 'on their own side');
  capture();
  capture();
  assert.equal(g.phase, 'matchEnd');
  assert.equal(g.matchTeam, 0, 'Red wins at three captures');
  console.log('ok 16 - capture the flag');
}

// 17. Blocks of buildings: the gaps between rooftops are a drop, the bridges
//     aren't, and you can run and jump across a gap.
{
  const map = MAPS.find((m) => m.name === 'City Blocks')!;
  const R = C.ARENA_START_RADIUS;
  const S = mapScale(R);
  assert.ok(isOffMap(map, R, 2.6 * S, 0), 'the gap between buildings is a drop');
  assert.ok(!isOffMap(map, R, 2.6 * S, 1.2 * S), 'the bridge is solid');
  const g = createGame(5);
  addPlayer(g, 0);
  setMapChoice(g, MAPS.indexOf(map));
  const p = g.players[0];
  Object.assign(p, { x: -1.5 * S, y: -1.7 * S, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, yaw: 0 });
  // Sprint east and jump at the edge of the middle roof.
  for (let i = 0; i < 90 && p.x < 4 * S; i++) {
    const nearEdge = p.x > 2.15 * S - 1.2 && p.x < 2.15 * S;
    step(g, new Map([[0, { ...NO_INPUT, yaw: 0, forward: 1, sprint: true, jump: nearEdge }]]));
  }
  assert.ok(p.x > 3.05 * S && !p.falling && p.z > -0.1, `jumped the gap (x=${(p.x / S).toFixed(2)}, z=${p.z.toFixed(2)})`);
  console.log('ok 17 - gaps between buildings, bridges, and a running jump across');
}

// 18. Movement extras: the grappling hook reels you up onto a tower, a
//     double jump goes higher than a single one, and Speed makes you faster.
{
  const g = createGame(8);
  addPlayer(g, 0);
  setMapChoice(g, MAPS.findIndex((m) => m.name === 'Downtown'));
  g.turrets = []; // nobody shooting during the climb
  const p = g.players[0];
  const S = mapScale(g.arenaRadius);
  // Stand west of the west tower and hook its roof deck.
  const tx = -4.6 * S;
  Object.assign(p, { x: tx - 22, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true });
  const pitch = Math.atan2(5.9 - C.EYE_HEIGHT, 22 - 4.6);
  let hooked = false;
  let top = 0;
  for (let i = 0; i < 90; i++) {
    const ev = step(g, new Map([[0, { ...NO_INPUT, yaw: 0, pitch, grapple: i < 60, forward: i >= 30 ? 1 : 0 }]]));
    if (ev.some((e) => e.k === 'hook')) hooked = true;
    top = Math.max(top, p.z);
  }
  assert.ok(hooked, 'the hook bites into the tower');
  assert.ok(top > 4, `the rope pulls you up the tower (${top.toFixed(2)} m)`);

  // Single jump vs double jump, from flat roof.
  const peak = (double: boolean): number => {
    Object.assign(p, { x: 0, y: -6 * S, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, airJumped: false, jumpHeld: false, grappleT: -1 });
    let best = 0;
    for (let i = 0; i < 50; i++) {
      const jump = i === 0 || (double && i === 12);
      step(g, new Map([[0, { ...NO_INPUT, yaw: 0, jump }]]));
      best = Math.max(best, p.z);
    }
    return best;
  };
  const single = peak(false);
  const twice = peak(true);
  assert.ok(twice > single + 0.8, `double jump goes higher (${twice.toFixed(2)} vs ${single.toFixed(2)} m)`);

  // Speed power-up: run for a second with and without it.
  const run = (fast: boolean): number => {
    Object.assign(p, { x: -3 * S, y: -6 * S, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, speed: fast ? C.SPEED_TIME : 0 });
    for (let i = 0; i < 30; i++) step(g, new Map([[0, { ...NO_INPUT, yaw: 0, forward: 1 }]]));
    return p.x + 3 * S;
  };
  const slow = run(false);
  const fast = run(true);
  assert.ok(fast > slow * 1.25, `Speed makes you faster (${fast.toFixed(1)} vs ${slow.toFixed(1)} m)`);
  console.log(`ok 18 - grapple up to ${top.toFixed(1)} m, double jump ${twice.toFixed(2)} m vs ${single.toFixed(2)} m, speed ${fast.toFixed(1)} vs ${slow.toFixed(1)} m`);
}

// 19. Turrets shoot whoever they can see and can be shot out; sudden-death
//     bombs start falling when a round runs long; the Railgun goes through
//     a whole line of people; taller rooftops are solid to stand on.
{
  const idx = MAPS.findIndex((m) => m.name === 'Stack City');
  const g = createGame(19);
  for (let id = 0; id < 3; id++) addPlayer(g, id, 6);
  setMapChoice(g, idx);
  const S = mapScale(g.arenaRadius);
  const [a, b, c] = g.players;
  // Standing on the tall building in the middle.
  Object.assign(a, { x: -0.5 * S, y: -0.5 * S, z: 6, vx: 0, vy: 0, vz: 0, grounded: true });
  step(g, new Map());
  assert.ok(Math.abs(a.z - 6) < 0.01 && a.grounded, `the tall rooftop holds you up (z=${a.z.toFixed(2)})`);

  // A turret up there picks someone out and fires.
  Object.assign(b, { x: 0.5 * S, y: -5.2 * S, z: 1.2, vx: 0, vy: 0, vz: 0, grounded: true });
  Object.assign(c, { x: -5.2 * S, y: -5.2 * S, z: 0, vx: 0, vy: 0, vz: 0, grounded: true });
  let tfired = 0;
  for (let i = 0; i < 150; i++) tfired += step(g, new Map()).filter((e) => e.k === 'tfire').length;
  assert.ok(tfired > 0, 'turrets fire at players they can see');

  // Shoot a turret until it's knocked out.
  const spot = scaledTurrets(MAPS[idx], g.arenaRadius)[0];
  Object.assign(a, { x: spot.x - 4, y: spot.y, z: 6, vx: 0, vy: 0, vz: 0, grounded: true, weapon: 0, cooldown: 0 });
  let down = false;
  for (let i = 0; i < 400 && !down; i++) {
    const pitch = Math.atan2(spot.z - 0.3 - (a.z + C.EYE_HEIGHT), Math.hypot(spot.x - a.x, spot.y - a.y));
    const yaw = Math.atan2(spot.y - a.y, spot.x - a.x);
    const ev = step(g, new Map([[a.id, { ...NO_INPUT, yaw, pitch, firing: i % 12 === 0 }]]));
    if (ev.some((e) => e.k === 'tdown')) down = true;
    Object.assign(a, { x: spot.x - 4, y: spot.y, z: 6, vx: 0, vy: 0, vz: 0, grounded: true, falling: false, fallTime: 0 });
  }
  assert.ok(down && g.turrets[0].down > 0, 'a turret can be shot out');

  // Railgun: one slug through two people standing in a line.
  const g2 = createGame(20);
  for (let id = 0; id < 3; id++) addPlayer(g2, id, 6);
  setMapChoice(g2, MAPS.findIndex((m) => m.name === 'Helipad'));
  const [r0, r1, r2] = g2.players;
  for (const [p, x] of [[r0, -6], [r1, 0], [r2, 4]] as const) Object.assign(p, { x, y: 0, z: 0, vx: 0, vy: 0, vz: 0, damage: 0, grounded: true });
  step(g2, new Map([[r0.id, { ...NO_INPUT, yaw: 0, pitch: 0, firing: true }]]));
  for (let i = 0; i < 10; i++) step(g2, new Map());
  assert.ok(r1.damage > 0 && r2.damage > 0, `the railgun goes through both (${r1.damage}, ${r2.damage})`);

  // Sudden death: bombs fall once a round passes BOMB_TIME.
  const g3 = createGame(21);
  for (let id = 0; id < 2; id++) addPlayer(g3, id, 0);
  setMapChoice(g3, MAPS.findIndex((m) => m.name === 'Helipad'));
  startMatch(g3);
  while (g3.phase !== 'playing') step(g3, new Map());
  let sudden = false;
  let bombs = 0;
  for (let i = 0; i < Math.ceil((C.BOMB_TIME + 5) / C.TICK_DT) && g3.phase === 'playing'; i++) {
    for (const p of g3.players) Object.assign(p, { x: p.id * 4, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: true, falling: false });
    const ev = step(g3, new Map());
    if (ev.some((e) => e.k === 'sudden')) sudden = true;
    bombs += ev.filter((e) => e.k === 'bomb').length;
  }
  assert.ok(sudden && bombs >= 3, `sudden death drops bombs (${bombs})`);
  console.log(`ok 19 - tall rooftops, turrets (${tfired} shots, shot out), railgun pierces, sudden death (${bombs} bombs in 5 s)`);
}

console.log('all simulation tests passed');
