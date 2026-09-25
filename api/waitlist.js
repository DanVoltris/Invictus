import { normalizeSettings, bayName, fmtMin, winnipegTodayISO, bookingWindowError } from '../lib/booking.js';
import { createHmac } from 'node:crypto';
import {
  getSettings, waitlistConfig, waitlistQuietNow, customerKeyFor, recordConsent, applySmsReply,
  createWaitlistEntry, waitlistEntryByToken, leaveWaitlist,
  waitlistOfferByToken, claimWaitlistOffer, declineWaitlistOffer,
  runWaitlistSweep, pendingWaitlistOffers, markWaitlistOfferNotified,
  staffContext, leaguePlayerForRequest
} from '../lib/db.js';
import { notifyWaitlistOffer, notifyWaitlistJoined, sendDue, venueIdentity } from '../lib/notify.js';

// The waiting list. Dispatch on ?action= —
//
//   join     POST   put me on the list for this date / bays / time window
//   entry    GET    what am I waiting for, and is there an offer open? (my own token)
//   leave    POST   take me off it
//   offer    GET    what is being offered to me, and how long have I got? (claim token)
//   claim    POST   I'll take it
//   decline  POST   I won't — give it to the next person now
//   sweep    POST   the cron tick: expire lapsed windows, match freed slots, send the messages
//   outbox   POST   the other cron tick: deliver whatever is due in the notification outbox
//   sms-reply POST  Twilio's inbound webhook: a customer texted STOP, START or HELP back
//
// WHAT THIS FILE IS NOT RESPONSIBLE FOR. Who gets offered which slot is decided by
// waitlist_process() in migration 0022, under an advisory lock, with the "one live offer per slot"
// rule enforced by a unique index rather than by whichever process happens to be running. That is
// deliberate: this endpoint can be called twice at once by a cron job and a manager and it still
// cannot produce two offers for one bay. What lives here is validation of what a customer typed,
// CASL consent capture, and turning offers into messages through lib/notify.js.
//
// THE CLAIM WINDOW IS THE FEATURE. Telling six people about one cancellation produces one booking
// and five people who will not bother next time. One person is told, the slot is genuinely held
// for them (settings.waitlist.holdSlot), and only when they pass does the next person hear about
// it. Everything else here is plumbing around that one rule.

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((e || '').trim());
const validPhone = (p) => { const raw = String(p || '').trim(); let d = raw.replace(/\D/g, ''); const intl = raw.startsWith('+') || (d.startsWith('00') && d.length >= 12); if (intl && d.startsWith('00')) d = d.slice(2); return (d.length === 10 && !intl) || (d.length === 11 && d[0] === '1') || (d.length >= 11 && d.length <= 15) || (intl && d.length >= 8 && d.length <= 15); };
const clientIp = (req) => String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '')
  .split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || null;
const isUuid = (s) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(s || ''));
// Said when someone signed in, but not as staff with booking.write (0024 puts the waiting list
// and the notification outbox under it), tries to run the sweep or the outbox by hand.
const NEEDS_BOOKINGS = 'This needs a staff login with the Bookings permission (booking.write). Ask an admin to turn it on under Staff.';

// "19:30" or 1170 — the browser may send either; both end up as minutes from midnight.
function parseMin(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= 1440 ? n : null;
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v).trim());
  if (!m) return null;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins <= 1440 ? mins : null;
}

// Where the links in a message point. settings.waitlist.claimUrl wins (an operator may host the
// page anywhere), then PUBLIC_BASE_URL, then the request's own origin — so a local run links to
// localhost and production links to production without configuring anything.
function baseUrl(req, cfg, kind) {
  const configured = kind === 'manage' ? cfg.manageUrl : cfg.claimUrl;
  if (configured) return configured;
  const env = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '';
  const origin = env || (() => {
    const h = (req.headers || {});
    const host = h['x-forwarded-host'] || h.host;
    if (!host) return '';
    const proto = h['x-forwarded-proto'] || (String(host).startsWith('localhost') ? 'http' : 'https');
    return `${proto}://${host}`;
  })();
  return origin ? `${origin.replace(/\/+$/, '')}/waitlist` : '';
}
const withToken = (url, token, extra) =>
  (url ? `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}${extra ? `&${extra}` : ''}` : null);

// A deadline in the venue's own words ("7:42 PM"), since that is what a customer reads.
function clockText(iso, timezone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(iso));
  } catch (_) { return null; }
}

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || '';
  if (req.method === 'GET') {
    if (action === 'offer') return offer(req, res);
    if (action === 'entry') return entry(req, res);
    return res.status(400).json({ ok: false, error: 'Unknown action' });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (action === 'join') return join(req, res);
  if (action === 'leave') return leave(req, res);
  if (action === 'claim') return claim(req, res);
  if (action === 'decline') return decline(req, res);
  if (action === 'sweep') return sweep(req, res);
  if (action === 'outbox') return outbox(req, res);
  if (action === 'sms-reply') return smsReply(req, res);
  return res.status(400).json({ ok: false, error: 'Unknown action' });
}

// ----- join --------------------------------------------------------------------------------
//
// CONSENT IS CAPTURED HERE OR NOWHERE. An offer is a message inviting a purchase, so CASL wants
// express consent per channel, recorded with the time and the IP at the point of collection. The
// two flags below come from two separate unticked boxes in the form (never one), are written onto
// the entry AND mirrored onto public.customers via recordConsent (migration 0019), and an entry
// with neither is refused outright rather than silently never being contacted.
async function join(req, res) {
  const b = req.body || {};
  const settingsRow = await getSettings();
  const settings = normalizeSettings(settingsRow);
  const cfg = waitlistConfig(settingsRow);

  const dateISO = String(b.dateISO || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return res.status(400).json({ ok: false, error: 'Pick a date first.' });
  const today = winnipegTodayISO();
  if (dateISO < today) return res.status(400).json({ ok: false, error: 'That date has already passed.' });
  const horizon = new Date(`${today}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 365);
  if (dateISO > horizon.toISOString().slice(0, 10)) {
    return res.status(400).json({ ok: false, error: 'That date is too far ahead to wait for.' });
  }
  // Waiting for a slot you could not book anyway helps nobody: same window as booking (0028).
  const tooFar = bookingWindowError({ settings, dateISO, todayISO: today,
    league: await leaguePlayerForRequest(req) });
  if (tooFar) return res.status(400).json({ ok: false, error: tooFar, code: 'booking_window' });

  const startMin = parseMin(b.windowStartMin ?? b.windowStart ?? 0);
  const endMin = parseMin(b.windowEndMin ?? b.windowEnd ?? 1440);
  if (startMin == null || endMin == null || endMin <= startMin) {
    return res.status(400).json({ ok: false, error: 'Give us a time window — an earliest and a latest time.' });
  }
  const floor = Math.max(15, Number(settings.minMins) || 60);
  const durationMin = parseMin(b.durationMin ?? b.duration ?? floor) ?? floor;
  if (durationMin < floor) return res.status(400).json({ ok: false, error: `Sessions are at least ${floor} minutes.` });
  if (durationMin > endMin - startMin) {
    return res.status(400).json({ ok: false, error: 'Your time window is shorter than the session you asked for.' });
  }

  // Bay preference, validated against the bays that actually exist. An empty list means "any bay",
  // which is the setting most likely to get somebody a slot.
  const known = new Set(settings.bays.filter((x) => !x.holding).map((x) => String(x.id)));
  const bayIds = Array.isArray(b.bayIds) ? [...new Set(b.bayIds.map(String))] : [];
  const unknown = bayIds.filter((id) => !known.has(id));
  if (unknown.length) return res.status(400).json({ ok: false, error: `We don’t have a bay called ${unknown[0]}.` });

  const name = String(b.name || '').trim().slice(0, 120) || null;
  const email = String(b.email || '').trim().toLowerCase() || null;
  const phone = String(b.phone || '').trim() || null;
  if (email && !validEmail(email)) return res.status(400).json({ ok: false, error: 'That email address doesn’t look right.' });
  if (phone && !validPhone(phone)) return res.status(400).json({ ok: false, error: 'That phone number doesn’t look right.' });
  if (!email && !phone) return res.status(400).json({ ok: false, error: 'We need an email or a mobile number to reach you on.' });

  const emailOk = !!b.emailOk && !!email;
  const smsOk = !!b.smsOk && !!phone;
  if (!emailOk && !smsOk) {
    return res.status(400).json({
      ok: false, code: 'consent_required',
      error: 'Tick the box for email or text so we can tell you when a bay opens — that is the whole point of the list.',
    });
  }

  const customerKey = customerKeyFor({ email, phone });
  if (!customerKey) return res.status(400).json({ ok: false, error: 'We need an email or a mobile number to reach you on.' });

  // Consent first, entry second: the entry is only worth having if we are allowed to use it.
  const consent = await recordConsent({
    email, phone, name,
    emailConsent: emailOk ? true : undefined,
    smsConsent: smsOk ? true : undefined,
    ip: clientIp(req), source: 'waitlist',
  });

  const made = await createWaitlistEntry({
    customerKey, customerId: consent.customerId || null, name, email, phone,
    emailOk, smsOk, consentIp: clientIp(req),
    dateISO, bayIds, windowStartMin: startMin, windowEndMin: endMin, durationMin,
    players: b.players == null ? null : Math.min(Math.max(parseInt(b.players, 10) || 1, 1), settings.maxParty),
    note: b.note,
  });
  if (made.unsupported) return res.status(503).json({ ok: false, error: 'The waiting list isn’t switched on yet.' });
  if (made.invalid) return res.status(400).json({ ok: false, error: made.error });
  if (made.error) return res.status(500).json({ ok: false, error: made.error });

  const e = made.entry;
  const manageUrl = withToken(baseUrl(req, cfg, 'manage'), e.token);
  const windowText = `${fmtMin(e.window_start_min)}–${fmtMin(e.window_end_min)}, ${e.duration_min} min`;
  const bayText = (e.bay_ids && e.bay_ids.length)
    ? e.bay_ids.map((id) => bayName(settings, id) || id).join(', ') : 'Any bay';

  if (!made.already) {
    await notifyWaitlistJoined({
      entryId: e.id, dateISO, windowText, bayText, manageUrl,
      quietText: cfg.quietStartMin === cfg.quietEndMin ? null
        : `We don’t send messages between ${fmtMin(cfg.quietStartMin)} and ${fmtMin(cfg.quietEndMin)}.`,
      name, email, phone, emailOk, smsOk, customerId: consent.customerId || null,
    });
  }

  res.status(200).json({
    ok: true, already: !!made.already,
    entry: publicEntry(e, settings),
    quietHours: cfg.quietStartMin === cfg.quietEndMin ? null
      : { startMin: cfg.quietStartMin, endMin: cfg.quietEndMin, quietNow: waitlistQuietNow(cfg) },
    claimMinutes: cfg.claimMinutes,
  });
}

// What the customer is allowed to see about their own entry. Never the customer_key, never
// another entry's anything — the token is the only credential involved.
function publicEntry(e, settings) {
  return {
    token: e.token,
    dateISO: e.booking_date,
    bays: (e.bay_ids || []).map((id) => bayName(settings, id) || id),
    bayIds: e.bay_ids || [],
    windowStartMin: e.window_start_min,
    windowEndMin: e.window_end_min,
    window: `${fmtMin(e.window_start_min)}–${fmtMin(e.window_end_min)}`,
    durationMin: e.duration_min,
    players: e.players,
    status: e.status,
    offersSent: e.offers_sent,
    createdAt: e.created_at,
  };
}

// ----- entry / leave -----------------------------------------------------------------------

async function entry(req, res) {
  const token = (req.query && req.query.token) || '';
  if (!isUuid(token)) return res.status(400).json({ ok: false, error: 'Invalid link.' });
  const e = await waitlistEntryByToken(token);
  if (!e) return res.status(404).json({ ok: false, error: 'We can’t find that waiting-list entry.' });
  const settings = normalizeSettings(await getSettings());
  res.status(200).json({ ok: true, entry: publicEntry(e, settings) });
}

async function leave(req, res) {
  const token = (req.body && req.body.token) || '';
  if (!isUuid(token)) return res.status(400).json({ ok: false, error: 'Invalid link.' });
  const out = await leaveWaitlist(token);
  if (out.unsupported) return res.status(503).json({ ok: false, error: 'The waiting list isn’t switched on yet.' });
  if (out.error) return res.status(500).json({ ok: false, error: out.error });
  if (!out.ok) return res.status(404).json({ ok: false, error: 'We can’t find that waiting-list entry.' });
  res.status(200).json({ ok: true, already: !!out.already });
}

// ----- offer / claim / decline ---------------------------------------------------------------

// The claim link's landing data. Deliberately terse about a token that is not live: an expired or
// unknown claim token gets "this offer has gone", not a description of somebody's booking.
async function offer(req, res) {
  const token = (req.query && req.query.token) || '';
  if (!isUuid(token)) return res.status(400).json({ ok: false, error: 'Invalid link.' });
  const o = await waitlistOfferByToken(token);
  if (!o) return res.status(404).json({ ok: false, error: 'That offer has gone.' });

  const settingsRow = await getSettings();
  const settings = normalizeSettings(settingsRow);
  const cfg = waitlistConfig(settingsRow);
  const secondsLeft = Math.max(0, Math.round((Date.parse(o.expires_at) - Date.now()) / 1000));
  res.status(200).json({
    ok: true,
    offer: {
      status: o.status === 'offered' && secondsLeft === 0 ? 'expired' : o.status,
      dateISO: o.booking_date,
      bayId: o.bay_id,
      bay: bayName(settings, o.bay_id) || o.bay_id,
      startMin: o.start_min,
      endMin: o.end_min,
      time: `${fmtMin(o.start_min)}–${fmtMin(o.end_min)}`,
      players: o.entry ? o.entry.players : null,
      expiresAt: o.expires_at,
      expiresText: clockText(o.expires_at, cfg.timezone),
      secondsLeft,
      held: !!o.hold_booking_id,
    },
  });
}

// Take it. The row lock lives in waitlist_claim (migration 0022 §6), so two taps on the link in a
// text message produce one claim and one answer.
//
// AND THEN WHAT: the claim releases the slot hold on purpose and returns the slot, so the customer
// goes through the ordinary checkout — which takes its own cart hold — instead of a second, parallel
// payment path that would have to be kept in step with the first. They are protected across that
// handover for checkoutMinutes, during which the slot is not re-offered to anybody (see
// waitlist_note_free_slot).
async function claim(req, res) {
  const token = (req.body && req.body.token) || '';
  if (!isUuid(token)) return res.status(400).json({ ok: false, error: 'Invalid link.' });

  const out = await claimWaitlistOffer(token);
  if (out.unsupported) return res.status(503).json({ ok: false, error: 'The waiting list isn’t switched on yet.' });
  if (out.error) return res.status(500).json({ ok: false, error: out.error });
  if (!out.ok) {
    const said = {
      expired: 'That offer ran out — we’ve passed it to the next person on the list.',
      declined: 'You turned that one down.',
      cancelled: 'That offer was withdrawn.',
      claimed: 'That offer has already been taken.',
      not_found: 'That offer has gone.',
      not_configured: 'The waiting list isn’t switched on yet.',
    }[out.reason] || 'That offer is no longer available.';
    return res.status(out.reason === 'not_found' ? 404 : 409).json({ ok: false, code: out.reason, error: said });
  }

  const settingsRow = await getSettings();
  const settings = normalizeSettings(settingsRow);
  const cfg = waitlistConfig(settingsRow);
  res.status(200).json({
    ok: true, already: !!out.already,
    // Everything demo/index.html needs to open its normal checkout on this slot.
    slot: {
      dateISO: out.dateISO, bayId: out.bayId, bay: bayName(settings, out.bayId) || out.bayId,
      startMin: out.startMin, endMin: out.endMin,
      time: `${fmtMin(out.startMin)}–${fmtMin(out.endMin)}`,
    },
    checkoutBy: out.checkoutBy,
    checkoutByText: clockText(out.checkoutBy, cfg.timezone),
    checkoutMinutes: cfg.checkoutMinutes,
  });
}

async function decline(req, res) {
  const b = req.body || {};
  if (!isUuid(b.token)) return res.status(400).json({ ok: false, error: 'Invalid link.' });
  const out = await declineWaitlistOffer(b.token, { leave: !!b.leave });
  if (out.unsupported) return res.status(503).json({ ok: false, error: 'The waiting list isn’t switched on yet.' });
  if (out.error) return res.status(500).json({ ok: false, error: out.error });
  if (!out.ok) return res.status(409).json({ ok: false, code: out.reason, error: 'That offer is no longer open.' });
  res.status(200).json({ ok: true, left: !!out.left });
}

// ----- sweep -------------------------------------------------------------------------------
//
// The tick. pg_cron + pg_net calls this every minute (migration 0022 §10) because Vercel Hobby
// cron is daily-only and a 15-minute claim window cannot be driven by a daily job; any external
// scheduler that can POST works identically.
//
// Three steps, in this order and no other:
//   1. waitlist_process()  — expire lapsed windows, match freed slots to waiting customers. All of
//      the concurrency safety is in there; calling this twice at once is harmless.
//   2. announce every live offer nobody has been told about — including offers from an earlier run
//      whose message failed. An offer nobody hears about is a slot burned for nothing.
//   3. drain anything else due in the outbox, so a booking receipt that failed earlier gets its
//      retry from the same tick rather than needing a second cron job.
//
// Authenticated with a shared secret. Without one set it refuses and says so — an open sweep
// endpoint is a way to make a stranger's phone ring.
async function sweep(req, res) {
  const secret = process.env.WAITLIST_SWEEP_SECRET || '';
  const sent = String((req.headers && (req.headers['x-waitlist-secret'] || req.headers['x-cron-secret'])) || '');
  let allowed = false;
  if (secret && sent && sent.length === secret.length && timingSafeEqual(sent, secret)) allowed = true;
  if (!allowed) {
    // Staff with booking.write may also run it by hand from the portal ("check for free slots now").
    // A Supabase session alone is not enough — customer accounts sign in to the same project.
    const auth = (req.headers && req.headers.authorization) || '';
    if (auth) {
      const who = await staffContext(auth, 'booking.write');
      if (who.error === 'forbidden') return res.status(403).json({ ok: false, error: NEEDS_BOOKINGS });
      allowed = !who.error;
    }
  }
  if (!allowed) {
    if (!secret) console.warn('waitlist sweep: WAITLIST_SWEEP_SECRET is not set — refusing to run an unauthenticated sweep.');
    return res.status(secret ? 401 : 503).json({
      ok: false,
      error: secret ? 'Not authorised.' : 'Set WAITLIST_SWEEP_SECRET before scheduling the sweep.',
    });
  }

  const swept = await runWaitlistSweep({ limit: req.body && req.body.limit });
  if (swept.unsupported) return res.status(503).json({ ok: false, error: 'The waiting list isn’t switched on yet.' });
  if (swept.error) return res.status(500).json({ ok: false, error: swept.error });

  const announced = await announcePendingOffers(req);
  const outbox = await sendDue({ limit: 20 });
  res.status(200).json({ ok: true, sweep: swept, announced, outbox });
}

// ----- outbox ------------------------------------------------------------------------------
//
// THE OUTBOX'S OWN TICK, and the reason it is a separate action rather than more of sweep():
// sendDue() is what actually hands a queued email or text to Resend/Twilio, and until this action
// existed the only caller was the waiting-list sweep above. That made every booking receipt whose
// first send attempt failed dependent on a feature an operator may not even run — and worse, the
// sweep returns early (503) when migration 0022 is not applied, so on those deployments the drain
// was never reached at all. A queued message is a promise to a customer; it gets its own clock.
//
// It lives on this handler because this is already the file that owns the outbox drain and the
// scheduler-secret plumbing, and because Vercel Hobby allows twelve functions and this project
// already ships seventeen — a new api/*.js file is not available to spend.
//
// SAFE TO CALL AGAIN AND AGAIN. No delivery logic is repeated here: lib/notify.js owns the whole
// of it — which rows are due (status queued + send_after in the past), the attempt counter, the
// 1/5/15/60/240-minute backoff, the permanent-failure rule and the CASL gates — and every row is
// marked the moment its attempt ends. This action adds one thing on top: a single-flight guard so
// a slow run and the next tick cannot overlap inside the same process, which is the overlap a
// one-minute cron actually produces. Concurrent calls get { busy: true } and change nothing.
//
// SCHEDULING (pg_cron + pg_net, same shape as waitlist_schedule_sweep in migration 0022 §10).
// Run once in Supabase -> SQL Editor, with your URL and the value of OUTBOX_SWEEP_SECRET:
//
//   select cron.schedule('outbox-sweep', '*/2 * * * *', $$
//     select net.http_post(
//       url := 'https://<your-app>/api/waitlist?action=outbox',
//       headers := '{"Content-Type":"application/json","x-outbox-secret":"<OUTBOX_SWEEP_SECRET>"}'::jsonb,
//       body := '{}'::jsonb,
//       timeout_milliseconds := 8000)
//   $$);
//
// Stop it again (holidays, a broken deployment, or before rotating the secret):
//
//   select cron.unschedule('outbox-sweep');
//
// Every two minutes is plenty: the urgent messages (offers, sign-in codes, receipts) are already
// sent inline at enqueue time by lib/notify.js, so what this drains is the retries and anything
// queued for later. Raise the cadence, not the limit, if a backlog ever builds.
let outboxRunning = false;

async function outbox(req, res) {
  // Same door as the sweep above, with its own secret so the two jobs can be rotated apart.
  // Falls back to WAITLIST_SWEEP_SECRET the way api/booking-series.js does, so one scheduler
  // secret can drive every cron job on the deployment.
  const secret = process.env.OUTBOX_SWEEP_SECRET || process.env.WAITLIST_SWEEP_SECRET || '';
  const sent = String((req.headers && (req.headers['x-outbox-secret'] || req.headers['x-cron-secret'])) || '');
  let allowed = false;
  if (secret && sent && sent.length === secret.length && timingSafeEqual(sent, secret)) allowed = true;
  if (!allowed) {
    // Staff with booking.write may also flush the queue by hand ("send the stuck messages now").
    const auth = (req.headers && req.headers.authorization) || '';
    if (auth) {
      const who = await staffContext(auth, 'booking.write');
      if (who.error === 'forbidden') return res.status(403).json({ ok: false, error: NEEDS_BOOKINGS });
      allowed = !who.error;
    }
  }
  if (!allowed) {
    if (!secret) console.warn('outbox sweep: OUTBOX_SWEEP_SECRET is not set — refusing to run an unauthenticated drain.');
    return res.status(secret ? 401 : 503).json({
      ok: false,
      error: secret ? 'Not authorised.' : 'Set OUTBOX_SWEEP_SECRET before scheduling the outbox drain.',
    });
  }

  // How many rows this tick may attempt. Bounded so one call cannot sit on a serverless function
  // until it is killed mid-send; the next tick takes the rest.
  const asked = Math.round(Number(req.body && req.body.limit));
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 100) : 25;

  if (outboxRunning) return res.status(200).json({ ok: true, busy: true, outbox: null });
  outboxRunning = true;
  try {
    const tally = await sendDue({ limit });
    // picked/sent/skipped/failed/retry — enough for a human to see the queue moving.
    return res.status(200).json({ ok: true, busy: false, outbox: tally });
  } catch (err) {
    console.error('outbox sweep:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: 'The outbox drain failed. Check the server log.' });
  } finally {
    outboxRunning = false;
  }
}

// ----- sms-reply ----------------------------------------------------------------------------
//
// THE OTHER HALF OF CONSENT. Twilio honours STOP at the carrier level, so a customer who replies
// STOP stops receiving texts whatever this app believes — but our database would still say they
// consented, lib/notify.js would happily queue the next commercial text, and the operator would be
// looking at a record that says yes while the customer is telling a regulator they said no. This
// endpoint is what keeps the record honest.
//
// Twilio POSTs application/x-www-form-urlencoded when a message comes in: From (their number),
// Body (what they typed), MessageSid, and more. Paste this URL into the Twilio console, under
// Phone Numbers -> Manage -> Active numbers -> your number -> Messaging -> "A message comes in":
//
//   https://<your-app>/api/waitlist?action=sms-reply     (HTTP POST)
//
// THE URL IS PUBLIC, so the signature is the only door. Every request must carry a valid
// X-Twilio-Signature (HMAC-SHA1 of the full URL plus the sorted POST fields, keyed with the
// account's auth token); anything else is refused and changes nothing. With no TWILIO_AUTH_TOKEN
// set there is no way to tell Twilio from a stranger, so the endpoint refuses outright rather
// than trusting a body that could unsubscribe — or re-subscribe — anyone.
//
// WHY THE REPLY IS EMPTY. Twilio's own opt-out handling already sends the confirmation ("You have
// unsubscribed…") and then blocks any message we try to send to a number that just texted STOP
// (error 21610), so answering with our own <Message> would either duplicate it or be rejected.
// An empty <Response/> is the documented TwiML for "no auto-reply". HELP is the exception: the
// customer asked who we are, so they are told, politely and once.
const SMS_STOP = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const SMS_START = new Set(['start', 'unstop', 'yes']);
const SMS_HELP = new Set(['help', 'info']);

// The address Twilio signed. It signs the URL it called, so that is what has to be rebuilt —
// proxy headers first (Vercel sets them), then the original path and query string. Set
// TWILIO_INBOUND_URL when what Twilio calls is not what this app sees (a rewrite, a custom
// domain), because a URL that differs by one character produces a signature that will not match.
function inboundUrl(req) {
  const configured = String(process.env.TWILIO_INBOUND_URL || '').trim();
  if (configured) return configured;
  const h = req.headers || {};
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
  if (!host) return '';
  const proto = String(h['x-forwarded-proto'] || (host.startsWith('localhost') ? 'http' : 'https')).split(',')[0].trim();
  return `${proto}://${host}${req.originalUrl || req.url || ''}`;
}

// https://www.twilio.com/docs/usage/security#validating-requests — the full URL, then every POST
// field appended in alphabetical order as key immediately followed by value, HMAC-SHA1 with the
// auth token, base64. Compared in constant time so the signature cannot be guessed a byte at a time.
function twilioSignatureOk({ token, url, params, signature }) {
  if (!token || !url || !signature) return false;
  const data = Object.keys(params || {}).sort()
    .reduce((acc, k) => acc + k + String(params[k] == null ? '' : params[k]), url);
  const expected = createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
  return signature.length === expected.length && timingSafeEqual(signature, expected);
}

const xmlEscape = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function smsReply(req, res) {
  const twiml = (inner = '') => {
    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`);
  };
  const refuse = (code, message) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(code).send(message);
  };

  const token = String(process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!token) {
    console.error('sms-reply refused: TWILIO_AUTH_TOKEN is not set, so an inbound message cannot be '
      + 'proved to have come from Twilio. Copy the auth token from console.twilio.com (Account Info) '
      + 'into the deployment\'s environment and redeploy.');
    return refuse(503, 'Inbound SMS is not configured: TWILIO_AUTH_TOKEN is not set on this deployment, '
      + 'so requests cannot be verified. Set it in the environment and try again.');
  }

  // Twilio sends a form body; Vercel and the local server both hand it over already parsed.
  const params = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) && !Array.isArray(req.body))
    ? req.body : {};
  const signature = String((req.headers && req.headers['x-twilio-signature']) || '');
  const url = inboundUrl(req);
  if (!twilioSignatureOk({ token, url, params, signature })) {
    console.warn(`sms-reply refused: bad or missing X-Twilio-Signature for ${url || '(unknown URL)'} — nothing was changed.`);
    return refuse(403, 'Rejected: this request is not signed by Twilio. Point the number\'s "A message comes in" '
      + `webhook at exactly ${url || 'https://<your-app>/api/waitlist?action=sms-reply'} using HTTP POST, `
      + 'and check TWILIO_AUTH_TOKEN belongs to the account that owns the number (or set TWILIO_INBOUND_URL '
      + 'if the URL Twilio calls is not the one this app sees).');
  }

  const from = String(params.From || '').trim();
  const sid = String(params.MessageSid || '') || '(no sid)';
  // Keywords are matched the way the carriers match them: the whole message, letters only, so
  // "Stop." and "STOP" count and "please stop texting me" does not — that one is for a human.
  const word = String(params.Body || '').trim().toLowerCase().replace(/[^a-z]/g, '');

  if (SMS_HELP.has(word)) {
    const v = venueIdentity(await getSettings());
    const help = `${v.name}: reply STOP to stop texts, START to get them again.`
      + (v.phone ? ` Questions? Call ${v.phone}.` : '');
    return twiml(`<Message>${xmlEscape(help)}</Message>`);
  }

  const intent = SMS_STOP.has(word) ? 'stop' : SMS_START.has(word) ? 'start' : null;
  if (!intent) {
    console.log(`📩 sms-reply: ${sid} from ${from || '(no number)'} is not a keyword — nothing changed.`);
    return twiml();
  }

  const r = await applySmsReply({ phone: from, intent, ip: clientIp(req), source: 'sms-reply' });
  if (r.ok) console.log(`📩 sms-reply: ${from} texted ${word.toUpperCase()} — SMS consent ${intent === 'stop' ? 'withdrawn' : 'restored'} (${sid}).`);
  else if (r.unknown) console.log(`📩 sms-reply: ${from} texted ${word.toUpperCase()} but is not a customer here — nothing to change (${sid}).`);
  else if (r.invalid) console.warn(`📩 sms-reply: could not read the sender's number on ${sid} — nothing changed.`);
  else if (r.unsupported) console.warn(`📩 sms-reply: ${from}'s ${word.toUpperCase()} was NOT recorded (${sid}) — either the database is not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) or supabase/migrations/0019_notifications_outbox.sql has not been applied.`);
  else if (r.error) console.error(`📩 sms-reply: could not record ${from}'s ${word.toUpperCase()} — ${r.error} (${sid}).`);
  // Always 200: Twilio retries nothing useful, and the log above is what an operator reads.
  return twiml();
}

// Step 2 of the sweep, and the only place an offer becomes a message. Split out so a manual run
// and the cron tick cannot drift apart.
export async function announcePendingOffers(req) {
  const settingsRow = await getSettings();
  const settings = normalizeSettings(settingsRow);
  const cfg = waitlistConfig(settingsRow);
  const pending = await pendingWaitlistOffers({ limit: 25 });
  const out = { pending: pending.length, notified: 0, skipped: 0 };

  for (const o of pending) {
    const e = o.entry;
    if (!e) { out.skipped += 1; continue; }
    const claimUrl = withToken(baseUrl(req, cfg, 'claim'), o.claim_token);
    const sent = await notifyWaitlistOffer({
      offerId: o.id,
      dateISO: o.booking_date, bayId: o.bay_id, bayName: bayName(settings, o.bay_id) || o.bay_id,
      startMin: o.start_min, endMin: o.end_min,
      expiresText: clockText(o.expires_at, cfg.timezone),
      holdSlot: !!o.hold_booking_id,
      claimUrl, declineUrl: withToken(baseUrl(req, cfg, 'claim'), o.claim_token, 'no=1'),
      name: e.name, email: e.email, phone: e.phone,
      emailOk: e.email_ok, smsOk: e.sms_ok, customerId: e.customer_id,
    });
    if (sent.channels.length) {
      await markWaitlistOfferNotified(o.id, sent.channels);
      out.notified += 1;
    } else {
      out.skipped += 1;
    }
  }
  return out;
}

// Constant-time compare so the sweep secret cannot be guessed a character at a time. Lengths are
// checked by the caller (an unequal length is a mismatch and leaks nothing).
function timingSafeEqual(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
