import { stripeStatus, stripeClient, normalizeSettings } from '../lib/booking.js';
import { getSettings, confirmHold, insertBooking, upsertCustomer, bookingExistsForPI, setCustomerNote,
         recordConsent, clientIp } from '../lib/db.js';

// Called by the booking site the moment a payment succeeds. It re-verifies the PaymentIntent with
// Stripe (so it can't be spoofed), then turns the customer's live cart hold into a confirmed booking
// and saves the customer. This makes bookings work without relying on a Stripe webhook; if a webhook
// IS configured it stays a backup — bookingExistsForPI keeps the two from double-booking.
export default async function handler(req, res) {
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
  if (pi.status !== 'succeeded') return res.status(400).json({ ok: false, error: 'Payment is not complete.' });

  const md = pi.metadata || {};
  if (!md.dateISO || !md.bayId) return res.status(400).json({ ok: false, error: 'Booking details missing on the payment.' });

  // Already saved (webhook or a retry got here first)? Nothing more to do.
  if (await bookingExistsForPI(pi.id)) {
    await upsertCustomer({ name, email, phone, smsOptIn: typeof sms === 'boolean' ? sms : undefined });
    await saveSmsConsent(req, { name, email, phone, smsConsent });
    await setCustomerNote({ paymentIntentId: pi.id, note, onlyIfEmpty: true });   // the webhook saved it without the note
    return res.status(200).json({ ok: true, already: true });
  }

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
  await setCustomerNote({ bookingId, note });
  await upsertCustomer({ name: n, email: e, phone: p, smsOptIn: typeof sms === 'boolean' ? sms : undefined });
  await saveSmsConsent(req, { name: n, email: e, phone: p, smsConsent });

  // Loyalty points are retired: nothing is spent and nothing is earned here any more. Gift cards
  // and promo codes are still settled by api/webhook.js, exactly as before.
  return res.status(200).json({ ok: true });
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
