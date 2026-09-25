#!/usr/bin/env node
// Live-database verification for group + recurring bookings (migration 0023).
//
// Runs the REAL endpoint (api/booking-series.js) and the REAL access layer (lib/db.js) against the
// REAL database in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
//
// THE TEST THAT MATTERS is test B. Everything else is scaffolding around it. A group booking is
// several rows behind one gist exclusion constraint, so the question that decides whether this
// feature is safe to ship is: when the FIFTH bay collides, do the first four stay in the ground?
// Test B blocks exactly one bay of five, calls book_group() directly — no pre-flight check, no
// chance to bail out early — and asserts that the bookings table is byte-for-byte what it was
// before, with no orphan booking_groups row either.
//
// Everything it creates is marked ZZTEST and deleted again, and the last assertion is that the
// bookings table is empty.
//
//   node scripts/verify-group-series.mjs
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { admin, bookGroup, groupById } from '../lib/db.js';
import { normalizeSettings, quoteGroup, allocateCents } from '../lib/booking.js';
import handler from '../api/booking-series.js';

const NOTE = 'ZZTEST group/series verification';
const rnd = Math.random().toString(36).slice(2, 8);
const db = admin();
if (!db) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.'); process.exit(1); }

let fails = 0;
const chk = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(want)})`}`);
};
const head = (t) => console.log(`\n${t}`);

// ---- schema probe: say so plainly instead of failing thirty assertions -----------------------
const probe = async (t) => { const { error } = await db.from(t).select('*').limit(1); return !error; };
const have = await probe('booking_series') && await probe('booking_groups')
  && await probe('booking_series_exceptions') && await probe('refunds');
console.log(`schema: 0023 tables ${have ? 'present' : 'MISSING'}`);

// ---- fixtures --------------------------------------------------------------------------------
const settingsRow = await db.from('settings').select('*').eq('id', 1).single().then((r) => r.data);
const settings = normalizeSettings(settingsRow);
const BAYS = settings.bays.filter((b) => !b.holding).map((b) => b.id);
if (BAYS.length < 3) { console.error('Need at least 3 bays to test a group booking.'); process.exit(1); }
const GROUP_BAYS = BAYS.slice(0, Math.min(5, BAYS.length));
const VICTIM = GROUP_BAYS[GROUP_BAYS.length - 1];        // the ONE bay we will block
const START = 600, END = 720;                            // 10:00–12:00
const iso = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const D_GROUP = iso(40), D_ATOMIC = iso(41), D_SERIES = iso(45);

console.log(`bays: ${GROUP_BAYS.join(', ')}   victim bay: ${VICTIM}   dates: ${D_GROUP} / ${D_ATOMIC} / ${D_SERIES}+`);

// A booking count that is stable to compare against — the whole table, since it starts empty.
const bookingCount = async () => (await db.from('bookings').select('*', { count: 'exact', head: true })).count;
const bookingRows = async (dateISO) => (await db.from('bookings')
  .select('id,bay_id,booking_date,start_min,end_min,status,amount_cents,refunded_cents,group_id,series_id')
  .eq('booking_date', dateISO).order('bay_id')).data || [];

// ---- a manager session, because every action here is manager-only ----------------------------
// Made and destroyed by this script; nothing is left behind in auth.
const tmpEmail = `zztest-series-${rnd}@invictus.test`;
const tmpPass = `Zz!${rnd}${rnd}`;
const made = await db.auth.admin.createUser({ email: tmpEmail, password: tmpPass, email_confirm: true });
if (made.error) { console.error('could not create a temporary manager user:', made.error.message); process.exit(1); }
const tmpUserId = made.data.user.id;
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const signed = await anon.auth.signInWithPassword({ email: tmpEmail, password: tmpPass });
if (signed.error) { console.error('could not sign in as the temporary manager:', signed.error.message); process.exit(1); }
const AUTH = `Bearer ${signed.data.session.access_token}`;

// Call the endpoint the way Vercel/express does.
const call = async (method, action, { body, query, headers } = {}) => {
  const req = { method, query: { action, ...(query || {}) }, body: body || {},
    headers: { authorization: AUTH, ...(headers || {}) }, socket: {} };
  const res = { code: 200, body: null,
    status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; } };
  await handler(req, res);
  return res;
};

// ---- before the gate: prove it degrades instead of exploding ---------------------------------
// This is worth running on a database that has NOT had 0023 applied, which is why it sits above
// the gate. The repo's standing rule is that a missing migration logs and no-ops; a 500 with a
// Postgres error in it is not "unconfigured", it is a crash.
if (!have) {
  console.log('\nDEGRADATION — migration 0023 is not applied; every path must say so, not throw');
  const noAuth = await (async () => {
    const req = { method: 'POST', query: { action: 'create' }, body: {}, headers: {}, socket: {} };
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
    await handler(req, res); return res;
  })();
  chk('create without a manager session → 401', noAuth.code, 401);

  const bad = await call('POST', 'create', { body: { freq: 'weekly', startDate: iso(10), bayIds: [GROUP_BAYS[0]], startMin: 600, endMin: 720 } });
  chk('an unbounded repeat is refused in words, not by a constraint name', bad.code, 400);
  chk('…and the words are usable', /end date or a number of sessions/.test(bad.body.error), true);

  const nb = await call('POST', 'create', { body: { freq: 'once', startDate: iso(10), bayIds: [], startMin: 600, endMin: 720 } });
  chk('no bays → 400', [nb.code, nb.body.error], [400, 'Pick at least one bay.']);

  const gone = await call('POST', 'create', { body: { freq: 'once', startDate: iso(10), bayIds: GROUP_BAYS, startMin: 600, endMin: 720 } });
  chk('a real request on a database without 0023 → 503, not 500', gone.code, 503);
  chk('…with a machine-readable reason', gone.body.code, 'schema');
  chk('…and no rows written', await bookingCount(), 0);

  const cn = await call('POST', 'cancel', { body: { groupId: '00000000-0000-4000-8000-000000000000' } });
  chk('cancel on a database without 0023 → 503, not 500', cn.code, 503);

  await db.auth.admin.deleteUser(tmpUserId).catch(() => {});
  console.log(`\n${fails ? `${fails} FAILED` : 'degradation checks passed'}`);
  console.error('\nTo run the REST of this script, paste');
  console.error('  supabase/migrations/0023_group_recurring_bookings.sql');
  console.error('into Supabase → SQL Editor → Run, then re-run it.');
  process.exit(fails ? 1 : 2);
}

const madeSeries = [];
const blockerIds = [];
let exitCode = 0;

try {
  // ==========================================================================================
  head('0) baseline');
  const startCount = await bookingCount();
  chk('bookings table starts empty', startCount, 0);

  // ==========================================================================================
  head('1) auth gate — nothing here is open to the public');
  const noAuth = await (async () => {
    const req = { method: 'POST', query: { action: 'create' }, body: {}, headers: {}, socket: {} };
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
    await handler(req, res); return res;
  })();
  chk('create without a manager session → 401', noAuth.code, 401);

  // ==========================================================================================
  head(`2) GROUP — reserve ${GROUP_BAYS.length} bays at once on ${D_GROUP}`);
  const g = await call('POST', 'create', { body: {
    label: `${NOTE} group`, freq: 'once', startDate: D_GROUP,
    bayIds: GROUP_BAYS, startMin: START, endMin: END, players: 8,
    name: 'ZZTEST Group', email: `zztest-${rnd}@invictus.test`, note: NOTE,
  } });
  if (g.body && g.body.series) madeSeries.push(g.body.series.id);
  chk('create → 200', g.code, 200);
  chk('one occurrence booked', g.body && g.body.bookedCount, 1);
  chk('nothing skipped', g.body && g.body.skippedCount, 0);
  chk('all bays written in one occurrence', g.body && g.body.booked[0].bays, GROUP_BAYS.length);

  const gRows = await bookingRows(D_GROUP);
  chk('booking rows on the day', gRows.length, GROUP_BAYS.length);
  chk('every row carries the group', gRows.every((r) => r.group_id === g.body.booked[0].groupId), true);
  chk('every row carries the series', gRows.every((r) => r.series_id === g.body.series.id), true);
  chk('bays are exactly the ones asked for', gRows.map((r) => r.bay_id), [...GROUP_BAYS].sort());

  // Pricing: the per-bay amounts must add up to what the occurrence was charged, to the cent.
  const grp = await groupById(g.body.booked[0].groupId);
  const sumBays = gRows.reduce((a, r) => a + (r.amount_cents || 0), 0);
  chk('per-bay amounts sum to the group total', sumBays, grp.amount_cents);
  chk('group total is what the quote said', grp.amount_cents, g.body.booked[0].amountCents);
  const q = quoteGroup({ settings, dateISO: D_GROUP, bayIds: GROUP_BAYS, startMin: START, endMin: END, todayISO: D_GROUP });
  chk('quoted through the one waterfall (quoteBooking)', grp.amount_cents, q.charge);

  // ==========================================================================================
  head(`3) ATOMICITY — one bay of ${GROUP_BAYS.length} is taken; NO rows may land`);
  // A single blocker, on one bay only.
  const blocker = await db.from('bookings').insert({
    bay_id: VICTIM, booking_date: D_ATOMIC, start_min: START, end_min: END,
    status: 'confirmed', source: 'manager', note: `${NOTE} blocker`,
  }).select('id').single();
  if (blocker.error) throw new Error(`could not place the blocker: ${blocker.error.message}`);
  blockerIds.push(blocker.data.id);

  const before = await bookingCount();
  const groupsBefore = (await db.from('booking_groups').select('*', { count: 'exact', head: true })).count;

  // Straight at book_group(), with no pre-flight conflict check in front of it. This is the path
  // that has to be atomic; anything that checks first is only ever hiding the question.
  const seriesForAtomic = await db.from('booking_series').insert({
    label: `${NOTE} atomic`, freq: 'once', start_date: D_ATOMIC,
    bay_ids: GROUP_BAYS, start_min: START, end_min: END, source: 'manager', note: NOTE,
  }).select('*').single();
  if (seriesForAtomic.error) throw new Error(seriesForAtomic.error.message);
  madeSeries.push(seriesForAtomic.data.id);

  const share = allocateCents(GROUP_BAYS.map(() => 1), 5000);
  const raw = await bookGroup({
    group: {
      series_id: seriesForAtomic.data.id, occurrence_date: D_ATOMIC, booking_date: D_ATOMIC, seq: 1,
      start_min: START, end_min: END, status: 'confirmed', amount_cents: 5000, list_price_cents: 5000,
      note: NOTE,
    },
    rows: GROUP_BAYS.map((bayId, i) => ({
      bay_id: bayId, start_min: START, end_min: END, status: 'confirmed',
      customer_name: 'ZZTEST Atomic', amount_cents: share[i], source: 'manager', note: NOTE,
    })),
  });

  chk('book_group reports a conflict', raw.conflict, true);
  chk('…and names the bay that lost', raw.bay, VICTIM);
  chk('NO booking rows landed', await bookingCount(), before);
  chk('…and the blocker is still the only row that day', (await bookingRows(D_ATOMIC)).map((r) => r.bay_id), [VICTIM]);
  chk('NO orphan booking_groups row', (await db.from('booking_groups').select('*', { count: 'exact', head: true })).count, groupsBefore);

  // And the same story through the endpoint, which checks first and so reports every clash at once.
  const gc = await call('POST', 'create', { body: {
    label: `${NOTE} atomic-api`, freq: 'once', startDate: D_ATOMIC,
    bayIds: GROUP_BAYS, startMin: START, endMin: END, note: NOTE,
  } });
  if (gc.body && gc.body.series) madeSeries.push(gc.body.series.id);
  chk('endpoint books nothing', gc.body && gc.body.bookedCount, 0);
  chk('endpoint records the skip', gc.body && gc.body.skipped[0] && gc.body.skipped[0].reason, 'conflict');
  chk('…naming the bay', gc.body && gc.body.skipped[0] && gc.body.skipped[0].bays, [VICTIM]);
  chk('still no extra rows', await bookingCount(), before);
  const exc = await db.from('booking_series_exceptions').select('*').eq('series_id', gc.body.series.id);
  chk('the skip is RECORDED, not dropped', (exc.data || []).map((x) => [x.kind, x.reason]), [['skipped', 'conflict']]);

  // ==========================================================================================
  head('4) RECURRING — weekly ×4, with week 2 already taken');
  const D2 = (() => { const d = new Date(`${D_SERIES}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); })();
  const b2 = await db.from('bookings').insert({
    bay_id: VICTIM, booking_date: D2, start_min: START, end_min: END,
    status: 'confirmed', source: 'manager', note: `${NOTE} blocker wk2`,
  }).select('id').single();
  if (b2.error) throw new Error(b2.error.message);
  blockerIds.push(b2.data.id);

  const s = await call('POST', 'create', { body: {
    label: `${NOTE} league`, freq: 'weekly', intervalN: 1, startDate: D_SERIES, maxOccurrences: 4,
    bayIds: GROUP_BAYS, startMin: START, endMin: END, note: NOTE,
    name: 'ZZTEST League', email: `zztest-lg-${rnd}@invictus.test`,
    throughDate: (() => { const d = new Date(`${D_SERIES}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 30); return d.toISOString().slice(0, 10); })(),
  } });
  const SID = s.body && s.body.series && s.body.series.id;
  if (SID) madeSeries.push(SID);
  chk('3 of 4 weeks booked', s.body && s.body.bookedCount, 3);
  chk('1 week skipped', s.body && s.body.skippedCount, 1);
  chk('…on the right date', s.body && s.body.skipped[0].date, D2);
  chk('…for the right reason', s.body && s.body.skipped[0].reason, 'conflict');
  chk('…naming the bay that was taken', s.body && s.body.skipped[0].bays, [VICTIM]);
  chk('the blocked week left NO partial rows', (await bookingRows(D2)).map((r) => r.bay_id), [VICTIM]);

  const view = await call('GET', 'get', { query: { id: SID } });
  const states = (view.body.occurrences || []).map((o) => o.state);
  chk('the series remembers every date and its fate', states, ['booked', 'skipped', 'booked', 'booked']);
  chk('the skip carries its reason', view.body.occurrences[1].detail.reason, 'conflict');

  // Idempotency: a second horizon pass must not double-book or retry the recorded skip.
  const countAfterSeries = await bookingCount();
  const again = await call('POST', 'extend', { body: { seriesId: SID } });
  chk('a second horizon pass books nothing new', again.body && again.body.booked, 0);
  chk('…and writes no rows', await bookingCount(), countAfterSeries);

  // ==========================================================================================
  head('5) PARTIAL CANCELLATION + the refunds ledger');
  const occ = (view.body.occurrences || []).filter((o) => o.state === 'booked');
  const partialGroup = occ[0].detail.groupId;
  const dropBays = GROUP_BAYS.slice(0, 2);
  const pc = await call('POST', 'cancel', { body: { groupId: partialGroup, bayIds: dropBays, refund: true, reason: 'ZZTEST partial' } });
  chk('two bays cancelled', pc.body && pc.body.cancelledCount, 2);
  chk('the rest of the event stands', pc.body && pc.body.remaining, GROUP_BAYS.length - 2);
  chk('the group is marked partial', pc.body && pc.body.groupStatus, 'partial');
  chk('refunds were written', (pc.body.refunds || []).length, 2);
  chk('and NO money moved', pc.body && pc.body.moneyMoved, false);

  const refRows = await db.from('refunds').select('*').eq('group_id', partialGroup);
  chk('refund rows are pending, not settled', (refRows.data || []).map((r) => r.status), ['pending', 'pending']);
  const cancelledRows = (await db.from('bookings').select('bay_id,status,refunded_cents').eq('group_id', partialGroup).order('bay_id')).data;
  chk('the cancelled bays are cancelled', cancelledRows.filter((r) => r.status === 'cancelled').map((r) => r.bay_id), [...dropBays].sort());
  chk('refunded_cents was booked against them', cancelledRows.filter((r) => r.status === 'cancelled').every((r) => r.refunded_cents > 0), true);
  const pcAgain = await call('POST', 'cancel', { body: { groupId: partialGroup, bayIds: dropBays, refund: true } });
  chk('re-cancelling the same bays is a no-op', pcAgain.body && pcAgain.body.cancelledCount, 0);

  // The freed bays must be genuinely free again — the constraint ignores cancelled rows.
  const reuse = await db.from('bookings').insert({
    bay_id: dropBays[0], booking_date: occ[0].date, start_min: START, end_min: END,
    status: 'confirmed', source: 'manager', note: `${NOTE} reuse`,
  }).select('id').single();
  chk('a cancelled bay can be re-sold', !reuse.error, true);
  if (reuse.data) blockerIds.push(reuse.data.id);

  // ==========================================================================================
  head('6) A CANCELLED OCCURRENCE STAYS CANCELLED');
  const killGroup = occ[1].detail.groupId;
  const fc = await call('POST', 'cancel', { body: { groupId: killGroup, refund: false, reason: 'ZZTEST full' } });
  chk('the whole occurrence is cancelled', fc.body && fc.body.groupStatus, 'cancelled');
  chk('nothing is left standing', fc.body && fc.body.remaining, 0);
  const afterKill = await bookingCount();
  const revive = await call('POST', 'extend', { body: { seriesId: SID } });
  chk('the horizon pass does NOT resurrect it', revive.body && revive.body.booked, 0);
  chk('…and writes no rows', await bookingCount(), afterKill);
  const view2 = await call('GET', 'get', { query: { id: SID } });
  chk('the series shows it as cancelled', view2.body.occurrences.map((o) => o.state), ['booked', 'skipped', 'cancelled', 'booked']);

  // ==========================================================================================
  head('7) MOVING ONE OCCURRENCE DOES NOT BREAK THE SERIES');
  const moveGroupId = occ[2].detail.groupId;
  const newDate = (() => { const d = new Date(`${occ[2].date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 2); return d.toISOString().slice(0, 10); })();
  const mv = await call('POST', 'move', { body: { groupId: moveGroupId, dateISO: newDate, startMin: START + 60, endMin: END + 60 } });
  chk('move → 200', mv.code, 200);
  chk('it moved every bay', mv.body && mv.body.moved, GROUP_BAYS.length);
  const movedGroup = await groupById(moveGroupId);
  chk('booking_date followed the move', movedGroup.booking_date, newDate);
  chk('occurrence_date did NOT — the recurrence keeps its slot', movedGroup.occurrence_date, occ[2].date);
  chk('the rows followed too', (await bookingRows(newDate)).length, GROUP_BAYS.length);
  const view3 = await call('GET', 'get', { query: { id: SID } });
  chk('the series reports it as moved', view3.body.occurrences[3].state, 'moved');
  const afterMove = await bookingCount();
  const revive2 = await call('POST', 'extend', { body: { seriesId: SID } });
  chk('the horizon pass does NOT refill the vacated date', revive2.body && revive2.body.booked, 0);
  chk('…and writes no rows', await bookingCount(), afterMove);
} catch (err) {
  fails++;
  exitCode = 1;
  console.error('\nUNEXPECTED ERROR:', err && err.message);
} finally {
  // ==========================================================================================
  head('8) cleanup');
  for (const id of madeSeries) {
    await db.from('refunds').delete().in('group_id',
      ((await db.from('booking_groups').select('id').eq('series_id', id)).data || []).map((r) => r.id));
    await db.from('bookings').delete().eq('series_id', id);
    await db.from('booking_series').delete().eq('id', id);   // cascades groups + exceptions
  }
  if (blockerIds.length) await db.from('bookings').delete().in('id', blockerIds);
  await db.auth.admin.deleteUser(tmpUserId).catch(() => {});

  const left = await bookingCount();
  chk('bookings table is empty again', left, 0);
  const leftGroups = (await db.from('booking_groups').select('*', { count: 'exact', head: true })).count;
  const leftSeries = (await db.from('booking_series').select('*', { count: 'exact', head: true })).count;
  const leftRefunds = (await db.from('refunds').select('*', { count: 'exact', head: true })).count;
  chk('no booking_groups left', leftGroups, 0);
  chk('no booking_series left', leftSeries, 0);
  chk('no refunds left', leftRefunds, 0);
}

console.log(`\n${fails ? `${fails} FAILED` : 'all checks passed'}`);
process.exit(fails ? (exitCode || 1) : 0);
