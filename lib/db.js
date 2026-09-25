// Supabase access for the server (API routes / webhook).
// Uses the SERVICE-ROLE key, which bypasses Row Level Security — server-only, never shipped to the browser.
import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DEMO_HOUR_CARDS, hoursUntilBooking, winnipegTodayISO } from './booking.js';
// Side effect: defines globalThis.InvictusLeagues, the schedule/standings maths the portal also uses.
import '../demo/assets/leagues.js';

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
export function normPhone(p) {
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
    // select('*') so optional columns (hours_balance_min) ride along when present.
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

// ----- Loyalty points: RETIRED -----
// adjustPoints(), awardBookingPoints() and bookWithPoints() lived here. The venue does not run a
// points programme, so nothing earns, redeems or adjusts a balance any more and those three are
// gone. The database side is untouched on purpose (same treatment memberships got in migration
// 0028): customers.points_balance, point_transactions and the adjust_points() RPC all still
// exist, holding their history, with no caller in this codebase.

// Book a slot by paying with prepaid hours: deduct first (atomic, rejects if short), then confirm the
// booking (flip the live hold or insert); refund the hours if the slot turns out to be taken.
export async function bookWithHours({ dateISO, bayId, startMin, endMin, name, email, phone, statusLabel, customerNote }) {
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
  await setCustomerNote({ bookingId, note: customerNote });
  return { ok: true, balanceMin: bal, bookingId, customerId: cust.id };
}

// Is there already a (non-cancelled) booking for this PaymentIntent? Keeps confirmation idempotent
// so the client-side confirm and the webhook can't create the booking twice.
// ----- The customer's note on a booking (migration 0027) -----
// Written AFTER the booking is saved, never as part of it: a note is worth keeping, not worth
// failing a paid booking over — e.g. on a database where 0027 has not been applied yet.
export function cleanCustomerNote(v) {
  return String(v || '').replace(/\r\n?/g, '\n').trim().slice(0, 500) || null;
}
export async function setCustomerNote({ bookingId, paymentIntentId, note, onlyIfEmpty = false } = {}) {
  const db = admin();
  const text = cleanCustomerNote(note);
  if (!db || !text || (!bookingId && !paymentIntentId)) return;
  let q = db.from('bookings').update({ customer_note: text });
  q = bookingId ? q.eq('id', bookingId) : q.eq('stripe_payment_intent', paymentIntentId);
  if (onlyIfEmpty) q = q.is('customer_note', null);
  const { error } = await q;
  if (error) console.warn('setCustomerNote: note not saved —', error.message);
}

// ----- Feedback after a session (migration 0027) -----
// Is this booking one this contact made? The same rule as bookings_self_read (0025): the email,
// or the phone number compared by digits.
function bookingBelongsTo(b, { email, phone } = {}) {
  const e = String(email || '').trim().toLowerCase();
  if (e && String(b.customer_email || '').trim().toLowerCase() === e) return true;
  const n = normPhone(phone);
  return !!(n && normPhone(b.customer_phone) === n);
}

// Save a rating (1–5, optional comment) or "skip" for one finished booking. Both the signed-in
// account route and the local no-login route call this, so the checks live in one place: the
// booking must belong to the contact, must have gone ahead, and must be over. A party across
// several bays is asked once — any answer on the group counts for all of it.
export async function saveBookingFeedback({ contact, customerId = null, bookingId, rating, comment, skipped } = {}) {
  const db = admin();
  if (!db) return { error: 'The database is not configured.', code: 503 };
  const skip = !!skipped;
  const stars = skip ? null : Number(rating);
  if (!skip && !(Number.isInteger(stars) && stars >= 1 && stars <= 5)) return { error: 'Choose a rating from 1 to 5 stars.', code: 400 };
  const text = skip ? null : (String(comment || '').trim().slice(0, 1000) || null);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(bookingId || ''))) return { error: 'That booking is not on your account.', code: 404 };
  const { data: b, error } = await db.from('bookings')
    .select('id,booking_date,end_min,status,customer_email,customer_phone,group_id').eq('id', String(bookingId)).maybeSingle();
  if (error) return { error: `Could not read that booking: ${error.message}`, code: 500 };
  if (!b || !bookingBelongsTo(b, contact)) return { error: 'That booking is not on your account.', code: 404 };
  if (['cancelled', 'held', 'blocked'].includes(b.status)) return { error: 'That booking did not go ahead, so there is nothing to rate.', code: 400 };
  if (hoursUntilBooking(b.booking_date, b.end_min) > 0) return { error: 'You can leave feedback once the session has finished.', code: 400 };

  let ids = [b.id];
  if (b.group_id) {
    const { data: g } = await db.from('bookings').select('id').eq('group_id', b.group_id);
    ids = (g || []).map((x) => x.id);
  }
  const { data: had, error: hadErr } = await db.from('booking_feedback').select('id').in('booking_id', ids).limit(1);
  if (hadErr) {
    return missingSchema(hadErr)
      ? { error: 'Feedback is not set up in this database yet. Run supabase/setup.sql.', code: 503 }
      : { error: `Could not check for earlier feedback: ${hadErr.message}`, code: 500 };
  }
  if (had && had.length) return { ok: true, already: true };

  const ins = await db.from('booking_feedback').insert({ booking_id: b.id, customer_id: customerId, rating: stars, comment: text, skipped: skip });
  if (ins.error) {
    if (/duplicate|unique/i.test(ins.error.message || '')) return { ok: true, already: true };
    return { error: `Could not save your feedback: ${ins.error.message}`, code: 500 };
  }
  return { ok: true };
}

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

// ----- Saved cards through Stripe (migration 0029) -----
// Card details live on a Stripe Customer, never here; customers.stripe_customer_id is the link.
// Saved cards are only ever shown to the account that owns them, so everything below starts from
// a PROVEN customer: a My Account session token — or, only on the local dev server, which sets
// req.devAccountPhone itself (server.js), the no-login dev account. A phone number typed at
// checkout is never enough.
export async function accountCustomerForRequest(req) {
  const db = admin();
  if (!db || !req) return null;
  if (req.devAccountPhone) return await customerHoursByContact({ phone: req.devAccountPhone });
  const token = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const who = await db.auth.getUser(token).catch(() => null);
  const user = who && !who.error && who.data && who.data.user;
  if (!user) return null;
  const { data } = await db.from('customers').select('*').eq('user_id', user.id).maybeSingle();
  return data || null;
}

// The customer's Stripe Customer id, created the first time it is needed and remembered. Two
// checkouts racing for the same customer both create one; the first write wins and the loser's
// Stripe Customer is deleted, so a customer never ends up with their cards split across two.
// Null when the database cannot store the link (0029 not applied): checkout carries on without.
export async function stripeCustomerIdFor(stripe, customer) {
  if (!customer || !customer.id) return null;
  if (customer.stripe_customer_id) return customer.stripe_customer_id;
  const db = admin();
  if (!db) return null;
  const made = await stripe.customers.create({
    name: customer.name || undefined, email: customer.email || undefined, phone: customer.phone || undefined,
    metadata: { invictus_customer_id: String(customer.id) },
  });
  const upd = await db.from('customers').update({ stripe_customer_id: made.id }).eq('id', customer.id).is('stripe_customer_id', null);
  const { data } = upd.error ? { data: null } : await db.from('customers').select('stripe_customer_id').eq('id', customer.id).maybeSingle();
  const saved = data && data.stripe_customer_id;
  if (saved !== made.id) {
    await stripe.customers.del(made.id).catch(() => {});
    if (upd.error) console.warn('stripeCustomerIdFor: link not saved —', upd.error.message);
  }
  return saved || null;
}

// Checkout: the proven customer's Stripe Customer id, or nothing. Never throws — a problem here
// means paying without saved cards, not failing to book.
export async function checkoutStripeCustomer(stripe, req) {
  try {
    return await stripeCustomerIdFor(stripe, await accountCustomerForRequest(req));
  } catch (err) {
    console.warn('checkoutStripeCustomer:', err.message);
    return null;
  }
}

// A Customer Session for the Payment Element: lists the customer's saved cards and wallets, offers a
// "save for next time" box, and lets them remove one. Cards added from My Account are saved without
// a checkout, so their redisplay setting is 'unspecified' — included, since they were added on purpose.
export async function paymentElementSession(stripe, stripeCustomerId) {
  const cs = await stripe.customerSessions.create({
    customer: stripeCustomerId,
    components: { payment_element: { enabled: true, features: {
      payment_method_redisplay: 'enabled',
      payment_method_allow_redisplay_filters: ['always', 'limited', 'unspecified'],
      payment_method_save: 'enabled',
      payment_method_save_usage: 'off_session',
      payment_method_remove: 'enabled',
    } } },
  });
  return cs.client_secret;
}

export async function listSavedCards(stripe, stripeCustomerId) {
  if (!stripeCustomerId) return [];
  const r = await stripe.customers.listPaymentMethods(stripeCustomerId, { limit: 20 });
  return (r.data || []).filter((pm) => pm.type === 'card' && pm.card).map((pm) => ({
    id: pm.id, brand: pm.card.brand, last4: pm.card.last4, expMonth: pm.card.exp_month, expYear: pm.card.exp_year,
    wallet: pm.card.wallet ? pm.card.wallet.type : null,
  }));
}

// Remove a saved card — only one that belongs to this Stripe Customer.
export async function removeSavedCard(stripe, stripeCustomerId, paymentMethodId) {
  const pm = await stripe.paymentMethods.retrieve(String(paymentMethodId || '')).catch(() => null);
  if (!stripeCustomerId || !pm || pm.customer !== stripeCustomerId) return { error: 'That card isn’t on your account.', code: 404 };
  await stripe.paymentMethods.detach(pm.id);
  return { ok: true };
}

// Save a card without paying (My Account → Add a card). Dynamic payment methods: no
// payment_method_types, so what is offered is managed in the Stripe Dashboard.
export async function cardSetupIntent(stripe, stripeCustomerId) {
  const si = await stripe.setupIntents.create({ customer: stripeCustomerId, usage: 'off_session' });
  return si.client_secret;
}

// ----- Leagues (migration 0028) -----
// What a league looks like to the public and to its players. Never phone numbers or emails.
const LEAGUE_PUBLIC = 'id,name,description,day_of_week,start_min,end_min,season_start,season_end,bay_ids,fee_cents,capacity,team_mode,scoring,join_online,is_active,color,sort';
const leagues = () => globalThis.InvictusLeagues;

// Active league ids this customer is currently playing in (season not over).
async function currentLeagueIds(db, customerId) {
  if (!customerId) return [];
  const { data, error } = await db.from('league_members')
    .select('league_id, leagues(is_active,season_end)').eq('customer_id', customerId).eq('status', 'active');
  if (error) { if (!missingSchema(error)) console.error('currentLeagueIds:', error.message); return []; }
  const today = winnipegTodayISO();
  return (data || []).filter((m) => leagues().isCurrent(m.leagues, today)).map((m) => m.league_id);
}

// Is this contact on a current league roster? Decides the longer advance-booking window.
export async function isLeaguePlayer({ email, phone } = {}) {
  const db = admin();
  if (!db) return false;
  const cust = await customerHoursByContact({ email, phone });
  return !!(cust && (await currentLeagueIds(db, cust.id)).length);
}

// League status for a customer booking request, from the My Account session the booking page
// sends along (or the localhost dev account). Decides the booking window.
export async function leaguePlayerForRequest(req) {
  // Only a proven identity counts. A phone number typed into the booking form proves nothing —
  // anyone could type a league player's number to unlock their longer window.
  if (req && req.devAccountPhone) return await isLeaguePlayer({ phone: req.devAccountPhone });
  const token = String((req && req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim();
  const db = admin();
  if (!token || !db) return false;
  const who = await db.auth.getUser(token).catch(() => null);
  const user = who && !who.error && who.data && who.data.user;
  if (!user) return false;
  const { data: c } = await db.from('customers').select('id').eq('user_id', user.id).maybeSingle();
  return !!(c && (await currentLeagueIds(db, c.id)).length);
}

// The /leagues page: current leagues open to online sign-up, with how many spots are left.
export async function listPublicLeagues() {
  const db = admin();
  if (!db) return { leagues: [] };
  const { data, error } = await db.from('leagues').select(LEAGUE_PUBLIC)
    .eq('is_active', true).eq('join_online', true).order('sort').order('season_start');
  if (error) {
    if (missingSchema(error)) return { leagues: [], unsupported: true };
    console.error('listPublicLeagues:', error.message);
    return { leagues: [] };
  }
  const today = winnipegTodayISO();
  const list = (data || []).filter((l) => leagues().isCurrent(l, today));
  const counts = {};
  if (list.length) {
    const { data: ms } = await db.from('league_members').select('league_id').eq('status', 'active').in('league_id', list.map((l) => l.id));
    (ms || []).forEach((m) => { counts[m.league_id] = (counts[m.league_id] || 0) + 1; });
  }
  return { leagues: list.map((l) => ({ ...l, players: counts[l.id] || 0,
    spotsLeft: l.capacity ? Math.max(0, l.capacity - (counts[l.id] || 0)) : null })) };
}

export async function leagueById(id) {
  const db = admin();
  if (!db || !id) return null;
  const { data } = await db.from('leagues').select(LEAGUE_PUBLIC).eq('id', id).maybeSingle();
  return data || null;
}

// Put a player on a league. Used by the online join (free or paid) and safe to call twice:
// the same Stripe session, or the same player joining again, returns the existing place.
export async function joinLeague({ leagueId, name, email, phone, teamName, source = 'online', paidCents = 0, stripeSessionId = null } = {}) {
  const db = admin();
  if (!db) return { error: 'The database is not configured.' };
  const league = await leagueById(leagueId);
  if (!league || !league.is_active) return { error: 'That league is not taking players right now.', code: 404 };
  if (!leagues().isCurrent(league, winnipegTodayISO())) return { error: 'That league’s season is over.', code: 400 };

  if (stripeSessionId) {
    const { data: paid } = await db.from('league_members').select('id').eq('stripe_session_id', stripeSessionId).maybeSingle();
    if (paid) return { ok: true, already: true, league };
  }
  const up = await upsertCustomer({ name, email, phone });
  if (!up.id) return { error: up.error || 'We need your phone number or email to add you to the league.', code: 400 };

  const { data: existing } = await db.from('league_members').select('id,status').eq('league_id', league.id).eq('customer_id', up.id).maybeSingle();
  if (existing && existing.status === 'active') return { ok: true, already: true, league, customerId: up.id };

  if (league.capacity) {
    const { data: ms } = await db.from('league_members').select('id').eq('league_id', league.id).eq('status', 'active');
    // A paid session is honoured even if the league filled up while they were paying.
    if ((ms || []).length >= league.capacity && !stripeSessionId) return { error: 'That league is full.', code: 409 };
  }

  let teamId = null;
  const team = String(teamName || '').trim().slice(0, 60);
  if (league.team_mode && team) {
    const { data: teams } = await db.from('league_teams').select('id,name').eq('league_id', league.id);
    const found = (teams || []).find((t) => t.name.trim().toLowerCase() === team.toLowerCase());
    if (found) teamId = found.id;
    else {
      const made = await db.from('league_teams').insert({ league_id: league.id, name: team }).select('id').single();
      if (made.error) return { error: `Could not create the team: ${made.error.message}`, code: 500 };
      teamId = made.data.id;
    }
  }

  const row = { league_id: league.id, customer_id: up.id, team_id: teamId, status: 'active', source,
    paid_cents: paidCents || 0, stripe_session_id: stripeSessionId, joined_at: new Date().toISOString(),
    ...(paidCents > 0 ? { paid_at: new Date().toISOString() } : {}) };
  const write = (r) => (existing
    ? db.from('league_members').update(r).eq('id', existing.id)   // rejoining after leaving
    : db.from('league_members').insert(r));
  let w = await write(row);
  // Before migration 0030 there is no paid_at: still add the player, just without the date.
  if (w.error && /paid_at/.test(w.error.message || '') && row.paid_at) { const { paid_at, ...rest } = row; w = await write(rest); }
  if (w.error) {
    if (/duplicate|unique/i.test(w.error.message || '')) return { ok: true, already: true, league, customerId: up.id };
    return { error: `Could not add you to the league: ${w.error.message}`, code: 500 };
  }
  return { ok: true, league, customerId: up.id };
}

// A paid league checkout → a place on the roster. The success page and the Stripe webhook both
// call this; it re-reads the session from Stripe instead of trusting whoever sent the id, and the
// session id makes it idempotent, so whichever arrives second changes nothing.
export async function confirmLeagueCheckout(stripe, sessionId) {
  if (!sessionId) return { error: 'Missing checkout session.', code: 400 };
  let session;
  try { session = await stripe.checkout.sessions.retrieve(String(sessionId)); }
  catch (_) { return { error: 'Checkout session not found.', code: 400 }; }
  const md = session.metadata || {};
  if (md.kind !== 'league' || !md.leagueId) return { error: 'This payment is not a league sign-up.', code: 400 };
  if (session.payment_status !== 'paid') return { error: 'Payment is not complete.', code: 400 };
  const email = md.email || (session.customer_details && session.customer_details.email) || '';
  const r = await joinLeague({ leagueId: md.leagueId, name: md.name, email, phone: md.phone, teamName: md.teamName,
    source: 'online', paidCents: session.amount_total || 0, stripeSessionId: session.id });
  return r.error ? { ...r, retry: (r.code || 500) >= 500 } : { ...r, email: email || null };
}

// Everything My Account shows about a player's leagues. Other players appear by first name and last
// initial only — never a phone number or an email.
//   standing   { rank, of, played, total, average, best }   this player (or their team)
//   progress   { played, total, left }                       weeks of the season
//   weeks      [{ start, end, number, current, past, round, missed, score }]
//   teams      [{ name, you, players:[{ name, you }] }]        team leagues; `roster` for individual
export async function leaguesForCustomer(customerId) {
  const db = admin();
  if (!db || !customerId) return [];
  const mineQ = (cols) => db.from('league_members').select(cols).eq('customer_id', customerId).eq('status', 'active');
  let { data: mine, error } = await mineQ('league_id,team_id,status,joined_at,paid_cents,paid_at');
  // Before migration 0030 there is no paid_at — still show the league, just without the payment date.
  if (error && /paid_at/.test(error.message || '')) ({ data: mine, error } = await mineQ('league_id,team_id,status,joined_at,paid_cents'));
  if (error) { if (!missingSchema(error)) console.error('leaguesForCustomer:', error.message); return []; }
  const today = winnipegTodayISO();
  const L = leagues();
  const bayNames = await (async () => {
    const row = await getSettings();
    return Object.fromEntries(((row && row.bays) || []).map((b) => [b.id, b.name]));
  })();
  const out = [];
  for (const m of mine || []) {
    const league = await leagueById(m.league_id);
    if (!league || !L.isCurrent(league, today)) continue;
    const [teamsQ, membersQ, resultsQ, offQ] = await Promise.all([
      db.from('league_teams').select('id,name').eq('league_id', league.id),
      db.from('league_members').select('customer_id,team_id,status,customers(name)').eq('league_id', league.id),
      db.from('league_results').select('team_id,customer_id,score,played_on').eq('league_id', league.id).order('played_on', { ascending: false }),
      db.from('league_cancelled_nights').select('night,reason').eq('league_id', league.id),   // 0030; empty before it
    ]);
    const teams = teamsQ.data || [];
    const members = (membersQ.data || []).map((x) => ({ customer_id: x.customer_id, team_id: x.team_id, status: x.status,
      name: L.publicName(x.customers && x.customers.name) }));
    const results = resultsQ.data || [];
    const cancelled = offQ.error ? [] : (offQ.data || []);
    const myKey = league.team_mode ? m.team_id : customerId;
    const mineOnly = (r) => (league.team_mode ? r.team_id === m.team_id : r.customer_id === customerId);

    const rows = L.standings({ league, teams, members, results });
    const me = rows.find((r) => r.key === myKey);
    const active = members.filter((x) => x.status === 'active');
    // A score belongs to the WEEK it was played in. Since 0031 there are no league nights, so a
    // result entered on "a date that isn't a league night" is no longer a special case: every date
    // falls in exactly one week, and that is the week it shows against.
    const scoreOn = new Map();
    results.filter(mineOnly).forEach((r) => { const w = L.weekOf(r.played_on); if (w && !scoreOn.has(w)) scoreOn.set(w, Number(r.score)); });
    const team = teams.find((t) => t.id === m.team_id) || null;
    const rounds = await teamRounds(db, m.team_id);
    void cancelled;   // 0030's cancelled nights: a league with no fixed night has no night to cancel

    out.push({
      league: { ...league, bays: (league.bay_ids || []).map((id) => bayNames[id] || id) },
      team: team ? team.name : null,
      joinedAt: m.joined_at, paidCents: m.paid_cents || 0, paidAt: m.paid_at || null,
      progress: L.progress(league, today),
      currentWeek: L.currentWeek(league, today),
      missedWeeks: L.missedWeeks({ league, todayISO: today, rounds }),
      standing: me ? { rank: me.played ? me.rank : null, of: rows.filter((r) => r.played).length || rows.length,
        played: me.played, total: me.total, average: me.average, best: me.best } : null,
      weeks: L.teamWeeks({ league, todayISO: today, rounds })
        .map((w) => ({ ...w, score: scoreOn.has(w.start) ? scoreOn.get(w.start) : null })),
      roster: active.map((x) => ({ name: x.name, team: (teams.find((t) => t.id === x.team_id) || {}).name || null, you: x.customer_id === customerId })),
      teams: league.team_mode
        ? teams.map((t) => ({ name: t.name, you: t.id === m.team_id,
            players: active.filter((x) => x.team_id === t.id).map((x) => ({ name: x.name, you: x.customer_id === customerId })) }))
            .sort((a, b) => (b.you - a.you) || a.name.localeCompare(b.name))
        : [],
      standings: rows.map((r) => ({ rank: r.rank, name: r.name, played: r.played, total: r.total, average: r.average, best: r.best, you: r.key === myKey })),
      myScores: results.filter(mineOnly).slice(0, 8).map((r) => ({ played_on: r.played_on, score: Number(r.score) })),
    });
  }
  return out;
}

// ----- Leagues sold by the team (migration 0031) -----
//
// One captain pays one price for the whole team, invites friends by phone number, and the team
// plays once a week whenever it likes — a free booking, in any bay, flagged as that team's round.
// Everything below therefore starts from a TEAM, not a player.
//
// 0031 is not applied on every database yet, so every query here has a second answer ready: a
// missing table or column comes back as a sentence telling the operator to run the migration,
// never as a stack trace and never as a silent empty page.
export const MIGRATION_0031 = 'Team leagues need one more database update — run supabase/migrations/0031_league_teams.sql in the Supabase SQL editor, then try again.';

// Postgres/PostgREST saying "no such table or column". 42703 = undefined_column, the rest is
// missingSchema()'s list, shared with every other migration in this file.
function needs0031(error) {
  return !!error && (error.code === '42703' || missingSchema(error));
}
const team0031 = (where, error) => {
  console.warn(`${where}: team leagues unavailable until migration 0031 is applied:`, error.message);
  return { unsupported: true, error: MIGRATION_0031, code: 503 };
};

// What a team league looks like. team_size and weekly_min_mins arrive with 0031; before it, the
// closest honest reading is the one the migration itself writes — capacity was the team size, and
// three hours is the recommended round — so the page still works while the update is pending.
const LEAGUE_TEAM_COLS = 'id,name,description,fee_cents,team_size,weekly_min_mins,season_start,season_end,is_active,join_online,team_mode,scoring,capacity,bay_ids,color,sort';
const LEAGUE_TEAM_COLS_PRE31 = 'id,name,description,fee_cents,season_start,season_end,is_active,join_online,team_mode,scoring,capacity,bay_ids,color,sort';

async function teamLeagueRows(db, { id = null } = {}) {
  const build = (cols) => { const q = db.from('leagues').select(cols); return id ? q.eq('id', id) : q; };
  let { data, error } = await build(LEAGUE_TEAM_COLS);
  let pre31 = false;
  if (error && needs0031(error)) { pre31 = true; ({ data, error } = await build(LEAGUE_TEAM_COLS_PRE31)); }
  if (error) return { rows: [], error, pre31 };
  const rows = (data || []).map((l) => (l.team_size === undefined
    ? { ...l, team_size: l.capacity ?? null, weekly_min_mins: 180 }
    : { ...l, weekly_min_mins: l.weekly_min_mins || 180 }));
  return { rows, pre31 };
}

export async function teamLeagueById(id) {
  const db = admin();
  if (!db || !id) return null;
  const { rows } = await teamLeagueRows(db, { id });
  return rows[0] || null;
}

// One team, with the 0031 columns when they exist and sensible blanks when they do not.
const TEAM_COLS = 'id,league_id,name,captain_customer_id,paid_cents,paid_at,stripe_session_id';
export async function leagueTeamById(teamId) {
  const db = admin();
  if (!db || !teamId) return null;
  let { data, error } = await db.from('league_teams').select(TEAM_COLS).eq('id', teamId).maybeSingle();
  if (error && needs0031(error)) ({ data, error } = await db.from('league_teams').select('id,league_id,name').eq('id', teamId).maybeSingle());
  if (error) { console.error('leagueTeamById:', error.message); return null; }
  if (!data) return null;
  return { captain_customer_id: null, paid_cents: 0, paid_at: null, stripe_session_id: null, ...data };
}

// Every live league round a team has booked. Empty — not an error — before 0031 adds the column.
async function teamRounds(db, teamId) {
  if (!db || !teamId) return [];
  const { data, error } = await db.from('bookings')
    .select('id,booking_date,start_min,end_min,bay_id,status,league_week,league_team_id')
    .eq('league_team_id', teamId);
  if (error) {
    if (!needs0031(error)) console.error('teamRounds:', error.message);
    return [];
  }
  // league_week is generated by the database; work it out here too so a round booked before the
  // column existed still files under the right week.
  return (data || []).map((r) => ({ ...r, league_week: r.league_week || leagues().weekOf(r.booking_date) }));
}

// The teams in a league, and how many players are on each.
async function teamsOfLeague(db, leagueId) {
  let { data, error } = await db.from('league_teams').select(TEAM_COLS).eq('league_id', leagueId);
  if (error && needs0031(error)) ({ data, error } = await db.from('league_teams').select('id,league_id,name').eq('league_id', leagueId));
  if (error) { console.error('teamsOfLeague:', error.message); return { teams: [], error }; }
  return { teams: (data || []).map((t) => ({ captain_customer_id: null, paid_cents: 0, paid_at: null, ...t })) };
}

// Active roster rows for a league, with each player's real name attached (never their contact
// details — callers pass them through publicName before anything leaves the server).
async function rosterOfLeague(db, leagueId) {
  const { data, error } = await db.from('league_members').select('id,customer_id,team_id,status').eq('league_id', leagueId);
  if (error) { if (!missingSchema(error)) console.error('rosterOfLeague:', error.message); return []; }
  const rows = data || [];
  const ids = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))];
  const names = {};
  if (ids.length) {
    const { data: cs } = await db.from('customers').select('id,name').in('id', ids);
    (cs || []).forEach((c) => { names[c.id] = c.name; });
  }
  return rows.map((r) => ({ ...r, name: names[r.customer_id] || null }));
}

// The /leagues page: leagues you can buy a team in, how many teams are already in, and — only
// when the caller proved who they are — which team is theirs.
export async function listTeamLeagues({ customerId = null } = {}) {
  const db = admin();
  if (!db) return { leagues: [] };
  const { rows, error } = await teamLeagueRows(db);
  if (error) {
    if (needs0031(error)) return { leagues: [], ...team0031('listTeamLeagues', error) };
    console.error('listTeamLeagues:', error.message);
    return { leagues: [], error: 'Leagues are unavailable right now — please call the shop.', code: 503 };
  }
  const L = leagues(), today = winnipegTodayISO();
  const open = rows
    .filter((l) => l.is_active !== false && l.join_online !== false && L.isCurrent(l, today))
    .sort((a, b) => (a.sort || 0) - (b.sort || 0) || String(a.season_start || '').localeCompare(String(b.season_start || '')));

  const counts = {};
  if (open.length) {
    const { data } = await db.from('league_teams').select('id,league_id').in('league_id', open.map((l) => l.id));
    (data || []).forEach((t) => { counts[t.league_id] = (counts[t.league_id] || 0) + 1; });
  }
  let myTeams = {};
  if (customerId) {
    const { data } = await db.from('league_members').select('league_id,team_id,status').eq('customer_id', customerId).eq('status', 'active');
    (data || []).forEach((m) => { if (m.team_id) myTeams[m.league_id] = m.team_id; });
  }
  return { leagues: open.map((l) => ({
    id: l.id, name: l.name, description: l.description || null,
    fee_cents: l.fee_cents || 0, team_size: l.team_size ?? null, weekly_min_mins: l.weekly_min_mins || 180,
    season_start: l.season_start, season_end: l.season_end,
    teamCount: counts[l.id] || 0, myTeamId: myTeams[l.id] || null,
  })) };
}

// Put a customer on a team's roster. Safe to call twice: the second call updates the row that is
// already there rather than adding a second one.
async function putOnTeam(db, { leagueId, teamId, customerId, paidCents = 0, stripeSessionId = null, source = 'online' } = {}) {
  const { data: existing } = await db.from('league_members').select('id,status,team_id')
    .eq('league_id', leagueId).eq('customer_id', customerId).maybeSingle();
  if (existing && existing.status === 'active' && existing.team_id === teamId) return { ok: true, already: true };
  const row = {
    league_id: leagueId, customer_id: customerId, team_id: teamId, status: 'active', source,
    paid_cents: paidCents || 0, stripe_session_id: stripeSessionId, joined_at: new Date().toISOString(),
    ...(paidCents > 0 ? { paid_at: new Date().toISOString() } : {}),
  };
  const write = (r) => (existing ? db.from('league_members').update(r).eq('id', existing.id) : db.from('league_members').insert(r));
  let w = await write(row);
  // Before migration 0030 there is no paid_at: still add the player, just without the date.
  if (w.error && /paid_at/.test(w.error.message || '') && row.paid_at) { const { paid_at, ...rest } = row; w = await write(rest); }
  if (w.error && isDuplicate(w.error)) return { ok: true, already: true };
  if (w.error) return { error: `Could not add you to the team: ${w.error.message}`, code: 500 };
  return { ok: true };
}

const teamName = (v) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 60);

// Buy a team: the row the captain paid for, plus the captain's own place on it. The Stripe session
// id makes this idempotent — the success page and the webhook both call it and only one team is
// ever created, because the database has a unique index on that column.
export async function createLeagueTeam({ leagueId, name, captainCustomerId = null, paidCents = 0, stripeSessionId = null } = {}) {
  const db = admin();
  if (!db) return { error: 'The database is not configured.', code: 503 };
  const nm = teamName(name);
  if (!nm) return { error: 'Give your team a name.', code: 400 };

  const league = await teamLeagueById(leagueId);
  if (!league || league.is_active === false) return { error: 'That league is not taking teams right now.', code: 404 };
  if (!leagues().isCurrent(league, winnipegTodayISO())) return { error: 'That league’s season is over.', code: 400 };

  // Already settled? (the webhook and the success page race each other by design)
  if (stripeSessionId) {
    const { data, error } = await db.from('league_teams').select(TEAM_COLS).eq('stripe_session_id', stripeSessionId).maybeSingle();
    if (error && needs0031(error)) return team0031('createLeagueTeam', error);
    if (data) return { ok: true, already: true, teamId: data.id, team: data, league };
  }

  const { teams, error: teamsErr } = await teamsOfLeague(db, league.id);
  if (teamsErr) return needs0031(teamsErr) ? team0031('createLeagueTeam', teamsErr) : { error: 'Could not read the teams in that league.', code: 500 };
  const taken = (n) => teams.some((t) => teamName(t.name).toLowerCase() === n.toLowerCase());

  // Two teams called "Birdies" would make the standings a guessing game, and the database has a
  // unique index saying so. Unpaid: say no clearly. Paid: the money is already taken, so never
  // throw the payment away over a name — number it and tell the log.
  let finalName = nm;
  if (taken(nm)) {
    if (!stripeSessionId) return { error: `There’s already a team called “${nm}” in ${league.name}. Pick another name.`, code: 409 };
    for (let i = 2; i <= 9 && taken(finalName); i++) finalName = `${nm} (${i})`;
    console.warn(`createLeagueTeam: “${nm}” was taken in ${league.name} by the time ${stripeSessionId} settled — saved as “${finalName}”.`);
  }

  const row = { league_id: league.id, name: finalName, captain_customer_id: captainCustomerId || null,
    paid_cents: paidCents || 0, stripe_session_id: stripeSessionId || null,
    ...(paidCents > 0 ? { paid_at: new Date().toISOString() } : {}) };
  const { data: made, error } = await db.from('league_teams').insert(row).select(TEAM_COLS).maybeSingle();
  if (error) {
    if (needs0031(error)) return team0031('createLeagueTeam', error);
    if (isDuplicate(error) && stripeSessionId) {
      const { data } = await db.from('league_teams').select(TEAM_COLS).eq('stripe_session_id', stripeSessionId).maybeSingle();
      if (data) return { ok: true, already: true, teamId: data.id, team: data, league };
    }
    if (isDuplicate(error)) return { error: `There’s already a team called “${finalName}” in ${league.name}. Pick another name.`, code: 409 };
    console.error('createLeagueTeam:', error.message);
    return { error: 'Could not create the team. Please try again, or call the shop.', code: 500 };
  }

  if (captainCustomerId) {
    const put = await putOnTeam(db, { leagueId: league.id, teamId: made.id, customerId: captainCustomerId, paidCents, stripeSessionId });
    if (put.error) return { ...put, teamId: made.id };
  }
  return { ok: true, teamId: made.id, team: made, league };
}

// A paid team checkout → the team on the board. Re-reads the session from Stripe rather than
// trusting whoever sent the id, exactly like confirmLeagueCheckout above.
export async function confirmLeagueTeamCheckout(stripe, sessionId) {
  if (!sessionId) return { error: 'Missing checkout session.', code: 400 };
  let session;
  try { session = await stripe.checkout.sessions.retrieve(String(sessionId)); }
  catch (_) { return { error: 'Checkout session not found.', code: 400 }; }
  const md = session.metadata || {};
  if (md.kind !== 'league-team') return { error: 'This payment is not a league team.', code: 400 };
  if (session.payment_status !== 'paid') return { error: 'Payment is not complete.', code: 400 };
  const r = await createLeagueTeam({
    leagueId: md.leagueId, name: md.teamName, captainCustomerId: md.captainCustomerId || null,
    paidCents: session.amount_total || 0, stripeSessionId: session.id,
  });
  return r.error ? { ...r, retry: (r.code || 500) >= 500 } : r;
}

// ----- Invites: "here's the link, you're on my team" -----
// The token is the only thing protecting a team, so it is treated like a waiting-list claim token:
// single use, revocable, never listed to anyone but the team, and never guessable.

// How many players are on a team right now, and whether that is all it will hold.
async function teamFullness(db, team, league) {
  const roster = await rosterOfLeague(db, team.league_id);
  const players = roster.filter((r) => r.team_id === team.id && r.status === 'active');
  const size = league && league.team_size ? Number(league.team_size) : null;
  return { players, count: players.length, size, full: !!(size && players.length >= size) };
}

export async function createTeamInvite({ teamId, phone, name = null, invitedBy = null } = {}) {
  const db = admin();
  if (!db) return { error: 'The database is not configured.', code: 503 };
  const p = normPhone(phone);
  if (!p) return { error: 'Enter your friend’s mobile number, including area code.', code: 400 };

  const team = await leagueTeamById(teamId);
  if (!team) return { error: 'That team no longer exists.', code: 404 };
  const league = await teamLeagueById(team.league_id);

  // Already playing for this team? Say so instead of sending them a link that does nothing.
  const cust = await customerHoursByContact({ phone: p });
  if (cust) {
    const roster = await rosterOfLeague(db, team.league_id);
    if (roster.some((r) => r.customer_id === cust.id && r.team_id === team.id && r.status === 'active')) {
      return { ok: true, alreadyOnTeam: true, team, league };
    }
  }

  // One live invite per number per team (the database has the same rule as a partial unique
  // index): inviting the same friend twice re-sends the first link rather than making a second.
  const live = await db.from('league_team_invites').select('*')
    .eq('team_id', team.id).eq('phone', p).is('claimed_at', null).is('revoked_at', null).maybeSingle();
  if (live.error && needs0031(live.error)) return team0031('createTeamInvite', live.error);
  if (live.data) return { ok: true, invite: live.data, already: true, team, league };

  const row = { team_id: team.id, phone: p, name: String(name || '').trim().slice(0, 120) || null,
    token: randomUUID(), invited_by: invitedBy || null };
  const { data, error } = await db.from('league_team_invites').insert(row).select('*').maybeSingle();
  if (error) {
    if (needs0031(error)) return team0031('createTeamInvite', error);
    if (isDuplicate(error)) {
      const { data: again } = await db.from('league_team_invites').select('*')
        .eq('team_id', team.id).eq('phone', p).is('claimed_at', null).is('revoked_at', null).maybeSingle();
      if (again) return { ok: true, invite: again, already: true, team, league };
    }
    console.error('createTeamInvite:', error.message);
    return { error: 'Could not create that invite. Please try again.', code: 500 };
  }
  return { ok: true, invite: data, team, league };
}

// The invite behind a link, with the team and league it belongs to. Null for an unknown token —
// a bearer secret that is not live gets no detail about anybody's team.
export async function teamInviteByToken(token) {
  const db = admin();
  if (!db || !token) return null;
  const { data, error } = await db.from('league_team_invites').select('*').eq('token', String(token)).maybeSingle();
  if (error) {
    if (needs0031(error)) { console.warn('teamInviteByToken: migration 0031 not applied yet.'); return { unsupported: true }; }
    console.error('teamInviteByToken:', error.message);
    return null;
  }
  if (!data) return null;
  const team = await leagueTeamById(data.team_id);
  const league = team ? await teamLeagueById(team.league_id) : null;
  return { invite: data, team, league };
}

// Tap the link, join the team. Single use, and it can never take a team past its size.
export async function claimTeamInvite({ token, customerId } = {}) {
  const db = admin();
  if (!db) return { error: 'The database is not configured.', code: 503 };
  if (!customerId) return { error: 'Sign in first, then open your invite link again.', code: 401 };
  const found = await teamInviteByToken(token);
  if (found && found.unsupported) return { error: MIGRATION_0031, code: 503 };
  if (!found || !found.team) return { error: 'That invite link isn’t valid. Ask your captain to send it again.', code: 404 };
  const { invite, team, league } = found;

  if (invite.revoked_at) return { error: 'That invite has been cancelled. Ask your captain to send a new one.', code: 410 };
  if (invite.claimed_at) {
    return invite.claimed_customer_id === customerId
      ? { ok: true, already: true, teamId: team.id, leagueId: team.league_id }
      : { error: 'That invite has already been used. Ask your captain to send you your own.', code: 409 };
  }

  const fill = await teamFullness(db, team, league);
  const mine = fill.players.find((r) => r.customer_id === customerId);
  if (!mine && fill.full) {
    return { error: `${team.name} is full — it holds ${fill.size} player${fill.size === 1 ? '' : 's'}. Ask your captain.`, code: 409 };
  }

  // Spend the invite first, and only the update that actually flips claimed_at wins: two taps at
  // once cannot both be the one that used it.
  const { data: spent, error } = await db.from('league_team_invites')
    .update({ claimed_at: new Date().toISOString(), claimed_customer_id: customerId })
    .eq('id', invite.id).is('claimed_at', null).select('id');
  if (error) {
    if (needs0031(error)) return { error: MIGRATION_0031, code: 503 };
    console.error('claimTeamInvite:', error.message);
    return { error: 'Could not join that team. Please try again.', code: 500 };
  }
  if (!spent || !spent.length) return { error: 'That invite has already been used.', code: 409 };

  const put = await putOnTeam(db, { leagueId: team.league_id, teamId: team.id, customerId, source: 'invite' });
  if (put.error) return put;
  return { ok: true, teamId: team.id, leagueId: team.league_id };
}

// ----- My teams -----
// Everything a player sees about the teams they are on: who else is on them, which weeks have a
// round booked, which were missed, and where the team sits. Other players by public name only.
export async function teamsForCustomer(customerId) {
  const db = admin();
  if (!db || !customerId) return { teams: [] };
  const { data: mine, error } = await db.from('league_members')
    .select('league_id,team_id,status').eq('customer_id', customerId).eq('status', 'active');
  if (error) {
    if (missingSchema(error)) return { teams: [], error: MIGRATION_0031, code: 503 };
    console.error('teamsForCustomer:', error.message);
    return { teams: [], error: 'Could not read your teams right now.', code: 500 };
  }
  const L = leagues(), today = winnipegTodayISO();
  const bays = Object.fromEntries((((await getSettings()) || {}).bays || []).map((b) => [b.id, b.name]));
  const out = [];
  for (const m of (mine || []).filter((x) => x.team_id)) {
    const league = await teamLeagueById(m.league_id);
    if (!league || !L.isCurrent(league, today)) continue;
    const team = await leagueTeamById(m.team_id);
    if (!team) continue;

    const [{ teams }, roster, resultsQ] = await Promise.all([
      teamsOfLeague(db, league.id),
      rosterOfLeague(db, league.id),
      db.from('league_results').select('team_id,customer_id,score,played_on').eq('league_id', league.id),
    ]);
    const members = roster.map((r) => ({ customer_id: r.customer_id, team_id: r.team_id, status: r.status, name: L.publicName(r.name) }));
    const rounds = await teamRounds(db, team.id);
    const standings = L.standings({ league, teams, members, results: resultsQ.data || [] });

    out.push({
      league: { ...league, bays: (league.bay_ids || []).map((id) => bays[id] || id) },
      team: { id: team.id, name: team.name, paid_at: team.paid_at || null, paid_cents: team.paid_cents || 0,
        captain: team.captain_customer_id === customerId },
      roster: roster.filter((r) => r.team_id === team.id && r.status === 'active').map((r) => ({
        name: L.publicName(r.name), isCaptain: r.customer_id === team.captain_customer_id, isMe: r.customer_id === customerId })),
      weeks: L.teamWeeks({ league, todayISO: today, rounds }),
      missedWeeks: L.missedWeeks({ league, todayISO: today, rounds }),
      currentWeek: L.currentWeek(league, today),
      standings: standings.map((r) => ({ rank: r.rank, name: r.name, played: r.played, total: r.total,
        average: r.average, best: r.best, you: r.key === team.id })),
      bays,
    });
  }
  return { teams: out };
}

// ----- The weekly round -----

// Is this customer actually on this team? Everything about booking a free round hangs off this,
// so it answers from the roster, never from anything the browser sent.
export async function teamMembershipFor({ teamId, customerId } = {}) {
  const db = admin();
  if (!db || !teamId || !customerId) return null;
  const team = await leagueTeamById(teamId);
  if (!team) return null;
  const { data, error } = await db.from('league_members').select('id,status,team_id')
    .eq('league_id', team.league_id).eq('customer_id', customerId).maybeSingle();
  if (error) { if (!missingSchema(error)) console.error('teamMembershipFor:', error.message); return null; }
  const member = data && data.status === 'active' && data.team_id === team.id ? data : null;
  const league = await teamLeagueById(team.league_id);
  return { team, league, member };
}

// The team's live round for the week dateISO falls in, if it has one already.
export async function teamRoundForWeek(teamId, dateISO) {
  const db = admin();
  if (!db || !teamId) return null;
  const week = leagues().weekOf(dateISO);
  const rounds = await teamRounds(db, teamId);
  return rounds.find((r) => r.status !== 'cancelled' && r.league_week === week) || null;
}

// Write the round. The two ways this can fail are both rules the database holds, not ours:
// the no-overlap constraint (somebody else has the bay) and the one-round-per-week index.
export async function insertLeagueRound(row) {
  const db = admin();
  if (!db) return { error: 'The database is not configured.', code: 503 };
  const { data, error } = await db.from('bookings').insert(row).select('id').maybeSingle();
  if (!error) return { ok: true, id: data && data.id };
  const msg = error.message || '';
  if (needs0031(error)) return team0031('insertLeagueRound', error);
  if (error.code === '23P01' || /overlap|exclusion/i.test(msg)) return { conflict: 'slot', code: 409 };
  if (isDuplicate(error) && /league_round|league_week|league_team/i.test(msg)) return { conflict: 'week', code: 409 };
  if (isDuplicate(error)) return { conflict: 'week', code: 409 };
  console.error('insertLeagueRound:', msg);
  return { error: 'Could not book that round. Please try again, or call the shop.', code: 500 };
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
// The address consent was given from, as CASL wants it recorded: the first entry in
// x-forwarded-for (the customer, ahead of any proxy), else the socket for a direct connection.
export function clientIp(req) {
  const h = (req && req.headers) || {};
  return String(h['x-forwarded-for'] || h['x-real-ip'] || '').split(',')[0].trim()
    || (req && req.socket && req.socket.remoteAddress) || null;
}

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

// A customer texted back. STOP is a withdrawal of consent and START is a fresh grant of it, so
// both end up in recordConsent above — one place writes the consent columns, whatever the door.
//
// WHY THIS ONLY EVER TOUCHES AN EXISTING CUSTOMER. recordConsent() creates a profile when it has
// to, which is right at checkout (they are buying something) and wrong here: anyone can text a
// number. An unknown sender therefore changes nothing and is reported as { unknown: true } — they
// have no consent on record to withdraw, and there is nothing to send them to restore.
export async function applySmsReply({ phone, intent, ip = null, source = 'sms-reply' } = {}) {
  const db = admin();
  if (!db) return { unsupported: true };
  if (intent !== 'stop' && intent !== 'start') return { ignored: true };
  const n = normPhone(phone);
  if (!n) return { invalid: true };
  const cust = await customerHoursByContact({ phone: n });
  if (!cust) return { unknown: true };
  // Their stored number, so the match that found them is the match that is written back.
  const r = await recordConsent({ phone: cust.phone || n, smsConsent: intent === 'start', ip, source });
  if (r.error) return { error: r.error, customerId: cust.id };
  if (r.unsupported) return { unsupported: true, customerId: cust.id };
  return { ok: true, customerId: cust.id, intent };
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
//      at all — the same contract as adjust_hours (0015).
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
// turns out to be taken. Same shape as bookWithHours above.
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

// A stable identity for one customer across every path, used as promo_redemptions.customer_key.
// Normalized phone first, lowercased email second — the same order customerHoursByContact matches
// in, so "who is this?" has one answer everywhere. Deliberately NOT customers.id: a first-time
// booker has no customer row yet, and a per-customer redemption limit that only binds registered
// customers is not a limit.
export function customerKeyFor({ email, phone } = {}) {
  const n = normPhone(phone);
  if (n) return `p:${n}`;
  const e = String(email || '').trim().toLowerCase();
  if (e) return `e:${e}`;
  return null;
}

// Every gift-card reservation attached to one PaymentIntent. The settlement path knows the
// payment but not the code (the code is the customer's, and by rule 1 it is never stored), so
// this is how "the payment succeeded — spend whatever was reserved against it" is answered.
export async function giftCardReservationsForRef(ref) {
  const db = admin();
  if (!db || !ref) return [];
  const { data, error } = await db.from('gift_card_reservations').select('*').eq('ref', String(ref));
  if (error) { if (!missingSchema(error)) console.error('giftCardReservationsForRef:', error.message); return []; }
  return data || [];
}

// ----- Promo codes (migration 0021) -----
//
// Same contract as the gift-card layer above, for the same reasons: the browser never reaches any
// of these (service-role only), every movement of a redemption counter happens inside one plpgsql
// function under a row lock on the promo, and a database still on migration 0020 reports the
// tables missing and gets { unsupported: true } after one warning rather than an exception.
//
// The DIVISION OF LABOUR is worth stating once, because it is easy to get backwards: this file
// and migration 0021 own the LIMITS and the VALIDITY WINDOW; lib/booking.js owns the AMOUNT.
// reserve_promo records whatever discount it is handed, so the only caller that may compute one
// is quoteBooking.

function promoUnsupported(where, error) {
  console.warn(`${where}: promo codes unavailable until migration 0021 is applied:`, error.message);
  return { unsupported: true };
}

// Pull the stable 'promo_…' token out of a raise exception coming back through PostgREST, so the
// API can map a database refusal to customer copy without matching on prose.
function promoReason(error) {
  const m = /promo_[a-z_]+/.exec((error && error.message) || '');
  return m ? m[0] : null;
}

// One code, matched the way the unique index in 0021 matches: case- and whitespace-insensitive.
// Returns null for "no such code" AND for a database without the table — a caller cannot tell the
// difference and should not, because both mean "there is no discount here".
export async function promoByCode(code) {
  const db = admin();
  if (!db) return null;
  // ilike is the only case-insensitive matcher PostgREST exposes, and the unique index in 0021 is
  // on upper(btrim(code)) — so the typed code goes into a LIKE PATTERN, and anything that is a
  // metacharacter there has to be dealt with before it gets near the query. Two layers:
  //
  //   (a) restrict the charset. A promo code is letters, digits, dash, dot, underscore. Stripping
  //       the rest removes '%' and '*' outright — '*' matters because PostgREST itself rewrites it
  //       to '%' on the way in, so escaping alone would not stop it.
  //   (b) escape what is left. '_' is legal in a code AND is LIKE's single-character wildcard, so
  //       without this "SAVE_20" would also match "SAVE020".
  //
  // Belt and braces on a lookup whose failure mode is handing a customer somebody else's discount.
  const norm = String(code || '').trim().replace(/[^0-9A-Za-z._-]/g, '');
  if (!norm || norm.length > 64) return null;
  const escaped = norm.replace(/[\\%_]/g, (c) => '\\' + c);
  const { data, error } = await db.from('promos').select('*').ilike('code', escaped).limit(2);
  if (error) { if (!missingSchema(error)) console.error('promoByCode:', error.message); return null; }
  if (data && data.length > 1) {
    console.warn(`promoByCode: "${norm}" matched ${data.length} rows — refusing to guess.`);
    return null;
  }
  return (data && data[0]) || null;
}

export async function promoById(id) {
  const db = admin();
  if (!db || !id) return null;
  const { data, error } = await db.from('promos').select('*').eq('id', id).maybeSingle();
  if (error) { if (!missingSchema(error)) console.error('promoById:', error.message); return null; }
  return data || null;
}

export async function promoReservationById(id) {
  const db = admin();
  if (!db || !id) return null;
  const { data, error } = await db.from('promo_redemptions').select('*').eq('id', id).maybeSingle();
  if (error) { if (!missingSchema(error)) console.error('promoReservationById:', error.message); return null; }
  return data || null;
}

// Claim one use of a code for ttlSeconds. Everything that could over-redeem happens inside
// reserve_promo under a lock on the promo row (see migration 0021 §5) — including releasing this
// same customer's previous reservation, which is why re-applying a code on every re-quote is
// normal rather than a way to exhaust it.
//
// Returns { reservationId, promoId, code, expiresAt, discountCents, redeemedCount } on success,
// or { reason } — one of promo_not_found / promo_inactive / promo_not_started / promo_expired /
// promo_exhausted / promo_already_used / promo_no_customer_key.
export async function reservePromo({ code, customerKey, customerId = null, discountCents = 0, ttlSeconds = 300, ref = null } = {}) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  if (!customerKey) return { reason: 'promo_no_customer_key' };
  const { data, error } = await db.rpc('reserve_promo', {
    p_code: String(code || ''), p_customer_key: String(customerKey), p_customer: customerId || null,
    p_discount_cents: Math.max(0, Math.round(Number(discountCents) || 0)),
    p_ttl_seconds: Math.round(Number(ttlSeconds) || 300), p_ref: ref || null,
  });
  if (error) {
    if (missingSchema(error)) return promoUnsupported('reservePromo', error);
    const reason = promoReason(error);
    if (reason) return { reason };
    console.error('reservePromo:', error.message);
    return { error: error.message };
  }
  const r = data || {};
  return {
    reservationId: r.reservationId || null, promoId: r.promoId || null, code: r.code || null,
    expiresAt: r.expiresAt || null, discountCents: Number(r.discountCents) || 0,
    redeemedCount: Number(r.redeemedCount) || 0,
  };
}

// Hand a claim back (checkout closed, code removed, slot changed). Best-effort by design — the
// callers are a beacon from a closing browser tab and a TTL sweeper, neither of which can do
// anything useful with an error. Releasing something already gone is success.
export async function releasePromo(reservationId) {
  const db = admin();
  if (!db || !reservationId) return { released: false };
  const { data, error } = await db.rpc('release_promo', { p_reservation: reservationId });
  if (error) {
    if (!missingSchema(error)) console.error('releasePromo:', error.message);
    return { released: false };
  }
  return { released: !!data };
}

// reserved → redeemed, at payment success. Idempotent: the client-side confirm and the Stripe
// webhook both call it for the same payment on purpose, and the second is a no-op.
export async function redeemPromo({ reservationId, bookingId = null, ref = null } = {}) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  if (!reservationId) return { error: 'A reservation id is required.' };
  const { data, error } = await db.rpc('redeem_promo', {
    p_reservation: reservationId, p_booking: bookingId || null, p_ref: ref || null,
  });
  if (error) {
    if (missingSchema(error)) return promoUnsupported('redeemPromo', error);
    console.error('redeemPromo:', error.message);
    return { error: error.message };
  }
  return { redeemed: !!data };
}

// True when this key may try another code. Fails OPEN: a database that cannot answer must not
// lock a customer out of a code the venue gave them.
export async function promoRateOk({ key, windowSeconds = 3600, maxFailed = 10 } = {}) {
  const db = admin();
  if (!db || !key) return true;
  const { data, error } = await db.rpc('promo_rate_ok', {
    p_key: String(key), p_window_seconds: Math.round(Number(windowSeconds) || 3600),
    p_max_failed: Math.round(Number(maxFailed) || 10),
  });
  if (error) { if (!missingSchema(error)) console.error('promoRateOk:', error.message); return true; }
  return data !== false;
}

export async function promoLogAttempt({ key, code, ok } = {}) {
  const db = admin();
  if (!db || !key) return;
  const { error } = await db.rpc('promo_log_attempt', {
    p_key: String(key), p_code: String(code || '').slice(0, 64), p_ok: !!ok,
  });
  if (error && !missingSchema(error)) console.error('promoLogAttempt:', error.message);
}

// Housekeeping for codes nobody is currently reserving — reserve_promo already sweeps its own.
export async function sweepPromoReservations() {
  const db = admin();
  if (!db) return { swept: 0 };
  const { data, error } = await db.rpc('sweep_promo_reservations');
  if (error) {
    if (!missingSchema(error)) console.error('sweepPromoReservations:', error.message);
    return { swept: 0 };
  }
  return { swept: Number(data) || 0 };
}

// ----- Waiting list (migration 0022) -----
//
// The rules that matter live in Postgres, not here: waitlist_process() decides who gets offered
// what under an advisory lock, and the unique indexes decide that a slot can only ever have one
// live offer. This layer is the thin PostgREST wrapper the API route talks to, and it degrades
// exactly like the gift-card and promo layers above — a database still on 0021 reports the tables
// as missing and every function below returns { unsupported: true } after one warning. Nothing a
// customer does may fail because the waiting list is not installed.

// Mirrors waitlist_config() in migration 0022. Kept in sync by hand — the SQL is authoritative for
// the sweep, this is what the API route uses to build links and explain deadlines.
export const WAITLIST_DEFAULTS = {
  claimMinutes: 15, checkoutMinutes: 10, maxOffersPerEntry: 3, minLeadMinutes: 60,
  quietStartMin: 1260, quietEndMin: 480, timezone: 'America/Winnipeg',
  holdSlot: true, sweepLimit: 25, lookaheadDays: 14,
  // Where the claim link points. Blank falls back to the request's own origin (api/waitlist.js).
  claimUrl: '', manageUrl: '',
};

export function waitlistConfig(settingsRow) {
  const w = (settingsRow && typeof settingsRow.waitlist === 'object' && settingsRow.waitlist) || {};
  const int = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : d;
  };
  return {
    claimMinutes:      int(w.claimMinutes, WAITLIST_DEFAULTS.claimMinutes, 2, 720),
    checkoutMinutes:   int(w.checkoutMinutes, WAITLIST_DEFAULTS.checkoutMinutes, 2, 120),
    maxOffersPerEntry: int(w.maxOffersPerEntry, WAITLIST_DEFAULTS.maxOffersPerEntry, 1, 50),
    minLeadMinutes:    int(w.minLeadMinutes, WAITLIST_DEFAULTS.minLeadMinutes, 0, 10080),
    quietStartMin:     int(w.quietStartMin, WAITLIST_DEFAULTS.quietStartMin, 0, 1440),
    quietEndMin:       int(w.quietEndMin, WAITLIST_DEFAULTS.quietEndMin, 0, 1440),
    timezone:          (typeof w.timezone === 'string' && w.timezone.trim()) || WAITLIST_DEFAULTS.timezone,
    holdSlot:          w.holdSlot === undefined ? WAITLIST_DEFAULTS.holdSlot : !!w.holdSlot,
    sweepLimit:        int(w.sweepLimit, WAITLIST_DEFAULTS.sweepLimit, 1, 200),
    lookaheadDays:     int(w.lookaheadDays, WAITLIST_DEFAULTS.lookaheadDays, 1, 365),
    claimUrl:          (typeof w.claimUrl === 'string' ? w.claimUrl.trim() : ''),
    manageUrl:         (typeof w.manageUrl === 'string' ? w.manageUrl.trim() : ''),
  };
}

// True when the venue's wall clock is inside the configured quiet hours. The same arithmetic as
// waitlist_quiet_now() in SQL, so the API can say "we'll text you after 8am" instead of going
// quiet for no visible reason. Equal start and end switches quiet hours off.
export function waitlistQuietNow(cfg, at = new Date()) {
  const { quietStartMin: s, quietEndMin: e, timezone } = cfg;
  if (s === e) return false;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  const m = (get('hour') % 24) * 60 + get('minute');
  return s < e ? (m >= s && m < e) : (m >= s || m < e);
}

function waitlistUnsupported(where, error) {
  console.warn(`${where}: the waiting list is unavailable until migration 0022 is applied:`, error.message);
  return { unsupported: true };
}

// Join the list. Returns { entry } — or { entry, already: true } when this customer already has a
// live entry for the same day and window, because re-submitting the form is not a second request
// and must not put them on the list twice (the partial unique index in 0022 is what says so).
export async function createWaitlistEntry({
  customerKey, customerId = null, name, email, phone,
  emailOk = false, smsOk = false, consentIp = null,
  dateISO, bayIds = [], windowStartMin, windowEndMin, durationMin, players = null, note = null,
} = {}) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  if (!customerKey) return { error: 'A phone number or email is needed to join the waiting list.' };

  const row = {
    customer_key: customerKey,
    customer_id: customerId || null,
    name: (name || '').trim() || null,
    email: (email || '').trim().toLowerCase() || null,
    phone: (phone || '').trim() || null,
    email_ok: !!emailOk,
    sms_ok: !!smsOk,
    consent_at: (emailOk || smsOk) ? new Date().toISOString() : null,
    consent_ip: consentIp || null,
    booking_date: dateISO,
    bay_ids: Array.isArray(bayIds) ? bayIds.filter(Boolean).map(String) : [],
    window_start_min: Math.round(Number(windowStartMin)),
    window_end_min: Math.round(Number(windowEndMin)),
    duration_min: Math.round(Number(durationMin)),
    players: players == null ? null : Math.round(Number(players)),
    note: (note || '').trim() || null,
  };

  const { data, error } = await db.from('waitlist_entries').insert(row).select('*').maybeSingle();
  if (error) {
    if (missingSchema(error)) return waitlistUnsupported('createWaitlistEntry', error);
    if (isDuplicate(error)) {
      const { data: live } = await db.from('waitlist_entries').select('*')
        .eq('customer_key', customerKey).eq('booking_date', dateISO)
        .eq('window_start_min', row.window_start_min).eq('window_end_min', row.window_end_min)
        .in('status', ['active', 'offered']).limit(1);
      if (live && live[0]) return { entry: live[0], already: true };
    }
    // A check constraint here is a bad request, not a server fault — the caller turns it into
    // wording the customer can act on.
    if (error.code === '23514') return { invalid: true, error: 'That time window does not work — check the times and how long you want.' };
    console.error('createWaitlistEntry:', error.message);
    return { error: error.message };
  }
  return { entry: data };
}

// One entry by the secret in the customer's own link.
export async function waitlistEntryByToken(token) {
  const db = admin();
  if (!db || !token) return null;
  const { data, error } = await db.from('waitlist_entries').select('*').eq('token', token).maybeSingle();
  if (error) {
    if (!missingSchema(error)) console.error('waitlistEntryByToken:', error.message);
    return null;
  }
  return data || null;
}

// Take yourself off the list; any live offer is withdrawn and its slot handed back at once.
export async function leaveWaitlist(token) {
  const db = admin();
  if (!db || !token) return { error: 'Not configured.' };
  const { data, error } = await db.rpc('waitlist_leave', { p_token: token });
  if (error) {
    if (missingSchema(error)) return waitlistUnsupported('leaveWaitlist', error);
    console.error('leaveWaitlist:', error.message);
    return { error: error.message };
  }
  return data || { ok: false };
}

// The offer behind a claim link, with the entry it belongs to. Returns null for an unknown token —
// a claim link is a bearer secret and an unknown one gets no detail beyond "no".
export async function waitlistOfferByToken(token) {
  const db = admin();
  if (!db || !token) return null;
  const { data, error } = await db.from('waitlist_offers')
    .select('*, entry:waitlist_entries(*)').eq('claim_token', token).maybeSingle();
  if (error) {
    if (!missingSchema(error)) console.error('waitlistOfferByToken:', error.message);
    return null;
  }
  return data || null;
}

// Take the slot (see waitlist_claim in 0022 — row-locked, so a double tap claims once).
export async function claimWaitlistOffer(token) {
  const db = admin();
  if (!db || !token) return { ok: false, reason: 'not_configured' };
  const { data, error } = await db.rpc('waitlist_claim', { p_token: token });
  if (error) {
    if (missingSchema(error)) return { ok: false, ...waitlistUnsupported('claimWaitlistOffer', error) };
    console.error('claimWaitlistOffer:', error.message);
    return { ok: false, error: error.message };
  }
  return data || { ok: false };
}

// "No thanks" — hands the slot to the next person immediately instead of after the full window.
export async function declineWaitlistOffer(token, { leave = false } = {}) {
  const db = admin();
  if (!db || !token) return { ok: false, reason: 'not_configured' };
  const { data, error } = await db.rpc('waitlist_decline', { p_token: token, p_leave: !!leave });
  if (error) {
    if (missingSchema(error)) return { ok: false, ...waitlistUnsupported('declineWaitlistOffer', error) };
    console.error('declineWaitlistOffer:', error.message);
    return { ok: false, error: error.message };
  }
  return data || { ok: false };
}

// Run the sweep: expire lapsed claim windows, then match queued wakeups to waiting customers.
// Idempotent — two overlapping runs cannot double-offer a slot (advisory lock + unique indexes).
export async function runWaitlistSweep({ limit } = {}) {
  const db = admin();
  if (!db) return { unsupported: true };
  const { data, error } = await db.rpc('waitlist_process', { p_limit: limit == null ? null : Math.round(Number(limit)) });
  if (error) {
    if (missingSchema(error)) return waitlistUnsupported('runWaitlistSweep', error);
    console.error('runWaitlistSweep:', error.message);
    return { error: error.message };
  }
  return data || {};
}

// Live offers nobody has been told about yet. The sweep creates offers; delivery happens over
// HTTP in lib/notify.js and can fail independently, so this is what makes the pair self-healing:
// an offer whose message did not get out is picked up again on the next run rather than expiring
// in silence.
export async function pendingWaitlistOffers({ limit = 25 } = {}) {
  const db = admin();
  if (!db) return [];
  const { data, error } = await db.from('waitlist_offers')
    .select('*, entry:waitlist_entries(*)')
    .eq('status', 'offered').is('notified_at', null).gt('expires_at', new Date().toISOString())
    .order('offered_at').limit(limit);
  if (error) {
    if (!missingSchema(error)) console.error('pendingWaitlistOffers:', error.message);
    return [];
  }
  return data || [];
}

export async function markWaitlistOfferNotified(id, channels = []) {
  const db = admin();
  if (!db || !id) return { unsupported: true };
  const { error } = await db.from('waitlist_offers')
    .update({ notified_at: new Date().toISOString(), notify_channels: channels })
    .eq('id', id);
  if (error) {
    if (missingSchema(error)) return { unsupported: true };
    console.error('markWaitlistOfferNotified:', error.message);
    return { error: error.message };
  }
  return { ok: true };
}

// ----- Group + recurring bookings (migration 0023) -----
//
// Same contract as the gift-card and promo layers above: service-role only, every multi-row
// booking write goes through one plpgsql function, and a database still on migration 0022 gets
// { unsupported: true } after one warning instead of an exception.
//
// THE DIVISION OF LABOUR, because it is the thing to get right here:
//   · migration 0023 owns ATOMICITY and RECURRENCE ARITHMETIC. book_group() is the only place in
//     the system that writes more than one booking row, and series_dates() is the only place that
//     turns "every second Thursday until March" into a list of dates.
//   · lib/booking.js owns PRICE. quoteGroup() calls the one waterfall once per occurrence.
//   · this file owns neither. It is the wire between them.

function seriesUnsupported(where, error) {
  console.warn(`${where}: group/recurring bookings unavailable until migration 0023 is applied:`, error.message);
  return { unsupported: true };
}

// Create the recurrence definition. A one-off group is freq 'once' — no special case anywhere.
export async function createSeries(row) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const { data, error } = await db.from('booking_series').insert(row).select('*').maybeSingle();
  if (error) {
    if (missingSchema(error)) return seriesUnsupported('createSeries', error);
    // A check constraint here is a bad request, not a server fault (end before start, no bays,
    // an unbounded recurring series) — the caller turns it into wording an operator can act on.
    if (error.code === '23514') return { invalid: true, error: error.message };
    console.error('createSeries:', error.message);
    return { error: error.message };
  }
  return { series: data };
}

export async function seriesById(id) {
  const db = admin();
  if (!db || !id) return null;
  const { data, error } = await db.from('booking_series').select('*').eq('id', id).maybeSingle();
  if (error) { if (!missingSchema(error)) console.error('seriesById:', error.message); return null; }
  return data || null;
}

export async function updateSeries(id, patch) {
  const db = admin();
  if (!db || !id) return { unsupported: true };
  const { data, error } = await db.from('booking_series').update(patch).eq('id', id).select('*').maybeSingle();
  if (error) {
    if (missingSchema(error)) return seriesUnsupported('updateSeries', error);
    console.error('updateSeries:', error.message);
    return { error: error.message };
  }
  return { series: data };
}

// Every series that still has occurrences owed before the horizon — the materialise sweep's
// worklist. 'once' series are included only while they have never been written at all.
export async function seriesNeedingHorizon(throughISO, { limit = 50 } = {}) {
  const db = admin();
  if (!db) return [];
  const { data, error } = await db.from('booking_series')
    .select('*').eq('status', 'active')
    .or(`materialised_through.is.null,materialised_through.lt.${throughISO}`)
    .order('created_at').limit(limit);
  if (error) { if (!missingSchema(error)) console.error('seriesNeedingHorizon:', error.message); return []; }
  return data || [];
}

// What the recurrence owes and what became of each date — see booking_series_occurrences (0023).
// [{ occurrence_date, seq, state: pending|booked|cancelled|skipped|moved, detail }]
export async function seriesOccurrences(seriesId, throughISO = null) {
  const db = admin();
  if (!db || !seriesId) return [];
  const { data, error } = await db.rpc('booking_series_occurrences',
    { p_series: seriesId, p_through: throughISO });
  if (error) { if (!missingSchema(error)) console.error('seriesOccurrences:', error.message); return []; }
  return data || [];
}

// The same date arithmetic before a series row exists, for the "what would this look like?"
// preview. Deliberately the SAME SQL function the real pass uses — a JavaScript copy of this
// would be a second recurrence implementation to keep in step, which is how leagues drift.
export async function seriesDatesPreview({ freq, intervalN = 1, startDate, untilDate = null, maxOccurrences = null, throughDate = null } = {}) {
  const db = admin();
  if (!db) return [];
  const { data, error } = await db.rpc('series_dates', {
    p_freq: freq, p_interval: Math.round(Number(intervalN) || 1), p_start: startDate,
    p_until: untilDate, p_max: maxOccurrences == null ? null : Math.round(Number(maxOccurrences)),
    p_through: throughDate,
  });
  if (error) { if (!missingSchema(error)) console.error('seriesDatesPreview:', error.message); return []; }
  return data || [];
}

// Advisory only — which of these bays is already taken. book_group()'s exclusion constraint is
// the guard; this exists so an operator hears about all six bays at once instead of one per try.
export async function groupConflicts({ dateISO, bayIds = [], startMin, endMin, ignoreGroupId = null } = {}) {
  const db = admin();
  if (!db) return [];
  const { data, error } = await db.rpc('group_conflicts', {
    p_date: dateISO, p_bays: bayIds, p_start: Math.round(Number(startMin)), p_end: Math.round(Number(endMin)),
    p_ignore_group: ignoreGroupId,
  });
  if (error) { if (!missingSchema(error)) console.error('groupConflicts:', error.message); return []; }
  return data || [];
}

// THE multi-row booking write. All of it or none of it — see book_group() in migration 0023.
// Returns { ok, groupId, bays } | { conflict: true, bay } | { error } | { unsupported: true }.
export async function bookGroup({ group, rows } = {}) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const { data, error } = await db.rpc('book_group', { p_group: group, p_rows: rows });
  if (error) {
    if (missingSchema(error)) return seriesUnsupported('bookGroup', error);
    console.error('bookGroup:', error.message);
    return { error: error.message };
  }
  return data || { error: 'no_result' };
}

// One occurrence with its bookings, for the manager view and the cancel/refund path.
export async function groupById(id) {
  const db = admin();
  if (!db || !id) return null;
  const { data, error } = await db.from('booking_groups')
    .select('*, series:booking_series(*), bookings(id,bay_id,booking_date,start_min,end_min,status,amount_cents,refunded_cents)')
    .eq('id', id).maybeSingle();
  if (error) { if (!missingSchema(error)) console.error('groupById:', error.message); return null; }
  return data || null;
}

// Record that an occurrence did not happen, and why. Never let one vanish silently.
export async function recordSeriesException({ seriesId, dateISO, kind, reason = null, detail = {} } = {}) {
  const db = admin();
  if (!db || !seriesId) return { unsupported: true };
  const { data, error } = await db.rpc('record_series_exception', {
    p_series: seriesId, p_date: dateISO, p_kind: kind, p_reason: reason, p_detail: detail || {},
  });
  if (error) {
    if (missingSchema(error)) return seriesUnsupported('recordSeriesException', error);
    console.error('recordSeriesException:', error.message);
    return { error: error.message };
  }
  return { id: data };
}

// Cancel a whole occurrence (bayIds null) or part of one. Returns what was cancelled and what it
// was worth; deciding what to refund is the caller's job, not this function's.
export async function cancelGroup({ groupId, bayIds = null, reason = null } = {}) {
  const db = admin();
  if (!db || !groupId) return { error: 'DB not configured' };
  const { data, error } = await db.rpc('cancel_group', {
    p_group: groupId, p_bays: bayIds && bayIds.length ? bayIds : null, p_reason: reason,
  });
  if (error) {
    if (missingSchema(error)) return seriesUnsupported('cancelGroup', error);
    console.error('cancelGroup:', error.message);
    return { error: error.message };
  }
  return data || { error: 'no_result' };
}

// Move one occurrence without touching the recurrence it belongs to. Atomic, same as bookGroup.
export async function moveGroup({ groupId, dateISO = null, startMin = null, endMin = null, bayMap = null, reason = null } = {}) {
  const db = admin();
  if (!db || !groupId) return { error: 'DB not configured' };
  const { data, error } = await db.rpc('move_group', {
    p_group: groupId, p_date: dateISO,
    p_start: startMin == null ? null : Math.round(Number(startMin)),
    p_end: endMin == null ? null : Math.round(Number(endMin)),
    p_bay_map: bayMap, p_reason: reason,
  });
  if (error) {
    if (missingSchema(error)) return seriesUnsupported('moveGroup', error);
    console.error('moveGroup:', error.message);
    return { error: error.message };
  }
  return data || { error: 'no_result' };
}

// ⚠ Records an obligation. MOVES NO MONEY. See section 5 of migration 0023 — no Stripe call is
// made from here, and stored value (gift cards) is not returned either. A row is a note
// that somebody is owed something, kept idempotent on (booking_id, ref).
export async function recordRefund({ bookingId = null, groupId = null, amountCents, reason = null, method = 'stripe', ref = null, note = null, by = null } = {}) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const { data, error } = await db.rpc('record_refund', {
    p_booking: bookingId, p_group: groupId, p_amount: Math.round(Number(amountCents) || 0),
    p_reason: reason, p_method: method, p_ref: ref, p_note: note, p_by: by,
  });
  if (error) {
    if (missingSchema(error)) return seriesUnsupported('recordRefund', error);
    console.error('recordRefund:', error.message);
    return { error: error.message };
  }
  return data || { error: 'no_result' };
}

// ----- Staff accounts, roles and the audit log (migration 0024) -----
//
// The database is the authority: every policy in 0024 is enforced by Postgres, and the three
// rules below are a MIRROR of public.staff_role() / public.staff_can(), not a second opinion.
// They exist because this file holds the SERVICE-ROLE key, which bypasses RLS entirely — so when
// an API route acts on a manager's behalf, nothing in the database is checking anything and the
// route has to ask the question itself. Keep the two in step; 0024 §4 is the original.
//
//   1. an active staff row     → that role
//   2. no active admin exists  → 'admin' (bootstrap, so a fresh install is never locked out)
//   3. otherwise               → null, which is "not staff"
//
// Everything degrades the same way the rest of this file does: a database without migration 0024
// reports the table as missing and these return { unsupported: true } after one warning, so an
// endpoint that gates on them can decide to fall back to verifyManager() alone rather than fail.
const STAFF_ROLES = ['admin', 'employee', 'readonly'];
let _staffWarned = false;
function staffUnsupported(where, error) {
  if (!_staffWarned) {
    console.warn(`${where}: staff roles unavailable until migration 0024 is applied:`, error.message);
    _staffWarned = true;
  }
  return { unsupported: true };
}

// The staff row for one auth user, or null. { unsupported: true } before migration 0024.
export async function staffByUserId(userId) {
  const db = admin();
  if (!db || !userId) return null;
  const { data, error } = await db.from('staff').select('*').eq('user_id', userId).maybeSingle();
  if (error) {
    if (missingSchema(error)) return staffUnsupported('staffByUserId', error);
    console.error('staffByUserId:', error.message);
    return null;
  }
  return data || null;
}

// Everyone who can sign in, newest first. The portal's Staff tab.
export async function listStaff() {
  const db = admin();
  if (!db) return [];
  const { data, error } = await db.from('staff').select('*').order('created_at');
  if (error) {
    if (missingSchema(error)) { staffUnsupported('listStaff', error); return []; }
    console.error('listStaff:', error.message);
    return [];
  }
  return data || [];
}

// The editable half of the permission matrix. Admin is deliberately absent — it is "everything"
// by definition (0024 §3) and the UI should render it as fixed.
export async function rolePermissions() {
  const db = admin();
  if (!db) return { capabilities: [], permissions: [] };
  const caps = await db.from('capabilities').select('*').order('sort');
  if (caps.error) {
    if (missingSchema(caps.error)) { staffUnsupported('rolePermissions', caps.error); return { capabilities: [], permissions: [] }; }
    console.error('rolePermissions:', caps.error.message);
    return { capabilities: [], permissions: [] };
  }
  const perms = await db.from('role_permissions').select('*');
  if (perms.error) { console.error('rolePermissions:', perms.error.message); return { capabilities: caps.data || [], permissions: [] }; }
  return { capabilities: caps.data || [], permissions: perms.data || [] };
}

// Who is this request, and may they do <capability>? The single call an API route should make
// before a privileged action. Returns { user, staff, role, capabilities, can }, or { error }.
//
// `capability` is optional: pass nothing to ask only "are you staff at all?".
export async function staffContext(accessToken, capability = null) {
  const { user, error } = await verifyManager(accessToken);
  if (error) return { error };

  const db = admin();
  if (!db) return { error: 'DB not configured' };

  const row = await staffByUserId(user.id);
  if (row && row.unsupported) {
    // Migration 0024 is not applied. Every authenticated user is still an unrestricted manager,
    // exactly as before this feature existed — say so instead of pretending to have checked.
    return { user, staff: null, role: 'admin', capabilities: [], can: true, unsupported: true };
  }

  let role = row && row.is_active ? row.role : null;
  let bootstrap = false;
  // Rule 2 — the bootstrap. Mirrors public.staff_role() as of migration 0026: never for someone
  // the staff table already knows, and never for a customer account (anyone can make one).
  if (!role && !row && user.user_metadata?.source !== 'customer_signup') {
    const { data, error: adminErr } = await db.from('staff')
      .select('user_id').eq('role', 'admin').eq('is_active', true).limit(1);
    if (adminErr) { console.error('staffContext:', adminErr.message); return { error: 'unauthorized' }; }
    if (!data || data.length === 0) {
      const { data: cust } = await db.from('customers').select('id').eq('user_id', user.id).limit(1);
      if (!cust || cust.length === 0) { role = 'admin'; bootstrap = true; }
    }
  }
  if (!role) return { error: 'forbidden', reason: 'no_staff_record' };

  let capabilities = [];
  if (role === 'admin') {
    const { data } = await db.from('capabilities').select('key').order('sort');
    capabilities = (data || []).map((c) => c.key);
  } else {
    const { data } = await db.from('role_permissions').select('capability').eq('role', role).eq('allowed', true);
    capabilities = (data || []).map((p) => p.capability);
  }

  const can = role === 'admin' || !capability || capabilities.includes(capability);
  if (capability && !can) return { error: 'forbidden', reason: capability, role, user, staff: row || null };
  return { user, staff: row || null, role, capabilities, can, bootstrap };
}

// Add or update one staff login. `userId` is the uuid from Supabase → Authentication → Users;
// creating the auth user itself is a GoTrue admin call, not this.
export async function upsertStaff({ userId, email = null, name = null, role = 'employee', isActive = true, note = null, by = null } = {}) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  if (!userId) return { error: 'userId is required — copy it from Supabase → Authentication → Users' };
  if (!STAFF_ROLES.includes(role)) return { error: `role must be one of ${STAFF_ROLES.join(', ')}` };
  const row = { user_id: userId, email, name, role, is_active: !!isActive, note, updated_at: new Date().toISOString() };
  if (by) row.created_by = by;
  const { data, error } = await db.from('staff').upsert(row, { onConflict: 'user_id' }).select('*').maybeSingle();
  if (error) {
    if (missingSchema(error)) return staffUnsupported('upsertStaff', error);
    // 42501 here is the last-admin trigger in 0024 §6, which is a rule, not a bug — pass its
    // message straight through so the portal can show the operator what happened.
    console.error('upsertStaff:', error.message);
    return { error: error.message };
  }
  return { staff: data || null };
}

// Revoke access without deleting the history attached to the row.
export async function deactivateStaff(userId) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  const { data, error } = await db.from('staff')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('user_id', userId).select('*').maybeSingle();
  if (error) {
    if (missingSchema(error)) return staffUnsupported('deactivateStaff', error);
    console.error('deactivateStaff:', error.message);
    return { error: error.message };
  }
  return { staff: data || null };
}

// Flip one box in the permission matrix. Only 'employee' and 'readonly' are storable — admin is
// not data (0024 §3), which is why an admin can never switch their own access off.
export async function setRolePermission({ role, capability, allowed } = {}) {
  const db = admin();
  if (!db) return { error: 'DB not configured' };
  if (role === 'admin') return { error: 'admin always has every permission and cannot be edited' };
  if (!['employee', 'readonly'].includes(role)) return { error: 'role must be employee or readonly' };
  const { data, error } = await db.from('role_permissions')
    .upsert({ role, capability, allowed: !!allowed, updated_at: new Date().toISOString() }, { onConflict: 'role,capability' })
    .select('*').maybeSingle();
  if (error) {
    if (missingSchema(error)) return staffUnsupported('setRolePermission', error);
    console.error('setRolePermission:', error.message);
    return { error: error.message };
  }
  return { permission: data || null };
}

// Read the audit trail. Newest first; `table` and `actorId` narrow it, `since` is an ISO date.
export async function auditLog({ limit = 100, table = null, actorId = null, since = null } = {}) {
  const db = admin();
  if (!db) return [];
  let q = db.from('audit_log').select('*').order('at', { ascending: false }).limit(Math.min(Number(limit) || 100, 500));
  if (table) q = q.eq('table_name', table);
  if (actorId) q = q.eq('actor_id', actorId);
  if (since) q = q.gte('at', since);
  const { data, error } = await q;
  if (error) {
    if (missingSchema(error)) { staffUnsupported('auditLog', error); return []; }
    console.error('auditLog:', error.message);
    return [];
  }
  return data || [];
}

// Record something no trigger can see: a Stripe refund that succeeded, a gift card emailed, an
// export downloaded. Row changes are captured by the triggers in 0024 §7 and do NOT need this.
// Never throws and never blocks the caller — a missing audit row must not fail a refund.
export async function recordAudit({ action, table = null, rowId = null, actor = null, note = null, detail = null } = {}) {
  const db = admin();
  if (!db || !action) return { skipped: true };
  const row = {
    action: String(action),
    table_name: table || 'server',
    row_id: rowId ? String(rowId) : null,
    actor_id: actor && actor.user ? actor.user.id : (actor && actor.id) || null,
    actor_email: (actor && (actor.email || (actor.user && actor.user.email))) || null,
    actor_role: (actor && actor.role) || 'service',
    note,
    row_after: detail || null,
    source: 'server',
  };
  const { error } = await db.from('audit_log').insert(row);
  if (error) {
    if (missingSchema(error)) return staffUnsupported('recordAudit', error);
    console.error('recordAudit:', error.message);
    return { error: error.message };
  }
  return { ok: true };
}
