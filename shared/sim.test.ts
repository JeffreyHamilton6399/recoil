// Headless simulation test. Run with: npm test
// 1. 1000 ticks of lobby warm-up with 4 random players.
// 2. A scripted 2-player duel until someone wins a round.
// 3. Full 6-player matches with random inputs, back to the lobby, on every map.
// 4. Spawn points are safe on every map for every player count.
// 5. Movement: running, jumping, a recoil rocket-jump, and running off the edge.
// 6. Client prediction replays the same inputs to the same place as the server.

import assert from 'node:assert/strict';
import * as C from './constants.js';
import { MAPS, isOffMap, scaledBumpers, spawnPoint } from './maps.js';
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
  startMatch,
  step,
} from './sim.js';
import type { GameState, InputState, PlayerId } from './types.js';

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
    if (p.grounded && !p.falling) assert.equal(p.z, 0, 'grounded players stand on the roof');
  }
  for (const sc of s.scores) assert.ok(sc <= C.WIN_SCORE);
}

function randomInput(rand: () => number): InputState {
  return {
    forward: Math.floor(rand() * 3) - 1,
    strafe: Math.floor(rand() * 3) - 1,
    jump: rand() < 0.1,
    firing: rand() < 0.5,
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
  for (const id of [0, 1, 2, 3]) addPlayer(s, id);
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
    const firing = chargeTicks < C.CHARGE_TIME * C.TICK_RATE + 1;
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
  for (const id of [0, 1, 2, 3, 4, 5]) addPlayer(s, id);
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
        for (const b of scaledBumpers(map, C.ARENA_START_RADIUS)) {
          assert.ok(Math.hypot(sp.x - b.x, sp.y - b.y) >= b.r + C.PLAYER_RADIUS, `${map.name}: spawn ${i}/${n} is inside a bumper`);
        }
      }
    }
  }
  console.log(`ok 4 - safe spawns on all ${MAPS.length} maps for 1-${C.MAX_PLAYERS} players`);
}

// 5. Movement on the Helipad (no holes or bumpers).
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
  // Stand in the middle facing +x and run.
  p.x = 0;
  p.y = 0;
  hold({ yaw: 0, forward: 1 }, 15);
  assert.ok(Math.abs(Math.hypot(p.vx, p.vy) - C.MOVE_SPEED) < 1e-6, 'reaches running speed');
  assert.ok(p.vx > 0 && Math.abs(p.vy) < 1e-6, 'runs where it looks');
  hold({ yaw: 0 }, 10);
  assert.ok(Math.hypot(p.vx, p.vy) < 1e-6, 'stops when the keys are released');
  p.x = 0;
  p.y = 0;
  // Jump.
  hold({ jump: true }, 1);
  const jumpTop = hold({}, 40);
  assert.ok(p.grounded && p.z === 0, 'lands after a jump');
  assert.ok(jumpTop > 1, `jumps over a metre (got ${jumpTop.toFixed(2)})`);
  // Rocket-jump: full charge straight down.
  hold({ pitch: -C.PITCH_LIMIT, firing: true }, C.CHARGE_TIME * C.TICK_RATE + 2);
  const rocketTop = hold({ pitch: -C.PITCH_LIMIT }, 40);
  assert.ok(rocketTop > jumpTop, `a rocket-jump beats a jump (${rocketTop.toFixed(2)} vs ${jumpTop.toFixed(2)})`);
  // Run off the edge.
  p.x = 0;
  p.y = 0;
  const ev: string[] = [];
  for (let i = 0; i < 200 && !p.falling; i++) {
    for (const e of step(s, new Map([[0, { ...NO_INPUT, yaw: 0, forward: 1 }]]))) ev.push(e.k);
  }
  assert.ok(p.falling && ev.includes('fall'), 'running off the edge is a fall');
  console.log(`ok 5 - run, jump (${jumpTop.toFixed(2)}m), rocket-jump (${rocketTop.toFixed(2)}m), fall off the edge`);
}

// 6. Prediction: replaying inputs on a snapshot copy matches the server (one player, no shots).
{
  const rand = mulberry32(77);
  const s = createGame(11);
  addPlayer(s, 0);
  const server = s.players[0];
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

console.log('all simulation tests passed');
