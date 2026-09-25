// Security: a prepaid-hours balance must never be readable or spendable from a typed phone
// number. The real api/hour-cards.js and lib/db.js run; only Supabase is fake.
//
// Loyalty points are retired. The three tests that covered api/points.js are gone with the
// endpoint; the last test below is their replacement — it keeps a victim's points_balance in the
// fixture and asserts that a booking path no longer reads, spends or awards against it.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake',
  STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_PUBLISHABLE_KEY: 'pk_test_fake' });
const ROOT = new URL('../', import.meta.url).href;

const S = {};
let seq = 0;
function builder(table) {
  const st = { f: [], op: 'select', payload: null };
  const match = (r) => st.f.every(([k, c, v]) => k === 'eq' ? r[c] === v : k === 'in' ? v.includes(r[c]) : k === 'is' ? (r[c] ?? null) === v
    : k === 'like' ? String(r[c] || '').includes(String(v).replace(/%/g, '')) : k === 'not' ? r[c] != null : k === 'gte' ? r[c] >= v : k === 'lte' ? r[c] <= v : k === 'lt' ? r[c] < v : k === 'neq' ? r[c] !== v : true);
  const run = () => {
    const rows = S.db[table] = S.db[table] || [];
    if (st.op === 'insert') { const row = { id: `${table}-${++seq}`, ...st.payload }; rows.push(row); S.writes.push([table, 'insert']); return { data: row, error: null }; }
    if (st.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.payload)); S.writes.push([table, 'update']); return { data: hit, error: null }; }
    if (st.op === 'delete') { S.db[table] = rows.filter((r) => !match(r)); return { data: null, error: null }; }
    return { data: rows.filter(match), error: null };
  };
  const q = {};
  for (const k of ['eq', 'in', 'is', 'like', 'gte', 'lte', 'lt', 'neq']) q[k] = (c, v) => { st.f.push([k, c, v]); return q; };
  Object.assign(q, {
    select() { return q; }, order() { return q; }, limit() { return q; }, not(c) { st.f.push(['not', c]); return q; }, ilike(c, v) { st.f.push(['eq', c, v]); return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; }, delete() { st.op = 'delete'; return q; },
    maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
    single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; },
    then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
  });
  return q;
}
mock.module(ROOT + 'node_modules/@supabase/supabase-js/dist/index.mjs', { namedExports: {
  createClient: () => ({ from: (t) => builder(t),
    rpc: async (fn, args) => { S.writes.push(['rpc', fn]);
      if (fn === 'adjust_hours') { const c = S.db.customers.find((x) => x.id === args.p_customer); c.hours_balance_min += args.p_delta_min; return { data: c.hours_balance_min, error: null }; }
      return { data: null, error: null }; },
    auth: { getUser: async (tok) => (S.tokens[tok] ? { data: { user: { id: S.tokens[tok] } } } : { error: { message: 'bad jwt' }, data: {} }) } }),
} });

const { default: hourCards } = await import(ROOT + 'api/hour-cards.js');

function world() {
  seq = 0;
  Object.assign(S, { writes: [], tokens: { 'tok-victim': 'user-victim', 'tok-attacker': 'user-attacker' }, db: {
    customers: [
      { id: 'c-victim', name: 'Victim Person', phone: '+12045550111', email: 'victim@example.com', user_id: 'user-victim', hours_balance_min: 600, points_balance: 5000 },
      { id: 'c-attacker', name: 'Attacker', phone: '+12045550999', email: 'att@example.com', user_id: 'user-attacker', hours_balance_min: 0, points_balance: 0 },
    ],
    settings: [{ id: 1, bays: [{ id: 'B1', name: 'Bay 1' }], hours: { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] },
      rates: { weekdayOffPeak: 20, weekdayPeak: 25, weekendOffPeak: 25, weekendPeak: 25, peakStartHour: 17 }, min_mins: 60, max_party: 4, slot_step: 30,
      booking_window: { regularDays: 10, leagueDays: 60 } }],
    bookings: [], schedule_overrides: [], league_members: [], leagues: [],
  } });
}
async function call(handler, action, { body = {}, headers = {}, dev } = {}) {
  let code = 200, out;
  const req = { method: 'POST', query: { action }, body, headers: { host: 'localhost', ...headers }, socket: {} };
  if (dev) req.devAccountPhone = dev;
  const res = { status(c) { code = c; return this; }, json(b) { out = b; return this; }, end() { return this; } };
  await handler(req, res);
  return { code, out };
}
const victim = () => S.db.customers[0];
const soon = (() => { const d = new Date(); d.setDate(d.getDate() + 2); return d.toISOString().slice(0, 10); })();
const slot = { dateISO: soon, bayId: 'B1', startMin: 600, endMin: 660 };
const spent = () => S.writes.filter((w) => w[0] === 'rpc' || w[0] === 'bookings');

test('hours balance: a typed phone number reveals nothing — no name, no balance', async () => {
  world();
  const r = await call(hourCards, 'balance', { body: { phone: '2045550111' } });
  assert.equal(r.out.found, false);
  assert.equal(r.out.signInRequired, true);
  assert.equal(r.out.name, undefined, 'the victim\'s name must not leak');
  assert.equal(r.out.balanceMin, undefined, 'the victim\'s balance must not leak');
});

test('hours balance: a signed-in customer sees only THEIR OWN balance, whatever phone they type', async () => {
  world();
  const own = await call(hourCards, 'balance', { headers: { authorization: 'Bearer tok-victim' } });
  assert.deepEqual([own.out.found, own.out.balanceMin], [true, 600]);
  const sneaky = await call(hourCards, 'balance', { headers: { authorization: 'Bearer tok-attacker' }, body: { phone: '2045550111' } });
  assert.equal(sneaky.out.balanceMin, 0, 'typing the victim\'s number while signed in as someone else returns your own balance');
  assert.equal(sneaky.out.name, 'Attacker');
});

test('hours book: spending someone\'s hours with their phone number alone is refused, nothing moves', async () => {
  world();
  const r = await call(hourCards, 'book', { body: { ...slot, name: 'x', phone: '2045550111' } });
  assert.equal(r.code, 401); assert.equal(r.out.code, 'sign_in');
  assert.equal(victim().hours_balance_min, 600, 'balance untouched');
  assert.deepEqual(spent(), [], 'no hours debited, no booking written');
});

test('hours book: a forged token is refused too', async () => {
  world();
  const r = await call(hourCards, 'book', { headers: { authorization: 'Bearer forged' }, body: { ...slot, phone: '2045550111' } });
  assert.equal(r.code, 401); assert.equal(victim().hours_balance_min, 600);
});

test('hours book: signed in as the attacker + victim\'s phone in the body spends the ATTACKER\'s balance (which is empty)', async () => {
  world();
  const r = await call(hourCards, 'book', { headers: { authorization: 'Bearer tok-attacker' }, body: { ...slot, name: 'x', phone: '2045550111' } });
  assert.equal(r.out.ok, false); assert.equal(r.out.error, 'insufficient');
  assert.equal(victim().hours_balance_min, 600, 'victim untouched');
});

test('hours book: the real owner, signed in, can still spend their hours', async () => {
  world();
  const r = await call(hourCards, 'book', { headers: { authorization: 'Bearer tok-victim' }, body: { ...slot, name: 'Victim Person' } });
  assert.equal(r.out.ok, true, JSON.stringify(r.out));
  assert.equal(victim().hours_balance_min, 540, '60 minutes debited from the right account');
});

test('localhost dev account still works (server-set marker, never client input)', async () => {
  world();
  const r = await call(hourCards, 'balance', { dev: '2045550111' });
  assert.deepEqual([r.out.found, r.out.balanceMin], [true, 600]);
});

test('points are retired: a successful booking neither spends nor awards points', async () => {
  world();
  const r = await call(hourCards, 'book', { headers: { authorization: 'Bearer tok-victim' }, body: { ...slot, name: 'Victim Person' } });
  assert.equal(r.out.ok, true, JSON.stringify(r.out));
  assert.equal(victim().points_balance, 5000, 'the stale balance is left exactly as it was');
  assert.equal(r.out.pointsEarned, undefined, 'no points are reported back to the customer');
  const pointsRpcs = S.writes.filter((w) => w[0] === 'rpc' && String(w[1]).includes('points'));
  assert.deepEqual(pointsRpcs, [], 'adjust_points() is never called');
});

test('points are retired: the endpoint that spent them is gone', async () => {
  await assert.rejects(() => import(ROOT + 'api/points.js'), 'api/points.js must no longer exist');
});
