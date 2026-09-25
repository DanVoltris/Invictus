// Refunds — the path that actually moves money (lib/refunds.js, api/booking-series.js ?action=
// refund, api/booking.js self-cancellation, api/webhook.js charge.refunded).
//
// What is real and what is fake:
//   · lib/refunds.js, lib/db.js, lib/booking.js and all four API handlers are the REAL code.
//   · @supabase/supabase-js is an in-memory fake whose rpc() implements record_refund() and
//     settle_refund() exactly as migrations 0023 and 0033 define them — the over-refund guard, the
//     (booking_id, ref) idempotency, and the release of the reservation on failure all live there,
//     so the tests below exercise the real rule and not a stub that always says yes.
//   · The Stripe SDK is faked and records every call; its `webhooks` helper is the REAL one, so
//     the signed events in the webhook tests are verified by production code.
//
//   node --test --experimental-test-module-mocks tests/refunds.test.mjs
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));
const url = (...p) => pathToFileURL(path.join(ROOT_DIR, ...p)).href;
const WHSEC = 'whsec_test_only_not_a_real_secret';

Object.assign(process.env, {
  SUPABASE_URL: 'https://fake.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
  STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_PUBLISHABLE_KEY: 'pk_test_fake',
  STRIPE_WEBHOOK_SECRET: WHSEC,
});

// ---------------------------------------------------------------------------------------------
// Fake Supabase
// ---------------------------------------------------------------------------------------------
const S = {};
let seq = 0;

function builder(table) {
  const st = { f: [], op: 'select', payload: null, limit: null };
  const match = (r) => st.f.every(([k, c, v]) => (
    k === 'eq' ? r[c] === v
      : k === 'is' ? (r[c] ?? null) === v
        : k === 'neq' ? r[c] !== v
          : k === 'in' ? v.includes(r[c]) : true));
  const run = () => {
    const rows = S.db[table] = S.db[table] || [];
    if (S.fail[`${table}:${st.op}`]) return { data: null, error: S.fail[`${table}:${st.op}`] };
    if (st.op === 'insert') {
      const row = { id: `${table}-${++seq}`, ...st.payload };
      if (table === 'stripe_events' && rows.some((r) => r.id === row.id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
      }
      rows.push(row);
      return { data: row, error: null };
    }
    if (st.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.payload)); return { data: hit, error: null }; }
    if (st.op === 'delete') { S.db[table] = rows.filter((r) => !match(r)); return { data: null, error: null }; }
    let out = rows.filter(match);
    if (st.limit != null) out = out.slice(0, st.limit);
    return { data: out, error: null };
  };
  const q = {};
  for (const k of ['eq', 'is', 'neq', 'in']) q[k] = (c, v) => { st.f.push([k, c, v]); return q; };
  Object.assign(q, {
    select() { return q; }, order() { return q; }, limit(n) { st.limit = n; return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; },
    update(p) { st.op = 'update'; st.payload = p; return q; },
    delete() { st.op = 'delete'; return q; },
    maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
    single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; },
    then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
  });
  return q;
}

// --- record_refund(), migration 0023 §13, in JavaScript ---------------------------------------
function record_refund({ p_booking, p_group, p_amount, p_reason, p_method, p_ref, p_note, p_by }) {
  const amount = Math.round(Number(p_amount) || 0);
  if (amount <= 0) return { error: 'bad_amount' };
  const refunds = S.db.refunds = S.db.refunds || [];
  if (p_ref != null) {
    const hit = refunds.find((r) => r.ref === p_ref && (p_booking != null
      ? r.booking_id === p_booking
      : r.booking_id == null && r.group_id === p_group));
    if (hit) return { already: true, refundId: hit.id, moneyMoved: false };
  }
  let group = p_group ?? null, pi = null;
  if (p_booking != null) {
    const b = (S.db.bookings || []).find((x) => x.id === p_booking);
    if (!b) return { error: 'booking_not_found' };
    const paid = b.amount_cents || 0, done = b.refunded_cents || 0;
    group = p_group ?? b.group_id ?? null;
    pi = b.stripe_payment_intent || null;
    if (done + amount > paid) return { error: 'over_refund', paidCents: paid, refundedCents: done, requested: amount };
  }
  const method = p_method || 'stripe';
  const row = {
    id: `rf-${++seq}`, booking_id: p_booking ?? null, group_id: group, amount_cents: amount, currency: 'cad',
    reason: p_reason ?? null, method, status: method === 'none' ? 'cancelled' : 'pending',
    stripe_payment_intent: pi, stripe_refund_id: null, ref: p_ref ?? null, note: p_note ?? null,
    created_by: p_by ?? null, created_at: new Date().toISOString(), settled_at: null,
  };
  refunds.push(row);
  if (p_booking != null) {
    const b = S.db.bookings.find((x) => x.id === p_booking);
    b.refunded_cents = (b.refunded_cents || 0) + amount;
  }
  if (group != null) {
    const g = (S.db.booking_groups || []).find((x) => x.id === group);
    if (g) g.refunded_cents = (g.refunded_cents || 0) + amount;
  }
  return { ok: true, refundId: row.id, amountCents: amount, moneyMoved: false };
}

// --- settle_refund(), migration 0033 §2, in JavaScript -----------------------------------------
function settle_refund({ p_refund, p_status, p_stripe_refund_id, p_note }) {
  if (!['pending', 'succeeded', 'failed', 'cancelled'].includes(p_status)) return { error: 'bad_status', status: p_status };
  const refunds = S.db.refunds = S.db.refunds || [];
  const r = refunds.find((x) => x.id === p_refund);
  if (!r) return { error: 'not_found' };
  if (r.status === p_status) {
    if (p_stripe_refund_id && !r.stripe_refund_id) r.stripe_refund_id = p_stripe_refund_id;
    return { already: true, refundId: r.id, status: r.status, amountCents: r.amount_cents, moneyMoved: r.status === 'succeeded' };
  }
  // The unique index on stripe_refund_id (0033 §1).
  if (p_stripe_refund_id && refunds.some((x) => x.id !== r.id && x.stripe_refund_id === p_stripe_refund_id)) {
    return { already: true, refundId: r.id, conflict: 'stripe_refund_id', status: r.status, amountCents: r.amount_cents };
  }
  const freed = ['failed', 'cancelled'].includes(p_status) && !['failed', 'cancelled'].includes(r.status);
  const took = ['pending', 'succeeded'].includes(p_status) && ['failed', 'cancelled'].includes(r.status);
  if (took && r.booking_id) {
    const b = (S.db.bookings || []).find((x) => x.id === r.booking_id);
    if (b && (b.refunded_cents || 0) + r.amount_cents > (b.amount_cents || 0)) {
      return { error: 'over_refund', paidCents: b.amount_cents || 0, refundedCents: b.refunded_cents || 0, requested: r.amount_cents };
    }
  }
  if (freed || took) {
    const delta = took ? r.amount_cents : -r.amount_cents;
    if (r.booking_id) {
      const b = (S.db.bookings || []).find((x) => x.id === r.booking_id);
      if (b) b.refunded_cents = Math.max(0, (b.refunded_cents || 0) + delta);
    }
    if (r.group_id) {
      const g = (S.db.booking_groups || []).find((x) => x.id === r.group_id);
      if (g) g.refunded_cents = Math.max(0, (g.refunded_cents || 0) + delta);
    }
  }
  r.status = p_status;
  if (p_stripe_refund_id) r.stripe_refund_id = p_stripe_refund_id;
  if (p_note) r.note = p_note;
  if (p_status === 'succeeded') r.settled_at = new Date().toISOString();
  return { ok: true, refundId: r.id, status: p_status, amountCents: r.amount_cents, moneyMoved: p_status === 'succeeded' };
}

mock.module(url('node_modules', '@supabase', 'supabase-js', 'dist', 'index.mjs'), {
  namedExports: {
    createClient: () => ({
      from: (t) => builder(t),
      rpc: async (fn, args) => {
        S.rpc.push(fn);
        if (fn === 'record_refund') return { data: record_refund(args), error: null };
        if (fn === 'settle_refund') return { data: settle_refund(args), error: null };
        return { data: null, error: null };
      },
      auth: {
        getUser: async (tok) => (S.users[tok]
          ? { data: { user: S.users[tok] }, error: null }
          : { data: { user: null }, error: { message: 'invalid JWT' } }),
      },
    }),
  },
});

// ---------------------------------------------------------------------------------------------
// Fake Stripe (real webhooks helper)
// ---------------------------------------------------------------------------------------------
const RealStripe = createRequire(path.join(ROOT_DIR, 'package.json'))('stripe');
const realWebhooks = new RealStripe('sk_test_dummy').webhooks;

class FakeStripe {
  constructor() {
    this.webhooks = realWebhooks;
    this.charges = { retrieve: async () => ({ billing_details: {} }) };
    this.refunds = {
      create: async (params, opts) => {
        S.stripe.push(['refunds.create', params, opts]);
        if (S.refundThrows) throw S.refundThrows;
        return { id: `re_${++seq}`, object: 'refund', amount: params.amount, status: S.refundStatus || 'succeeded',
          payment_intent: params.payment_intent };
      },
      list: async (params) => { S.stripe.push(['refunds.list', params]); return { data: S.refundList || [] }; },
    };
  }
}
mock.module(url('node_modules', 'stripe', 'esm', 'stripe.esm.node.js'), { defaultExport: FakeStripe });

const db = await import(url('lib', 'db.js'));
const refundsLib = await import(url('lib', 'refunds.js'));
const { default: seriesApi } = await import(url('api', 'booking-series.js'));
const { default: bookingApi } = await import(url('api', 'booking.js'));
const { default: webhookApi } = await import(url('api', 'webhook.js'));

// ---------------------------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------------------------
const CAPS = ['booking.write', 'customer.write', 'money.write', 'config.write', 'staff.manage', 'audit.read'];
const in48h = () => {
  const d = new Date(Date.now() + 48 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};
const in2h = () => new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);

function world(over = {}) {
  seq = 0;
  Object.assign(S, {
    stripe: [], rpc: [], fail: {}, refundThrows: null, refundStatus: 'succeeded', refundList: null,
    users: {
      'tok-admin': { id: 'u-admin', email: 'admin@invictus.test', user_metadata: { source: 'staff_setup' } },
      'tok-emp': { id: 'u-emp', email: 'emp@invictus.test', user_metadata: { source: 'staff_invite' } },
    },
    db: {
      staff: [
        { user_id: 'u-admin', email: 'admin@invictus.test', role: 'admin', is_active: true },
        { user_id: 'u-emp', email: 'emp@invictus.test', role: 'employee', is_active: true },
      ],
      capabilities: CAPS.map((key, sort) => ({ key, sort })),
      role_permissions: CAPS.map((c) => ({ role: 'employee', capability: c, allowed: c === 'booking.write' || c === 'customer.write' })),
      customers: [],
      settings: [{ id: 1, bays: [{ id: 'B1', name: 'Bay 1' }], hours: {}, rates: {}, min_mins: 60, max_party: 4, slot_step: 30 }],
      bookings: [
        // paid $50 by card, 48 hours away — the ordinary case
        { id: '11111111-1111-4111-8111-111111111111', bay_id: 'B1', booking_date: in48h(), start_min: 600, end_min: 660,
          status: 'confirmed', amount_cents: 5000, refunded_cents: 0, stripe_payment_intent: 'pi_paid', group_id: null,
          customer_name: 'Pat Golfer' },
        // paid $50, but starts in two hours — outside the 24-hour policy
        { id: '22222222-2222-4222-8222-222222222222', bay_id: 'B1', booking_date: in2h(), start_min: 0, end_min: 60,
          status: 'confirmed', amount_cents: 5000, refunded_cents: 0, stripe_payment_intent: 'pi_soon', group_id: null },
        // no card on file (paid at the counter / by gift card)
        { id: '33333333-3333-4333-8333-333333333333', bay_id: 'B1', booking_date: in48h(), start_min: 600, end_min: 660,
          status: 'confirmed', amount_cents: 4000, refunded_cents: 0, stripe_payment_intent: null, group_id: null },
      ],
      refunds: [], booking_groups: [], stripe_events: [],
      ...over,
    },
  });
}
const PAID = '11111111-1111-4111-8111-111111111111';
const SOON = '22222222-2222-4222-8222-222222222222';
const NOCARD = '33333333-3333-4333-8333-333333333333';

const booking = (id) => S.db.bookings.find((b) => b.id === id);
const refundRows = () => S.db.refunds;
const stripeCalls = (name) => S.stripe.filter((c) => c[0] === name);

async function call(handler, { method = 'POST', query = {}, body = {}, headers = {} } = {}) {
  let code = 200, out;
  const req = { method, query, body, headers: { host: 'localhost', ...headers }, socket: {} };
  const res = { status(c) { code = c; return this; }, json(b) { out = b; return this; }, send(b) { out = b; return this; }, end() { return this; } };
  await handler(req, res);
  return { code, out };
}
const asStaff = (token, body) => call(seriesApi, { query: { action: 'refund' }, body, headers: { authorization: `Bearer ${token}` } });

beforeEach(() => world());

// ---------------------------------------------------------------------------------------------
// Staff refunds
// ---------------------------------------------------------------------------------------------
test('a full refund: Stripe is called once, the row settles, refunded_cents keeps step', async () => {
  const { code, out } = await asStaff('tok-admin', { bookingId: PAID, reason: 'cancelled by phone' });
  assert.equal(code, 200);
  assert.equal(out.ok, true);
  assert.equal(out.moneyMoved, true);
  assert.equal(out.amountCents, 5000);
  assert.equal(out.status, 'succeeded');

  const calls = stripeCalls('refunds.create');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].payment_intent, 'pi_paid');
  assert.equal(calls[0][1].amount, 5000);
  assert.ok(calls[0][2].idempotencyKey, 'an idempotency key is always sent');

  assert.equal(refundRows().length, 1);
  assert.equal(refundRows()[0].status, 'succeeded');
  assert.equal(refundRows()[0].stripe_refund_id, out.stripeRefundId);
  assert.equal(refundRows()[0].method, 'stripe');
  assert.equal(booking(PAID).refunded_cents, 5000);
});

test('a partial refund, twice, adds up to the whole and never past it', async () => {
  const a = await asStaff('tok-admin', { bookingId: PAID, amountCents: 2000, ref: 'r-a' });
  assert.equal(a.code, 200);
  assert.equal(a.out.amountCents, 2000);
  assert.equal(booking(PAID).refunded_cents, 2000);

  const b = await asStaff('tok-admin', { bookingId: PAID, amountCents: 3000, ref: 'r-b' });
  assert.equal(b.code, 200);
  assert.equal(booking(PAID).refunded_cents, 5000);
  assert.equal(stripeCalls('refunds.create').length, 2);

  // Nothing left. A third attempt is refused before Stripe is touched.
  const c = await asStaff('tok-admin', { bookingId: PAID, amountCents: 100, ref: 'r-c' });
  assert.equal(c.code, 409);
  assert.equal(c.out.code, 'over_refund');
  assert.match(c.out.error, /already been refunded in full/);
  assert.equal(stripeCalls('refunds.create').length, 2, 'no Stripe call for a refund with nothing left');
});

test('refunding more than was paid is refused — by the API and by record_refund itself', async () => {
  const { code, out } = await asStaff('tok-admin', { bookingId: PAID, amountCents: 6000 });
  assert.equal(code, 409);
  assert.equal(out.code, 'over_refund');
  assert.equal(out.moneyMoved, false);
  assert.equal(stripeCalls('refunds.create').length, 0);
  assert.equal(refundRows().length, 0, 'nothing is written down for a refund that is refused');

  // The database guard, on its own — this is what holds when two callers race past the fast path.
  const direct = await db.recordRefund({ bookingId: PAID, amountCents: 6000, ref: 'race' });
  assert.equal(direct.error, 'over_refund');
  assert.equal(direct.paidCents, 5000);
  assert.equal(booking(PAID).refunded_cents, 0, 'a refused record moves no counter');
});

test('the same refund asked for twice moves money once', async () => {
  const first = await asStaff('tok-admin', { bookingId: PAID, amountCents: 2500, ref: 'click-7' });
  const second = await asStaff('tok-admin', { bookingId: PAID, amountCents: 2500, ref: 'click-7' });

  assert.equal(first.code, 200);
  assert.equal(second.code, 200);
  assert.equal(second.out.already, true);
  assert.equal(second.out.moneyMoved, true);
  assert.equal(second.out.refundId, first.out.refundId);
  assert.equal(stripeCalls('refunds.create').length, 1, 'Stripe is called once');
  assert.equal(refundRows().length, 1, 'one row');
  assert.equal(booking(PAID).refunded_cents, 2500, 'counted once');
});

test('a caller that sends no ref is still safe against a double click', async () => {
  await asStaff('tok-admin', { bookingId: PAID, amountCents: 1500 });
  const again = await asStaff('tok-admin', { bookingId: PAID, amountCents: 1500 });
  assert.equal(again.out.already, true);
  assert.equal(stripeCalls('refunds.create').length, 1);
  assert.equal(booking(PAID).refunded_cents, 1500);
});

test('a Stripe failure records nothing as succeeded and gives the money back to the booking', async () => {
  S.refundThrows = Object.assign(new Error('Your card issuer refused the refund.'), { type: 'StripeInvalidRequestError', statusCode: 400 });
  const { code, out } = await asStaff('tok-admin', { bookingId: PAID, ref: 'boom' });

  assert.equal(code, 502);
  assert.equal(out.ok, false);
  assert.equal(out.moneyMoved, false);
  assert.equal(refundRows().length, 1);
  assert.equal(refundRows()[0].status, 'failed');
  assert.equal(refundRows()[0].stripe_refund_id, null);
  assert.equal(refundRows().filter((r) => r.status === 'succeeded').length, 0);
  assert.equal(booking(PAID).refunded_cents, 0, 'the reservation is released so it can be tried again');

  // And it CAN be tried again, with a fresh reference.
  S.refundThrows = null;
  const retry = await asStaff('tok-admin', { bookingId: PAID, ref: 'boom-2' });
  assert.equal(retry.code, 200);
  assert.equal(retry.out.moneyMoved, true);
  assert.equal(booking(PAID).refunded_cents, 5000);
});

test('a restricted key names the two permissions it is missing', async () => {
  // Exactly what the Stripe SDK raises for a 403: RequestSender maps it to StripePermissionError.
  S.refundThrows = Object.assign(new Error("The provided key does not have the required permissions for this endpoint."),
    { type: 'StripePermissionError', statusCode: 403, rawType: 'invalid_request_error' });

  const { code, out } = await asStaff('tok-admin', { bookingId: PAID });
  assert.equal(code, 503);
  assert.equal(out.code, 'stripe_key_permission');
  assert.equal(out.moneyMoved, false);
  assert.equal(out.missingPermissions, 'Refunds: write, Charges: read');
  assert.match(out.error, /Refunds: write/);
  assert.match(out.error, /Charges: read/);
  assert.match(out.error, /Developers → API keys/);
  assert.equal(refundRows()[0].status, 'failed');
  assert.equal(booking(PAID).refunded_cents, 0);

  // The detector, on the shapes Stripe actually produces.
  assert.equal(refundsLib.isKeyPermissionError({ type: 'StripePermissionError' }), true);
  assert.equal(refundsLib.isKeyPermissionError({ statusCode: 403 }), true);
  assert.equal(refundsLib.isKeyPermissionError({ type: 'StripeInvalidRequestError', message: 'No such payment_intent' }), false);
});

test('a staff member without money.write cannot refund anything', async () => {
  const { code, out } = await asStaff('tok-emp', { bookingId: PAID });
  assert.equal(code, 403);
  assert.match(out.error, /money\.write/);
  assert.equal(stripeCalls('refunds.create').length, 0);
  assert.equal(refundRows().length, 0);
  assert.equal(booking(PAID).refunded_cents, 0);

  // ...and neither can a stranger with no session at all.
  const anon = await call(seriesApi, { query: { action: 'refund' }, body: { bookingId: PAID } });
  assert.equal(anon.code, 401);
  assert.equal(stripeCalls('refunds.create').length, 0);
});

test('a booking with no card on file is refused rather than quietly recorded', async () => {
  const { code, out } = await asStaff('tok-admin', { bookingId: NOCARD });
  assert.equal(code, 409);
  assert.equal(out.code, 'no_payment_intent');
  assert.equal(refundRows().length, 0);
});

// ---------------------------------------------------------------------------------------------
// Customer self-cancellation
// ---------------------------------------------------------------------------------------------
test('self-cancellation inside the policy cancels AND refunds', async () => {
  const { code, out } = await call(bookingApi, { body: { id: PAID } });
  assert.equal(code, 200);
  assert.equal(out.ok, true);
  assert.equal(booking(PAID).status, 'cancelled');
  assert.equal(out.refund.moneyMoved, true);
  assert.equal(out.refund.amountCents, 5000);
  assert.match(out.refund.message, /on its way back/);
  assert.equal(stripeCalls('refunds.create').length, 1);
  assert.equal(booking(PAID).refunded_cents, 5000);
});

test('self-cancellation too close to the tee time refunds nothing and cancels nothing', async () => {
  const { code, out } = await call(bookingApi, { body: { id: SOON } });
  assert.equal(code, 403);
  assert.equal(out.code, 'too_late');
  assert.equal(booking(SOON).status, 'confirmed');
  assert.equal(stripeCalls('refunds.create').length, 0);
  assert.equal(refundRows().length, 0);
});

test('self-cancellation with no card on file records the obligation instead of losing it', async () => {
  const { code, out } = await call(bookingApi, { body: { id: NOCARD } });
  assert.equal(code, 200);
  assert.equal(booking(NOCARD).status, 'cancelled');
  assert.equal(out.refund.moneyMoved, false);
  assert.equal(out.refund.amountCents, 4000);
  assert.match(out.refund.message, /the shop will put the money back/);
  assert.equal(refundRows().length, 1);
  assert.equal(refundRows()[0].method, 'manual');
  assert.equal(refundRows()[0].status, 'pending');
  assert.equal(stripeCalls('refunds.create').length, 0);
});

test('a Stripe failure never blocks the cancellation the customer asked for', async () => {
  S.refundThrows = Object.assign(new Error('Stripe is down'), { type: 'StripeAPIError', statusCode: 500 });
  const { code, out } = await call(bookingApi, { body: { id: PAID } });
  assert.equal(code, 200);
  assert.equal(booking(PAID).status, 'cancelled');
  assert.equal(out.refund.moneyMoved, false);
  assert.match(out.refund.message, /has not gone through automatically/);
  assert.equal(refundRows().filter((r) => r.status === 'succeeded').length, 0);
});

test('the lookup tells the page what cancelling would send back', async () => {
  const { out } = await call(bookingApi, { method: 'GET', query: { id: PAID } });
  assert.equal(out.booking.canCancel, true);
  assert.equal(out.booking.paidCents, 5000);
  assert.equal(out.booking.refundableCents, 5000);
});

// ---------------------------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------------------------
const sign = (payload) => realWebhooks.generateTestHeaderString({ payload, secret: WHSEC });
async function fireWebhook(event) {
  const raw = JSON.stringify(event);
  return call(webhookApi, { body: Buffer.from(raw), headers: { 'stripe-signature': sign(raw) } });
}
const chargeRefunded = (over = {}) => ({
  id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', type: 'charge.refunded', livemode: false,
  data: { object: { id: 'ch_1', object: 'charge', payment_intent: 'pi_paid', amount: 5000, ...over } },
});

test('a refund issued from the Stripe dashboard is recorded here', async () => {
  const { code } = await fireWebhook(chargeRefunded({
    refunds: { object: 'list', has_more: false, data: [{ id: 're_dash', object: 'refund', amount: 5000, status: 'succeeded' }] },
  }));
  assert.equal(code, 200);
  assert.equal(refundRows().length, 1);
  const row = refundRows()[0];
  assert.equal(row.booking_id, PAID);
  assert.equal(row.amount_cents, 5000);
  assert.equal(row.status, 'succeeded');
  assert.equal(row.stripe_refund_id, 're_dash');
  assert.equal(row.ref, 'stripe:re_dash');
  assert.equal(booking(PAID).refunded_cents, 5000, 'the portal can no longer refund it a second time');

  // Replayed by Stripe: the event claim stops it, and the ledger is untouched either way.
  assert.equal(refundRows().length, 1);
});

test('the same dashboard refund delivered under a new event id is still recorded once', async () => {
  const r = { id: 're_dash', object: 'refund', amount: 5000, status: 'succeeded' };
  await fireWebhook(chargeRefunded({ refunds: { object: 'list', data: [r] } }));
  await fireWebhook(chargeRefunded({ refunds: { object: 'list', data: [r] } }));
  assert.equal(refundRows().length, 1);
  assert.equal(booking(PAID).refunded_cents, 5000);
});

test('our own refund settles to succeeded when the webhook arrives', async () => {
  S.refundStatus = 'pending';                       // Stripe accepted it but has not settled it
  const issued = await asStaff('tok-admin', { bookingId: PAID, ref: 'slow' });
  assert.equal(issued.out.status, 'pending');
  assert.equal(issued.out.moneyMoved, false);
  assert.equal(refundRows()[0].status, 'pending');

  await fireWebhook(chargeRefunded({
    refunds: { object: 'list', data: [{ id: issued.out.stripeRefundId, object: 'refund', amount: 5000, status: 'succeeded' }] },
  }));
  assert.equal(refundRows().length, 1, 'settled in place — no second row');
  assert.equal(refundRows()[0].status, 'succeeded');
  assert.equal(booking(PAID).refunded_cents, 5000);
});

test('a refund of ours whose id was never written down is attached, not duplicated', async () => {
  // The shape left behind when the process dies between the Stripe call and the settle.
  const rec = await db.recordRefund({ bookingId: PAID, amountCents: 5000, ref: 'crashed', method: 'stripe' });
  assert.equal(refundRows()[0].status, 'pending');
  assert.equal(refundRows()[0].stripe_refund_id, null);

  await fireWebhook(chargeRefunded({
    refunds: { object: 'list', data: [{ id: 're_lost', object: 'refund', amount: 5000, status: 'succeeded' }] },
  }));
  assert.equal(refundRows().length, 1, 'the orphan row is settled, not joined by a second one');
  assert.equal(refundRows()[0].id, rec.refundId);
  assert.equal(refundRows()[0].stripe_refund_id, 're_lost');
  assert.equal(refundRows()[0].status, 'succeeded');
  assert.equal(booking(PAID).refunded_cents, 5000, 'counted once, not twice');
});

test('a Stripe refund with no booking here is logged, not failed', async () => {
  const { code } = await fireWebhook(chargeRefunded({
    payment_intent: 'pi_gift_card_purchase',
    refunds: { object: 'list', data: [{ id: 're_gift', object: 'refund', amount: 2500, status: 'succeeded' }] },
  }));
  assert.equal(code, 200, 'acknowledged, so Stripe stops retrying');
  assert.equal(refundRows().length, 0);
});

test('a truncated refunds list is re-read from Stripe', async () => {
  S.refundList = [{ id: 're_page', object: 'refund', amount: 1000, status: 'succeeded' }];
  await fireWebhook(chargeRefunded({ refunds: { object: 'list', has_more: true, data: [] } }));
  assert.equal(stripeCalls('refunds.list').length, 1);
  assert.equal(refundRows().length, 1);
  assert.equal(refundRows()[0].stripe_refund_id, 're_page');
  assert.equal(booking(PAID).refunded_cents, 1000);
});

test('an unsigned charge.refunded is refused', async () => {
  const raw = JSON.stringify(chargeRefunded({ refunds: { object: 'list', data: [{ id: 're_x', amount: 5000, status: 'succeeded' }] } }));
  const { code } = await call(webhookApi, { body: Buffer.from(raw), headers: { 'stripe-signature': 't=1,v1=deadbeef' } });
  assert.equal(code, 400);
  assert.equal(refundRows().length, 0);
});
