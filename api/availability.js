import { getSettings, getBookingsForDate, getOverridesForDate, cleanupExpiredHolds } from '../lib/db.js';
import { normalizeSettings, overrideEffects, weeklyStatusBlocked } from '../lib/booking.js';

// Public availability: live settings + busy time ranges per bay for a date (no customer data).
export default async function handler(req, res) {
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
