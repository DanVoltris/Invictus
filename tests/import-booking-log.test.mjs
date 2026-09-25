// scripts/import-booking-log.mjs rebuilds bookings from GolfBooking's event log. The log never
// says "this is the booking": it says what happened to it. These tests pin the readings that are
// easy to get wrong — a released card hold is not a cancellation, the bay lives only in "Moved"
// lines, and a booking that runs past midnight has to become two rows. All names are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('../', import.meta.url).href;
const { parseCSV, rebuildBookings, placeInBays, customersFrom, linkContacts, toBookingRow, winnipegToISO, clockToMin }
  = await import(ROOT + 'scripts/import-booking-log.mjs');

const HEAD = '"Log Date","Description","User","Booking Confirmation","Booking Date","Booking Start","Booking End","Booking Name","Actions"';
const ev = (at, desc, user, code, date, start, end, name) =>
  `"${at}Mon Sep 1st 2026, 1:00 PM","${desc}","${user}","${code}","${date}Mon Sep 1st 2026","${start}","${end}","${name}","View Edit Booking Sheet"`;
const log = (...lines) => parseCSV([HEAD, ...lines].join('\n'));
const build = (...lines) => rebuildBookings(log(...lines));

test('log times are Winnipeg wall-clock, in daylight time and out of it', () => {
  assert.equal(winnipegToISO('2026-09-23 18:48:00Wed Sep 23rd 2026'), '2026-09-23T23:48:00.000Z');
  assert.equal(winnipegToISO('2026-02-23 18:48:00'), '2026-02-24T00:48:00.000Z');
  assert.equal(clockToMin('12:30 AM'), 30);
  assert.equal(clockToMin('12:00 PM'), 720);
});

test('a released card hold leaves the booking standing; a real cancellation does not', () => {
  const { bookings } = build(
    ev('2026-09-01 10:00:00', 'Booking Created', 'Customer', 'AAA', '2026-09-01', '7:00 PM', '8:00 PM', 'Ada Test'),
    ev('2026-09-01 19:05:00', 'Hold Cancelled', 'Staff', 'AAA', '2026-09-01', '7:00 PM', '8:00 PM', 'Ada Test'),
    ev('2026-09-01 10:00:00', 'Booking Created', 'Customer', 'BBB', '2026-09-01', '7:00 PM', '8:00 PM', 'Bo Test'),
    ev('2026-09-01 12:00:00', 'Booking Cancelled', 'Staff', 'BBB', '2026-09-01', '7:00 PM', '8:00 PM', 'Bo Test'),
  );
  const by = Object.fromEntries(bookings.map(b => [b.code, b]));
  assert.equal(by.AAA.status, 'confirmed');
  assert.equal(by.AAA.source, 'online');
  assert.equal(by.BBB.status, 'cancelled');
  assert.equal(by.BBB.cancelled_at, '2026-09-01T17:00:00.000Z');
});

test('an abandoned checkout is not imported, and overlapping exports do not double a booking', () => {
  const line = ev('2026-09-01 10:00:00', 'Booking Created', 'Staff', 'CCC', '2026-09-01', '1:00 PM', '2:00 PM', 'walkin');
  const { bookings, skipped } = rebuildBookings([...log(line), ...log(line),
    ...log(ev('2026-09-01 10:00:00', 'Booking Created', 'Customer', 'DDD', '2026-09-01', '1:00 PM', '2:00 PM', 'Cy Test'),
           ev('2026-09-01 10:00:02', 'Booking Cancelled - Payment Failure', 'System', 'DDD', '2026-09-01', '1:00 PM', '2:00 PM', 'Cy Test'))]);
  assert.deepEqual(bookings.map(b => b.code), ['CCC']);
  assert.equal(bookings[0].source, 'manager');
  assert.equal(skipped.paymentFailure, 1);
});

test('the bay is the destination of the last move, and Holding Bay counts as unknown', () => {
  const { bookings } = build(
    ev('2026-09-01 10:00:00', 'Booking Created', 'Customer', 'EEE', '2026-09-01', '9:00 PM', '10:00 PM', 'Di Test'),
    ev('2026-09-01 11:00:00', 'Moved from Bay  Birchwood  Bay #2  to Bay Holding Bay Start changed from Mon Sep 1st 2026, 8:00 PM to Mon Sep 1st 2026, 9:00 PM', 'Staff', 'EEE', '2026-09-01', '9:00 PM', '10:00 PM', 'Di Test'),
    ev('2026-09-01 11:00:05', 'Moved from Bay Holding Bay to Bay McNaught  Private Room #1  ', 'Staff', 'EEE', '2026-09-01', '9:00 PM', '10:00 PM', 'Di Test'),
    ev('2026-09-01 10:00:00', 'Booking Created', 'Customer', 'FFF', '2026-09-01', '9:00 PM', '10:00 PM', 'Ed Test'),
    ev('2026-09-01 11:00:00', 'Moved from Bay Private Room 2 to Bay Holding Bay', 'Staff', 'FFF', '2026-09-01', '9:00 PM', '10:00 PM', 'Ed Test'),
  );
  const by = Object.fromEntries(bookings.map(b => [b.code, b]));
  assert.equal(by.EEE.bay, 'B5');
  assert.equal(by.FFF.bay, null);
});

test('a booking past midnight becomes two rows; maintenance 4 AM to 4 AM is a full day', () => {
  const { bookings } = build(
    ev('2026-09-01 10:00:00', 'Booking Created', 'Customer', 'GGG', '2026-09-01', '11:00 PM', '1:30 AM', 'Fay Test'),
    ev('2026-09-01 10:00:00', 'Booking Created', 'Staff', 'HHH', '2026-09-02', '4:00 AM', '4:00 AM', 'Maintenance'),
    ev('2026-09-01 10:00:00', 'Booking Created', 'Staff', 'III', '2026-09-02', '4:00 AM', '4:00 AM', 'walkin'),
  );
  const { rows } = placeInBays(bookings);
  const g = rows.filter(r => r.code === 'GGG').map(r => [r.date, r.start, r.end, r.part]);
  assert.deepEqual(g, [['2026-09-01', 1380, 1440, 1], ['2026-09-02', 0, 90, 2]]);
  const h = rows.filter(r => r.code === 'HHH');
  assert.deepEqual(h.map(r => [r.date, r.start, r.end]), [['2026-09-02', 240, 1440], ['2026-09-03', 0, 240]]);
  assert.equal(h[0].status, 'blocked');
  assert.equal(h[0].name, null);
  assert.ok(!rows.some(r => r.code === 'III'), 'a zero-length walk-in is noise, not a booking');
  assert.match(toBookingRow(rows[1]).note, /overnight, part 2 of 2/);
});

test('no two live bookings share a bay at the same time; a clashing known bay yields', () => {
  const lines = [];
  for (const c of ['J1', 'J2', 'J3']) lines.push(ev('2026-09-01 10:00:00', 'Booking Created', 'Customer', c, '2026-09-05', '7:00 PM', '9:00 PM', 'Gus ' + c));
  lines.push(ev('2026-09-01 11:00:00', 'Moved from Bay Public Bay 4 Right Hand Only to Bay Manitopia Realty Bay #3', 'Staff', 'J1', '2026-09-05', '7:00 PM', '9:00 PM', 'Gus J1'));
  lines.push(ev('2026-09-01 11:00:00', 'Moved from Bay Public Bay 4 Right Hand Only to Bay Manitopia Realty Bay #3', 'Staff', 'J2', '2026-09-05', '7:00 PM', '9:00 PM', 'Gus J2'));
  const { rows, stats } = placeInBays(build(...lines).bookings);
  const bays = rows.map(r => r.bay);
  assert.equal(new Set(bays).size, 3, `three distinct bays, got ${bays}`);
  assert.ok(bays.includes('B3'));
  assert.equal(stats.knownBayMoved, 1);
});

test('when a slot was oversold, the no-show and the repeat booking are the ones left out', () => {
  const lines = [];
  for (let i = 1; i <= 6; i++) lines.push(ev('2026-09-01 10:00:00', 'Booking Created', 'Customer', 'K' + i, '2026-09-05', '7:00 PM', '8:00 PM', i === 6 ? 'Kim Twice' : 'Kay ' + i));
  lines.push(ev('2026-09-01 10:05:00', 'Booking Created', 'Customer', 'K7', '2026-09-05', '7:00 PM', '8:00 PM', 'Kim Twice'));
  lines.push(ev('2026-09-01 10:00:00', 'Booking Created', 'Customer', 'K0', '2026-09-05', '6:00 PM', '8:00 PM', 'Lou Noshow'));
  lines.push(ev('2026-09-05 19:30:00', 'Booking Updated - No Show', 'Staff', 'K0', '2026-09-05', '6:00 PM', '8:00 PM', 'Lou Noshow'));
  const { rows, stats } = placeInBays(build(...lines).bookings);
  assert.deepEqual(stats.noRoom.map(s => s.split(' ')[0]).sort(), ['K0', 'K7']);
  assert.ok(['K1', 'K2', 'K3', 'K4', 'K5', 'K6'].every(c => rows.some(r => r.code === c)), 'all six real bookings keep a bay');
});

test('customers need a name and a way to reach them; bookings link only on a unique name', () => {
  const exportCsv = parseCSV([
    'id,first_name,last_name,email_address,mobile_phone,added,note',
    '1,Hal,Test,HAL@example.com,(204) 555-0101,2026-03-01 12:00:00,',
    '2,Ivy,Test,,,2026-03-01 12:00:00,',
    '3,Jo,Same,jo1@example.com,,2026-03-01 12:00:00,',
    '4,Jo,Same,,2045550104,2026-03-01 12:00:00,',
  ].join('\n'));
  const customers = customersFrom(exportCsv);
  assert.deepEqual(customers.map(c => c.name), ['Hal Test', 'Jo Same', 'Jo Same']);
  assert.equal(customers[0].email, 'hal@example.com');
  assert.equal(customers[0].phone, '+12045550101');
  const rows = [{ name: 'hal  test' }, { name: 'Jo Same' }, { name: null }];
  assert.equal(linkContacts(rows, customers), 1);
  assert.equal(rows[0].phone, '+12045550101');
  assert.equal(rows[1].email, undefined, 'two Jo Sames — do not guess');
});
