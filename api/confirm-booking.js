import Stripe from 'stripe';
import { stripeStatus, normalizeSettings, pointsEarned } from '../lib/booking.js';
import { getSettings, confirmHold, insertBooking, upsertCustomer, bookingExistsForPI, adjustPoints, awardBookingPoints } from '../lib/db.js';

// Called by the booking site the moment a payment succeeds. It re-verifies the PaymentIntent with
// Stripe (so it can't be spoofed), then turns the customer's live cart hold into a confirmed booking
// and saves the customer. This makes bookings work without relying on a Stripe webhook; if a webhook
// IS configured it stays a backup — bookingExistsForPI keeps the two from double-booking.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const { enabled, secretKey } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ ok: false, error: 'Stripe not configured' });

  const { paymentIntentId, name, email, phone, sms } = req.body || {};
  if (!paymentIntentId) return res.status(400).json({ ok: false, error: 'Missing payment reference.' });

  const stripe = new Stripe(secretKey);
  let pi;
  try { pi = await stripe.paymentIntents.retrieve(paymentIntentId); }
  catch (_) { return res.status(400).json({ ok: false, error: 'Payment not found.' }); }
  if (pi.status !== 'succeeded') return res.status(400).json({ ok: false, error: 'Payment is not complete.' });

  const md = pi.metadata || {};
  if (!md.dateISO || !md.bayId) return res.status(400).json({ ok: false, error: 'Booking details missing on the payment.' });

  // Already saved (webhook or a retry got here first)? Nothing more to do.
  if (await bookingExistsForPI(pi.id)) { await upsertCustomer({ name, email, phone, smsOptIn: typeof sms === 'boolean' ? sms : undefined }); return res.status(200).json({ ok: true, already: true }); }

  // Prefer what the customer typed; fall back to the card's billing details.
  let n = name, e = email, p = phone;
  try {
    if (pi.latest_charge) {
      const ch = await stripe.charges.retrieve(pi.latest_charge);
      const bd = ch.billing_details || {};
      n = n || bd.name; e = e || pi.receipt_email || bd.email; p = p || bd.phone;
    }
  } catch (_) { /* best-effort */ }

  const settings = normalizeSettings(await getSettings());
  const slot = { dateISO: md.dateISO, bayId: md.bayId, startMin: Number(md.startMin), endMin: Number(md.endMin) };
  const patch = {
    status_label: settings.onlineStatusLabel || null, customer_name: n || null, customer_email: e || null, customer_phone: p || null,
    amount_cents: pi.amount, stripe_payment_intent: pi.id, source: 'online',
  };

  const flip = await confirmHold({ ...slot, patch });
  let bookingId = flip.id;
  if (!flip.updated) {
    const ins = await insertBooking({ bay_id: slot.bayId, booking_date: slot.dateISO, start_min: slot.startMin, end_min: slot.endMin, status: 'confirmed', ...patch });
    if (ins.error) return res.status(409).json({ ok: false, error: 'That slot is no longer available — please contact the shop; your payment went through.' });
    bookingId = ins.id;
  }
  const up = await upsertCustomer({ name: n, email: e, phone: p, smsOptIn: typeof sms === 'boolean' ? sms : undefined });

  // Loyalty: spend the applied points (idempotent by PaymentIntent id), then earn for time played
  // (once per booking — the ledger's unique index guards both against retries/webhook overlap).
  const spent = Number(md.pointsUsed) || 0;
  if (spent > 0 && md.pointsCustomerId) {
    await adjustPoints({ customerId: md.pointsCustomerId, delta: -spent, kind: 'redeem', note: `Booking ${slot.dateISO}`, bookingId, ref: pi.id });
  }
  if (up.id && bookingId) {
    await awardBookingPoints({ customerId: up.id, bookingId, points: pointsEarned(settings, slot.endMin - slot.startMin) });
  }
  return res.status(200).json({ ok: true });
}
