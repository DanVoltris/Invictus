// Phase 2 logic: leagues in lib/db.js, the league branch of promo eligibility.
// The real lib/db.js and lib/booking.js run; only the Supabase client under them is fake.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
const ROOT = new URL('../', import.meta.url).href;

const S = {};
let seq = 0;
function builder(table) {
  const st = { f: [], op: 'select', payload: null, cols: '' };
  const match = (r) => st.f.every(([k, c, v]) => k === 'eq' ? r[c] === v : k === 'in' ? v.includes(r[c]) : k === 'is' ? (r[c] ?? null) === v
    : k === 'like' ? String(r[c] || '').includes(String(v).replace(/%/g, '')) : k === 'not' ? r[c] != null : true);
  const embed = (r) => {
    const out = { ...r };
    if (/leagues\(/.test(st.cols)) out.leagues = (S.db.leagues || []).find((l) => l.id === r.league_id) || null;
    if (/customers\(/.test(st.cols)) out.customers = (S.db.customers || []).find((c) => c.id === r.customer_id) || null;
    return out;
  };
  const run = () => {
    const rows = S.db[table] = S.db[table] || [];
    if (st.op === 'insert') {
      const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p) => ({ id: `${table}-${++seq}`, ...p }));
      if (S.rejectCol && list.some((x) => S.rejectCol in x)) return { data: null, error: { message: `column "${S.rejectCol}" of relation "${table}" does not exist` } };
      if (table === 'league_members') for (const x of list) {
        if (rows.some((r) => r.league_id === x.league_id && r.customer_id === x.customer_id)) return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
      }
      rows.push(...list); S.writes.push([table, 'insert', list]);
      return { data: Array.isArray(st.payload) ? list : list[0], error: null };
    }
    if (st.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.payload)); S.writes.push([table, 'update', st.payload]); return { data: hit, error: null }; }
    if (S.rejectSelectCol && st.cols.includes(S.rejectSelectCol)) return { data: null, error: { message: `column league_members.${S.rejectSelectCol} does not exist` } };
    return { data: rows.filter(match).map(embed), error: null };
  };
  const q = {
    select(c) { st.cols = c || ''; return q; }, order() { return q; }, limit() { return q; },
    eq(c, v) { st.f.push(['eq', c, v]); return q; }, in(c, v) { st.f.push(['in', c, v]); return q; }, is(c, v) { st.f.push(['is', c, v]); return q; },
    like(c, v) { st.f.push(['like', c, v]); return q; }, not(c) { st.f.push(['not', c]); return q; }, ilike(c, v) { st.f.push(['eq', c, v]); return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; },
    maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
    single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; },
    then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
  };
  return q;
}
mock.module(ROOT + 'node_modules/@supabase/supabase-js/dist/index.mjs', { namedExports: {
  createClient: () => ({ from: (t) => builder(t),
    auth: { getUser: async (tok) => (S.tokens[tok] ? { data: { user: { id: S.tokens[tok] } } } : { error: { message: 'bad jwt' }, data: {} }) } }),
} });
const db = await import(ROOT + 'lib/db.js');
const { promoApplies, winnipegTodayISO } = await import(ROOT + 'lib/booking.js');

const today = winnipegTodayISO();
const addDays = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function world(extra = {}) {
  seq = 0;
  Object.assign(S, { writes: [], tokens: { 'tok-murad': 'user-murad' }, db: {
    customers: [
      { id: 'c-murad', name: 'Murad Cheway', phone: '+12049906530', email: 'murad@voltrisai.com', user_id: 'user-murad' },
      { id: 'c-sam', name: 'Sam Okafor', phone: '+12045550116', email: 'sam@example.com' },
      { id: 'c-lee', name: 'Lee', phone: '+12045550199', email: null },
    ],
    leagues: [
      { id: 'L-thu', name: 'Thursday Night', is_active: true, join_online: true, season_start: addDays(-30), season_end: addDays(30), day_of_week: 4, start_min: 1140, end_min: 1260, team_mode: true, scoring: 'points', capacity: 3, fee_cents: 15000, sort: 0 },
      { id: 'L-old', name: 'Spring League', is_active: true, join_online: true, season_start: addDays(-120), season_end: addDays(-1), day_of_week: 2, start_min: 600, end_min: 720, team_mode: false, scoring: 'strokes', capacity: null, fee_cents: 0, sort: 1 },
      { id: 'L-off', name: 'Retired', is_active: false, join_online: true, season_start: addDays(-10), season_end: addDays(10), day_of_week: 1, team_mode: false, scoring: 'points', capacity: null, fee_cents: 0, sort: 2 },
      { id: 'L-staff', name: 'Invite only', is_active: true, join_online: false, season_start: addDays(-10), season_end: null, day_of_week: 5, team_mode: false, scoring: 'points', capacity: null, fee_cents: 0, sort: 3 },
    ],
    league_teams: [{ id: 'T-aces', league_id: 'L-thu', name: 'Aces' }],
    league_members: [
      { id: 'm1', league_id: 'L-thu', customer_id: 'c-murad', team_id: 'T-aces', status: 'active' },
      { id: 'm2', league_id: 'L-thu', customer_id: 'c-sam', team_id: 'T-aces', status: 'active' },
      { id: 'm3', league_id: 'L-old', customer_id: 'c-lee', team_id: null, status: 'active' },
    ],
    league_results: [
      { league_id: 'L-thu', played_on: addDays(-7), team_id: 'T-aces', customer_id: null, score: 8 },
      { league_id: 'L-thu', played_on: addDays(-14), team_id: 'T-aces', customer_id: null, score: 5 },
    ],
    ...extra,
  } });
}

test('isLeaguePlayer: current season yes; ended season, left, inactive, unknown: no', async () => {
  world();
  assert.equal(await db.isLeaguePlayer({ phone: '204-990-6530' }), true);
  assert.equal(await db.isLeaguePlayer({ phone: '2045550199' }), false, 'Lee is only in a season that ended yesterday');
  assert.equal(await db.isLeaguePlayer({ phone: '2045550000' }), false);
  S.db.league_members[0].status = 'left';
  assert.equal(await db.isLeaguePlayer({ phone: '2049906530' }), false);
  world(); S.db.leagues[0].is_active = false;
  assert.equal(await db.isLeaguePlayer({ phone: '2049906530' }), false);
});

test('listPublicLeagues: only active, online, current; spots left counted', async () => {
  world();
  const { leagues } = await db.listPublicLeagues();
  assert.deepEqual(leagues.map((l) => l.id), ['L-thu']);
  assert.equal(leagues[0].players, 2); assert.equal(leagues[0].spotsLeft, 1);
});

test('joinLeague: new player → customer created, team created, placed on roster', async () => {
  world();
  const r = await db.joinLeague({ leagueId: 'L-thu', name: 'Pat New', phone: '2045551234', teamName: '  birdies ' });
  assert.equal(r.ok, true);
  const cust = S.db.customers.find((c) => c.name === 'Pat New');
  assert.ok(cust, 'customer row made');
  const team = S.db.league_teams.find((t) => t.name === 'birdies');
  assert.ok(team, 'team created');
  assert.ok(S.db.league_members.find((m) => m.customer_id === cust.id && m.team_id === team.id && m.status === 'active' && m.source === 'online'));
});

test('joinLeague: existing team name reused case-insensitively', async () => {
  world();
  await db.joinLeague({ leagueId: 'L-thu', name: 'Pat', phone: '2045551234', teamName: 'ACES' });
  assert.equal(S.db.league_teams.length, 1);
  assert.equal(S.db.league_members.at(-1).team_id, 'T-aces');
});

test('joinLeague: already on roster → already, nothing new written', async () => {
  world();
  const before = S.db.league_members.length;
  const r = await db.joinLeague({ leagueId: 'L-thu', name: 'Murad', phone: '2049906530' });
  assert.equal(r.already, true); assert.equal(S.db.league_members.length, before);
});

test('joinLeague: full league refuses a free join, but honours a paid Stripe session', async () => {
  world();
  await db.joinLeague({ leagueId: 'L-thu', name: 'Third', phone: '2045550001' });   // 3 of 3
  const full = await db.joinLeague({ leagueId: 'L-thu', name: 'Fourth', phone: '2045550002' });
  assert.equal(full.code, 409);
  const paid = await db.joinLeague({ leagueId: 'L-thu', name: 'Fourth', phone: '2045550002', stripeSessionId: 'cs_1', paidCents: 15000 });
  assert.equal(paid.ok, true);
  const again = await db.joinLeague({ leagueId: 'L-thu', name: 'Fourth', phone: '2045550002', stripeSessionId: 'cs_1', paidCents: 15000 });
  assert.equal(again.already, true, 'same session twice is a no-op');
});

test('joinLeague: rejoining after leaving reactivates the same row', async () => {
  world(); S.db.league_members[1].status = 'left';
  const r = await db.joinLeague({ leagueId: 'L-thu', name: 'Sam', phone: '2045550116' });
  assert.equal(r.ok, true);
  assert.equal(S.db.league_members.filter((m) => m.customer_id === 'c-sam').length, 1);
  assert.equal(S.db.league_members[1].status, 'active');
});

test('joinLeague: season over or inactive → refused', async () => {
  world();
  assert.equal((await db.joinLeague({ leagueId: 'L-old', name: 'X', phone: '2045550003' })).code, 400);
  assert.equal((await db.joinLeague({ leagueId: 'L-off', name: 'X', phone: '2045550003' })).code, 404);
});

test('leaguesForCustomer: the season by week, standings with "you", scores — and no phone or email of anyone', async () => {
  world();
  const L = globalThis.InvictusLeagues;
  const [m] = await db.leaguesForCustomer('c-murad');
  assert.equal(m.league.name, 'Thursday Night'); assert.equal(m.team, 'Aces');
  // Since migration 0031 a league has no fixed night — the unit is the Monday–Sunday week.
  assert.equal(m.currentWeek.start, L.weekOf(today));
  assert.equal(m.weeks.length, L.weeks(S.db.leagues[0]).length);
  assert.equal(m.weeks.filter((w) => w.current).length, 1);
  assert.deepEqual(m.roster.map((p) => [p.name, p.you]), [['Murad C.', true], ['Sam O.', false]]);
  assert.deepEqual(m.standings.map((r) => [r.name, r.total, r.played, r.you]), [['Aces', 13, 2, true]]);
  assert.deepEqual(m.myScores.map((s) => s.score), [8, 5]);
  const json = JSON.stringify(m);
  for (const secret of ['2049906530', '2045550116', '@voltrisai.com', '@example.com', 'Cheway', 'Okafor']) assert.equal(json.includes(secret), false, `leaked ${secret}`);
  assert.deepEqual(await db.leaguesForCustomer('c-lee'), [], 'finished seasons are not shown');
});

test('confirmLeagueCheckout: unpaid / wrong kind refused; paid joins once', async () => {
  world();
  const sessions = {
    unpaid: { id: 'cs_u', payment_status: 'unpaid', metadata: { kind: 'league', leagueId: 'L-thu', name: 'A', phone: '2045550011' } },
    other: { id: 'cs_o', payment_status: 'paid', metadata: { kind: 'membership' } },
    paid: { id: 'cs_p', payment_status: 'paid', amount_total: 15000, metadata: { kind: 'league', leagueId: 'L-thu', name: 'Paid Player', phone: '2045550012' } },
  };
  const stripe = { checkout: { sessions: { retrieve: async (id) => { const s = Object.values(sessions).find((x) => x.id === id); if (!s) throw new Error('nope'); return s; } } } };
  assert.match((await db.confirmLeagueCheckout(stripe, 'cs_u')).error, /not complete/);
  assert.match((await db.confirmLeagueCheckout(stripe, 'cs_o')).error, /not a league/);
  assert.match((await db.confirmLeagueCheckout(stripe, 'cs_missing')).error, /not found/);
  assert.equal((await db.confirmLeagueCheckout(stripe, 'cs_p')).ok, true);
  assert.equal((await db.confirmLeagueCheckout(stripe, 'cs_p')).already, true);
  assert.equal(S.db.league_members.filter((x) => x.stripe_session_id === 'cs_p').length, 1);
  assert.equal(S.db.league_members.find((x) => x.stripe_session_id === 'cs_p').paid_cents, 15000);
});

test('leaguePlayerForRequest: only a session or the dev marker counts — a typed phone never does', async () => {
  world();
  assert.equal(await db.leaguePlayerForRequest({ headers: {}, body: { phone: '2049906530' } }, { phone: '2049906530' }), false, 'typing a league player\'s number unlocks nothing');
  assert.equal(await db.leaguePlayerForRequest({ headers: {}, devAccountPhone: '2049906530' }), true, 'localhost dev account');
  assert.equal(await db.leaguePlayerForRequest({ headers: {} }, {}), false);
  assert.equal(await db.leaguePlayerForRequest({ headers: { authorization: 'Bearer tok-murad' } }, {}), true);
  assert.equal(await db.leaguePlayerForRequest({ headers: { authorization: 'Bearer forged' } }, {}), false);
});

test('promo "members only" now means league players', () => {
  const promo = { active: true, membership_scope: 'members', membership_ids: ['old-plan'], bay_ids: [], weekdays: [] };
  assert.equal(promoApplies(promo, { leaguePlayer: true }).ok, true, 'plan-specific codes apply to any league player');
  assert.equal(promoApplies(promo, { leaguePlayer: false }).reason, 'members_only');
  assert.equal(promoApplies({ ...promo, membership_scope: 'non_members' }, { leaguePlayer: true }).reason, 'non_members_only');
  assert.equal(promoApplies({ ...promo, membership_scope: 'non_members' }, { leaguePlayer: false }).ok, true);
});

// ---- league management (migrations 0030 / 0031) ----
test('leaguesForCustomer: standing, progress, the season week by week with scores and rounds, teams, bay names, payment', async () => {
  world({
    settings: [{ id: 1, bays: [{ id: 'B1', name: 'Assiniboine Bay #1' }] }],
    league_teams: [{ id: 'T-aces', league_id: 'L-thu', name: 'Aces' }, { id: 'T-birdies', league_id: 'L-thu', name: 'Birdies' }],
  });
  const L = globalThis.InvictusLeagues;
  const playedOn = addDays(-7);
  S.db.leagues[0].bay_ids = ['B1'];
  S.db.league_members.push({ id: 'm4', league_id: 'L-thu', customer_id: 'c-lee', team_id: 'T-birdies', status: 'active' });
  S.db.league_members[0].paid_cents = 15000; S.db.league_members[0].paid_at = '2026-09-02T12:00:00Z'; S.db.league_members[0].joined_at = '2026-09-01T12:00:00Z';
  S.db.league_results = [
    { league_id: 'L-thu', played_on: playedOn, team_id: 'T-aces', customer_id: null, score: 8 },
    { league_id: 'L-thu', played_on: playedOn, team_id: 'T-birdies', customer_id: null, score: 11 },
  ];
  // The round the team booked for that week (migration 0031): a free booking flagged as theirs.
  S.db.bookings = [{ id: 'bk-1', league_team_id: 'T-aces', booking_date: playedOn, league_week: L.weekOf(playedOn),
    bay_id: 'B1', start_min: 600, end_min: 780, status: 'confirmed' }];

  const [m] = await db.leaguesForCustomer('c-murad');
  assert.deepEqual(m.standing, { rank: 2, of: 2, played: 1, total: 8, average: 8, best: 8 });
  assert.deepEqual(m.progress, L.progress(S.db.leagues[0], today));
  const week = m.weeks.find((w) => w.start === L.weekOf(playedOn));
  assert.equal(week.score, 8, 'my team score, against the week it was played in');
  assert.equal(week.round.id, 'bk-1', 'and the round they booked that week');
  assert.equal(week.missed, false);
  assert.equal(typeof m.missedWeeks, 'number');
  assert.deepEqual(m.teams.map((t) => [t.name, t.you, t.players.map((p) => p.name)]), [['Aces', true, ['Murad C.', 'Sam O.']], ['Birdies', false, ['Lee']]]);
  assert.deepEqual(m.league.bays, ['Assiniboine Bay #1']);
  assert.deepEqual([m.paidCents, m.paidAt, m.joinedAt], [15000, '2026-09-02T12:00:00Z', '2026-09-01T12:00:00Z']);
  assert.equal(JSON.stringify(m).includes('2045550199'), false, 'no phone numbers');
});

test('joinLeague: a paid sign-up records paid_at; before 0030 it still joins without it', async () => {
  world();
  await db.joinLeague({ leagueId: 'L-thu', name: 'Payer', phone: '2045550777', stripeSessionId: 'cs_x', paidCents: 15000 });
  const row = S.db.league_members.find((x) => x.stripe_session_id === 'cs_x');
  assert.ok(row.paid_at, 'paid_at set');

  world(); S.rejectCol = 'paid_at';   // a database that has not had migration 0030
  const r = await db.joinLeague({ leagueId: 'L-thu', name: 'Payer2', phone: '2045550778', stripeSessionId: 'cs_y', paidCents: 15000 });
  S.rejectCol = null;
  assert.equal(r.ok, true, JSON.stringify(r));
  const row2 = S.db.league_members.find((x) => x.stripe_session_id === 'cs_y');
  assert.ok(row2 && !('paid_at' in row2) && row2.paid_cents === 15000, 'added without paid_at, amount kept');
});

test('leaguesForCustomer: still shows the league before migration 0030 (no paid_at column)', async () => {
  world(); S.rejectSelectCol = 'paid_at';
  const list = await db.leaguesForCustomer('c-murad');
  S.rejectSelectCol = null;
  assert.equal(list.length, 1); assert.equal(list[0].league.name, 'Thursday Night'); assert.equal(list[0].paidAt, null);
});

test('leaguesForCustomer: a score shows against the week it was played in, whichever day that was', async () => {
  world();
  const L = globalThis.InvictusLeagues;
  // Teams play whenever suits them (0031), so no date is an "off night" any more — every date
  // falls in exactly one Monday–Sunday week, and that is the week the score appears against.
  const playedOn = addDays(-9);
  S.db.league_results = [{ league_id: 'L-thu', played_on: playedOn, team_id: 'T-aces', customer_id: null, score: 9 }];
  const [m] = await db.leaguesForCustomer('c-murad');
  assert.equal(m.standing.played, 1);
  assert.equal(m.weeks.find((w) => w.start === L.weekOf(playedOn)).score, 9);
});
