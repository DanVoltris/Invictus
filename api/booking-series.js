import {
  normalizeSettings, bayName, fmtMin, winnipegTodayISO, quoteGroup, SERIES_FREQS,
  overrideEffects, overrideConflicts, weeklyStatusConflicts, stripeStatus, stripeClient,
  hoursUntilBooking,
} from '../lib/booking.js';
import { issueRefund } from '../lib/refunds.js';
import { captureHold, releaseHold as releaseAuthorisation, holdView } from '../lib/holds.js';
import {
  getSettings, getOverridesForDate, staffContext,
  createSeries, seriesById, updateSeries, seriesNeedingHorizon, seriesOccurrences, seriesDatesPreview,
  groupConflicts, bookGroup, groupById, recordSeriesException, cancelGroup, moveGroup, recordRefund,
  customerHoursByContact, heldBookings, bookingForHold,
} from '../lib/db.js';

// Group + recurring bookings. Dispatch on ?action= —
//
//   preview   POST   what would this series look like, and what is already in the way?
//   create    POST   make the series and write every occurrence it can (groups included)
//   get       GET    one series with every occurrence and what became of it
//   extend    POST   push the horizon forward — one series, or a sweep of all of them
//   cancel    POST   cancel an occurrence, or some of its bays, and record what is owed back
//   end       POST   stop a recurrence: cancel what is still ahead, leave the past alone
//   move      POST   put one occurrence somewhere else without breaking the recurrence
//   refund    POST   actually send money back through Stripe, for ONE booking (see below)
//
// WHY `refund` LIVES HERE AND NOT IN A FILE OF ITS OWN. Two reasons, and the second is the real
// one. Vercel's Hobby plan allows 12 Serverless Functions and api/ holds exactly 12 — a thirteenth
// file means the project stops deploying. And this file already owns `public.refunds`: ?action=
// cancel writes the obligations, so the thing that pays them belongs beside it, sharing the same
// staff gate and the same money.write rule. It refunds any booking, group or not.
//
// A GROUP IS A SERIES OF ONE. There is no separate "group" endpoint and no separate group table
// hierarchy, because `booking_groups.series_id` and `booking_series` were the same idea invented
// twice (see the build plan's shared-data-models list). Booking six bays for Saturday is a series
// with freq 'once'; a Thursday league is the same shape repeated. Everything below — pricing,
// atomicity, cancellation, refunds — is written once and works for both.
//
// WHAT THIS FILE DOES NOT DECIDE:
//   · Whether the write succeeded partially. It cannot: book_group() in migration 0023 is the one
//     multi-row booking write and it is all-or-nothing.
//   · What anything costs. quoteGroup() in lib/booking.js calls quoteBooking() — the single
//     pricing waterfall — once per occurrence, on the occurrence's TOTAL. Never per bay: every
//     step below the base rate belongs to the customer, not the bay, so a six-bay event must not
//     burn a gift card six times.
//   · Whether the recurrence lands on the 30th or the 28th. series_dates() in SQL owns that.

// How far ahead occurrences are written. See "MATERIALISE-AHEAD" in migration 0023 for why they
// are written at all rather than computed when someone opens a calendar.
const HORIZON_DAYS = Math.max(1, Number(process.env.SERIES_HORIZON_DAYS) || 90);
// A hard ceiling on how many occurrences one call will write, so a fat-fingered daily-for-two-years
// series cannot turn one HTTP request into 700 inserts and a timeout.
const MAX_PER_CALL = 60;

const isUuid = (s) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(s || ''));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || '';
  if (req.method === 'GET') {
    if (action === 'get') return getSeries(req, res);
    if (action === 'holds') return holds(req, res);
    return res.status(400).json({ ok: false, error: 'Unknown action' });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (action === 'preview') return preview(req, res);
  if (action === 'create') return create(req, res);
  if (action === 'extend') return extend(req, res);
  if (action === 'cancel') return cancel(req, res);
  if (action === 'end') return end(req, res);
  if (action === 'move') return move(req, res);
  if (action === 'refund') return refund(req, res);
  if (action === 'capture') return capture(req, res);
  if (action === 'release') return release(req, res);
  return res.status(400).json({ ok: false, error: 'Unknown action' });
}

// ----- auth ---------------------------------------------------------------------------------
//
// Every action here is staff-only, checked by staffContext against the staff table. A Supabase
// session alone proves nothing: customer accounts sign in to the same auth project. Writes need
// booking.write (0024 puts booking_series/booking_groups under it); recording a refund also needs
// money.write (public.refunds). Reads — preview, get — need any staff login, the same rule 0024
// applies to reading these tables. `extend` additionally accepts the cron secret, because the
// horizon pass is meant to run on a schedule with nobody signed in — same shape as the
// waiting-list sweep in 0022.
//
// Returns the staff context, or null after answering 401 / 403 itself.
async function staff(req, res, capability = null) {
  const auth = (req.headers && req.headers.authorization) || '';
  const ctx = auth ? await staffContext(auth, capability) : { error: 'unauthorized' };
  if (!ctx.error) return ctx;
  if (ctx.error === 'unauthorized') denied(res);
  else if (ctx.error === 'forbidden') forbidden(res, capability);
  else res.status(503).json({ ok: false, error: 'Database not configured.' });
  return null;
}
function cronOk(req) {
  const secret = process.env.SERIES_SWEEP_SECRET || process.env.WAITLIST_SWEEP_SECRET || '';
  const sent = String((req.headers && (req.headers['x-series-secret'] || req.headers['x-cron-secret'])) || '');
  if (!secret || !sent || sent.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < sent.length; i++) diff |= sent.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}
const denied = (res) => res.status(401).json({ ok: false, error: 'Sign in to the manager portal first.' });
const CAP_LABEL = { 'booking.write': 'Bookings', 'money.write': 'Money' };
const forbidden = (res, capability) => res.status(403).json({
  ok: false,
  error: capability
    ? `This needs a staff login with the ${CAP_LABEL[capability]} permission (${capability}). Ask an admin to turn it on under Staff.`
    : 'This needs a staff login. Customer accounts cannot use the manager tools.',
});

// ----- shared validation --------------------------------------------------------------------
//
// Turns whatever the caller sent into a definition the database will accept, or an error a human
// can act on. Everything downstream assumes this has run.
function readDefinition(body, settings) {
  const b = body || {};
  const freq = String(b.freq || 'once').toLowerCase();
  if (!SERIES_FREQS.includes(freq)) return { error: `Repeat can be ${SERIES_FREQS.join(', ')} — not “${b.freq}”.` };

  const startDate = String(b.startDate || b.dateISO || '').trim();
  if (!isDate(startDate)) return { error: 'Pick a start date.' };
  if (startDate < winnipegTodayISO()) return { error: 'That start date has already passed.' };

  const startMin = Math.round(Number(b.startMin));
  const endMin = Math.round(Number(b.endMin));
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
    return { error: 'Give a start and end time, with the end after the start.' };
  }
  const minMins = Math.max(15, Number(settings.minMins) || 60);
  if (endMin - startMin < minMins) return { error: `Sessions are at least ${minMins} minutes.` };

  const known = new Set(settings.bays.filter((x) => !x.holding).map((x) => String(x.id)));
  const bayIds = [...new Set((Array.isArray(b.bayIds) ? b.bayIds : [b.bayId]).filter(Boolean).map(String))].sort();
  if (!bayIds.length) return { error: 'Pick at least one bay.' };
  const unknown = bayIds.find((id) => !known.has(id));
  if (unknown) return { error: `We don’t have a bay called ${unknown}.` };

  const intervalN = Math.round(Number(b.intervalN ?? b.interval ?? 1)) || 1;
  if (intervalN < 1 || intervalN > 52) return { error: 'Repeat every 1–52.' };

  const untilDate = isDate(b.untilDate) ? String(b.untilDate) : null;
  if (untilDate && untilDate < startDate) return { error: 'The end of the series is before it starts.' };
  const maxOccurrences = b.maxOccurrences == null || b.maxOccurrences === ''
    ? null : Math.round(Number(b.maxOccurrences));
  if (maxOccurrences != null && (!Number.isFinite(maxOccurrences) || maxOccurrences < 1 || maxOccurrences > 520)) {
    return { error: 'Number of sessions must be between 1 and 520.' };
  }
  // A recurring series with no end is a standing claim on six bays forever. The database refuses
  // it too (booking_series_bounded); saying so here gets a sentence instead of a constraint name.
  if (freq !== 'once' && !untilDate && maxOccurrences == null) {
    return { error: 'A repeating booking needs an end date or a number of sessions.' };
  }

  const players = b.players == null || b.players === '' ? null
    : Math.min(Math.max(Math.round(Number(b.players)) || 1, 1), Math.max(1, Number(settings.maxParty) || 4) * bayIds.length);

  return {
    def: {
      label: String(b.label || '').trim().slice(0, 160) || null,
      freq, interval_n: intervalN, start_date: startDate,
      until_date: untilDate, max_occurrences: maxOccurrences,
      bay_ids: bayIds, start_min: startMin, end_min: endMin, players,
      customer_name: String(b.name || '').trim().slice(0, 120) || null,
      customer_email: String(b.email || '').trim().toLowerCase() || null,
      customer_phone: String(b.phone || '').trim() || null,
      status_label: String(b.statusLabel || '').trim() || settings.onlineStatusLabel || null,
      source: b.source === 'online' ? 'online' : 'manager',
      note: String(b.note || '').trim().slice(0, 500) || null,
      pay_mode: ['per_occurrence', 'prepaid', 'invoice'].includes(b.payMode) ? b.payMode : 'per_occurrence',
    },
  };
}

// Who is paying. Looked up ONCE per request — a series of twelve occurrences must not do twelve
// customer lookups. `plan` stays null: memberships were retired for leagues (0028), which carry no
// discount, and staff-made series are not limited by the customer booking window.
async function payer({ email, phone }) {
  const cust = await customerHoursByContact({ email, phone });
  return { cust: cust || null, plan: null };
}

// The venue's own calendar: closures, special hours and the recurring tee-sheet status pattern.
// These live in JavaScript (lib/booking.js), not in the exclusion constraint, so they have to be
// checked here — a league that books straight through a Christmas closure is a phone call.
async function venueBlocks(settings, dateISO, bayIds, startMin, endMin) {
  const overrides = await getOverridesForDate(dateISO);
  const fx = overrideEffects(overrides, settings, dateISO);
  const blocked = bayIds.filter((bayId) =>
    overrideConflicts(fx, settings, dateISO, bayId, startMin, endMin) ||
    weeklyStatusConflicts(settings, overrides, dateISO, bayId, startMin, endMin));
  return { dateHours: fx.dateHours, blocked };
}

// ----- preview ------------------------------------------------------------------------------
//
// Read-only. Every date the recurrence would produce, what it would cost, and what is already
// standing in the way — before anything is written. The dates come from series_dates() in SQL,
// the same function the real pass uses, so the preview cannot disagree with what happens next.
async function preview(req, res) {
  if (!(await staff(req, res))) return;
  const settingsRow = await getSettings();
  if (!settingsRow) return res.status(503).json({ ok: false, error: 'Database not configured.' });
  const settings = normalizeSettings(settingsRow);

  const v = readDefinition(req.body, settings);
  if (v.error) return res.status(400).json({ ok: false, error: v.error });
  const d = v.def;

  const through = isDate(req.body && req.body.throughDate)
    ? req.body.throughDate : addDays(winnipegTodayISO(), HORIZON_DAYS);
  const dates = await seriesDatesPreview({
    freq: d.freq, intervalN: d.interval_n, startDate: d.start_date,
    untilDate: d.until_date, maxOccurrences: d.max_occurrences, throughDate: through,
  });
  // series_dates() always returns at least the start date when it is inside the horizon, so an
  // empty answer there means the function is not installed — not that the recurrence is empty.
  if (!dates.length && d.start_date <= through) {
    return res.status(503).json({ ok: false, code: 'schema', error: 'Group and repeat bookings aren’t switched on yet — apply migration 0023.' });
  }

  const { cust, plan } = await payer({ email: d.customer_email, phone: d.customer_phone });
  const today = winnipegTodayISO();
  const out = [];
  let total = 0, listTotal = 0;
  for (const row of dates.slice(0, MAX_PER_CALL)) {
    const dateISO = row.occurrence_date;
    const { dateHours, blocked } = await venueBlocks(settings, dateISO, d.bay_ids, d.start_min, d.end_min);
    const taken = blocked.length ? [] : await groupConflicts({
      dateISO, bayIds: d.bay_ids, startMin: d.start_min, endMin: d.end_min });
    const q = quoteGroup({
      settings, dateISO, bayIds: d.bay_ids, startMin: d.start_min, endMin: d.end_min, dateHours,
      plan, membershipExpires: cust && cust.membership_expires, todayISO: today,
    });
    out.push({
      date: dateISO, seq: row.seq,
      willBook: !blocked.length && !taken.length,
      blockedBays: blocked,
      conflicts: taken.map((c) => ({ bayId: c.bay_id, bay: bayName(settings, c.bay_id) || c.bay_id, start: fmtMin(c.start_min), end: fmtMin(c.end_min) })),
      listCents: q.listTotalCents, amountCents: q.charge, memberPct: q.memberPct,
    });
    if (!blocked.length && !taken.length) { total += q.charge; listTotal += q.listTotalCents; }
  }
  res.status(200).json({
    ok: true,
    bays: d.bay_ids.map((id) => ({ id, name: bayName(settings, id) || id })),
    time: `${fmtMin(d.start_min)}–${fmtMin(d.end_min)}`,
    occurrences: out,
    bookable: out.filter((o) => o.willBook).length,
    blocked: out.filter((o) => !o.willBook).length,
    truncated: dates.length > MAX_PER_CALL,
    totalCents: total, listTotalCents: listTotal,
    memberPct: out.length ? out[0].memberPct : 0,
  });
}

// ----- create -------------------------------------------------------------------------------
//
// Writes the definition, then every occurrence up to the horizon. Each occurrence is independently
// atomic — all its bays or none of them — and independently reported: a Thursday that cannot be
// booked does not roll back the eleven that could, it lands in booking_series_exceptions with the
// reason and the bay that was in the way. Nothing is ever dropped without a row saying why.
async function create(req, res) {
  if (!(await staff(req, res, 'booking.write'))) return;
  const settingsRow = await getSettings();
  if (!settingsRow) return res.status(503).json({ ok: false, error: 'Database not configured.' });
  const settings = normalizeSettings(settingsRow);

  const v = readDefinition(req.body, settings);
  if (v.error) return res.status(400).json({ ok: false, error: v.error });
  const d = v.def;

  const created = await createSeries(d);
  if (created.unsupported) return res.status(503).json({ ok: false, code: 'schema', error: 'Group and repeat bookings aren’t switched on yet — apply migration 0023.' });
  if (created.invalid) return res.status(400).json({ ok: false, error: created.error });
  if (created.error) return res.status(500).json({ ok: false, error: created.error });

  const through = isDate(req.body && req.body.throughDate)
    ? req.body.throughDate : addDays(winnipegTodayISO(), HORIZON_DAYS);
  const run = await materialise(created.series, settings, {
    through,
    stripePaymentIntent: String((req.body && req.body.stripePaymentIntent) || '') || null,
    holdMinutes: Number(req.body && req.body.holdMinutes) || 0,
  });

  res.status(200).json({ ok: true, series: run.series, ...run.result });
}

// ----- the horizon pass ----------------------------------------------------------------------
//
// The one place occurrences become bookings. Called from create (write what is owed now) and from
// extend (write what has since come into range). Idempotent by construction: booking_series_
// occurrences() only returns a date as 'pending' when there is neither a group nor an exception
// for it, so running this twice writes nothing the second time.
//
// PRICING. Every occurrence is quoted separately, because a Thursday and a Saturday are not the
// same price, and each quote is one quoteGroup() call — which is one quoteBooking() call on the
// occurrence's total. The member discount applies to every occurrence (it is what the customer is
// paying a membership for). Loyalty points are retired, so nothing is spent on the first
// occurrence any more. Gift cards and promo codes are not applied at all here: both are reserved
// against a PaymentIntent by the checkout path, and there is no PaymentIntent in a manager-created
// group booking. Their absence is honest — the alternative is quoting a discount nothing ever
// deducts.
async function materialise(series, settings, { through, stripePaymentIntent = null, holdMinutes = 0 } = {}) {
  const dates = await seriesOccurrences(series.id, through);
  const owed = dates.filter((x) => x.state === 'pending');
  const pending = owed.slice(0, MAX_PER_CALL);
  const { cust, plan } = await payer({ email: series.customer_email, phone: series.customer_phone });
  const today = winnipegTodayISO();

  const booked = [], skipped = [];
  let first = true;
  for (const row of pending) {
    const dateISO = row.occurrence_date;

    // A date that has already gone by is recorded, not attempted — a series created today with a
    // start date last month should say "these four are in the past", not fail four inserts.
    if (dateISO < today) {
      await recordSeriesException({ seriesId: series.id, dateISO, kind: 'skipped', reason: 'past', detail: {} });
      skipped.push({ date: dateISO, reason: 'past', bays: [] });
      continue;
    }

    const { dateHours, blocked } = await venueBlocks(settings, dateISO, series.bay_ids, series.start_min, series.end_min);
    if (blocked.length) {
      await recordSeriesException({ seriesId: series.id, dateISO, kind: 'skipped', reason: 'closed', detail: { bays: blocked } });
      skipped.push({ date: dateISO, reason: 'closed', bays: blocked });
      continue;
    }

    const taken = await groupConflicts({ dateISO, bayIds: series.bay_ids, startMin: series.start_min, endMin: series.end_min });
    if (taken.length) {
      const bays = [...new Set(taken.map((c) => c.bay_id))];
      await recordSeriesException({
        seriesId: series.id, dateISO, kind: 'skipped', reason: 'conflict',
        detail: { bays, bookingIds: taken.map((c) => c.booking_id) },
      });
      skipped.push({ date: dateISO, reason: 'conflict', bays });
      continue;
    }

    const q = quoteGroup({
      settings, dateISO, bayIds: series.bay_ids, startMin: series.start_min, endMin: series.end_min, dateHours,
      plan, membershipExpires: cust && cust.membership_expires, todayISO: today,
    });

    const status = holdMinutes > 0 ? 'held' : 'confirmed';
    const expiresAt = holdMinutes > 0 ? new Date(Date.now() + holdMinutes * 60000).toISOString() : null;
    const wrote = await bookGroup({
      group: {
        series_id: series.id, occurrence_date: dateISO, booking_date: dateISO, seq: row.seq,
        start_min: series.start_min, end_min: series.end_min, status,
        players: series.players, list_price_cents: q.listTotalCents, amount_cents: q.charge,
        stripe_payment_intent: first ? stripePaymentIntent : null, note: series.note,
      },
      rows: q.bays.map((b) => ({
        bay_id: b.bayId, start_min: series.start_min, end_min: series.end_min, status,
        status_label: series.status_label, customer_name: series.customer_name,
        customer_email: series.customer_email, customer_phone: series.customer_phone,
        amount_cents: b.amountCents, source: series.source, note: series.note,
        expires_at: expiresAt,
        stripe_payment_intent: first ? stripePaymentIntent : null,
      })),
    });

    if (wrote.conflict) {
      // Lost a race between the advisory check above and the write. NOTHING landed — that is what
      // book_group() guarantees — so this is a skip like any other, with the bay that won recorded.
      await recordSeriesException({
        seriesId: series.id, dateISO, kind: 'skipped', reason: 'conflict', detail: { bays: [wrote.bay], race: true },
      });
      skipped.push({ date: dateISO, reason: 'conflict', bays: [wrote.bay] });
      continue;
    }
    if (wrote.error) {
      await recordSeriesException({ seriesId: series.id, dateISO, kind: 'skipped', reason: 'error', detail: { error: wrote.error } });
      skipped.push({ date: dateISO, reason: 'error', bays: [], error: wrote.error });
      continue;
    }

    booked.push({
      date: dateISO, seq: row.seq, groupId: wrote.groupId, bays: wrote.bays,
      amountCents: q.charge, listCents: q.listTotalCents,
    });
    first = false;
  }

  // The horizon only advances over dates this pass actually looked at. A capped pass must not
  // claim the whole window, or everything past MAX_PER_CALL would never be written at all — the
  // next call would see materialised_through beyond it and find nothing to do.
  const more = owed.length > MAX_PER_CALL;
  const reached = more ? pending[pending.length - 1].occurrence_date : through;
  const upd = await updateSeries(series.id, { materialised_through: reached, updated_at: new Date().toISOString() });

  return {
    series: (upd && upd.series) || { ...series, materialised_through: reached },
    result: {
      booked, skipped,
      bookedCount: booked.length, skippedCount: skipped.length,
      through: reached, more,
    },
  };
}

// ----- extend -------------------------------------------------------------------------------
//
// Push the horizon forward. `seriesId` for one, nothing for the sweep over every active series —
// which is what a pg_cron job calls. Authenticated by the manager session OR the cron secret, and
// refuses to run unauthenticated at all: this endpoint writes bookings.
async function extend(req, res) {
  if (!cronOk(req)) {
    if (!(req.headers && req.headers.authorization)) {
      const secret = process.env.SERIES_SWEEP_SECRET || process.env.WAITLIST_SWEEP_SECRET || '';
      if (!secret) console.warn('booking-series extend: no SERIES_SWEEP_SECRET set — refusing an unauthenticated horizon pass.');
      return res.status(secret ? 401 : 503).json({
        ok: false,
        error: secret ? 'Not authorised.' : 'Sign in, or set SERIES_SWEEP_SECRET before scheduling the horizon pass.',
      });
    }
    if (!(await staff(req, res, 'booking.write'))) return;
  }
  const settingsRow = await getSettings();
  if (!settingsRow) return res.status(503).json({ ok: false, error: 'Database not configured.' });
  const settings = normalizeSettings(settingsRow);

  const through = isDate(req.body && req.body.throughDate)
    ? req.body.throughDate : addDays(winnipegTodayISO(), HORIZON_DAYS);
  const id = (req.body && req.body.seriesId) || '';

  let list;
  if (id) {
    if (!isUuid(id)) return res.status(400).json({ ok: false, error: 'Invalid series id.' });
    const s = await seriesById(id);
    if (!s) return res.status(404).json({ ok: false, error: 'No such series.' });
    list = [s];
  } else {
    list = await seriesNeedingHorizon(through);
  }

  const runs = [];
  for (const s of list) {
    if (s.status !== 'active') continue;
    const run = await materialise(s, settings, { through });
    runs.push({ seriesId: s.id, label: s.label, ...run.result });
  }
  res.status(200).json({
    ok: true, through, series: runs.length,
    booked: runs.reduce((a, r) => a + r.bookedCount, 0),
    skipped: runs.reduce((a, r) => a + r.skippedCount, 0),
    runs,
  });
}

// ----- get ----------------------------------------------------------------------------------
async function getSeries(req, res) {
  if (!(await staff(req, res))) return;
  const id = (req.query && req.query.id) || '';
  if (!isUuid(id)) return res.status(400).json({ ok: false, error: 'Invalid series id.' });
  const s = await seriesById(id);
  if (!s) return res.status(404).json({ ok: false, error: 'No such series.' });
  const settings = normalizeSettings(await getSettings());
  const occ = await seriesOccurrences(id, (req.query && req.query.through) || null);
  res.status(200).json({
    ok: true,
    series: {
      id: s.id, label: s.label, freq: s.freq, intervalN: s.interval_n,
      startDate: s.start_date, untilDate: s.until_date, maxOccurrences: s.max_occurrences,
      bays: (s.bay_ids || []).map((b) => ({ id: b, name: bayName(settings, b) || b })),
      time: `${fmtMin(s.start_min)}–${fmtMin(s.end_min)}`,
      startMin: s.start_min, endMin: s.end_min, players: s.players,
      customerName: s.customer_name, customerEmail: s.customer_email, customerPhone: s.customer_phone,
      status: s.status, payMode: s.pay_mode, materialisedThrough: s.materialised_through, note: s.note,
    },
    occurrences: occ.map((o) => ({ date: o.occurrence_date, seq: o.seq, state: o.state, detail: o.detail })),
  });
}

// ----- cancel -------------------------------------------------------------------------------
//
// Cancels a whole occurrence, or named bays of it ("two of the six fell through"). The group row
// survives either way so the recurrence keeps its memory of that date and the horizon pass never
// re-creates it.
//
// ⚠ THE REFUND IS A NOTE, NOT A PAYMENT. `refund: true` writes rows to public.refunds and keeps
// refunded_cents in step — it does not call Stripe and does not credit a gift card.
// Migration 0023 section 5 says the same thing at more length. The response says
// `moneyMoved: false` on every refund it writes so a UI cannot accidentally tell a customer their
// money is on its way.
async function cancel(req, res) {
  const who = await staff(req, res, 'booking.write');
  if (!who) return;
  const b = req.body || {};
  // Checked before anything is cancelled, so a refused refund never leaves half a job done.
  if (b.refund && who.role !== 'admin' && !who.capabilities.includes('money.write')) return forbidden(res, 'money.write');
  const groupId = String(b.groupId || '');
  if (!isUuid(groupId)) return res.status(400).json({ ok: false, error: 'Invalid booking id.' });

  const bayIds = Array.isArray(b.bayIds) ? [...new Set(b.bayIds.filter(Boolean).map(String))] : null;
  const out = await cancelGroup({ groupId, bayIds, reason: String(b.reason || 'manager').slice(0, 120) });
  if (out.unsupported) return res.status(503).json({ ok: false, code: 'schema', error: 'Group bookings aren’t switched on yet — apply migration 0023.' });
  if (out.error) return res.status(out.error === 'not_found' ? 404 : 500).json({ ok: false, error: out.error });

  const refunds = [];
  if (b.refund) {
    for (const row of out.cancelled || []) {
      const owed = Math.max(0, (row.amountCents || 0) - (row.refundedCents || 0));
      if (!owed) continue;
      const r = await recordRefund({
        bookingId: row.id, groupId, amountCents: owed,
        reason: String(b.reason || 'cancellation').slice(0, 120),
        method: b.refundMethod === 'manual' ? 'manual' : 'stripe',
        ref: `cancel:${row.id}`, by: 'manager',
      });
      refunds.push({ bayId: row.bayId, amountCents: owed, ...r });
    }
  }

  // ⚠ A CANCELLED BOOKING THAT IS STILL HELD. Nothing above touches it: a hold has amount_cents 0,
  // so `owed` is zero and no refund note is written — correctly, because the customer was never
  // charged and there is nothing to refund. But the AUTHORISATION is still sitting on their card,
  // and left alone it stays there until it expires. It must be released.
  //
  // Releasing is a money.write act (it is the money side of this booking), and this action only
  // demands booking.write. So: a caller who has Money gets it done here and now; one who does not
  // gets the bookings named in `heldNeedingRelease` so the portal can say which ones still need
  // somebody with the permission to press Release. Nothing is silently left behind either way.
  const canRelease = who.role === 'admin' || who.capabilities.includes('money.write');
  const { enabled: stripeOn } = stripeStatus(process.env);
  const released = [], heldNeedingRelease = [];
  for (const row of out.cancelled || []) {
    const booking = await bookingForHold(row.id);
    if (!booking || booking.payment_state !== 'held') continue;
    if (!canRelease || !stripeOn) {
      heldNeedingRelease.push({ bookingId: row.id, bayId: row.bayId,
        authorizedCents: Math.max(0, Number(booking.authorized_cents) || 0),
        holdExpiresAt: booking.hold_expires_at || null });
      continue;
    }
    const r = await releaseAuthorisation({
      stripe: stripeClient(process.env), bookingId: row.id,
      reason: String(b.reason || 'cancelled by staff').slice(0, 120),
      by: (who.user && who.user.email) || 'manager',
    });
    released.push({ bookingId: row.id, bayId: row.bayId, ok: !!r.ok,
      releasedCents: r.releasedCents || 0, error: r.error });
  }

  res.status(200).json({
    ok: true,
    cancelled: out.cancelled, cancelledCount: out.cancelledCount,
    remaining: out.remaining, groupStatus: out.groupStatus,
    refundableCents: out.refundableCents,
    refunds,
    // Held bookings whose authorisation was cancelled here: the customer is never charged.
    released,
    // …and the ones this caller could not release, so they are chased rather than forgotten.
    heldNeedingRelease: heldNeedingRelease.length ? heldNeedingRelease : undefined,
    heldNote: heldNeedingRelease.length
      ? 'These bookings were only HELD, never charged, and the hold is still on the customer’s card. '
        + 'Someone with the Money permission needs to release them.'
      : undefined,
    // Said out loud, every time, because the alternative is a customer being told they have been
    // refunded by a system that has never issued a refund. Releases are a different thing and are
    // reported separately above — nothing was refunded there either, because nothing was charged.
    moneyMoved: false,
    refundNote: refunds.length
      ? 'Recorded what is owed. No money has moved — issue these refunds in Stripe.'
      : undefined,
  });
}

// ----- refund -------------------------------------------------------------------------------
//
// THE ONE THAT ACTUALLY MOVES MONEY. ?action=cancel above writes what is owed; this pays it.
//
//   POST /api/booking-series?action=refund
//   Authorization: Bearer <the manager's Supabase access token>
//   { "bookingId": "<uuid>", "amountCents": 2500, "reason": "cancelled by phone", "ref": "<uuid>" }
//
//   amountCents  optional — leave it out to refund everything still refundable on that booking.
//   ref          optional but recommended — the idempotency key. The SAME ref twice moves money
//                ONCE. Generate one per button press (crypto.randomUUID()) and reuse it on retry.
//                Omitted, it falls back to `refund:<bookingId>:<amountCents>`, which still stops a
//                double-click paying twice.
//
// money.write, not booking.write: this is the Money permission in migration 0024, the same one
// ?action=cancel demands before it will even write a refund NOTE. An employee who may cancel a
// booking still may not send the customer's money back unless an admin has turned Money on.
//
// The answer always carries `moneyMoved`. Never tell a customer they have been refunded on the
// strength of anything else.
async function refund(req, res) {
  const who = await staff(req, res, 'money.write');
  if (!who) return;

  const b = req.body || {};
  const bookingId = String(b.bookingId || b.id || '');
  if (!isUuid(bookingId)) return res.status(400).json({ ok: false, error: 'Which booking? Send a bookingId.' });

  let amountCents = null;
  if (b.amountCents != null && b.amountCents !== '') {
    amountCents = Math.round(Number(b.amountCents));
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ ok: false, error: 'Enter a refund amount greater than zero.' });
    }
  }

  // Stripe off (no keys, or a live key this prototype refuses to use) is a 503, not a silent
  // "recorded". Staff must not be told a refund is on its way when nothing can send it.
  const { enabled } = stripeStatus(process.env);
  if (!enabled) {
    return res.status(503).json({ ok: false, moneyMoved: false, code: 'stripe_off',
      error: 'Stripe is not configured on this deployment, so no refund can be sent. Set STRIPE_SECRET_KEY '
        + '(a test key with Refunds: write and Charges: read) and try again.' });
  }

  const out = await issueRefund({
    stripe: stripeClient(process.env),
    bookingId,
    amountCents,
    reason: b.reason || 'refunded by staff',
    ref: b.ref ? String(b.ref).slice(0, 120) : null,
    by: (who.user && who.user.email) || (who.staff && who.staff.email) || 'manager',
    note: b.note || null,
  });
  if (!out.ok) {
    return res.status(out.code || 400).json({
      ok: false, moneyMoved: false, code: out.reason, error: out.error,
      refundId: out.refundId, missingPermissions: out.missingPermissions,
      paidCents: out.paidCents, refundedCents: out.refundedCents, refundableCents: out.refundableCents,
    });
  }
  return res.status(200).json({
    ok: true,
    refundId: out.refundId,
    stripeRefundId: out.stripeRefundId || null,
    amountCents: out.amountCents,
    status: out.status,
    moneyMoved: !!out.moneyMoved,
    already: !!out.already,
    message: out.message,
    ledgerWarning: out.ledgerWarning,
  });
}

// ----- capture / release / holds: the card-hold desk (migration 0034) -------------------------
//
// A booking near enough to today is HELD, not charged: the card is authorised at checkout and
// captured by a human at check-in. Three things follow from that, and they are these three actions.
//
//   POST /api/booking-series?action=capture   { bookingId, amountCents?, note? }   money.write
//   POST /api/booking-series?action=release   { bookingId, reason? }               money.write
//   GET  /api/booking-series?action=holds                                          any staff login
//
// WHY THEY LIVE IN THIS FILE. Vercel's Hobby plan allows 12 Serverless Functions and api/ holds
// exactly 12 — a thirteenth file means the project stops deploying. And this is already the file
// that moves money (?action=refund), under the same staff gate and the same money.write rule, so
// capture and release belong beside it rather than beside the tee sheet. The logic itself is in
// lib/holds.js, the mirror of lib/refunds.js.
//
// money.write, not booking.write: this charges a customer's card, or lets go of the venue's claim
// on it. An employee who may move a booking still may not do either unless an admin has turned
// Money on. `holds` is a READ, so it takes any staff login, the same rule `get` and `preview` use.

// Capture a held booking — the check-in button. `amountCents` captures LESS than was authorised, for
// a session that ran short; leave it out for the whole hold.
//
// ⚠ A partial capture is FINAL: Stripe releases the rest and the same authorisation cannot be
// captured twice. lib/holds.js says so in the response so nobody learns it from a customer.
async function capture(req, res) {
  const who = await staff(req, res, 'money.write');
  if (!who) return;

  const b = req.body || {};
  const bookingId = String(b.bookingId || b.id || '');
  if (!isUuid(bookingId)) return res.status(400).json({ ok: false, error: 'Which booking? Send a bookingId.' });

  let amountCents = null;
  if (b.amountCents != null && b.amountCents !== '') {
    amountCents = Math.round(Number(b.amountCents));
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return res.status(400).json({ ok: false, error: 'Enter an amount greater than zero, or leave it out to capture the full hold.' });
    }
  }

  // Stripe off is a 503, not a silent "done" — the same rule ?action=refund applies. Staff must not
  // be told a card was charged when nothing could charge it.
  const { enabled } = stripeStatus(process.env);
  if (!enabled) {
    return res.status(503).json({ ok: false, moneyMoved: false, code: 'stripe_off',
      error: 'Stripe is not configured on this deployment, so no hold can be captured. Set STRIPE_SECRET_KEY and try again.' });
  }

  const out = await captureHold({
    stripe: stripeClient(process.env), bookingId, amountCents,
    by: (who.user && who.user.email) || (who.staff && who.staff.email) || 'manager',
    note: b.note || null,
  });
  if (!out.ok) {
    return res.status(out.code || 400).json({
      ok: false, moneyMoved: false, code: out.reason, error: out.error,
      paymentState: out.paymentState, holdExpiresAt: out.holdExpiresAt, authorizedCents: out.authorizedCents,
    });
  }
  return res.status(200).json({
    ok: true, moneyMoved: true, already: !!out.already,
    paymentState: out.paymentState, capturedCents: out.capturedCents,
    authorizedCents: out.authorizedCents, releasedCents: out.releasedCents || 0,
    message: out.message, ledgerWarning: out.ledgerWarning,
  });
}

// Let the hold go. The customer is never charged and nothing is recorded in public.refunds, because
// a release is NOT a refund — see the header of lib/holds.js.
async function release(req, res) {
  const who = await staff(req, res, 'money.write');
  if (!who) return;

  const b = req.body || {};
  const bookingId = String(b.bookingId || b.id || '');
  if (!isUuid(bookingId)) return res.status(400).json({ ok: false, error: 'Which booking? Send a bookingId.' });

  const { enabled } = stripeStatus(process.env);
  if (!enabled) {
    return res.status(503).json({ ok: false, moneyMoved: false, code: 'stripe_off',
      error: 'Stripe is not configured on this deployment, so no hold can be released. Set STRIPE_SECRET_KEY and try again.' });
  }

  const out = await releaseAuthorisation({
    stripe: stripeClient(process.env), bookingId,
    reason: b.reason ? String(b.reason).slice(0, 120) : null,
    by: (who.user && who.user.email) || (who.staff && who.staff.email) || 'manager',
  });
  if (!out.ok) {
    return res.status(out.code || 400).json({ ok: false, moneyMoved: false, code: out.reason,
      error: out.error, paymentState: out.paymentState });
  }
  return res.status(200).json({
    ok: true, moneyMoved: false, already: !!out.already,
    paymentState: out.paymentState, releasedCents: out.releasedCents || 0,
    message: out.message, ledgerWarning: out.ledgerWarning,
  });
}

// ⚠ THE LIST THAT STOPS HOLDS FROM QUIETLY EXPIRING.
//
// Staff chose MANUAL capture, so nothing captures a hold unless a person does. A hold nobody
// presses does not fail, does not error and does not appear anywhere — it simply lapses after about
// seven days and the money is gone. This is the query that makes those visible.
//
// SORT ON `holdExpiresAt` ASCENDING — it is already returned in that order. `hoursLeft` is the same
// fact in a form a row can print; `expired` is true once it is too late to capture at all, and
// those rows still belong on the list so somebody can release them and see what was lost.
async function holds(req, res) {
  if (!(await staff(req, res))) return;
  const settings = normalizeSettings(await getSettings());
  const out = await heldBookings({ limit: Math.min(500, Math.max(1, Number((req.query || {}).limit) || 200)) });
  if (out.unsupported) return res.status(503).json({ ok: false, code: 'schema', error: out.error });
  if (out.error) return res.status(500).json({ ok: false, error: out.error });

  const now = new Date();
  const rows = out.rows.map((r) => ({
    ...holdView(r, now),
    bay: bayName(settings, r.bay_id) || r.bay_id,
    bayId: r.bay_id,
    bookingDate: r.booking_date,
    start: fmtMin(r.start_min), end: fmtMin(r.end_min),
    customerName: r.customer_name || null,
    customerEmail: r.customer_email || null,
    customerPhone: r.customer_phone || null,
    stripePaymentIntent: r.stripe_payment_intent || null,
    // A session that has already started and is still only held: the customer either checked in and
    // nobody pressed Capture, or they never came. Either way it is a decision somebody owes.
    noShow: hoursUntilBooking(r.booking_date, r.start_min, now) < 0,
  }));
  return res.status(200).json({
    ok: true,
    sortField: 'holdExpiresAt',
    holds: rows,
    expiringCents: rows.filter((r) => !r.expired).reduce((a, r) => a + r.authorizedCents, 0),
    expiredCents: rows.filter((r) => r.expired).reduce((a, r) => a + r.authorizedCents, 0),
    cutoffDays: settings.hold.cutoffDays,
    authWindowDays: settings.hold.authWindowDays,
  });
}

// ----- end ----------------------------------------------------------------------------------
//
// Stop a recurrence. Everything still ahead is cancelled; what has already been played is left
// exactly as it is. The series is marked 'ended' so the horizon pass stops picking it up.
async function end(req, res) {
  if (!(await staff(req, res, 'booking.write'))) return;
  const b = req.body || {};
  const id = String(b.seriesId || '');
  if (!isUuid(id)) return res.status(400).json({ ok: false, error: 'Invalid series id.' });
  const s = await seriesById(id);
  if (!s) return res.status(404).json({ ok: false, error: 'No such series.' });

  const from = isDate(b.fromDate) ? b.fromDate : winnipegTodayISO();
  const occ = await seriesOccurrences(id, s.until_date || s.materialised_through);
  const ahead = occ.filter((o) => o.state === 'booked' && o.occurrence_date >= from && o.detail && o.detail.groupId);

  const cancelled = [];
  for (const o of ahead) {
    const out = await cancelGroup({ groupId: o.detail.groupId, bayIds: null, reason: 'series ended' });
    if (out && out.ok) cancelled.push({ date: o.occurrence_date, groupId: o.detail.groupId, refundableCents: out.refundableCents });
  }
  await updateSeries(id, { status: 'ended', updated_at: new Date().toISOString() });

  res.status(200).json({
    ok: true, seriesId: id, cancelled, cancelledCount: cancelled.length,
    refundableCents: cancelled.reduce((a, c) => a + (c.refundableCents || 0), 0),
    moneyMoved: false,
    refundNote: cancelled.length ? 'Nothing has been refunded — record refunds per occurrence with ?action=cancel&refund=true, then issue them in Stripe.' : undefined,
  });
}

// ----- move ---------------------------------------------------------------------------------
//
// One occurrence, somewhere else. All its bays move together or none of them do (move_group() has
// the same all-or-nothing shape as book_group), the recurrence date it belongs to is untouched, and
// the move is written to booking_series_exceptions so the horizon pass knows this week happened.
async function move(req, res) {
  if (!(await staff(req, res, 'booking.write'))) return;
  const b = req.body || {};
  const groupId = String(b.groupId || '');
  if (!isUuid(groupId)) return res.status(400).json({ ok: false, error: 'Invalid booking id.' });

  const g = await groupById(groupId);
  if (!g) return res.status(404).json({ ok: false, error: 'No such booking.' });

  const dateISO = isDate(b.dateISO) ? b.dateISO : g.booking_date;
  if (dateISO < winnipegTodayISO()) return res.status(400).json({ ok: false, error: 'That date has already passed.' });
  const startMin = b.startMin == null ? g.start_min : Math.round(Number(b.startMin));
  const endMin = b.endMin == null ? g.end_min : Math.round(Number(b.endMin));
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
    return res.status(400).json({ ok: false, error: 'Give a start and end time, with the end after the start.' });
  }

  const settings = normalizeSettings(await getSettings());
  const bayMap = b.bayMap && typeof b.bayMap === 'object' ? b.bayMap : null;
  const bays = (g.bookings || []).filter((x) => x.status !== 'cancelled')
    .map((x) => String((bayMap && bayMap[x.bay_id]) || x.bay_id));

  const { blocked } = await venueBlocks(settings, dateISO, bays, startMin, endMin);
  if (blocked.length) {
    return res.status(409).json({ ok: false, error: `We’re closed for ${blocked.map((x) => bayName(settings, x) || x).join(', ')} then.` });
  }
  const taken = await groupConflicts({ dateISO, bayIds: bays, startMin, endMin, ignoreGroupId: groupId });
  if (taken.length) {
    return res.status(409).json({
      ok: false, code: 'conflict',
      error: `${bayName(settings, taken[0].bay_id) || taken[0].bay_id} is already booked then.`,
      conflicts: taken.map((c) => ({ bayId: c.bay_id, start: fmtMin(c.start_min), end: fmtMin(c.end_min) })),
    });
  }

  const out = await moveGroup({ groupId, dateISO, startMin, endMin, bayMap, reason: String(b.reason || 'manager').slice(0, 120) });
  if (out.unsupported) return res.status(503).json({ ok: false, code: 'schema', error: 'Group bookings aren’t switched on yet — apply migration 0023.' });
  if (out.conflict) return res.status(409).json({ ok: false, code: 'conflict', error: `${bayName(settings, out.bay) || out.bay} was just taken — nothing was moved.` });
  if (out.error) return res.status(out.error === 'not_found' ? 404 : 400).json({ ok: false, error: out.error });

  // The price is not re-quoted on a move. A Thursday-to-Saturday move changes the rate band, and
  // silently re-charging (or silently refunding) a customer because a manager dragged a booking is
  // not a decision to take without asking. The response says what the new list price would be so
  // the portal can offer the choice.
  const q = quoteGroup({
    settings, dateISO, bayIds: bays, startMin, endMin,
    plan: null, todayISO: winnipegTodayISO(),
  });
  res.status(200).json({
    ok: true, ...out,
    paidCents: g.amount_cents,
    newListCents: q.listTotalCents,
    repriced: false,
  });
}
