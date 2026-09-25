#!/usr/bin/env node
// Live-database verification for the waiting list (migration 0022).
//
// Runs the REAL endpoint (api/waitlist.js) against the REAL database in SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY: joins the list, frees a slot by cancelling a booking, sweeps, and
// asserts that exactly one offer came out of it and that a second sweep does not produce another.
// Every row it creates is prefixed ZZTEST and deleted again at the end, and the last thing it does
// is prove nothing of its own is left behind.
//
//   node scripts/verify-waitlist.mjs
import 'dotenv/config';
import { admin, waitlistConfig } from '../lib/db.js';
import { normalizeSettings } from '../lib/booking.js';
import handler from '../api/waitlist.js';

const PREFIX = 'ZZTEST';
const rnd = Math.random().toString(36).slice(2, 8);
const EMAIL = `zztest-wl-${rnd}@invictus.test`;
const db = admin();
if (!db) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.'); process.exit(1); }

let fails = 0;
const chk = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(want)})`}`);
};

// Are the migrations actually applied? Say so plainly instead of failing twenty assertions.
const probe = async (t) => { const { error } = await db.from(t).select('*').limit(1); return !error; };
const have = await probe('waitlist_entries') && await probe('waitlist_offers') && await probe('waitlist_wakeups');
console.log(`schema: waitlist tables ${have ? 'present' : 'MISSING'}`);
if (!have) {
  console.error('\nMigration 0022 is not applied to this project. Paste supabase/migrations/0022_waiting_list.sql');
  console.error('into Supabase → SQL Editor → Run, then re-run this script.');
  process.exit(2);
}

// Call the endpoint the way Vercel/express does, and hand back what it answered.
const call = async (method, action, { body, query, headers } = {}) => {
  const req = { method, query: { action, ...(query || {}) }, body: body || {}, headers: headers || {}, socket: {} };
  const res = {
    code: 200, body: null,
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
  };
  await handler(req, res);
  return res;
};

const settingsRow = await db.from('settings').select('*').eq('id', 1).single().then((r) => r.data);
const settings = normalizeSettings(settingsRow);
const BAY = (settings.bays.filter((b) => !b.holding)[0] || {}).id;
if (!BAY) { console.error('No bays configured — cannot test.'); process.exit(1); }
const DATE = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
const START = 600, END = 660;                      // 10:00–11:00, comfortably past minLeadMinutes
const savedWaitlist = settingsRow.waitlist || {};

let bookingId = null, entryToken = null, entryId = null, offerId = null, claimToken = null;

try {
  // Quiet hours are a real feature and the default window (21:00 → 08:00) would legitimately stop
  // this test at night. Switch them off for the duration and put the operator's setting back in
  // the cleanup below — the point of the test is the matching, not the clock.
  await db.from('settings').update({ waitlist: { ...savedWaitlist, quietStartMin: 0, quietEndMin: 0 } }).eq('id', 1);
  const cfg = waitlistConfig({ waitlist: { ...savedWaitlist, quietStartMin: 0, quietEndMin: 0 } });
  console.log(`\nusing bay ${BAY} on ${DATE} 10:00–11:00 · claim window ${cfg.claimMinutes} min · holdSlot=${cfg.holdSlot}`);

  // ---------- 1. a booked slot, and somebody waiting for it ----------
  console.log('\nSETUP');
  const ins = await db.from('bookings').insert({
    bay_id: BAY, booking_date: DATE, start_min: START, end_min: END,
    status: 'confirmed', customer_name: `${PREFIX} Occupant`, source: 'manager',
  }).select('id').single();
  if (ins.error) throw new Error('could not create the test booking: ' + ins.error.message);
  bookingId = ins.data.id;
  console.log(`  booked ${BAY} ${DATE} 10:00–11:00 (${bookingId})`);

  const joined = await call('POST', 'join', {
    body: {
      dateISO: DATE, bayIds: [BAY], windowStartMin: 540, windowEndMin: 780, durationMin: 60,
      name: `${PREFIX} Waiter`, email: EMAIL, emailOk: true, players: 2,
    },
    headers: { host: 'localhost:4242' },
  });
  chk('join returns 200', joined.code, 200);
  chk('join put them on the list', joined.body && joined.body.ok, true);
  entryToken = joined.body.entry.token;
  const entryRow = await db.from('waitlist_entries').select('*').eq('token', entryToken).single();
  entryId = entryRow.data.id;
  chk('entry is active', entryRow.data.status, 'active');
  chk('bay preference stored', entryRow.data.bay_ids, [BAY]);

  const dupe = await call('POST', 'join', {
    body: { dateISO: DATE, bayIds: [BAY], windowStartMin: 540, windowEndMin: 780, durationMin: 60, email: EMAIL, emailOk: true },
    headers: { host: 'localhost:4242' },
  });
  chk('joining twice returns the same entry, not a second one', [dupe.body.ok, dupe.body.already, dupe.body.entry.token], [true, true, entryToken]);

  // ---------- 2. free the slot ----------
  console.log('\nA CANCELLATION FREES THE SLOT');
  await db.from('bookings').update({ status: 'cancelled' }).eq('id', bookingId);
  const wake = await db.from('waitlist_wakeups').select('*')
    .eq('booking_date', DATE).eq('bay_id', BAY).is('processed_at', null);
  chk('the cancellation queued exactly one wakeup', (wake.data || []).length, 1);
  chk('and it says what freed it', (wake.data[0] || {}).reason, 'booking_cancelled');

  // ---------- 3. the sweep offers it to exactly one person ----------
  console.log('\nTHE SWEEP');
  process.env.WAITLIST_SWEEP_SECRET = process.env.WAITLIST_SWEEP_SECRET || `${PREFIX}-secret-${rnd}`;
  const secret = process.env.WAITLIST_SWEEP_SECRET;
  const sweep1 = await call('POST', 'sweep', { headers: { 'x-waitlist-secret': secret, host: 'localhost:4242' } });
  chk('sweep runs', sweep1.code, 200);
  chk('sweep created one offer', sweep1.body.sweep.created, 1);

  const offers1 = await db.from('waitlist_offers').select('*').eq('entry_id', entryId);
  chk('exactly one offer row exists', (offers1.data || []).length, 1);
  offerId = offers1.data[0].id;
  claimToken = offers1.data[0].claim_token;
  chk('the offer is one duration-long slot inside the window', [offers1.data[0].start_min, offers1.data[0].end_min], [START, END]);
  chk('the entry is now marked offered', (await db.from('waitlist_entries').select('status').eq('id', entryId).single()).data.status, 'offered');

  const held = await db.from('bookings').select('*')
    .eq('booking_date', DATE).eq('bay_id', BAY).eq('status', 'held');
  chk('the slot is genuinely held for them', [(held.data || []).length, (held.data[0] || {}).source], [1, 'waitlist']);

  const notes = await db.from('notifications').select('*').eq('dedupe_key', `waitlist.offer:email:${offerId}`);
  chk('the customer was told (outbox row exists)', (notes.data || []).length, 1);
  console.log(`  outbox row status=${notes.data[0].status}${notes.data[0].last_error ? ` (${notes.data[0].last_error})` : ''}`);
  chk('the offer is marked notified', !!(await db.from('waitlist_offers').select('notified_at').eq('id', offerId).single()).data.notified_at, true);

  // ---------- 4. THE POINT OF ALL THIS: a second sweep must not offer it again ----------
  console.log('\nA SECOND SWEEP MUST NOT DOUBLE-OFFER');
  const sweep2 = await call('POST', 'sweep', { headers: { 'x-waitlist-secret': secret, host: 'localhost:4242' } });
  chk('second sweep created nothing', sweep2.body.sweep.created, 0);
  chk('still exactly one offer for this slot', (await db.from('waitlist_offers').select('id')
    .eq('booking_date', DATE).eq('bay_id', BAY).eq('status', 'offered')).data.length, 1);
  chk('still exactly one outbox message', (await db.from('notifications').select('id')
    .eq('dedupe_key', `waitlist.offer:email:${offerId}`)).data.length, 1);
  chk('still exactly one held row', (await db.from('bookings').select('id')
    .eq('booking_date', DATE).eq('bay_id', BAY).eq('status', 'held')).data.length, 1);

  // ---------- 5. the claim ----------
  console.log('\nTHE CLAIM');
  const look = await call('GET', 'offer', { query: { token: claimToken }, headers: { host: 'localhost:4242' } });
  chk('the claim link resolves', [look.code, look.body.offer.status, look.body.offer.time], [200, 'offered', '10:00 AM–11:00 AM']);
  chk('and it has time left on it', look.body.offer.secondsLeft > 0, true);

  const claimed = await call('POST', 'claim', { body: { token: claimToken }, headers: { host: 'localhost:4242' } });
  chk('claiming works', [claimed.code, claimed.body.ok], [200, true]);
  chk('and hands back the slot for checkout', [claimed.body.slot.bayId, claimed.body.slot.startMin], [BAY, START]);
  chk('the offer is claimed', (await db.from('waitlist_offers').select('status').eq('id', offerId).single()).data.status, 'claimed');
  chk('the hold is released so the normal checkout can take it', (await db.from('bookings').select('id')
    .eq('booking_date', DATE).eq('bay_id', BAY).eq('status', 'held')).data.length, 0);
  chk('releasing it did NOT re-offer the slot to anybody else', (await db.from('waitlist_wakeups').select('id')
    .eq('booking_date', DATE).eq('bay_id', BAY).is('processed_at', null)).data.length, 0);
  const claimAgain = await call('POST', 'claim', { body: { token: claimToken }, headers: { host: 'localhost:4242' } });
  chk('a second tap on the same link is not a second claim', [claimAgain.code, claimAgain.body.already], [200, true]);
} catch (err) {
  fails++;
  console.error('\nERROR:', err && err.message ? err.message : err);
} finally {
  // ---------- cleanup ----------
  console.log('\nCLEANUP');
  await db.from('settings').update({ waitlist: savedWaitlist }).eq('id', 1);
  if (offerId) await db.from('notifications').delete().like('dedupe_key', `waitlist.offer:%:${offerId}`);
  if (entryId) await db.from('notifications').delete().like('dedupe_key', `waitlist.joined:%:${entryId}`);
  if (entryId) await db.from('waitlist_offers').delete().eq('entry_id', entryId);
  if (entryId) await db.from('waitlist_entries').delete().eq('id', entryId);
  await db.from('waitlist_wakeups').delete().eq('booking_date', DATE).eq('bay_id', BAY);
  await db.from('bookings').delete().eq('booking_date', DATE).eq('bay_id', BAY).eq('status', 'held');
  if (bookingId) await db.from('bookings').delete().eq('id', bookingId);
  await db.from('customers').delete().eq('email', EMAIL);

  const left = {
    entries: (await db.from('waitlist_entries').select('id').eq('booking_date', DATE)).data?.length ?? 0,
    offers: (await db.from('waitlist_offers').select('id').eq('booking_date', DATE)).data?.length ?? 0,
    wakeups: (await db.from('waitlist_wakeups').select('id').eq('booking_date', DATE)).data?.length ?? 0,
    bookings: (await db.from('bookings').select('id').eq('booking_date', DATE).eq('bay_id', BAY)).data?.length ?? 0,
    notifications: (await db.from('notifications').select('id').eq('recipient', EMAIL)).data?.length ?? 0,
    customers: (await db.from('customers').select('id').eq('email', EMAIL)).data?.length ?? 0,
  };
  chk('every test row is gone', left, { entries: 0, offers: 0, wakeups: 0, bookings: 0, notifications: 0, customers: 0 });
  console.log(fails ? `\n${fails} check(s) FAILED.` : '\nAll checks passed.');
  process.exit(fails ? 1 : 0);
}
