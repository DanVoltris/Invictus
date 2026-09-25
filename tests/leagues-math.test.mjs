// The shared league maths (demo/assets/leagues.js). A league is sold by the team and has no fixed
// night (migration 0031): teams play once a week, whenever they like. So the unit is the WEEK, and
// a week runs Monday–Sunday to match Postgres date_trunc('week') — the column the database uses to
// stop a team booking two rounds in one week. If these two ever disagree, that rule breaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const ROOT = new URL('../', import.meta.url).href;
await import(ROOT + 'demo/assets/leagues.js');
const L = globalThis.InvictusLeagues;

// Season: Monday 14 Sep 2026 → Sunday 1 Nov 2026.
const LG = { name: 'Winter League', season_start: '2026-09-14', season_end: '2026-11-01', weekly_min_mins: 180, scoring: 'points', team_mode: true, is_active: true };

test("weekOf: every day of a week maps to that week's Monday", () => {
  assert.equal(L.weekOf('2026-09-14'), '2026-09-14', 'Monday is its own week start');
  assert.equal(L.weekOf('2026-09-17'), '2026-09-14', 'Thursday');
  assert.equal(L.weekOf('2026-09-20'), '2026-09-14', 'Sunday belongs to the week that began Monday');
  assert.equal(L.weekOf('2026-09-21'), '2026-09-21', 'the next Monday starts a new week');
});

test('weeks: the season is a list of Monday–Sunday weeks, numbered from 1', () => {
  const w = L.weeks(LG);
  assert.equal(w.length, 7);
  assert.deepEqual(w[0], { start: '2026-09-14', end: '2026-09-20', number: 1 });
  assert.deepEqual(w.at(-1), { start: '2026-10-26', end: '2026-11-01', number: 7 });
});

test('weeks: a season starting mid-week still counts that part week — a team can play in it', () => {
  const w = L.weeks({ season_start: '2026-09-16', season_end: '2026-09-29' });   // Wed → Tue
  assert.deepEqual(w.map((x) => x.start), ['2026-09-14', '2026-09-21', '2026-09-28']);
});

test('weeks: no season dates means no weeks, and a silly season cannot run away', () => {
  assert.deepEqual(L.weeks({}), []);
  assert.deepEqual(L.weeks({ season_start: '2026-09-14' }), []);
  assert.equal(L.weeks({ season_start: '2020-01-06', season_end: '2099-01-06' }).length, 400);
});

test('currentWeek: the week today falls in, or nothing outside the season', () => {
  assert.equal(L.currentWeek(LG, '2026-09-20').number, 1, 'the Sunday is still week 1');
  assert.equal(L.currentWeek(LG, '2026-09-21').number, 2);
  assert.equal(L.currentWeek(LG, '2026-09-13'), null, 'the day before the season opens');
  assert.equal(L.currentWeek(LG, '2026-11-02'), null, 'the day after it closes');
});

test('progress: the week in play still counts as "to go" until it ends', () => {
  assert.deepEqual(L.progress(LG, '2026-09-14'), { played: 0, total: 7, left: 7 }, 'opening day');
  assert.deepEqual(L.progress(LG, '2026-09-20'), { played: 0, total: 7, left: 7 }, 'its last day — still playable');
  assert.deepEqual(L.progress(LG, '2026-09-21'), { played: 1, total: 7, left: 6 }, 'now week 1 is gone');
  assert.deepEqual(L.progress(LG, '2026-11-09'), { played: 7, total: 7, left: 0 }, 'season over');
});

test('teamWeeks: shows the round a team booked, whichever day of that week they played', () => {
  const rounds = [{ league_week: '2026-09-14', booking_date: '2026-09-16', bay_id: 'B1', status: 'confirmed' }];
  const weeks = L.teamWeeks({ league: LG, todayISO: '2026-09-18', rounds });
  assert.equal(weeks[0].round.booking_date, '2026-09-16');
  assert.equal(weeks[0].current, true);
  assert.equal(weeks[1].round, null);
  assert.equal(weeks.filter((w) => w.current).length, 1);
});

test('teamWeeks: a round with no league_week is filed by the week its date falls in', () => {
  const weeks = L.teamWeeks({ league: LG, todayISO: '2026-09-18', rounds: [{ booking_date: '2026-09-20', status: 'confirmed' }] });
  assert.equal(weeks[0].round.booking_date, '2026-09-20', 'the Sunday counts as week 1');
});

test('missed weeks: past weeks with no round; the current week is never missed yet', () => {
  const rounds = [{ league_week: '2026-09-14', booking_date: '2026-09-16', status: 'confirmed' }];
  assert.equal(L.missedWeeks({ league: LG, todayISO: '2026-09-20', rounds }), 0, 'week 1 booked, still in it');
  assert.equal(L.missedWeeks({ league: LG, todayISO: '2026-09-28', rounds }), 1, 'week 2 went by unbooked');
  assert.equal(L.missedWeeks({ league: LG, todayISO: '2026-09-28', rounds: [] }), 2);
});

test('missed weeks: a cancelled round does not count as played', () => {
  const rounds = [{ league_week: '2026-09-14', booking_date: '2026-09-16', status: 'cancelled' }];
  assert.equal(L.missedWeeks({ league: LG, todayISO: '2026-09-21', rounds }), 1);
});

test('teamsWithoutRound: who staff have to chase this week', () => {
  const teams = [{ id: 'T1', name: 'Aces' }, { id: 'T2', name: 'Birdies' }, { id: 'T3', name: 'Divots' }];
  const rounds = [
    { league_team_id: 'T1', league_week: '2026-09-21', status: 'confirmed' },
    { league_team_id: 'T2', league_week: '2026-09-14', status: 'confirmed' },   // last week, not this one
    { league_team_id: 'T3', league_week: '2026-09-21', status: 'cancelled' },   // cancelled it
  ];
  const late = L.teamsWithoutRound({ league: LG, todayISO: '2026-09-23', teams, rounds });
  assert.deepEqual(late.map((t) => t.name), ['Birdies', 'Divots']);
  assert.deepEqual(L.teamsWithoutRound({ league: LG, todayISO: '2026-12-01', teams, rounds }), [], 'season over: nobody to chase');
});

test('scheduleLabel: says how it actually works, with the recommended length', () => {
  assert.equal(L.scheduleLabel(LG), 'Once a week, your own time · 3 hours recommended');
  assert.equal(L.scheduleLabel({ weekly_min_mins: 60 }), 'Once a week, your own time · 1 hour recommended');
  assert.equal(L.scheduleLabel({}), 'Once a week, your own time');
  assert.equal(L.timeLabel(0), '12:00 AM');
  assert.equal(L.timeLabel(720), '12:00 PM');
});

test('isCurrent', () => {
  assert.equal(L.isCurrent({ is_active: true, season_end: '2026-09-30' }, '2026-09-12'), true);
  assert.equal(L.isCurrent({ is_active: true, season_end: '2026-09-01' }, '2026-09-12'), false);
  assert.equal(L.isCurrent({ is_active: false, season_end: null }, '2026-09-12'), false);
  assert.equal(L.isCurrent({ is_active: true, season_end: null }, '2026-09-12'), true);
});

test('points league (teams): highest total wins, ties share a rank, unplayed last', () => {
  const s = L.standings({ league: { team_mode: true, scoring: 'points' },
    teams: [{ id: 'A', name: 'Aces' }, { id: 'B', name: 'Birdies' }, { id: 'C', name: 'Chippers' }, { id: 'D', name: 'Divots' }],
    results: [{ team_id: 'A', score: 10 }, { team_id: 'B', score: 6 }, { team_id: 'A', score: 2 }, { team_id: 'C', score: 12 }, { team_id: 'B', score: 6 }] });
  assert.deepEqual(s.map((r) => [r.name, r.total, r.rank, r.played]), [['Aces', 12, 1, 2], ['Birdies', 12, 1, 2], ['Chippers', 12, 1, 1], ['Divots', 0, 4, 0]]);
});

test('strokes league (players): lowest AVERAGE wins, so missing a week does not help', () => {
  const s = L.standings({ league: { team_mode: false, scoring: 'strokes' },
    members: [{ customer_id: 'p1', name: 'Pat' }, { customer_id: 'p2', name: 'Sam' }, { customer_id: 'p3', name: 'Lee', status: 'left' }],
    results: [{ customer_id: 'p1', score: 72 }, { customer_id: 'p1', score: 70 }, { customer_id: 'p2', score: 69 }, { customer_id: 'p3', score: 80 }] });
  assert.deepEqual(s.map((r) => [r.name, r.average, r.best, r.rank]), [['Sam', 69, 69, 1], ['Pat', 71, 70, 2], ['Lee', 80, 80, 3]]);
});

test('publicName: how a player appears to other players', () => {
  assert.equal(L.publicName('Murad Cheway'), 'Murad C.');
  assert.equal(L.publicName('Cher'), 'Cher');
  assert.equal(L.publicName(''), 'Player');
  assert.deepEqual([1, 2, 3, 4, 11, 21].map(L.ordinal), ['1st', '2nd', '3rd', '4th', '11th', '21st']);
});
