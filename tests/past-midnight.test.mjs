// Sessions that run past midnight (migration 0038): "book at 11:30 PM Saturday, finish at 3 AM Sunday".
//
// A booking is stored under the day it starts; the part after midnight has end_min above 1440.
// The time after midnight is priced as the next day (the owner's choice: "whatever the real day
// is"), it only exists when the night is open until midnight and the next day opens at it, and the
// previous night's late session still owns the bay in the small hours.
//
// The real lib/booking.js, lib/db.js and api/public.js run; Supabase is an in-memory fake.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake' });
const ROOT = new URL('../', import.meta.url).href;

const S = { db: {} };
function builder(table) {
  const st = { f: [], op: 'select', payload: null };
  const ops = { eq: (a, b) => a === b, neq: (a, b) => a !== b, gte: (a, b) => a >= b, lte: (a, b) => a <= b, lt: (a, b) => a < b, gt: (a, b) => a > b };
  const run = () => {
    const rows = S.db[table] = S.db[table] || [];
    const hit = rows.filter((r) => st.f.every(([op, c, v]) => ops[op](r[c], v)));
    if (st.op === 'delete') { S.db[table] = rows.filter((r) => !hit.includes(r)); return { data: hit, error: null }; }
    if (st.op === 'update') { hit.forEach((r) => Object.assign(r, st.payload)); return { data: hit, error: null }; }
    return { data: hit, error: null };
  };
  const q = {
    select() { return q; }, order() { return q; }, limit() { return q; },
    delete() { st.op = 'delete'; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; },
    single: async () => { const r = run(); return { data: r.data[0] || null, error: r.data[0] ? null : { message: 'no row' } }; },
    maybeSingle: async () => { const r = run(); return { data: r.data[0] || null, error: null }; },
    then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
  };
  for (const op of Object.keys(ops)) q[op] = (c, v) => { st.f.push([op, c, v]); return q; };
  return q;
}
mock.module(ROOT + 'node_modules/@supabase/supabase-js/dist/index.mjs', { namedExports: {
  createClient: () => ({ from: (t) => builder(t), rpc: async () => ({ data: null, error: null }), auth: {} }),
} });

const { priceForBooking, timeRangeText, normalizeSettings, MAX_END_MIN } = await import(ROOT + 'lib/booking.js');
const { crossDayProblem } = await import(ROOT + 'lib/db.js');
const { availability } = await import(ROOT + 'api/public.js');

// A Thursday far enough ahead that it is never "in the past", and the days around it.
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const THU = (() => { let d = addDays(new Date().toISOString().slice(0, 10), 14); while (new Date(`${d}T00:00:00`).getDay() !== 4) d = addDays(d, 1); return d; })();
const FRI = addDays(THU, 1), SAT = addDays(THU, 2), SUN = addDays(THU, 3);

const allNight = normalizeSettings({});   // open around the clock; weekday $20/hr, Fri–Sun $25/hr
const withHours = (h) => normalizeSettings({ hours: { ...allNight.hours, ...h } });

test('Thursday 11 PM → Friday 1 AM: the hour after midnight is charged at Friday\'s rate', () => {
  const cents = priceForBooking({ settings: allNight, dateISO: THU, bayId: 'B1', startMin: 1380, endMin: 1500 });
  assert.equal(cents, 2000 + 2500, 'one hour at the weekday $20, one at the weekend $25');
});

test('a session can run past midnight only when the night is open until midnight and the next day opens at it', () => {
  const late = { dateISO: SAT, bayId: 'B1', startMin: 1410, endMin: 1620 };   // Sat 11:30 PM → Sun 3:00 AM
  assert.ok(priceForBooking({ settings: allNight, ...late }) > 0, 'open both sides of midnight → fine');
  assert.throws(() => priceForBooking({ settings: withHours({ 6: [10, 23] }), ...late }), /Outside hours/, 'Saturday closes at 11 PM');
  assert.throws(() => priceForBooking({ settings: withHours({ 0: [8, 24] }), ...late }), /Outside hours/, 'Sunday does not open until 8 AM');
  assert.throws(() => priceForBooking({ settings: withHours({ 0: [0, 2] }), ...late }), /Outside hours/, 'Sunday\'s small hours end at 2 AM');
  assert.ok(priceForBooking({ settings: withHours({ 0: [0, 3] }), ...late }) > 0, '…but a 3 AM finish fits a 3 AM close');
});

test('nothing runs later than midnight the following night, and a session starts on its own day', () => {
  assert.equal(MAX_END_MIN, 2880);
  assert.throws(() => priceForBooking({ settings: allNight, dateISO: SAT, bayId: 'B1', startMin: 1410, endMin: 2910 }), /Outside hours/);
  assert.throws(() => priceForBooking({ settings: allNight, dateISO: SAT, bayId: 'B1', startMin: 1440, endMin: 1500 }), /Outside hours/,
    'midnight is Sunday 0, never Saturday 1440');
});

test('3:30 AM → 4:30 AM is an ordinary booking on the day it starts', () => {
  const cents = priceForBooking({ settings: allNight, dateISO: SUN, bayId: 'B3', startMin: 210, endMin: 270 });
  assert.equal(cents, 2500);
});

test('the time text names the day, so nobody turns up a day early or late', () => {
  const sat = '2026-10-03';   // a Saturday
  assert.equal(timeRangeText(sat, 1410, 1620), '11:30 PM–3:00 AM (Sun)');
  assert.equal(timeRangeText(sat, 1380, 1440), '11:00 PM–Midnight');
  assert.equal(timeRangeText('2026-10-04', 60, 120), '1:00 AM–2:00 AM (Saturday night)');
  assert.equal(timeRangeText(sat, 600, 660), '10:00 AM–11:00 AM');
});

beforeEach(() => {
  S.db = {
    settings: [{ id: 1, hours: allNight.hours }],
    schedule_overrides: [],
    bookings: [{ id: 'late', bay_id: 'B1', booking_date: SAT, start_min: 1410, end_min: 1620, status: 'confirmed' }],   // Sat 11:30 PM → Sun 3 AM
  };
});

test('Saturday\'s late session still has the bay at 1 AM Sunday', async () => {
  const ask = (bayId, s, e, extra = {}) => crossDayProblem({ settings: allNight, dateISO: SUN, bayId, startMin: s, endMin: e, ...extra });
  assert.equal((await ask('B1', 60, 120))?.code, 'taken', 'Sun 1–2 AM in the same bay');
  assert.equal(await ask('B1', 180, 240), null, 'Sun 3–4 AM starts as it ends');
  assert.equal(await ask('B2', 60, 120), null, 'another bay is free');
  assert.equal(await ask('B1', 60, 120, { ignoreId: 'late' }), null, 'moving the late session itself is not a clash with itself');
});

test('a late session is refused when the next morning is booked or closed', async () => {
  S.db.bookings.push({ id: 'sun', bay_id: 'B2', booking_date: SUN, start_min: 60, end_min: 120, status: 'confirmed' });
  const r = await crossDayProblem({ settings: allNight, dateISO: SAT, bayId: 'B2', startMin: 1380, endMin: 1530 });
  assert.equal(r?.code, 'taken', 'Sat 11 PM → Sun 1:30 AM runs into Sunday\'s 1 AM booking…');
  assert.equal(await crossDayProblem({ settings: allNight, dateISO: SAT, bayId: 'B2', startMin: 1380, endMin: 1500 }), null, '…but finishing at 1 AM, as it starts, is fine');

  S.db.schedule_overrides.push({ id: 'x', override_date: SUN, end_date: null, is_active: true, is_closed: true, bay_ids: null, start_min: null, end_min: null });
  const shut = await crossDayProblem({ settings: allNight, dateISO: SAT, bayId: 'B3', startMin: 1380, endMin: 1500 });
  assert.equal(shut?.code, 'closed', 'Sunday is closed by an override');
  assert.match(shut.error, /closed the next day/);
});

test('cart holds: an abandoned one never blocks; a live one does only when asked to count it', async () => {
  const soon = new Date(Date.now() + 5 * 60e3).toISOString(), gone = new Date(Date.now() - 5 * 60e3).toISOString();
  S.db.bookings = [
    { id: 'h1', bay_id: 'B4', booking_date: SAT, start_min: 1410, end_min: 1620, status: 'held', expires_at: soon },
    { id: 'h2', bay_id: 'B5', booking_date: SAT, start_min: 1410, end_min: 1620, status: 'held', expires_at: gone },
  ];
  const ask = (bayId, includeHeld) => crossDayProblem({ settings: allNight, dateISO: SUN, bayId, startMin: 60, endMin: 120, includeHeld });
  assert.equal(await ask('B4', false), null);
  assert.equal((await ask('B4', true))?.code, 'taken');
  assert.equal(await ask('B5', true), null);
});

test('the booking page gets the night before, the day, and the next morning in one set of numbers', async () => {
  S.db.bookings.push(
    { id: 'fri', bay_id: 'B2', booking_date: FRI, start_min: 1380, end_min: 1500, status: 'confirmed' },   // Fri 11 PM → Sat 1 AM
    { id: 'fri-early', bay_id: 'B2', booking_date: FRI, start_min: 600, end_min: 660, status: 'confirmed' }, // Friday morning — not Saturday's business
    { id: 'sun', bay_id: 'B3', booking_date: SUN, start_min: 60, end_min: 120, status: 'confirmed' },      // Sun 1–2 AM
  );
  let out;
  await availability({ query: { date: SAT } }, { status() { return this; }, json(b) { out = b; return this; }, setHeader() {} });
  assert.deepEqual(out.booked.B1, [[1410, 1620]], 'Saturday\'s own late session');
  assert.deepEqual(out.booked.B2, [[-60, 60]], 'Friday\'s late session, still running until 1 AM Saturday');
  assert.deepEqual(out.booked.B3, [[1500, 1560]], 'Sunday 1–2 AM, 1440 minutes on');
  assert.deepEqual(out.nextDateHours, null, 'no override on Sunday — the weekly hours apply');
});
