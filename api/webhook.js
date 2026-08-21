import { stripeStatus, stripeClient, normalizeSettings, pointsEarned } from '../lib/booking.js';
import { insertBooking, getSettings, confirmHold, upsertCustomer, bookingExistsForPI, adjustPoints, awardBookingPoints,
  recordStripeEvent, forgetStripeEvent } from '../lib/db.js';
import { notifyBookingConfirmed } from '../lib/notify.js';

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Source of truth: only record a confirmed booking here, never on the client redirect.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(200).json({ received: true });

  const stripe = stripeClient(process.env);
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  // Local dev mounts this behind express.raw(), which hands us a Buffer and leaves the request
  // stream drained — readRaw() would never resolve, so always prefer the Buffer when there is one.
  const buf = req.body && Buffer.isBuffer(req.body) ? req.body : null;
  let event;
  try {
    if (whsec) {
      event = stripe.webhooks.constructEvent(buf || await readRaw(req), req.headers['stripe-signature'], whsec);
    } else {
      // No signing secret configured — accept the parsed event (fine for a test-mode prototype).
      if (buf) event = JSON.parse(buf.toString());
      else event = req.body && req.body.type ? req.body : JSON.parse((await readRaw(req)).toString());
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Global idempotency. Stripe retries until it gets a 2xx and can also deliver the same event
  // twice on purpose, so claim the event id before doing any work: a duplicate delivery loses the
  // insert with a unique violation and is acknowledged without repeating the fulfilment. This sits
  // ALONGSIDE bookingExistsForPI rather than replacing it — the client-side confirm path doesn't
  // go through here at all, and a database still on migration 0017 has no stripe_events table, in
  // which case this reports unsupported and the per-booking guard carries the load on its own.
  const claim = await recordStripeEvent(event.id);
  if (claim.duplicate) {
    console.log(`↩︎ Webhook ${event.id} already handled — skipping.`);
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    await fulfil(event, stripe);
  } catch (err) {
    // The claim is only valid if the work behind it finished. Release it so Stripe's retry is
    // treated as a first attempt instead of a duplicate of an attempt that never completed.
    if (claim.recorded) await forgetStripeEvent(event.id);
    console.error('Webhook fulfilment failed:', err && err.message ? err.message : err);
    return res.status(500).json({ received: false });
  }
  res.status(200).json({ received: true });
}

// Everything a successful payment causes: the booking row, the customer, loyalty points and the
// confirmation message. Split out of the handler so a failure anywhere in it can release the
// event claim above.
async function fulfil(event, stripe) {
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const md = pi.metadata || {};
    if (md.dateISO && md.bayId) {
      // Pull the customer's contact info from the charge's billing details.
      let name = null, email = pi.receipt_email || null, phone = null;
      try {
        if (pi.latest_charge) {
          const ch = await stripe.charges.retrieve(pi.latest_charge);
          const bd = ch.billing_details || {};
          name = bd.name || null;
          email = email || bd.email || null;
          phone = bd.phone || null;
        }
      } catch (_) { /* best-effort */ }

      // The client-side confirm usually saved this already — the webhook is the backup path.
      if (await bookingExistsForPI(pi.id)) return;

      const settings = normalizeSettings(await getSettings());
      const slot = { dateISO: md.dateISO, bayId: md.bayId, startMin: Number(md.startMin), endMin: Number(md.endMin) };
      const patch = {
        status_label: settings.onlineStatusLabel || null,   // workflow label for a self-booked online reservation
        customer_name: name,
        customer_email: email,
        customer_phone: phone,
        amount_cents: pi.amount,
        stripe_payment_intent: pi.id,
        source: 'online',
      };
      // Prefer flipping the customer's live cart hold → confirmed; fall back to a fresh insert if it lapsed.
      const flip = await confirmHold({ ...slot, patch });
      let error = flip.error || null;
      let bookingId = flip.id;
      if (!flip.updated) {
        const ins = await insertBooking({ bay_id: slot.bayId, booking_date: slot.dateISO, start_min: slot.startMin, end_min: slot.endMin, status: 'confirmed', ...patch });
        error = ins.error;
        bookingId = ins.id;
      }
      console.log(error
        ? `⚠ Booking save failed (${md.summary}): ${error}`
        : `✅ Booking PAID & saved — ${md.bayName} · ${md.summary}`);
      // Save the booker into the customer database (contact only; the SMS toggle is set at pay time).
      const up = await upsertCustomer({ name, email, phone });
      // Loyalty: spend applied points (idempotent by PI id) + earn for time played (once per booking).
      const spent = Number(md.pointsUsed) || 0;
      if (!error && spent > 0 && md.pointsCustomerId) {
        await adjustPoints({ customerId: md.pointsCustomerId, delta: -spent, kind: 'redeem', note: `Booking ${slot.dateISO}`, bookingId, ref: pi.id });
      }
      if (!error && up.id && bookingId) {
        await awardBookingPoints({ customerId: up.id, bookingId, points: pointsEarned(settings, slot.endMin - slot.startMin) });
      }
      // Tell the customer. Queued in the outbox keyed on the booking, so the client-side confirm
      // enqueuing the same receipt cannot produce a second one; delivery is best-effort and can
      // never fail a payment that has already been taken (see lib/notify.js).
      if (!error) {
        await notifyBookingConfirmed({
          bookingId, dateISO: slot.dateISO, bayId: slot.bayId, bayName: md.bayName,
          startMin: slot.startMin, endMin: slot.endMin, players: Number(md.players) || null,
          amountCents: pi.amount, name, email, phone, customerId: up.id || null,
        });
      }
    }
  }
}
