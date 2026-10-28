// Hole-by-hole scores (migration 0047, demo/assets/leagues.js): par per hole on the schedule row, a
// round's 18 holes counted into eagles-or-better / birdies / pars / bogeys / doubles-or-worse, and a
// player's entry ('pending') counting for nothing until staff confirm it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../', import.meta.url).href;
await import(ROOT + 'demo/assets/leagues.js');
const L = globalThis.InvictusLeagues;

const PARS = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 5, 4, 4, 3, 4, 5];   // par 72
const LG = { season_start: '2026-11-01', season_end: '2027-03-06', week_start: 0, scoring: 'strokes', team_mode: true,
  details: { holeScoring: true, schedule: [{ from: '2026-11-01', to: '2026-11-07', course: 'Marco Simone', pars: PARS },
    { from: '2026-11-08', to: '2026-11-14', course: 'Deer Ridge' }] } };
const teams = [{ id: 'A', name: 'Aces' }, { id: 'B', name: 'Birdies' }];

test('pars: 18 of them, 2–7 each, from a list or typed text', () => {
  assert.deepEqual(L.normalizePars('4 4 3 5 4 4 3 4 5, 4 4 3 5 4 4 3 4 5'), PARS);
  assert.equal(L.normalizePars('4 4 3'), null, 'not 18');
  assert.equal(L.normalizePars(PARS.map((p, i) => (i ? p : 9))), null, 'a par of 9');
  assert.deepEqual(L.parsFor(LG, '2026-11-01'), PARS);
  assert.equal(L.parsFor(LG, '2026-11-08'), null, 'week 2 has no pars yet');
});

test('a round needs all 18 holes, each a whole number', () => {
  assert.ok(L.normalizeHoles(PARS));
  assert.equal(L.normalizeHoles(PARS.slice(0, 17)), null);
  assert.equal(L.normalizeHoles([...PARS.slice(0, 17), '']), null, 'a blank hole');
  assert.equal(L.normalizeHoles([...PARS.slice(0, 17), 4.5]), null);
});

test('each hole is counted against its par', () => {
  // Hole 1 (par 4): 2 = eagle · hole 2 (par 4): 3 = birdie · hole 3 (par 3): 1 = ace on a par 3 → eagle or better
  // hole 4 (par 5): 6 = bogey · hole 5 (par 4): 6 = double · hole 6 (par 4): 8 = worse → double or worse · rest: par
  const holes = [...PARS]; holes[0] = 2; holes[1] = 3; holes[2] = 1; holes[3] = 6; holes[4] = 6; holes[5] = 8;
  const s = L.holeStats({ league: LG, teams, results: [{ team_id: 'A', played_on: '2026-11-01', holes, score: 0 }] });
  const a = s.rows.find((r) => r.key === 'A');
  assert.deepEqual([a.eagles, a.birdies, a.pars, a.bogeys, a.doubles, a.rounds], [2, 1, 12, 1, 2, 1]);
  assert.equal(s.leaders.birdies[0].name, 'Aces');
});

test('a player’s entry counts for nothing until staff confirm it', () => {
  const pending = { team_id: 'A', played_on: '2026-11-01', holes: PARS, score: 72, status: 'pending' };
  assert.equal(L.holeStats({ league: LG, teams, results: [pending] }).rows.find((r) => r.key === 'A').rounds, 0);
  assert.equal(L.standings({ league: LG, teams, results: [pending] }).find((r) => r.key === 'A').played, 0);
  const confirmed = { ...pending, status: 'confirmed' };
  assert.equal(L.standings({ league: LG, teams, results: [confirmed] }).find((r) => r.key === 'A').played, 1);
});

test('a week with no pars adds nothing to the stats (the round still counts in the standings)', () => {
  const r = { team_id: 'B', played_on: '2026-11-08', holes: PARS, score: 72 };
  assert.equal(L.holeStats({ league: LG, teams, results: [r] }).rows.find((x) => x.key === 'B').rounds, 0);
  assert.equal(L.standings({ league: LG, teams, results: [r] }).find((x) => x.key === 'B').played, 1);
});

test('settings survive the manager form round-trip', () => {
  const d = L.normalizeDetails({ holeScoring: true, schedule: [{ from: '2026-11-01', to: '2026-11-07', pars: PARS.join(' ') }] });
  assert.equal(d.holeScoring, true);
  assert.deepEqual(d.schedule[0].pars, PARS);
});
