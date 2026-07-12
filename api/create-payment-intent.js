import Stripe from 'stripe';
import { priceForBooking, summaryFor, stripeStatus, normalizeSettings, bayName, overrideEffects, overrideConflicts, weeklyStatusConflicts, pointsRedemption } from '../lib/booking.js';
import { getSettings, getBookingsForDate, getOverridesForDate, createHold, customerHoursByContact } from '../lib/db.js';

// Creates a PaymentIntent for a booking. Price + availability are validated server-side.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { enabled, secretKey } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ error: 'Stripe not configured' });

  try {
    const stripe = new Stripe(secretKey);
    const { dateISO, bayId, startMin, endMin, party, hold, applyPoints, email, phone } = req.body || {};

    const settings = normalizeSettings(await getSettings());
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

    // Loyalty points as dollars off: discount the charge now; the points are actually deducted
    // when the payment succeeds (confirm-booking/webhook, idempotent by PaymentIntent id).
    // partialOnly: on this card path a charge must remain — a balance big enough to fully cover
    // still gets the max discount (50¢ minimum charge) instead of being silently ignored.
    let charge = amount, pointsUsed = 0, pointsCustomerId = '';
    if (applyPoints) {
      const cust = await customerHoursByContact({ email, phone });
      const r = pointsRedemption(settings, (cust && cust.points_balance) || 0, amount, { partialOnly: true });
      if (cust && r.pointsUsed > 0) {
        charge = amount - r.discountCents; pointsUsed = r.pointsUsed; pointsCustomerId = cust.id;
      }
    }

    const pi = await stripe.paymentIntents.create({
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
        pointsUsed: String(pointsUsed),
        pointsCustomerId,
      },
    });

    res.status(200).json({ clientSecret: pi.client_secret, amount: charge, fullAmount: amount, pointsUsed, expiresAt });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
