// Shared booking/pricing logic + Stripe key helpers.
// Used by both the local Express server (server.js) and the Vercel functions (api/*).
// The browser never sets the price — it's always recomputed here from saved settings.

import Stripe from 'stripe';

// Defaults used when the database isn't configured yet (keeps the demo working standalone).
// Invictus Golf's real bays, as listed on their GolfBook sheet.
const DEFAULT_BAYS = [
  { id: 'B1', name: 'Assiniboine Credit Union Bay #1', sim: 'Golfzon TwoVision', description: 'Right hand only' },
  { id: 'B2', name: 'Birchwood Bay #2', sim: 'Golfzon TwoVision' },
  { id: 'B3', name: 'Manitopia Realty Bay #3', sim: 'Golfzon TwoVision' },
  { id: 'B4', name: 'Public Bay #4', sim: 'Golfzon TwoVision', description: 'Flat base' },
  { id: 'B5', name: 'McNaught Private Room #1', sim: 'Golfzon TwoVision', description: 'Private room' },
  { id: 'B6', name: 'Private Room #2', sim: 'Golfzon TwoVision', description: 'Private room' },
];

// The card-hold cut-off. Declared up here only because DEFAULT_SETTINGS below is built from it —
// the reasoning, which is the part that matters, is under "Card holds" further down.
export const HOLD_DEFAULTS = {
  cutoffDays: 5,        // session starts within this many days → hold it. Further ahead → charge now.
  authWindowDays: 7,    // what Stripe documents an online card authorisation survives
};

export const DEFAULT_SETTINGS = {
  bays: DEFAULT_BAYS,
  // Invictus Golf is open 24 hours, every day.
  hours: { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] },
  slotStep: 30,
  minMins: 60,
  maxParty: 4,
  peakStartHour: 17,
  // Invictus charges CA$20/hour Mon–Thu and CA$25/hour Fri–Sun (invictusgolfwpg.ca).
  // There is no evening peak rate, so the peak and off-peak bands are equal.
  rates: { weekdayOffPeak: 20, weekdayPeak: 20, weekendOffPeak: 25, weekendPeak: 25 },
  bayRates: {},   // { bayId: {weekdayOffPeak,weekdayPeak,weekendOffPeak,weekendPeak,peakStartHour} }
  weeklyStatus: {},   // { weekday: [ band, … ] } — recurring tee-sheet status pattern (see weeklyStatusAt)
  onlineStatusLabel: 'Booked',   // workflow status stamped on a customer's own online booking
  pay: {},
  hold: holdSettings(null),      // hold near sessions, charge far ones — see "Card holds" below
  currency: 'cad',
};

// Placeholder catalogue shown on the public /hours page while Supabase is not configured, so the
// demo has something to show. These are NOT written anywhere — the moment the database is connected
// and seeded, the real rows take over and these stop being served. Purchase is blocked without a
// database (see the list handler in api/hour-cards.js).
export const DEMO_HOUR_CARDS = [
  { id: 'demo-5h',  name: '5-Hour Card',  hours: 5,  price_cents: 13500, color: '#4AA3FF', sort: 1 },
  { id: 'demo-10h', name: '10-Hour Card', hours: 10, price_cents: 25000, color: '#067647', sort: 2 },
  { id: 'demo-20h', name: '20-Hour Card', hours: 20, price_cents: 46000, color: '#F0523D', sort: 3 },
];

// Turn a raw `settings` DB row into the normalized shape used everywhere (and sent to the browser).
// The rates object is passed through as-stored so time-block bands survive; only defaults are backfilled.
export function normalizeSettings(row) {
  if (!row) return DEFAULT_SETTINGS;
  return {
    bays: Array.isArray(row.bays) ? row.bays : DEFAULT_SETTINGS.bays,
    hours: row.hours || DEFAULT_SETTINGS.hours,
    slotStep: row.slot_step ?? 30,
    minMins: row.min_mins ?? 60,
    maxParty: row.max_party ?? 4,
    peakStartHour: (row.rates && row.rates.peakStartHour) ?? 17,
    rates: (row.rates && typeof row.rates === 'object') ? row.rates : DEFAULT_SETTINGS.rates,
    bayRates: (row.bay_rates && typeof row.bay_rates === 'object') ? row.bay_rates : {},
    weeklyStatus: (row.weekly_status && typeof row.weekly_status === 'object') ? row.weekly_status : {},
    onlineStatusLabel: row.online_status_label || 'Booked',
    bookingWindow: bookingWindowDays(row.booking_window),
    // settings.pay is where payment settings live (migration 0003). `hold` is that same jsonb read
    // through holdSettings() so every caller asks the hold question the same way — see below.
    pay: (row.pay && typeof row.pay === 'object') ? row.pay : {},
    hold: holdSettings(row.pay),
    currency: 'cad',
  };
}

// ----- How far ahead a customer may book online (migration 0028) -----
// Regular players get regularDays, anyone on a current league roster gets leagueDays. Staff bookings
// on the tee sheet are never limited. Defaults apply until the settings row carries its own.
export const BOOKING_WINDOW_DEFAULTS = { regularDays: 10, leagueDays: 60 };
export function bookingWindowDays(raw) {
  const w = (raw && typeof raw === 'object') ? raw : {};
  const days = (v, d) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    regularDays: days(w.regularDays, BOOKING_WINDOW_DEFAULTS.regularDays),
    leagueDays: days(w.leagueDays, BOOKING_WINDOW_DEFAULTS.leagueDays),
  };
}

// The error a customer sees when dateISO is past their window, or null when it is fine.
// `league` is whether they are on a current league roster (lib/db.js isLeaguePlayer).
export function bookingWindowError({ settings, dateISO, league, todayISO = winnipegTodayISO() }) {
  const w = (settings && settings.bookingWindow) || BOOKING_WINDOW_DEFAULTS;
  const days = league ? w.leagueDays : w.regularDays;
  const last = new Date(`${todayISO}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() + days);
  const lastISO = last.toISOString().slice(0, 10);
  // Anything that is not a real YYYY-MM-DD is refused here, so a malformed date can never be
  // "not past the window" simply because the comparison could not be made.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ''))) return 'Pick a date on the calendar first.';
  if (dateISO <= lastISO) return null;
  return league
    ? `League players can book up to ${days} days ahead — pick a date on or before ${lastISO}.`
    : `Bookings open ${days} days ahead — pick a date on or before ${lastISO}. League players: sign in to My Account to book further ahead.`;
}

// ----- Card holds: authorise now, capture at check-in (migration 0034) -----
//
// THE PORTAL'S PAYMENT SETTINGS SCREEN HAS ALWAYS SAID "Capture method: Credit Card Hold" and
// nothing read it — every booking was captured the instant it was paid, because no capture_method
// was sent and Stripe's default is `automatic`. This is what makes that screen true.
//
// THE CONSTRAINT THAT DECIDES EVERYTHING. A card authorisation is not permanent. Stripe documents
// the validity windows at docs.stripe.com/payments/place-a-hold-on-a-payment-method, and for an
// ONLINE (card-not-present) customer-initiated payment they are:
//
//     Visa 7 days (5 days — exactly 4d18h — when the network reads it as merchant-initiated)
//     Mastercard 7 · American Express 7 · Discover 7
//
// When the window passes, "the funds are released and the payment status changes to `canceled`".
// There is no recovering it: the money was never taken, and the card is gone. So a booking FURTHER
// AHEAD than an authorisation can survive must be CHARGED IN FULL at booking, exactly as every
// booking is today. With a 10-day window for everyone and 60 days for league players, that is a
// large minority of bookings, and getting it wrong means uncollectable sessions, not a bug report.
//
// WHY THE DEFAULT CUT-OFF IS 5 DAYS AND NOT 7. Three margins, all of them real:
//   · 7 is the documented ceiling for the best case. Visa's merchant-initiated window is 4d18h, and
//     Stripe warns the NETWORK decides which window applies, from signals, not from our API call.
//   · issuers are allowed to release a hold early, and some do.
//   · staff chose MANUAL capture, so a human presses the button. A no-show that needs a decision on
//     Monday must not have expired over the weekend.
// Five days leaves roughly two days of slack past the session for that decision. It is a SETTING,
// not a constant: settings.pay.hold.cutoffDays moves it without a deploy. (HOLD_DEFAULTS itself is
// declared at the top of this file, because DEFAULT_SETTINGS is built from it.)
//
// The hold rules, read out of the `pay` jsonb the Payment Settings screen writes.
//   pay.captureMethod       the existing dropdown: 'Credit Card Hold' | 'Payment Upfront' | 'No Payment'
//   pay.hold.cutoffDays     hold/charge cut-off, in days ahead of the session
//   pay.hold.authWindowDays how long an authorisation is assumed to last when Stripe has not said
// Anything missing or nonsense falls back to the defaults above, and cutoffDays is never allowed to
// exceed authWindowDays — a cut-off past the expiry is the one setting that loses money silently.
export function holdSettings(pay) {
  const p = (pay && typeof pay === 'object') ? pay : {};
  const h = (p.hold && typeof p.hold === 'object') ? p.hold : {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const authWindowDays = num(h.authWindowDays, HOLD_DEFAULTS.authWindowDays);
  const cutoffDays = Math.min(num(h.cutoffDays, HOLD_DEFAULTS.cutoffDays), authWindowDays);
  return {
    // 'Payment Upfront' and 'No Payment' both mean "do not hold". Only the dropdown's own
    // "Credit Card Hold" turns authorisation on, so the screen reads as what actually happens.
    enabled: String(p.captureMethod || 'Credit Card Hold') === 'Credit Card Hold',
    captureMethod: String(p.captureMethod || 'Credit Card Hold'),
    cutoffDays, authWindowDays,
  };
}

// Hold or charge, for ONE booking — and everything the customer must be told BEFORE they confirm.
//
//   mode           'hold'   → authorise only; staff capture at check-in
//                  'charge' → taken in full at booking, exactly as today
//   captureMethod  what goes on the PaymentIntent: 'manual' for a hold. For a charge nothing is
//                  sent at all, because Stripe's default already is `automatic`.
//   holdExpiresAt  when the authorisation dies if nobody captures it. THIS is the deadline staff
//                  chase, and it runs from the moment of BOOKING, not from the session.
export function holdPlan({ settings, dateISO, startMin, now = new Date() } = {}) {
  const rules = (settings && settings.hold) || holdSettings(settings && settings.pay);
  const hoursAhead = (/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || '')) && Number.isFinite(Number(startMin)))
    ? hoursUntilBooking(dateISO, Number(startMin), now)
    : 0;
  const withinCutoff = hoursAhead <= rules.cutoffDays * 24;
  const mode = (rules.enabled && withinCutoff) ? 'hold' : 'charge';
  const holdExpiresAt = mode === 'hold'
    ? new Date(now.getTime() + rules.authWindowDays * 86400000).toISOString()
    : null;
  return {
    mode,
    captureMethod: mode === 'hold' ? 'manual' : 'automatic',
    holdExpiresAt,
    captureBy: holdExpiresAt,
    hoursAhead,
    daysAhead: hoursAhead / 24,
    cutoffDays: rules.cutoffDays,
    authWindowDays: rules.authWindowDays,
    // Why, in words that can go on the checkout screen before the customer presses pay.
    message: mode === 'hold'
      ? 'Your card is held, not charged. We take the payment when you check in, and if you cancel in '
        + 'time the hold is released and nothing ever leaves your account.'
      : `This session is more than ${rules.cutoffDays} days away — longer than a card hold can last — `
        + 'so your card is charged in full now. Cancel at least 24 hours ahead for a full refund.',
  };
}

// When a card authorisation actually expires, straight from Stripe when Stripe knows. The charge's
// payment_method_details.card.capture_before is the network's own deadline and beats any guess made
// here; `fallback` (booking time + authWindowDays) is used only until that field exists.
export function holdExpiryFrom(charge, fallback = null) {
  const secs = charge && charge.payment_method_details && charge.payment_method_details.card
    && charge.payment_method_details.card.capture_before;
  if (Number.isFinite(Number(secs)) && Number(secs) > 0) return new Date(Number(secs) * 1000).toISOString();
  return fallback;
}

// ----- Loyalty points: RETIRED -----
// The venue does not run a points programme. Retired the same way memberships were in migration
// 0028: customers.points_balance, point_transactions, adjust_points() and settings.points are all
// LEFT IN PLACE in the database — nothing is dropped and no history is deleted — but no code path
// earns, redeems, quotes or adjusts points any more, and nothing is offered at checkout.
// quoteBooking below still returns zeroed pointsUsed / pointsDiscountCents / pointsBlocked fields
// so callers that read them keep working.

// ----- Membership discount -----
// A plan's percentage off a session. Returns 0 for no membership, an unknown plan, or one that
// lapsed on or before today — a member who stops paying stops getting the discount.
export function memberDiscountPct(plan, membershipExpires, todayISO) {
  if (!plan) return 0;
  if (membershipExpires && todayISO && String(membershipExpires) < String(todayISO)) return 0;
  const pct = Number(plan.discount_pct) || 0;
  return Math.min(Math.max(pct, 0), 100);
}

// The whole "what does this customer pay" calculation, in ONE place so the Express server and
// the Vercel functions cannot drift apart. Every path that decides what a customer is charged
// calls this — extend it, never fork it.
//
// THE WATERFALL, in order, and why that order:
//
//   base (priceForBooking)
//     → membership %       a price reduction: the member's rate IS the price
//     → promo (% then $)   a price reduction
//     → floor at 0         never go negative before stored value is spent
//     → gift card          stored value: permanent liability, transferable, legally owed
//     → Stripe             what is left on the card (≥ 50¢, or a zero-charge booking path)
//
// Price reductions come first because they change what the session costs; stored value then buys
// what is left. Loyalty points used to sit between the floor and the gift card; they are retired
// (see the note above) and that stage is simply gone — every other stage is unchanged.
//
// PROMO CODES sit where the note above always said they would: straight after the membership
// percentage, before the floor. Pass the whole `promo` row (from lib/db.js promoByCode) rather
// than a pre-computed number — the amount, the restrictions and the two stacking flags are all
// properties of that row, and computing the discount anywhere but here would be a second pricing
// path. `promoContext` carries what the restrictions are checked against (the slot, the plan).
//
// STACKING. Migration 0021 gives each code two flags. Only stacks_with_membership is enforced
// here now, so every booking path agrees. The rule, in one sentence: the benefit the customer
// already owns beats the one they just typed.
//   · stacks_with_membership = false, and this customer has a live member discount
//       → the PROMO is dropped (quote reports promoBlocked: 'membership'). The membership is
//         paid for and already advertised; silently withdrawing it to honour a marketing code
//         would take away something the customer bought.
//   · stacks_with_points is NOT consulted any more. It stayed a column on promo_codes (0021) so
//     no data is lost, but with points retired there is nothing for it to block, and reading it
//     would be the one place a retired feature still changed a price.
export function quoteBooking({
  settings, amountCents, plan, membershipExpires, todayISO,
  giftBalanceCents = 0, applyGift = false, giftPartialOnly = true,
  promo = null, promoContext = null,
}) {
  const fullAmount = Math.max(0, Math.round(Number(amountCents) || 0));
  const memberPct = memberDiscountPct(plan, membershipExpires, todayISO);
  const memberDiscountCents = Math.round(fullAmount * memberPct / 100);
  let charge = Math.max(0, fullAmount - memberDiscountCents);

  // Promo: a price reduction, taken off the post-membership subtotal (which is also what
  // min_subtotal_cents is measured against — a member cannot clear a threshold they never paid).
  // promoApplies() decides yes/no; promoDiscountFor() decides how much. Floor at 0 straight after.
  let promoCode = null, promoDiscountCents = 0, promoBlocked = null;
  if (promo) {
    const gate = promoApplies(promo, { ...(promoContext || {}), memberPct, subtotalCents: charge });
    if (!gate.ok) {
      promoBlocked = gate.reason;
    } else {
      promoDiscountCents = promoDiscountFor(promo, charge);
      promoCode = promo.code || null;
      charge = Math.max(0, charge - promoDiscountCents);
    }
  }

  // Gift card last, and now the only stored value in the waterfall. giftPartialOnly defaults to
  // true because this is the card path: a charge must remain for Stripe (50¢ minimum), so a card
  // big enough to cover everything still leaves 50¢ rather than producing a PaymentIntent Stripe
  // will reject. Pass giftPartialOnly:false on a zero-charge booking path, where a card that
  // covers the whole session should cover the whole session and no payment is created at all.
  let giftUsedCents = 0, giftFullCover = false;
  if (applyGift) {
    const bal = Math.max(0, Math.round(Number(giftBalanceCents) || 0));
    const spendable = giftPartialOnly ? Math.max(0, charge - 50) : charge;
    giftUsedCents = Math.min(bal, spendable);
    charge -= giftUsedCents;
    giftFullCover = charge === 0 && giftUsedCents > 0;
  }

  return {
    fullAmount, memberPct, memberDiscountCents,
    promoCode, promoDiscountCents, promoBlocked,
    // Points are retired. These three are kept, permanently zeroed, so any caller still reading
    // them gets "no points applied" rather than undefined. Nothing sets them any more.
    pointsUsed: 0, pointsDiscountCents: 0, pointsBlocked: null,
    giftUsedCents, giftFullCover,
    charge,
  };
}

export function bayName(settings, id) {
  return (settings.bays.find((b) => b.id === id) || {}).name;
}

// Normalize any rate object into time bands: [{ start: hour, wd: weekday$, we: weekend$ }, …] sorted by start.
// A legacy 2-tier rate (off-peak / peak) becomes two bands so old data keeps working with no migration.
export function bandsOf(r) {
  if (r && Array.isArray(r.bands) && r.bands.length) {
    return r.bands
      .map((b) => ({ start: Math.max(0, Math.min(23, Math.round(Number(b.start) || 0))), wd: Number(b.wd) || 0, we: Number(b.we) || 0 }))
      .sort((a, b) => a.start - b.start);
  }
  const peak = r && r.peakStartHour != null ? Number(r.peakStartHour) : 17;
  return [
    { start: 0, wd: (r && r.weekdayOffPeak) ?? 25, we: (r && r.weekendOffPeak) ?? 30 },
    { start: peak, wd: (r && r.weekdayPeak) ?? 32, we: (r && r.weekendPeak) ?? 36 },
  ].sort((a, b) => a.start - b.start);
}

// The $/hr for an hour: the band with the greatest start ≤ hour (falls back to the first band).
export function rateFromBands(bands, weekend, hour) {
  let band = bands[0];
  for (const b of bands) { if (b.start <= hour) band = b; else break; }
  return weekend ? band.we : band.wd;
}

// Invictus's higher rate runs Friday–Sunday, so Friday (5) prices as "weekend" too. The
// stored rate fields keep their weekdayX/weekendX names — only which days they cover changes.
// Mirrored in demo/index.html and demo/admin.html, which carry their own copies of this.
export function rateFor(settings, weekday, hour, bayId) {
  const weekend = weekday === 0 || weekday === 5 || weekday === 6;
  const r = (bayId && settings.bayRates && settings.bayRates[bayId]) || settings.rates;
  return rateFromBands(bandsOf(r), weekend, hour);
}

// Resolve a date's schedule overrides into (a) venue-wide hour changes and
// (b) per-bay blocked time ranges. bay_ids empty/null on an override = all bays.
export function overrideEffects(overrides, settings, dateISO) {
  let venueClosed = false, venueHours = null;   // resolved: a closure always wins over special hours
  const blocked = {};             // { bayId: [[startMin, endMin], …] }
  // Why each block exists, for the ones staff chose to explain (0032 public_reason). Same shape as
  // `blocked` so a caller can line them up, and deliberately separate so nothing that only reads
  // `blocked` starts leaking a reason it never asked for.
  const reasons = {};             // { bayId: [[startMin, endMin, reason], …] }
  let closedReason = null;        // the venue-wide closure's reason, when it is a public one
  let hoursReason = null;         // …and for a day whose HOURS were changed rather than closed
  // The text staff type lives in schedule_overrides.note — there has never been a `reason` column
  // (migration 0001 created `note`; 0007's header calls it "a reason", which is what misled the
  // first version of this code into reading o.reason and silently finding nothing).
  const publicReason = (o) => (o.public_reason === false ? null : String(o.note || o.reason || '').trim() || null);
  const note = (id, s, e, o) => { const r = publicReason(o); if (r) (reasons[id] ||= []).push([s, e, r]); };
  const realIds = settings.bays.filter((b) => !b.holding).map((b) => b.id);
  for (const o of overrides || []) {
    const bays = (o.bay_ids && o.bay_ids.length) ? o.bay_ids : null;
    if (o.start_min == null) {
      if (!bays) {
        if (o.is_closed) { venueClosed = true; closedReason = publicReason(o) || closedReason; }
        // Latest special-hours row wins — and its reason travels with it, so a customer seeing a
        // short day is told why instead of guessing.
        else { venueHours = [o.open_hour ?? 0, o.close_hour ?? 0]; hoursReason = publicReason(o); }
      }
      else if (o.is_closed) for (const id of bays) { (blocked[id] ||= []).push([0, 24 * 60]); note(id, 0, 24 * 60, o); }
    } else {
      // An "Open" schedule status (Happy Hour, Open Prime Rate…) colours the tee sheet but must
      // never block online booking — skip it here so those slots stay bookable.
      if (o.status_open) continue;
      // A timed block applies to its time window on EVERY day in the range — "Jul 15–17,
      // 11 AM–7 PM" blocks 11–7 on each of the three days (how managers set up multi-day events).
      const s = Number(o.start_min);
      const e = Number(o.end_min);
      if (e > s) for (const id of (bays || realIds)) { (blocked[id] ||= []).push([s, e]); note(id, s, e, o); }
    }
  }
  const dateHours = venueClosed ? [0, 0] : venueHours;
  return { dateHours, blocked, reasons, closedReason, hoursReason: venueClosed ? null : hoursReason };
}

// True when a requested slot collides with an override (used to refuse payment for blocked time).
export function overrideConflicts(effects, settings, dateISO, bayId, startMin, endMin) {
  if (effects.dateHours) {
    const [o, c] = effects.dateHours;
    if (!(c > o) || startMin < o * 60 || endMin > c * 60) return true;
  }
  return (effects.blocked[bayId] || []).some(([s, e]) => startMin < e && endMin > s);
}

// ---- Weekly tee-sheet status pattern --------------------------------------
// settings.weeklyStatus is keyed by weekday (0=Sun … 6=Sat). Each value is an ordered
// list of bands that "paint" the tee sheet for every day of that weekday. A band with
// `full:true` covers the whole day + all bays (the weekday's default); other bands carry
// start/end minutes (and an optional bays[]) so a manager can vary within a day. Later
// bands win over earlier ones, so a Happy-Hour band layered after the default "Open" base
// takes effect for its window. Each band denormalises the status it points at:
//   { statusId, label, color, open, full?, start?, end?, bays? }
// `open:false` means the slot is closed (unbookable, no price on the sheet).
export function weeklyBandsForWeekday(settings, weekday) {
  const ws = settings.weeklyStatus || {};
  const bands = ws[weekday] ?? ws[String(weekday)] ?? [];
  return Array.isArray(bands) ? bands : [];
}

// Effective weekly status for a bay at a given minute — or null when nothing applies
// (the implicit default: Open, bookable, priced).
export function weeklyStatusAt(settings, weekday, bayId, minute) {
  let hit = null;
  for (const b of weeklyBandsForWeekday(settings, weekday)) {
    const bays = Array.isArray(b.bays) && b.bays.length ? b.bays : null;
    if (bays && !bays.includes(bayId)) continue;
    const s = b.full ? 0 : Number(b.start);
    const e = b.full ? 24 * 60 : Number(b.end);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (minute >= s && minute < e) hit = b;      // last matching band wins
  }
  if (!hit) return null;
  return { label: hit.label || '', color: hit.color || null, open: hit.open !== false };
}

// Does a date-specific "Open" status override (status_open=true) cover this cell?
// Such an override re-opens a slot the weekly pattern would otherwise close ("may vary").
function dateOpenStatusCovers(overrides, dateISO, bayId, minute) {
  for (const o of overrides || []) {
    if (!o.status_open) continue;
    const bays = (o.bay_ids && o.bay_ids.length) ? o.bay_ids : null;
    if (bays && !bays.includes(bayId)) continue;
    if (o.start_min == null) return true;
    const first = dateISO === o.override_date;
    const last = dateISO === (o.end_date || o.override_date);
    const s = first ? Number(o.start_min) : 0;
    const e = last ? Number(o.end_min) : 24 * 60;
    if (minute >= s && minute < e) return true;
  }
  return false;
}

// Per-bay blocked [start,end] ranges coming from Closed weekly-pattern bands, for a date.
// A cell re-opened by a date-specific Open status override is left bookable.
export function weeklyStatusBlocked(settings, overrides, dateISO) {
  const date = new Date(dateISO + 'T00:00:00');
  if (Number.isNaN(date.getTime())) return {};
  const weekday = date.getDay();
  const step = settings.slotStep || 30;
  const realIds = settings.bays.filter((b) => !b.holding).map((b) => b.id);
  const [open, close] = settings.hours[weekday] || [0, 0];
  const blocked = {};
  if (!(close > open)) return blocked;
  for (const id of realIds) {
    let runStart = null;
    for (let m = open * 60; m < close * 60; m += step) {
      const st = weeklyStatusAt(settings, weekday, id, m);
      const closed = st && !st.open && !dateOpenStatusCovers(overrides, dateISO, id, m);
      if (closed && runStart == null) runStart = m;
      if (!closed && runStart != null) { (blocked[id] ||= []).push([runStart, m]); runStart = null; }
    }
    if (runStart != null) (blocked[id] ||= []).push([runStart, close * 60]);
  }
  return blocked;
}

// True when [startMin,endMin) collides with a Closed weekly band (used to refuse payment).
export function weeklyStatusConflicts(settings, overrides, dateISO, bayId, startMin, endMin) {
  const ranges = weeklyStatusBlocked(settings, overrides, dateISO)[bayId] || [];
  return ranges.some(([s, e]) => startMin < e && endMin > s);
}

// Wall-clock hours from now (America/Winnipeg) until a booking's start time.
// Used for the customer cancellation policy (must cancel ≥ 24h before tee time).
// `now` exists so the hold/charge cut-off can be tested at an exact instant; every caller that
// means "right now" leaves it out and nothing about the answer changes.
export function hoursUntilBooking(dateISO, startMin, now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Winnipeg', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const nowMs = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? 0 : p.hour), +p.minute);
  const [y, mo, d] = dateISO.split('-').map(Number);
  const startMs = Date.UTC(y, mo - 1, d, Math.floor(startMin / 60), startMin % 60);
  return (startMs - nowMs) / 3600000;
}

// Today's date (YYYY-MM-DD) in America/Winnipeg — TZ-safe even on UTC servers.
export function winnipegTodayISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Winnipeg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Validate the requested slot against saved settings and return the price in cents. Throws if invalid.
// dateHours (optional) is the effective open/close for the date from a venue-wide override — when
// present it replaces the weekly template so special-hours slots are priceable.
export function priceForBooking({ settings = DEFAULT_SETTINGS, dateISO, bayId, startMin, endMin, dateHours }) {
  if (!bayName(settings, bayId)) throw new Error('Unknown bay');
  // Strict YYYY-MM-DD. new Date('2027T00:00:00') would happily parse, and that is how a date
  // like "2027" once slipped past the advance-booking window.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ''))) throw new Error('Bad date');
  const date = new Date(dateISO + 'T00:00:00');
  // A day that does not exist ("2026-09-31") must not quietly become October 1st.
  if (Number.isNaN(date.getTime()) || date.getFullYear() !== +dateISO.slice(0, 4) || date.getMonth() + 1 !== +dateISO.slice(5, 7) || date.getDate() !== +dateISO.slice(8, 10)) throw new Error('Bad date');
  if (dateISO < winnipegTodayISO()) throw new Error('Date in the past');

  const weekday = date.getDay();
  const [open, close] = dateHours || settings.hours[weekday] || [0, 0];
  startMin = Number(startMin); endMin = Number(endMin);
  if (!Number.isInteger(startMin) || !Number.isInteger(endMin)) throw new Error('Bad times');
  if (startMin % settings.slotStep || endMin % settings.slotStep) throw new Error('Times must align to 30 min');
  if (startMin < open * 60 || endMin > close * 60 || endMin <= startMin) throw new Error('Outside hours');
  if (endMin - startMin < settings.minMins) throw new Error(`Minimum ${settings.minMins / 60}-hour booking`);

  let cents = 0;
  for (let m = startMin; m < endMin; m += settings.slotStep) {
    cents += Math.round(rateFor(settings, weekday, Math.floor(m / 60), bayId) * 100 / (60 / settings.slotStep));
  }
  return cents;
}

export const fmtMin = (m) => {
  if (m >= 1440) return 'Midnight';
  const h = Math.floor(m / 60), mm = m % 60, ap = h < 12 ? 'AM' : 'PM', hh = h % 12 || 12;
  return `${hh}:${String(mm).padStart(2, '0')} ${ap}`;
};

export function summaryFor({ dateISO, startMin, endMin, players }) {
  const dateLabel = new Date(dateISO + 'T00:00:00')
    .toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  return `${dateLabel} · ${fmtMin(Number(startMin))}–${fmtMin(Number(endMin))} · ${players} ${players > 1 ? 'players' : 'player'}`;
}

// Stripe key gating. This is a prototype — LIVE keys are refused so it can never charge real cards.
const isLiveKey = (k) => !!k && k.includes('_live_');
const looksTestKey = (k, prefixes) =>
  !!k && !k.includes('xxx') && k.includes('test') && prefixes.some((p) => k.startsWith(p));

export function stripeStatus(env) {
  const secretKey = env.STRIPE_SECRET_KEY;
  const publishableKey = env.STRIPE_PUBLISHABLE_KEY;
  const hasLive = isLiveKey(secretKey) || isLiveKey(publishableKey);
  const enabled = !hasLive && looksTestKey(secretKey, ['rk_', 'sk_']) && looksTestKey(publishableKey, ['pk_']);
  return { enabled, hasLive, secretKey, publishableKey };
}

// Pinned Stripe API version. Matches the version bundled with the installed SDK (stripe 17.7.0,
// see node_modules/stripe/cjs/apiVersion.js), so the wire format always matches the types the
// SDK was generated against. Without this the account's dashboard default applies and can move
// under us — e.g. Stripe's Basil release relocated subscription.current_period_end, which would
// silently write a null membership expiry for every member at once.
export const STRIPE_API_VERSION = '2025-02-24.acacia';

// The one place a Stripe client is constructed. Callers must still gate on stripeStatus().enabled
// first — this only builds the client, it does not decide whether Stripe may be used.
export function stripeClient(env) {
  return new Stripe(stripeStatus(env).secretKey, { apiVersion: STRIPE_API_VERSION });
}

// ----- Gift-card settings (migration 0020: settings.gift) -----
// Read straight off the RAW settings row rather than normalizeSettings()'s output, so a database
// still on 0019 (no `gift` column at all) simply falls through to these defaults instead of
// needing the normalizer changed. Migration 0020's section 5 documents this shape and says the
// API supplies the defaults — this is that.
export const GIFT_DEFAULTS = {
  minCents: 2500, maxCents: 50000,
  presetsCents: [2500, 5000, 10000, 15000],
  expiryMonths: null, dormancyFeeCents: 0,
};

export function giftConfig(settingsRow) {
  const g = (settingsRow && typeof settingsRow.gift === 'object' && settingsRow.gift) || {};
  const int = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : d);
  const presets = Array.isArray(g.presetsCents)
    ? g.presetsCents.map((c) => Math.round(Number(c) || 0)).filter((c) => c > 0)
    : GIFT_DEFAULTS.presetsCents;
  const minCents = int(g.minCents, GIFT_DEFAULTS.minCents);
  const maxCents = Math.max(minCents, int(g.maxCents, GIFT_DEFAULTS.maxCents));
  return {
    minCents, maxCents,
    presetsCents: presets.filter((c) => c >= minCents && c <= maxCents).sort((a, b) => a - b),
    // Both levers ship OFF and this code never turns them on by itself — see the LEGAL NOTE at
    // the foot of migration 0020. They are surfaced so the manager portal can show what is set
    // (and so a non-zero value is visible rather than silently ignored), not acted on.
    expiryMonths: g.expiryMonths == null ? null : int(g.expiryMonths, null),
    dormancyFeeCents: int(g.dormancyFeeCents, GIFT_DEFAULTS.dormancyFeeCents),
  };
}

// ----- Promo codes (migration 0021) -----
// settings.promo — a raw settings sub-object, same reasoning as giftConfig above.
// ttlSeconds defaults to 300 to match HOLD_MINUTES = 5 in lib/db.js: a promo reservation and the
// cart hold it belongs to must lapse together, or one outlives the booking it was taken for.
export const PROMO_DEFAULTS = { ttlSeconds: 300, maxFailed: 10, windowSeconds: 3600 };

export function promoConfig(settingsRow) {
  const p = (settingsRow && typeof settingsRow.promo === 'object' && settingsRow.promo) || {};
  const int = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), lo), hi) : d;
  };
  return {
    ttlSeconds:    int(p.ttlSeconds, PROMO_DEFAULTS.ttlSeconds, 30, 3600),
    maxFailed:     int(p.maxFailed, PROMO_DEFAULTS.maxFailed, 1, 1000),
    windowSeconds: int(p.windowSeconds, PROMO_DEFAULTS.windowSeconds, 60, 86400),
  };
}

// What the customer typed, reduced to the form the unique index in 0021 matches on
// (upper(btrim(code))). Kept short so a paste of a whole sentence can't become a lookup.
export function normalizePromoCode(input) {
  return String(input || '').trim().toUpperCase().slice(0, 64);
}

// Is this code usable for THIS booking? Everything that is a property of the slot or the customer
// is decided here; the validity window and the redemption limits are decided under a row lock in
// reserve_promo (migration 0021), which is the only thing that can be raced. The window is checked
// here too, so validate() can say "expired" without taking a lock or a reservation.
//
// ctx: { dateISO, bayId, startMin, endMin, leaguePlayer, memberPct, subtotalCents, nowMs }
// Returns { ok: true } or { ok: false, reason }. Reasons are stable strings the API maps to copy.
export function promoApplies(promo, ctx = {}) {
  if (!promo) return { ok: false, reason: 'not_found' };
  if (promo.active === false) return { ok: false, reason: 'inactive' };

  const now = Number.isFinite(ctx.nowMs) ? ctx.nowMs : Date.now();
  const at = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };
  const starts = promo.starts_at ? at(promo.starts_at) : null;
  const ends = promo.ends_at ? at(promo.ends_at) : null;
  if (starts !== null && now < starts) return { ok: false, reason: 'not_started' };
  if (ends !== null && now > ends) return { ok: false, reason: 'expired' };

  // An empty array means "no restriction" — the same convention schedule_overrides.bay_ids uses.
  const bays = Array.isArray(promo.bay_ids) ? promo.bay_ids : [];
  if (bays.length && ctx.bayId && !bays.includes(ctx.bayId)) return { ok: false, reason: 'bay' };

  const wds = Array.isArray(promo.weekdays) ? promo.weekdays.map(Number) : [];
  if (wds.length && ctx.dateISO) {
    const d = new Date(String(ctx.dateISO) + 'T00:00:00');
    if (!Number.isNaN(d.getTime()) && !wds.includes(d.getDay())) return { ok: false, reason: 'weekday' };
  }

  // Time-of-day window: the WHOLE session must sit inside it. Containment rather than overlap,
  // so a "before noon" code cannot be claimed by a session that runs 11:30–13:30.
  const ws = promo.start_min == null ? null : Number(promo.start_min);
  const we = promo.end_min == null ? null : Number(promo.end_min);
  if (ws !== null && ctx.startMin != null && Number(ctx.startMin) < ws) return { ok: false, reason: 'time' };
  if (we !== null && ctx.endMin != null && Number(ctx.endMin) > we) return { ok: false, reason: 'time' };

  // Since leagues replaced memberships (0028), "members" means players on a current league roster.
  // A code limited to particular membership plans applies to any league player: those plans are
  // no longer sold, and a code nobody can ever redeem helps no one.
  const isMember = !!ctx.leaguePlayer;
  if (promo.membership_scope === 'members' && !isMember) return { ok: false, reason: 'members_only' };
  if (promo.membership_scope === 'non_members' && isMember) return { ok: false, reason: 'non_members_only' };

  // Stacking, half one: see the STACKING note on quoteBooking. The membership wins.
  if (promo.stacks_with_membership === false && Number(ctx.memberPct) > 0) {
    return { ok: false, reason: 'membership' };
  }

  const min = Math.max(0, Math.round(Number(promo.min_subtotal_cents) || 0));
  if (min > 0 && Math.round(Number(ctx.subtotalCents) || 0) < min) {
    return { ok: false, reason: 'min_subtotal', minSubtotalCents: min };
  }
  return { ok: true };
}

// How much comes off, in cents. Percentage first (capped by max_discount_cents), then the fixed
// amount — the "% then $" the waterfall documents. `kind` says which one an operator meant, but
// both are applied unconditionally: a percent code carries amount_off_cents = 0 and a fixed code
// carries percent_off = 0, so applying both is the same arithmetic with one fewer branch to be
// wrong in. Never exceeds the subtotal — the floor at 0 is quoteBooking's job, not a surprise here.
export function promoDiscountFor(promo, subtotalCents) {
  if (!promo) return 0;
  const subtotal = Math.max(0, Math.round(Number(subtotalCents) || 0));
  if (!subtotal) return 0;

  const pct = Math.min(Math.max(Number(promo.percent_off) || 0, 0), 100);
  let cents = Math.round(subtotal * pct / 100);
  const cap = promo.max_discount_cents == null ? null : Math.round(Number(promo.max_discount_cents));
  if (cap !== null && cap > 0) cents = Math.min(cents, cap);

  cents += Math.max(0, Math.round(Number(promo.amount_off_cents) || 0));
  return Math.min(Math.max(cents, 0), subtotal);
}

// ----- Group + recurring bookings (migration 0023) -----
//
// A GROUP is N bays reserved at one moment; a SERIES is that moment repeated. Both are priced
// here, and "priced here" means one call to quoteBooking() for the whole occurrence — not one per
// bay. That distinction is the entire reason this function exists rather than a loop at the call
// site: every step of the waterfall below the base rate is a property of the CUSTOMER, not of a
// bay, and applying a customer's benefits once per bay would multiply them by the size of the
// party. Six bays would burn a $50 gift card six times over, a $10-off promo would take $60 off,
// and the 50¢ Stripe floor would be enforced six times instead of once.
//
// So: sum the per-bay list prices, run THAT total through the one waterfall, then split what is
// actually owed back across the bays for the booking rows. The split is pro rata by list price
// with largest-remainder rounding, so the per-bay amounts always add up to exactly what the
// customer is charged — no stray cent appearing or disappearing on a six-way division.
export const SERIES_FREQS = ['once', 'daily', 'weekly', 'monthly', 'annual'];

// Split totalCents across weights so the parts sum to exactly totalCents. Largest remainder:
// give everyone their floor, then hand the leftover pennies to the biggest fractions first.
export function allocateCents(weights, totalCents) {
  const w = weights.map((n) => Math.max(0, Math.round(Number(n) || 0)));
  const total = Math.max(0, Math.round(Number(totalCents) || 0));
  const sum = w.reduce((a, b) => a + b, 0);
  if (!total || !sum) return w.map(() => 0);
  const exact = w.map((x) => (total * x) / sum);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k].i] += 1;
  return out;
}

// One occurrence, priced. Returns everything quoteBooking() returns, plus:
//   bays            [{ bayId, listCents, amountCents }] — listCents is the pre-discount rate for
//                   that bay, amountCents is its share of what the customer actually pays
//   listTotalCents  the sum of the bays' list prices (== the quote's fullAmount)
// Bays are de-duplicated and sorted, matching the order book_group() writes them in.
export function quoteGroup({
  settings = DEFAULT_SETTINGS, dateISO, bayIds = [], startMin, endMin, dateHours = null,
  ...quoteArgs
} = {}) {
  const bays = [...new Set((bayIds || []).filter(Boolean).map(String))].sort();
  const listCents = bays.map((bayId) =>
    priceForBooking({ settings, dateISO, bayId, startMin, endMin, dateHours }));
  const total = listCents.reduce((a, b) => a + b, 0);
  const quote = quoteBooking({ settings, amountCents: total, ...quoteArgs });
  const share = allocateCents(listCents, quote.charge);
  return {
    ...quote,
    listTotalCents: total,
    bays: bays.map((bayId, i) => ({ bayId, listCents: listCents[i], amountCents: share[i] })),
  };
}
