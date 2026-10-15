// Cancelling online (24 hours or more ahead) refunded a CARD and nothing else. A booking paid with
// a gift card or prepaid hours was told "there was nothing to pay, so there is nothing to refund",
// and the value was simply gone — the debits were not even tied to the booking, so nothing could
// find them. The real api/booking.js, api/hour-cards.js and lib/db.js run; Supabase is fake.
import { test, mock, beforeEach } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

Object.assign(process.env, { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake',
  STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_PUBLISHABLE_KEY: 'pk_test_fake' });
const ROOT = new URL('../', import.meta.url).href;
const S = { db: {} };
let seq = 0;

function builder(table) {
  const st = { f: [], op: 'select', payload: null };
  const match = (r) => st.f.every(([k, c, v]) => k === 'eq' ? r[c] === v : k === 'neq' ? r[c] !== v : k === 'is' ? (r[c] ?? null) === v
    : k === 'in' ? v.includes(r[c]) : k === 'gte' ? r[c] >= v : k === 'lte' ? r[c] <= v : k === 'lt' ? r[c] < v : k === 'gt' ? r[c] > v : (k === 'like' || k === 'ilike') ? String(r[c] || '').includes(String(v).replace(/%/g, '')) : true);
  const run = () => {
    const rows = S.db[table] = S.db[table] || [];
    if (st.op === 'insert') { const row = { id: randomUUID(), ...st.payload }; rows.push(row); return { data: row, error: null }; }
    if (st.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.payload)); return { data: hit, error: null }; }
    return { data: rows.filter(match), error: null };
  };
  const q = {};
  for (const k of ['eq', 'neq', 'is', 'in', 'gte', 'lte', 'lt', 'gt', 'like', 'ilike']) q[k] = (c, v) => { st.f.push([k, c, v]); return q; };
  Object.assign(q, {
    select() { return q; }, order() { return q; }, limit() { return q; }, range() { return q; }, not() { return q; }, or() { return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; },
    maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
    single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; },
    then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
  });
  return q;
}
const rpc = async (fn, a) => {
  if (fn === 'adjust_hours') {
    const c = S.db.customers.find((x) => x.id === a.p_customer);
    if (c.hours_balance_min + a.p_delta_min < 0) return { data: null, error: { message: 'insufficient hours' } };
    c.hours_balance_min += a.p_delta_min;
    S.db.hour_transactions.push({ id: `ht-${++seq}`, customer_id: a.p_customer, minutes: a.p_delta_min, kind: a.p_kind, booking_id: a.p_booking, ref: a.p_ref ?? null });
    return { data: c.hours_balance_min, error: null };
  }
  if (fn === 'adjust_gift_card') {
    if (a.p_ref && S.db.gift_card_transactions.some((t) => t.gift_card_id === a.p_card && t.ref === a.p_ref)) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
    const g = S.db.gift_cards.find((x) => x.id === a.p_card);
    g.balance_cents += a.p_delta;
    S.db.gift_card_transactions.push({ id: `gt-${++seq}`, gift_card_id: a.p_card, cents: a.p_delta, kind: a.p_kind, booking_id: a.p_booking, ref: a.p_ref ?? null });
    return { data: g.balance_cents, error: null };
  }
  return { data: null, error: null };
};
mock.module(ROOT + 'node_modules/@supabase/supabase-js/dist/index.mjs', { namedExports: {
  createClient: () => ({ from: (t) => builder(t), rpc,
    auth: { getUser: async (tok) => (tok === 'tok-ann' ? { data: { user: { id: 'u-ann' } } } : { error: { message: 'bad jwt' }, data: {} }) } }),
} });

const { default: bookingApi } = await import(ROOT + 'api/booking.js');
const { default: hourCards } = await import(ROOT + 'api/hour-cards.js');
const db = await import(ROOT + 'lib/db.js');

const inDays = (n) => { const d = new Date(Date.now() + n * 86400000); return d.toISOString().slice(0, 10); };
const SLOT = { dateISO: inDays(3), bayId: 'B1', startMin: 600, endMin: 720 };
beforeEach(() => {
  seq = 0;
  S.db = {
    customers: [{ id: 'c-ann', name: 'Ann Test', phone: '+12045550101', email: 'ann@example.com', user_id: 'u-ann', hours_balance_min: 600 }],
    bookings: [], hour_transactions: [], gift_cards: [{ id: 'gc-1', balance_cents: 10000, status: 'active' }], gift_card_transactions: [],
    settings: [{ id: 1, bays: [{ id: 'B1', name: 'Bay 1' }], hours: { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] },
      rates: { weekdayOffPeak: 20, weekdayPeak: 20, weekendOffPeak: 25, weekendPeak: 25, peakStartHour: 17 }, min_mins: 60, max_party: 4, slot_step: 30,
      booking_window: { regularDays: 10, leagueDays: 60 } }],
    schedule_overrides: [], league_members: [], leagues: [], refunds: [],
  };
});
async function call(handler, { method = 'POST', query = {}, body = {}, headers = {} }) {
  let code = 200, out;
  const res = { setHeader() { return this; }, status(c) { code = c; return this; }, json(b) { out = b; return this; }, end() { return this; } };
  await handler({ method, query, body, headers: { host: 'invictus.test', ...headers }, socket: { remoteAddress: '127.0.0.1' } }, res);
  return { code, out };
}
const ann = () => S.db.customers[0];

test('hours: the debit is tied to the booking, and cancelling online gives the hours back once', async () => {
  const b = await call(hourCards, { query: { action: 'book' }, body: { ...SLOT, name: 'Ann Test' }, headers: { authorization: 'Bearer tok-ann' } });
  assert.equal(b.out.ok, true, JSON.stringify(b.out));
  assert.equal(ann().hours_balance_min, 480);
  const booking = S.db.bookings[0];
  assert.equal(S.db.hour_transactions[0].booking_id, booking.id, 'the debit knows its booking');

  const c = await call(bookingApi, { body: { id: booking.id } });
  assert.equal(c.out.ok, true, JSON.stringify(c.out));
  assert.equal(ann().hours_balance_min, 600, 'two hours back');
  assert.match(c.out.credit.message, /2 prepaid hours back on your account/);
  assert.doesNotMatch(c.out.refund.message, /nothing to refund/, 'not told there was nothing to give back');

  assert.deepEqual(await db.creditBackOnCancel(booking.id), { giftCents: 0, hoursMin: 0, errors: [] }, 'a second pass returns nothing');
  assert.equal(ann().hours_balance_min, 600);
});

test('gift card: a booking paid entirely by gift card gets its value back once', async () => {
  const r = await db.bookWithGiftCard({ ...SLOT, name: 'Ann Test', phone: '+12045550101', cardId: 'gc-1', amountCents: 5600 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(S.db.gift_cards[0].balance_cents, 4400);
  assert.equal(S.db.gift_card_transactions[0].booking_id, r.bookingId, 'the debit knows its booking');

  const c = await call(bookingApi, { body: { id: r.bookingId } });
  assert.equal(c.out.ok, true, JSON.stringify(c.out));
  assert.equal(S.db.gift_cards[0].balance_cents, 10000);
  assert.match(c.out.credit.message, /\$56\.00 back on your gift card/);
  await db.creditBackOnCancel(r.bookingId);
  assert.equal(S.db.gift_cards[0].balance_cents, 10000, 'never twice');
});

test('a booking paid only by card gets no credit line', async () => {
  const id = randomUUID();
  S.db.bookings.push({ id, status: 'confirmed', booking_date: SLOT.dateISO, start_min: 600, end_min: 720, bay_id: 'B1', amount_cents: 0 });
  const c = await call(bookingApi, { body: { id } });
  assert.equal(c.out.ok, true);
  assert.equal(c.out.credit, undefined);
});
