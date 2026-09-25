import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  stripeStatus, normalizeSettings, fmtMin, hoursUntilBooking,
  overrideEffects, weeklyStatusBlocked,
} from './lib/booking.js';
import { getSettings, dbEnabled, admin,
  customerHoursByContact, normPhone, upsertCustomer, saveBookingFeedback,
  leaguesForCustomer, isLeaguePlayer } from './lib/db.js';
import leagues from './api/leagues.js';
import hourCards from './api/hour-cards.js';
import giftCards from './api/gift-cards.js';
import promos from './api/promos.js';
import waitlist from './api/waitlist.js';
import bookingSeries from './api/booking-series.js';
import bookingSelfService from './api/booking.js';
import account from './api/account.js';
import staff from './api/staff.js';
// The two merged handlers. api/public.js answers /api/config and /api/availability; api/checkout.js
// answers /api/create-payment-intent, /api/confirm-booking and /api/release-hold; the waiver is an
// action on api/account.js. Vercel reaches them through the rewrites in vercel.json; this file
// reaches the SAME dispatcher by naming the action in a third argument. Nothing is copied here.
import publicApi from './api/public.js';
import checkout from './api/checkout.js';
import webhook from './api/webhook.js';

// Local dev server. On Vercel the same logic runs as serverless functions in /api.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { PORT = 4242 } = process.env;

// Startup banner only. The Stripe client, and the answer /api/config gives, both live in api/.
const { enabled: stripeEnabled, hasLive } = stripeStatus(process.env);

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
app.get('/leagues', (_req, res) => res.sendFile(path.join(__dirname, 'demo', 'leagues.html')));
app.get('/membership', (_req, res) => res.redirect(301, '/leagues'));   // memberships were replaced by leagues
app.get('/hours', (_req, res) => res.sendFile(path.join(__dirname, 'demo', 'hours.html')));
app.get('/account', (_req, res) => res.sendFile(path.join(__dirname, 'demo', 'account.html')));
// /gift-cards is where api/gift-cards.js sends a buyer back to after Stripe Checkout. The page
// itself belongs to the Customer UI agent and does not exist yet, so serve it only if it is there
// — otherwise fall through to a clean 404 rather than a sendFile ENOENT 500.
app.get('/gift-cards', (_req, res, next) => {
  const page = path.join(__dirname, 'demo', 'gift-cards.html');
  return existsSync(page) ? res.sendFile(page) : next();
});
// /waitlist is where an offer message sends the customer to claim their slot. Same story as
// /gift-cards above: the page is the Customer UI agent's, so serve it only if it exists.
app.get('/waitlist', (_req, res, next) => {
  const page = path.join(__dirname, 'demo', 'waitlist.html');
  return existsSync(page) ? res.sendFile(page) : next();
});
app.use(express.static(path.join(__dirname, 'demo')));

// LOCAL ONLY: the booking page on localhost books as the no-login dev account when it sends
// X-Dev-Account, so the league window applies to it (same rule as /api/create-payment-intent below).
// This is registered BEFORE the routes it covers: Express runs middleware and routes in the order
// they were added, so a route mounted first would never see the marker. /api/leagues and
// /api/booking are on the list so the dev account can buy a team and book its weekly round.
app.use(['/api/hour-cards', '/api/gift-cards', '/api/waitlist', '/api/leagues', '/api/booking'], (req, _res, next) => {
  if (devAccountPhone(req) && req.get('x-dev-account') === '1') req.devAccountPhone = process.env.DEV_ACCOUNT_PHONE;
  next();
});

// Waiver signing + booking confirmation + league purchases (same handlers the Vercel functions use).
// The waiver now lives inside api/account.js and confirmation inside api/checkout.js; both are
// reached here by the same ?action= the vercel.json rewrite uses, so the URL is all that's shared.
app.all('/api/sign-waiver', (req, res) => account(req, res, 'waiver'));
app.all('/api/confirm-booking', (req, res) => checkout(req, res, 'confirm-booking'));
// Leagues: buy a team, invite a friend, claim an invite, my teams — dispatches on ?action=.
app.all('/api/leagues', (req, res) => leagues(req, res));
app.all('/api/hour-cards', (req, res) => hourCards(req, res));
// Gift cards (buy, check a balance, apply at checkout) and promo codes (validate, reserve,
// release, redeem). Both dispatch on ?action= — see the header of each handler.
app.all('/api/gift-cards', (req, res) => giftCards(req, res));
app.all('/api/promos', (req, res) => promos(req, res));
// Waiting list (join, leave, claim an offer, and the pg_cron sweep) — dispatches on ?action=.
// ?action=outbox on the same handler is the notification outbox's own scheduled drain; it is
// mounted here rather than on a route of its own so the local server and the Vercel function
// answer the identical URL. Try it with:
//   curl -XPOST -H "x-outbox-secret: $OUTBOX_SWEEP_SECRET" 'localhost:4242/api/waitlist?action=outbox'
// ?action=sms-reply on the same handler is Twilio's INBOUND webhook — a customer texting STOP,
// START or HELP back. Twilio posts application/x-www-form-urlencoded, which express.json() above
// ignores, so that one content type gets its own parser here; a JSON body is untouched by it.
// Vercel parses the same form body for the function without any of this.
app.use('/api/waitlist', express.urlencoded({ extended: false }));
app.all('/api/waitlist', (req, res) => waitlist(req, res));

// Group + recurring bookings (preview, create, extend the horizon, cancel, end, move) —
// dispatches on ?action=. A group is a series of one; see the header of the handler.
app.all('/api/booking-series', (req, res) => bookingSeries(req, res));

// Customer booking lookup (GET) + self-service cancellation (POST) — shared module handler.
// ?action=league-round on the same handler books a team's free weekly round (migration 0031).
app.all('/api/account', (req, res) => account(req, res));
app.all('/api/staff', (req, res) => staff(req, res));
app.all('/api/booking', (req, res) => bookingSelfService(req, res));
app.post('/api/cancel-booking', (req, res) => bookingSelfService(req, res));   // legacy path

// What the browser needs to boot (Stripe + public Supabase config). This route used to hold its
// own copy of that JSON; it now delegates to api/public.js, the same code Vercel runs.
app.all('/api/config', (req, res) => publicApi(req, res, 'config'));

// Public availability. Delegates to the SAME handler Vercel runs (api/public.js ?action=availability)
// instead of keeping a second copy here: this route used to be duplicated, and the copies drifted —
// the shared one learned to tell customers why a time is unavailable while this one silently did
// not, so the feature worked in tests and not in the browser.
app.all('/api/availability', (req, res) => publicApi(req, res, 'availability'));

// The merged handlers on their OWN paths too, so this server answers everything Vercel answers.
// On Vercel these two files ARE /api/public and /api/checkout; the old paths above are rewrites
// onto them (vercel.json). Mounting them here keeps the dev server and production identical and
// exercises the same ?action= dispatch the rewrites use.
app.all('/api/public', (req, res) => publicApi(req, res));
app.all('/api/checkout', (req, res) => checkout(req, res));

// PaymentIntent creation (pricing, availability, cart hold, promo + gift card) — shared module handler.
app.all('/api/create-payment-intent', (req, res) => {
  // LOCAL ONLY: the booking page on localhost checks out as the no-login dev account (see below),
  // so its league booking window applies (lib/db.js leaguePlayerForRequest). Vercel never runs this
  // file; req.devAccountPhone is set nowhere else.
  const devPhone = devAccountPhone(req);
  if (devPhone && req.get('x-dev-account') === '1') req.devAccountPhone = process.env.DEV_ACCOUNT_PHONE;
  return checkout(req, res, 'create-payment-intent');
});

// Release a cart hold (checkout closed/abandoned before payment). Best-effort — the 5-min TTL is
// the backstop. This route used to hold its own copy of that logic; it now delegates to
// api/checkout.js, so local and production cannot drift apart.
app.all('/api/release-hold', (req, res) => checkout(req, res, 'release-hold'));

// LOCAL ONLY: "My Account" without signing in, always as the customer in DEV_ACCOUNT_PHONE.
// This route exists only in this dev server. Vercel runs the /api/*.js functions and never this
// file, so it cannot reach the live site. It is also off unless .env sets DEV_ACCOUNT_PHONE, and
// it refuses any request that does not come from this machine.
// The dev customer's phone when this request may use the no-login account, else null.
function devAccountPhone(req) {
  return isLocal(req) ? normPhone(process.env.DEV_ACCOUNT_PHONE) : null;
}
// True only for a request whose peer is this machine. Every dev-only route below is gated on it.
function isLocal(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}
app.get('/api/dev/my-account', async (req, res) => {
  const phone = devAccountPhone(req);
  if (!phone) return res.status(404).json({ error: 'Not found.' });
  const db = admin();
  if (!db) return res.status(503).json({ error: 'No database configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.' });

  // The customer, found by phone exactly as checkout finds them. No record yet: a blank account.
  const c = await customerHoursByContact({ phone }) || {};
  const customer = {
    name: c.name || process.env.DEV_ACCOUNT_NAME || null, email: c.email || null, phone: c.phone || process.env.DEV_ACCOUNT_PHONE,
    hours_balance_min: c.hours_balance_min || 0,
    membership_id: c.membership_id || null, membership_expires: c.membership_expires || null,
    waiver_signed_at: c.waiver_signed_at || null, address: c.address || null, career: c.career || null,
  };

  // Bookings keep the phone as it was typed, not a customer id, so match the same way the
  // customer lookup does: narrow on the last four digits in the database, compare in full here.
  const { data, error } = await db.from('bookings')
    .select('id,group_id,booking_date,start_min,end_min,bay_id,status,status_label,amount_cents,customer_phone')
    .like('customer_phone', `%${phone.slice(-4)}%`)
    .order('booking_date', { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: `Could not read bookings: ${error.message}` });
  const bookings = (data || []).filter((b) => normPhone(b.customer_phone) === phone).slice(0, 50)
    .map(({ customer_phone, ...b }) => b);
  // Which of these already have feedback, so My Account asks about the rest (migration 0027).
  let answered = [];
  if (bookings.length) {
    const fb = await db.from('booking_feedback').select('booking_id').in('booking_id', bookings.map((b) => b.id));
    answered = fb.error ? [] : (fb.data || []).map((r) => r.booking_id);
  }
  const bays = Object.fromEntries((normalizeSettings(await getSettings()).bays || []).map((b) => [b.id, b.name]));
  res.json({ ok: true, customer, bookings, answered, leagues: c.id ? await leaguesForCustomer(c.id) : [], bays });
});

// The booking page's date picker: how far ahead the dev customer may book (migration 0028).
// LOCAL ONLY: open the manager portal without signing in, as a real staff member.
// Same shape as the customer dev account above: localhost peers only, and this route lives in
// server.js, which Vercel never runs. It mints a single-use magic-link token with the service-role
// key; the portal exchanges it for a normal session, so RLS and the staff role apply exactly as
// they would after a hand-typed sign-in. An employee login stays an employee login.
// Which account: DEV_STAFF_EMAIL if set, else the first active admin in the staff table.
app.get('/api/dev/staff-session', async (req, res) => {
  if (!isLocal(req)) return res.status(404).json({ error: 'Not found.' });
  const db = admin();
  if (!db) return res.status(503).json({ error: 'Database not configured.' });
  let email = (process.env.DEV_STAFF_EMAIL || '').trim().toLowerCase();
  if (!email) {
    const { data } = await db.from('staff').select('email,role,is_active').eq('is_active', true).eq('role', 'admin').order('created_at').limit(1);
    email = ((data || [])[0] || {}).email || '';
  }
  if (!email) return res.status(404).json({ error: 'No active admin to sign in as. Set DEV_STAFF_EMAIL in .env.' });
  const { data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) return res.status(500).json({ error: error.message });
  const tokenHash = (data && data.properties && data.properties.hashed_token) || null;
  if (!tokenHash) return res.status(500).json({ error: 'Could not mint a local sign-in.' });
  res.json({ ok: true, email, tokenHash });
});

app.get('/api/dev/window', async (req, res) => {
  const phone = devAccountPhone(req);
  if (!phone) return res.status(404).json({ error: 'Not found.' });
  const settings = normalizeSettings(await getSettings());
  const league = await isLeaguePlayer({ phone });
  res.json({ ok: true, league, phone: process.env.DEV_ACCOUNT_PHONE, leagueDays: settings.bookingWindow.leagueDays,
    days: league ? settings.bookingWindow.leagueDays : settings.bookingWindow.regularDays });
});

app.post('/api/dev/my-account/feedback', async (req, res) => {
  const phone = devAccountPhone(req);
  if (!phone) return res.status(404).json({ error: 'Not found.' });
  const c = await customerHoursByContact({ phone });
  const b = req.body || {};
  const r = await saveBookingFeedback({ contact: { phone }, customerId: (c && c.id) || null,
    bookingId: b.bookingId, rating: b.rating, comment: b.comment, skipped: b.skipped });
  return r.ok ? res.json(r) : res.status(r.code || 400).json({ error: r.error });
});

// Saved cards are retired, so the dev account's /api/dev/my-account/cards route is gone with them;
// the path now 404s like any other unknown one.

app.post('/api/dev/my-account/profile', async (req, res) => {
  const phone = devAccountPhone(req);
  if (!phone) return res.status(404).json({ error: 'Not found.' });
  const db = admin();
  if (!db) return res.status(503).json({ error: 'No database configured.' });
  const up = await upsertCustomer({ name: process.env.DEV_ACCOUNT_NAME, phone: process.env.DEV_ACCOUNT_PHONE });
  if (!up.id) return res.status(500).json({ error: `Could not find or create the customer record: ${up.error || 'unknown'}` });
  const patch = {
    address: String((req.body || {}).address || '').trim().slice(0, 200) || null,
    career: String((req.body || {}).career || '').trim().slice(0, 120) || null,
  };
  const { error } = await db.from('customers').update(patch).eq('id', up.id);
  if (error) return res.status(500).json({ error: `Could not save: ${error.message}. Is migration 0027 applied?` });
  res.json({ ok: true, ...patch });
});

app.listen(PORT, () => {
  console.log(`\n🏌  Invictus Golf booking demo running at  http://localhost:${PORT}`);
  console.log(`    Manager portal:  http://localhost:${PORT}/admin\n`);
});
