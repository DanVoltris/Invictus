// Leagues sold by the team (migration 0031): buying a team, inviting friends by phone number, and
// the free weekly round any member can book.
//
// The real lib/db.js, lib/booking.js, api/leagues.js, api/booking.js and api/webhook.js run end to
// end; only the Supabase client and the Stripe SDK underneath are fake. The fake database enforces
// the three unique indexes 0031 adds — one team name per league, one Stripe session per team, one
// live round per team per week — and generates bookings.league_week the way Postgres does, because
// those rules are the feature, not an implementation detail.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake',
  STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_PUBLISHABLE_KEY: 'pk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake' });
const ROOT = new URL('../', import.meta.url).href;

const S = {};
let seq = 0;

// The Monday of a date's week — date_trunc('week'), which is what the generated column does.
const mondayOf = (iso) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

// The unique indexes migration 0031 creates. Returning a name means the insert is refused with a
// Postgres unique_violation, exactly as the live database would refuse it.
const UNIQUE = {
  league_teams: (row, rows) => {
    if (row.stripe_session_id && rows.some((r) => r.stripe_session_id === row.stripe_session_id)) return 'league_teams_session_once';
    if (rows.some((r) => r.league_id === row.league_id && String(r.name).toLowerCase() === String(row.name).toLowerCase())) return 'league_teams_name_per_league';
    return null;
  },
  league_team_invites: (row, rows) =>
    (rows.some((r) => r.team_id === row.team_id && r.phone === row.phone && !r.claimed_at && !r.revoked_at) ? 'league_team_invites_open' : null),
  bookings: (row, rows) => (row.league_team_id
    && rows.some((r) => r.league_team_id === row.league_team_id && r.league_week === row.league_week && r.status !== 'cancelled')
    ? 'bookings_league_round_once' : null),
  league_members: (row, rows) => (rows.some((r) => r.league_id === row.league_id && r.customer_id === row.customer_id) ? 'league_members_once' : null),
};

function builder(table) {
  const st = { f: [], op: 'select', payload: null, cols: '' };
  const match = (r) => st.f.every(([k, c, v]) => k === 'eq' ? r[c] === v : k === 'in' ? v.includes(r[c]) : k === 'is' ? (r[c] ?? null) === v
    : k === 'like' ? String(r[c] || '').includes(String(v).replace(/%/g, '')) : k === 'not' ? r[c] != null : k === 'gte' ? r[c] >= v : k === 'lte' ? r[c] <= v
    : k === 'lt' ? r[c] < v : k === 'neq' ? r[c] !== v : true);
  const run = () => {
    if (S.fail[`${table}:${st.op}`]) return { data: null, error: S.fail[`${table}:${st.op}`] };
    // A database still on migration 0030: the 0031 columns simply are not there, whether they are
    // asked for in a select or written in an insert.
    if (S.missing0031) {
      const gone = S.missing0031.find((c) => (st.cols && st.cols.includes(c))
        || (st.payload && !Array.isArray(st.payload) && c in st.payload));
      if (gone) return { data: null, error: { code: '42703', message: `column "${gone}" does not exist` } };
    }
    const rows = S.db[table] = S.db[table] || [];
    if (st.op === 'insert') {
      const list = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((p) => {
        const row = { id: `${table}-${++seq}`, ...p };
        // league_week is generated always: supplied values are ignored, the date decides.
        if (table === 'bookings' && row.booking_date) row.league_week = mondayOf(row.booking_date);
        return row;
      });
      for (const row of list) {
        const clash = UNIQUE[table] && UNIQUE[table](row, rows);
        if (clash) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${clash}"` } };
        rows.push(row);
      }
      return { data: Array.isArray(st.payload) ? list : list[0], error: null };
    }
    if (st.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.payload)); return { data: hit, error: null }; }
    if (st.op === 'delete') { S.db[table] = rows.filter((r) => !match(r)); return { data: null, error: null }; }
    // Used by one test to make the "already played this week" pre-check miss, so the database's
    // own unique index is the thing that catches it.
    if (S.hideTeamRounds && table === 'bookings' && st.f.some(([, c]) => c === 'league_team_id')) return { data: [], error: null };
    return { data: rows.filter(match), error: null };
  };
  const q = {};
  for (const k of ['eq', 'in', 'is', 'like', 'gte', 'lte', 'lt', 'neq']) q[k] = (c, v) => { st.f.push([k, c, v]); return q; };
  Object.assign(q, {
    select(c) { st.cols = c || st.cols; return q; }, order() { return q; }, limit() { return q; },
    not(c) { st.f.push(['not', c]); return q; }, ilike(c, v) { st.f.push(['eq', c, v]); return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; }, delete() { st.op = 'delete'; return q; },
    maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
    single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; },
    then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
  });
  return q;
}
mock.module(ROOT + 'node_modules/@supabase/supabase-js/dist/index.mjs', { namedExports: {
  createClient: () => ({ from: (t) => builder(t), rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async (tok) => (S.tokens[tok] ? { data: { user: { id: S.tokens[tok] } } } : { error: { message: 'bad jwt' }, data: {} }) } }),
} });

// Fake Stripe: records every call and hands back shaped objects.
class FakeStripe {
  constructor() {
    this.checkout = { sessions: {
      create: async (p) => {
        S.stripe.push(['checkout.sessions.create', p]);
        const id = `cs_${++seq}`;
        S.sessions[id] = { id, payment_status: 'paid', amount_total: p.line_items[0].price_data.unit_amount, metadata: p.metadata };
        return { id, url: `https://checkout.stripe.test/${id}` };
      },
      retrieve: async (id) => { S.stripe.push(['checkout.sessions.retrieve', id]); const s = S.sessions[id]; if (!s) throw new Error('No such session'); return s; },
    } };
    this.paymentIntents = { create: async (p) => { S.stripe.push(['paymentIntents.create', p]); return { id: 'pi_1', client_secret: 'x' }; } };
    this.customers = { create: async () => ({ id: `cus_${++seq}` }), del: async () => ({}) };
    this.webhooks = { constructEvent: (buf) => JSON.parse(String(buf)) };
  }
}
mock.module(ROOT + 'node_modules/stripe/esm/stripe.esm.node.js', { defaultExport: FakeStripe });

const db = await import(ROOT + 'lib/db.js');
const { default: leaguesApi } = await import(ROOT + 'api/leagues.js');
const { default: bookingApi } = await import(ROOT + 'api/booking.js');
const { default: webhookApi } = await import(ROOT + 'api/webhook.js');
const { winnipegTodayISO } = await import(ROOT + 'lib/booking.js');
const L = globalThis.InvictusLeagues;

const today = winnipegTodayISO();
const addDays = (n, from = today) => { const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// A date inside the season that is definitely not in the same week as today, so the
// one-round-per-week rule is not tripped by accident.
const nextWeek = () => addDays(9, mondayOf(today));
const BAYS = [{ id: 'B1', name: 'Bay One' }, { id: 'B2', name: 'Bay Two' }];

function world(extra = {}) {
  seq = 0;
  Object.assign(S, {
    stripe: [], sessions: {}, fail: {}, missing0031: null, hideTeamRounds: false,
    tokens: { 'tok-cap': 'user-cap', 'tok-friend': 'user-friend', 'tok-other': 'user-other' },
    db: {
      customers: [
        { id: 'c-cap', name: 'Murad Cheway', phone: '+12049906530', email: 'murad@voltrisai.com', user_id: 'user-cap' },
        { id: 'c-friend', name: 'Sam Okafor', phone: '+12045550116', email: 'sam@example.com', user_id: 'user-friend' },
        { id: 'c-other', name: 'Lee Park', phone: '+12045550199', email: null, user_id: 'user-other' },
      ],
      settings: [{ id: 1, bays: BAYS, hours: { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] },
        rates: { weekdayOffPeak: 20, weekdayPeak: 20, weekendOffPeak: 25, weekendPeak: 25 }, min_mins: 60, max_party: 4, slot_step: 30,
        online_status_label: 'Booked', booking_window: { regularDays: 10, leagueDays: 60 } }],
      leagues: [
        { id: 'L-team', name: 'Winter Team League', description: 'Six weeks, play when you like.', is_active: true, join_online: true,
          season_start: addDays(-14), season_end: addDays(42), team_mode: true, scoring: 'points',
          fee_cents: 30000, team_size: 4, weekly_min_mins: 180, capacity: null, bay_ids: ['B1'], sort: 0 },
        { id: 'L-free', name: 'Free Friday', is_active: true, join_online: true, season_start: addDays(-7), season_end: addDays(28),
          team_mode: true, scoring: 'points', fee_cents: 0, team_size: 2, weekly_min_mins: 120, capacity: null, bay_ids: [], sort: 1 },
        { id: 'L-over', name: 'Summer League', is_active: true, join_online: true, season_start: addDays(-120), season_end: addDays(-1),
          team_mode: true, scoring: 'points', fee_cents: 0, team_size: 4, weekly_min_mins: 180, capacity: null, bay_ids: [], sort: 2 },
      ],
      league_teams: [], league_members: [], league_results: [], league_team_invites: [],
      bookings: [], schedule_overrides: [], staff: [], notifications: [],
      ...extra,
    },
  });
}

async function run(handler, { method = 'POST', query = {}, body = {}, headers = {}, dev } = {}) {
  let code = 200, out;
  const req = { method, query, body, headers: { host: 'localhost:4242', ...headers }, socket: {} };
  if (dev) req.devAccountPhone = dev;
  const res = { status(c) { code = c; return this; }, json(b) { out = b; return this; }, end() { return this; }, send(b) { out = b; return this; } };
  await handler(req, res);
  return { code, out };
}
const cap = { headers: { authorization: 'Bearer tok-cap' } };
const friend = { headers: { authorization: 'Bearer tok-friend' } };
const other = { headers: { authorization: 'Bearer tok-other' } };
const names = () => S.stripe.map((c) => c[0]);

// Buy a team for the captain and return its id, without going through Stripe.
async function ownTeam(leagueId = 'L-team', name = 'Aces', captain = 'c-cap') {
  const r = await db.createLeagueTeam({ leagueId, name, captainCustomerId: captain, paidCents: 30000, stripeSessionId: `cs_seed_${name}` });
  assert.ok(r.ok, JSON.stringify(r));
  return r.teamId;
}

// ---------------------------------------------------------------- buying a team

test('list: the leagues you can buy a team in, with the team count and your own team', async () => {
  world();
  const anon = await run(leaguesApi, { query: { action: 'list' } });
  assert.equal(anon.code, 200);
  assert.deepEqual(anon.out.leagues.map((l) => l.id), ['L-team', 'L-free'], 'the finished season is not offered');
  assert.deepEqual(anon.out.leagues[0], { id: 'L-team', name: 'Winter Team League', description: 'Six weeks, play when you like.',
    fee_cents: 30000, team_size: 4, weekly_min_mins: 180, season_start: addDays(-14), season_end: addDays(42), teamCount: 0, myTeamId: null });

  const teamId = await ownTeam();
  const mine = await run(leaguesApi, { query: { action: 'list' }, ...cap });
  assert.equal(mine.out.leagues[0].teamCount, 1);
  assert.equal(mine.out.leagues[0].myTeamId, teamId, 'signed in: the page can say "your team"');
  assert.equal((await run(leaguesApi, { query: { action: 'list' } })).out.leagues[0].myTeamId, null, 'signed out: nobody else’s team id');
});

test('buy-team, paid: Stripe Checkout for the TEAM price, and nothing written until it is paid', async () => {
  world();
  const r = await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'L-team', teamName: '  the   Aces ' }, ...cap });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.match(r.out.url, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(S.db.league_teams.length, 0, 'no team until the money arrives');

  const sent = S.stripe.find((c) => c[0] === 'checkout.sessions.create')[1];
  assert.equal(sent.line_items[0].price_data.unit_amount, 30000, 'one price for the whole team');
  assert.deepEqual(sent.metadata, { kind: 'league-team', leagueId: 'L-team', teamName: 'the Aces', captainCustomerId: 'c-cap' });
  assert.equal(sent.customer_email, 'murad@voltrisai.com');
  assert.equal(JSON.stringify(S.stripe).includes('payment_method_types'), false, 'dynamic payment methods, as everywhere else');

  // The success page settles it; so does the webhook. Either way there is exactly one team.
  const sessionId = Object.keys(S.sessions)[0];
  const done = await run(leaguesApi, { query: { action: 'confirm' }, body: { sessionId }, ...cap });
  assert.equal(done.code, 200, JSON.stringify(done.out));
  const team = S.db.league_teams[0];
  assert.equal(team.name, 'the Aces');
  assert.equal(team.captain_customer_id, 'c-cap');
  assert.equal(team.paid_cents, 30000);
  assert.ok(team.paid_at, 'paid_at stamped');
  assert.equal(team.stripe_session_id, sessionId);
  const member = S.db.league_members.find((m) => m.customer_id === 'c-cap');
  assert.equal(member.team_id, team.id);
  assert.equal(member.status, 'active');

  const again = await run(leaguesApi, { query: { action: 'confirm' }, body: { sessionId }, ...cap });
  assert.equal(again.code, 200);
  assert.equal(S.db.league_teams.length, 1, 'settling twice does not make a second team');
  assert.equal(S.db.league_members.length, 1);
});

test('buy-team, paid: a replayed Stripe webhook cannot create a second team', async () => {
  world();
  await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'L-team', teamName: 'Birdies' }, ...cap });
  const sessionId = Object.keys(S.sessions)[0];
  const event = { id: 'evt_1', type: 'checkout.session.completed', livemode: false,
    data: { object: { id: sessionId, metadata: { kind: 'league-team' } } } };
  const hook = (e) => run(webhookApi, { body: Buffer.from(JSON.stringify(e)), headers: { 'stripe-signature': 'sig' } });
  assert.equal((await hook(event)).code, 200);
  assert.equal(S.db.league_teams.length, 1);
  assert.equal((await hook({ ...event, id: 'evt_2' })).code, 200, 'a redelivery is acknowledged');
  assert.equal(S.db.league_teams.length, 1, 'still one team');
});

test('buy-team, free league: the team exists straight away, no Stripe at all', async () => {
  world();
  const r = await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'L-free', teamName: 'Divots' }, ...cap });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(r.out.free, true);
  assert.ok(r.out.teamId);
  assert.equal(S.stripe.length, 0, 'nothing to pay, nothing to charge');
  assert.equal(S.db.league_teams[0].paid_cents, 0);
  assert.equal(S.db.league_members[0].team_id, r.out.teamId);
});

test('buy-team: a name already used in that league is refused, in words, before Stripe', async () => {
  world();
  await ownTeam('L-team', 'Aces');
  const clash = await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'L-team', teamName: 'aces' }, ...friend });
  assert.equal(clash.code, 409);
  assert.match(clash.out.error, /already a team called “aces”/i);
  assert.ok(!/duplicate key|constraint/i.test(clash.out.error), 'never a raw database message');
  assert.equal(S.stripe.length, 0, 'refused before Checkout — nobody pays for a name they cannot have');

  // The same name in a different league is fine.
  const ok = await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'L-free', teamName: 'Aces' }, ...friend });
  assert.equal(ok.code, 200, JSON.stringify(ok.out));
});

test('buy-team: signed out, no team name, dead season, and already on a team', async () => {
  world();
  assert.equal((await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'L-team', teamName: 'X' } })).code, 401);
  assert.equal((await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'L-team', teamName: '  ' }, ...cap })).code, 400);
  assert.equal((await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'L-over', teamName: 'X' }, ...cap })).code, 400);
  assert.equal((await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'nope', teamName: 'X' }, ...cap })).code, 404);

  await ownTeam('L-team', 'Aces');
  const twice = await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'L-team', teamName: 'Other' }, ...cap });
  assert.equal(twice.code, 409);
  assert.match(twice.out.error, /already on Aces/);
});

// ---------------------------------------------------------------- invites

test('invite: the captain gets a link, re-inviting the same number returns the same one', async () => {
  world();
  const teamId = await ownTeam();
  const r = await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '(204) 555-0116', name: 'Sam' }, ...cap });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.match(r.out.link, /^http:\/\/localhost:4242\/leagues\?invite=[0-9a-f-]{36}$/);
  assert.equal(S.db.league_team_invites.length, 1);
  const inv = S.db.league_team_invites[0];
  assert.equal(inv.phone, '12045550116', 'stored normalised, however it was typed');
  assert.equal(inv.invited_by, 'c-cap');

  const again = await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '204 555 0116' }, ...cap });
  assert.equal(again.out.link, r.out.link, 'the same live invite, not a second one');
  assert.equal(again.out.resent, true);
  assert.equal(S.db.league_team_invites.length, 1);
});

test('invite: only the captain (or staff) may add to a team', async () => {
  world();
  const teamId = await ownTeam();
  const stranger = await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '2045550116' }, ...other });
  assert.equal(stranger.code, 403);
  assert.match(stranger.out.error, /captain/i);
  assert.equal((await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '2045550116' } })).code, 401);
  assert.equal(S.db.league_team_invites.length, 0);
  assert.equal((await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: 'nope' }, ...cap })).code, 400);
});

test('invite: somebody already on the team is told so instead of being sent a dead link', async () => {
  world();
  const teamId = await ownTeam();
  const r = await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '2049906530' }, ...cap });
  assert.equal(r.code, 200);
  assert.equal(r.out.alreadyOnTeam, true);
  assert.equal(r.out.link, null);
  assert.equal(S.db.league_team_invites.length, 0);
});

test('invite-info: public, and it says only what the person who tapped the link needs', async () => {
  world();
  const teamId = await ownTeam();
  await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '2045550116' }, ...cap });
  const token = S.db.league_team_invites[0].token;

  const info = await run(leaguesApi, { query: { action: 'invite-info' }, body: { token } });
  assert.equal(info.code, 200);
  assert.deepEqual([info.out.leagueName, info.out.teamName, info.out.invitedBy, info.out.teamFull, info.out.claimed],
    ['Winter Team League', 'Aces', 'Murad Cheway', false, true === false]);
  assert.equal(JSON.stringify(info.out).includes('2045550116'), false, 'no phone numbers');
  assert.equal(JSON.stringify(info.out).includes('12045550116'), false);

  assert.equal((await run(leaguesApi, { query: { action: 'invite-info' }, body: { token: 'not-a-token' } })).code, 400);
  assert.equal((await run(leaguesApi, { query: { action: 'invite-info' }, body: { token: '11111111-2222-3333-4444-555555555555' } })).code, 404);
});

test('invite-claim: single use — the friend joins, a second person cannot use the same link', async () => {
  world();
  const teamId = await ownTeam();
  await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '2045550116' }, ...cap });
  const token = S.db.league_team_invites[0].token;

  assert.equal((await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token } })).code, 401, 'signed out first');

  const joined = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token }, ...friend });
  assert.equal(joined.code, 200, JSON.stringify(joined.out));
  assert.deepEqual([joined.out.teamId, joined.out.leagueId], [teamId, 'L-team']);
  const inv = S.db.league_team_invites[0];
  assert.ok(inv.claimed_at && inv.claimed_customer_id === 'c-friend', 'the invite is spent');
  assert.equal(S.db.league_members.filter((m) => m.team_id === teamId).length, 2);

  // The friend tapping their own link twice is on the team once, and is not shown an error.
  const twice = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token }, ...friend });
  assert.equal(twice.code, 200);
  assert.equal(twice.out.already, true);
  assert.equal(S.db.league_members.filter((m) => m.team_id === teamId).length, 2, 'not on the roster twice');

  // Somebody else with the same link gets nothing.
  const thief = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token }, ...other });
  assert.equal(thief.code, 409);
  assert.match(thief.out.error, /already been used/);
  assert.equal(S.db.league_members.filter((m) => m.customer_id === 'c-other').length, 0);

  assert.equal((await run(leaguesApi, { query: { action: 'invite-info' }, body: { token } })).out.claimed, true);
});

test('invite-claim: a revoked invite, and one for a team that is already full', async () => {
  world();
  const teamId = await ownTeam('L-free', 'Pair');            // L-free holds two players
  await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '2045550116' }, ...cap });
  await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '2045550199' }, ...cap });
  const [first, second] = S.db.league_team_invites;

  assert.equal((await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token: first.token }, ...friend })).code, 200);
  const full = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token: second.token }, ...other });
  assert.equal(full.code, 409);
  assert.match(full.out.error, /Pair is full — it holds 2 players/);
  assert.equal(S.db.league_members.filter((m) => m.team_id === teamId).length, 2, 'the third player is not on it');
  assert.equal((await run(leaguesApi, { query: { action: 'invite-info' }, body: { token: second.token } })).out.teamFull, true);

  // Revoked: the link stops working, and says why.
  second.revoked_at = new Date().toISOString();
  const gone = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token: second.token }, ...other });
  assert.equal(gone.code, 410);
  assert.match(gone.out.error, /cancelled/);
});

// ---------------------------------------------------------------- my teams

test('my-teams: the team, the roster by public name, the season week by week, the standings', async () => {
  world();
  const teamId = await ownTeam();
  const rivalId = (await db.createLeagueTeam({ leagueId: 'L-team', name: 'Birdies', captainCustomerId: 'c-other' })).teamId;
  await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '2045550116' }, ...cap });
  await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token: S.db.league_team_invites[0].token }, ...friend });
  S.db.league_results = [
    { league_id: 'L-team', team_id: teamId, customer_id: null, score: 8, played_on: addDays(-7) },
    { league_id: 'L-team', team_id: rivalId, customer_id: null, score: 11, played_on: addDays(-7) },
  ];
  // Last week's round, already played.
  S.db.bookings.push({ id: 'bk-last', league_team_id: teamId, booking_date: addDays(-7), league_week: mondayOf(addDays(-7)),
    bay_id: 'B1', start_min: 600, end_min: 780, status: 'confirmed' });

  const r = await run(leaguesApi, { query: { action: 'my-teams' }, ...cap });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(r.out.teams.length, 1);
  const t = r.out.teams[0];
  assert.deepEqual([t.team.id, t.team.name, t.team.paid_cents, t.team.captain], [teamId, 'Aces', 30000, true]);
  assert.ok(t.team.paid_at);
  assert.deepEqual(t.roster, [
    { name: 'Murad C.', isCaptain: true, isMe: true },
    { name: 'Sam O.', isCaptain: false, isMe: false },
  ]);
  assert.equal(t.weeks.length, L.weeks(S.db.leagues[0]).length);
  assert.equal(t.weeks.find((w) => w.start === mondayOf(addDays(-7))).round.id, 'bk-last');
  assert.equal(t.currentWeek.start, mondayOf(today));
  assert.equal(typeof t.missedWeeks, 'number');
  assert.deepEqual(t.standings.map((x) => [x.name, x.total, x.you]), [['Birdies', 11, false], ['Aces', 8, true]]);
  assert.deepEqual(t.bays, { B1: 'Bay One', B2: 'Bay Two' });
  assert.equal(JSON.stringify(t).includes('2045550116'), false, 'no phone numbers anywhere');
  assert.equal(JSON.stringify(t).includes('Okafor'), false, 'no surnames either');

  assert.equal((await run(leaguesApi, { query: { action: 'my-teams' } })).code, 401);
  assert.deepEqual((await run(leaguesApi, { query: { action: 'my-teams' }, ...other })).out.teams.map((x) => x.team.name), ['Birdies']);
});

// ---------------------------------------------------------------- the weekly round

const round = (over = {}) => ({ teamId: over.teamId, dateISO: over.dateISO || nextWeek(), bayId: over.bayId || 'B1',
  startMin: over.startMin ?? 600, endMin: over.endMin ?? 780 });

test('league-round: any member books the week’s round, free, in any bay', async () => {
  world();
  const teamId = await ownTeam();
  await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '2045550116' }, ...cap });
  await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token: S.db.league_team_invites[0].token }, ...friend });

  const r = await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId }), ...friend });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  const b = S.db.bookings.find((x) => x.id === r.out.bookingId);
  assert.equal(b.league_team_id, teamId);
  assert.equal(b.amount_cents, 0, 'the team paid for the season — the round is free');
  assert.equal(b.status, 'confirmed');
  assert.equal(b.customer_name, 'Sam Okafor', 'booked by whoever got to it');
  assert.equal(b.league_week, mondayOf(nextWeek()));
  assert.equal(r.out.round.bay, 'Bay One');

  // And the whole team sees it.
  const seen = await run(leaguesApi, { query: { action: 'my-teams' }, ...cap });
  assert.equal(seen.out.teams[0].weeks.find((w) => w.start === mondayOf(nextWeek())).round.id, b.id);
});

test('league-round: somebody who is not on the team cannot book for it', async () => {
  world();
  const teamId = await ownTeam();
  const r = await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId }), ...other });
  assert.equal(r.code, 403);
  assert.match(r.out.error, /not on that team/);
  assert.equal((await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId }) })).code, 401, 'signed out');
  // A team id is not a password: knowing it changes nothing.
  assert.equal(S.db.bookings.length, 0);
});

test('league-round: a second round in the same week is refused, and names the one they have', async () => {
  world();
  const teamId = await ownTeam();
  const first = await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId }), ...cap });
  assert.equal(first.code, 200, JSON.stringify(first.out));

  const second = await run(bookingApi, { query: { action: 'league-round' },
    body: round({ teamId, dateISO: addDays(2, nextWeek()), bayId: 'B2' }), ...cap });
  assert.equal(second.code, 409);
  assert.equal(second.out.code, 'round_booked');
  assert.match(second.out.error, /already booked its round for this week/);
  assert.equal(second.out.existing.id, first.out.bookingId);
  assert.equal(second.out.existing.bay, 'Bay One');
  assert.equal(S.db.bookings.length, 1);

  // The week after is fine.
  const later = await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId, dateISO: addDays(7, nextWeek()) }), ...cap });
  assert.equal(later.code, 200, JSON.stringify(later.out));

  // Cancelling frees the week again (the index only counts live rounds).
  S.db.bookings[0].status = 'cancelled';
  const again = await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId, bayId: 'B2' }), ...cap });
  assert.equal(again.code, 200, JSON.stringify(again.out));
});

test('league-round: when two members book at once, the database index is what refuses the second', async () => {
  world();
  const teamId = await ownTeam();
  assert.equal((await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId }), ...cap })).code, 200);
  S.hideTeamRounds = true;    // the pre-check cannot see the round — as if it landed a moment ago
  const racer = await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId, bayId: 'B2' }), ...cap });
  S.hideTeamRounds = false;
  assert.equal(racer.code, 409);
  assert.equal(racer.out.code, 'round_booked');
  assert.match(racer.out.error, /already booked its round for this week/);
  assert.ok(!/duplicate key|constraint/i.test(racer.out.error), 'never a raw database message');
  assert.equal(S.db.bookings.length, 1);
});

test('league-round: outside the season', async () => {
  world();
  const teamId = await ownTeam();
  const early = await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId, dateISO: addDays(-20) }), ...cap });
  assert.equal(early.code, 400);
  assert.equal(early.out.code, 'outside_season');
  assert.match(early.out.error, /Winter Team League runs/);
  const late = await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId, dateISO: addDays(43) }), ...cap });
  assert.equal(late.code, 400);
  assert.equal(late.out.code, 'outside_season');
  assert.equal(S.db.bookings.length, 0);
});

test('league-round: a slot somebody else already has', async () => {
  world();
  const teamId = await ownTeam();
  S.db.bookings.push({ id: 'bk-taken', bay_id: 'B1', booking_date: nextWeek(), start_min: 660, end_min: 720, status: 'confirmed' });
  const clash = await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId }), ...cap });
  assert.equal(clash.code, 409);
  assert.equal(clash.out.code, 'slot_taken');
  assert.equal(S.db.bookings.length, 1);

  const elsewhere = await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId, bayId: 'B2' }), ...cap });
  assert.equal(elsewhere.code, 200, JSON.stringify(elsewhere.out));
});

test('league-round: past the booking window, and the nonsense a form can send', async () => {
  world();
  S.db.leagues[0].season_end = addDays(400);
  const teamId = await ownTeam();
  const far = await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId, dateISO: addDays(90) }), ...cap });
  assert.equal(far.code, 400);
  assert.equal(far.out.code, 'booking_window');
  assert.match(far.out.error, /League players can book up to 60 days ahead/);

  // 59 days ahead is inside the league window (a regular booking would stop at 10).
  assert.equal((await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId, dateISO: addDays(59) }), ...cap })).code, 200);

  for (const bad of [{ dateISO: 'tomorrow' }, { dateISO: '2026-13' }, { bayId: '' }, { startMin: 600, endMin: 600 }, { startMin: 'x' }]) {
    const r = await run(bookingApi, { query: { action: 'league-round' }, body: { ...round({ teamId }), ...bad }, ...cap });
    assert.equal(r.code, 400, JSON.stringify(bad));
  }
  assert.equal((await run(bookingApi, { query: { action: 'league-round' }, body: { ...round({ teamId }), teamId: null }, ...cap })).code, 400);
});

test('league-round: the localhost dev account books like anybody else', async () => {
  world();
  const teamId = await ownTeam();
  const r = await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId }), dev: '2049906530' });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(S.db.bookings[0].league_team_id, teamId);
  assert.equal((await run(leaguesApi, { query: { action: 'my-teams' }, dev: '2049906530' })).out.teams.length, 1);
});

// ---------------------------------------------------------------- migration 0031 not applied yet

test('before migration 0031: a sentence telling the operator what to run, never a stack trace', async () => {
  world();
  S.missing0031 = ['team_size', 'captain_customer_id', 'league_team_id'];

  // The list still works — the columns 0031 adds have honest stand-ins until it is run.
  const list = await run(leaguesApi, { query: { action: 'list' } });
  assert.equal(list.code, 200, JSON.stringify(list.out));
  assert.equal(list.out.leagues[0].weekly_min_mins, 180);

  const invites = await run(leaguesApi, { query: { action: 'invite' }, body: { teamId: 'T-x', phone: '2045550116' }, ...cap });
  assert.equal(invites.code, 404, 'no such team, because the team columns are not there yet');

  const claim = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token: '11111111-2222-3333-4444-555555555555' }, ...cap });
  assert.ok([404, 503].includes(claim.code));
  assert.match(claim.out.error, /migration 0031|invite link isn’t valid/);

  S.missing0031 = null;
  const teamId = await ownTeam();
  S.missing0031 = ['league_team_id'];
  const r = await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId }), ...cap });
  assert.equal(r.code, 503);
  assert.match(r.out.error, /0031_league_teams\.sql/);
  assert.equal(S.db.bookings.length, 0);
});
