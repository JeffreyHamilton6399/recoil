// Headless simulation test. Run with: npm test
// 1. Runs 1000 ticks of random inputs and checks the state stays sane.
// 2. Plays a scripted duel until someone wins a round.
// 3. Plays whole matches with random inputs and checks the match flow.

import assert from 'node:assert/strict';
import * as C from './constants.js';
import { angleDiff, createGame, startMatch, step } from './sim.js';
import type { GameState, InputState, PlayerIndex } from './types.js';

/** Small seeded PRNG so failures are reproducible. */
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
  const nums: number[] = [s.arenaRadius, s.phaseTime, s.playTime];
  for (const p of s.players) nums.push(p.x, p.y, p.vx, p.vy, p.aim, p.charge, p.damage, p.fallTime);
  for (const b of s.bullets) nums.push(b.x, b.y, b.vx, b.vy, b.radius);
  for (const n of nums) assert.ok(Number.isFinite(n), `non-finite value at tick ${s.tick}`);
  assert.ok(s.arenaRadius <= C.ARENA_START_RADIUS + 1e-9 && s.arenaRadius >= C.ARENA_END_RADIUS - 1e-9);
  for (const p of s.players) assert.ok(p.charge >= 0 && p.charge <= 1);
  assert.ok(s.scores[0] <= C.WIN_SCORE && s.scores[1] <= C.WIN_SCORE);
}

function randomInputs(rand: () => number, prev: [InputState, InputState]): [InputState, InputState] {
  return prev.map((inp) =>
    rand() < 0.1 ? { aimLeft: rand() < 0.3, aimRight: rand() < 0.3, firing: rand() < 0.5 } : inp,
  ) as [InputState, InputState];
}

// 1. 1000 random ticks.
{
  const rand = mulberry32(1234);
  const s = createGame();
  startMatch(s);
  let inputs: [InputState, InputState] = [
    { aimLeft: false, aimRight: false, firing: false },
    { aimLeft: false, aimRight: false, firing: false },
  ];
  let shots = 0;
  for (let i = 0; i < 1000; i++) {
    inputs = randomInputs(rand, inputs);
    shots += step(s, inputs).filter((e) => e.k === 'fire').length;
    assertSane(s);
  }
  assert.equal(s.tick, 1000);
  assert.ok(shots > 0, 'expected some shots to be fired');
  console.log(`ok 1 - 1000 random ticks, ${shots} shots, phase=${s.phase}, scores=${s.scores.join('-')}`);
}

// 2. Scripted duel: player 0 aims at player 1 and fires full-charge shots.
{
  const s = createGame();
  startMatch(s);
  let hits = 0;
  let chargeTicks = 0;
  for (let i = 0; i < 5000 && s.phase !== 'roundEnd'; i++) {
    const me = s.players[0];
    const them = s.players[1];
    const want = Math.atan2(them.y - me.y, them.x - me.x);
    const diff = angleDiff(me.aim, want);
    const firing = chargeTicks < C.CHARGE_TIME * C.TICK_RATE + 1;
    chargeTicks = firing ? chargeTicks + 1 : 0;
    const p0: InputState = { aimLeft: diff < -0.05, aimRight: diff > 0.05, firing };
    const p1: InputState = { aimLeft: false, aimRight: false, firing: false };
    hits += step(s, [p0, p1]).filter((e) => e.k === 'hit').length;
    assertSane(s);
  }
  assert.equal(s.phase, 'roundEnd', 'round should have ended');
  assert.ok(hits > 0, 'expected hits');
  console.log(`ok 2 - scripted duel ended at tick ${s.tick} after ${hits} hits, result=${String(s.roundResult)}`);
}

// 3. Full matches with random play finish and can be restarted.
{
  const rand = mulberry32(99);
  const s = createGame();
  startMatch(s);
  let inputs: [InputState, InputState] = [
    { aimLeft: false, aimRight: false, firing: false },
    { aimLeft: false, aimRight: false, firing: false },
  ];
  let matches = 0;
  for (let i = 0; i < 200000 && matches < 2; i++) {
    inputs = randomInputs(rand, inputs);
    step(s, inputs);
    assertSane(s);
    if (s.phase === 'matchEnd') {
      const w: PlayerIndex | null = s.matchWinner;
      assert.ok(w !== null && s.scores[w] === C.WIN_SCORE, 'winner should have WIN_SCORE points');
      matches++;
      startMatch(s);
      assert.deepEqual(s.scores, [0, 0]);
    }
  }
  assert.equal(matches, 2, 'expected two full matches to complete');
  console.log(`ok 3 - two complete random matches by tick ${s.tick}`);
}

console.log('all simulation tests passed');
