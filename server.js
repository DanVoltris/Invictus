import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  priceForBooking, summaryFor, stripeStatus, normalizeSettings, bayName, fmtMin, hoursUntilBooking,
  overrideEffects, overrideConflicts, weeklyStatusBlocked, weeklyStatusConflicts,
} from './lib/booking.js';
import { getSettings, getBookingsForDate, getOverridesForDate, insertBooking, dbEnabled, admin,
  createHold, releaseHold, confirmHold, cleanupExpiredHolds, upsertCustomer } from './lib/db.js';
import signWaiver from './api/sign-waiver.js';
import saveCustomer from './api/save-customer.js';

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
      const onlineLabel = normalizeSettings(await getSettings()).onlineStatusLabel;
      const slot = { dateISO: md.dateISO, bayId: md.bayId, startMin: Number(md.startMin), endMin: Number(md.endMin) };
      const patch = { status_label: onlineLabel || null, customer_name: name, customer_email: email, customer_phone: phone,
        amount_cents: pi.amount, stripe_payment_intent: pi.id, source: 'online' };
      // Prefer flipping the customer's live cart hold → confirmed; fall back to a fresh insert if it lapsed.
      const flip = await confirmHold({ ...slot, patch });
      let error = flip.error || null;
      if (!flip.updated) {
        const ins = await insertBooking({ bay_id: slot.bayId, booking_date: slot.dateISO, start_min: slot.startMin, end_min: slot.endMin, status: 'confirmed', ...patch });
        error = ins.error;
      }
      console.log(error ? `⚠ Booking save failed: ${error}` : `✅ Booking PAID & saved — ${md.summary}`);
      await upsertCustomer({ name, email, phone });   // save the booker into the customer database
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
app.use(express.static(path.join(__dirname, 'demo')));

// Waiver signing + customer save (same handlers the Vercel functions use).
app.all('/api/sign-waiver', (req, res) => signWaiver(req, res));
app.all('/api/save-customer', (req, res) => saveCustomer(req, res));

// Customer booking lookup + self-service cancellation (24-hour policy enforced server-side).
app.get('/api/booking', async (req, res) => {
  const id = req.query.id || '';
  if (!/^[0-9a-fA-F-]{10,}$/.test(id)) return res.status(400).json({ ok: false, error: 'Invalid link.' });
  const db = admin();
  if (!db) return res.status(503).json({ ok: false, error: 'Not configured.' });
  const { data, error } = await db.from('bookings')
    .select('id,bay_id,booking_date,start_min,end_min,status,customer_name').eq('id', id).maybeSingle();
  if (error || !data) return res.status(404).json({ ok: false, error: 'Booking not found.' });
  const settings = normalizeSettings(await getSettings());
  const hoursUntil = hoursUntilBooking(data.booking_date, data.start_min);
  res.json({ ok: true, booking: {
    id: data.id, bay: bayName(settings, data.bay_id) || data.bay_id, booking_date: data.booking_date,
    start: fmtMin(data.start_min), end: fmtMin(data.end_min), status: data.status,
    customerName: data.customer_name || null, hoursUntil, canCancel: data.status === 'confirmed' && hoursUntil >= 24,
  } });
});

app.post('/api/cancel-booking', async (req, res) => {
  const id = (req.body && req.body.id) || '';
  if (!/^[0-9a-fA-F-]{10,}$/.test(id)) return res.status(400).json({ ok: false, error: 'Invalid request.' });
  const db = admin();
  if (!db) return res.status(503).json({ ok: false, error: 'Not configured.' });
  const { data, error } = await db.from('bookings').select('id,booking_date,start_min,status').eq('id', id).maybeSingle();
  if (error || !data) return res.status(404).json({ ok: false, error: 'Booking not found.' });
  if (data.status === 'cancelled') return res.json({ ok: true, already: true });
  if (data.status !== 'confirmed') return res.status(400).json({ ok: false, error: "This booking can't be cancelled online." });
  if (hoursUntilBooking(data.booking_date, data.start_min) < 24) {
    return res.status(403).json({ ok: false, code: 'too_late', error: 'Cancellations must be made at least 24 hours before your tee time. Please call the shop to cancel.' });
  }
  let upd = await db.from('bookings').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', id);
  if (upd.error && /cancelled_at/.test(upd.error.message || '')) {
    upd = await db.from('bookings').update({ status: 'cancelled' }).eq('id', id);
  }
  if (upd.error) return res.status(500).json({ ok: false, error: upd.error.message });
  res.json({ ok: true });
});

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
    const pi = await stripe.paymentIntents.create({
      amount, currency: settings.currency,
      automatic_payment_methods: { enabled: true },
      description: `${bayName(settings, bayId)} — simulator session`,
      metadata: {
        bayId, bayName: bayName(settings, bayId), dateISO, startMin: String(startMin), endMin: String(endMin),
        players: String(players), summary: summaryFor({ dateISO, startMin, endMin, players }),
      },
    });
    res.json({ clientSecret: pi.client_secret, amount, expiresAt });
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
