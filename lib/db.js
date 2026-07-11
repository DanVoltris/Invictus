// Supabase access for the server (API routes / webhook).
// Uses the SERVICE-ROLE key, which bypasses Row Level Security — server-only, never shipped to the browser.
import { createClient } from '@supabase/supabase-js';

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
  if (!db) return [];
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

// Normalize a phone number to bare 10 digits (drops formatting and a leading 1), or null.
function normPhone(p) {
  const d = (p || '').replace(/\D/g, '');
  const n = (d.length === 11 && d[0] === '1') ? d.slice(1) : d;
  return n.length === 10 ? n : null;
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

  let cust = null;
  if (e) { const { data } = await db.from('customers').select('*').ilike('email', e).limit(1); if (data && data[0]) cust = data[0]; }
  if (!cust && p) { const { data } = await db.from('customers').select('*').eq('phone', p).limit(1); if (data && data[0]) cust = data[0]; }

  // Retry once without sms_opt_in if migration 0014 hasn't been applied.
  const run = async (payload, isInsert) => {
    let r = isInsert ? await db.from('customers').insert(payload).select('id').single()
                     : await db.from('customers').update(payload).eq('id', cust.id).select('id').maybeSingle();
    if (r.error && /sms_opt_in|column/i.test(r.error.message || '')) {
      const { sms_opt_in, ...rest } = payload;
      r = isInsert ? await db.from('customers').insert(rest).select('id').single()
                   : await db.from('customers').update(rest).eq('id', cust.id).select('id').maybeSingle();
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
