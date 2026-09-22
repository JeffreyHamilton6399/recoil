// Headless simulation test. Run with: npm test
// 1. 1000 ticks of lobby warm-up with 4 random players.
// 2. A scripted 2-player duel until someone wins a round.
// 3. Full 6-player matches with random inputs, back to the lobby, on every map.
// 4. Spawn points are safe on every map for every player count.

import assert from 'node:assert/strict';
import * as C from './constants.js';
import { MAPS, isOffMap, scaledBumpers, spawnPoint } from './maps.js';
import { addPlayer, angleDiff, createGame, enterLobby, removePlayer, startMatch, step } from './sim.js';
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
  for (const p of s.players) nums.push(p.x, p.y, p.vx, p.vy, p.aim, p.charge, p.damage, p.fallTime, p.rapid, p.triple, p.shield, p.mega);
  for (const b of s.bullets) nums.push(b.x, b.y, b.vx, b.vy, b.radius);
  for (const u of s.powerups) nums.push(u.x, u.y, u.age);
  for (const n of nums) assert.ok(Number.isFinite(n), `non-finite value at tick ${s.tick}`);
  assert.ok(s.arenaRadius <= C.ARENA_START_RADIUS + 1e-9 && s.arenaRadius >= C.ARENA_END_RADIUS - 1e-9);
  assert.ok(s.mapIndex >= 0 && s.mapIndex < MAPS.length);
  assert.ok(s.powerups.length <= C.POWERUP_MAX);
  for (const p of s.players) assert.ok(p.charge >= 0 && p.charge <= 1);
  for (const sc of s.scores) assert.ok(sc <= C.WIN_SCORE);
}

function randomInputs(rand: () => number, s: GameState, prev: Map<PlayerId, InputState>): Map<PlayerId, InputState> {
  const next = new Map(prev);
  for (const p of s.players) {
    if (!next.has(p.id) || rand() < 0.1) next.set(p.id, { aimLeft: rand() < 0.3, aimRight: rand() < 0.3, firing: rand() < 0.5 });
  }
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
  console.log(`ok 1 - 1000 lobby ticks, ${shots} shots, ${respawns} respawns, ${s.powerups.length} power-ups on the ice`);
}

// 2. Scripted duel: player 0 aims at player 1 and fires full-charge shots.
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
    const want = Math.atan2(them.y - me.y, them.x - me.x);
    const diff = angleDiff(me.aim, want);
    const firing = chargeTicks < C.CHARGE_TIME * C.TICK_RATE + 1;
    chargeTicks = firing ? chargeTicks + 1 : 0;
    const inputs = new Map<PlayerId, InputState>([[0, { aimLeft: diff < -0.05, aimRight: diff > 0.05, firing }]]);
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
        assert.ok(!isOffMap(map, C.ARENA_START_RADIUS, sp.x, sp.y), `${map.name}: spawn ${i}/${n} is off the ice`);
        for (const b of scaledBumpers(map, C.ARENA_START_RADIUS)) {
          assert.ok(Math.hypot(sp.x - b.x, sp.y - b.y) >= b.r + C.PLAYER_RADIUS, `${map.name}: spawn ${i}/${n} is inside a bumper`);
        }
      }
    }
  }
  console.log(`ok 4 - safe spawns on all ${MAPS.length} maps for 1-${C.MAX_PLAYERS} players`);
}

console.log('all simulation tests passed');
