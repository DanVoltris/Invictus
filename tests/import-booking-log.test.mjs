// scripts/import-booking-log.mjs rebuilds bookings from GolfBooking's event log. The log never
// says "this is the booking": it says what happened to it. These tests pin the readings that are
// easy to get wrong — a released card hold is not a cancellation, the bay lives only in "Moved"
// lines, and a booking that runs past midnight has to become two rows. All names are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('../', import.meta.url).href;
const { parseCSV, rebuildBookings, placeInBays, customersFrom, linkContacts, toBookingRow, winnipegToISO, clockToMin, planAdd, newCustomers }
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

// ----- --add: topping up a live table that already holds an earlier import -------------------------
const liveRow = (id, code, date, s, e, bay, extra = {}) => ({ id, bay_id: bay, booking_date: date, start_min: s, end_min: e,
  status: 'confirmed', status_label: null, amount_cents: null, refunded_cents: 0, note: `Imported from GolfBooking #${code}`, ...extra });

test('--add: a new booking is added, an untouched one is left alone, a moved one is updated in place', () => {
  const { bookings } = build(
    ev('2026-09-25 08:00:00', 'Booking Created', 'Customer', 'OLD', '2026-09-26', '6:00 PM', '7:00 PM', 'Ada Test'),
    ev('2026-09-25 08:00:00', 'Booking Created', 'Customer', 'MOV', '2026-09-26', '6:00 PM', '7:00 PM', 'Bo Test'),
    ev('2026-09-26 10:00:00', 'Moved from Bay  Birchwood  Bay #2  to Bay Manitopia Realty Bay #3', 'Staff', 'MOV', '2026-09-26', '6:00 PM', '7:00 PM', 'Bo Test'),
    ev('2026-09-26 11:00:00', 'Booking Created', 'Customer', 'NEW', '2026-09-26', '6:00 PM', '7:00 PM', 'Cy Test'),
  );
  const live = [liveRow('r1', 'OLD', '2026-09-26', 1080, 1140, 'B1'), liveRow('r2', 'MOV', '2026-09-26', 1080, 1140, 'B2')];
  const plan = planAdd(bookings, live);
  assert.equal(plan.unchanged, 1);
  assert.deepEqual(plan.updates.map((u) => [u.code, u.id, u.bay, u.diff]), [['MOV', 'r2', 'B3', ['bay']]]);
  assert.deepEqual(plan.adds.map((a) => [a.code, a.bay]), [['NEW', 'B2']], 'first bay free in the LIVE table — B1 is Ada, B3 now Bo');
});

test('--add: a late session is added as ONE row, and it blocks the bay into the next morning', () => {
  const { bookings } = build(
    ev('2026-09-26 15:00:00', 'Booking Created', 'Customer', 'LATE', '2026-09-26', '11:30 PM', '1:30 AM', 'Di Test'),
    ev('2026-09-26 15:00:00', 'Booking Created', 'Staff', 'EARLY', '2026-09-27', '12:30 AM', '3:00 AM', 'Ed Test'),
  );
  // B1 is busy from 11 PM the night before until 2 AM (an older overnight import, split in two).
  const live = [liveRow('p1', 'NITE', '2026-09-26', 1380, 1440, 'B1', { note: 'Imported from GolfBooking #NITE · overnight, part 1 of 2' }),
                liveRow('p2', 'NITE', '2026-09-27', 0, 120, 'B1', { note: 'Imported from GolfBooking #NITE · overnight, part 2 of 2' })];
  const plan = planAdd(bookings, live);
  const late = plan.adds.find((a) => a.code === 'LATE'), early = plan.adds.find((a) => a.code === 'EARLY');
  assert.deepEqual([late.date, late.start, late.end, late.bay], ['2026-09-26', 1410, 1530, 'B2']);
  assert.equal(toBookingRow(late).end_min, 1530, 'no midnight split');
  assert.doesNotMatch(toBookingRow(late).note, /part/);
  assert.equal(early.bay, 'B3', 'B1 has the old overnight, B2 has the new late session until 1:30');
});

test('--add: an old overnight pair that is still right stays as it is; a changed one becomes one row', () => {
  const { bookings } = build(
    ev('2026-09-20 15:00:00', 'Booking Created', 'Customer', 'SAME', '2026-09-24', '11:00 PM', '1:00 AM', 'Fy Test'),
    ev('2026-09-20 15:00:00', 'Booking Created', 'Customer', 'LONG', '2026-09-24', '11:00 PM', '1:00 AM', 'Gi Test'),
    ev('2026-09-26 15:00:00', 'Start changed from x End changed from y', 'Staff', 'LONG', '2026-09-24', '11:00 PM', '2:00 AM', 'Gi Test'),
  );
  const pair = (code, bay, ids) => [
    liveRow(ids[0], code, '2026-09-24', 1380, 1440, bay, { note: `Imported from GolfBooking #${code} · overnight, part 1 of 2` }),
    liveRow(ids[1], code, '2026-09-25', 0, 60, bay, { note: `Imported from GolfBooking #${code} · overnight, part 2 of 2` })];
  const plan = planAdd(bookings, [...pair('SAME', 'B1', ['a1', 'a2']), ...pair('LONG', 'B2', ['b1', 'b2'])]);
  assert.equal(plan.unchanged, 1);
  const u = plan.updates[0];
  assert.deepEqual([u.code, u.id, u.dropIds, u.end, u.bay, u.diff], ['LONG', 'b1', ['b2'], 1560, 'B2', ['end']]);
});

test('--add: the log never erases a no-show, payment or refund staff recorded since', () => {
  const { bookings } = build(ev('2026-09-20 15:00:00', 'Booking Created', 'Customer', 'KEEP', '2026-09-24', '7:00 PM', '8:00 PM', 'Hu Test'));
  const plan = planAdd(bookings, [liveRow('k', 'KEEP', '2026-09-24', 1140, 1200, 'B1', { status_label: 'Checked In', amount_cents: 2800 })]);
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.updates.length, 0);
});

test('--add: cancelled in GolfBooking since the import → marked cancelled here, not deleted', () => {
  const { bookings } = build(
    ev('2026-09-20 15:00:00', 'Booking Created', 'Staff', 'GONE', '2026-09-28', '5:30 AM', '6:30 AM', 'Io Test'),
    ev('2026-09-26 01:15:00', 'Booking Cancelled', 'Staff', 'GONE', '2026-09-28', '5:30 AM', '6:30 AM', 'Io Test'),
  );
  const plan = planAdd(bookings, [liveRow('g', 'GONE', '2026-09-28', 330, 390, 'B4')]);
  assert.deepEqual(plan.updates.map((u) => [u.id, u.status, u.dropIds, u.diff]), [['g', 'cancelled', [], ['status']]]);
  assert.equal(plan.adds.length, 0);
});

test('--add: customers already known by email or phone are not added again', () => {
  const fresh = newCustomers(
    [{ name: 'Jo Test', email: 'jo@x.test', phone: '+12045550001' }, { name: 'Ki Test', email: null, phone: '+12045550002' }, { name: 'Lu New', email: 'lu@x.test', phone: null }],
    [{ email: 'JO@x.test', phone: null }, { email: null, phone: '204-555-0002' }]);
  assert.deepEqual(fresh.map((c) => c.name), ['Lu New']);
});

test('--add: an edit made in this portal is kept unless GolfBooking changed the same booking since', () => {
  const made = ev('2026-09-24 13:00:00', 'Booking Created', 'Customer', 'LUC', '2026-09-25', '10:00 AM', '12:00 PM', 'Mo Test');
  const now = build(made).bookings;
  // Staff dragged it to 12:30 on the new tee sheet; GolfBooking has done nothing to it since the import.
  const live = [liveRow('l', 'LUC', '2026-09-25', 750, 870, 'B1')];
  const kept = planAdd(now, live, new Map(), new Set());
  assert.equal(kept.updates.length, 0, 'the portal edit stands');
  assert.deepEqual(kept.keptEdits.map((k) => [k.code, k.kept, k.log.start]), [['LUC', ['start', 'end'], 600]]);
  // …but when GolfBooking itself moved the time since, GolfBooking wins.
  const moved = build(made, ev('2026-09-26 09:00:00', 'Start changed', 'Staff', 'LUC', '2026-09-25', '1:00 PM', '3:00 PM', 'Mo Test')).bookings;
  const plan = planAdd(moved, live, new Map(), new Set(['LUC']));
  assert.deepEqual(plan.updates.map((u) => [u.start, u.end, u.diff]), [[780, 900, ['start', 'end']]]);
});

test('--add: a late session imported only as its after-midnight half is made whole when there is room', () => {
  const { bookings } = build(ev('2026-09-20 15:00:00', 'Booking Created', 'Customer', 'HALF', '2026-09-23', '10:30 PM', '12:30 AM', 'No Test'));
  const half = liveRow('h2', 'HALF', '2026-09-24', 0, 30, 'B2', { note: 'Imported from GolfBooking #HALF · overnight, part 2 of 2' });
  const roomy = planAdd(bookings, [half]);
  assert.deepEqual(roomy.updates.map((u) => [u.id, u.date, u.start, u.end, u.bay]), [['h2', '2026-09-23', 1350, 1470, 'B2']]);
  // Every bay busy that evening: nothing is written, so the half that is there stays.
  const full = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6'].map((bay, i) => liveRow('x' + i, 'X' + i, '2026-09-23', 1320, 1440, bay));
  const tight = planAdd(bookings, [half, ...full]);
  assert.equal(tight.updates.length, 0);
  assert.equal(tight.noRoom[0].code, 'HALF');
});

test('--add: a bay the log moved a booking into is kept for it, even against an earlier booking', () => {
  const { bookings } = build(
    ev('2026-09-26 10:00:00', 'Booking Created', 'Staff', 'EARLY', '2026-09-26', '11:00 PM', '12:00 AM', 'Pa Test'),
    ev('2026-09-26 10:00:00', 'Booking Created', 'Customer', 'MOVED', '2026-09-26', '11:30 PM', '1:30 AM', 'Qi Test'),
    ev('2026-09-26 23:19:00', 'Moved from Bay Manitopia Realty Bay #3  to Bay   Assiniboine Credit Union Bay #1 ,  RIGHT HAND ONLY', 'Staff', 'MOVED', '2026-09-26', '11:30 PM', '1:30 AM', 'Qi Test'),
  );
  const plan = planAdd(bookings, []);
  assert.deepEqual(plan.adds.map((a) => [a.code, a.bay]).sort(), [['EARLY', 'B2'], ['MOVED', 'B1']]);
});

test('a card hold in the Payments export names the bay a customer booked; a later move still wins', async () => {
  const { baysFromPayments, applyPaymentBays } = await import(ROOT + 'scripts/import-booking-log.mjs');
  const pay = parseCSV(['"Date Created","Customer","Amount","Capture Method","Description","Status","Payment Processor","Action"',
    '"2026-09-26 23:35:44","ra@x.test","22.40","Hold","Ra Test - Sun Sep 27 2026, 12:00 AM -  Birchwood  Bay #2  (credit card hold)","Awaiting Capture","Stripe",""',
    '"2026-09-26 15:27:56","sy@x.test","47.60","Hold","Sy Test - Sat Sep 26 2026, 11:30 PM -  Birchwood  Bay #2  (credit card hold)","Awaiting Capture","Stripe",""'].join('\n'));
  const { bookings } = build(
    ev('2026-09-26 23:35:42', 'Booking Created', 'Customer', 'RA', '2026-09-27', '12:00 AM', '2:00 AM', 'Ra Test'),
    ev('2026-09-26 15:27:53', 'Booking Created', 'Customer', 'SY', '2026-09-26', '11:30 PM', '1:30 AM', 'Sy Test'),
    ev('2026-09-26 23:19:32', 'Moved from Bay Manitopia Realty Bay #3  to Bay   Assiniboine Credit Union Bay #1 ,  RIGHT HAND ONLY', 'Staff', 'SY', '2026-09-26', '11:30 PM', '1:30 AM', 'Sy Test'),
  );
  assert.equal(applyPaymentBays(bookings, baysFromPayments(pay)), 1);
  assert.deepEqual(bookings.map((b) => [b.code, b.bay]), [['RA', 'B2'], ['SY', 'B1']]);
});

test('--add: a changed group booking is never rewritten, so its other bays are never dropped', () => {
  const { bookings } = build(
    ev('2026-09-20 10:00:00', 'Group Booking Created', 'Staff', 'GRP', '2026-09-26', '8:00 PM', '11:00 PM', 'Ro Test'),
    ev('2026-09-26 21:00:00', 'Group Booking Updated', 'Staff', 'GRP', '2026-09-26', '8:00 PM', '10:00 PM', 'Ro Test'),
  );
  const live = [liveRow('g1', 'GRP', '2026-09-26', 1200, 1380, 'B1', { note: 'Group booking · Imported from GolfBooking #GRP' }),
                liveRow('g2', 'GRP', '2026-09-26', 1200, 1380, 'B3', { note: 'Group booking · Imported from GolfBooking #GRP · extra bay' })];
  const plan = planAdd(bookings, live);
  assert.equal(plan.updates.length, 0);
  assert.deepEqual(plan.groupsToCheck.map((g) => [g.code, g.diff]), [['GRP', ['end']]]);
});

// ----- --sheet: GolfBooking's public booking sheet ------------------------------------------------
// The cells below copy the page's own markup: a taken slot is "Reserved" with a waitlist button that
// names its time and bay; an open one shows its price and "Bay name , time".
const reservedCell = (t, bay) => `<td class="status_2"><b>Reserved</b> <img src="img/waitlist.png" onclick="openWaitlistModal('${t}', 4, 1, '${bay} ', '04:00');" /></td>`;
const openCell = (t, bay) => `<td class="status_1"><b>CA$25.00 / hour</b><br /> ${bay} , ${t}</td>`;
const B = { B1: 'Assiniboine Credit Union Bay #1 ,  RIGHT HAND ONLY', B2: 'Birchwood  Bay #2', B3: 'Manitopia Realty Bay #3', B4: 'Public Bay 4 Right Hand Only', B5: 'McNaught  Private Room #1', B6: 'Private Room 2' };
const sheetHTML = (rows) => rows.map(([t, taken]) => `<tr><td>${t}</td>${Object.keys(B).map((b) => (taken.includes(b) ? reservedCell(t, B[b]) : openCell(t, B[b]))).join('')}</tr>`).join('');

test('--sheet: reserved cells become (date, bay, time); after midnight is the next date; a closed day is null', async () => {
  const { parseSheet } = await import(ROOT + 'scripts/import-booking-log.mjs');
  const sh = parseSheet(sheetHTML([['10:30 PM', ['B3']], ['11:00 PM', []], ['12:30 AM', ['B1', 'B6']]]), '2026-09-26');
  assert.deepEqual(sh.reserved, [['2026-09-26', 'B3', 1350], ['2026-09-27', 'B1', 30], ['2026-09-27', 'B6', 30]]);
  assert.equal(sh.from, 1350, 'the first row drawn');
  assert.equal(parseSheet('Reservations for this day are currently unavailable.', '2026-11-15'), null);
});

test('--sheet: bays worked out by elimination — known bays kept, groups take several, gone slots unknown', async () => {
  const { parseSheet, solveSheetBays } = await import(ROOT + 'scripts/import-booking-log.mjs');
  // 8–9 PM: B1+B2+B3 (a new group of three) and B5; 9–10 PM: B5 (Ada, moved there in the log) and B6.
  const rows = [['8:00 PM', ['B1', 'B2', 'B3', 'B5']], ['8:30 PM', ['B1', 'B2', 'B3', 'B5']], ['9:00 PM', ['B5', 'B6']], ['9:30 PM', ['B5', 'B6']]];
  const sheets = [parseSheet(sheetHTML(rows), '2026-09-29')];
  const bk = (code, s, e, extra = {}) => ({ code, date: '2026-09-29', start: s, end: e, status: 'confirmed', bay: null, ...extra });
  const { bays, unexplained } = solveSheetBays([
    bk('GRP', 1200, 1260, { group: true }), bk('SOLO', 1200, 1260), bk('ADA', 1260, 1320, { bay: 'B5' }), bk('BO', 1260, 1320),
  ], sheets);
  assert.deepEqual(bays.get('ADA'), ['B5']);
  assert.deepEqual(bays.get('BO'), ['B6']);
  // Which of the four 8 PM bays is the single booking cannot be read off a sheet with no names —
  // but together the group and it hold exactly those four, and the group holds three.
  assert.equal(bays.get('GRP').length, 3);
  assert.deepEqual([...bays.get('GRP'), ...bays.get('SOLO')].sort(), ['B1', 'B2', 'B3', 'B5']);
  assert.deepEqual(unexplained, []);
  // Today's sheet no longer draws 8 PM: a booking then is not "missing", it is simply not judged.
  const today = [parseSheet(sheetHTML(rows.slice(2)), '2026-09-29')];
  const r = solveSheetBays([bk('EARLY', 1200, 1260), bk('ADA', 1260, 1320, { bay: 'B5' })], today);
  assert.equal(r.unplaced.length, 0);
  assert.equal(r.bays.has('EARLY'), false);
});

test('--sheet: a live group in the wrong bays is re-bayed as a set; rows already right stay put', () => {
  const live = [liveRow('g1', 'GRP', '2026-09-26', 1200, 1380, 'B1', { note: 'Group booking · Imported from GolfBooking #GRP' }),
                liveRow('g2', 'GRP', '2026-09-26', 1200, 1380, 'B5', { note: 'Group booking · Imported from GolfBooking #GRP · extra bay' })];
  const b = { code: 'GRP', date: '2026-09-26', start: 1200, end: 1380, status: 'confirmed', status_label: null, amount_cents: null, refunded_cents: 0,
    group: true, bay: 'B1', sheetBays: ['B1', 'B2'], moved: true };
  const plan = planAdd([b], live);
  assert.deepEqual(plan.groupMoves.map((g) => g.moves), [[{ id: 'g1', from: 'B1', to: 'B1' }, { id: 'g2', from: 'B5', to: 'B2' }]]);
});

test('--sheet: when two groups at one time could split their bays either way, the live split stands', async () => {
  const { parseSheet, solveSheetBays } = await import(ROOT + 'scripts/import-booking-log.mjs');
  const sheets = [parseSheet(sheetHTML([['3:00 PM', ['B1', 'B2', 'B3']], ['3:30 PM', ['B1', 'B2', 'B3']]]), '2026-09-26')];
  const g = (code, liveBays) => ({ code, date: '2026-09-26', start: 900, end: 960, status: 'confirmed', group: true, bay: null, liveBays });
  const size = (c) => ({ ONE: 2, TWO: 1 })[c];
  for (let i = 0; i < 3; i++) {   // the same answer every run
    const { bays } = solveSheetBays([g('TWO', ['B2']), g('ONE', ['B1', 'B3'])], sheets, size);
    assert.deepEqual([bays.get('ONE').sort(), bays.get('TWO')], [['B1', 'B3'], ['B2']]);
  }
});

test('--add: a NEWER export shows the latest times on old rows too — GolfBooking\'s change still wins', () => {
  // Janet booked 8–10 PM; staff changed it to 8:30–11:30 PM after the last import. The new export prints
  // 8:30–11:30 on the ORIGINAL creation row as well, so "how it looked before" cannot be read from it.
  const { bookings } = build(
    ev('2026-09-26 10:47:46', 'Booking Created', 'Customer', 'JAN', '2026-09-27', '8:30 PM', '11:30 PM', 'Ja Test'),
    ev('2026-09-27 22:37:12', 'Start changed from x End changed from y', 'Staff', 'JAN', '2026-09-27', '8:30 PM', '11:30 PM', 'Ja Test'),
  );
  const live = [liveRow('j', 'JAN', '2026-09-27', 1200, 1320, 'B6')];
  const plan = planAdd(bookings, live, new Map(), new Set(['JAN']));
  assert.deepEqual(plan.updates.map((u) => [u.start, u.end, u.diff]), [[1230, 1410, ['start', 'end']]]);
  assert.equal(plan.keptEdits.length, 0);
});
