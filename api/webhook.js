import Stripe from 'stripe';
import { stripeStatus, normalizeSettings, pointsEarned } from '../lib/booking.js';
import { insertBooking, getSettings, confirmHold, upsertCustomer, bookingExistsForPI, adjustPoints, awardBookingPoints } from '../lib/db.js';

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
  const { enabled, secretKey } = stripeStatus(process.env);
  if (!enabled) return res.status(200).json({ received: true });

  const stripe = new Stripe(secretKey);
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (whsec) {
      const raw = req.body && Buffer.isBuffer(req.body) ? req.body : await readRaw(req);
      event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], whsec);
    } else {
      // No signing secret configured — accept the parsed event (fine for a test-mode prototype).
      event = req.body && req.body.type ? req.body : JSON.parse((await readRaw(req)).toString());
    }
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

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
      if (await bookingExistsForPI(pi.id)) { res.status(200).json({ received: true }); return; }

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
    }
  }
  res.status(200).json({ received: true });
}
