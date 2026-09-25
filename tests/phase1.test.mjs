// Phase 1 logic: saveBookingFeedback, setCustomerNote, and the note on the hours path.
// The real lib/db.js runs; only the Supabase client under it is fake.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';
const ROOT = new URL('../', import.meta.url).href;

const S = {};
// Query builder over in-memory tables; records every write so tests can assert on it.
function builder(table) {
  const st = { f: [], op: 'select', payload: null };
  const match = (r) => st.f.every(([k, c, v]) => k === 'eq' ? r[c] === v : k === 'in' ? v.includes(r[c]) : k === 'is' ? (r[c] ?? null) === v : true);
  const run = () => {
    const rows = S.db[table] || [];
    if (S.fail[table + ':' + st.op]) return { data: null, error: S.fail[table + ':' + st.op] };
    if (st.op === 'insert') {
      const row = { id: 'new-' + (rows.length + 1), ...st.payload };
      if (table === 'booking_feedback' && rows.some((r) => r.booking_id === row.booking_id)) return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
      rows.push(row); S.db[table] = rows; S.writes.push([table, 'insert', row]); return { data: row, error: null };
    }
    if (st.op === 'update') {
      const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.payload));
      S.writes.push([table, 'update', st.payload, hit.map((r) => r.id)]); return { data: hit, error: null };
    }
    return { data: rows.filter(match), error: null };
  };
  const q = {
    select() { return q; }, order() { return q; }, limit() { return q; }, not() { return q; }, like() { return q; },
    eq(c, v) { st.f.push(['eq', c, v]); return q; }, in(c, v) { st.f.push(['in', c, v]); return q; }, is(c, v) { st.f.push(['is', c, v]); return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; },
    maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
    single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; },
    then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
  };
  return q;
}
mock.module(ROOT + 'node_modules/@supabase/supabase-js/dist/index.mjs', { namedExports: {
  createClient: () => ({ from: (t) => builder(t), rpc: async (fn) => { S.writes.push(['rpc', fn]); return { data: 540, error: null }; } }),
} });
const db = await import(ROOT + 'lib/db.js');

const PAST = '2026-01-10', FUTURE = '2099-01-10';
function world(extra = {}) {
  Object.assign(S, { writes: [], fail: {}, db: {
    bookings: [
      { id: '11111111-1111-4111-8111-111111111111',   booking_date: PAST,   end_min: 1200, status: 'confirmed', customer_phone: '(204) 990-6530', customer_email: null, group_id: null },
      { id: '22222222-2222-4222-8222-222222222222', booking_date: FUTURE, end_min: 1200, status: 'confirmed', customer_phone: '2049906530', group_id: null },
      { id: '33333333-3333-4333-8333-333333333333', booking_date: PAST,   end_min: 1200, status: 'cancelled', customer_phone: '2049906530', group_id: null },
      { id: '44444444-4444-4444-8444-444444444444',booking_date: PAST,   end_min: 1200, status: 'confirmed', customer_phone: '2045550000', customer_email: 'x@y.co', group_id: null },
      { id: '55555555-5555-4555-8555-555555555555',    booking_date: PAST,   end_min: 1200, status: 'confirmed', customer_phone: null, customer_email: 'Murad@VoltrisAI.com', group_id: null },
      { id: '66666666-6666-4666-8666-666666666666', booking_date: PAST, end_min: 1200, status: 'confirmed', customer_phone: '2049906530', group_id: 'G1' },
      { id: '77777777-7777-4777-8777-777777777777', booking_date: PAST, end_min: 1200, status: 'confirmed', customer_phone: '2049906530', group_id: 'G1' },
    ],
    booking_feedback: [], customers: [], ...extra,
  } });
}
const ME = { phone: '+1 204 990 6530' };
const fb = (o) => db.saveBookingFeedback({ contact: ME, customerId: 'C1', ...o });

test('saves a rating for my finished booking (phone matched by digits)', async () => {
  world();
  assert.deepEqual(await fb({ bookingId: '11111111-1111-4111-8111-111111111111', rating: 4, comment: '  Great bays  ' }), { ok: true });
  const row = S.db.booking_feedback[0];
  assert.equal(row.booking_id, '11111111-1111-4111-8111-111111111111'); assert.equal(row.rating, 4); assert.equal(row.comment, 'Great bays'); assert.equal(row.skipped, false); assert.equal(row.customer_id, 'C1');
});

test('matched by email too (case-insensitive)', async () => {
  world();
  assert.equal((await db.saveBookingFeedback({ contact: { email: 'murad@voltrisai.com' }, bookingId: '55555555-5555-4555-8555-555555555555', rating: 5 })).ok, true);
});

test("someone else's booking -> 404, nothing written", async () => {
  world();
  const r = await fb({ bookingId: '44444444-4444-4444-8444-444444444444', rating: 5 });
  assert.equal(r.code, 404); assert.equal(S.db.booking_feedback.length, 0);
});

test('session not finished yet -> 400', async () => {
  world(); const r = await fb({ bookingId: '22222222-2222-4222-8222-222222222222', rating: 5 });
  assert.equal(r.code, 400); assert.match(r.error, /finished/); assert.equal(S.db.booking_feedback.length, 0);
});

test('cancelled booking -> 400', async () => {
  world(); assert.equal((await fb({ bookingId: '33333333-3333-4333-8333-333333333333', rating: 5 })).code, 400);
});

test('rating must be a whole number 1–5; skip needs no rating', async () => {
  world();
  for (const bad of [0, 6, 3.5, 'x', undefined]) assert.equal((await fb({ bookingId: '11111111-1111-4111-8111-111111111111', rating: bad })).code, 400, String(bad));
  assert.equal(S.db.booking_feedback.length, 0);
  assert.equal((await fb({ bookingId: '11111111-1111-4111-8111-111111111111', skipped: true, comment: 'ignored' })).ok, true);
  assert.deepEqual([S.db.booking_feedback[0].skipped, S.db.booking_feedback[0].rating, S.db.booking_feedback[0].comment], [true, null, null]);
});

test('answered once: second answer is a no-op, and a group counts once', async () => {
  world();
  await fb({ bookingId: '11111111-1111-4111-8111-111111111111', rating: 5 });
  assert.deepEqual(await fb({ bookingId: '11111111-1111-4111-8111-111111111111', rating: 1 }), { ok: true, already: true });
  await fb({ bookingId: '66666666-6666-4666-8666-666666666666', rating: 3 });
  assert.deepEqual(await fb({ bookingId: '77777777-7777-4777-8777-777777777777', rating: 3 }), { ok: true, already: true });
  assert.equal(S.db.booking_feedback.length, 2);
});

test('comment capped at 1000 characters', async () => {
  world(); await fb({ bookingId: '11111111-1111-4111-8111-111111111111', rating: 5, comment: 'x'.repeat(5000) });
  assert.equal(S.db.booking_feedback[0].comment.length, 1000);
});

test('feedback table missing (0027 not applied) -> clear 503 message', async () => {
  world(); S.fail['booking_feedback:select'] = { code: '42P01', message: 'relation "booking_feedback" does not exist' };
  const r = await fb({ bookingId: '11111111-1111-4111-8111-111111111111', rating: 5 });
  assert.equal(r.code, 503); assert.match(r.error, /setup\.sql/);
});

test('customer note: trimmed, capped at 500, written to the booking', async () => {
  world();
  await db.setCustomerNote({ bookingId: '11111111-1111-4111-8111-111111111111', note: '  bringing clubs\r\n' + 'y'.repeat(600) });
  const w = S.writes.find((x) => x[0] === 'bookings' && x[1] === 'update');
  assert.equal(w[2].customer_note.startsWith('bringing clubs\n'), true); assert.equal(w[2].customer_note.length, 500);
  assert.deepEqual(w[3], ['11111111-1111-4111-8111-111111111111']);
});

test('customer note: empty note writes nothing; onlyIfEmpty never overwrites', async () => {
  world();
  await db.setCustomerNote({ bookingId: '11111111-1111-4111-8111-111111111111', note: '   ' });
  assert.equal(S.writes.length, 0);
  S.db.bookings[0].customer_note = 'first'; S.db.bookings[0].stripe_payment_intent = 'pi_1';
  await db.setCustomerNote({ paymentIntentId: 'pi_1', note: 'second', onlyIfEmpty: true });
  assert.equal(S.db.bookings[0].customer_note, 'first');
});

test('customer note: a failing update is logged, never thrown (booking already saved)', async () => {
  world(); S.fail['bookings:update'] = { message: 'column "customer_note" does not exist' };
  await assert.doesNotReject(db.setCustomerNote({ bookingId: '11111111-1111-4111-8111-111111111111', note: 'hi' }));
});

test('hours booking carries the note onto the new booking', async () => {
  world({ customers: [{ id: 'C1', name: 'Murad', phone: '2049906530', hours_balance_min: 600 }] });
  const r = await db.bookWithHours({ dateISO: FUTURE, bayId: 'B1', startMin: 600, endMin: 660, name: 'Murad', phone: '2049906530', customerNote: 'Birthday!' });
  assert.equal(r.ok, true);
  const booking = S.db.bookings.find((b) => b.id === r.bookingId);
  assert.equal(booking.customer_note, 'Birthday!');
});

test('feedback: a missing or non-UUID booking id is a 404, not a database error', async () => {
  world();
  for (const id of ['not-a-uuid', '', undefined, '00000000-0000-0000-0000-00000000000g']) {
    const r = await fb({ bookingId: id, rating: 5 });
    assert.equal(r.code, 404, String(id)); assert.match(r.error, /not on your account/);
  }
});
