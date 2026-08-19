import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripeStatus, normalizeSettings, fmtMin, hoursUntilBooking,
  overrideEffects, weeklyStatusBlocked, pointsRedemption,
} from './lib/booking.js';
import { getSettings, getBookingsForDate, getOverridesForDate, dbEnabled, admin,
  releaseHold, cleanupExpiredHolds } from './lib/db.js';
import signWaiver from './api/sign-waiver.js';
import confirmBooking from './api/confirm-booking.js';
import membership from './api/membership.js';
import hourCards from './api/hour-cards.js';
import points from './api/points.js';
import bookingSelfService from './api/booking.js';
import createPaymentIntent from './api/create-payment-intent.js';
import webhook from './api/webhook.js';

// Local dev server. On Vercel the same logic runs as serverless functions in /api.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { PORT = 4242, SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

// Startup banner + /api/config only. The Stripe client itself lives in the api/ handlers.
const { enabled: stripeEnabled, hasLive, publishableKey } = stripeStatus(process.env);

if (hasLive) {
  console.error('\n⛔  LIVE Stripe keys detected in .env — refusing to start Stripe.');
  console.error('   This is a prototype: use TEST keys (sk_test_ / rk_test_ / pk_test_) only.\n');
} else if (!stripeEnabled) {
  console.warn('\n⚠  Stripe keys not set — running in SIMULATED checkout mode.\n');
}
console.log(dbEnabled ? '🗄  Supabase connected — live settings & bookings.' : '🗄  Supabase not set — using built-in demo data.');

const app = express();

// Webhook needs the raw body for signature verification, so register it — with express.raw() —
// BEFORE express.json(). Same shared handler the Vercel function uses.
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => webhook(req, res));

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

// PaymentIntent creation (pricing, availability, cart hold, member/points discount) — shared module handler.
app.all('/api/create-payment-intent', (req, res) => createPaymentIntent(req, res));

// Release a cart hold (checkout closed/abandoned before payment). Best-effort — the 5-min TTL is the backstop.
app.post('/api/release-hold', async (req, res) => {
  const { dateISO, bayId, startMin, endMin } = req.body || {};
  if (dateISO && bayId) await releaseHold({ dateISO, bayId, startMin: Number(startMin), endMin: Number(endMin) });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n🏌  Invictus Golf booking demo running at  http://localhost:${PORT}`);
  console.log(`    Manager portal:  http://localhost:${PORT}/admin\n`);
});
