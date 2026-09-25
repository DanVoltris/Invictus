import {
  stripeStatus, stripeClient, normalizeSettings, promoConfig, normalizePromoCode,
  priceForBooking, overrideEffects, overrideConflicts, weeklyStatusConflicts,
  quoteBooking, taxPctOf, winnipegTodayISO,
} from '../lib/booking.js';
import {
  getSettings, getOverridesForDate,
  promoByCode, reservePromo, releasePromo, redeemPromo, promoReservationById,
  promoRateOk, promoLogAttempt, customerKeyFor,
  customerHoursByContact, isLeaguePlayer
} from '../lib/db.js';

// Promo codes at checkout. Dispatch on ?action= — validate | reserve | release | redeem.
//
// ENFORCEMENT IS ENTIRELY SERVER-SIDE. The browser sends a code and a slot; it never sends, and is
// never trusted for, a discount. Every number below comes from quoteBooking (lib/booking.js), which
// prices the slot from saved settings and applies the waterfall in one place — so a promo behaves
// identically on the card path, the hours path and a manager's manual booking.
//
// THE LIFECYCLE, and why it has four steps rather than one:
//
//   validate  is this code usable for this booking, and what is it worth? Takes nothing.
//   reserve   claim one use while the customer checks out. Same 5-minute TTL as the cart hold —
//             without it, a 50-use code can be redeemed 200 times by 200 people checking out at
//             once, because "how many are left" would only be counted at payment.
//   release   the cart was abandoned. Hands the claim straight back.
//   redeem    the payment succeeded. reserved → redeemed, and the use is spent for good.
//
// There is no ?action=list. A promo list is every live discount code the business has, and the
// point of the brute-force limiter below is that codes are not enumerable — an endpoint that hands
// them out would defeat the feature in one request. The manager portal reads the promos table
// directly with its authenticated session (migration 0021 §10 permits exactly that, and only that).

// GET has nothing safe to return here, so this handler is POST-only — see the note above.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const action = (req.query && req.query.action) || '';
  if (action === 'validate') return validate(req, res);
  if (action === 'reserve') return reserve(req, res);
  if (action === 'release') return release(req, res);
  if (action === 'redeem') return redeem(req, res);
  return res.status(400).json({ error: 'Unknown action' });
}

// Whoever is asking, for the rate limiter. A normalized contact when we have one (so a limiter
// cannot be walked around by rotating IPs), else the client IP.
const clientIp = (req) => String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '')
  .split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
const attemptKey = (req, body) => customerKeyFor({ email: body.email, phone: body.phone }) || `ip:${clientIp(req)}`;

// Why a code was refused, in the customer's words. Kept in ONE place so validate and reserve can
// never explain the same refusal two different ways.
//
// Note what is deliberately vague and what is not: an unknown code says "we don't recognise it"
// and nothing more, because a precise answer is a free oracle for someone guessing. A code that
// exists but does not apply to THIS booking gets a specific reason, because the customer is
// holding a real code and needs to know what to change.
const REFUSALS = {
  not_found:        'We don’t recognise that code.',
  promo_not_found:  'We don’t recognise that code.',
  inactive:         'That code is no longer active.',
  promo_inactive:   'That code is no longer active.',
  not_started:      'That code isn’t active yet.',
  promo_not_started:'That code isn’t active yet.',
  expired:          'That code has expired.',
  promo_expired:    'That code has expired.',
  bay:              'That code doesn’t apply to this bay.',
  weekday:          'That code doesn’t apply on this day.',
  time:             'That code doesn’t apply at this time of day.',
  members_only:     'That code is for league players.',
  non_members_only: 'That code isn’t for league players.',
  membership:       'That code can’t be combined with your membership discount — you’re already getting the better deal.',
  min_subtotal:     'Your booking isn’t large enough for that code.',
  promo_exhausted:  'That code has been fully claimed.',
  promo_already_used: 'You’ve already used that code.',
  promo_no_customer_key: 'Enter your phone number or email to use a code.',
};
const refusal = (reason) => REFUSALS[reason] || 'That code can’t be used on this booking.';

// Price + availability for the slot, then the whole waterfall with this promo in it. Identical
// checks, in the same order, as api/hour-cards.js — a promo must never make an
// unavailable slot bookable.
async function quoteFor(body) {
  const { dateISO, bayId, startMin, endMin, email, phone } = body;
  const row = await getSettings();
  const settings = normalizeSettings(row);
  const overrides = await getOverridesForDate(dateISO);
  const fx = overrideEffects(overrides, settings, dateISO);
  const amount = priceForBooking({ settings, dateISO, bayId, startMin, endMin, dateHours: fx.dateHours });
  if (overrideConflicts(fx, settings, dateISO, bayId, Number(startMin), Number(endMin)) ||
      weeklyStatusConflicts(settings, overrides, dateISO, bayId, Number(startMin), Number(endMin))) {
    throw Object.assign(new Error('That time is unavailable — pick another slot.'), { code: 409 });
  }

  const cust = await customerHoursByContact({ email, phone });
  const leaguePlayer = await isLeaguePlayer({ email, phone });
  const promo = await promoByCode(normalizePromoCode(body.code));

  const q = quoteBooking({
    settings, amountCents: amount, plan: null, todayISO: winnipegTodayISO(), taxPct: taxPctOf(settings),
    promo,
    promoContext: {
      dateISO, bayId, startMin: Number(startMin), endMin: Number(endMin), leaguePlayer,
    },
  });
  return { row, settings, amount, cust, promo, quote: q };
}

// The shape both validate and reserve answer with, so the browser has one thing to render.
const breakdown = (q) => ({
  fullAmountCents: q.fullAmount,
  memberPct: q.memberPct,
  memberDiscountCents: q.memberDiscountCents,
  promoDiscountCents: q.promoDiscountCents,
  chargeCents: q.charge,
});

// POST ?action=validate — is this code good for this booking, and what does it take off?
// Reserves nothing, so it is safe to call on every keystroke-completed code entry. Rate-limited:
// a promo code is a short shared secret typed into a public form, i.e. enumerable by definition.
async function validate(req, res) {
  const b = req.body || {};
  const code = normalizePromoCode(b.code);
  if (!code) return res.status(400).json({ ok: false, error: 'Enter a code.' });

  const cfg = promoConfig(await getSettings());
  const key = attemptKey(req, b);
  if (!(await promoRateOk({ key, windowSeconds: cfg.windowSeconds, maxFailed: cfg.maxFailed }))) {
    return res.status(429).json({ ok: false, error: 'Too many tries — wait a few minutes, or call the shop.' });
  }

  let r;
  try { r = await quoteFor({ ...b, code }); }
  catch (e) { return res.status(e.code || 400).json({ ok: false, error: e.message }); }

  if (!r.promo) {
    await promoLogAttempt({ key, code, ok: false });
    return res.status(200).json({ ok: false, reason: 'not_found', error: refusal('not_found') });
  }
  if (r.quote.promoBlocked) {
    // A real code that does not apply here. Not a guess, so it is not counted against the limiter.
    await promoLogAttempt({ key, code, ok: true });
    return res.status(200).json({ ok: false, reason: r.quote.promoBlocked, error: refusal(r.quote.promoBlocked) });
  }
  await promoLogAttempt({ key, code, ok: true });
  res.status(200).json({ ok: true, code: r.promo.code, ...breakdown(r.quote) });
}

// POST ?action=reserve — claim one use for the length of the cart hold.
//
// The discount recorded on the reservation is the one quoteBooking just computed here, never a
// number from the request: migration 0021 records p_discount_cents without verifying it precisely
// because the only route to that function is this file, running on the service-role key.
async function reserve(req, res) {
  const b = req.body || {};
  const code = normalizePromoCode(b.code);
  if (!code) return res.status(400).json({ ok: false, error: 'Enter a code.' });

  // The per-customer limit counts this key, so a booking with no contact details cannot hold a
  // code at all — otherwise "one per customer" would mean "unlimited for anyone anonymous".
  const customerKey = customerKeyFor({ email: b.email, phone: b.phone });
  if (!customerKey) return res.status(400).json({ ok: false, error: refusal('promo_no_customer_key') });

  const cfg = promoConfig(await getSettings());
  // Rate-limit here too, not only in validate: otherwise reserve is an unmetered oracle and the
  // limiter is bypassed by guessing against this action instead.
  const key = attemptKey(req, b);
  if (!(await promoRateOk({ key, windowSeconds: cfg.windowSeconds, maxFailed: cfg.maxFailed }))) {
    return res.status(429).json({ ok: false, error: 'Too many tries — wait a few minutes, or call the shop.' });
  }

  let r;
  try { r = await quoteFor({ ...b, code }); }
  catch (e) { return res.status(e.code || 400).json({ ok: false, error: e.message }); }

  if (!r.promo) {
    await promoLogAttempt({ key, code, ok: false });
    return res.status(200).json({ ok: false, reason: 'not_found', error: refusal('not_found') });
  }
  await promoLogAttempt({ key, code, ok: true });
  if (r.quote.promoBlocked) {
    return res.status(200).json({ ok: false, reason: r.quote.promoBlocked, error: refusal(r.quote.promoBlocked) });
  }
  if (!(r.quote.promoDiscountCents > 0)) {
    return res.status(200).json({ ok: false, reason: 'no_discount', error: 'That code takes nothing off this booking.' });
  }

  const out = await reservePromo({
    code: r.promo.code, customerKey, customerId: (r.cust && r.cust.id) || null,
    discountCents: r.quote.promoDiscountCents,
    ttlSeconds: cfg.ttlSeconds,               // 300 by default — matches HOLD_MINUTES in lib/db.js
    ref: b.paymentIntentId || null,
  });
  if (out.unsupported) return res.status(503).json({ ok: false, error: 'Promo codes aren’t switched on yet — please call the shop.' });
  if (out.reason) return res.status(200).json({ ok: false, reason: out.reason, error: refusal(out.reason) });
  if (out.error) return res.status(500).json({ ok: false, error: out.error });

  res.status(200).json({
    ok: true,
    reservationId: out.reservationId,
    code: out.code || r.promo.code,
    expiresAt: out.expiresAt,
    ...breakdown(r.quote),
  });
}

// POST ?action=release — the cart was abandoned or the code removed. Always 200: the caller is a
// beacon from a closing tab, and the TTL sweeps anything this misses.
async function release(req, res) {
  const { reservationId } = req.body || {};
  if (!reservationId) return res.status(200).json({ ok: true, released: false });
  const out = await releasePromo(reservationId);
  res.status(200).json({ ok: true, released: out.released });
}

// POST ?action=redeem — the payment succeeded; spend the claim for good.
//
// Safe to expose publicly because it proves the payment rather than trusting the caller: the
// PaymentIntent is re-read from Stripe and must be `succeeded`. redeem_promo is idempotent, so the
// client-side confirm and a Stripe webhook may both call this — which is how this repo already
// double-covers booking confirmation, deliberately (see api/checkout.js ?action=confirm-booking).
//
// A reservation whose TTL lapsed while the customer sat on a 3-D Secure challenge is honoured
// anyway; migration 0021 §7 explains why that is the cheapest of the three bad options.
async function redeem(req, res) {
  const b = req.body || {};
  if (!b.reservationId) return res.status(400).json({ ok: false, error: 'Missing reservation.' });
  if (!b.paymentIntentId) return res.status(400).json({ ok: false, error: 'Missing payment reference.' });

  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ ok: false, error: 'Stripe not configured' });

  const stripe = stripeClient(process.env);
  let pi;
  try { pi = await stripe.paymentIntents.retrieve(b.paymentIntentId); }
  catch (_) { return res.status(400).json({ ok: false, error: 'Payment not found.' }); }
  if (pi.status !== 'succeeded') return res.status(400).json({ ok: false, error: 'Payment is not complete.' });

  const rsv = await promoReservationById(b.reservationId);
  if (!rsv) return res.status(404).json({ ok: false, error: 'That reservation no longer exists.' });
  if (rsv.status === 'redeemed') return res.status(200).json({ ok: true, already: true });

  const out = await redeemPromo({
    reservationId: b.reservationId,
    bookingId: b.bookingId || rsv.booking_id || null,
    ref: pi.id,
  });
  if (out.unsupported) return res.status(503).json({ ok: false, error: 'Promo codes aren’t switched on yet.' });
  if (out.error) return res.status(500).json({ ok: false, error: out.error });
  res.status(200).json({ ok: true, redeemed: out.redeemed, discountCents: rsv.discount_cents });
}
