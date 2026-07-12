import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  priceForBooking, summaryFor, stripeStatus, normalizeSettings, bayName, fmtMin, hoursUntilBooking,
  overrideEffects, overrideConflicts, weeklyStatusBlocked, weeklyStatusConflicts, pointsRedemption, pointsEarned,
} from './lib/booking.js';
import { getSettings, getBookingsForDate, getOverridesForDate, insertBooking, dbEnabled, admin,
  createHold, releaseHold, confirmHold, cleanupExpiredHolds, upsertCustomer,
  customerHoursByContact, bookingExistsForPI, adjustPoints, awardBookingPoints } from './lib/db.js';
import signWaiver from './api/sign-waiver.js';
import confirmBooking from './api/confirm-booking.js';
import membership from './api/membership.js';
import hourCards from './api/hour-cards.js';
import points from './api/points.js';
import bookingSelfService from './api/booking.js';

// Local dev server. On Vercel the same logic runs as serverless functions in /api.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { PORT = 4242, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

const { enabled: stripeEnabled, hasLive, secretKey, publishableKey } = stripeStatus(process.env);
const stripe = stripeEnabled ? new Stripe(secretKey) : null;

if (hasLive) {
  console.error('\n⛔  LIVE Stripe keys detected in .env — refusing to start Stripe.');
  console.error('   This is a prototype: use TEST keys (sk_test_ / rk_test_ / pk_test_) only.\n');
} else if (!stripeEnabled) {
  console.warn('\n⚠  Stripe keys not set — running in SIMULATED checkout mode.\n');
}
console.log(dbEnabled ? '🗄  Supabase connected — live settings & bookings.' : '🗄  Supabase not set — using built-in demo data.');

const app = express();

// Webhook needs the raw body, so register it BEFORE express.json().
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripeEnabled) return res.json({ received: true });
  let event;
  if (STRIPE_WEBHOOK_SECRET) {
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    event = JSON.parse(req.body.toString());
  }
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const md = pi.metadata || {};
    if (md.dateISO && md.bayId) {
      let name = null, email = pi.receipt_email || null, phone = null;
      try {
        if (pi.latest_charge) {
          const ch = await stripe.charges.retrieve(pi.latest_charge);
          const bd = ch.billing_details || {};
          name = bd.name || null; email = email || bd.email || null; phone = bd.phone || null;
        }
      } catch (_) {}
      if (await bookingExistsForPI(pi.id)) { res.json({ received: true }); return; }   // client confirm beat us
      const settings = normalizeSettings(await getSettings());
      const slot = { dateISO: md.dateISO, bayId: md.bayId, startMin: Number(md.startMin), endMin: Number(md.endMin) };
      const patch = { status_label: settings.onlineStatusLabel || null, customer_name: name, customer_email: email, customer_phone: phone,
        amount_cents: pi.amount, stripe_payment_intent: pi.id, source: 'online' };
      // Prefer flipping the customer's live cart hold → confirmed; fall back to a fresh insert if it lapsed.
      const flip = await confirmHold({ ...slot, patch });
      let error = flip.error || null;
      let bookingId = flip.id;
      if (!flip.updated) {
        const ins = await insertBooking({ bay_id: slot.bayId, booking_date: slot.dateISO, start_min: slot.startMin, end_min: slot.endMin, status: 'confirmed', ...patch });
        error = ins.error;
        bookingId = ins.id;
      }
      console.log(error ? `⚠ Booking save failed: ${error}` : `✅ Booking PAID & saved — ${md.summary}`);
      const up = await upsertCustomer({ name, email, phone });   // save the booker into the customer database
      // Loyalty: spend applied points (idempotent by PI id) + earn for time played (once per booking).
      const spent = Number(md.pointsUsed) || 0;
      if (!error && spent > 0 && md.pointsCustomerId) await adjustPoints({ customerId: md.pointsCustomerId, delta: -spent, kind: 'redeem', note: `Booking ${slot.dateISO}`, bookingId, ref: pi.id });
      if (!error && up.id && bookingId) await awardBookingPoints({ customerId: up.id, bookingId, points: pointsEarned(settings, slot.endMin - slot.startMin) });
    }
  }
  res.json({ received: true });
});

app.use(express.json());

// /admin → manager portal, /manage → customer self-service, /waiver → participant waiver
// (before static so clean URLs work)
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'demo', 'admin.html')));
app.get('/manage', (_req, res) => res.sendFile(path.join(__dirname, 'demo', 'manage.html')));
app.get('/waiver', (_req, res) => res.sendFile(path.join(__dirname, 'demo', 'waiver.html')));
app.get('/membership', (_req, res) => res.sendFile(path.join(__dirname, 'demo', 'membership.html')));
app.get('/hours', (_req, res) => res.sendFile(path.join(__dirname, 'demo', 'hours.html')));
app.get('/account', (_req, res) => res.sendFile(path.join(__dirname, 'demo', 'account.html')));
app.use(express.static(path.join(__dirname, 'demo')));

// Waiver signing + booking confirmation + membership purchase (same handlers the Vercel functions use).
app.all('/api/sign-waiver', (req, res) => signWaiver(req, res));
app.all('/api/confirm-booking', (req, res) => confirmBooking(req, res));
app.all('/api/membership', (req, res) => membership(req, res));
app.all('/api/hour-cards', (req, res) => hourCards(req, res));
app.all('/api/points', (req, res) => points(req, res));

// Customer booking lookup (GET) + self-service cancellation (POST) — shared module handler.
app.all('/api/booking', (req, res) => bookingSelfService(req, res));
app.post('/api/cancel-booking', (req, res) => bookingSelfService(req, res));   // legacy path

app.get('/api/config', (_req, res) => {
  res.json({
    stripeEnabled,
    publishableKey: stripeEnabled ? publishableKey : null,
    dbEnabled,
    supabase: SUPABASE_URL && SUPABASE_ANON_KEY ? { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY } : null,
  });
});

app.get('/api/availability', async (req, res) => {
  const row = await getSettings();
  if (!row) return res.json({ dbEnabled: false });
  const settings = normalizeSettings(row);
  const dateISO = req.query.date || '';
  const booked = {};
  const closed = {};
  const held = {};      // live cart holds — shown to other users as "Held"
  let dateHours = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    await cleanupExpiredHolds();
    for (const b of await getBookingsForDate(dateISO)) {
      (booked[b.bay_id] ||= []).push([b.start_min, b.end_min]);
      if (b.status === 'held') (held[b.bay_id] ||= []).push([b.start_min, b.end_min]);
    }
    const overrides = await getOverridesForDate(dateISO);
    const fx = overrideEffects(overrides, settings, dateISO);
    dateHours = fx.dateHours;
    for (const [bayId, ranges] of Object.entries(fx.blocked)) for (const r of ranges) (booked[bayId] ||= []).push(r);
    for (const [bayId, ranges] of Object.entries(weeklyStatusBlocked(settings, overrides, dateISO)))
      for (const r of ranges) { (booked[bayId] ||= []).push(r); (closed[bayId] ||= []).push(r); }
  }
  res.json({
    dbEnabled: true,
    settings: {
      bays: settings.bays.filter((b) => !b.holding), hours: settings.hours, slotStep: settings.slotStep,
      minMins: settings.minMins, maxParty: settings.maxParty, peakStartHour: settings.peakStartHour,
      rates: settings.rates, bayRates: settings.bayRates,
    },
    dateHours,
    booked,
    closed,
    held,
  });
});

app.post('/api/create-payment-intent', async (req, res) => {
  if (!stripeEnabled) return res.status(503).json({ error: 'Stripe not configured' });
  try {
    const { dateISO, bayId, startMin, endMin, party, hold } = req.body;
    const settings = normalizeSettings(await getSettings());
    const overrides = await getOverridesForDate(dateISO);
    const fx = overrideEffects(overrides, settings, dateISO);
    const amount = priceForBooking({ settings, dateISO, bayId, startMin, endMin, dateHours: fx.dateHours });
    const players = Math.min(Math.max(parseInt(party, 10) || 1, 1), settings.maxParty);
    const conflict = (await getBookingsForDate(dateISO))
      .some((b) => b.status !== 'held' && b.bay_id === bayId && Number(startMin) < b.end_min && Number(endMin) > b.start_min);
    if (conflict) return res.status(409).json({ error: 'That time was just booked — pick another slot.' });
    if (overrideConflicts(fx, settings, dateISO, bayId, Number(startMin), Number(endMin)) ||
        weeklyStatusConflicts(settings, overrides, dateISO, bayId, Number(startMin), Number(endMin))) {
      return res.status(409).json({ error: 'That time is unavailable — pick another slot.' });
    }
    let expiresAt = null;
    if (hold) {
      const h = await createHold({ dateISO, bayId, startMin: Number(startMin), endMin: Number(endMin) });
      if (h.conflict) return res.status(409).json({ error: 'That time was just taken — pick another slot.' });
      if (h.error) return res.status(500).json({ error: h.error });
      expiresAt = h.expiresAt;
    }
    // Loyalty points as dollars off (deducted for real on payment success — see the webhook/confirm).
    // partialOnly: a charge must remain on this card path — full-cover balances get the max
    // discount (50¢ minimum charge) instead of being silently ignored.
    let charge = amount, pointsUsed = 0, pointsCustomerId = '';
    if (req.body.applyPoints) {
      const cust = await customerHoursByContact({ email: req.body.email, phone: req.body.phone });
      const r = pointsRedemption(settings, (cust && cust.points_balance) || 0, amount, { partialOnly: true });
      if (cust && r.pointsUsed > 0) { charge = amount - r.discountCents; pointsUsed = r.pointsUsed; pointsCustomerId = cust.id; }
    }
    const pi = await stripe.paymentIntents.create({
      amount: charge, currency: settings.currency,
      automatic_payment_methods: { enabled: true },
      description: `${bayName(settings, bayId)} — simulator session`,
      metadata: {
        bayId, bayName: bayName(settings, bayId), dateISO, startMin: String(startMin), endMin: String(endMin),
        players: String(players), summary: summaryFor({ dateISO, startMin, endMin, players }),
        pointsUsed: String(pointsUsed), pointsCustomerId,
      },
    });
    res.json({ clientSecret: pi.client_secret, amount: charge, fullAmount: amount, pointsUsed, expiresAt });
  } catch (err) {
    console.error('create-payment-intent:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Release a cart hold (checkout closed/abandoned before payment). Best-effort — the 5-min TTL is the backstop.
app.post('/api/release-hold', async (req, res) => {
  const { dateISO, bayId, startMin, endMin } = req.body || {};
  if (dateISO && bayId) await releaseHold({ dateISO, bayId, startMin: Number(startMin), endMin: Number(endMin) });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n🏌  Joy House Golf booking demo running at  http://localhost:${PORT}`);
  console.log(`    Manager portal:  http://localhost:${PORT}/admin\n`);
});
