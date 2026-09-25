// Card holds — authorise at booking, capture at check-in (migration 0034).
//
// THE ONE FACT EVERY TEST BELOW EXISTS FOR: a card authorisation expires. Stripe documents about
// seven days for an online card payment, and when the window passes the money is released and
// cannot be captured — ever. The booking window here is 10 days for everyone and 60 for league
// players, so a large minority of bookings CANNOT be held and must be charged in full at booking
// instead. Get the cut-off wrong in either direction and the venue either loses the money or
// charges people months early.
//
// What is real and what is fake:
//   · lib/booking.js, lib/holds.js, lib/refunds.js, lib/db.js and the four API handlers are the
//     REAL code.
//   · @supabase/supabase-js is an in-memory fake; its rpc() implements record_refund() and
//     settle_refund() from migrations 0023/0033 so the refund half of the cancellation tests
//     exercises the real rule.
//   · The Stripe SDK is faked and records every call. Its `webhooks` helper is the REAL one, so the
//     signed events below are verified by production code.
//
//   node --test --experimental-test-module-mocks tests/holds.test.mjs
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
  const st = { f: [], op: 'select', payload: null, limit: null, order: null };
  const match = (r) => st.f.every(([k, c, v]) => (
    k === 'eq' ? r[c] === v
      : k === 'is' ? (r[c] ?? null) === v
        : k === 'neq' ? r[c] !== v
          : k === 'in' ? v.includes(r[c])
            : k === 'lt' ? r[c] < v : k === 'gte' ? r[c] >= v : k === 'lte' ? r[c] <= v
              : k === 'not' ? r[c] != null : true));
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
    if (st.order) {
      const [col, asc] = st.order;
      out = [...out].sort((a, b) => (String(a[col] ?? '') < String(b[col] ?? '') ? -1 : 1) * (asc ? 1 : -1));
    }
    if (st.limit != null) out = out.slice(0, st.limit);
    return { data: out, error: null };
  };
  const q = {};
  for (const k of ['eq', 'is', 'neq', 'in', 'lt', 'gte', 'lte']) q[k] = (c, v) => { st.f.push([k, c, v]); return q; };
  Object.assign(q, {
    select() { return q; },
    order(c, o) { st.order = [c, !o || o.ascending !== false]; return q; },
    limit(n) { st.limit = n; return q; },
    not(c) { st.f.push(['not', c]); return q; },
    ilike(c, v) { st.f.push(['eq', c, v]); return q; },
    like(c, v) { st.f.push(['eq', c, v]); return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; },
    update(p) { st.op = 'update'; st.payload = p; return q; },
    delete() { st.op = 'delete'; return q; },
    maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
    single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; },
    then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
  });
  return q;
}

// record_refund() / settle_refund(), migrations 0023 §13 and 0033 §2, in JavaScript. Only what the
// cancellation tests below need — the full pair is exercised in tests/refunds.test.mjs.
function record_refund({ p_booking, p_group, p_amount, p_reason, p_method, p_ref, p_note, p_by }) {
  const amount = Math.round(Number(p_amount) || 0);
  if (amount <= 0) return { error: 'bad_amount' };
  const refunds = S.db.refunds = S.db.refunds || [];
  if (p_ref != null) {
    const hit = refunds.find((r) => r.ref === p_ref && r.booking_id === p_booking);
    if (hit) return { already: true, refundId: hit.id, moneyMoved: false };
  }
  const b = (S.db.bookings || []).find((x) => x.id === p_booking);
  if (!b) return { error: 'booking_not_found' };
  const paid = b.amount_cents || 0, done = b.refunded_cents || 0;
  if (done + amount > paid) return { error: 'over_refund', paidCents: paid, refundedCents: done, requested: amount };
  const row = {
    id: `rf-${++seq}`, booking_id: p_booking, group_id: p_group ?? b.group_id ?? null, amount_cents: amount,
    reason: p_reason ?? null, method: p_method || 'stripe', status: 'pending',
    stripe_payment_intent: b.stripe_payment_intent || null, stripe_refund_id: null, ref: p_ref ?? null,
    note: p_note ?? null, created_by: p_by ?? null, settled_at: null,
  };
  refunds.push(row);
  b.refunded_cents = done + amount;
  return { ok: true, refundId: row.id, amountCents: amount, moneyMoved: false };
}
function settle_refund({ p_refund, p_status, p_stripe_refund_id, p_note }) {
  const r = (S.db.refunds || []).find((x) => x.id === p_refund);
  if (!r) return { error: 'not_found' };
  if (r.status === p_status) return { already: true, refundId: r.id, status: r.status, amountCents: r.amount_cents };
  if (['failed', 'cancelled'].includes(p_status) && !['failed', 'cancelled'].includes(r.status)) {
    const b = (S.db.bookings || []).find((x) => x.id === r.booking_id);
    if (b) b.refunded_cents = Math.max(0, (b.refunded_cents || 0) - r.amount_cents);
  }
  r.status = p_status;
  if (p_stripe_refund_id) r.stripe_refund_id = p_stripe_refund_id;
  if (p_note) r.note = p_note;
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
    this.charges = { retrieve: async (id) => { S.stripe.push(['charges.retrieve', id]); return S.charge || { billing_details: {} }; } };
    this.paymentIntents = {
      create: async (p) => {
        S.stripe.push(['paymentIntents.create', p]);
        const id = `pi_${++seq}`;
        S.pis[id] = { id, object: 'payment_intent', amount: p.amount, metadata: p.metadata || {},
          status: p.capture_method === 'manual' ? 'requires_capture' : 'succeeded',
          amount_capturable: p.capture_method === 'manual' ? p.amount : 0,
          amount_received: p.capture_method === 'manual' ? 0 : p.amount,
          latest_charge: 'ch_1', client_secret: `${id}_secret_x` };
        return S.pis[id];
      },
      retrieve: async (id) => { if (!S.pis[id]) throw new Error('No such payment_intent'); return S.pis[id]; },
      capture: async (id, params, opts) => {
        S.stripe.push(['paymentIntents.capture', id, params, opts]);
        if (S.captureThrows) throw S.captureThrows;
        const pi = S.pis[id] || { id };
        const took = params && params.amount_to_capture != null ? params.amount_to_capture : pi.amount;
        Object.assign(pi, { status: 'succeeded', amount_received: took, amount_capturable: 0 });
        return pi;
      },
      cancel: async (id, params, opts) => {
        S.stripe.push(['paymentIntents.cancel', id, params, opts]);
        if (S.cancelThrows) throw S.cancelThrows;
        const pi = S.pis[id] || { id };
        Object.assign(pi, { status: 'canceled', amount_capturable: 0 });
        return pi;
      },
    };
    this.refunds = {
      create: async (params, opts) => {
        S.stripe.push(['refunds.create', params, opts]);
        return { id: `re_${++seq}`, object: 'refund', amount: params.amount, status: 'succeeded', payment_intent: params.payment_intent };
      },
      list: async () => ({ data: [] }),
    };
  }
}
mock.module(url('node_modules', 'stripe', 'esm', 'stripe.esm.node.js'), { defaultExport: FakeStripe });

// The receipt is not what this file is about, and the real one writes to the outbox.
mock.module(url('lib', 'notify.js'), { namedExports: { notifyBookingConfirmed: async () => ({ ok: true }) } });

const { holdPlan, holdSettings, HOLD_DEFAULTS, normalizeSettings, winnipegTodayISO } = await import(url('lib', 'booking.js'));
const { createPaymentIntent: createPI, confirmBooking } = await import(url('api', 'checkout.js'));
const { default: seriesApi } = await import(url('api', 'booking-series.js'));
const { default: bookingApi } = await import(url('api', 'booking.js'));
const { default: webhookApi } = await import(url('api', 'webhook.js'));

// ---------------------------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------------------------
const CAPS = ['booking.write', 'customer.write', 'money.write', 'config.write', 'staff.manage', 'audit.read'];
const HELD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STALE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const dayAhead = (n) => { const d = new Date(`${winnipegTodayISO()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

function world(over = {}) {
  seq = 0;
  Object.assign(S, {
    stripe: [], rpc: [], fail: {}, pis: {}, charge: null, captureThrows: null, cancelThrows: null,
    users: {
      'tok-admin': { id: 'u-admin', email: 'admin@invictus.test' },
      'tok-emp': { id: 'u-emp', email: 'emp@invictus.test' },
    },
    db: {
      staff: [
        { user_id: 'u-admin', email: 'admin@invictus.test', role: 'admin', is_active: true },
        { user_id: 'u-emp', email: 'emp@invictus.test', role: 'employee', is_active: true },
      ],
      capabilities: CAPS.map((key, sort) => ({ key, sort })),
      // The employee has Bookings but NOT Money — the whole point of the permission tests below.
      role_permissions: CAPS.map((c) => ({ role: 'employee', capability: c, allowed: c === 'booking.write' || c === 'customer.write' })),
      settings: [{
        id: 1, bays: [{ id: 'B1', name: 'Bay 1' }],
        hours: { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] },
        rates: { weekdayOffPeak: 20, weekdayPeak: 20, weekendOffPeak: 25, weekendPeak: 25, peakStartHour: 17 },
        min_mins: 60, max_party: 4, slot_step: 30,
        booking_window: { regularDays: 10, leagueDays: 60 },
        pay: { captureMethod: 'Credit Card Hold' },
      }],
      bookings: [
        // $25 HELD on a card, session in two days, hold good for another five.
        { id: HELD, bay_id: 'B1', booking_date: dayAhead(2), start_min: 600, end_min: 660, status: 'confirmed',
          amount_cents: 0, refunded_cents: 0, authorized_cents: 2500, payment_state: 'held',
          hold_expires_at: inHours(120), stripe_payment_intent: 'pi_held', customer_name: 'Pat Golfer', group_id: null },
        // $50 CHARGED in full at booking — the far-ahead path.
        { id: PAID, bay_id: 'B1', booking_date: dayAhead(9), start_min: 600, end_min: 660, status: 'confirmed',
          amount_cents: 5000, refunded_cents: 0, authorized_cents: null, payment_state: 'paid',
          hold_expires_at: null, stripe_payment_intent: 'pi_paid', customer_name: 'Sam Golfer', group_id: null },
        // A no-show whose hold lapsed while nobody pressed anything. The money is gone.
        { id: STALE, bay_id: 'B1', booking_date: dayAhead(-8), start_min: 600, end_min: 660, status: 'confirmed',
          amount_cents: 0, refunded_cents: 0, authorized_cents: 4000, payment_state: 'held',
          hold_expires_at: inHours(-6), stripe_payment_intent: 'pi_stale', customer_name: 'Gone Golfer', group_id: null },
      ],
      customers: [], refunds: [], booking_groups: [], stripe_events: [],
      schedule_overrides: [], league_members: [], leagues: [], sms_consents: [],
      ...over,
    },
  });
  S.pis.pi_held = { id: 'pi_held', status: 'requires_capture', amount: 2500, amount_capturable: 2500, metadata: {} };
  S.pis.pi_paid = { id: 'pi_paid', status: 'succeeded', amount: 5000, amount_received: 5000, metadata: {} };
  S.pis.pi_stale = { id: 'pi_stale', status: 'requires_capture', amount: 4000, amount_capturable: 4000, metadata: {} };
}

const booking = (id) => S.db.bookings.find((b) => b.id === id);
const calls = (name) => S.stripe.filter((c) => c[0] === name);

async function call(handler, { method = 'POST', query = {}, body = {}, headers = {} } = {}) {
  let code = 200, out;
  const req = { method, query, body, headers: { host: 'localhost', ...headers }, socket: {} };
  const res = { status(c) { code = c; return this; }, json(b) { out = b; return this; }, send(b) { out = b; return this; }, end() { return this; } };
  await handler(req, res);
  return { code, out };
}
const staffPost = (token, action, body) => call(seriesApi, { query: { action }, body, headers: { authorization: `Bearer ${token}` } });
const sign = (payload) => realWebhooks.generateTestHeaderString({ payload, secret: WHSEC });
const fire = (event) => {
  const raw = JSON.stringify(event);
  return call(webhookApi, { body: Buffer.from(raw), headers: { 'stripe-signature': sign(raw) } });
};

beforeEach(() => world());

// =============================================================================================
// 1. The decision: hold or charge
// =============================================================================================

test('the cut-off is a setting, defaults to 5 days, and can never exceed the authorisation window', () => {
  assert.equal(HOLD_DEFAULTS.cutoffDays, 5);
  assert.equal(HOLD_DEFAULTS.authWindowDays, 7);

  const d = holdSettings(null);
  assert.equal(d.enabled, true, 'the Payment Settings screen already says "Credit Card Hold"');
  assert.equal(d.cutoffDays, 5);

  // The owner can move it without a deploy…
  assert.equal(holdSettings({ hold: { cutoffDays: 3 } }).cutoffDays, 3);
  // …but not past the cliff. A cut-off of 30 days against a 7-day authorisation would authorise
  // bookings that can never be captured, and lose the money silently.
  assert.equal(holdSettings({ hold: { cutoffDays: 30 } }).cutoffDays, 7);
  assert.equal(holdSettings({ hold: { cutoffDays: 30, authWindowDays: 10 } }).cutoffDays, 10);
  // Rubbish falls back rather than disabling holds or authorising for ever.
  assert.equal(holdSettings({ hold: { cutoffDays: 'soon' } }).cutoffDays, 5);
  assert.equal(holdSettings({ hold: { cutoffDays: -4 } }).cutoffDays, 5);

  // The dropdown's other two values mean "charge", and they are read from the same place.
  assert.equal(holdSettings({ captureMethod: 'Payment Upfront' }).enabled, false);
  assert.equal(holdSettings({ captureMethod: 'No Payment' }).enabled, false);
});

test('THE BOUNDARY: 5 days ahead is held, one minute past it is charged', () => {
  const settings = normalizeSettings(S.db.settings[0]);
  // 12:00 Winnipeg on a fixed day, so the arithmetic below is not at the mercy of when the suite runs.
  const now = new Date('2026-06-10T17:00:00Z');    // 12:00 CDT
  const at = (dateISO, startMin) => holdPlan({ settings, dateISO, startMin, now });

  assert.equal(at('2026-06-15', 12 * 60).mode, 'hold', 'exactly 120 hours ahead — the last held booking');
  assert.equal(at('2026-06-15', 12 * 60 + 1).mode, 'charge', 'one minute past the cut-off');
  assert.equal(at('2026-06-15', 11 * 60 + 59).mode, 'hold');
  assert.equal(at('2026-06-10', 14 * 60).mode, 'hold', 'this afternoon');
  assert.equal(at('2026-06-20', 12 * 60).mode, 'charge', 'ten days out — the regular booking window');
  assert.equal(at('2026-08-01', 12 * 60).mode, 'charge', 'a league player booking 60 days out');

  // The hold's deadline runs from the BOOKING, not from the session: seven days from now.
  const held = at('2026-06-15', 12 * 60);
  assert.equal(held.captureMethod, 'manual');
  assert.equal(held.holdExpiresAt, new Date('2026-06-17T17:00:00Z').toISOString());
  assert.equal(held.captureBy, held.holdExpiresAt);
  assert.match(held.message, /held, not charged/);

  const charged = at('2026-06-20', 12 * 60);
  assert.equal(charged.captureMethod, 'automatic');
  assert.equal(charged.holdExpiresAt, null);
  assert.match(charged.message, /charged in full now/);
});

test('"Payment Upfront" turns every booking back into a charge, however near', () => {
  S.db.settings[0].pay = { captureMethod: 'Payment Upfront' };
  const settings = normalizeSettings(S.db.settings[0]);
  assert.equal(holdPlan({ settings, dateISO: dayAhead(1), startMin: 600 }).mode, 'charge');
});

// =============================================================================================
// 2. Checkout: what Stripe is actually asked for, and what the customer is told
// =============================================================================================

// 15:00–16:00, clear of the three seeded bookings above (all of which are 10:00–11:00).
const slot = (days) => ({ dateISO: dayAhead(days), bayId: 'B1', startMin: 900, endMin: 960, party: 1, hold: false });

test('a NEAR booking is authorised, not charged — capture_method: manual on the PaymentIntent', async () => {
  const r = await call(createPI, { body: slot(2) });
  assert.equal(r.code, 200, JSON.stringify(r.out));

  const params = calls('paymentIntents.create')[0][1];
  assert.equal(params.capture_method, 'manual', 'THE line that makes it a hold');
  assert.equal(params.metadata.paymentMode, 'hold');
  assert.ok(params.metadata.holdExpiresAt, 'the deadline travels on the PaymentIntent');
  // Wallets are untouched: they come from automatic_payment_methods, not from capture_method.
  assert.deepEqual(params.automatic_payment_methods, { enabled: true });

  // …and the customer is told BEFORE they confirm.
  assert.equal(r.out.paymentMode, 'hold');
  assert.equal(r.out.payment.mode, 'hold');
  assert.equal(r.out.payment.captureMethod, 'manual');
  assert.equal(r.out.payment.captureBy, params.metadata.holdExpiresAt);
  assert.equal(r.out.payment.cutoffDays, 5);
  assert.match(r.out.payment.message, /held, not charged/);
  assert.equal(r.out.payment.amountCents, r.out.amount);
});

test('a FAR booking is charged in full at booking, exactly as before', async () => {
  const r = await call(createPI, { body: slot(9) });
  assert.equal(r.code, 200, JSON.stringify(r.out));

  const params = calls('paymentIntents.create')[0][1];
  assert.equal('capture_method' in params, false,
    'nothing is sent: Stripe already defaults to automatic, so the charge-now request is unchanged');
  assert.equal(params.metadata.paymentMode, 'charge');
  assert.equal(params.metadata.holdExpiresAt, '');

  assert.equal(r.out.paymentMode, 'charge');
  assert.equal(r.out.payment.captureBy, null);
  assert.match(r.out.payment.message, /charged in full now/);
});

test('confirm-booking records a HELD booking from requires_capture, and charges nothing to it', async () => {
  const made = await call(createPI, { body: slot(2) });
  const piId = made.out.clientSecret.split('_secret')[0];

  const r = await call(confirmBooking, { body: { paymentIntentId: piId, name: 'Pat', email: 'pat@x.test' } });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(r.out.paymentState, 'held');
  assert.ok(r.out.holdExpiresAt, 'the page can say when the hold runs out');

  const row = S.db.bookings.find((b) => b.stripe_payment_intent === piId);
  assert.ok(row, 'the booking exists, so the slot is taken');
  assert.equal(row.status, 'confirmed');
  assert.equal(row.payment_state, 'held');
  assert.equal(row.authorized_cents, made.out.amount);
  // amount_cents stays 0 while held. This is what stops anyone refunding money that was never taken.
  assert.equal(row.amount_cents, 0);
  assert.ok(row.hold_expires_at);
});

test('confirm-booking still records a far-ahead booking as PAID', async () => {
  const made = await call(createPI, { body: slot(9) });
  const piId = made.out.clientSecret.split('_secret')[0];
  const r = await call(confirmBooking, { body: { paymentIntentId: piId } });
  assert.equal(r.out.paymentState, 'paid');

  const row = S.db.bookings.find((b) => b.stripe_payment_intent === piId);
  assert.equal(row.payment_state, 'paid');
  assert.equal(row.amount_cents, made.out.amount);
  assert.ok(row.captured_at);
});

test('a PaymentIntent that is neither succeeded nor requires_capture is still refused', async () => {
  S.pis.pi_open = { id: 'pi_open', status: 'requires_payment_method', amount: 2500, metadata: { dateISO: dayAhead(2), bayId: 'B1' } };
  const r = await call(confirmBooking, { body: { paymentIntentId: 'pi_open' } });
  assert.equal(r.code, 400);
  assert.match(r.out.error, /not complete/);
});

// =============================================================================================
// 3. THE TRAP: the webhook must record a held booking at AUTHORISATION
// =============================================================================================
//
// With manual capture, payment_intent.succeeded does not fire at checkout — it fires when staff
// capture, days later or never. A webhook that waits for it would leave a held booking unwritten,
// the customer's card authorised, and the slot showing free.

const capturableEvent = (over = {}) => ({
  id: `evt_${Math.random().toString(36).slice(2)}`, object: 'event', livemode: false,
  type: 'payment_intent.amount_capturable_updated',
  data: { object: {
    id: 'pi_new_hold', object: 'payment_intent', status: 'requires_capture',
    amount: 2500, amount_capturable: 2500, amount_received: 0, latest_charge: 'ch_h', receipt_email: null,
    metadata: { dateISO: dayAhead(3), bayId: 'B1', bayName: 'Bay 1', startMin: '600', endMin: '660',
      summary: 'in three days 10:00', paymentMode: 'hold', holdExpiresAt: inHours(168) },
    ...over,
  } },
});

test('amount_capturable_updated is what makes a held booking real — succeeded is never waited for', async () => {
  const { code } = await fire(capturableEvent());
  assert.equal(code, 200);

  const row = S.db.bookings.find((b) => b.stripe_payment_intent === 'pi_new_hold');
  assert.ok(row, 'the booking exists the moment the authorisation lands');
  assert.equal(row.status, 'confirmed', 'the slot is taken — nobody else can buy it');
  assert.equal(row.payment_state, 'held');
  assert.equal(row.authorized_cents, 2500);
  assert.equal(row.amount_cents, 0, 'nothing has been charged');
  assert.ok(row.hold_expires_at);
});

test('the hold deadline comes from the card network when Stripe gives it, not from our estimate', async () => {
  const networkDeadline = Math.floor(new Date(inHours(100)).getTime() / 1000);
  S.charge = { billing_details: { name: 'Pat Golfer' }, payment_method_details: { card: { capture_before: networkDeadline } } };
  await fire(capturableEvent());
  const row = S.db.bookings.find((b) => b.stripe_payment_intent === 'pi_new_hold');
  assert.equal(row.hold_expires_at, new Date(networkDeadline * 1000).toISOString());
});

test('the later capture settles the SAME booking to paid — it does not write a second one', async () => {
  await fire(capturableEvent());
  const before = S.db.bookings.length;

  const captured = capturableEvent();
  captured.type = 'payment_intent.succeeded';
  captured.data.object.status = 'succeeded';
  captured.data.object.amount_received = 2500;
  const { code } = await fire(captured);
  assert.equal(code, 200);

  assert.equal(S.db.bookings.length, before, 'one booking, not two');
  const row = S.db.bookings.find((b) => b.stripe_payment_intent === 'pi_new_hold');
  assert.equal(row.payment_state, 'paid');
  assert.equal(row.amount_cents, 2500, 'now it really has been charged');
  assert.ok(row.captured_at);
});

test('a far-ahead booking still arrives on payment_intent.succeeded alone, as paid', async () => {
  const e = capturableEvent();
  e.type = 'payment_intent.succeeded';
  e.data.object.status = 'succeeded';
  e.data.object.amount_received = 2500;
  e.data.object.metadata.paymentMode = 'charge';
  e.data.object.metadata.holdExpiresAt = '';
  await fire(e);

  const row = S.db.bookings.find((b) => b.stripe_payment_intent === 'pi_new_hold');
  assert.ok(row);
  assert.equal(row.payment_state, 'paid');
  assert.equal(row.amount_cents, 2500);
});

test('the client-side confirm and the webhook agree: whichever lands first, there is one booking', async () => {
  const made = await call(createPI, { body: slot(2) });
  const piId = made.out.clientSecret.split('_secret')[0];
  await call(confirmBooking, { body: { paymentIntentId: piId } });

  const e = capturableEvent();
  e.data.object.id = piId;
  e.data.object.amount = made.out.amount;
  e.data.object.amount_capturable = made.out.amount;
  Object.assign(e.data.object.metadata, { dateISO: dayAhead(2), startMin: '900', endMin: '960' });
  await fire(e);

  const rows = S.db.bookings.filter((b) => b.stripe_payment_intent === piId);
  assert.equal(rows.length, 1, 'double-covered, never double-booked');
  assert.equal(rows[0].payment_state, 'held');
});

// A held card whose slot went to someone else has no booking row, so it is on no list anywhere.
// It has to be released right there, or it sits on the customer's card for a week.
const SLOT_TAKEN = { code: '23P01', message: 'conflicting key value violates exclusion constraint "bookings_no_overlap"' };

test('slot taken at confirm: the hold is released at Stripe, and the customer is told so truthfully', async () => {
  const made = await call(createPI, { body: slot(2) });
  const piId = made.out.clientSecret.split('_secret')[0];
  S.fail['bookings:insert'] = SLOT_TAKEN;

  const r = await call(confirmBooking, { body: { paymentIntentId: piId } });
  assert.equal(r.code, 409);
  assert.match(r.out.error, /hold has been released/);
  assert.deepEqual(calls('paymentIntents.cancel').map((c) => c[1]), [piId]);
  assert.equal(S.pis[piId].status, 'canceled');
});

test('a database failure (not a taken slot) never releases the hold', async () => {
  const made = await call(createPI, { body: slot(2) });
  const piId = made.out.clientSecret.split('_secret')[0];
  S.fail['bookings:insert'] = { message: 'connection terminated unexpectedly' };

  const r = await call(confirmBooking, { body: { paymentIntentId: piId } });
  assert.equal(r.code, 409);
  assert.match(r.out.error, /could not save your booking/);
  assert.equal(calls('paymentIntents.cancel').length, 0, 'the card is left alone');
});

test('slot "taken" by the webhook\'s own row for this payment: the hold is kept and the booking stands', async () => {
  const made = await call(createPI, { body: slot(2) });
  const piId = made.out.clientSecret.split('_secret')[0];
  // The race: the webhook saves this very PaymentIntent a moment before the client-side insert,
  // so the client sees the overlap error — against its own booking.
  let raced = false;
  Object.defineProperty(S.fail, 'bookings:insert', { configurable: true, get() {
    if (!raced) {
      raced = true;
      S.db.bookings.push({ id: 'b-webhook', bay_id: 'B1', booking_date: dayAhead(2), start_min: 900, end_min: 960,
        status: 'confirmed', payment_state: 'held', stripe_payment_intent: piId });
    }
    return SLOT_TAKEN;
  } });

  const r = await call(confirmBooking, { body: { paymentIntentId: piId } });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(r.out.already, true);
  assert.equal(calls('paymentIntents.cancel').length, 0, 'a real booking is never left with its hold released');
});

test('slot taken when the webhook saves a hold: it is released there too', async () => {
  S.fail['bookings:insert'] = SLOT_TAKEN;
  const { code } = await fire(capturableEvent());
  assert.equal(code, 200);
  assert.equal(S.db.bookings.find((b) => b.stripe_payment_intent === 'pi_new_hold'), undefined);
  assert.deepEqual(calls('paymentIntents.cancel').map((c) => c[1]), ['pi_new_hold']);
});

// =============================================================================================
// 4. Capture
// =============================================================================================

test('capture in full moves the money once and marks the booking paid', async () => {
  const { code, out } = await staffPost('tok-admin', 'capture', { bookingId: HELD });
  assert.equal(code, 200, JSON.stringify(out));
  assert.equal(out.moneyMoved, true);
  assert.equal(out.capturedCents, 2500);
  assert.equal(out.paymentState, 'paid');

  const c = calls('paymentIntents.capture');
  assert.equal(c.length, 1);
  assert.equal(c[0][1], 'pi_held');
  assert.equal(c[0][2].amount_to_capture, 2500);
  assert.ok(c[0][3].idempotencyKey, 'an idempotency key is always sent');

  assert.equal(booking(HELD).payment_state, 'paid');
  assert.equal(booking(HELD).amount_cents, 2500, 'only now is there anything refundable');
  assert.ok(booking(HELD).captured_at);
});

test('a partial capture takes the shorter session and says the rest is gone for good', async () => {
  const { code, out } = await staffPost('tok-admin', 'capture', { bookingId: HELD, amountCents: 1500 });
  assert.equal(code, 200, JSON.stringify(out));
  assert.equal(out.capturedCents, 1500);
  assert.equal(out.releasedCents, 1000);
  assert.match(out.message, /released back to the customer and cannot be captured later/);
  assert.equal(calls('paymentIntents.capture')[0][2].amount_to_capture, 1500);
  assert.equal(booking(HELD).amount_cents, 1500);
  assert.equal(booking(HELD).payment_state, 'paid');
});

test('capturing twice charges once', async () => {
  const first = await staffPost('tok-admin', 'capture', { bookingId: HELD });
  const second = await staffPost('tok-admin', 'capture', { bookingId: HELD });
  assert.equal(first.code, 200);
  assert.equal(second.code, 200);
  assert.equal(second.out.already, true);
  assert.equal(second.out.capturedCents, 2500);
  assert.equal(calls('paymentIntents.capture').length, 1, 'Stripe is asked once');
  assert.equal(booking(HELD).amount_cents, 2500, 'counted once');
});

test('a PaymentIntent Stripe says is already captured settles the row instead of erroring', async () => {
  // The state write failed the first time round; the money moved. Pressing Capture again must
  // bring the booking into line rather than reporting a failure.
  S.pis.pi_held = { id: 'pi_held', status: 'succeeded', amount: 2500, amount_received: 2500, metadata: {} };
  S.captureThrows = Object.assign(new Error('This PaymentIntent could not be captured because it has already been captured.'),
    { code: 'payment_intent_unexpected_state' });
  const { code, out } = await staffPost('tok-admin', 'capture', { bookingId: HELD });
  assert.equal(code, 200, JSON.stringify(out));
  assert.equal(out.already, true);
  assert.equal(out.moneyMoved, true);
  assert.equal(out.capturedCents, 2500);
  assert.equal(booking(HELD).payment_state, 'paid');
  assert.equal(booking(HELD).amount_cents, 2500);
});

// The same Stripe error means two opposite things, and getting it wrong marks a booking 'paid' with
// nothing behind it. This is the other half of the test above.
test('a PaymentIntent Stripe has CANCELLED is never mistaken for a capture', async () => {
  // The row still says held with time left, but the authorisation lapsed at the bank.
  S.pis.pi_held.status = 'canceled';
  S.captureThrows = Object.assign(new Error('This PaymentIntent could not be captured because it has a status of canceled.'),
    { code: 'payment_intent_unexpected_state' });

  const { code, out } = await staffPost('tok-admin', 'capture', { bookingId: HELD });
  assert.equal(code, 409);
  assert.equal(out.moneyMoved, false);
  assert.equal(out.code, 'expired');
  assert.match(out.error, /Nothing was charged/);
  assert.equal(booking(HELD).payment_state, 'released', 'and it stops asking to be captured');
  assert.equal(booking(HELD).amount_cents, 0, 'never marked as money received');
});

test('capture past the expiry is refused, and says why in words staff can act on', async () => {
  const { code, out } = await staffPost('tok-admin', 'capture', { bookingId: STALE });
  assert.equal(code, 409);
  assert.equal(out.code, 'expired');
  assert.equal(out.moneyMoved, false);
  assert.match(out.error, /expired on/);
  assert.match(out.error, /about seven days/);
  assert.match(out.error, /Take payment at the counter/);
  assert.equal(calls('paymentIntents.capture').length, 0, 'Stripe is never asked for money that is gone');
  assert.equal(booking(STALE).payment_state, 'held', 'nothing is quietly rewritten');
});

test('capturing a booking that was charged in full at booking is refused, and explains itself', async () => {
  const { code, out } = await staffPost('tok-admin', 'capture', { bookingId: PAID });
  assert.equal(code, 200, 'already paid is not an error — it is the state the caller wanted');
  assert.equal(out.already, true);
  assert.equal(out.capturedCents, 5000);
  assert.equal(calls('paymentIntents.capture').length, 0);
});

test('capturing more than was authorised is refused before Stripe is touched', async () => {
  const { code, out } = await staffPost('tok-admin', 'capture', { bookingId: HELD, amountCents: 9900 });
  assert.equal(code, 400);
  assert.equal(out.code, 'over_capture');
  assert.match(out.error, /only capture up to what is on hold/);
  assert.equal(calls('paymentIntents.capture').length, 0);
});

// =============================================================================================
// 5. Release
// =============================================================================================

test('release cancels the authorisation and charges nothing', async () => {
  const { code, out } = await staffPost('tok-admin', 'release', { bookingId: HELD, reason: 'called to cancel' });
  assert.equal(code, 200, JSON.stringify(out));
  assert.equal(out.moneyMoved, false);
  assert.equal(out.paymentState, 'released');
  assert.equal(out.releasedCents, 2500);

  const c = calls('paymentIntents.cancel');
  assert.equal(c.length, 1);
  assert.equal(c[0][1], 'pi_held');
  assert.ok(c[0][3].idempotencyKey);

  assert.equal(booking(HELD).payment_state, 'released');
  assert.equal(booking(HELD).amount_cents, 0, 'the customer was never charged a cent');
  assert.ok(booking(HELD).released_at);
  assert.equal(S.db.refunds.length, 0, 'a release is NOT a refund and writes nothing to the ledger');
  assert.equal(calls('refunds.create').length, 0);
});

test('releasing twice is harmless, and releasing a captured booking is refused', async () => {
  await staffPost('tok-admin', 'release', { bookingId: HELD });
  const again = await staffPost('tok-admin', 'release', { bookingId: HELD });
  assert.equal(again.code, 200);
  assert.equal(again.out.already, true);
  assert.equal(calls('paymentIntents.cancel').length, 1);

  const paid = await staffPost('tok-admin', 'release', { bookingId: PAID });
  assert.equal(paid.code, 409);
  assert.equal(paid.out.code, 'already_captured');
  assert.match(paid.out.error, /Refund it instead/);
});

test('releasing a hold that already lapsed still tidies the list and charges nothing', async () => {
  S.cancelThrows = Object.assign(new Error('You cannot cancel this PaymentIntent because it has already been canceled.'),
    { code: 'payment_intent_unexpected_state' });
  const { code, out } = await staffPost('tok-admin', 'release', { bookingId: STALE });
  assert.equal(code, 200, JSON.stringify(out));
  assert.equal(booking(STALE).payment_state, 'released');
  assert.match(out.message, /already lapsed/);
});

// =============================================================================================
// 6. Cancellation does the right thing per state
// =============================================================================================

test('cancelling a HELD booking releases it — it is never called a refund', async () => {
  const { code, out } = await call(bookingApi, { body: { id: HELD } });
  assert.equal(code, 200, JSON.stringify(out));
  assert.equal(booking(HELD).status, 'cancelled');

  assert.equal(out.refund, undefined, 'nothing about a refund, because nothing was ever charged');
  assert.equal(out.release.released, true);
  assert.equal(out.release.moneyMoved, false);
  assert.equal(out.release.amountCents, 2500);
  assert.match(out.release.message, /released/);

  assert.equal(calls('paymentIntents.cancel').length, 1);
  assert.equal(calls('refunds.create').length, 0, 'Stripe is never asked for a refund');
  assert.equal(S.db.refunds.length, 0, 'and nothing is written to public.refunds');
  assert.equal(booking(HELD).payment_state, 'released');
});

test('cancelling a PAID booking still refunds, exactly as it did before', async () => {
  const { code, out } = await call(bookingApi, { body: { id: PAID } });
  assert.equal(code, 200, JSON.stringify(out));
  assert.equal(booking(PAID).status, 'cancelled');

  assert.equal(out.release, undefined);
  assert.equal(out.refund.moneyMoved, true);
  assert.equal(out.refund.amountCents, 5000);
  assert.equal(calls('refunds.create').length, 1);
  assert.equal(calls('paymentIntents.cancel').length, 0);
  assert.equal(S.db.refunds.length, 1);
  assert.equal(booking(PAID).refunded_cents, 5000);
  // Fully refunded, so the state says so rather than leaving the portal to derive it.
  assert.equal(booking(PAID).payment_state, 'refunded');
});

test('the booking lookup says which one cancelling would do, before the customer commits', async () => {
  const held = await call(bookingApi, { method: 'GET', query: { id: HELD } });
  assert.equal(held.out.booking.paymentState, 'held');
  assert.equal(held.out.booking.cancelEffect, 'release');
  assert.equal(held.out.booking.paidCents, 0, 'nothing has been paid…');
  assert.equal(held.out.booking.authorizedCents, 2500, '…this much is on hold');
  assert.ok(held.out.booking.holdExpiresAt);

  const paid = await call(bookingApi, { method: 'GET', query: { id: PAID } });
  assert.equal(paid.out.booking.cancelEffect, 'refund');
  assert.equal(paid.out.booking.refundableCents, 5000);
});

// =============================================================================================
// 7. Permissions
// =============================================================================================

test('staff without money.write may not capture or release; no card is touched', async () => {
  for (const action of ['capture', 'release']) {
    world();
    const { code, out } = await staffPost('tok-emp', action, { bookingId: HELD });
    assert.equal(code, 403, action);
    assert.match(out.error, /Money permission \(money\.write\)/, action);
    assert.equal(S.stripe.length, 0, `${action}: Stripe is never reached`);
    assert.equal(booking(HELD).payment_state, 'held', `${action}: nothing changed`);
  }
});

test('no staff login at all is a 401, not a 403', async () => {
  const { code } = await call(seriesApi, { query: { action: 'capture' }, body: { bookingId: HELD } });
  assert.equal(code, 401);
  assert.equal(S.stripe.length, 0);
});

// =============================================================================================
// 8. The warning list
// =============================================================================================

test('the held list is ordered by hold_expires_at, nearest cliff first, and names the no-shows', async () => {
  const { code, out } = await call(seriesApi, { method: 'GET', query: { action: 'holds' }, headers: { authorization: 'Bearer tok-admin' } });
  assert.equal(code, 200, JSON.stringify(out));
  assert.equal(out.sortField, 'holdExpiresAt', 'the field the portal must sort on');
  assert.equal(out.holds.length, 2, 'the two held bookings; the paid one is not on the list');

  // Ascending: the one that already lapsed comes first, the one with five days left second.
  assert.equal(out.holds[0].bookingId, STALE);
  assert.equal(out.holds[1].bookingId, HELD);

  assert.equal(out.holds[0].expired, true);
  assert.equal(out.holds[0].capturable, false);
  assert.equal(out.holds[0].noShow, true, 'the session has been and gone and nobody pressed anything');
  assert.ok(out.holds[0].hoursLeft < 0);

  assert.equal(out.holds[1].expired, false);
  assert.equal(out.holds[1].capturable, true);
  assert.equal(out.holds[1].authorizedCents, 2500);
  assert.ok(out.holds[1].hoursLeft > 100 && out.holds[1].hoursLeft <= 120);
  assert.equal(out.holds[1].bay, 'Bay 1');
  assert.equal(out.holds[1].customerName, 'Pat Golfer');

  assert.equal(out.expiringCents, 2500, 'still collectable');
  assert.equal(out.expiredCents, 4000, 'already lost');
  assert.equal(out.cutoffDays, 5);
});

test('the held list drops a booking the moment it is captured or released', async () => {
  await staffPost('tok-admin', 'capture', { bookingId: HELD });
  await staffPost('tok-admin', 'release', { bookingId: STALE });
  const { out } = await call(seriesApi, { method: 'GET', query: { action: 'holds' }, headers: { authorization: 'Bearer tok-admin' } });
  assert.equal(out.holds.length, 0);
});

test('read-only staff may see the list — chasing holds is not a money-moving act', async () => {
  S.db.staff.push({ user_id: 'u-ro', email: 'ro@invictus.test', role: 'readonly', is_active: true });
  S.users['tok-ro'] = { id: 'u-ro', email: 'ro@invictus.test' };
  const { code } = await call(seriesApi, { method: 'GET', query: { action: 'holds' }, headers: { authorization: 'Bearer tok-ro' } });
  assert.equal(code, 200);
});
