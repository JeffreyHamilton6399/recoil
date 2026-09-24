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
import { MAPS, inBlock, isOffMap, mapScale, rampHeight, scaledBumpers, scaledRamps, spawnPoint } from './maps.js';
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
  setOffhand,
  setWeapon,
  startMatch,
  step,
} from './sim.js';
import { BotBrain } from './bot.js';
import { SHOCK_WEAPON, WEAPONS } from './weapons.js';
import type { GameState, InputState, PlayerId, PlayerState } from './types.js';

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
    nums.push(p.x, p.y, p.z, p.vx, p.vy, p.vz, p.yaw, p.pitch, p.charge, p.damage, p.fallTime, p.rapid, p.triple, p.shield, p.mega);
  }
  for (const b of s.bullets) nums.push(b.x, b.y, b.z, b.vx, b.vy, b.vz, b.radius);
  for (const u of s.powerups) nums.push(u.x, u.y, u.age);
  for (const n of nums) assert.ok(Number.isFinite(n), `non-finite value at tick ${s.tick}`);
  assert.ok(s.arenaRadius <= C.ARENA_START_RADIUS + 1e-9 && s.arenaRadius >= C.ARENA_END_RADIUS - 1e-9);
  assert.ok(s.mapIndex >= 0 && s.mapIndex < MAPS.length);
  assert.ok(s.powerups.length <= C.POWERUP_MAX);
  for (const p of s.players) {
    assert.ok(p.charge >= 0 && p.charge <= 1);
    if (p.grounded && !p.falling) {
      const onBlock = currentMap(s).blocks.some((b) => Math.abs(b.h - p.z) < 1e-9);
      const onRamp = scaledRamps(currentMap(s), s.arenaRadius).some((r) => Math.abs(rampHeight(r, p.x, p.y) - p.z) < 0.35);
      assert.ok(p.z === 0 || onBlock || onRamp, `grounded players stand on the roof, a block or a ramp (z=${p.z})`);
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

// 2. Scripted duel: player 0 aims at player 1's chest and fires full-charge shots.
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
    const firing = chargeTicks < WEAPONS[0].chargeTime * C.TICK_RATE + 1;
    chargeTicks = firing ? chargeTicks + 1 : 0;
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
  for (let i = 0; i < 200 && !p.falling; i++) {
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
  const { canMove, canFire } = phaseRules(s.phase);
  let maxErr = 0;
  for (let i = 0; i < 300 && !server.falling; i++) {
    const input = { ...randomInput(rand), firing: false };
    step(s, new Map([[0, input]]));
    controlPlayer(local, input, C.TICK_DT, canMove, canFire);
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
  let ev = step(s, new Map([[0, { ...noop(a), offhand: true }], [1, noop(b)]]));
  assert.ok(ev.some((e) => e.k === 'melee' && e.hit), 'knife connects at point-blank');
  assert.ok(b.vx > 5 && b.damage > 0, `knife shoves (vx=${b.vx.toFixed(1)})`);
  assert.ok(a.offCd > 0, 'knife goes on cooldown');
  // Holding the button doesn't swing again.
  ev = step(s, new Map([[0, { ...noop(a), offhand: true }], [1, noop(b)]]));
  assert.ok(!ev.some((e) => e.k === 'melee'), 'no swing while held / on cooldown');

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
  console.log(`ok 7 - knife shove ${b.vx.toFixed(1)} m/s, shockwave throw ${shoved.toFixed(1)} m/s`);
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
    for (let i = 0; i < ticks; i++) step(s, new Map([[0, { ...NO_INPUT, forward: 1, yaw, pitch: 0, ...extra }]]));
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

console.log('all simulation tests passed');
