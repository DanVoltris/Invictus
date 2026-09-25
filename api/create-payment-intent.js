import { priceForBooking, summaryFor, stripeStatus, stripeClient, normalizeSettings, bayName, overrideEffects, overrideConflicts, weeklyStatusConflicts, quoteBooking, winnipegTodayISO, bookingWindowError } from '../lib/booking.js';
import { getSettings, getBookingsForDate, getOverridesForDate, createHold, promoByCode, giftCardByCode, giftCardAvailable, leaguePlayerForRequest,
         checkoutStripeCustomer, paymentElementSession } from '../lib/db.js';

// Creates a PaymentIntent for a booking. Price + availability are validated server-side.
export default async function handler(req, res) {
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

    // A signed-in customer's saved cards and wallets (migration 0029). Null for everyone else.
    const stripeCustomerId = await checkoutStripeCustomer(stripe, req);

    const pi = await stripe.paymentIntents.create({
      ...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
      amount: charge,
      currency: settings.currency,
      automatic_payment_methods: { enabled: true }, // dynamic payment methods, no hardcoded card-only
      description: `${bayName(settings, bayId)} — simulator session`,
      metadata: {
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

    let customerSessionClientSecret = null;
    if (stripeCustomerId) {
      try { customerSessionClientSecret = await paymentElementSession(stripe, stripeCustomerId); }
      catch (err) { console.warn('create-payment-intent: saved cards unavailable —', err.message); }
    }

    res.status(200).json({ clientSecret: pi.client_secret, customerSessionClientSecret, amount: charge, fullAmount: amount,
      memberPct: q.memberPct, memberDiscountCents: q.memberDiscountCents,
      promoDiscountCents: q.promoDiscountCents || 0, promoBlocked: q.promoBlocked || null,
      giftUsedCents: q.giftUsedCents || 0, expiresAt });
  } catch (err) {
    console.error('create-payment-intent:', err.message);
    res.status(400).json({ error: err.message });
  }
}
