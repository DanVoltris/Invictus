import { priceForBooking, summaryFor, stripeStatus, stripeClient, normalizeSettings, bayName, overrideEffects, overrideConflicts, weeklyStatusConflicts, quoteBooking, winnipegTodayISO, bookingWindowError, holdPlan } from '../lib/booking.js';
import { getSettings, getBookingsForDate, getOverridesForDate, createHold, promoByCode, giftCardByCode, giftCardAvailable, leaguePlayerForRequest,
         confirmHold, insertBooking, upsertCustomer, bookingExistsForPI, setCustomerNote, recordConsent, clientIp,
         releaseHold } from '../lib/db.js';
import { paymentPatchFor, releaseUnbookedHold } from '../lib/holds.js';

// One customer checkout, start to finish. Dispatch on ?action=, the same shape as
// api/gift-cards.js, api/leagues.js and api/waitlist.js:
//
//   create-payment-intent  POST   price the slot, hold it, and open a PaymentIntent
//   confirm-booking        POST   the payment succeeded — turn the hold into a real booking
//   release-hold           POST   checkout was closed before paying — give the slot back
//
// WHY THESE THREE SHARE A FILE. Vercel's Hobby plan allows 12 Serverless Functions and api/ held
// 16, so the project could not deploy at all. These three are the single flow one customer walks
// through in one sitting — price, pay, or walk away — so they cost one slot between them instead
// of three. Nothing about any of the three answers changed.
//
// THE OLD URLS ARE UNCHANGED. /api/create-payment-intent, /api/confirm-booking and
// /api/release-hold still work: vercel.json rewrites each onto this file with the right ?action=,
// and server.js mounts the same three paths on the same dispatcher below. Stripe's success URLs,
// demo/index.html and anything else pointing at the old paths keep working untouched.
//
// Each section below keeps its OWN method check, so an old path answers a GET exactly as its own
// file used to — the three did not agree on the shape of that 405 and this is not the place to
// start changing answers.

// Which of the three is being asked for. Normally ?action=, set by the rewrite. `forced` is how
// server.js names the action for a path it mounts directly — Vercel only ever passes (req, res),
// so the default applies there.
const ACTIONS = ['create-payment-intent', 'confirm-booking', 'release-hold'];
export default async function handler(req, res, forced) {
  const action = forced || actionOf(req, ACTIONS);
  if (action === 'create-payment-intent') return createPaymentIntent(req, res);
  if (action === 'confirm-booking') return confirmBooking(req, res);
  if (action === 'release-hold') return releaseHoldAction(req, res);
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

// ---- ?action=create-payment-intent (was api/create-payment-intent.js) -------------------
// Creates a PaymentIntent for a booking. Price + availability are validated server-side.
export async function createPaymentIntent(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ error: 'Stripe not configured' });

  try {
    const stripe = stripeClient(process.env);
    const { dateISO, bayId, startMin, endMin, party, hold, email, phone,
            promoCode, giftCode, promoReservationId } = req.body || {};

    const settings = normalizeSettings(await getSettings());
    // How far ahead this customer may book: further for league players (migration 0028).
    const leaguePlayer = await leaguePlayerForRequest(req);
    const tooFar = bookingWindowError({ settings, dateISO, league: leaguePlayer });
    if (tooFar) return res.status(400).json({ error: tooFar, code: 'booking_window' });
    const overrides = await getOverridesForDate(dateISO);
    // Resolve schedule overrides up front: dateHours lets priceForBooking accept widened
    // special hours; overrideConflicts rejects blocked/closed slots.
    const fx = overrideEffects(overrides, settings, dateISO);
    const amount = priceForBooking({ settings, dateISO, bayId, startMin, endMin, dateHours: fx.dateHours });
    const players = Math.min(Math.max(parseInt(party, 10) || 1, 1), settings.maxParty);

    // Reject if the slot is really taken (confirmed booking / manager block). Cart holds are handled
    // by createHold below — its atomic insert is the real guard, so they don't count here.
    const conflict = (await getBookingsForDate(dateISO))
      .some((b) => b.status !== 'held' && b.bay_id === bayId && Number(startMin) < b.end_min && Number(endMin) > b.start_min);
    if (conflict) return res.status(409).json({ error: 'That time was just booked — pick another slot.' });

    if (overrideConflicts(fx, settings, dateISO, bayId, Number(startMin), Number(endMin)) ||
        weeklyStatusConflicts(settings, overrides, dateISO, bayId, Number(startMin), Number(endMin))) {
      return res.status(409).json({ error: 'That time is unavailable — pick another slot.' });
    }

    // Cart hold: lock the slot for ~5 min while the customer checks out (see lib/db.js createHold).
    let expiresAt = null;
    if (hold) {
      const h = await createHold({ dateISO, bayId, startMin: Number(startMin), endMin: Number(endMin) });
      if (h.conflict) return res.status(409).json({ error: 'That time was just taken — pick another slot.' });
      if (h.error) return res.status(500).json({ error: h.error });
      expiresAt = h.expiresAt;
    }

    // Promo code and gift card. The browser sends these; until now this handler destructured
    // neither, so quoteBooking() never saw them and the card was charged the undiscounted price
    // while /api/promos and /api/gift-cards quoted a lower one. Three answers, one of them the
    // one that actually took the money.
    //
    // Both are looked up server-side from the code alone — the browser sends a string, never an
    // amount. An unknown or exhausted code is simply not applied; it is not an error, because the
    // customer must still be able to pay. What was applied comes back in the response and in the
    // PaymentIntent metadata, so the client shows the same figure the card is charged and the
    // webhook can settle it (see api/webhook.js fulfil()).
    const promo = promoCode ? await promoByCode(String(promoCode)) : null;
    const giftCard = giftCode ? await giftCardByCode(String(giftCode)) : null;
    const giftBalanceCents = giftCard ? await giftCardAvailable(giftCard.id) : 0;

    const q = quoteBooking({
      settings, amountCents: amount, plan: null,   // memberships retired (0028): leagues carry no discount
      todayISO: winnipegTodayISO(),                // loyalty points retired: no stage for them here
      promo,
      promoContext: {
        dateISO, bayId, startMin: Number(startMin), endMin: Number(endMin),
        leaguePlayer,
      },
      giftBalanceCents, applyGift: !!giftCard,
    });
    const charge = q.charge;

    // Saved cards (migration 0029) are retired: no Stripe Customer is created or attached here,
    // and no Customer Session is opened, so customers.stripe_customer_id is never read. Apple Pay
    // and Google Pay are unaffected — they come from automatic_payment_methods below, which has
    // nothing to do with a Customer.
    // HOLD OR CHARGE. The Payment Settings screen has always claimed "Capture method: Credit Card
    // Hold" while every booking was captured on the spot. holdPlan() is what makes it true, and it
    // is a DATE question, not a preference: a card authorisation lasts about seven days (Stripe's
    // documented windows are in lib/booking.js), the booking window is 10 days — 60 for league
    // players — so a session further ahead than settings.pay.hold.cutoffDays cannot be held and is
    // charged in full exactly as it is today. The answer goes back to the caller below so the
    // customer is told which one before they confirm, not after their card is taken.
    const plan = holdPlan({ settings, dateISO, startMin });

    const pi = await stripe.paymentIntents.create({
      amount: charge,
      currency: settings.currency,
      automatic_payment_methods: { enabled: true }, // dynamic payment methods, no hardcoded card-only
      // Only sent for a hold. Stripe's default is already 'automatic', so the charge-now path is
      // byte for byte the request it has always been.
      ...(plan.mode === 'hold' ? { capture_method: 'manual' } : {}),
      description: `${bayName(settings, bayId)} — simulator session`,
      metadata: {
        // Which way this payment was set up, carried on the PaymentIntent itself so the webhook and
        // the client-side confirm cannot disagree about it — neither of them re-runs the decision.
        paymentMode: plan.mode,
        holdExpiresAt: plan.holdExpiresAt || '',
        bayId,
        bayName: bayName(settings, bayId),
        dateISO,
        startMin: String(startMin),
        endMin: String(endMin),
        players: String(players),
        summary: summaryFor({ dateISO, startMin, endMin, players }),
        promoId: (q.promoDiscountCents > 0 && promo) ? String(promo.id) : '',
        promoReservationId: (q.promoDiscountCents > 0 && promoReservationId) ? String(promoReservationId) : '',
        promoDiscountCents: String(q.promoDiscountCents || 0),
        giftCardId: (q.giftUsedCents > 0 && giftCard) ? String(giftCard.id) : '',
        giftUsedCents: String(q.giftUsedCents || 0),
        memberDiscountPct: String(q.memberPct),
        memberDiscountCents: String(q.memberDiscountCents),
      },
    });

    res.status(200).json({ clientSecret: pi.client_secret, amount: charge, fullAmount: amount,
      memberPct: q.memberPct, memberDiscountCents: q.memberDiscountCents,
      promoDiscountCents: q.promoDiscountCents || 0, promoBlocked: q.promoBlocked || null,
      giftUsedCents: q.giftUsedCents || 0, expiresAt,
      // WHAT THE CUSTOMER MUST BE TOLD BEFORE THEY CONFIRM. `mode` is 'hold' or 'charge';
      // `message` is a sentence ready to put on the screen; `captureBy` is when a hold dies if
      // nobody captures it. A checkout page that shows nothing from here is telling a customer
      // their card was charged when it was only held, or the reverse.
      payment: {
        mode: plan.mode,
        captureMethod: plan.captureMethod,
        amountCents: charge,
        holdExpiresAt: plan.holdExpiresAt,
        captureBy: plan.captureBy,
        cutoffDays: plan.cutoffDays,
        message: plan.message,
      },
      // The same answer flat, for callers that only want the one word.
      paymentMode: plan.mode });
  } catch (err) {
    console.error('create-payment-intent:', err.message);
    res.status(400).json({ error: err.message });
  }
}

// ---- ?action=confirm-booking (was api/confirm-booking.js) -------------------------------
// Called by the booking site the moment a payment succeeds. It re-verifies the PaymentIntent with
// Stripe (so it can't be spoofed), then turns the customer's live cart hold into a confirmed booking
// and saves the customer. This makes bookings work without relying on a Stripe webhook; if a webhook
// IS configured it stays a backup — bookingExistsForPI keeps the two from double-booking.
export async function confirmBooking(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ ok: false, error: 'Stripe not configured' });

  // note: typed at checkout, after the PaymentIntent already existed — so it arrives here, not in its metadata.
  // smsConsent: the express-consent tick box on the checkout form (migration 0019). `sms` beside it
  // is the old UI preference, which defaults to true and is NOT consent — the two are kept apart.
  const { paymentIntentId, name, email, phone, sms, smsConsent, note } = req.body || {};
  if (!paymentIntentId) return res.status(400).json({ ok: false, error: 'Missing payment reference.' });

  const stripe = stripeClient(process.env);
  let pi;
  try { pi = await stripe.paymentIntents.retrieve(paymentIntentId); }
  catch (_) { return res.status(400).json({ ok: false, error: 'Payment not found.' }); }
  // TWO statuses mean "the customer is done and the slot is theirs", not one:
  //   succeeded         the card was charged — the far-ahead path, and what this handler has always
  //                     accepted, unchanged.
  //   requires_capture  the card was AUTHORISED. With capture_method: 'manual' this is as far as a
  //                     held booking ever gets at checkout, and `succeeded` will not arrive until a
  //                     member of staff captures at check-in — possibly days later. Refusing it here
  //                     would leave a customer who has had money reserved with no booking at all,
  //                     and the slot showing free.
  if (pi.status !== 'succeeded' && pi.status !== 'requires_capture') {
    return res.status(400).json({ ok: false, error: 'Payment is not complete.' });
  }
  const held = pi.status === 'requires_capture';

  const md = pi.metadata || {};
  if (!md.dateISO || !md.bayId) return res.status(400).json({ ok: false, error: 'Booking details missing on the payment.' });

  // Already saved (webhook or a retry got here first)? Nothing more to do.
  if (await bookingExistsForPI(pi.id)) {
    await upsertCustomer({ name, email, phone, smsOptIn: typeof sms === 'boolean' ? sms : undefined });
    await saveSmsConsent(req, { name, email, phone, smsConsent });
    await setCustomerNote({ paymentIntentId: pi.id, note, onlyIfEmpty: true });   // the webhook saved it without the note
    return res.status(200).json({ ok: true, already: true });
  }

  // Prefer what the customer typed; fall back to the card's billing details. The charge is also
  // where the card network's own authorisation deadline lives (capture_before), which is why it is
  // handed to paymentPatchFor below rather than thrown away after the billing details.
  let n = name, e = email, p = phone, charge = null;
  try {
    if (pi.latest_charge) {
      charge = await stripe.charges.retrieve(pi.latest_charge);
      const bd = charge.billing_details || {};
      n = n || bd.name; e = e || pi.receipt_email || bd.email; p = p || bd.phone;
    }
  } catch (_) { /* best-effort */ }

  const settings = normalizeSettings(await getSettings());
  const slot = { dateISO: md.dateISO, bayId: md.bayId, startMin: Number(md.startMin), endMin: Number(md.endMin) };
  const patch = {
    status_label: settings.onlineStatusLabel || null, customer_name: n || null, customer_email: e || null, customer_phone: p || null,
    stripe_payment_intent: pi.id, source: 'online',
    // amount_cents, authorized_cents, hold_expires_at and captured_at all come from here, so this
    // path and the webhook record the identical row. A held booking gets amount_cents 0.
    ...paymentPatchFor({ pi, charge }),
  };

  const flip = await confirmHold({ ...slot, patch });
  let bookingId = flip.id;
  if (!flip.updated) {
    const ins = await insertBooking({ bay_id: slot.bayId, booking_date: slot.dateISO, start_min: slot.startMin, end_min: slot.endMin, status: 'confirmed', ...patch });
    if (ins.error) {
      if (!held) {
        return res.status(409).json({ ok: false, error: 'That slot is no longer available — please contact the shop; your payment went through.' });
      }
      // A held card with no booking is on no list anywhere, so let it go now — but only when the
      // slot really is taken, never because the database hiccupped.
      const rel = ins.conflict ? await releaseUnbookedHold({ stripe, pi }) : { released: false };
      if (rel.booked) return res.status(200).json({ ok: true, already: true });
      return res.status(409).json({ ok: false, error: rel.released
        ? 'That slot is no longer available — please contact the shop. Your card was only held, not charged, and the hold has been released.'
        : 'We could not save your booking — please contact the shop. Your card was only held, not charged, and the hold clears on its own within about a week.' });
    }
    bookingId = ins.id;
  }
  await setCustomerNote({ bookingId, note });
  await upsertCustomer({ name: n, email: e, phone: p, smsOptIn: typeof sms === 'boolean' ? sms : undefined });
  await saveSmsConsent(req, { name: n, email: e, phone: p, smsConsent });

  // Loyalty points are retired: nothing is spent and nothing is earned here any more. Gift cards
  // and promo codes are still settled by api/webhook.js, exactly as before.
  return res.status(200).json({
    ok: true, bookingId,
    // Which of the two happened, so the confirmation screen says "held" or "charged" and not
    // whichever one it was written for.
    paymentState: held ? 'held' : 'paid',
    holdExpiresAt: held ? (patch.hold_expires_at || null) : null,
    amountCents: held ? (patch.authorized_cents || 0) : (patch.amount_cents || 0),
  });
}

// The consent tick, written where lib/notify.js looks for it. Three rules, all of them here:
//   • no smsConsent in the request → nothing is written, ever. Silence is not consent, and a
//     client that has not been updated must not be read as one that sent `false`.
//   • true  → sms_consent, with the time, the IP and source 'checkout' (CASL's point-of-collection
//     record), and sms_unsub_at cleared.
//   • false → recorded as a NO, not skipped: the box starts empty, so the customer has looked at
//     it and chosen to leave it that way. That withdraws any earlier yes rather than leaving the
//     old one standing, which is why recordConsent() stamps sms_unsub_at on a false.
// Best-effort, like the note and the receipt: a paid booking is never failed over a preference.
async function saveSmsConsent(req, { name, email, phone, smsConsent }) {
  if (typeof smsConsent !== 'boolean') return;
  try {
    await recordConsent({ name, email, phone, smsConsent, ip: clientIp(req), source: 'checkout' });
  } catch (err) {
    console.error('confirm-booking: consent not recorded —', err && err.message ? err.message : err);
  }
}

// ---- ?action=release-hold (was api/release-hold.js) -------------------------------------
// Release a cart hold when checkout is closed/abandoned before payment.
// Best-effort — the 5-minute TTL (cleanupExpiredHolds) is the real backstop.
// Named releaseHoldAction because lib/db.js already exports releaseHold, which is what it calls.
export async function releaseHoldAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { dateISO, bayId, startMin, endMin } = req.body || {};
  if (dateISO && bayId) await releaseHold({ dateISO, bayId, startMin: Number(startMin), endMin: Number(endMin) });
  res.status(200).json({ ok: true });
}
