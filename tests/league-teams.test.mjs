// Leagues sold by the team (migration 0031): buying a team, inviting friends by phone number, and
// the weekly round any member can book — paid for at checkout like any session, less the league
// discount, and tagged as the team's round for that week.
//
// The real lib/db.js, lib/booking.js, api/leagues.js, api/booking.js, api/checkout.js and api/webhook.js run end to
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
// What public.league_week_of() does (migration 0040), written out separately from the page's own maths.
const startOfWeek = (iso, ws) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - ws + 7) % 7)); return d.toISOString().slice(0, 10); };
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
  // 0019: one outbox row per logical message — the dedupe key is what stops a second text.
  notifications: (row, rows) => (row.dedupe_key && rows.some((r) => r.dedupe_key === row.dedupe_key) ? 'notifications_dedupe_key' : null),
  // 0036: one payment row per Checkout Session.
  league_seat_payments: (row, rows) => (row.stripe_session_id && rows.some((r) => r.stripe_session_id === row.stripe_session_id) ? 'league_seat_payments_session' : null),
};

// Migration 0041's trigger: a team has at most three active substitutes. Checked on every insert
// and update of league_members, exactly where the database checks it.
const subsLimit = (row, rows) => (row.role === 'sub' && row.status === 'active' && row.team_id
  && rows.filter((r) => r !== row && r.id !== row.id && r.team_id === row.team_id && r.role === 'sub' && r.status === 'active').length >= 3
  ? { code: '23514', message: 'league_subs_limit: a team can have at most 3 substitutes' } : null);

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
        // league_week is never supplied: the database works it out from the date and — since
        // migration 0040 — the day the team's league says its week starts (Monday by default).
        if (table === 'bookings' && row.booking_date) {
          const team = (S.db.league_teams || []).find((t) => t.id === row.league_team_id);
          const lg = team && (S.db.leagues || []).find((l) => l.id === team.league_id);
          // 0042: a make-up round says which week it counts for; anything else is the week it is played in.
          row.league_week = startOfWeek((row.league_team_id && row.league_for_week) || row.booking_date, lg && lg.week_start != null ? lg.week_start : 1);
        }
        return row;
      });
      for (const row of list) {
        const clash = UNIQUE[table] && UNIQUE[table](row, rows);
        if (clash) return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${clash}"` } };
        if (table === 'league_members' && subsLimit(row, rows)) return { data: null, error: subsLimit(row, rows) };
        rows.push(row);
      }
      return { data: Array.isArray(st.payload) ? list : list[0], error: null };
    }
    if (st.op === 'update') {
      const hit = rows.filter(match);
      if (table === 'league_members') for (const r of hit) { const no = subsLimit({ ...r, ...st.payload }, rows); if (no) return { data: null, error: no }; }
      hit.forEach((r) => Object.assign(r, st.payload)); return { data: hit, error: null };
    }
    if (st.op === 'delete') { S.db[table] = rows.filter((r) => !match(r)); return { data: null, error: null }; }
    // Used by one test to make the "already played this week" pre-check miss, so the database's
    // own unique index is the thing that catches it.
    if (S.hideTeamRounds && table === 'bookings' && st.f.some(([, c]) => c === 'league_team_id')) return { data: [], error: null };
    // PostgREST's embed — select('league_id, leagues(…)') — which is how lib/db.js decides a
    // customer is a current league player (and so gets the longer booking window).
    if (table === 'league_members' && st.cols.includes('leagues(')) {
      return { data: rows.filter(match).map((r) => ({ ...r, leagues: (S.db.leagues || []).find((l) => l.id === r.league_id) || null })), error: null };
    }
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
    // Storage: one private bucket of scorecard photos. It does not exist until it is created.
    storage: {
      createBucket: async (name, opts) => { S.buckets[name] = { ...opts, files: {} }; return { data: { name }, error: null }; },
      from: (name) => ({
        upload: async (path, bytes, opts) => { const bk = S.buckets[name]; if (!bk) return { data: null, error: { message: 'Bucket not found' } };
          bk.files[path] = { bytes, type: opts.contentType }; return { data: { path }, error: null }; },
        createSignedUrl: async (path, secs) => ({ data: { signedUrl: `https://storage.test/${name}/${path}?exp=${secs}` }, error: null }),
        remove: async (paths) => { const bk = S.buckets[name]; (paths || []).forEach((x) => { if (bk) delete bk.files[x]; }); return { data: [], error: null }; },
      }),
    },
    auth: { getUser: async (tok) => (S.tokens[tok] ? { data: { user: { id: S.tokens[tok] } } } : { error: { message: 'bad jwt' }, data: {} }) } }),
} });

// Fake Stripe: records every call and hands back shaped objects.
class FakeStripe {
  constructor() {
    this.checkout = { sessions: {
      create: async (p) => {
        S.stripe.push(['checkout.sessions.create', p]);
        const id = `cs_${++seq}`;
        S.sessions[id] = { id, payment_status: 'paid', payment_intent: `pi_${id}`,
          amount_total: p.line_items[0].price_data.unit_amount * (p.line_items[0].quantity || 1), metadata: p.metadata };
        return { id, url: `https://checkout.stripe.test/${id}` };
      },
      retrieve: async (id) => { S.stripe.push(['checkout.sessions.retrieve', id]); const s = S.sessions[id]; if (!s) throw new Error('No such session'); return s; },
    } };
    // A hold (capture_method manual) comes back authorised, anything else paid, and a SetupIntent
    // with its card saved — what Stripe reports once the customer has finished the payment form.
    const intent = (kind, p) => {
      S.stripe.push([`${kind === 'pi' ? 'paymentIntents' : 'setupIntents'}.create`, p]);
      const id = `${kind}_${++seq}`;
      return (S.intents[id] = { id, client_secret: `${id}_secret`, amount: p.amount, metadata: p.metadata, customer: p.customer || null,
        status: kind === 'pi' && p.capture_method === 'manual' ? 'requires_capture' : 'succeeded',
        payment_method: kind === 'seti' ? 'pm_1' : null });
    };
    const read = async (id) => { if (!S.intents[id]) throw new Error('No such intent'); return S.intents[id]; };
    this.paymentIntents = { create: async (p) => intent('pi', p), retrieve: read };
    this.setupIntents = { create: async (p) => intent('seti', p), retrieve: read };
    this.paymentMethods = { retrieve: async () => ({ billing_details: {} }), detach: async () => ({}) };
    this.customers = { create: async () => ({ id: `cus_${++seq}` }), del: async () => ({}) };
    this.refunds = { create: async (p, o) => { S.stripe.push(['refunds.create', p, o]); return { id: `re_${++seq}`, status: 'succeeded' }; } };
    this.webhooks = { constructEvent: (buf) => JSON.parse(String(buf)) };
  }
}
mock.module(ROOT + 'node_modules/stripe/esm/stripe.esm.node.js', { defaultExport: FakeStripe });

const db = await import(ROOT + 'lib/db.js');
const { default: leaguesApi } = await import(ROOT + 'api/leagues.js');
const { default: bookingApi } = await import(ROOT + 'api/booking.js');
const { default: checkoutApi } = await import(ROOT + 'api/checkout.js');
const notify = await import(ROOT + 'lib/notify.js');
const { default: webhookApi } = await import(ROOT + 'api/webhook.js');
const { default: seriesApi } = await import(ROOT + 'api/booking-series.js');
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
    stripe: [], sessions: {}, intents: {}, buckets: {}, fail: {}, missing0031: null, hideTeamRounds: false,
    tokens: { 'tok-cap': 'user-cap', 'tok-friend': 'user-friend', 'tok-other': 'user-other', 'tok-admin': 'u-admin', 'tok-emp': 'u-emp' },
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
      league_teams: [], league_members: [], league_results: [], league_team_invites: [], league_seat_payments: [],
      bookings: [], schedule_overrides: [], notifications: [],
      // An admin and an employee WITHOUT the Money permission, for the staff "Mark collected" action.
      staff: [
        { user_id: 'u-admin', email: 'admin@invictus.test', role: 'admin', is_active: true },
        { user_id: 'u-emp', email: 'emp@invictus.test', role: 'employee', is_active: true },
      ],
      capabilities: ['booking.write', 'money.write'].map((key, sort) => ({ key, sort })),
      role_permissions: [{ role: 'employee', capability: 'booking.write', allowed: true }, { role: 'employee', capability: 'money.write', allowed: false }],
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
    fee_cents: 30000, team_size: 4, team_min: null, weekly_min_mins: 180, season_start: addDays(-14), season_end: addDays(42), teamCount: 0, myTeamId: null, soloCents: 7500, hasInfo: false });

  const teamId = await ownTeam();
  const mine = await run(leaguesApi, { query: { action: 'list' }, ...cap });
  assert.equal(mine.out.leagues[0].teamCount, 1);
  assert.equal(mine.out.leagues[0].myTeamId, teamId, 'signed in: the page can say "your team"');
  assert.equal((await run(leaguesApi, { query: { action: 'list' } })).out.leagues[0].myTeamId, null, 'signed out: nobody else’s team id');
});

test('buy-team, paid: Stripe Checkout for the captain\'s SHARE of the team price, nothing written until paid', async () => {
  world();
  const r = await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'L-team', teamName: '  the   Aces ' }, ...cap });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.match(r.out.url, /^https:\/\/checkout\.stripe\.test\//);
  assert.equal(S.db.league_teams.length, 0, 'no team until the money arrives');

  const sent = S.stripe.find((c) => c[0] === 'checkout.sessions.create')[1];
  // $300 team, teams of exactly 4 (no minimum set) → the captain pays one $75 share.
  assert.equal(sent.line_items[0].price_data.unit_amount, 7500, 'the captain pays their own share, not the whole team');
  assert.deepEqual(sent.metadata, { kind: 'league-team', leagueId: 'L-team', teamName: 'the Aces', captainCustomerId: 'c-cap',
    seats: '4', shareCents: '7500' });
  assert.equal(sent.customer_email, 'murad@voltrisai.com');
  assert.equal(JSON.stringify(S.stripe).includes('payment_method_types'), false, 'dynamic payment methods, as everywhere else');

  // The success page settles it; so does the webhook. Either way there is exactly one team.
  const sessionId = Object.keys(S.sessions)[0];
  const done = await run(leaguesApi, { query: { action: 'confirm' }, body: { sessionId }, ...cap });
  assert.equal(done.code, 200, JSON.stringify(done.out));
  const team = S.db.league_teams[0];
  assert.equal(team.name, 'the Aces');
  assert.equal(team.captain_customer_id, 'c-cap');
  assert.equal(team.paid_cents, 7500);
  assert.equal(team.seats, 4);
  assert.equal(team.share_cents, 7500);
  assert.ok(team.paid_at, 'paid_at stamped');
  assert.equal(S.db.league_seat_payments.length, 1, 'the captain\'s own seat is the first one paid');
  assert.deepEqual([S.db.league_seat_payments[0].seats, S.db.league_seat_payments[0].for_customer_id], [1, 'c-cap']);
  assert.equal(team.stripe_session_id, sessionId);
  const member = S.db.league_members.find((m) => m.customer_id === 'c-cap');
  assert.equal(member.team_id, team.id);
  assert.equal(member.status, 'active');

  const again = await run(leaguesApi, { query: { action: 'confirm' }, body: { sessionId }, ...cap });
  assert.equal(again.code, 200);
  assert.equal(S.db.league_teams.length, 1, 'settling twice does not make a second team');
  assert.equal(S.db.league_members.length, 1);
  assert.equal(S.db.league_seat_payments.length, 1, 'nor a second seat');
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

test('invite-claim: a player already on another team is refused, not charged again and not moved', async () => {
  world();
  const teamId = await ownTeam();                                       // the captain's Aces
  const theirs = await db.createLeagueTeam({ leagueId: 'L-team', name: 'Birdies', captainCustomerId: 'c-friend', paidCents: 30000, stripeSessionId: 'cs_birdies' });
  await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '2045550116' }, ...cap });
  const token = S.db.league_team_invites.at(-1).token;
  const sessionsBefore = S.stripe.filter(([c]) => c === 'checkout.sessions.create').length;

  const r = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token }, ...friend });
  assert.equal(r.code, 409);
  assert.match(r.out.error, /You already play for Birdies/);
  assert.equal(S.stripe.filter(([c]) => c === 'checkout.sessions.create').length, sessionsBefore, 'not sent to pay a second time');
  const row = S.db.league_members.find((m) => m.customer_id === 'c-friend');
  assert.equal(row.team_id, theirs.teamId, 'still on their own team');
  assert.ok(!S.db.league_team_invites.at(-1).claimed_at, 'the invite is not used up');
});

test('invite-claim: a solo player who already paid takes the seat with that payment', async () => {
  world();
  // Two seats bought seat by seat; the captain has paid one, so the second costs a share to join.
  const made = await db.createLeagueTeam({ leagueId: 'L-team', name: 'Aces', captainCustomerId: 'c-cap', paidCents: 7500, stripeSessionId: 'cs_seed', seats: 2, shareCents: 7500 });
  await soloSignUp(other);
  const paidSolo = S.db.league_members.find((m) => m.customer_id === 'c-other');
  await run(leaguesApi, { query: { action: 'invite' }, body: { teamId: made.teamId, phone: '2045550199' }, ...cap });
  const token = S.db.league_team_invites.at(-1).token;
  const sessionsBefore = S.stripe.filter(([c]) => c === 'checkout.sessions.create').length;

  const r = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token }, ...other });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.ok(!r.out.payRequired, 'no second payment');
  assert.equal(S.stripe.filter(([c]) => c === 'checkout.sessions.create').length, sessionsBefore);
  const rows = S.db.league_members.filter((m) => m.customer_id === 'c-other');
  assert.equal(rows.length, 1, 'one roster row, the solo one, now on the team');
  assert.equal(rows[0].team_id, made.teamId);
  assert.equal(rows[0].paid_cents, paidSolo.paid_cents, 'what they paid is still on record');
  assert.ok(S.db.league_team_invites.at(-1).claimed_at, 'the invite is spent');
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
// A league round is an ordinary paid booking made at checkout with the team named on it. The team
// tag is what makes it the week's round; the league discount is what the team gets for it.

const round = (over = {}) => ({ teamId: over.teamId, dateISO: over.dateISO || nextWeek(), bayId: over.bayId || 'B1',
  startMin: over.startMin ?? 600, endMin: over.endMin ?? 780 });
const quote = (over, who = {}) => run(checkoutApi, { query: { action: 'create-payment-intent' }, body: round(over), ...who });
const intentsMade = () => S.stripe.filter(([call]) => call === 'paymentIntents.create' || call === 'setupIntents.create');
// Whatever the card ended up as for this booking: held, saved for later, or charged.
const moneyOn = (b) => b.authorized_cents || b.deferred_cents || b.amount_cents;

// The whole checkout: the quote (which creates the payment), then the confirm the page sends once
// Stripe says the customer has finished. A refused quote comes straight back.
async function payRound(over, who = {}, name = 'Murad Cheway') {
  const q = await quote(over, who);
  if (q.code !== 200) return q;
  const id = Object.keys(S.intents).at(-1);
  const done = await run(checkoutApi, { query: { action: 'confirm-booking' }, body: { paymentIntentId: id, name, phone: '2045550100' } });
  return { code: done.code, out: done.out, quote: q.out, booking: S.db.bookings.find((x) => x.id === (done.out && done.out.bookingId)) };
}

// These tests are about ONE week, so the season starts in it: there is no earlier week to make up.
const seasonStartsAt = (iso, ws = 1) => { S.db.leagues[0].season_start = startOfWeek(iso, ws); };

test('league round: any member books it at checkout, pays the bay less $5 an hour, and it counts for the week', async () => {
  world();
  seasonStartsAt(nextWeek());
  const teamId = await ownTeam();
  await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '2045550116' }, ...cap });
  await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token: S.db.league_team_invites[0].token }, ...friend });

  const r = await payRound({ teamId }, friend, 'Sam Okafor');
  assert.equal(r.code, 200, JSON.stringify(r.out));
  // Three hours on a weekday at $20: $60, less $5 an hour = $45, plus 12% tax = $50.40.
  assert.equal(r.quote.fullAmount, 6000);
  assert.equal(r.quote.leagueDiscountCents, 1500);
  assert.equal(r.quote.subtotalCents, 4500, 'the discount comes off before tax');
  assert.equal(r.quote.totalCents, 5040);
  assert.equal(r.quote.amount, 5040);
  assert.deepEqual(r.quote.leagueRound, { teamId, teamName: 'Aces', leagueName: 'Winter Team League',
    week: { start: mondayOf(nextWeek()), end: addDays(6, mondayOf(nextWeek())), number: 1 }, makeup: false });
  assert.equal(intentsMade()[0][1].metadata.leagueForWeek, '', 'not a make-up: it counts for the week it is played in');
  assert.equal(intentsMade()[0][1].metadata.leagueTeamId, teamId);

  const b = r.booking;
  assert.equal(b.league_team_id, teamId);
  assert.equal(moneyOn(b), 5040, 'the team pays for its bay time — a league round is not free');
  assert.equal(b.status, 'confirmed');
  assert.equal(b.customer_name, 'Sam Okafor', 'booked by whoever got to it');
  assert.equal(b.league_week, mondayOf(nextWeek()));
  assert.deepEqual(r.out.leagueRound, { counted: true });

  // And the whole team sees it.
  const seen = await run(leaguesApi, { query: { action: 'my-teams' }, ...cap });
  assert.equal(seen.out.teams[0].weeks.find((w) => w.start === mondayOf(nextWeek())).round.id, b.id);
});

test('league round: the discount is the manager’s setting, and an ordinary booking never gets it', async () => {
  world();
  const teamId = await ownTeam();
  S.db.settings[0].booking_window = { regularDays: 10, leagueDays: 60, leagueRoundOffPerHourCents: 1000 };
  assert.equal((await quote({ teamId }, cap)).out.leagueDiscountCents, 3000, '$10 an hour for three hours');
  S.db.settings[0].booking_window.leagueRoundOffPerHourCents = 0;
  const none = await quote({ teamId }, cap);
  assert.equal(none.out.leagueDiscountCents, 0);
  assert.equal(none.out.subtotalCents, 6000);

  // The same member booking the same slot WITHOUT naming the team: full price, no tag.
  S.db.settings[0].booking_window.leagueRoundOffPerHourCents = 500;
  const plain = await payRound({}, cap);
  assert.equal(plain.code, 200, JSON.stringify(plain.out));
  assert.equal(plain.quote.leagueDiscountCents, 0);
  assert.equal(plain.quote.subtotalCents, 6000);
  assert.equal(plain.quote.leagueRound, null);
  assert.equal(plain.booking.league_team_id ?? null, null);
  assert.equal(plain.out.leagueRound, null);
});

test('league round: somebody who is not on the team cannot book for it', async () => {
  world();
  const teamId = await ownTeam();
  const r = await quote({ teamId }, other);
  assert.equal(r.code, 403);
  assert.equal(r.out.code, 'not_on_team');
  assert.match(r.out.error, /not on that team/);
  const out = await quote({ teamId });
  assert.equal(out.code, 401, 'signed out');
  assert.equal(out.out.code, 'sign_in');
  assert.equal((await quote({ teamId: 'no-such-team' }, cap)).code, 404);
  // A team id is not a password: knowing it changes nothing, and Stripe is never asked for a cent.
  assert.equal(intentsMade().length, 0);
  assert.equal(S.db.bookings.length, 0);
});

test('league round: a second round in the same week is refused before any payment, and names the one they have', async () => {
  world();
  seasonStartsAt(nextWeek());
  const teamId = await ownTeam();
  const first = await payRound({ teamId }, cap);
  assert.equal(first.code, 200, JSON.stringify(first.out));

  const second = await quote({ teamId, dateISO: addDays(2, nextWeek()), bayId: 'B2' }, cap);
  assert.equal(second.code, 409);
  assert.equal(second.out.code, 'round_booked');
  assert.match(second.out.error, /already booked its league round for this week/);
  assert.match(second.out.error, /ordinary session/);
  assert.equal(second.out.existing.id, first.booking.id);
  assert.equal(second.out.existing.bay, 'Bay One');
  assert.equal(intentsMade().length, 1, 'nothing was held or charged for the refused round');
  assert.equal(S.db.bookings.length, 1);

  // The week after is fine.
  const later = await payRound({ teamId, dateISO: addDays(7, nextWeek()) }, cap);
  assert.equal(later.code, 200, JSON.stringify(later.out));
  assert.deepEqual(later.out.leagueRound, { counted: true });

  // Cancelling frees the week again (the index only counts live rounds).
  S.db.bookings[0].status = 'cancelled';
  const again = await payRound({ teamId, bayId: 'B2' }, cap);
  assert.equal(again.code, 200, JSON.stringify(again.out));
  assert.deepEqual(again.out.leagueRound, { counted: true });
});

test('league round: two members paying at once — the second keeps the booking, as an ordinary session', async () => {
  world();
  const teamId = await ownTeam();
  assert.equal((await payRound({ teamId }, cap)).code, 200);
  S.hideTeamRounds = true;    // the pre-check cannot see the round — as if it landed a moment ago
  const q = await quote({ teamId, bayId: 'B2' }, cap);
  S.hideTeamRounds = false;
  assert.equal(q.code, 200, JSON.stringify(q.out));
  const racer = await run(checkoutApi, { query: { action: 'confirm-booking' },
    body: { paymentIntentId: Object.keys(S.intents).at(-1), name: 'Murad Cheway', phone: '2045550100' } });
  // They have paid, so they are never left without the slot. It just is not the week's round.
  assert.equal(racer.code, 200, JSON.stringify(racer.out));
  assert.deepEqual(racer.out.leagueRound, { counted: false });
  assert.equal(S.db.bookings.length, 2);
  const kept = S.db.bookings.find((x) => x.id === racer.out.bookingId);
  assert.equal(kept.league_team_id ?? null, null);
  assert.equal(kept.bay_id, 'B2');
  assert.equal(S.db.bookings.filter((x) => x.league_team_id === teamId).length, 1, 'still one round for the week');
});

test('league round: outside the season', async () => {
  world();
  const teamId = await ownTeam();
  const late = await quote({ teamId, dateISO: addDays(43) }, cap);
  assert.equal(late.code, 400);
  assert.equal(late.out.code, 'outside_season');
  assert.match(late.out.error, /Winter Team League runs/);
  S.db.leagues[0].season_start = addDays(20);
  const early = await quote({ teamId, dateISO: addDays(10) }, cap);
  assert.equal(early.code, 400);
  assert.equal(early.out.code, 'outside_season');
  assert.equal(intentsMade().length, 0);
  assert.equal(S.db.bookings.length, 0);
});

test('league round: a slot somebody else already has', async () => {
  world();
  const teamId = await ownTeam();
  S.db.bookings.push({ id: 'bk-taken', bay_id: 'B1', booking_date: nextWeek(), start_min: 660, end_min: 720, status: 'confirmed' });
  const clash = await quote({ teamId }, cap);
  assert.equal(clash.code, 409);
  assert.match(clash.out.error, /just booked/);
  assert.equal(intentsMade().length, 0);

  const elsewhere = await payRound({ teamId, bayId: 'B2' }, cap);
  assert.equal(elsewhere.code, 200, JSON.stringify(elsewhere.out));
});

test('league round: past the booking window, and the nonsense a form can send', async () => {
  world();
  S.db.leagues[0].season_end = addDays(400);
  const teamId = await ownTeam();
  const far = await quote({ teamId, dateISO: addDays(90) }, cap);
  assert.equal(far.code, 400);
  assert.equal(far.out.code, 'booking_window');
  assert.match(far.out.error, /League players can book up to 60 days ahead/);

  // 59 days ahead is inside the league window (a regular booking would stop at 10).
  assert.equal((await payRound({ teamId, dateISO: addDays(59) }, cap)).code, 200);

  for (const bad of [{ dateISO: 'tomorrow' }, { dateISO: '2026-13' }, { bayId: '' }, { startMin: 600, endMin: 600 }, { startMin: 'x' }]) {
    const r = await run(checkoutApi, { query: { action: 'create-payment-intent' }, body: { ...round({ teamId }), ...bad }, ...cap });
    assert.equal(r.code, 400, JSON.stringify(bad));
  }
});

test('league round: the localhost dev account books like anybody else', async () => {
  world();
  const teamId = await ownTeam();
  const r = await payRound({ teamId }, { dev: '2049906530' });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(r.booking.league_team_id, teamId);
  assert.equal((await run(leaguesApi, { query: { action: 'my-teams' }, dev: '2049906530' })).out.teams.length, 1);
});

test('the old free league-round address is closed, and says where rounds are booked now', async () => {
  world();
  const teamId = await ownTeam();
  const r = await run(bookingApi, { query: { action: 'league-round' }, body: round({ teamId }), ...cap });
  assert.equal(r.code, 410);
  assert.equal(r.out.code, 'league_round_moved');
  assert.match(r.out.error, /paid for at checkout/);
  assert.equal(S.db.bookings.length, 0, 'nothing is booked for free');
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

});

// ---------------------------------------------------------------- paying seat by seat (0036)
//
// The team price is shared across the seats the captain picks (league team_min..team_size). The
// captain pays one share, each friend pays one to join, the captain may cover seats, and whatever is
// left is owed by the captain and collected by staff.

// A $600 league whose captains pick 3 to 5 golfers, and a $200 league of fixed pairs.
const RANGE = { id: 'L-range', name: 'Spring League', is_active: true, join_online: true, season_start: addDays(-7), season_end: addDays(56),
  team_mode: true, scoring: 'points', fee_cents: 60000, team_size: 5, team_min: 3, weekly_min_mins: 180, capacity: null, bay_ids: [], sort: 3 };
const PAIRS = { id: 'L-pair', name: 'Pairs League', is_active: true, join_online: true, season_start: addDays(-7), season_end: addDays(56),
  team_mode: true, scoring: 'points', fee_cents: 20000, team_size: 2, weekly_min_mins: 120, capacity: null, bay_ids: [], sort: 4 };
function seatWorld() { world(); S.db.leagues.push({ ...RANGE }, { ...PAIRS }); }

// Buy a seat-by-seat team through the real endpoints and settle it. Returns the team id.
async function buySplitTeam(leagueId, teamName, seats) {
  const r = await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId, teamName, seats }, ...cap });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  const sessionId = r.out.url.split('/').pop();
  const done = await run(leaguesApi, { query: { action: 'confirm' }, body: { sessionId }, ...cap });
  assert.equal(done.code, 200, JSON.stringify(done.out));
  return done.out.teamId;
}
async function inviteToken(teamId, phone) {
  const r = await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone }, ...cap });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  return S.db.league_team_invites.find((i) => i.team_id === teamId && i.phone === phone.replace(/\D/g, '').replace(/^(\d{10})$/, '1$1')).token;
}
const sessionOf = (url) => url.split('/').pop();

test('seat maths: the captain picks within min–max, and a share is the price ÷ seats rounded UP', () => {
  assert.deepEqual(L.seatRange({ team_size: 5, team_min: 3 }), { min: 3, max: 5 });
  assert.deepEqual(L.seatRange({ team_size: 4 }), { min: 4, max: 4 }, 'no minimum = fixed size');
  assert.deepEqual(L.seatRange({ team_size: 4, team_min: 9 }), { min: 4, max: 4 }, 'a minimum above the maximum is clamped');
  assert.equal(L.seatRange({ team_size: null }), null, 'no maximum: nothing to split');
  assert.equal(L.shareOf(60000, 4), 15000);
  assert.equal(L.shareOf(50000, 3), 16667, '$500 three ways is $166.67 each — never less than the team price');
  assert.equal(L.shareOf(0, 4), 0);
});

test('buy-team with a range: the captain must pick a size in it, and pays the price ÷ that size', async () => {
  seatWorld();
  const none = await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'L-range', teamName: 'Trio' }, ...cap });
  assert.equal(none.code, 400);
  assert.match(none.out.error, /3 to 5/);
  assert.equal((await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'L-range', teamName: 'Trio', seats: 6 }, ...cap })).code, 400);
  assert.equal((await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'L-range', teamName: 'Trio', seats: 2 }, ...cap })).code, 400);
  assert.equal(S.stripe.length, 0, 'nothing sent to Stripe for a size outside the range');

  const ok = await run(leaguesApi, { query: { action: 'buy-team' }, body: { leagueId: 'L-range', teamName: 'Trio', seats: 3 }, ...cap });
  assert.equal(ok.code, 200, JSON.stringify(ok.out));
  const sent = S.stripe.find((c) => c[0] === 'checkout.sessions.create')[1];
  assert.equal(sent.line_items[0].price_data.unit_amount, 20000, '$600 ÷ 3 golfers');
  assert.equal(sent.metadata.seats, '3');
});

test('joining an UNPAID seat: the friend pays their own share through Checkout, then they are on the team', async () => {
  seatWorld();
  const teamId = await buySplitTeam('L-range', 'Trio', 3);
  const token = await inviteToken(teamId, '2045550116');

  const info = await run(leaguesApi, { query: { action: 'invite-info' }, body: { token } });
  assert.deepEqual([info.out.payToJoin, info.out.shareCents, info.out.seats], [true, 20000, 3]);

  const claim = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token }, ...friend });
  assert.equal(claim.code, 200, JSON.stringify(claim.out));
  assert.equal(claim.out.payRequired, true);
  assert.equal(claim.out.shareCents, 20000);
  const sent = S.stripe.filter((c) => c[0] === 'checkout.sessions.create').pop()[1];
  assert.deepEqual(sent.metadata, { kind: 'league-seat', teamId, inviteId: S.db.league_team_invites[0].id, customerId: 'c-friend' });
  assert.equal(S.db.league_team_invites[0].claimed_at, undefined, 'the invite is not spent until the money is in');
  assert.equal(S.db.league_members.filter((m) => m.team_id === teamId).length, 1, 'not on the team yet');

  const sessionId = sessionOf(claim.out.url);
  const done = await run(leaguesApi, { query: { action: 'confirm' }, body: { sessionId }, ...friend });
  assert.equal(done.code, 200, JSON.stringify(done.out));
  assert.equal(done.out.seat, true);
  assert.equal(S.db.league_members.filter((m) => m.team_id === teamId).length, 2);
  assert.equal(S.db.league_team_invites[0].claimed_customer_id, 'c-friend');
  assert.equal(S.db.league_seat_payments.length, 2, 'captain\'s seat + the friend\'s');

  // The success page again, and the webhook: still one seat, still one player.
  await run(leaguesApi, { query: { action: 'confirm' }, body: { sessionId }, ...friend });
  const hook = await run(webhookApi, { body: Buffer.from(JSON.stringify({ id: 'evt_seat', type: 'checkout.session.completed', livemode: false,
    data: { object: { id: sessionId, metadata: { kind: 'league-seat' } } } })), headers: { 'stripe-signature': 'sig' } });
  assert.equal(hook.code, 200);
  assert.equal(S.db.league_seat_payments.length, 2);
  assert.equal(S.db.league_members.filter((m) => m.team_id === teamId).length, 2);
  assert.equal((await db.teamMoneyFor(teamId)).money.paidSeats, 2);
});

test('the captain covers seats: a friend joining a PAID seat pays nothing and joins straight away', async () => {
  seatWorld();
  const teamId = await buySplitTeam('L-range', 'Quad', 4);   // $150 a seat

  assert.equal((await run(leaguesApi, { query: { action: 'pay-seats' }, body: { teamId, seats: 1 }, ...friend })).code, 403, 'captain only');
  assert.equal((await run(leaguesApi, { query: { action: 'pay-seats' }, body: { teamId, seats: 4 }, ...cap })).code, 400, 'only 3 are unpaid');

  const pay = await run(leaguesApi, { query: { action: 'pay-seats' }, body: { teamId, seats: 2 }, ...cap });
  assert.equal(pay.code, 200, JSON.stringify(pay.out));
  assert.equal(pay.out.amountCents, 30000);
  const done = await run(leaguesApi, { query: { action: 'confirm' }, body: { sessionId: sessionOf(pay.out.url) }, ...cap });
  assert.equal(done.code, 200, JSON.stringify(done.out));
  const m = (await db.teamMoneyFor(teamId)).money;
  assert.deepEqual([m.paidSeats, m.freeSeats, m.unpaidSeats, m.owedCents], [3, 2, 1, 15000]);

  const before = S.stripe.length;
  const token = await inviteToken(teamId, '2045550116');
  const claim = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token }, ...friend });
  assert.equal(claim.code, 200, JSON.stringify(claim.out));
  assert.equal(claim.out.payRequired, undefined, 'a paid seat was waiting');
  assert.equal(S.stripe.length, before, 'no Checkout at all');
  assert.equal(S.db.league_members.filter((x) => x.team_id === teamId).length, 2);
});

test('the team fills up while a friend is paying: they are refunded in full and not added', async () => {
  seatWorld();
  const teamId = await buySplitTeam('L-pair', 'Duo', 2);   // one seat left, $100
  const t1 = await inviteToken(teamId, '2045550116');
  const t2 = await inviteToken(teamId, '2045550199');
  const a = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token: t1 }, ...friend });
  const b = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token: t2 }, ...other });
  assert.equal(a.out.payRequired && b.out.payRequired, true, 'both sent to Checkout for the last seat');

  assert.equal((await run(leaguesApi, { query: { action: 'confirm' }, body: { sessionId: sessionOf(a.out.url) }, ...friend })).code, 200);
  const late = await run(leaguesApi, { query: { action: 'confirm' }, body: { sessionId: sessionOf(b.out.url) }, ...other });
  assert.equal(late.code, 409);
  assert.equal(late.out.refunded, true);
  assert.match(late.out.error, /filled up .* refunded in full/);
  const refund = S.stripe.find((c) => c[0] === 'refunds.create');
  assert.ok(refund, 'Stripe was asked for the refund');
  assert.equal(refund[1].payment_intent, `pi_${sessionOf(b.out.url)}`);
  assert.equal(S.db.league_members.some((x) => x.customer_id === 'c-other'), false);
  assert.equal(S.db.league_seat_payments.length, 2, 'the refunded payment is not a seat');
});

test('what the captain owes: unpaid seats × share, due once the season has started', async () => {
  seatWorld();
  const teamId = await buySplitTeam('L-range', 'Quad', 4);
  await inviteToken(teamId, '2045550116');
  let m = (await db.teamMoneyFor(teamId)).money;
  assert.deepEqual([m.seats, m.paidSeats, m.unpaidSeats, m.owedCents, m.due, m.openInvites], [4, 1, 3, 45000, true, 1]);

  // Before the season starts nobody is chased — friends are still joining.
  S.db.leagues.find((l) => l.id === 'L-range').season_start = addDays(5);
  m = (await db.teamMoneyFor(teamId)).money;
  assert.equal(m.owedCents, 45000);
  assert.equal(m.due, false);

  // The captain sees it on My Teams, with who is still to accept; a teammate does not see the bill.
  const mine = await run(leaguesApi, { query: { action: 'my-teams' }, ...cap });
  const t = mine.out.teams.find((x) => x.team.id === teamId);
  assert.deepEqual([t.seats.seats, t.seats.paidSeats, t.seats.owedCents, t.seats.invited.length], [4, 1, 45000, 1]);
});

test('staff "Mark collected": Money permission only, part payments, and nothing past what is owed', async () => {
  seatWorld();
  const teamId = await buySplitTeam('L-range', 'Trio', 3);   // 2 seats × $200 owed
  const collect = (tok, body) => run(seriesApi, { query: { action: 'league-collect' }, body, headers: { authorization: `Bearer ${tok}` } });

  assert.equal((await collect('tok-emp', { teamId, seats: 1 })).code, 403, 'an employee without Money');
  assert.equal((await run(seriesApi, { query: { action: 'league-collect' }, body: { teamId, seats: 1 } })).code, 401);
  assert.equal((await collect('tok-admin', { teamId, seats: 3 })).code, 400, 'only 2 are owed');
  assert.equal((await collect('tok-admin', { teamId, seats: 0 })).code, 400);

  const part = await collect('tok-admin', { teamId, seats: 1 });
  assert.equal(part.code, 200, JSON.stringify(part.out));
  assert.deepEqual([part.out.collectedCents, part.out.owedCents, part.out.unpaidSeats], [20000, 20000, 1]);
  assert.match(part.out.message, /1 still unpaid/);
  const row = S.db.league_seat_payments.find((p) => p.method === 'counter');
  assert.deepEqual([row.seats, row.amount_cents, row.recorded_by, row.payer_customer_id], [1, 20000, 'admin@invictus.test', 'c-cap']);

  const rest = await collect('tok-admin', { teamId, seats: 1 });
  assert.match(rest.out.message, /Every seat is now paid/);
  assert.equal((await db.teamMoneyFor(teamId)).money.owedCents, 0);
  assert.equal((await collect('tok-admin', { teamId, seats: 1 })).code, 409, 'nothing left to collect');
  assert.equal(S.db.league_teams.find((x) => x.id === teamId).paid_cents, 60000, 'the team total adds up');
});

test('teams bought before seat-by-seat payments are untouched: never asked to pay, never flagged', async () => {
  seatWorld();
  const teamId = await ownTeam();   // the old way: whole price, no seats
  const m = (await db.teamMoneyFor(teamId)).money;
  assert.deepEqual([m.split, m.owedCents, m.due], [false, 0, false]);
  const token = await inviteToken(teamId, '2045550116');
  const claim = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token }, ...friend });
  assert.equal(claim.out.payRequired, undefined, 'friends of an old team join free, as before');
  assert.equal((await run(seriesApi, { query: { action: 'league-collect' }, body: { teamId, seats: 1 }, headers: { authorization: 'Bearer tok-admin' } })).code, 409);
});

test('before migration 0036: leagues and teams still read, with their 0031 sizes', async () => {
  world();
  S.missing0031 = ['team_min', 'share_cents'];
  const r = await run(leaguesApi, { query: { action: 'list' } });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(r.out.leagues[0].team_size, 4, 'not dropped back to the pre-0031 columns');
  const teamId = await ownTeam();
  assert.equal((await db.leagueTeamById(teamId)).captain_customer_id, 'c-cap');
});

// ---- League info: the brochure (migration 0039, leagues.details) -------------------------------
const BROCHURE = {
  about: 'A 16-week, four-person scramble.',
  format: ['Four-person scramble', '• 2-foot concede', ''],
  challenges: 'Mega Putt Challenge\nClosest to the Pin Challenge',
  schedule: [
    { from: '2026-11-01', to: '2026-11-07', phase: 'Phase 1', event: '', course: 'Marco Simone Golf & Country Club', location: 'Italy' },
    { from: '2026-11-08', to: '2026-11-14', phase: 'Phase 1', event: 'Mini Tournament 1', course: 'Deer Ridge Golf Club', location: 'Kitchener, Ontario' },
    { from: 'not-a-date', to: null, phase: '', event: '', course: '', location: '' },
  ],
  awards: ['Cup Winner', 'Most Honest'],
  prize: '3 teams going on the trip.',
};

test('info: a league\'s brochure, cleaned up the same way the form cleans it', async () => {
  world();
  S.db.leagues[0].details = BROCHURE;
  const r = await run(leaguesApi, { query: { action: 'info' }, body: { leagueId: 'L-team' } });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  const d = r.out.league.details;
  assert.equal(d.about, 'A 16-week, four-person scramble.');
  assert.deepEqual(d.format, ['Four-person scramble', '2-foot concede'], 'bullets and blank lines are dropped');
  assert.deepEqual(d.challenges, ['Mega Putt Challenge', 'Closest to the Pin Challenge'], 'one item per line');
  assert.equal(d.schedule.length, 2, 'a row with no date, event or course is not a week');
  assert.equal(d.schedule[1].event, 'Mini Tournament 1');
  assert.deepEqual(d.awards, ['Cup Winner', 'Most Honest']);
  assert.equal(r.out.league.joinOnline, true);
  // The list only says whether there is anything to open.
  const list = await run(leaguesApi, { query: { action: 'list' } });
  assert.equal(list.out.leagues[0].hasInfo, true);
  assert.equal(list.out.leagues[1].hasInfo, false);
  assert.equal('details' in list.out.leagues[0], false);
});

test('info: a team in a league that has closed sign-up can still read it; a hidden or unknown league cannot be read', async () => {
  world();
  S.db.leagues[2].details = BROCHURE;                       // L-over: its season has ended
  const over = await run(leaguesApi, { query: { action: 'info' }, body: { leagueId: 'L-over' } });
  assert.equal(over.code, 200);
  assert.equal(over.out.league.joinOnline, false);
  S.db.leagues[0].is_active = false;
  assert.equal((await run(leaguesApi, { query: { action: 'info' }, body: { leagueId: 'L-team' } })).code, 404);
  assert.equal((await run(leaguesApi, { query: { action: 'info' }, body: { leagueId: 'nope' } })).code, 404);
  assert.equal((await run(leaguesApi, { query: { action: 'info' }, body: {} })).code, 404);
});

test('info: a league with nothing filled in gives an empty brochure, never an error', async () => {
  world();
  const r = await run(leaguesApi, { query: { action: 'info' }, body: { leagueId: 'L-free' } });
  assert.equal(r.code, 200);
  assert.deepEqual(r.out.league.details, { about: '', perks: [], eligibility: [], format: [], rules: [], settings: [], challenges: [], schedule: [], notice: '', awards: [], prize: '' });
});

test('before migration 0039 is pasted in: leagues list and open as before, with no brochure yet', async () => {
  world();
  S.missing0031 = ['details'];
  try {
    const list = await run(leaguesApi, { query: { action: 'list' } });
    assert.equal(list.code, 200, JSON.stringify(list.out));
    assert.deepEqual(list.out.leagues.map((l) => l.id), ['L-team', 'L-free']);
    assert.equal(list.out.leagues[0].hasInfo, false);
    assert.equal(list.out.leagues[0].team_size, 4, 'the earlier columns are still read');
    const r = await run(leaguesApi, { query: { action: 'info' }, body: { leagueId: 'L-team' } });
    assert.equal(r.code, 200);
    assert.equal(r.out.league.details.about, '');
  } finally { S.missing0031 = null; }
});

// ---- A league chooses the day its week starts (migration 0040) ---------------------------------
// The first Tuesday from tomorrow on, then the Sunday five days later (same Monday–Sunday week, a
// NEW Sunday–Saturday week), then the Saturday closing that Sunday week.
function tueSunSat() {
  let tue = addDays(1);
  while (new Date(`${tue}T00:00:00Z`).getUTCDay() !== 2) tue = addDays(1, tue);
  return { tue, sun: addDays(5, tue), sat: addDays(11, tue) };
}

test('a Sunday-start league: Tuesday then the following Sunday are two weeks; that Sunday and its Saturday are one', async () => {
  world();
  S.db.leagues[0].week_start = 0;
  const teamId = await ownTeam();
  const { tue, sun, sat } = tueSunSat();
  seasonStartsAt(tue, 0);
  const a = await payRound({ teamId, dateISO: tue }, cap);
  assert.equal(a.code, 200, JSON.stringify(a.out));
  const b = await payRound({ teamId, dateISO: sun }, cap);
  assert.equal(b.code, 200, 'the Sunday starts a new week — Monday weeks refused this: ' + JSON.stringify(b.out));
  assert.equal(b.booking.league_week, sun);
  const c = await payRound({ teamId, dateISO: sat }, cap);
  assert.equal(c.code, 409, 'the Saturday closes the week that Sunday opened');
  assert.equal(c.out.code, 'round_booked');
  // The team's own page files both rounds under the right weeks.
  const seen = await run(leaguesApi, { query: { action: 'my-teams' }, ...cap });
  const weeks = seen.out.teams[0].weeks.filter((w) => w.round);
  assert.deepEqual(weeks.map((w) => [w.start, w.round.booking_date]), [[startOfWeek(tue, 0), tue], [sun, sun]]);
  assert.ok(seen.out.teams[0].weeks.every((w) => new Date(`${w.start}T00:00:00Z`).getUTCDay() === 0), 'every week starts on a Sunday');
});

test('a league that says nothing still counts Monday to Sunday: Tuesday then Sunday is refused', async () => {
  world();
  const teamId = await ownTeam();
  const { tue, sun } = tueSunSat();
  seasonStartsAt(tue);
  assert.equal((await payRound({ teamId, dateISO: tue }, cap)).code, 200);
  const b = await payRound({ teamId, dateISO: sun }, cap);
  assert.equal(b.code, 409);
  assert.equal(b.out.code, 'round_booked');
});

// ---- Solo sign-ups and substitutes (migration 0041) --------------------------------------------
// Extra people for these tests: each gets a customer row, a login and a token, like cap/friend/other.
function person(key, name, phone) {
  S.db.customers.push({ id: `c-${key}`, name, phone: `+1${phone}`, email: null, user_id: `user-${key}` });
  S.tokens[`tok-${key}`] = `user-${key}`;
  return { id: `c-${key}`, auth: { headers: { authorization: `Bearer tok-${key}` } }, phone };
}
const admin = { headers: { authorization: 'Bearer tok-admin' } };
const emp = { headers: { authorization: 'Bearer tok-emp' } };
const onTeam = (teamId, customerId, extra = {}) => S.db.league_members.push({ id: `lm-${++seq}`, league_id: 'L-team', customer_id: customerId, team_id: teamId, status: 'active', role: 'player', paid_cents: 0, ...extra });
const members = (teamId, role = 'player') => S.db.league_members.filter((m) => m.team_id === teamId && m.status === 'active' && (m.role || 'player') === role);
// A solo who has paid online: the whole sign-up, through Checkout and the success page.
async function soloSignUp(who) {
  const r = await run(leaguesApi, { query: { action: 'join-solo' }, body: { leagueId: 'L-team' }, ...who });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  const sessionId = Object.keys(S.sessions).at(-1);
  const done = await run(leaguesApi, { query: { action: 'confirm' }, body: { sessionId } });
  assert.equal(done.code, 200, JSON.stringify(done.out));
  return { r, done, sessionId };
}

test('solo: one golfer pays one share, is in the league with no team, and cannot sign up twice', async () => {
  world();
  assert.equal((await run(leaguesApi, { query: { action: 'join-solo' }, body: { leagueId: 'L-team' } })).code, 401, 'signed out');

  const { r, done, sessionId } = await soloSignUp(other);
  assert.equal(r.out.amountCents, 7500, 'a quarter of the $300 team price — one seat of a full team');
  const sent = S.stripe.find(([c]) => c === 'checkout.sessions.create')[1];
  assert.equal(sent.line_items[0].price_data.unit_amount, 7500);
  assert.deepEqual(sent.metadata, { kind: 'league-solo', leagueId: 'L-team', customerId: 'c-other' });
  assert.equal(done.out.solo, true);

  const rows = S.db.league_members.filter((m) => m.customer_id === 'c-other');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].team_id, null, 'no team yet — the manager places them');
  assert.equal(rows[0].paid_cents, 7500);
  assert.equal(rows[0].stripe_session_id, sessionId);

  // The success page and the webhook both settle it: still one row.
  await run(leaguesApi, { query: { action: 'confirm' }, body: { sessionId } });
  assert.equal(S.db.league_members.filter((m) => m.customer_id === 'c-other').length, 1);

  // What they see while they wait, and what the league page shows them.
  const mine = await run(leaguesApi, { query: { action: 'my-teams' }, ...other });
  assert.deepEqual(mine.out.teams, []);
  assert.deepEqual(mine.out.solos.map((x) => x.league.name), ['Winter Team League']);
  const listed = (await run(leaguesApi, { query: { action: 'list' }, ...other })).out.leagues.find((l) => l.id === 'L-team');
  assert.equal(listed.mySolo, true);
  assert.equal(listed.soloCents, 7500);

  const again = await run(leaguesApi, { query: { action: 'join-solo' }, body: { leagueId: 'L-team' }, ...other });
  assert.equal(again.code, 409);
  assert.match(again.out.error, /already signed up as a solo player/);
  // And a captain cannot also sign up solo in the league their team is in.
  await ownTeam();
  const capSolo = await run(leaguesApi, { query: { action: 'join-solo' }, body: { leagueId: 'L-team' }, ...cap });
  assert.equal(capSolo.code, 409);
  assert.match(capSolo.out.error, /already on Aces/);
});

test('placing a solo: staff only; they join the team, their payment becomes a paid seat, and they are texted', async () => {
  world();
  // A team of two bought seat by seat: the captain has paid one of its two seats.
  const made = await db.createLeagueTeam({ leagueId: 'L-team', name: 'Aces', captainCustomerId: 'c-cap', paidCents: 7500, stripeSessionId: 'cs_seed', seats: 2, shareCents: 7500 });
  const teamId = made.teamId;
  await soloSignUp(other);
  const solo = S.db.league_members.find((m) => m.customer_id === 'c-other');

  for (const who of [{}, other]) {
    const no = await run(leaguesApi, { query: { action: 'place-solo' }, body: { memberId: solo.id, teamId }, ...who });
    assert.equal(no.code, 403, 'a customer and a signed-out caller are both refused');
  }
  // Staff without the Bookings permission are refused too.
  S.db.role_permissions.find((x) => x.capability === 'booking.write').allowed = false;
  assert.equal((await run(leaguesApi, { query: { action: 'place-solo' }, body: { memberId: solo.id, teamId }, ...emp })).code, 403);
  S.db.role_permissions.find((x) => x.capability === 'booking.write').allowed = true;
  assert.equal(solo.team_id, null);

  const r = await run(leaguesApi, { query: { action: 'place-solo' }, body: { memberId: solo.id, teamId }, ...admin });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(r.out.teamName, 'Aces');
  assert.equal(r.out.grew, false, 'there was an open seat');
  assert.equal(solo.team_id, teamId);
  const seat = S.db.league_seat_payments.find((p) => p.for_customer_id === 'c-other');
  assert.equal(seat.amount_cents, 7500);
  assert.equal(seat.seats, 1);
  const money = (await db.teamMoneyFor(teamId)).money;
  assert.equal(money.paidSeats, 2);
  assert.equal(money.owedCents, 0, 'the captain is not chased for a seat the solo already paid for');
  assert.ok(S.db.notifications.some((n) => n.template === 'league.placed' && n.recipient === '+12045550199'), 'told which team they are on');

  // Placing them again changes nothing and records no second seat.
  const twice = await run(leaguesApi, { query: { action: 'place-solo' }, body: { memberId: solo.id, teamId }, ...admin });
  assert.equal(twice.out.already, true);
  assert.equal(S.db.league_seat_payments.filter((p) => p.for_customer_id === 'c-other').length, 1);

  // The team's two seats are taken. The next solo brings their own seat, up to the league's four.
  const a = person('a', 'Ana Ruiz', '2045550201'), b = person('b', 'Bo Chen', '2045550202'), c = person('c', 'Cy Dunn', '2045550203');
  for (const x of [a, b, c]) await soloSignUp(x.auth);
  const idOf = (x) => S.db.league_members.find((m) => m.customer_id === x.id).id;
  const third = await run(leaguesApi, { query: { action: 'place-solo' }, body: { memberId: idOf(a), teamId }, ...admin });
  assert.equal(third.out.grew, true);
  assert.equal(S.db.league_teams.find((t) => t.id === teamId).seats, 3);
  assert.equal((await run(leaguesApi, { query: { action: 'place-solo' }, body: { memberId: idOf(b), teamId }, ...admin })).code, 200);
  const fifth = await run(leaguesApi, { query: { action: 'place-solo' }, body: { memberId: idOf(c), teamId }, ...admin });
  assert.equal(fifth.code, 409, 'never past the league’s team size');
  assert.match(fifth.out.error, /Aces is full/);
  assert.equal(members(teamId).length, 4);
});

test('a team made from solos: one seat each, all paid, the first is captain', async () => {
  world();
  const a = person('a', 'Ana Ruiz', '2045550201'), b = person('b', 'Bo Chen', '2045550202');
  await soloSignUp(a.auth); await soloSignUp(b.auth);
  const ids = [a, b].map((x) => S.db.league_members.find((m) => m.customer_id === x.id).id);

  assert.equal((await run(leaguesApi, { query: { action: 'team-from-solos' }, body: { leagueId: 'L-team', memberIds: ids, name: 'Mulligans' }, ...other })).code, 403);
  const r = await run(leaguesApi, { query: { action: 'team-from-solos' }, body: { leagueId: 'L-team', memberIds: ids, name: 'Mulligans' }, ...admin });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(r.out.placed, 2);
  const team = S.db.league_teams.find((t) => t.id === r.out.teamId);
  assert.equal(team.name, 'Mulligans');
  assert.equal(team.captain_customer_id, 'c-a');
  assert.equal(team.seats, 2);
  assert.equal(team.share_cents, 7500);
  assert.equal(members(team.id).length, 2);
  const money = (await db.teamMoneyFor(team.id)).money;
  assert.deepEqual([money.paidSeats, money.players, money.owedCents], [2, 2, 0]);
  assert.equal(S.db.notifications.filter((n) => n.template === 'league.placed').length, 2);
  // They see their team on My Account now, not "waiting to be placed".
  const mine = await run(leaguesApi, { query: { action: 'my-teams' }, ...b.auth });
  assert.deepEqual(mine.out.teams.map((t) => t.team.name), ['Mulligans']);
  assert.deepEqual(mine.out.solos, []);

  // A name already in the league, and players who are no longer team-less, are both refused.
  await soloSignUp(other);
  const otherId = S.db.league_members.find((m) => m.customer_id === 'c-other').id;
  const clash = await run(leaguesApi, { query: { action: 'team-from-solos' }, body: { leagueId: 'L-team', memberIds: [otherId], name: 'mulligans' }, ...admin });
  assert.equal(clash.code, 409);
  const stale = await run(leaguesApi, { query: { action: 'team-from-solos' }, body: { leagueId: 'L-team', memberIds: [ids[0], otherId], name: 'Eagles' }, ...admin });
  assert.equal(stale.code, 409);
  assert.match(stale.out.error, /already on a team/);
});

// A full team: the captain plus three players, in a league whose teams hold four.
async function fullTeam() {
  const teamId = await ownTeam();
  for (const k of ['p1', 'p2', 'p3']) onTeam(teamId, person(k, `Player ${k}`, `20455503${k.slice(1)}0`).id);
  return teamId;
}
const inviteSub = (teamId, phone, who = cap) => run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone, role: 'sub' }, ...who });

test('substitutes: the captain invites one whenever they like — the team need not be full — and a sub takes no seat', async () => {
  world();
  const teamId = await ownTeam();
  // A team of one, three open spots: a substitute can be invited already, and takes none of them.
  const early = await inviteSub(teamId, '2045550150');
  assert.equal(early.code, 200, JSON.stringify(early.out));
  assert.equal(early.out.role, 'sub');
  const lonely = (await run(leaguesApi, { query: { action: 'my-teams' }, ...cap })).out.teams[0];
  assert.equal(lonely.subs.canInvite, true);
  assert.deepEqual(lonely.subs.invited.map((x) => x.name), ['Invited substitute']);
  assert.equal((await db.teamMoneyFor(teamId)).money.openInvites, 0, 'a substitute’s invite holds no seat');
  S.db.league_team_invites.at(-1).revoked_at = new Date().toISOString();

  for (const k of ['p1', 'p2', 'p3']) onTeam(teamId, person(k, `Player ${k}`, `20455503${k.slice(1)}0`).id);
  assert.equal((await inviteSub(teamId, '2045550116', other)).code, 403, 'only the captain (or staff) invites');
  const inv = await inviteSub(teamId, '2045550116');
  assert.equal(inv.code, 200, JSON.stringify(inv.out));
  assert.equal(inv.out.role, 'sub');
  const row = S.db.league_team_invites.at(-1);
  assert.equal(row.role, 'sub');
  assert.equal(S.db.notifications.at(-1).payload.role, 'sub', 'the text says "substitute", not "paid for your spot"');

  const info = await run(leaguesApi, { query: { action: 'invite-info' }, body: { token: row.token } });
  assert.equal(info.out.role, 'sub');
  assert.equal(info.out.teamFull, false, 'a full team is exactly when a substitute can join');
  assert.equal(info.out.payToJoin, false);

  const claim = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token: row.token }, ...friend });
  assert.equal(claim.code, 200, JSON.stringify(claim.out));
  assert.equal(claim.out.sub, true);
  assert.equal(claim.out.payRequired, undefined);
  assert.equal(members(teamId, 'sub').length, 1);
  assert.equal(members(teamId).length, 4, 'still four players');

  const capView = (await run(leaguesApi, { query: { action: 'my-teams' }, ...cap })).out.teams[0];
  assert.equal(capView.roster.length, 4, 'the roster is the players');
  assert.deepEqual(capView.subs.list.map((x) => x.name), ['Sam O.']);
  assert.equal(capView.subs.canInvite, true);
  assert.equal(capView.subs.max, 3);
  const subView = (await run(leaguesApi, { query: { action: 'my-teams' }, ...friend })).out.teams[0];
  assert.equal(subView.team.sub, true);
  assert.equal(subView.subs.list[0].isMe, true);
});

test('substitutes get no league perks: no longer booking window, and they cannot book the team’s league round', async () => {
  world();
  const teamId = await fullTeam();
  const inv = await inviteSub(teamId, '2045550116');
  await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token: S.db.league_team_invites.at(-1).token }, ...friend });
  assert.equal(inv.code, 200);

  const win = await run(leaguesApi, { query: { action: 'window' }, ...friend });
  assert.equal(win.out.league, false);
  assert.equal(win.out.days, 10, 'the regular window, not the league one');
  assert.equal((await run(leaguesApi, { query: { action: 'window' }, ...cap })).out.league, true, 'a player still gets it');

  const r = await quote({ teamId }, friend);
  assert.equal(r.code, 403);
  assert.equal(r.out.code, 'not_on_team');
  assert.match(r.out.error, /You’re a substitute for Aces/);
  assert.equal(intentsMade().length, 0);
});

test('substitutes: three a team, counting invites still waiting; the database refuses a fourth', async () => {
  world();
  const teamId = await fullTeam();
  const nums = ['2045550401', '2045550402', '2045550403'];
  for (const n of nums) assert.equal((await inviteSub(teamId, n)).code, 200);
  // Three are invited and none has accepted: a fourth text is refused already.
  const fourth = await inviteSub(teamId, '2045550404');
  assert.equal(fourth.code, 409);
  assert.match(fourth.out.error, /up to 3 substitutes/);
  // Re-sending to one of the three is still fine.
  assert.equal((await inviteSub(teamId, nums[0])).out.resent, true);

  // All three accept.
  const tokens = S.db.league_team_invites.filter((i) => i.role === 'sub').map((i) => i.token);
  const subs = nums.map((n, i) => person(`s${i}`, `Sub ${i}`, n));
  for (let i = 0; i < 3; i++) assert.equal((await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token: tokens[i] }, ...subs[i].auth })).code, 200);
  assert.equal(members(teamId, 'sub').length, 3);
  assert.equal((await inviteSub(teamId, '2045550404')).code, 409);

  // Staff writing the roster directly (the portal does) hit the same wall in the database.
  const direct = await db.admin().from('league_members').insert({ league_id: 'L-team', customer_id: 'c-other', team_id: teamId, status: 'active', role: 'sub' });
  assert.match(direct.error.message, /league_subs_limit/);
  assert.equal(members(teamId, 'sub').length, 3);
});

test('substitutes: somebody already playing in the league cannot also be one', async () => {
  world();
  const teamId = await fullTeam();
  await db.createLeagueTeam({ leagueId: 'L-team', name: 'Birdies', captainCustomerId: 'c-other' });
  await inviteSub(teamId, '2045550199');
  const token = S.db.league_team_invites.at(-1).token;
  const r = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token }, ...other });
  assert.equal(r.code, 409);
  assert.match(r.out.error, /already in Winter Team League/);
  assert.equal(members(teamId, 'sub').length, 0);
  assert.equal(S.db.league_team_invites.at(-1).claimed_at ?? null, null, 'the invite is not spent on a refusal');
});

// ---- The league's own rules (2026-27): make-ups, the deadline, fees first, the roster lock ------
// A season of six Monday weeks starting two weeks ago, so "today" is in week 3 and weeks 1 and 2
// are already behind the team. w(n) is the Monday of week n.
function ruleWorld(dates = {}) {
  world();
  const lg = S.db.leagues[0];
  lg.season_start = mondayOf(addDays(-14)); lg.season_end = addDays(6 * 7 - 1, lg.season_start);
  lg.details = { dates };
  return (n) => addDays((n - 1) * 7, lg.season_start);
}
const roundOn = (teamId, dateISO, extra = {}) => S.db.bookings.push({ id: `bk-${++seq}`, bay_id: 'B2', booking_date: dateISO, start_min: 600, end_min: 780,
  status: 'confirmed', league_team_id: teamId, league_week: mondayOf(extra.league_for_week || dateISO), ...extra });

test('make-up rounds: a missed week is played first, in order, and a team that is up to date plays one a week', async () => {
  const w = ruleWorld();
  const teamId = await ownTeam();
  roundOn(teamId, w(1));                       // week 1 was played; week 2 was missed; today is week 3
  const day = addDays(2, w(4));                // a Wednesday in week 4, inside the regular booking window

  // The first round they book that day is the make-up for week 2 — not week 4, not week 3.
  const a = await payRound({ teamId, dateISO: day, startMin: 480, endMin: 660 }, cap);
  assert.equal(a.code, 200, JSON.stringify(a.out));
  assert.deepEqual([a.quote.leagueRound.week.number, a.quote.leagueRound.makeup], [2, true]);
  assert.equal(a.booking.league_for_week, w(2));
  assert.equal(a.booking.league_week, w(2), 'filed under the week it counts for');
  assert.equal(a.quote.leagueDiscountCents, 1500, 'a make-up is a league round like any other: it gets the discount');

  // Then week 3, then week 4 itself — three league rounds in one calendar week, each its own week.
  const b = await payRound({ teamId, dateISO: day, startMin: 660, endMin: 840 }, cap);
  assert.deepEqual([b.quote.leagueRound.week.number, b.quote.leagueRound.makeup], [3, true]);
  const c = await payRound({ teamId, dateISO: addDays(1, day) }, cap);
  assert.deepEqual([c.quote.leagueRound.week.number, c.quote.leagueRound.makeup], [4, false]);
  assert.equal(c.booking.league_for_week ?? null, null);

  // Up to date now: a fourth round that week is refused, and nobody plays ahead.
  const d = await quote({ teamId, dateISO: addDays(2, day), bayId: 'B2' }, cap);
  assert.equal(d.code, 409);
  assert.equal(d.out.code, 'round_booked');
  assert.equal(intentsMade().length, 3);

  // My Account files each round under the week it counts for.
  const weeks = (await run(leaguesApi, { query: { action: 'my-teams' }, ...cap })).out.teams[0].weeks;
  assert.deepEqual(weeks.slice(0, 4).map((x) => [x.number, !!x.round, x.missed]), [[1, true, false], [2, true, false], [3, true, false], [4, true, false]]);
  assert.equal(weeks[1].round.booking_date, day, 'week 2’s round was played in week 4');
});

test('make-up rounds: a holiday break is never owed, but can still be played in its own week', async () => {
  const w = ruleWorld();
  S.db.leagues[0].details.schedule = [{ from: w(2), to: addDays(6, w(2)), event: 'Break', optional: true }];
  const teamId = await ownTeam();
  roundOn(teamId, w(1));
  // Week 2 was a break and was not played. A round this week is this week's, not a make-up for it.
  const r = await quote({ teamId, dateISO: addDays(1) < addDays(7, w(3)) ? addDays(1) : w(3) }, cap);
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.deepEqual([r.out.leagueRound.week.number, r.out.leagueRound.makeup], [3, false]);
});

test('the regular-season deadline: rounds after it do not count, and no regular week can be made up', async () => {
  const w = ruleWorld();
  const lg = S.db.leagues[0];
  // Regular season is weeks 1–3; playoffs start in week 5; week 4 belongs to neither.
  lg.details.dates = { regularEnd: addDays(6, w(3)), playoffsStart: w(5) };
  S.db.settings[0].booking_window = { regularDays: 10, leagueDays: 60 };
  const teamId = await ownTeam();
  roundOn(teamId, w(1));                       // week 2 missed, week 3 not played yet

  const gap = await quote({ teamId, dateISO: addDays(1, w(4)) }, cap);
  assert.equal(gap.code, 400);
  assert.equal(gap.out.code, 'after_deadline');
  assert.match(gap.out.error, /regular season ended on/);
  assert.match(gap.out.error, /playoffs start/);

  // A playoff week is its own round: the missed regular weeks are gone, not made up now.
  const po = await quote({ teamId, dateISO: addDays(1, w(5)) }, cap);
  assert.equal(po.code, 200, JSON.stringify(po.out));
  assert.deepEqual([po.out.leagueRound.week.number, po.out.leagueRound.makeup], [5, false]);
  assert.equal(intentsMade().length, 1);
});

test('fees before the first round: a team that still owes cannot book a league round until it is paid', async () => {
  ruleWorld({ feesFirst: true });
  // A team of two bought seat by seat; only the captain's seat is paid.
  const made = await db.createLeagueTeam({ leagueId: 'L-team', name: 'Aces', captainCustomerId: 'c-cap', paidCents: 7500, stripeSessionId: 'cs_seed', seats: 2, shareCents: 7500 });
  const owing = await quote({ teamId: made.teamId }, cap);
  assert.equal(owing.code, 403);
  assert.equal(owing.out.code, 'fees_unpaid');
  assert.match(owing.out.error, /Aces still has \$75\.00 of its league fee to pay/);
  assert.equal(intentsMade().length, 0);

  S.db.league_seat_payments.push({ id: 'sp-2', team_id: made.teamId, league_id: 'L-team', seats: 1, amount_cents: 7500, method: 'counter' });
  assert.equal((await quote({ teamId: made.teamId }, cap)).code, 200, 'paid up: the round books');

  // The rule is the league's to switch on: without it an owing team books as before.
  S.db.league_seat_payments.pop();
  S.db.leagues[0].details.dates = {};
  assert.equal((await quote({ teamId: made.teamId, bayId: 'B2' }, cap)).code, 200);
});

test('the roster lock: after the lock week the captain adds nobody, an old invite lapses, and staff still can', async () => {
  const w = ruleWorld({ rosterLockWeek: 4 });          // today is week 3: not locked yet
  const teamId = await ownTeam();
  const before = await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '2045550116' }, ...cap });
  assert.equal(before.code, 200, JSON.stringify(before.out));
  const invite = S.db.league_team_invites.at(-1);
  invite.created_at = new Date().toISOString();

  // Move the season back so today is in week 5: rosters locked at the end of week 4.
  const lg = S.db.leagues[0];
  lg.season_start = mondayOf(addDays(-28)); lg.season_end = addDays(8 * 7 - 1, lg.season_start);
  invite.created_at = `${addDays(-20)}T12:00:00Z`;       // …and that invite was sent back in week 2

  for (const role of [undefined, 'sub']) {
    const r = await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '2045550199', role }, ...cap });
    assert.equal(r.code, 403);
    assert.equal(r.out.code, 'roster_locked');
    assert.match(r.out.error, /locked after week 4/);
  }
  const late = await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token: invite.token }, ...friend });
  assert.equal(late.code, 409);
  assert.equal(late.out.code, 'roster_locked');
  assert.equal(S.db.league_members.filter((m) => m.customer_id === 'c-friend').length, 0);

  // A correction is staff's to make: their invite goes out, and it can be accepted.
  const byStaff = await run(leaguesApi, { query: { action: 'invite' }, body: { teamId, phone: '2045550199' }, headers: { authorization: 'Bearer tok-admin' } });
  assert.equal(byStaff.code, 200, JSON.stringify(byStaff.out));
  const fresh = S.db.league_team_invites.at(-1);
  fresh.created_at = new Date().toISOString();
  assert.equal((await run(leaguesApi, { query: { action: 'invite-claim' }, body: { token: fresh.token }, ...other })).code, 200);
});

test('rule reminders: each captain is told once, in the week before rosters lock and before the playoffs', async () => {
  const w = ruleWorld();
  const lg = S.db.leagues[0];
  const teamId = await ownTeam();
  await db.createLeagueTeam({ leagueId: 'L-team', name: 'Birdies', captainCustomerId: 'c-other' });
  await db.createLeagueTeam({ leagueId: 'L-team', name: 'No Captain' });
  const today = winnipegTodayISO();

  // Nothing set on the league: nobody is told anything.
  assert.deepEqual(await db.leagueReminderTargets(today), []);

  // Rosters lock at the end of week 3 (this week), playoffs start in 5 days.
  lg.details.dates = { rosterLockWeek: 3, playoffsStart: addDays(5) };
  const due = await db.leagueReminderTargets(today);
  assert.deepEqual(due.map((d) => [d.kind, d.team.name]).sort(), [['playoffs', 'Aces'], ['playoffs', 'Birdies'], ['roster_lock', 'Aces'], ['roster_lock', 'Birdies']]);
  assert.equal(due.find((d) => d.kind === 'roster_lock').on, addDays(6, w(3)));

  const first = await notify.notifyLeagueReminders(due, { sendNow: false });
  assert.deepEqual([first.due, first.queued], [4, 4]);
  const rows = S.db.notifications.filter((n) => n.template === 'league.reminder');
  assert.equal(rows.length, 4);
  assert.deepEqual([...new Set(rows.map((n) => n.recipient))].sort(), ['+12045550199', '+12049906530']);
  const text = (kind) => notify.TEMPLATES['league.reminder'].sms(rows.find((n) => n.payload.kind === kind && n.payload.teamName === 'Aces').payload, { name: 'Invictus Golf' });
  assert.match(text('playoffs'), /playoffs start .*Substitutes can't play in the playoffs/);
  assert.match(text('roster_lock'), /rosters for Winter Team League lock after .*end of week 3.*Aces/);

  // The job runs again tomorrow (and the day after): nobody is texted twice.
  const again = await notify.notifyLeagueReminders(await db.leagueReminderTargets(today), { sendNow: false });
  assert.equal(again.queued, 0);
  assert.equal(S.db.notifications.filter((n) => n.template === 'league.reminder').length, 4);

  // More than a week out, or already past: not due.
  lg.details.dates = { rosterLockWeek: 6, playoffsStart: addDays(-1) };
  assert.deepEqual(await db.leagueReminderTargets(today), []);
});

// ---- Scorecard photos (rule 5; migration 0042) -------------------------------------------------
const JPEG = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(600, 7)]).toString('base64')}`;
const card = (body, who = cap) => run(leaguesApi, { query: { action: 'scorecard' }, body, ...who });

test('scorecard photos: someone on the team adds the photo for a week they played; staff find it by week', async () => {
  const w = ruleWorld();
  const teamId = await ownTeam();
  roundOn(teamId, addDays(1, w(1)));                               // week 1 played
  roundOn(teamId, addDays(2, w(3)), { league_for_week: w(2) });    // week 2, made up in week 3

  assert.equal((await card({ teamId, week: w(1), image: JPEG }, {})).code, 401, 'signed out');
  assert.equal((await card({ teamId, week: w(1), image: JPEG }, other)).code, 403, 'not on the team');
  // Not a photo, whatever it says it is; and far too large.
  assert.equal((await card({ teamId, week: w(1), image: `data:image/jpeg;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}` })).code, 400);
  assert.equal((await card({ teamId, week: w(1), image: 'data:text/html;base64,PGI+' })).code, 400);
  assert.equal((await card({ teamId, week: w(1), image: `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(4 * 1024 * 1024)]).toString('base64')}` })).code, 400);
  // A week the team has not played has no scorecard.
  const none = await card({ teamId, week: w(4), image: JPEG });
  assert.equal(none.code, 409);
  assert.match(none.out.error, /no league round for week 4/);
  assert.equal(Object.keys(S.buckets).length, 0, 'nothing was stored for any of those');

  // The real thing — the bucket is made, privately, on the first photo. A mid-week date finds its week.
  const ok = await card({ teamId, week: addDays(3, w(1)), image: JPEG });
  assert.equal(ok.code, 200, JSON.stringify(ok.out));
  assert.deepEqual(ok.out.week, { start: w(1), number: 1 });
  assert.equal(S.buckets['league-scorecards'].public, false);
  const row = S.db.league_scorecards[0];
  assert.equal(row.league_week, w(1));
  assert.equal(row.content_type, 'image/jpeg');
  assert.equal(row.uploaded_by, 'c-cap');
  assert.match(row.path, new RegExp(`^L-team/${teamId}/${w(1)}-`));
  assert.ok(S.buckets['league-scorecards'].files[row.path]);
  // The make-up round's photo is filed under the week it counted for.
  assert.equal((await card({ teamId, week: w(2), image: JPEG })).code, 200);
  assert.equal(S.db.league_scorecards[1].booking_id, S.db.bookings[1].id);

  // The team sees its own; a stranger does not; staff see the league's, by week.
  const mine = await run(leaguesApi, { query: { action: 'scorecards' }, body: { teamId }, ...cap });
  assert.deepEqual(mine.out.cards.map((c) => c.week), [w(1), w(2)]);
  assert.match(mine.out.cards[0].url, /^https:\/\/storage\.test\/league-scorecards\//);
  assert.equal((await run(leaguesApi, { query: { action: 'scorecards' }, body: { teamId }, ...other })).code, 403);
  assert.equal((await run(leaguesApi, { query: { action: 'scorecards' }, body: { leagueId: 'L-team' }, ...cap })).code, 403, 'a customer cannot list the league');
  const staff = await run(leaguesApi, { query: { action: 'scorecards' }, body: { leagueId: 'L-team' }, headers: { authorization: 'Bearer tok-admin' } });
  assert.equal(staff.code, 200);
  assert.deepEqual(staff.out.cards.map((c) => [c.teamId, c.week]), [[teamId, w(1)], [teamId, w(2)]]);

  // Six a week at most; staff remove a wrong one, photo and row both.
  for (let i = 0; i < 5; i++) assert.equal((await card({ teamId, week: w(1), image: JPEG })).code, 200);
  assert.equal((await card({ teamId, week: w(1), image: JPEG })).code, 409);
  assert.equal((await run(leaguesApi, { query: { action: 'scorecard-remove' }, body: { id: row.id }, ...cap })).code, 403);
  const gone = await run(leaguesApi, { query: { action: 'scorecard-remove' }, body: { id: row.id }, headers: { authorization: 'Bearer tok-admin' } });
  assert.equal(gone.code, 200);
  assert.equal(S.buckets['league-scorecards'].files[row.path], undefined);
  assert.equal(S.db.league_scorecards.some((c) => c.id === row.id), false);
});
