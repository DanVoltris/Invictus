// Notification outbox — the one way this app talks to a customer.
//
// Two channels, both spoken to over plain fetch(): email through Resend, SMS through Twilio's
// REST API. No SDKs, no new dependencies. Sending is split in two on purpose:
//
//   enqueue()   writes a row into public.notifications (migration 0019) and returns. It is
//               cheap, it cannot fail a checkout, and the unique index on dedupe_key means the
//               same message can be enqueued from two code paths — the Stripe webhook and the
//               client-side confirm, which this repo double-covers deliberately — and still
//               reach the customer once.
//   sendDue()   walks the due rows and actually talks to the providers, recording attempts,
//               provider message ids and errors on each row. Safe to call from a cron job, a
//               script, or opportunistically right after an enqueue.
//
// NOTHING HERE THROWS AT ITS CALLER. Missing credentials, a missing table, a provider outage
// and a missing venue address all end the same way: a clear log line saying what would have
// been sent, the row marked so a human can see it, and a clean return. With nothing configured
// the app behaves exactly as it did before this file existed — it sends nothing.
//
// CASL (Canada's Anti-Spam Legislation) is enforced here rather than left to whoever writes the
// next template: see caslBlock() and the consent gate in sendOne().

import { fmtMin } from './booking.js';
import {
  getSettings, customerHoursByContact,
  insertNotification, dueNotifications, updateNotification,
} from './db.js';

// Give up after this many attempts; wait this many minutes before attempt N+1.
export const MAX_ATTEMPTS = 5;
const BACKOFF_MIN = [1, 5, 15, 60, 240];
const HTTP_TIMEOUT_MS = 15000;

// ----- Configuration -------------------------------------------------------------------

// Which channels can actually deliver right now. Absent credentials are not an error state —
// they are the default state, and every send path checks this before doing anything.
export function notifyStatus(env = process.env) {
  const email = Boolean(env.RESEND_API_KEY && env.RESEND_FROM);
  const sms = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
  return { email, sms, enabled: email || sms };
}

// The sender identity CASL requires in every message: who sent this, where they physically are,
// and how to tell them to stop. Comes from settings.venue (manager-editable, migration 0019),
// with env fallbacks for deployments running without a database.
export function venueIdentity(settingsRow, env = process.env) {
  const v = (settingsRow && settingsRow.venue && typeof settingsRow.venue === 'object') ? settingsRow.venue : {};
  const str = (x) => (typeof x === 'string' ? x.trim() : '');
  return {
    name: str(v.name) || str(env.NOTIFY_VENUE_NAME) || 'Invictus Golf',
    address: str(v.address) || str(env.NOTIFY_VENUE_ADDRESS),
    phone: str(v.phone),
    email: str(v.email),
    website: str(v.website),
    unsubscribeUrl: str(v.unsubscribeUrl) || str(env.NOTIFY_UNSUBSCRIBE_URL),
  };
}

// CASL s.11 wants a mailing address AND a working unsubscribe mechanism — either a link or an
// electronic address that requests can be sent to. Without both we do not send: an unidentified
// commercial message is worse than a missing one, and the operator gets told exactly what to fill in.
export function caslReady(venue) {
  return Boolean(venue.name && venue.address && (venue.unsubscribeUrl || venue.email));
}

// The identification + unsubscribe block appended to every message, transactional ones included.
// Email gets the full block. SMS cannot carry a mailing address in 160 characters, so it carries
// a link to it — which CASL permits when including the information is not practicable — plus the
// STOP keyword Twilio already honours at the carrier level.
export function caslBlock(venue, { channel = 'email', unsubToken } = {}) {
  const unsub = venue.unsubscribeUrl
    ? (unsubToken ? `${venue.unsubscribeUrl}${venue.unsubscribeUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(unsubToken)}&c=${channel}` : venue.unsubscribeUrl)
    : '';
  if (channel === 'sms') {
    const where = venue.website || unsub || venue.address;
    return `${venue.name}${where ? ' · ' + where : ''}. Reply STOP to opt out.`;
  }
  const contact = [venue.phone, venue.email].filter(Boolean).join(' · ');
  const lines = [
    '—',
    venue.name,
    venue.address,
    contact || null,
    venue.website || null,
    '',
    unsub
      ? `To stop receiving these messages, unsubscribe here: ${unsub}`
      : `To stop receiving these messages, reply to this email or write to ${venue.email} with the word UNSUBSCRIBE. We action requests within 10 business days.`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

// ----- Templates -----------------------------------------------------------------------
// A template turns a payload into a subject + body. Keep them plain text: it renders in every
// client, it is what SMS is, and it keeps the CASL block impossible to miss.

const money = (cents) => `$${(Math.max(0, Math.round(Number(cents) || 0)) / 100).toFixed(2)} CAD`;
const dayText = (dateISO) => {
  try {
    return new Date(String(dateISO) + 'T00:00:00')
      .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  } catch (_) { return String(dateISO || ''); }
};
const slotText = (p) => `${dayText(p.dateISO)}, ${fmtMin(Number(p.startMin))}–${fmtMin(Number(p.endMin))}`;

export const TEMPLATES = {
  // The first consumer of the outbox: the receipt a customer gets after paying for a bay.
  // Transactional — it is about a service they just bought, not a solicitation.
  'booking.confirmed': {
    msgClass: 'transactional',
    subject: (p, venue) => `Your booking at ${venue.name} — ${dayText(p.dateISO)}`,
    email: (p, venue) => [
      `Hi${p.name ? ' ' + p.name : ''},`,
      '',
      `You're booked at ${venue.name}.`,
      '',
      `  ${p.bayName || p.bayId || 'Your bay'}`,
      `  ${slotText(p)}`,
      p.players ? `  ${p.players} ${Number(p.players) > 1 ? 'players' : 'player'}` : null,
      `  Paid: ${money(p.amountCents)}`,
      '',
      p.manageUrl ? `Need to change or cancel? ${p.manageUrl}`
        : (venue.phone ? `Need to change or cancel? Call us at ${venue.phone}.` : null),
      '',
      'See you in the bay.',
    ].filter((l) => l !== null).join('\n'),
    sms: (p, venue) =>
      `${venue.name}: you're booked — ${p.bayName || 'your bay'}, ${slotText(p)}. Paid ${money(p.amountCents)}.`,
  },
};

// Render one queued row into what actually goes over the wire, CASL block attached.
// Returns null for a template that no longer exists, so an old row can never send a blank message.
export function renderNotification({ template, channel, payload = {} }, venue, { unsubToken } = {}) {
  const t = TEMPLATES[template];
  if (!t) return null;
  const build = channel === 'sms' ? t.sms : t.email;
  if (typeof build !== 'function') return null;
  // Collapse the gaps left by optional lines the payload didn't fill in, so a missing manage
  // link never shows up as a hole in the middle of the message.
  const body = `${build(payload, venue)}\n\n${caslBlock(venue, { channel, unsubToken })}`.replace(/\n{3,}/g, '\n\n');
  const subject = channel === 'email' && typeof t.subject === 'function' ? t.subject(payload, venue) : null;
  return { subject, body };
}

// ----- Enqueue -------------------------------------------------------------------------

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
const isPhone = (s) => String(s || '').replace(/\D/g, '').length >= 10;

// Queue one message. `dedupeKey` is required and must identify the MESSAGE, not the attempt
// ("booking.confirmed:<booking id>"), because it is the only thing standing between a retried
// webhook and a customer being texted twice.
export async function enqueue({
  channel, recipient, template, payload = {}, dedupeKey,
  msgClass, customerId, sendAfter,
} = {}) {
  if (channel !== 'email' && channel !== 'sms') return { error: 'channel must be "email" or "sms"' };
  if (!TEMPLATES[template]) return { error: `unknown notification template "${template}"` };
  if (!dedupeKey) return { error: 'dedupeKey is required — it is what keeps a message from being sent twice' };
  const to = String(recipient || '').trim();
  if (channel === 'email' ? !isEmail(to) : !isPhone(to)) return { error: `not a usable ${channel} recipient` };

  const row = {
    channel, recipient: to, template, payload,
    dedupe_key: String(dedupeKey),
    msg_class: msgClass || TEMPLATES[template].msgClass || 'transactional',
    customer_id: customerId || null,
    send_after: sendAfter ? new Date(sendAfter).toISOString() : new Date().toISOString(),
  };
  const r = await insertNotification(row);
  if (r.unsupported) {
    // No database, or migration 0019 not applied. Say what would have been queued and move on.
    console.log(`📭 notify: outbox unavailable — would have queued ${channel} "${template}" to ${to}`);
  }
  return r;
}

// ----- Sending -------------------------------------------------------------------------

// Walk the due rows and try to deliver each one. Returns a small tally so a cron job or script
// has something to log. Never throws.
export async function sendDue({ limit = 20, env = process.env } = {}) {
  const rows = await dueNotifications({ limit });
  const tally = { picked: rows.length, sent: 0, skipped: 0, failed: 0, retry: 0 };
  if (!rows.length) return tally;
  const venue = venueIdentity(await getSettings(), env);
  for (const row of rows) {
    const outcome = await sendOne(row, { env, venue });
    if (tally[outcome] !== undefined) tally[outcome] += 1;
  }
  return tally;
}

// Deliver one row. Returns 'sent' | 'skipped' | 'failed' | 'retry'.
export async function sendOne(row, { env = process.env, venue } = {}) {
  const v = venue || venueIdentity(await getSettings(), env);
  const status = notifyStatus(env);

  // 1) Identification. CASL requires the venue's name and physical mailing address in the
  //    message; we cannot invent either, so an unconfigured venue means nothing goes out.
  if (!caslReady(v)) {
    console.warn(`📭 notify: settings.venue is missing a name, mailing address or unsubscribe contact — not sending "${row.template}" to ${row.recipient}. See migration 0019 for the one-line update that fills it in.`);
    return finish(row, 'skipped', { last_error: 'venue identification incomplete (CASL)' });
  }

  // 2) Consent. Express consent is required for COMMERCIAL messages. A transactional message
  //    about a booking the customer just paid for is not a solicitation and is sent regardless —
  //    but it still carries the identification block built above.
  let customer = null;
  if (row.msg_class === 'commercial') {
    customer = await lookupCustomer(row);
    const consented = row.channel === 'sms'
      ? Boolean(customer && customer.sms_consent && !customer.sms_unsub_at)
      : Boolean(customer && customer.email_consent && !customer.email_unsub_at);
    if (!consented) {
      console.warn(`📭 notify: no CASL ${row.channel} consent on record for ${row.recipient} — skipping "${row.template}".`);
      return finish(row, 'skipped', { last_error: 'no express consent on record (CASL)' });
    }
  } else {
    customer = await lookupCustomer(row);   // only for the unsubscribe token
  }

  const rendered = renderNotification(row, v, { unsubToken: customer && customer.unsub_token });
  if (!rendered) {
    console.error(`📭 notify: no template "${row.template}" for channel ${row.channel} — skipping.`);
    return finish(row, 'skipped', { last_error: `unknown template ${row.template}/${row.channel}` });
  }

  // 3) Credentials. The unconfigured path: log the whole message so the operator can see the
  //    pipe works, mark the row skipped so it is not retried forever, and return cleanly.
  if ((row.channel === 'email' && !status.email) || (row.channel === 'sms' && !status.sms)) {
    const need = row.channel === 'email' ? 'RESEND_API_KEY + RESEND_FROM' : 'TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM';
    console.log(
      `📭 notify: ${row.channel} not configured (${need}) — WOULD HAVE SENT to ${row.recipient}\n` +
      (rendered.subject ? `    subject: ${rendered.subject}\n` : '') +
      rendered.body.split('\n').map((l) => '    ' + l).join('\n'));
    return finish(row, 'skipped', { last_error: `${row.channel} provider not configured` });
  }

  // 4) Deliver.
  const attempt = (Number(row.attempts) || 0) + 1;
  let res;
  try {
    res = row.channel === 'sms' ? await sendViaTwilio(row, rendered, env) : await sendViaResend(row, rendered, env);
  } catch (err) {
    res = { ok: false, retryable: true, error: err && err.message ? err.message : String(err) };
  }

  if (res.ok) {
    console.log(`📨 notify: ${row.channel} "${row.template}" sent to ${row.recipient} (${res.id || 'no id'})`);
    return finish(row, 'sent', { attempts: attempt, sent_at: new Date().toISOString(), provider_message_id: res.id || null, last_error: null });
  }

  // A provider saying "your request is wrong" (bad address, bad key) will say it again forever;
  // only a timeout, a rate limit or a 5xx is worth waiting for.
  const giveUp = !res.retryable || attempt >= MAX_ATTEMPTS;
  if (giveUp) {
    console.error(`📭 notify: ${row.channel} "${row.template}" to ${row.recipient} failed permanently after ${attempt} attempt(s): ${res.error}`);
    return finish(row, 'failed', { attempts: attempt, last_error: String(res.error).slice(0, 500) });
  }
  const wait = BACKOFF_MIN[Math.min(attempt, BACKOFF_MIN.length) - 1];
  console.warn(`📭 notify: ${row.channel} "${row.template}" to ${row.recipient} failed (attempt ${attempt}) — retrying in ${wait} min: ${res.error}`);
  await updateNotification(row.id, {
    attempts: attempt, last_error: String(res.error).slice(0, 500),
    send_after: new Date(Date.now() + wait * 60000).toISOString(),
  });
  return 'retry';
}

async function finish(row, status, patch) {
  await updateNotification(row.id, { status, ...patch });
  return status;
}

// The customer behind a queued message — for their consent flags and unsubscribe token.
async function lookupCustomer(row) {
  try {
    return await customerHoursByContact(
      row.channel === 'email' ? { email: row.recipient } : { phone: row.recipient });
  } catch (_) { return null; }
}

// ----- Providers (fetch only — no SDKs) -------------------------------------------------

// Resend: POST /emails with a bearer token. https://resend.com/docs/api-reference/emails/send-email
async function sendViaResend(row, { subject, body }, env) {
  const headers = { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' };
  const payload = { from: env.RESEND_FROM, to: [row.recipient], subject: subject || '(no subject)', text: body };
  // One-click unsubscribe for mail clients that offer it, when a real URL is configured.
  const unsubUrl = /unsubscribe here: (\S+)/.exec(body);
  if (unsubUrl) payload.headers = { 'List-Unsubscribe': `<${unsubUrl[1]}>` };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, id: json.id || null };
  return { ok: false, retryable: res.status === 429 || res.status >= 500, error: `Resend ${res.status}: ${json.message || json.name || 'send failed'}` };
}

// Twilio: form-encoded POST to the Messages resource, HTTP Basic auth of SID:auth-token.
// https://www.twilio.com/docs/sms/api/message-resource#create-a-message-resource
async function sendViaTwilio(row, { body }, env) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`;
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const form = new URLSearchParams({ To: row.recipient, From: env.TWILIO_FROM, Body: body });

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, id: json.sid || null };
  return { ok: false, retryable: res.status === 429 || res.status >= 500, error: `Twilio ${res.status}: ${json.message || 'send failed'}` };
}

// ----- Consumers ------------------------------------------------------------------------

// Booking confirmation — the outbox's first customer, enqueued the moment a booking is paid.
// Email always (transactional). SMS only with express consent on record: customers.sms_opt_in
// defaults to true and so is not consent (see migration 0019).
//
// Best-effort by construction: every failure inside is logged and swallowed, because a booking
// that is paid for and saved must never be reported as failed just because a receipt didn't send.
export async function notifyBookingConfirmed({
  bookingId, dateISO, bayId, bayName, startMin, endMin, players,
  amountCents, name, email, phone, customerId, manageUrl, env = process.env, sendNow = true,
} = {}) {
  const key = bookingId || `${dateISO}:${bayId}:${startMin}`;
  const payload = { bookingId, dateISO, bayId, bayName, startMin, endMin, players, amountCents, name, manageUrl };
  const out = { email: null, sms: null };
  try {
    if (isEmail(email)) {
      out.email = await enqueue({
        channel: 'email', recipient: email, template: 'booking.confirmed',
        payload, dedupeKey: `booking.confirmed:email:${key}`, customerId,
      });
    }
    if (isPhone(phone)) {
      const cust = await customerHoursByContact({ phone });
      if (cust && cust.sms_consent && !cust.sms_unsub_at) {
        out.sms = await enqueue({
          channel: 'sms', recipient: phone, template: 'booking.confirmed',
          payload, dedupeKey: `booking.confirmed:sms:${key}`, customerId: customerId || cust.id,
        });
      }
    }
    // Deliver right away so a booking receipt doesn't wait for a scheduler this repo doesn't
    // have yet. The row is already durable, so a failure here just means the worker retries.
    if (sendNow) {
      const venue = venueIdentity(await getSettings(), env);
      for (const r of [out.email, out.sms]) {
        if (r && r.row) await sendOne(r.row, { env, venue });
      }
    }
  } catch (err) {
    console.error('notifyBookingConfirmed:', err && err.message ? err.message : err);
  }
  return out;
}
