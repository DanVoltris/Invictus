// The 2026-27 Winter League's shape (demo/assets/leagues.js): 18 Sunday–Saturday weeks; weeks 1–8
// are the scored qualifiers, weeks 9–10 are catch-up weeks with no course of their own, the
// qualifiers close for good after week 10 (Jan 9) so the managers can split the divisions, and
// weeks 11–18 may be caught up in order — into the playoffs — until the season ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../', import.meta.url).href;
await import(ROOT + 'demo/assets/leagues.js');
const L = globalThis.InvictusLeagues;

const WL = {
  name: 'Invictus Winter League 2026-2027', season_start: '2026-11-01', season_end: '2027-03-06', week_start: 0,
  scoring: 'strokes', team_mode: true, is_active: true,
  details: {
    dates: { playoffsStart: '2027-02-07', qualifiersEnd: '2027-01-09', playoffMakeups: true, rosterLockWeek: 4 },
    schedule: [{ from: '2026-12-27', to: '2027-01-09', course: 'Catch-up weeks', catchup: true }],
  },
};
const wk = (n) => L.weeks(WL)[n - 1].start;          // the Sunday week n starts on
const dayIn = (n, plus = 2) => { const d = new Date(`${wk(n)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + plus); return d.toISOString().slice(0, 10); };
// A team's season with rounds already played in the given week numbers.
const season = (played, todayISO) => L.teamWeeks({ league: WL, todayISO,
  rounds: played.map((n) => ({ league_week: wk(n), booking_date: dayIn(n), status: 'confirmed' })) });
const target = (played, onWeek, pick = null) => {
  const dateISO = dayIn(onWeek);
  return L.roundTarget({ league: WL, weeks: season(played, dateISO), dateISO, pick });
};
const weekNo = (r) => r.week && L.weeks(WL).findIndex((w) => w.start === r.week.start) + 1;

test('18 weeks; weeks 9 and 10 are catch-up weeks', () => {
  const all = L.weeks(WL);
  assert.equal(all.length, 18);
  assert.equal(all[0].start, '2026-11-01');
  assert.equal(all[8].start, '2026-12-27');
  assert.deepEqual(all.filter((w) => w.catchup).map((w) => w.number), [9, 10]);
  assert.ok(all[8].off && all[9].off, 'a catch-up week is never owed');
});

test('a missed week is played next, in order', () => {
  const r = target([1], 3);                  // missed week 2, playing in week 3
  assert.ok(r.ok); assert.equal(weekNo(r), 2); assert.ok(r.makeup);
});

test('a catch-up week only catches up', () => {
  const owed = target([1, 2, 3, 4, 6, 7, 8], 9);
  assert.ok(owed.ok); assert.equal(weekNo(owed), 5, 'week 5 was missed, so week 9 plays week 5');
  const none = target([1, 2, 3, 4, 5, 6, 7, 8], 10);
  assert.equal(none.ok, false); assert.equal(none.code, 'catchup_only', 'up to date: nothing to play');
});

test('after week 10 the qualifiers are closed for good', () => {
  const r = target([1, 2, 3, 4, 5, 6, 7], 11);   // never played week 8
  assert.ok(r.ok); assert.equal(weekNo(r), 11, 'week 8 cannot be played any more; week 11 is this week');
  assert.ok(!r.makeup);
});

test('weeks 11–18 can be caught up into the playoffs, in order', () => {
  const quals = [1, 2, 3, 4, 5, 6, 7, 8];
  const r = target([...quals, 11, 13, 14, 15], 16);   // missed week 12
  assert.ok(r.ok); assert.equal(weekNo(r), 12, 'week 12 is played before week 16');
  const caught = target([...quals, 11, 12, 13, 14, 15], 16);
  assert.ok(caught.ok); assert.equal(weekNo(caught), 16);
});

test('staff can book a week ahead; a customer booking never does', () => {
  const early = target([1, 2, 3], 4, wk(5));          // away in week 5: play it during week 4
  assert.ok(early.ok); assert.equal(weekNo(early), 5); assert.ok(early.early);
  const normal = target([1, 2, 3], 4);
  assert.equal(weekNo(normal), 4, 'without a pick the round is this week’s');
  assert.equal(target([1], 4, wk(9)).code, 'catchup_only', 'a catch-up week has no round of its own to play early');
  assert.equal(target([1, 2], 12, wk(3)).code, 'after_deadline', 'nor can staff reopen a closed qualifier week');
  assert.equal(target([1, 2, 3, 4, 5], 4, wk(5)).code, 'round_booked', 'a week already played is not booked twice');
});

test('settings survive the manager form round-trip', () => {
  const d = L.normalizeDetails({ dates: { qualifiersEnd: '2027-01-09', playoffMakeups: 'true' },
    schedule: [{ from: '2026-12-27', to: '2027-01-09', catchup: 'true' }] });
  assert.equal(d.dates.qualifiersEnd, '2027-01-09');
  assert.equal(d.dates.playoffMakeups, true);
  assert.equal(d.schedule[0].catchup, true);
});
