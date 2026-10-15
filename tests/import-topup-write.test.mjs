// The --add write step, end to end, against a stand-in database that refuses two live bookings in
// one bay at the same time — the rule the real one enforces (bookings_no_overlap). The case that
// matters: GolfBooking's sheet says two bookings are in each other's bay, so they have to swap, and
// a swap done one row at a time collides halfway unless each first steps aside. All names invented.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake' });
const ROOT = new URL('../', import.meta.url).href;

const DB = { bookings: [], customers: [], log: [] };
const day = (iso) => Date.parse(`${iso}T00:00:00Z`) / 864e5 * 1440;
const clash = (rows) => {
  const live = rows.filter((r) => r.status !== 'cancelled');
  for (const a of live) for (const b of live) {
    if (a !== b && a.bay_id === b.bay_id && day(a.booking_date) + a.start_min < day(b.booking_date) + b.end_min
      && day(b.booking_date) + b.start_min < day(a.booking_date) + a.end_min) return `${a.id} and ${b.id} overlap in ${a.bay_id}`;
  }
  return null;
};
let seq = 0;
function from(table) {
  const st = { f: [], op: 'select', payload: null };
  const match = (r) => st.f.every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
  const run = () => {
    const rows = DB[table];
    if (st.op === 'select') return { data: table === 'bookings' && st.span ? rows.slice(0, 1) : rows.slice(st.from ?? 0, (st.to ?? 1e9) + 1), error: null };
    const next = rows.map((r) => ({ ...r }));
    if (st.op === 'insert') for (const p of [].concat(st.payload)) next.push({ id: `new-${++seq}`, ...p });
    if (st.op === 'update') next.filter(match).forEach((r) => Object.assign(r, st.payload));
    const kept = st.op === 'delete' ? next.filter((r) => !match(r)) : next;
    const bad = table === 'bookings' && clash(kept);
    if (bad) return { data: null, error: { message: `conflicting key value violates exclusion constraint "bookings_no_overlap": ${bad}` } };
    DB[table] = kept; DB.log.push(st.op);
    return { data: null, error: null };
  };
  const q = {
    select(cols) { if (cols === 'span') st.span = true; return q; }, range(a, b) { st.from = a; st.to = b; return q; }, limit() { return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; }, delete() { st.op = 'delete'; return q; },
    eq(k, v) { st.f.push([k, v]); return q; }, in(k, v) { st.f.push([k, v]); return q; },
    then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
  };
  return q;
}
mock.module(ROOT + 'node_modules/@supabase/supabase-js/dist/index.mjs', { namedExports: { createClient: () => ({ from }) } });

// GolfBooking's sheet: Sat Sep 26, B1 is taken 8–10 PM and B2 8–9 PM. Ada is 8–9 and Bo 8–10, so Bo
// can only be B1 and Ada B2 — the reverse of where the last import guessed them. Cy (new) holds B3.
const cell = (t, bay, name) => (bay ? `<td><b>Reserved</b> <img onclick="openWaitlistModal('${t}', 4, 1, '${name}', '04:00');" /></td>` : `<td><b>CA$25.00 / hour</b><br /> ${name} , ${t}</td>`);
const NAMES = { B1: 'Assiniboine Credit Union Bay #1', B2: 'Birchwood  Bay #2', B3: 'Manitopia Realty Bay #3', B4: 'Public Bay 4 Right Hand Only', B5: 'McNaught  Private Room #1', B6: 'Private Room 2' };
const page = (taken) => ['8:00 PM', '8:30 PM', '9:00 PM', '9:30 PM', '10:00 PM'].map((t) => `<tr>${Object.keys(NAMES).map((b) => cell(t, taken[t]?.includes(b), NAMES[b])).join('')}</tr>`).join('');
globalThis.fetch = async (url) => {
  const d = new URL(url).searchParams.get('date');
  const html = d === '2026-09-26' ? page({ '8:00 PM': ['B1', 'B2', 'B3'], '8:30 PM': ['B1', 'B2', 'B3'], '9:00 PM': ['B1'], '9:30 PM': ['B1'] })
    : d === '2026-09-27' ? page({}) : 'Reservations for this day are currently unavailable.';
  return { ok: true, status: 200, text: async () => html };
};

const { topUp, parseCSV, rebuildBookings } = await import(ROOT + 'scripts/import-booking-log.mjs');

test('a swap GolfBooking\'s sheet calls for goes through, and a new booking lands in its sheet bay', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-09-27T15:00:00Z'));   // "today" is Sep 27 → the sheet from Sep 26
  const HEAD = '"Log Date","Description","User","Booking Confirmation","Booking Date","Booking Start","Booking End","Booking Name","Actions"';
  const ev = (at, code, name, end = '9:00 PM') => `"${at}","Booking Created","Customer","${code}","2026-09-26Sat","8:00 PM","${end}","${name}",""`;
  const events = parseCSV([HEAD, ev('2026-09-20 10:00:00', 'ADA', 'Ada Test'), ev('2026-09-20 10:00:00', 'BO', 'Bo Test', '10:00 PM'), ev('2026-09-26 12:00:00', 'CY', 'Cy Test')].join('\n'));
  const row = (id, code, bay, end = 1260) => ({ id, bay_id: bay, booking_date: '2026-09-26', start_min: 1200, end_min: end, status: 'confirmed',
    status_label: null, amount_cents: null, refunded_cents: 0, note: `Imported from GolfBooking #${code}`, created_at: '2026-09-25T14:00:00+00:00' });
  DB.bookings = [row('ada-row', 'ADA', 'B1'), row('bo-row', 'BO', 'B2', 1320)];
  const { bookings, skipped } = rebuildBookings(events);
  const out = []; t.mock.method(console, 'log', (...a) => out.push(a.join(' ')));
  await topUp({ customers: [], bookings, skipped, events, DRY: false, SHEET: true });
  const bay = (name) => DB.bookings.filter((r) => r.note.includes(`#${name}`)).map((r) => r.bay_id);
  assert.deepEqual([bay('ADA'), bay('BO'), bay('CY')], [['B2'], ['B1'], ['B3']], out.join('\n'));
  assert.equal(DB.bookings.some((r) => /^PARK/.test(r.bay_id)), false, 'no booking left in a parking bay');
  assert.equal(clash(DB.bookings), null);
  // And the swap really needed the parking step: moving either one straight across would have hit the other.
  assert.ok(DB.log.filter((op) => op === 'update').length >= 4, 'two parks + two final moves');
});

test('a booking that gets SHORTER frees its time before a new booking is put there', async (t) => {
  // Kevin was 5:30–7:00 PM in B5; GolfBooking moved him to 5:00–6:30 PM, and Dryden (new) took B5
  // from 6:30. Inserting Dryden before Kevin is shortened collides — the order has to allow for it.
  t.mock.method(Date, 'now', () => Date.parse('2026-09-28T15:00:00Z'));
  globalThis.fetch = async (url) => {
    const d = new URL(url).searchParams.get('date');
    const rows = ['5:00 PM', '5:30 PM', '6:00 PM', '6:30 PM', '7:00 PM', '7:30 PM', '8:00 PM'];
    const html = d === '2026-09-27' ? rows.map((tm) => `<tr>${Object.keys(NAMES).map((b) => cell(tm, b === 'B5' && tm !== '8:00 PM', NAMES[b])).join('')}</tr>`).join('')
      : d === '2026-09-28' ? page({}) : 'Reservations for this day are currently unavailable.';
    return { ok: true, status: 200, text: async () => html };
  };
  const HEAD = '"Log Date","Description","User","Booking Confirmation","Booking Date","Booking Start","Booking End","Booking Name","Actions"';
  const ev = (at, desc, code, s, e, name) => `"${at}","${desc}","Customer","${code}","2026-09-27Sun","${s}","${e}","${name}",""`;
  const events = parseCSV([HEAD,
    ev('2026-09-26 11:47:55', 'Booking Created', 'KEV', '5:00 PM', '6:30 PM', 'Ke Test'),
    ev('2026-09-27 11:34:15', 'Start changed from x End changed from y', 'KEV', '5:00 PM', '6:30 PM', 'Ke Test'),
    ev('2026-09-27 16:00:00', 'Booking Created', 'DRY', '6:30 PM', '8:00 PM', 'Dr Test')].join('\n'));
  DB.bookings = [{ id: 'kev-row', bay_id: 'B5', booking_date: '2026-09-27', start_min: 1050, end_min: 1140, status: 'confirmed', status_label: null,
    amount_cents: null, refunded_cents: 0, note: 'Imported from GolfBooking #KEV', created_at: '2026-09-27T10:00:00+00:00' }];
  DB.log = [];
  const { bookings, skipped } = rebuildBookings(events);
  const out = []; t.mock.method(console, 'log', (...a) => out.push(a.join(' ')));
  t.mock.method(console, 'error', (...a) => out.push('ERR ' + a.join(' ')));
  t.mock.method(process, 'exit', (c) => { throw new Error(`exit ${c}: ${out.join('\n')}`); });
  await topUp({ customers: [], bookings, skipped, events, DRY: false, SHEET: true });
  const kev = DB.bookings.find((r) => r.id === 'kev-row'), dry = DB.bookings.find((r) => r.note.includes('#DRY'));
  assert.deepEqual([kev.bay_id, kev.start_min, kev.end_min], ['B5', 1020, 1110]);
  assert.deepEqual([dry.bay_id, dry.start_min, dry.end_min], ['B5', 1110, 1200]);
  assert.equal(clash(DB.bookings), null);
});
