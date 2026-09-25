// Phase 3: saved cards. The real lib/db.js, lib/booking.js, api/account.js and api/create-payment-intent.js
// run end to end; only the Stripe SDK and the Supabase client underneath are fake and record every call.
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
    if (S.fail[`${table}:${st.op}`]) return { data: null, error: S.fail[`${table}:${st.op}`] };
    const rows = S.db[table] = S.db[table] || [];
    if (st.op === 'insert') { const row = { id: `${table}-${++seq}`, ...st.payload }; rows.push(row); return { data: row, error: null }; }
    if (st.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.payload)); return { data: hit, error: null }; }
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
  createClient: () => ({ from: (t) => builder(t), rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async (tok) => (S.tokens[tok] ? { data: { user: { id: S.tokens[tok] } } } : { error: { message: 'bad jwt' }, data: {} }) } }),
} });

// Fake Stripe SDK: records calls, returns shaped objects.
const call = (n, ...a) => { S.stripe.push([n, ...a]); };
class FakeStripe {
  constructor() {
    this.customers = {
      create: async (p) => { call('customers.create', p); return { id: `cus_${++seq}` }; },
      del: async (id) => { call('customers.del', id); return { id, deleted: true }; },
      listPaymentMethods: async (id) => { call('customers.listPaymentMethods', id); return { data: S.pms.filter((p) => p.customer === id) }; },
    };
    this.customerSessions = { create: async (p) => { call('customerSessions.create', p); return { client_secret: 'cuss_secret' }; } };
    this.setupIntents = { create: async (p) => { call('setupIntents.create', p); return { client_secret: 'seti_secret' }; } };
    this.paymentMethods = {
      retrieve: async (id) => { const pm = S.pms.find((p) => p.id === id); if (!pm) throw new Error('No such payment method'); return pm; },
      detach: async (id) => { call('paymentMethods.detach', id); return { id }; },
    };
    this.paymentIntents = { create: async (p) => { call('paymentIntents.create', p); return { id: 'pi_1', client_secret: 'pi_1_secret_x' }; } };
  }
}
mock.module(ROOT + 'node_modules/stripe/esm/stripe.esm.node.js', { defaultExport: FakeStripe });

const db = await import(ROOT + 'lib/db.js');
const { default: accountApi } = await import(ROOT + 'api/account.js');
const { default: createPI } = await import(ROOT + 'api/create-payment-intent.js');
const { winnipegTodayISO } = await import(ROOT + 'lib/booking.js');

const BAYS = [{ id: 'B1', name: 'Bay 1' }];
function world(extra = {}) {
  seq = 0;
  Object.assign(S, { stripe: [], fail: {}, tokens: { 'tok-murad': 'user-murad' }, pms: [
      { id: 'pm_mine', customer: 'cus_murad', type: 'card', card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2028, wallet: { type: 'apple_pay' } } },
      { id: 'pm_bank', customer: 'cus_murad', type: 'us_bank_account' },
      { id: 'pm_other', customer: 'cus_someone', type: 'card', card: { brand: 'mastercard', last4: '4444', exp_month: 1, exp_year: 2030 } },
    ],
    db: {
      customers: [
        { id: 'c-murad', name: 'Murad', phone: '+12049906530', email: 'murad@voltrisai.com', user_id: 'user-murad', stripe_customer_id: 'cus_murad' },
        { id: 'c-new', name: 'New Person', phone: '+12045550100', email: null, user_id: 'user-new', stripe_customer_id: null },
      ],
      settings: [{ id: 1, bays: BAYS, hours: { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] },
        rates: { weekdayOffPeak: 20, weekdayPeak: 25, weekendOffPeak: 25, weekendPeak: 25, peakStartHour: 17 }, min_mins: 60, max_party: 4, slot_step: 30,
        booking_window: { regularDays: 10, leagueDays: 60 } }],
      bookings: [], schedule_overrides: [], league_members: [], leagues: [],
      ...extra,
    } });
}
async function run(handler, { query = {}, body = {}, headers = {}, dev } = {}) {
  let code = 200, out;
  const req = { method: 'POST', query, body, headers: { host: 'localhost', ...headers }, socket: {} };
  if (dev) req.devAccountPhone = dev;
  const res = { status(c) { code = c; return this; }, json(b) { out = b; return this; } };
  await handler(req, res);
  return { code, out };
}
const names = () => S.stripe.map((c) => c[0]);

test('accountCustomerForRequest: session token, dev marker, forged token, nothing', async () => {
  world();
  assert.equal((await db.accountCustomerForRequest({ headers: { authorization: 'Bearer tok-murad' } })).id, 'c-murad');
  assert.equal((await db.accountCustomerForRequest({ headers: {}, devAccountPhone: '2049906530' })).id, 'c-murad');
  assert.equal(await db.accountCustomerForRequest({ headers: { authorization: 'Bearer forged' } }), null);
  assert.equal(await db.accountCustomerForRequest({ headers: {} }), null);
});

test('stripeCustomerIdFor: reuses, creates and links, loses a race cleanly, survives a missing column', async () => {
  world();
  assert.equal(await db.stripeCustomerIdFor(new FakeStripe(), S.db.customers[0]), 'cus_murad');
  assert.ok(!names().includes('customers.create'), 'existing link reused without calling Stripe');

  const created = await db.stripeCustomerIdFor(new FakeStripe(), { ...S.db.customers[1] });
  assert.match(created, /^cus_/); assert.equal(S.db.customers[1].stripe_customer_id, created);
  assert.equal(S.stripe.find((c) => c[0] === 'customers.create')[1].metadata.invictus_customer_id, 'c-new');

  world(); S.stripe = [];
  const stale = { ...S.db.customers[1] };                 // our copy says "no link yet"...
  S.db.customers[1].stripe_customer_id = 'cus_winner';    // ...but another checkout just linked one
  assert.equal(await db.stripeCustomerIdFor(new FakeStripe(), stale), 'cus_winner');
  assert.ok(names().includes('customers.del'), 'the duplicate Stripe Customer is deleted');

  world(); S.fail['customers:update'] = { message: 'column "stripe_customer_id" does not exist' };
  assert.equal(await db.stripeCustomerIdFor(new FakeStripe(), { ...S.db.customers[1] }), null);
  assert.ok(names().includes('customers.del'), 'no orphan Stripe Customer left behind');
});

test('listSavedCards: cards only, shaped for the page', async () => {
  world();
  assert.deepEqual(await db.listSavedCards(new FakeStripe(), 'cus_murad'),
    [{ id: 'pm_mine', brand: 'visa', last4: '4242', expMonth: 4, expYear: 2028, wallet: 'apple_pay' }]);
  assert.deepEqual(await db.listSavedCards(new FakeStripe(), null), []);
});

test("removeSavedCard: cannot remove someone else's card", async () => {
  world();
  assert.equal((await db.removeSavedCard(new FakeStripe(), 'cus_murad', 'pm_other')).code, 404);
  assert.equal((await db.removeSavedCard(new FakeStripe(), 'cus_murad', 'pm_nope')).code, 404);
  assert.ok(!names().includes('paymentMethods.detach'));
  assert.equal((await db.removeSavedCard(new FakeStripe(), 'cus_murad', 'pm_mine')).ok, true);
  assert.deepEqual(S.stripe.find((c) => c[0] === 'paymentMethods.detach'), ['paymentMethods.detach', 'pm_mine']);
});

test('SetupIntent and Customer Session parameters follow Stripe guidance (no payment_method_types)', async () => {
  world();
  await db.cardSetupIntent(new FakeStripe(), 'cus_murad');
  await db.paymentElementSession(new FakeStripe(), 'cus_murad');
  const si = S.stripe.find((c) => c[0] === 'setupIntents.create')[1];
  assert.deepEqual(si, { customer: 'cus_murad', usage: 'off_session' });
  const cs = S.stripe.find((c) => c[0] === 'customerSessions.create')[1];
  assert.equal(cs.customer, 'cus_murad');
  assert.equal(cs.components.payment_element.enabled, true);
  assert.equal(cs.components.payment_element.features.payment_method_save, 'enabled');
  assert.equal(cs.components.payment_element.features.payment_method_redisplay, 'enabled');
  assert.ok(JSON.stringify(S.stripe).indexOf('payment_method_types') === -1);
});

test('api/account cards: signed out 401; list; add; remove only own', async () => {
  world();
  assert.equal((await run(accountApi, { query: { action: 'cards' } })).code, 401);
  const list = await run(accountApi, { query: { action: 'cards' }, headers: { authorization: 'Bearer tok-murad' } });
  assert.equal(list.out.cards.length, 1);
  const setup = await run(accountApi, { query: { action: 'card-setup' }, headers: { authorization: 'Bearer tok-murad' } });
  assert.equal(setup.out.clientSecret, 'seti_secret');
  const theirs = await run(accountApi, { query: { action: 'card-remove' }, headers: { authorization: 'Bearer tok-murad' }, body: { paymentMethodId: 'pm_other' } });
  assert.equal(theirs.code, 404);
  const mine = await run(accountApi, { query: { action: 'card-remove' }, dev: '2049906530', body: { paymentMethodId: 'pm_mine' } });
  assert.equal(mine.out.ok, true);
});

const futureDate = (n) => { const d = new Date(`${winnipegTodayISO()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const slot = (n = 3) => ({ dateISO: futureDate(n), bayId: 'B1', startMin: 600, endMin: 660, party: 1, hold: false });

test('checkout, signed out: no Stripe Customer, no customer session', async () => {
  world();
  const r = await run(createPI, { body: slot() });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  const pi = S.stripe.find((c) => c[0] === 'paymentIntents.create')[1];
  assert.equal(pi.customer, undefined); assert.equal(r.out.customerSessionClientSecret, null);
});

test("checkout: typing a customer's phone does NOT expose their saved cards", async () => {
  world();
  const r = await run(createPI, { body: { ...slot(), phone: '(204) 990-6530', email: 'murad@voltrisai.com' } });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(S.stripe.find((c) => c[0] === 'paymentIntents.create')[1].customer, undefined);
  assert.equal(r.out.customerSessionClientSecret, null);
  assert.ok(!names().includes('customerSessions.create'));
});

test('checkout, signed in: PaymentIntent attached to their Stripe Customer, session returned', async () => {
  world();
  const r = await run(createPI, { body: slot(), headers: { authorization: 'Bearer tok-murad' } });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(S.stripe.find((c) => c[0] === 'paymentIntents.create')[1].customer, 'cus_murad');
  assert.equal(r.out.customerSessionClientSecret, 'cuss_secret');
  assert.ok(JSON.stringify(S.stripe).indexOf('payment_method_types') === -1);
});

test('checkout: a Stripe failure on saved cards still lets the customer pay', async () => {
  world();
  const orig = FakeStripe.prototype;
  S.db.customers[0].stripe_customer_id = null;
  const r0 = { ...FakeStripe };
  // Make customer creation fail for this run only.
  const StripeMod = await import(ROOT + 'node_modules/stripe/esm/stripe.esm.node.js');
  const failing = new StripeMod.default(); failing.customers.create = async () => { throw new Error('Stripe is down'); };
  assert.equal(await db.checkoutStripeCustomer(failing, { headers: { authorization: 'Bearer tok-murad' } }), null);
  void orig; void r0;
});

test('checkout: past the booking window is refused before anything touches Stripe', async () => {
  world();
  const r = await run(createPI, { body: slot(30), headers: { authorization: 'Bearer tok-murad' } });
  assert.equal(r.code, 400); assert.equal(r.out.code, 'booking_window');
  assert.equal(S.stripe.length, 0);
});

test('card-remove for a customer with no Stripe link -> 404 and NO Stripe customer created', async () => {
  world();
  const r = await run(accountApi, { query: { action: 'card-remove' }, headers: { authorization: 'Bearer tok-new' }, body: { paymentMethodId: 'pm_fake' } });
  assert.equal(r.code, 401, 'tok-new is not a known token in this world');
  S.tokens['tok-new'] = 'user-new';
  const r2 = await run(accountApi, { query: { action: 'card-remove' }, headers: { authorization: 'Bearer tok-new' }, body: { paymentMethodId: 'pm_fake' } });
  assert.equal(r2.code, 404);
  assert.ok(!names().includes('customers.create'), 'no Stripe customer was created just to say 404');
  assert.equal(S.db.customers[1].stripe_customer_id, null);
});

test('checkout: malformed dates are refused by the window check before Stripe', async () => {
  world();
  for (const d of ['2027', '2026-12', '9999', 'tomorrow']) {
    const r = await run(createPI, { body: { ...slot(), dateISO: d }, headers: { authorization: 'Bearer tok-murad' } });
    assert.equal(r.code, 400, d); assert.equal(r.out.code, 'booking_window', d);
  }
  assert.equal(S.stripe.length, 0);
});
