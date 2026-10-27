// A week's scores are published when the week starts (lib/db.js splitPublished). A team that played
// the week early sees its own score at once; nobody else sees it, and it is not placed until then.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ROOT = new URL('../', import.meta.url).href;
await import(ROOT + 'demo/assets/leagues.js');
const L = globalThis.InvictusLeagues;
const src = readFileSync(new URL('../lib/db.js', import.meta.url), 'utf8');
const at = src.indexOf('function splitPublished');
const body = src.slice(at, src.indexOf('\n}\n', at) + 2);
const splitPublished = new Function(`${body}; return splitPublished;`)();

const WL = { season_start: '2026-11-01', season_end: '2027-03-06', week_start: 0 };
const rows = [
  { team_id: 'A', played_on: '2026-11-22', score: 40 },   // week 4 — this week
  { team_id: 'B', played_on: '2026-11-29', score: 38 },   // week 5 — played early
  { team_id: 'A', played_on: '2026-11-15', score: 44 },   // week 3 — last week
];

test('a score is public once its week has started; an early one is held back', () => {
  const { published, early } = splitPublished(L, WL, rows, '2026-11-25');   // a Wednesday in week 4
  assert.deepEqual(published.map((r) => r.played_on).sort(), ['2026-11-15', '2026-11-22']);
  assert.deepEqual(early.map((r) => [r.team_id, r.played_on]), [['B', '2026-11-29']]);
});

test('the held-back score is published the day its week starts', () => {
  const { published, early } = splitPublished(L, WL, rows, '2026-11-29');   // Sunday: week 5 starts
  assert.equal(early.length, 0);
  assert.equal(published.length, 3);
});
