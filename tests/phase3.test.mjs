// Phase 3: saved cards, RETIRED. The venue does not offer them, so what is pinned down here is
// that they are GONE and that nothing else went with them — no Stripe Customer, no Customer
// Session, no card endpoints, and Apple Pay / Google Pay still offered via automatic_payment_methods.
// The real lib/db.js, lib/booking.js, api/account.js and api/checkout.js
// (?action=create-payment-intent, formerly api/create-payment-intent.js)
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
const { createPaymentIntent: createPI } = await import(ROOT + 'api/checkout.js');
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

test('the saved-card helpers are gone from lib/db.js', () => {
  for (const name of ['stripeCustomerIdFor', 'checkoutStripeCustomer', 'paymentElementSession',
                      'listSavedCards', 'removeSavedCard', 'cardSetupIntent']) {
    assert.equal(db[name], undefined, `${name} should no longer be exported`);
  }
  assert.equal(typeof db.accountCustomerForRequest, 'function', 'proving who a request speaks for stays');
});

test('api/account: cards, card-setup and card-remove are no longer actions, signed in or out', async () => {
  world();
  for (const action of ['cards', 'card-setup', 'card-remove']) {
    const out = await run(accountApi, { query: { action } });
    assert.equal(out.code, 400, action);
    assert.equal(out.out.error, 'Unknown action.', action);

    const signedIn = await run(accountApi, { query: { action }, headers: { authorization: 'Bearer tok-murad' },
      body: { paymentMethodId: 'pm_mine' } });
    assert.equal(signedIn.code, 400, `${action} signed in`);
    assert.equal(signedIn.out.error, 'Unknown action.', `${action} signed in`);

    const dev = await run(accountApi, { query: { action }, dev: '2049906530', body: { paymentMethodId: 'pm_mine' } });
    assert.equal(dev.code, 400, `${action} dev account`);
  }
  // Nothing reached Stripe, so the restricted key never needs "Customer Session: write" again,
  // and no card was listed, attached or detached on the way to that 400.
  assert.deepEqual(S.stripe, []);
  // The card that belongs to c-murad is still at Stripe, untouched — retiring is not deleting.
  assert.ok(S.pms.some((pm) => pm.id === 'pm_mine' && pm.customer === 'cus_murad'));
});

const futureDate = (n) => { const d = new Date(`${winnipegTodayISO()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const slot = (n = 3) => ({ dateISO: futureDate(n), bayId: 'B1', startMin: 600, endMin: 660, party: 1, hold: false });

// The one price in this file that is checked in full: 10:00-11:00 on a weekday-or-weekend day at
// $20/$25 an hour. What matters below is that removing saved cards did not disturb it.
test('checkout, signed out: a client secret, the right price, no Stripe Customer, no Customer Session', async () => {
  world();
  const r = await run(createPI, { body: slot() });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(r.out.clientSecret, 'pi_1_secret_x');
  const pi = S.stripe.find((c) => c[0] === 'paymentIntents.create')[1];
  assert.equal(pi.amount, r.out.amount);
  // Plus 12% tax — the default when Payment Settings has no Tax % saved (lib/booking.js taxPctOf).
  assert.ok([2240, 2800].includes(pi.amount), `one hour at the configured rate plus 12% tax, got ${pi.amount}`);
  assert.equal(pi.customer, undefined);
  assert.equal('customerSessionClientSecret' in r.out, false, 'the field is gone from the answer');
  assert.deepEqual(names(), ['paymentIntents.create'], 'the only Stripe call checkout makes');
});

// The point of the old feature was that saved cards were shown only to a PROVEN customer. Retired,
// the guarantee is stronger and simpler: nobody's Stripe Customer is touched at checkout at all.
test('checkout: neither a typed phone nor a real session attaches a Stripe Customer', async () => {
  world();
  const typed = await run(createPI, { body: { ...slot(), phone: '(204) 990-6530', email: 'murad@voltrisai.com' } });
  assert.equal(typed.code, 200, JSON.stringify(typed.out));

  world();
  const signedIn = await run(createPI, { body: slot(), headers: { authorization: 'Bearer tok-murad' } });
  assert.equal(signedIn.code, 200, JSON.stringify(signedIn.out));
  assert.equal(S.stripe.find((c) => c[0] === 'paymentIntents.create')[1].customer, undefined,
    'c-murad already has cus_murad on file and it is still not used');
  assert.ok(!names().includes('customerSessions.create'), 'no Customer Session — the restricted key never needs that permission');
  assert.ok(!names().includes('customers.create'), 'no new Stripe Customer either');
  assert.equal(S.db.customers[0].stripe_customer_id, 'cus_murad', 'the retired column is left exactly as it was');
});

// Apple Pay and Google Pay come from automatic_payment_methods on the PaymentIntent. They never
// depended on the Customer Session, so removing it must not change this line.
test('wallets survive: automatic_payment_methods on, no payment_method_types, signed in or out', async () => {
  for (const headers of [{}, { authorization: 'Bearer tok-murad' }]) {
    world();
    const r = await run(createPI, { body: slot(), headers });
    assert.equal(r.code, 200, JSON.stringify(r.out));
    const pi = S.stripe.find((c) => c[0] === 'paymentIntents.create')[1];
    assert.deepEqual(pi.automatic_payment_methods, { enabled: true });
    assert.equal(JSON.stringify(S.stripe).includes('payment_method_types'), false);
  }
});

test('checkout: past the booking window is refused before anything touches Stripe', async () => {
  world();
  const r = await run(createPI, { body: slot(30), headers: { authorization: 'Bearer tok-murad' } });
  assert.equal(r.code, 400); assert.equal(r.out.code, 'booking_window');
  assert.equal(S.stripe.length, 0);
});

test('checkout: malformed dates are refused by the window check before Stripe', async () => {
  world();
  for (const d of ['2027', '2026-12', '9999', 'tomorrow']) {
    const r = await run(createPI, { body: { ...slot(), dateISO: d }, headers: { authorization: 'Bearer tok-murad' } });
    assert.equal(r.code, 400, d); assert.equal(r.out.code, 'booking_window', d);
  }
  assert.equal(S.stripe.length, 0);
});
