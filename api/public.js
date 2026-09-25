import { getSettings, getBookingsForDate, getOverridesForDate, cleanupExpiredHolds } from '../lib/db.js';
import { stripeStatus, normalizeSettings, overrideEffects, weeklyStatusBlocked } from '../lib/booking.js';

// The two anonymous reads every visitor makes before they can do anything — what this install is
// wired up to, and what is free on a given day. Dispatch on ?action=, the same shape as
// api/gift-cards.js, api/leagues.js and api/waitlist.js:
//
//   GET ?action=config         Stripe on/off (+ publishable key) and the PUBLIC Supabase config
//   GET ?action=availability   live settings + busy ranges for ?date=YYYY-MM-DD
//
// WHY THESE TWO SHARE A FILE. Vercel's Hobby plan allows 12 Serverless Functions and api/ held 16,
// so the project could not deploy at all. Both of these are anonymous reads with no customer data
// in them, so they cost one slot between them instead of two. Nothing about either answer changed.
//
// THE OLD URLS ARE UNCHANGED. /api/config and /api/availability still work: vercel.json rewrites
// each onto this file with the right ?action=, and server.js mounts the same two paths on the same
// dispatcher below. No page in demo/ was edited.

// Which of the two is being asked for. Normally ?action=, set by the rewrite. `forced` is how
// server.js names the action for a path it mounts directly — Vercel only ever passes (req, res),
// so the default applies there.
export default async function handler(req, res, forced) {
  const action = forced || actionOf(req, ['config', 'availability']);
  if (action === 'config') return config(req, res);
  if (action === 'availability') return availability(req, res);
  return res.status(400).json({ error: 'Unknown action' });
}

// A rewrite MERGES the incoming query string with the destination's, so if a caller ever sent its
// own ?action= to one of the old paths the key arrives twice, as an array. Pick the first value
// this file actually recognises rather than whichever end happened to win.
function actionOf(req, known) {
  const raw = (req.query && req.query.action);
  const list = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v == null ? '' : v));
  return list.find((v) => known.includes(v)) || list[0] || '';
}

// ---- ?action=config (was api/config.js) -----------------------------------------------
// Tells the browser whether Stripe is live (+ publishable key) and hands the admin page
// the PUBLIC Supabase config (URL + anon key) for email/password login.
export function config(req, res) {
  const { enabled, publishableKey } = stripeStatus(process.env);
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const dbEnabled = Boolean(url && process.env.SUPABASE_SERVICE_ROLE_KEY);
  res.status(200).json({
    stripeEnabled: enabled,
    publishableKey: enabled ? publishableKey : null,
    dbEnabled,
    supabase: url && anonKey ? { url, anonKey } : null,
  });
}

// ---- ?action=availability (was api/availability.js) ------------------------------------
// Public availability: live settings + busy time ranges per bay for a date (no customer data).
export async function availability(req, res) {
  const row = await getSettings();
  if (!row) return res.status(200).json({ dbEnabled: false });

  const settings = normalizeSettings(row);
  const dateISO = (req.query && req.query.date) || '';
  const booked = {};
  const closed = {};    // ranges closed by the recurring weekly status pattern (labelled distinctly)
  const unavailable = {};   // ranges the VENUE closed (override or weekly status) — "Closed", not "Booked"
  const reasons = {};       // { bayId: [[start, end, reason], …] } — only reasons staff marked public (0032)
  let closedReason = null;  // why the whole day is shut, when staff chose to say
  let hoursReason = null;   // …or why today's hours are different from usual
  const held = {};      // live cart holds — shown to other users as "Held"
  let dateHours = null; // effective [open,close] for this exact date, or [0,0] when closed by override
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    await cleanupExpiredHolds();
    for (const b of await getBookingsForDate(dateISO)) {
      (booked[b.bay_id] ||= []).push([b.start_min, b.end_min]);
      if (b.status === 'held') (held[b.bay_id] ||= []).push([b.start_min, b.end_min]);
    }
    const overrides = await getOverridesForDate(dateISO);
    // Overrides: venue-wide hour changes surface as dateHours; per-bay blocks are merged
    // into the busy ranges so those slots simply read as unavailable (no reason leaked).
    const fx = overrideEffects(overrides, settings, dateISO);
    dateHours = fx.dateHours;
    closedReason = fx.closedReason || null;
    hoursReason = fx.hoursReason || null;
    for (const [bayId, ranges] of Object.entries(fx.blocked)) {
      // Still merged into `booked` so the slot cannot be sold — but also listed as `unavailable`,
      // because telling a customer the venue's own maintenance block is "Booked" is a lie they act
      // on ("someone took it, I'll try tomorrow") rather than an omission.
      for (const r of ranges) { (booked[bayId] ||= []).push(r); (unavailable[bayId] ||= []).push(r); }
    }
    for (const [bayId, ranges] of Object.entries(fx.reasons || {})) {
      for (const r of ranges) (reasons[bayId] ||= []).push(r);
    }
    // Recurring weekly "Closed" bands also make time unavailable — merge them into busy
    // ranges (so they can't be booked) and surface them separately for a clearer label.
    for (const [bayId, ranges] of Object.entries(weeklyStatusBlocked(settings, overrides, dateISO))) {
      for (const r of ranges) { (booked[bayId] ||= []).push(r); (closed[bayId] ||= []).push(r); (unavailable[bayId] ||= []).push(r); }
    }
  }

  res.status(200).json({
    dbEnabled: true,
    settings: {
      bays: settings.bays.filter((b) => !b.holding),   // holding bays are manager-only, never bookable online
      hours: settings.hours,
      slotStep: settings.slotStep,
      minMins: settings.minMins,
      maxParty: settings.maxParty,
      peakStartHour: settings.peakStartHour,
      rates: settings.rates,
      bayRates: settings.bayRates,
    },
    dateHours,
    booked,
    closed,
    unavailable,     // venue-closed ranges: the booking page labels these "Closed", never "Booked"
    reasons,         // why, for the ones staff ticked "show customers" (0032)
    closedReason,    // why the whole day is shut, when staff said
    hoursReason,     // why today's hours are shorter than usual, when staff said
    held,
  });
}
