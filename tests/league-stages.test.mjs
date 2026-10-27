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

// ---- Scoring (stagedStandings) ----------------------------------------------------------------
const STAGED = { ...WL, details: { ...WL.details, stages: { qualifiers: [1, 8], ranking: [11, 14], playoffs: [15, 18] } } };
const res = (team, week, score) => ({ team_id: team, played_on: wk(week), score });
const T = (id, extra = {}) => ({ id, name: id, ...extra });

test('weekly placings: lowest strokes first, ties share the place and skip the next', () => {
  const teams = ['A', 'B', 'C', 'D'].map((x) => T(x));
  const s = L.stagedStandings({ league: STAGED, teams, todayISO: '2026-11-10',
    results: [res('A', 1, 50), res('B', 1, 52), res('C', 1, 52), res('D', 1, 55)] });
  const w1 = Object.fromEntries(s.qualifiers.rows.map((r) => [r.key, r.weeks.find((w) => w.week === 1)]));
  assert.deepEqual(['A', 'B', 'C', 'D'].map((x) => w1[x].place), [1, 2, 2, 4]);
  assert.deepEqual(['A', 'B', 'C', 'D'].map((x) => w1[x].points), [100, 98, 98, 94]);
  assert.equal(s.qualifiers.weeks.length, 8, 'weeks 1–8 are scored; 9–10 are catch-up');
});

test('the points table, all the way down', () => {
  const st = L.normalizeStages({ qualifiers: [1, 8], ranking: [11, 14], playoffs: [15, 18] });
  const pts = (place) => { for (const [u, p] of st.points) if (place <= u) return p; return 0; };
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10, 11, 15, 16, 20, 21, 25, 26, 30, 31, 40, 41, 50, 51, 60, 61, 100].map(pts),
    [100, 98, 96, 94, 92, 90, 90, 85, 85, 80, 80, 75, 75, 70, 70, 65, 65, 60, 60, 55, 55, 50, 50]);
});

test('a missed qualifier week: nothing while it can be caught up, last-place points after the cut-off', () => {
  const teams = ['A', 'B', 'C'].map((x) => T(x));
  const results = [res('A', 1, 50), res('B', 1, 52)];
  const open = L.stagedStandings({ league: STAGED, teams, results, todayISO: '2026-11-10' });
  const c = (s) => s.qualifiers.rows.find((r) => r.key === 'C').weeks.find((w) => w.week === 1);
  assert.ok(c(open).pending, 'week 1 can still be caught up');
  const shut = L.stagedStandings({ league: STAGED, teams, results, todayISO: '2027-01-10' });
  assert.equal(c(shut).place, 3, 'two teams played, so the missing team is 3rd');
  assert.equal(c(shut).points, 96);
  assert.ok(c(shut).missed);
});

test('qualifier totals rank the teams for the managers', () => {
  const teams = ['A', 'B'].map((x) => T(x));
  const s = L.stagedStandings({ league: STAGED, teams, todayISO: '2026-12-01',
    results: [res('A', 1, 50), res('B', 1, 52), res('A', 2, 60), res('B', 2, 55)] });
  assert.deepEqual(s.qualifiers.rows.map((r) => [r.key, r.total, r.rank]), [['A', 198, 1], ['B', 198, 1]]);
  assert.equal(s.phase, 'qualifiers');
});

const divisionTeams = (extra = {}) => ['A', 'B', 'C', 'D'].map((x) => T(x, { division: 1, ...(extra[x] || {}) }));
const fullSeason = (team, rank, playoff) => [11, 12, 13, 14].map((w) => res(team, w, rank)).concat([15, 16, 17, 18].map((w) => res(team, w, playoff)));

test('divisions: final = (average of weeks 11–14 + average of weeks 15–18) ÷ 2, lowest wins', () => {
  const s = L.stagedStandings({ league: STAGED, teams: divisionTeams(), todayISO: '2027-03-07',
    results: [...fullSeason('A', 20, 10), ...fullSeason('B', 18, 16), ...fullSeason('C', 25, 20), ...fullSeason('D', 30, 30)] });
  const d1 = s.divisions[0];
  assert.equal(s.phase, 'divisions');
  assert.deepEqual(d1.standings.map((r) => [r.key, r.final, r.rank]), [['A', 15, 1], ['B', 17, 2], ['C', 22.5, 3], ['D', 30, 4]]);
  assert.deepEqual(d1.seeding.map((r) => r.key), ['B', 'A', 'C', 'D'], 'seeding is the weeks 11–14 average alone');
});

test('did not finish: after the season, a team missing any week from 11 on leaves the rankings', () => {
  const missing = fullSeason('D', 18, 15).filter((r) => r.played_on !== wk(17));
  const results = [...fullSeason('A', 20, 10), ...fullSeason('B', 18, 16), ...fullSeason('C', 25, 20), ...missing];
  const during = L.stagedStandings({ league: STAGED, teams: divisionTeams(), results, todayISO: '2027-03-01' });
  assert.equal(during.divisions[0].dnf.length, 0, 'still time to catch up');
  const after = L.stagedStandings({ league: STAGED, teams: divisionTeams(), results, todayISO: '2027-03-07' });
  assert.deepEqual(after.divisions[0].dnf.map((r) => r.key), ['D']);
  assert.ok(!after.divisions[0].standings.some((r) => r.key === 'D'));
});

test('a tie for the top three is played off; below that the better playoff average wins', () => {
  // A and B tie on 15 for 1st; C and D tie on 22 for 3rd — both ties touch the top three.
  const results = [...fullSeason('A', 20, 10), ...fullSeason('B', 10, 20), ...fullSeason('C', 24, 20), ...fullSeason('D', 20, 24)];
  const flagged = L.stagedStandings({ league: STAGED, teams: divisionTeams(), results, todayISO: '2027-03-07' }).divisions[0].standings;
  assert.deepEqual(flagged.filter((r) => r.tie === 'playoff').map((r) => [r.key, r.rank]).sort(), [['A', 1], ['B', 1], ['C', 3], ['D', 3]],
    'both ties touch the top three: play-offs needed');
  const settled = L.stagedStandings({ league: STAGED, results, todayISO: '2027-03-07',
    teams: divisionTeams({ A: { tiebreak_strokes: 31 }, B: { tiebreak_strokes: 29 }, C: { tiebreak_strokes: 30 }, D: { tiebreak_strokes: 33 } }) }).divisions[0].standings;
  assert.deepEqual(settled.map((r) => [r.key, r.rank]), [['B', 1], ['A', 2], ['C', 3], ['D', 4]]);
});

test('a tie below third goes to the better playoff average', () => {
  const teams = ['A', 'B', 'C', 'D', 'E'].map((x) => T(x, { division: 2 }));
  const results = [...fullSeason('A', 10, 10), ...fullSeason('B', 11, 11), ...fullSeason('C', 12, 12),
    ...fullSeason('D', 20, 24), ...fullSeason('E', 24, 20)];   // D and E both 22 → E's playoffs were better
  const s = L.stagedStandings({ league: STAGED, teams, results, todayISO: '2027-03-07' }).divisions[0].standings;
  assert.deepEqual(s.map((r) => [r.key, r.rank]), [['A', 1], ['B', 2], ['C', 3], ['E', 4], ['D', 5]]);
});

test('a league without stages is unchanged', () => {
  assert.equal(L.stagedStandings({ league: WL, teams: [], results: [] }), null);
  assert.ok(L.normalizeDetails({ stages: { qualifiers: [1, 8], ranking: [11, 14], playoffs: [15, 18] } }).stages);
});

test('a qualifier week with no scores entered at all is not "everyone missed it"', () => {
  const teams = ['A', 'B'].map((x) => T(x));
  const s = L.stagedStandings({ league: STAGED, teams, results: [res('A', 1, 50), res('B', 1, 52)], todayISO: '2027-01-10' });
  const w2 = s.qualifiers.rows.map((r) => r.weeks.find((w) => w.week === 2));
  assert.ok(w2.every((w) => w.pending && !w.points), 'week 2 has no scores yet: nobody gets last place for it');
});
