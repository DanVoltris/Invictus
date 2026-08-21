// Supabase access for the server (API routes / webhook).
// Uses the SERVICE-ROLE key, which bypasses Row Level Security — server-only, never shipped to the browser.
import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import { DEMO_HOUR_CARDS } from './booking.js';

const URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const dbEnabled = Boolean(URL && SERVICE_KEY);

// Lazily create a singleton admin client (or null when not configured yet).
let _admin = null;
export function admin() {
  if (!dbEnabled) return null;
  if (!_admin) _admin = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
  return _admin;
}

// Read the single settings row (or null if DB not configured / not seeded).
export async function getSettings() {
  const db = admin();
  if (!db) return null;
  const { data, error } = await db.from('settings').select('*').eq('id', 1).single();
  if (error) { console.error('getSettings:', error.message); return null; }
  return data;
}

// All schedule overrides that apply on a given ISO date (closures, special hours,
// and time-range blocks). An override applies when it is active and the date falls
// inside [override_date, end_date || override_date].
export async function getOverridesForDate(dateISO) {
  const db = admin();
  if (!db) return [];
  const { data, error } = await db
    .from('schedule_overrides')
    .select('*')
    .lte('override_date', dateISO)
    .order('created_at');
  if (error) { console.error('getOverridesForDate:', error.message); return []; }
  return (data || []).filter((o) =>
    o.is_active !== false && dateISO >= o.override_date && dateISO <= (o.end_date || o.override_date));
}

// Active (non-cancelled) bookings for a given ISO date — used to compute availability.
// Includes live cart holds ('held' with a future expires_at); stale holds are dropped so they
// neither block nor display as busy.
export async function getBookingsForDate(dateISO) {
  const db = admin();
  if (!db) return [];
  let { data, error } = await db
    .from('bookings')
    .select('bay_id,start_min,end_min,status,expires_at')
    .eq('booking_date', dateISO)
    .neq('status', 'cancelled');
  // Before migration 0012 there's no expires_at column — fall back so availability still works.
  if (error && /expires_at/i.test(error.message || '')) {
    ({ data, error } = await db.from('bookings')
      .select('bay_id,start_min,end_min,status').eq('booking_date', dateISO).neq('status', 'cancelled'));
  }
  if (error) { console.error('getBookingsForDate:', error.message); return []; }
  const now = new Date().toISOString();
  return (data || []).filter((b) => b.status !== 'held' || (b.expires_at && b.expires_at > now));
}

// ----- Cart holds -----
const HOLD_MINUTES = 5;

// Delete lapsed holds (abandoned carts). Runs before creating a hold / reading availability so a
// stale row never keeps a slot locked. Swallows the error if migration 0012 hasn't been applied.
export async function cleanupExpiredHolds() {
  const db = admin();
  if (!db) return;
  const now = new Date().toISOString();
  const { error } = await db.from('bookings').delete().eq('status', 'held').lt('expires_at', now);
  if (error && !/expires_at|held|constraint|check/i.test(error.message || '')) console.error('cleanupExpiredHolds:', error.message);
}

// Lock a slot with a short-lived 'held' row. The bookings_no_overlap exclusion constraint makes this
// atomic: if the slot is already booked/blocked/held, the insert fails and we report a conflict.
export async function createHold({ dateISO, bayId, startMin, endMin }) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  await cleanupExpiredHolds();
  const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60000).toISOString();
  const { error } = await db.from('bookings').insert({
    bay_id: bayId, booking_date: dateISO, start_min: startMin, end_min: endMin,
    status: 'held', expires_at: expiresAt, source: 'online',
  });
  if (error) {
    if (error.code === '23P01' || /overlap|exclusion/i.test(error.message || '')) return { conflict: true };
    // Before migration 0012, 'held'/expires_at aren't valid — skip holding so checkout still works.
    if (/check constraint|violates check|expires_at|column .* does not exist|invalid input value/i.test(error.message || '')) {
      console.warn('createHold: cart holds unavailable until migration 0012 is applied:', error.message);
      return { unsupported: true };
    }
    console.error('createHold:', error.message);
    return { error: error.message };
  }
  return { expiresAt, holdMinutes: HOLD_MINUTES };
}

// Release a hold (cart closed/abandoned) — only deletes a 'held' row, never a real booking.
export async function releaseHold({ dateISO, bayId, startMin, endMin }) {
  const db = admin();
  if (!db) return;
  const { error } = await db.from('bookings').delete()
    .eq('booking_date', dateISO).eq('bay_id', bayId).eq('start_min', startMin).eq('end_min', endMin)
    .eq('status', 'held');
  if (error && !/expires_at|held/i.test(error.message || '')) console.error('releaseHold:', error.message);
}

// Turn this slot's live hold into a confirmed booking (called by the webhook on payment success).
// Returns { updated } — 0 means there was no live hold to flip (expired/released), so the caller
// should fall back to a fresh insert.
export async function confirmHold({ dateISO, bayId, startMin, endMin, patch }) {
  const db = admin();
  if (!db) return { updated: 0 };
  const { data, error } = await db.from('bookings')
    .update({ ...patch, status: 'confirmed', expires_at: null })
    .eq('booking_date', dateISO).eq('bay_id', bayId).eq('start_min', startMin).eq('end_min', endMin)
    .eq('status', 'held')
    .select('id');
  if (error) { console.error('confirmHold:', error.message); return { updated: 0, error: error.message }; }
  return { updated: (data || []).length, id: (data && data[0] && data[0].id) || null };
}

// Insert a confirmed booking (used by the Stripe webhook). The DB exclusion constraint
// guarantees no overlap; a conflict surfaces as an error we log and return.
export async function insertBooking(row) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const { data, error } = await db.from('bookings').insert(row).select('id').maybeSingle();
  if (error) console.error('insertBooking:', error.message);
  return { error: error?.message || null, id: (data && data.id) || null };
}

// ----- Prepaid hour cards -----
// Owner-configured packages for the /hours purchase page + admin.
export async function listHourCards() {
  const db = admin();
  if (!db) return DEMO_HOUR_CARDS;   // placeholder catalogue until Supabase is connected
  const { data, error } = await db.from('hour_cards').select('id,name,hours,price_cents,color,sort').order('sort');
  if (error) { console.error('listHourCards:', error.message); return []; }
  return data || [];
}

// A paid hour-card purchase → credit the minutes to the customer (match/create by email) + ledger.
// `ref` (the Stripe session id) makes it idempotent: a refresh of the success page won't double-credit.
export async function grantHours({ name, email, phone, minutes, ref }) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const up = await upsertCustomer({ name, email, phone });
  if (up.error) return { error: up.error };
  if (!up.id) return { error: 'Could not identify the customer to credit these hours.' };
  if (ref) {
    const { data: seen } = await db.from('hour_transactions').select('id').eq('ref', ref).limit(1);
    if (seen && seen[0]) {
      const { data: c } = await db.from('customers').select('hours_balance_min').eq('id', up.id).maybeSingle();
      return { customerId: up.id, balanceMin: c ? c.hours_balance_min : null, already: true };
    }
  }
  const { data, error } = await db.rpc('adjust_hours', { p_customer: up.id, p_delta_min: Math.round(minutes), p_kind: 'purchase', p_note: 'Hour card purchase', p_booking: null, p_ref: ref || null });
  if (error) return { error: error.message };
  return { customerId: up.id, balanceMin: data };
}

// Normalize a phone number to a comparable digit key, or null when it can't be a real number.
// North American numbers key as "1" + 10 digits; international numbers (typed with +, 00, or a
// bare country-code form) key as their full digit string. Formatting never matters:
//   "(204) 990-6530" / "+1 204 990 6530" / "12049906530"  → "12049906530"
//   "+44 20 7946 0958" / "0044 20 7946 0958"              → "442079460958"
// Limitation: an international number typed WITHOUT its country code (e.g. UK "020 7946 0958")
// can't be attributed to a country and won't match the +44 form.
function normPhone(p) {
  const raw = String(p || '').trim();
  let d = raw.replace(/\D/g, '');
  const intl = raw.startsWith('+') || (d.startsWith('00') && d.length >= 12);
  if (intl && d.startsWith('00')) d = d.slice(2);           // 00 international dialing prefix
  if (d.length === 10 && !intl) return '1' + d;             // bare NANP national number
  if (d.length === 11 && d[0] === '1') return d;            // NANP with its country code
  if (d.length >= 11 && d.length <= 15) return d;           // country code + national number
  if (intl && d.length >= 8 && d.length <= 15) return d;    // short full numbers (some countries)
  return null;
}

// Look up a customer + their hours balance — by phone first (digits-insensitive), then email.
// Phone is the primary key customers reuse; email stays as a fallback so nobody gets stranded.
export async function customerHoursByContact({ email, phone } = {}) {
  const db = admin();
  if (!db) return null;
  const n = normPhone(phone);
  if (n) {
    // Match on the last 4 digits server-side, then compare full normalized numbers here —
    // stored phones vary in formatting ("(204) 990-6530" vs "2049906530").
    // select('*') so optional columns (hours_balance_min, points_balance) ride along when present.
    const { data } = await db.from('customers').select('*')
      .not('phone', 'is', null).like('phone', `%${n.slice(-4)}%`).limit(25);
    const hit = (data || []).find((c) => normPhone(c.phone) === n);
    if (hit) return hit;
  }
  const e = (email || '').trim().toLowerCase();
  if (e) {
    const { data } = await db.from('customers').select('*').ilike('email', e).limit(1);
    if (data && data[0]) return data[0];
  }
  return null;
}

// Everything a customer sees on their /account page: profile, balances, membership, bookings.
// Matched by phone (digits-insensitive) or email — same rules as the balance lookups.
export async function accountSummary({ email, phone } = {}) {
  const db = admin();
  if (!db) return null;
  const cust = await customerHoursByContact({ email, phone });
  if (!cust) return null;

  // Bookings that belong to this customer: by email and/or phone (normalized), deduped.
  const rows = new Map();
  const e = ((cust.email || email) || '').trim().toLowerCase();
  if (e) {
    const { data } = await db.from('bookings').select('id,bay_id,booking_date,start_min,end_min,status,source,created_at')
      .ilike('customer_email', e).neq('status', 'blocked').order('booking_date', { ascending: false }).limit(50);
    (data || []).forEach((b) => rows.set(b.id, b));
  }
  const n = normPhone(cust.phone || phone);
  if (n) {
    const { data } = await db.from('bookings').select('id,bay_id,booking_date,start_min,end_min,status,source,customer_phone,created_at')
      .not('customer_phone', 'is', null).like('customer_phone', `%${n.slice(-4)}%`)
      .neq('status', 'blocked').order('booking_date', { ascending: false }).limit(50);
    (data || []).forEach((b) => { if (normPhone(b.customer_phone) === n) rows.set(b.id, b); });
  }
  const bookings = [...rows.values()]
    .filter((b) => b.status !== 'held')
    .sort((a, b) => (a.booking_date === b.booking_date ? a.start_min - b.start_min : (a.booking_date < b.booking_date ? 1 : -1)))
    .slice(0, 30);

  let membership = null;
  if (cust.membership_id) {
    const { data: m } = await db.from('memberships').select('name,color').eq('id', cust.membership_id).maybeSingle();
    if (m) membership = { name: m.name, color: m.color, expires: cust.membership_expires || null };
  }
  return { customer: cust, bookings, membership };
}

// ----- Loyalty points -----
// Atomic points change + ledger entry (see adjust_points in migration 0016).
export async function adjustPoints({ customerId, delta, kind, note, bookingId, ref }) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const { data, error } = await db.rpc('adjust_points', {
    p_customer: customerId, p_delta: Math.round(delta), p_kind: kind || 'adjust',
    p_note: note || null, p_booking: bookingId || null, p_ref: ref || null,
  });
  if (error) return { error: error.message };
  return { balance: data };
}

// Award the earn-points for a booking — once, ever (the ledger's unique earn-per-booking index is
// the guard; a duplicate attempt comes back as `already`). Missing migration 0016 degrades silently.
export async function awardBookingPoints({ customerId, bookingId, points, note }) {
  if (!(points > 0) || !customerId || !bookingId) return { skipped: true };
  const r = await adjustPoints({ customerId, delta: points, kind: 'earn', note: note || 'Time played', bookingId });
  if (r.error) {
    if (/duplicate|unique|point_tx_earn_once/i.test(r.error)) return { already: true };
    if (/adjust_points|does not exist|schema cache/i.test(r.error)) return { unsupported: true };
    return { error: r.error };
  }
  return { balance: r.balance };
}

// Book a slot fully covered by points: deduct first (atomic, rejects if short), then confirm the
// booking (flip the live hold or insert); refund the points if the slot turns out to be taken.
export async function bookWithPoints({ dateISO, bayId, startMin, endMin, name, email, phone, points, statusLabel }) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const cust = await customerHoursByContact({ email, phone });
  if (!cust) return { error: 'no_account' };
  if ((cust.points_balance || 0) < points) return { error: 'insufficient', balance: cust.points_balance || 0 };

  const d = await adjustPoints({ customerId: cust.id, delta: -points, kind: 'redeem', note: `Booking ${dateISO}` });
  if (d.error) return { error: /insufficient/i.test(d.error) ? 'insufficient' : d.error };

  const patch = {
    status_label: statusLabel || 'Booked', customer_name: name || cust.name || null,
    customer_email: (email || '').trim() || null, customer_phone: (phone || '').trim() || null,
    amount_cents: 0, source: 'points',
  };
  const flip = await confirmHold({ dateISO, bayId, startMin: Number(startMin), endMin: Number(endMin), patch });
  let bookingId = flip.id;
  if (!flip.updated) {
    const ins = await insertBooking({ bay_id: bayId, booking_date: dateISO, start_min: Number(startMin), end_min: Number(endMin), status: 'confirmed', ...patch });
    if (ins.error) {
      await adjustPoints({ customerId: cust.id, delta: points, kind: 'adjust', note: 'Refund — slot unavailable' });
      return { error: 'taken' };
    }
    bookingId = ins.id;
  }
  return { ok: true, balance: d.balance, bookingId, customerId: cust.id };
}

// Book a slot by paying with prepaid hours: deduct first (atomic, rejects if short), then confirm the
// booking (flip the live hold or insert); refund the hours if the slot turns out to be taken.
export async function bookWithHours({ dateISO, bayId, startMin, endMin, name, email, phone, statusLabel }) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const minutes = Number(endMin) - Number(startMin);
  if (!(minutes > 0)) return { error: 'Invalid time range.' };
  const cust = await customerHoursByContact({ email, phone });
  if (!cust) return { error: 'no_account' };
  if ((cust.hours_balance_min || 0) < minutes) return { error: 'insufficient', balanceMin: cust.hours_balance_min || 0, neededMin: minutes };

  const { data: bal, error: dErr } = await db.rpc('adjust_hours', { p_customer: cust.id, p_delta_min: -minutes, p_kind: 'redeem', p_note: `Booking ${dateISO}`, p_booking: null });
  if (dErr) return { error: /insufficient/i.test(dErr.message) ? 'insufficient' : dErr.message };

  const patch = {
    status_label: statusLabel || 'Booked', customer_name: name || cust.name || null,
    customer_email: (email || '').trim() || null, customer_phone: (phone || '').trim() || null,
    amount_cents: 0, source: 'hours',
  };
  const flip = await confirmHold({ dateISO, bayId, startMin: Number(startMin), endMin: Number(endMin), patch });
  let bookingId = flip.id;
  if (!flip.updated) {
    const ins = await insertBooking({ bay_id: bayId, booking_date: dateISO, start_min: Number(startMin), end_min: Number(endMin), status: 'confirmed', ...patch });
    if (ins.error) {
      await db.rpc('adjust_hours', { p_customer: cust.id, p_delta_min: minutes, p_kind: 'adjust', p_note: 'Refund — slot unavailable', p_booking: null });
      return { error: 'taken' };
    }
    bookingId = ins.id;
  }
  return { ok: true, balanceMin: bal, bookingId, customerId: cust.id };
}

// Link a purchased membership to the customer: upsert their profile (by email/phone), then set the
// plan + expiry. Used by /api/confirm-membership after a paid Stripe Checkout session.
export async function grantMembership({ name, email, phone, membershipId, expiresAt }) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const up = await upsertCustomer({ name, email, phone });
  if (up.error) return { error: up.error };
  if (!up.id) return { error: 'Could not identify the customer to link this membership.' };
  const { error } = await db.from('customers')
    .update({ membership_id: membershipId, membership_expires: expiresAt || null, membership_flag: null })
    .eq('id', up.id);
  return { error: error?.message || null, customerId: up.id };
}

// Is there already a (non-cancelled) booking for this PaymentIntent? Keeps confirmation idempotent
// so the client-side confirm and the webhook can't create the booking twice.
export async function bookingExistsForPI(piId) {
  const db = admin();
  if (!db || !piId) return false;
  const { data } = await db.from('bookings').select('id').eq('stripe_payment_intent', piId).neq('status', 'cancelled').limit(1);
  return !!(data && data[0]);
}

// Save a booking customer into the customers table: match an existing profile by email or phone,
// backfill any missing contact fields (never overwrite), and set the SMS preference when given.
// Used by the webhook (reliable, contact only) and the /api/save-customer call (adds the SMS toggle).
export async function upsertCustomer({ name, email, phone, smsOptIn } = {}) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const e = (email || '').trim().toLowerCase(), p = (phone || '').trim(), n = (name || '').trim();
  if (!e && !p) return { skipped: true };   // need an email or phone to dedupe on
  const sms = (typeof smsOptIn === 'boolean') ? { sms_opt_in: smsOptIn } : {};

  // Phone is the primary identity (digits-insensitive), email the fallback — same matcher as
  // the balance lookups, so every path agrees on who a customer is.
  const cust = await customerHoursByContact({ email: e, phone: p });

  const run = async (payload, isInsert) => {
    let r = isInsert ? await db.from('customers').insert(payload).select('id').single()
                     : await db.from('customers').update(payload).eq('id', cust.id).select('id').maybeSingle();
    // Retry once without sms_opt_in if migration 0014 hasn't been applied.
    if (r.error && /sms_opt_in|column/i.test(r.error.message || '')) {
      const { sms_opt_in, ...rest } = payload;
      r = isInsert ? await db.from('customers').insert(rest).select('id').single()
                   : await db.from('customers').update(rest).eq('id', cust.id).select('id').maybeSingle();
    }
    // Phone matched one profile but the email belongs to another (unique column) — keep the
    // phone match and skip the email backfill rather than fail the whole save.
    if (r.error && /duplicate|unique/i.test(r.error.message || '') && payload.email) {
      const { email, ...rest } = payload;
      if (Object.keys(rest).length || isInsert) {
        r = isInsert ? await db.from('customers').insert(rest).select('id').single()
                     : await db.from('customers').update(rest).eq('id', cust.id).select('id').maybeSingle();
      } else return { data: { id: cust.id }, error: null };
    }
    return r;
  };

  if (cust) {
    const patch = { ...sms };
    if (n && !cust.name) patch.name = n;
    if (e && !cust.email) patch.email = e;
    if (p && !cust.phone) patch.phone = p;
    if (!Object.keys(patch).length) return { id: cust.id };
    const r = await run(patch, false);
    return { id: cust.id, error: r.error?.message || null };
  }
  const r = await run({ name: n || null, email: e || null, phone: p || null, ...sms }, true);
  return { id: r.data?.id || null, error: r.error?.message || null };
}

// One membership plan by id — used at checkout to read discount_pct. Null when the database
// is off, the id is empty, or the plan was deleted after the customer was assigned to it.
export async function membershipById(id) {
  const db = admin();
  if (!db || !id) return null;
  const { data } = await db.from('memberships').select('id,name,discount_pct').eq('id', id).limit(1);
  return (data && data[0]) || null;
}

// ----- Notifications outbox (migration 0019) -----
// The queue itself lives here; who to talk to and what to say lives in lib/notify.js.
//
// Every function below degrades the same way the rest of this file does: a database that has
// not had migration 0019 applied yet reports the table as missing, and we return
// { unsupported: true } after one warning rather than throwing. Nothing a customer does may
// fail because a notification could not be queued.

// True when Postgres/PostgREST is telling us the table or column simply isn't there yet
// (PGRST205 = unknown table, PGRST204 = unknown column, 42P01 = undefined_table).
function missingSchema(error) {
  if (!error) return false;
  const code = error.code || '';
  return code === 'PGRST205' || code === 'PGRST204' || code === '42P01' ||
    /schema cache|does not exist/i.test(error.message || '');
}
// Postgres unique_violation — for this table that is the dedupe index doing its job.
function isDuplicate(error) {
  return !!error && (error.code === '23505' || /duplicate key|unique constraint/i.test(error.message || ''));
}

// Queue one message. The unique index on dedupe_key is the guard: a second enqueue of the
// same logical message comes back as { already: true }, which is success, not an error.
export async function insertNotification(row) {
  const db = admin();
  if (!db) return { unsupported: true };
  const { data, error } = await db.from('notifications').insert(row).select('*').maybeSingle();
  if (error) {
    if (isDuplicate(error)) return { already: true };
    if (missingSchema(error)) {
      console.warn('insertNotification: outbox unavailable until migration 0019 is applied:', error.message);
      return { unsupported: true };
    }
    console.error('insertNotification:', error.message);
    return { error: error.message };
  }
  return { id: data?.id || null, row: data || null };
}

// The send worker's queue read: queued messages whose send_after has arrived, oldest first.
export async function dueNotifications({ limit = 20, nowISO } = {}) {
  const db = admin();
  if (!db) return [];
  const { data, error } = await db.from('notifications').select('*')
    .eq('status', 'queued').lte('send_after', nowISO || new Date().toISOString())
    .order('send_after').limit(limit);
  if (error) {
    if (missingSchema(error)) return [];
    console.error('dueNotifications:', error.message);
    return [];
  }
  return data || [];
}

// Record the outcome of a delivery attempt (sent / skipped / failed / re-queued with backoff).
export async function updateNotification(id, patch) {
  const db = admin();
  if (!db || !id) return { unsupported: true };
  const { error } = await db.from('notifications').update(patch).eq('id', id);
  if (error) {
    if (missingSchema(error)) return { unsupported: true };
    console.error('updateNotification:', error.message);
    return { error: error.message };
  }
  return { ok: true };
}

// ----- Stripe webhook idempotency (table from migration 0018) -----

// Claim a Stripe event id before doing its work. Insert-first is what makes this a lock:
// a duplicate delivery loses the race with a unique violation and is told to skip.
// Returns { duplicate: true } for an event already handled, { unsupported: true } when the
// table isn't there (the caller keeps its own per-feature guard, so that stays safe).
export async function recordStripeEvent(eventId) {
  const db = admin();
  if (!db || !eventId) return { unsupported: true };
  const { error } = await db.from('stripe_events').insert({ id: eventId });
  if (error) {
    if (isDuplicate(error)) return { duplicate: true };
    if (missingSchema(error)) {
      console.warn('recordStripeEvent: stripe_events unavailable until migration 0018 is applied — falling back to the per-booking guard.');
      return { unsupported: true };
    }
    console.error('recordStripeEvent:', error.message);
    return { error: error.message };
  }
  return { recorded: true };
}

// Release a claimed event id after the handler failed, so Stripe's retry can do the work
// instead of being turned away as a duplicate of an attempt that never finished.
export async function forgetStripeEvent(eventId) {
  const db = admin();
  if (!db || !eventId) return;
  const { error } = await db.from('stripe_events').delete().eq('id', eventId);
  if (error && !missingSchema(error)) console.error('forgetStripeEvent:', error.message);
}

// ----- CASL consent -----
// Record express consent at the point of collection: which channels, when, and from what IP.
// Consent is only ever recorded here when the customer actively gave it — never inferred from
// customers.sms_opt_in, which defaults to true and so records nothing (see migration 0019).
// Withdrawal is the mirror image: pass false to stamp <channel>_unsub_at and stop sending.
export async function recordConsent({ email, phone, name, emailConsent, smsConsent, ip, source } = {}) {
  const db = admin();
  if (!db) return { unsupported: true };
  if (typeof emailConsent !== 'boolean' && typeof smsConsent !== 'boolean') return { skipped: true };
  const up = await upsertCustomer({ name, email, phone });
  if (up.error) return { error: up.error };
  if (!up.id) return { skipped: true };

  const now = new Date().toISOString();
  const patch = {};
  if (typeof emailConsent === 'boolean') {
    Object.assign(patch, emailConsent
      ? { email_consent: true, email_consent_at: now, email_consent_ip: ip || null, email_consent_source: source || null, email_unsub_at: null }
      : { email_consent: false, email_unsub_at: now });
  }
  if (typeof smsConsent === 'boolean') {
    Object.assign(patch, smsConsent
      ? { sms_consent: true, sms_consent_at: now, sms_consent_ip: ip || null, sms_consent_source: source || null, sms_unsub_at: null }
      : { sms_consent: false, sms_unsub_at: now });
  }
  const { error } = await db.from('customers').update(patch).eq('id', up.id);
  if (error) {
    if (missingSchema(error)) {
      console.warn('recordConsent: consent columns unavailable until migration 0019 is applied:', error.message);
      return { customerId: up.id, unsupported: true };
    }
    console.error('recordConsent:', error.message);
    return { customerId: up.id, error: error.message };
  }
  return { customerId: up.id, ok: true };
}

// ----- Gift cards (migration 0020) -----
//
// A gift card is bearer value: whoever types the code can spend it. Three rules shape everything
// below, and all three are enforced here rather than left to each caller.
//
//   1. THE CODE IS NEVER STORED. Only sha256 of its normalized form, so a database dump is not a
//      pile of spendable cards. The plaintext exists exactly once — in the return value of
//      createGiftCard — and after that it lives only wherever the customer put it.
//   2. THE BALANCE IS NEVER DEBITED SPECULATIVELY. Checkout takes a reservation with the same
//      5-minute TTL as a cart hold (see createHold above); the debit happens only once Stripe
//      confirms the payment beside it succeeded. demo/index.html rebuilds its PaymentIntent on
//      every slot change, so anything else would drain a real card while the customer browses.
//   3. EVERY MOVEMENT GOES THROUGH adjust_gift_card. Balance and ledger change together or not
//      at all — the same contract as adjust_hours (0015) and adjust_points (0016).
//
// All of it degrades like the rest of this file: a database still on migration 0019 reports the
// tables as missing and these return { unsupported: true } after one warning, never throwing.

// Crockford base32: no I, L, O or U, so nothing is misread off a printed card or a phone screen.
const GIFT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GIFT_CODE_LEN = 16;                       // 16 × 5 bits = 80 bits of randomness

// A fresh code. 256 is an exact multiple of 32, so taking a random byte modulo 32 is uniform —
// no modulo bias, no rejection loop needed.
export function newGiftCode(len = GIFT_CODE_LEN) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += GIFT_ALPHABET[bytes[i] % 32];
  return out;
}

// How a code is shown to a human: INV5-9K3M-2XQ7-TB4W. Dashes are cosmetic — normalizeGiftCode
// strips them, so a customer may type the code with them, without them, or in lower case.
export function formatGiftCode(code) {
  return (String(code || '').match(/.{1,4}/g) || []).join('-');
}

// Forgive the ways a hand-copied code goes wrong: case, spaces, dashes, and the two substitutions
// people actually make when reading (1/I/L and 0/O). U is not in the alphabet and is left alone —
// it can only ever come from a typo, and mapping it would silently point at a different card.
export function normalizeGiftCode(input) {
  return String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1').replace(/O/g, '0');
}

// The lookup key. Namespaced so the digest can never be confused with a hash of something else.
export function giftCodeHash(code) {
  return createHash('sha256').update('invictus:giftcard:v1:' + normalizeGiftCode(code)).digest('hex');
}

// Shared "this database hasn't had 0020 applied yet" reply.
function giftUnsupported(where, error) {
  console.warn(`${where}: gift cards unavailable until migration 0020 is applied:`, error.message);
  return { unsupported: true };
}

// Issue a card. `ref` is the Stripe Checkout session id for an online purchase and is what makes
// this idempotent — a refreshed success page finds the card that already exists instead of minting
// a second one. Note that a repeat call CANNOT return the code again (rule 1 above); it returns
// { already: true } and the caller tells the buyer to check their email.
//
// The row is inserted with a zero balance and then credited through adjust_gift_card, so the
// opening balance and its ledger entry are written by the same atomic function as every later
// movement. If that credit fails the empty card row is removed rather than left behind as a
// worthless code somebody has already been emailed.
export async function createGiftCard({
  amountCents, purchaserName, purchaserEmail, purchaserPhone,
  recipientName, recipientEmail, recipientPhone, message,
  deliverAt = null, issuedBy = 'online', ref = null, paymentIntentId = null,
  note = null, expiresAt = null,
} = {}) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const cents = Math.round(Number(amountCents) || 0);
  if (!(cents > 0)) return { error: 'A gift card needs an amount greater than zero.' };

  if (ref) {
    const { data: seen, error } = await db.from('gift_cards').select('*').eq('stripe_session_id', ref).maybeSingle();
    if (error && missingSchema(error)) return giftUnsupported('createGiftCard', error);
    if (seen) return { card: seen, already: true };
  }

  // Link the buyer to a customer profile when we can — best-effort, never fatal: a gift card is
  // valid whether or not we managed to work out who bought it.
  let purchaserId = null;
  if (purchaserEmail || purchaserPhone) {
    const up = await upsertCustomer({ name: purchaserName, email: purchaserEmail, phone: purchaserPhone });
    purchaserId = up.id || null;
  }

  const code = newGiftCode();
  const row = {
    code_hash: giftCodeHash(code), code_hint: code.slice(-4),
    balance_cents: 0, initial_cents: cents, currency: 'cad', status: 'active',
    expires_at: expiresAt || null,
    purchaser_customer_id: purchaserId,
    purchaser_name: (purchaserName || '').trim() || null,
    purchaser_email: (purchaserEmail || '').trim().toLowerCase() || null,
    purchaser_phone: (purchaserPhone || '').trim() || null,
    recipient_name: (recipientName || '').trim() || null,
    recipient_email: (recipientEmail || '').trim().toLowerCase() || null,
    recipient_phone: (recipientPhone || '').trim() || null,
    message: (message || '').trim() || null,
    deliver_at: deliverAt || null,
    issued_by: issuedBy || 'online',
    stripe_session_id: ref || null,
    stripe_payment_intent: paymentIntentId || null,
    note: note || null,
  };
  const { data: card, error } = await db.from('gift_cards').insert(row).select('*').maybeSingle();
  if (error) {
    if (missingSchema(error)) return giftUnsupported('createGiftCard', error);
    // Two purchases racing on the same Checkout session: the loser reads the winner's card.
    if (isDuplicate(error) && ref) {
      const { data: seen } = await db.from('gift_cards').select('*').eq('stripe_session_id', ref).maybeSingle();
      if (seen) return { card: seen, already: true };
    }
    console.error('createGiftCard:', error.message);
    return { error: error.message };
  }

  const credit = await adjustGiftCard({
    cardId: card.id, delta: cents, kind: 'issue',
    note: note || (issuedBy === 'staff' ? 'Issued in shop' : 'Gift card purchase'), ref,
  });
  if (credit.error) {
    await db.from('gift_cards').delete().eq('id', card.id);
    return { error: credit.error };
  }
  return { card: { ...card, balance_cents: credit.balance }, code, formattedCode: formatGiftCode(code) };
}

// Atomic balance change + ledger entry (see adjust_gift_card in migration 0020).
export async function adjustGiftCard({ cardId, delta, kind, note, bookingId, ref } = {}) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const { data, error } = await db.rpc('adjust_gift_card', {
    p_card: cardId, p_delta: Math.round(Number(delta) || 0), p_kind: kind || 'adjust',
    p_note: note || null, p_booking: bookingId || null, p_ref: ref || null,
  });
  if (error) {
    if (missingSchema(error)) return giftUnsupported('adjustGiftCard', error);
    if (isDuplicate(error)) return { already: true };
    return { error: error.message };
  }
  return { balance: data };
}

// Find a card by the code the customer typed. Returns null for "no such card" and for a database
// that has not had 0020 applied — a caller cannot tell the difference and should not: both mean
// "there is nothing here to spend".
export async function giftCardByCode(code) {
  const db = admin();
  if (!db) return null;
  const normalized = normalizeGiftCode(code);
  if (normalized.length !== GIFT_CODE_LEN) return null;    // wrong shape — never touch the table
  const { data, error } = await db.from('gift_cards').select('*').eq('code_hash', giftCodeHash(normalized)).maybeSingle();
  if (error) {
    if (!missingSchema(error)) console.error('giftCardByCode:', error.message);
    return null;
  }
  return data || null;
}

export async function giftCardById(id) {
  const db = admin();
  if (!db || !id) return null;
  const { data, error } = await db.from('gift_cards').select('*').eq('id', id).maybeSingle();
  if (error) { if (!missingSchema(error)) console.error('giftCardById:', error.message); return null; }
  return data || null;
}

// Spendable right now — the balance less anything reserved against it by a checkout in progress.
export async function giftCardAvailable(cardId) {
  const db = admin();
  if (!db || !cardId) return 0;
  const { data, error } = await db.rpc('gift_card_available', { p_card: cardId });
  if (error) { if (!missingSchema(error)) console.error('giftCardAvailable:', error.message); return 0; }
  return Number(data) || 0;
}

// Claim value against one PaymentIntent for `ttlSeconds`, WITHOUT debiting. `expectedChargeCents`
// is what the customer is due to pay on their card alongside this claim; settlement refuses to
// redeem unless Stripe reports exactly that, which is what stops a reservation from being spent
// against a PaymentIntent that was never discounted. Re-reserving the same (card, payment)
// replaces the previous claim, so this is safe to call on every re-quote.
export async function reserveGiftCard({ cardId, amountCents, ref, expectedChargeCents = null, bookingId = null, ttlSeconds = 300 } = {}) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  if (!cardId || !ref) return { error: 'A card and a payment reference are required.' };
  const { data, error } = await db.rpc('reserve_gift_card', {
    p_card: cardId, p_amount: Math.round(Number(amountCents) || 0), p_ref: String(ref),
    p_charge: expectedChargeCents == null ? null : Math.round(Number(expectedChargeCents)),
    p_booking: bookingId || null, p_ttl_seconds: Math.round(Number(ttlSeconds) || 300),
  });
  if (error) {
    if (missingSchema(error)) return giftUnsupported('reserveGiftCard', error);
    console.error('reserveGiftCard:', error.message);
    return { error: error.message };
  }
  return data || {};
}

// Hand a claim back (checkout closed, card removed, slot changed). Best-effort: releasing
// something already gone is success, because the TTL would have released it anyway.
export async function releaseGiftCard({ cardId, ref } = {}) {
  const db = admin();
  if (!db || !cardId || !ref) return { released: 0 };
  const { data, error } = await db.rpc('release_gift_card', { p_card: cardId, p_ref: String(ref) });
  if (error) {
    if (!missingSchema(error)) console.error('releaseGiftCard:', error.message);
    return { released: 0 };
  }
  return { released: Number(data) || 0 };
}

// Settle a reservation into a real debit, once the payment beside it has succeeded.
// Idempotent through the ledger's (gift_card_id, ref) unique index, so the client-side confirm
// and the Stripe webhook — which this repo double-covers deliberately — cannot both spend it.
export async function redeemGiftCard({ cardId, ref, chargedCents = null, bookingId = null, note = null } = {}) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  if (!cardId || !ref) return { error: 'A card and a payment reference are required.' };
  const { data, error } = await db.rpc('redeem_gift_card', {
    p_card: cardId, p_ref: String(ref),
    p_charged: chargedCents == null ? null : Math.round(Number(chargedCents)),
    p_booking: bookingId || null, p_note: note || null,
  });
  if (error) {
    if (missingSchema(error)) return giftUnsupported('redeemGiftCard', error);
    console.error('redeemGiftCard:', error.message);
    return { error: error.message };
  }
  return data || {};
}

// Delete every lapsed reservation. reserve_gift_card already frees the card it is working on, so
// this is housekeeping rather than a correctness requirement — call it opportunistically, or from
// pg_cron once the scheduler the build plan calls for exists.
export async function sweepGiftCardReservations() {
  const db = admin();
  if (!db) return { swept: 0 };
  const { data, error } = await db.rpc('sweep_gift_card_reservations');
  if (error) {
    if (!missingSchema(error)) console.error('sweepGiftCardReservations:', error.message);
    return { swept: 0 };
  }
  return { swept: Number(data) || 0 };
}

// One card's history, newest first — for the manager portal.
export async function giftCardTransactions(cardId, { limit = 100 } = {}) {
  const db = admin();
  if (!db || !cardId) return [];
  const { data, error } = await db.from('gift_card_transactions').select('*')
    .eq('gift_card_id', cardId).order('created_at', { ascending: false }).limit(limit);
  if (error) { if (!missingSchema(error)) console.error('giftCardTransactions:', error.message); return []; }
  return data || [];
}

// Stamp a card as delivered once its message has been queued, so a re-run does not send again.
export async function markGiftCardDelivered(cardId) {
  const db = admin();
  if (!db || !cardId) return { unsupported: true };
  const { error } = await db.from('gift_cards').update({ delivered_at: new Date().toISOString() }).eq('id', cardId);
  if (error) {
    if (missingSchema(error)) return { unsupported: true };
    console.error('markGiftCardDelivered:', error.message);
    return { error: error.message };
  }
  return { ok: true };
}

// ----- Gift-card brute-force throttle -----
// 80 bits of entropy is not guessable, but logging attempts makes a scripted sweep visible and
// cheap to stop. Failures only are counted; somebody checking a card they hold is not an attacker.

const GIFT_ATTEMPT_WINDOW_MIN = 15;
const GIFT_ATTEMPT_MAX_MISSES = 10;

export async function recordGiftCardAttempt({ ip, codeHint, ok } = {}) {
  const db = admin();
  if (!db) return;
  const { error } = await db.from('gift_card_attempts')
    .insert({ ip: ip || null, code_hint: (codeHint || '').slice(-4) || null, ok: !!ok });
  if (error && !missingSchema(error)) console.error('recordGiftCardAttempt:', error.message);
}

// True when this IP has missed too often lately. Fails OPEN: a database that cannot answer must
// not lock a paying customer out of the card they are holding.
export async function giftCardAttemptsBlocked(ip) {
  const db = admin();
  if (!db || !ip) return false;
  const since = new Date(Date.now() - GIFT_ATTEMPT_WINDOW_MIN * 60000).toISOString();
  const { count, error } = await db.from('gift_card_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('ip', ip).eq('ok', false).gte('created_at', since);
  if (error) { if (!missingSchema(error)) console.error('giftCardAttemptsBlocked:', error.message); return false; }
  return (count || 0) >= GIFT_ATTEMPT_MAX_MISSES;
}

// Book a slot entirely covered by a gift card: debit first (atomic, rejects if short), then
// confirm the booking (flip the live cart hold, or insert); credit the card back if the slot
// turns out to be taken. Same shape as bookWithPoints/bookWithHours above.
//
// `ref` keys the ledger entry on the slot rather than on a payment, because there is no payment:
// the (gift_card_id, ref) unique index then makes a double-submitted booking form harmless.
export async function bookWithGiftCard({ dateISO, bayId, startMin, endMin, name, email, phone, cardId, amountCents, statusLabel } = {}) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const cents = Math.round(Number(amountCents) || 0);
  if (!cardId) return { error: 'no_card' };

  const ref = `book:${dateISO}:${bayId}:${startMin}-${endMin}`;
  const note = `Booking ${dateISO}`;
  let balance = null;
  if (cents > 0) {
    const d = await adjustGiftCard({ cardId, delta: -cents, kind: 'redeem', note, ref });
    if (d.already) return { error: 'duplicate' };
    if (d.unsupported) return { error: 'unsupported' };
    if (d.error) {
      if (/insufficient/i.test(d.error)) return { error: 'insufficient' };
      if (/expired/i.test(d.error)) return { error: 'expired' };
      if (/disabled|void/i.test(d.error)) return { error: 'inactive' };
      return { error: d.error };
    }
    balance = d.balance;
  }

  const patch = {
    status_label: statusLabel || 'Booked', customer_name: (name || '').trim() || null,
    customer_email: (email || '').trim() || null, customer_phone: (phone || '').trim() || null,
    amount_cents: 0, source: 'gift',
  };
  const flip = await confirmHold({ dateISO, bayId, startMin: Number(startMin), endMin: Number(endMin), patch });
  let bookingId = flip.id;
  if (!flip.updated) {
    const ins = await insertBooking({ bay_id: bayId, booking_date: dateISO, start_min: Number(startMin), end_min: Number(endMin), status: 'confirmed', ...patch });
    if (ins.error) {
      if (cents > 0) await adjustGiftCard({ cardId, delta: cents, kind: 'refund', note: 'Refund — slot unavailable' });
      return { error: 'taken' };
    }
    bookingId = ins.id;
  }
  return { ok: true, balance, bookingId };
}

// ----- Manager identity -----
// The only authenticated identity this app has is the Supabase session demo/admin.html signs in
// with. Endpoints that mint value (issuing a gift card from the shop counter) verify that session
// token here rather than trusting a request that says it came from the admin page.
// This is not the role system the build plan sequences last — it is the single check that says
// "a manager is logged in", and it should be replaced by that role system when it arrives.
export async function verifyManager(accessToken) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const token = String(accessToken || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: 'unauthorized' };
  try {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data || !data.user) return { error: 'unauthorized' };
    return { user: data.user };
  } catch (_) {
    return { error: 'unauthorized' };
  }
}
