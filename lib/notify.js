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

  // The gift card itself, to whoever it was bought for. Transactional: somebody paid for this and
  // the recipient cannot use it without the message, so it is not a solicitation.
  //
  // THIS IS THE ONE TEMPLATE WHOSE PAYLOAD HOLDS SPENDABLE VALUE. lib/db.js states the rule the
  // rest of the gift-card code keeps — the plaintext code is never stored — and a queued row here
  // is a database row, so notifyGiftCard() scrubs `code` out of the payload the moment the message
  // is delivered. It is present only between enqueue and send. Anything that renders this template
  // must therefore cope with `code` being gone (a failed row that already sent cannot be re-sent
  // with a code in it, and re-sending a gift card by hand is a staff re-issue, not a retry).
  'gift.issued': {
    msgClass: 'transactional',
    subject: (p, venue) => (p.fromName
      ? `${p.fromName} sent you a gift card for ${venue.name}`
      : `Your ${venue.name} gift card`),
    email: (p, venue) => [
      `Hi${p.name ? ' ' + p.name : ''},`,
      '',
      p.fromName ? `${p.fromName} has sent you a gift card for ${venue.name}.`
                 : `Here is your gift card for ${venue.name}.`,
      '',
      `  Amount: ${money(p.amountCents)}`,
      p.code ? `  Code:   ${p.code}` : '  Code:   (already sent — call us if you no longer have it)',
      '',
      p.message ? `“${p.message}”` : null,
      p.message ? '' : null,
      'Type the code at checkout when you book a bay, or read it out at the counter.',
      'It never expires and there are no fees on it.',
      venue.phone ? `Questions? Call us at ${venue.phone}.` : null,
    ].filter((l) => l !== null).join('\n'),
    // The code goes by SMS too — an SMS gift card with no code in it is not a gift card. Same
    // scrub applies: the row stops holding it as soon as it is delivered.
    sms: (p, venue) =>
      `${venue.name}: ${p.fromName ? p.fromName + ' sent you' : 'here is'} a ${money(p.amountCents)} gift card.` +
      `${p.code ? ' Code: ' + p.code + '.' : ''} Never expires — use it at checkout.`,
  },

  // The buyer's receipt. NO CODE: they may have bought it for somebody else, and a receipt is not
  // where a bearer instrument should live. When they bought it for themselves there is no separate
  // recipient, so they get 'gift.issued' instead and this template is never queued.
  'gift.purchased': {
    msgClass: 'transactional',
    subject: (_p, venue) => `Your ${venue.name} gift card order`,
    email: (p, venue) => [
      `Hi${p.name ? ' ' + p.name : ''},`,
      '',
      `Thanks — your ${money(p.amountCents)} gift card for ${venue.name} is paid for.`,
      '',
      p.recipientName || p.recipientTo
        ? `  Sent to: ${[p.recipientName, p.recipientTo].filter(Boolean).join(' · ')}`
        : '  It is on its way.',
      p.deliverOn ? `  Delivering: ${dayText(p.deliverOn)}` : null,
      '',
      'The code went to them directly, so it stays private. We do not keep a copy we can read',
      'back to you — if it goes missing, call the shop and we will re-issue the balance.',
      venue.phone ? `  ${venue.phone}` : null,
    ].filter((l) => l !== null).join('\n'),
    sms: (p, venue) =>
      `${venue.name}: your ${money(p.amountCents)} gift card is paid for and on its way${p.recipientName ? ' to ' + p.recipientName : ''}.`,
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

// ----- Gift-card delivery ---------------------------------------------------------------
//
// Called once, from api/gift-cards.js, the moment a purchase is confirmed paid. Two messages at
// most: the card to whoever it is for, and a receipt to whoever paid. When there is no separate
// recipient (somebody buying for themselves) only the first is queued, to the buyer.
//
// THE CODE AND THE OUTBOX. Everything else in the gift-card feature keeps one rule — the plaintext
// code is never stored — and a queued notification is a stored row, so this function is the single
// place that rule is relaxed, and only for as long as delivery takes:
//
//   enqueue → the row holds the code, because renderNotification() builds the body from the row
//             and a retry has to be able to rebuild the same message;
//   sent    → the code is stripped from the payload immediately (scrubDeliveredCode below).
//
// So a database dump taken at any moment holds codes only for cards whose delivery is still in
// flight or has permanently failed, rather than for every card ever sold. A failed row is left
// with its code deliberately: it is the only remaining copy, and an operator reading it out of the
// outbox is a better outcome than a customer who paid and received nothing.
//
// Best-effort throughout, like notifyBookingConfirmed: a card that is paid for and issued must
// never be reported as failed because a message could not be queued.
export async function notifyGiftCard({
  cardId, code, amountCents, purchaserName, purchaserEmail, purchaserPhone,
  recipientName, recipientEmail, recipientPhone, message, deliverAt,
  customerId, env = process.env, sendNow = true,
} = {}) {
  const key = cardId || `${purchaserEmail || purchaserPhone || 'anon'}:${amountCents}`;
  const hasRecipient = isEmail(recipientEmail) || isPhone(recipientPhone);
  const toName = hasRecipient ? (recipientName || null) : (purchaserName || null);
  const cardPayload = {
    cardId, code, amountCents, name: toName, message: message || null,
    // "From" only when it is actually a gift to someone else — nobody needs telling they sent
    // themselves a card.
    fromName: hasRecipient ? (purchaserName || null) : null,
  };
  const out = { card: null, receipt: null, sent: [] };

  try {
    // Scheduled delivery ("give it to her on the 14th"): hold the row until then and do not try
    // to send now. deliver_at is already stored on the card row; this mirrors it into the queue.
    const sendAfter = deliverAt && Date.parse(deliverAt) > Date.now() ? deliverAt : undefined;

    const cardEmail = hasRecipient ? recipientEmail : purchaserEmail;
    const cardPhone = hasRecipient ? recipientPhone : purchaserPhone;
    if (isEmail(cardEmail)) {
      out.card = await enqueue({
        channel: 'email', recipient: cardEmail, template: 'gift.issued',
        payload: cardPayload, dedupeKey: `gift.issued:email:${key}`, customerId, sendAfter,
      });
    } else if (isPhone(cardPhone)) {
      // Only fall back to SMS when there is no email to send to: a gift card in a text message is
      // a code with no context, and the recipient's consent state may not be known at all.
      const cust = await customerHoursByContact({ phone: cardPhone });
      if (!cust || (cust.sms_consent && !cust.sms_unsub_at)) {
        out.card = await enqueue({
          channel: 'sms', recipient: cardPhone, template: 'gift.issued',
          payload: cardPayload, dedupeKey: `gift.issued:sms:${key}`, customerId, sendAfter,
        });
      }
    }

    if (hasRecipient && isEmail(purchaserEmail)) {
      out.receipt = await enqueue({
        channel: 'email', recipient: purchaserEmail, template: 'gift.purchased',
        payload: {
          cardId, amountCents, name: purchaserName || null,
          recipientName: recipientName || null,
          recipientTo: recipientEmail || recipientPhone || null,
          deliverOn: sendAfter ? String(sendAfter).slice(0, 10) : null,
        },
        dedupeKey: `gift.purchased:email:${key}`, customerId,
      });
    }

    // Deliver straight away unless the buyer asked for a later date — this repo has no scheduler
    // yet, so a card that waited for one would simply never arrive.
    if (sendNow && !sendAfter) {
      const venue = venueIdentity(await getSettings(), env);
      for (const r of [out.card, out.receipt]) {
        if (r && r.row) {
          const outcome = await sendOne(r.row, { env, venue });
          out.sent.push(outcome);
          if (outcome === 'sent' && r.row.template === 'gift.issued') await scrubDeliveredCode(r.row);
        }
      }
    }
  } catch (err) {
    console.error('notifyGiftCard:', err && err.message ? err.message : err);
  }
  return out;
}

// Take the gift code back out of a delivered row. The message is already with the customer, so the
// payload no longer needs to be able to rebuild it — and what is left in the database is a record
// that a card was sent, not a spendable card.
async function scrubDeliveredCode(row) {
  if (!row || !row.id) return;
  const { code, ...rest } = (row.payload && typeof row.payload === 'object') ? row.payload : {};
  if (!code) return;
  await updateNotification(row.id, { payload: { ...rest, codeRedacted: true } });
}

// ----- Waiting list (migration 0022) ----------------------------------------------------
//
// Registered by assignment rather than inside the TEMPLATES literal above, so this whole feature
// is an append to this file and nothing already in it moves. Both templates are available to
// anything that imports lib/notify.js, which matters: sendDue() renders a queued row from the
// TEMPLATES table, so a template that only existed inside the waiting-list API route would leave
// a retried row unrenderable.

// The offer itself. THIS IS THE MESSAGE THE WHOLE FEATURE EXISTS TO SEND — a slot came free, it is
// being held for this one person, and here is how long they have. Everything the customer needs to
// decide is in the first two lines, because it will be read on a phone, possibly while driving.
//
// msg_class is 'commercial': it invites a purchase, so CASL requires express consent, which is
// exactly what api/waitlist.js records when they join the list. sendOne() enforces that at send
// time against public.customers, so an entry whose consent never made it there is never texted.
TEMPLATES['waitlist.offer'] = {
  msgClass: 'commercial',
  subject: (p, venue) => `A bay just opened — ${p.bayName || 'your bay'}, ${dayText(p.dateISO)}`,
  email: (p, venue) => [
    `Hi${p.name ? ' ' + p.name : ''},`,
    '',
    `A time you asked about has just come free at ${venue.name}:`,
    '',
    `  ${p.bayName || p.bayId || 'A bay'}`,
    `  ${slotText(p)}`,
    '',
    p.holdSlot
      ? `It is being held for you — nobody else on the waiting list has been told about it.`
      : `You are first in line for it — nobody else on the waiting list has been told yet.`,
    p.expiresText ? `You have until ${p.expiresText} to take it.` : null,
    '',
    p.claimUrl ? `Take it: ${p.claimUrl}` : (venue.phone ? `Call us to take it: ${venue.phone}` : null),
    p.declineUrl ? `Not this time? ${p.declineUrl}` : null,
    '',
    'If you do nothing, it goes to the next person on the list.',
  ].filter((l) => l !== null).join('\n'),
  sms: (p, venue) =>
    `${venue.name}: ${p.bayName || 'a bay'} just opened — ${slotText(p)}. ` +
    `Yours${p.expiresText ? ' until ' + p.expiresText : ''}.${p.claimUrl ? ' ' + p.claimUrl : ''}`,
};

// The receipt for joining. Transactional: they asked to be put on a list and this is the record of
// it, plus the link that takes them off it again.
TEMPLATES['waitlist.joined'] = {
  msgClass: 'transactional',
  subject: (p, venue) => `You're on the waiting list — ${dayText(p.dateISO)}`,
  email: (p, venue) => [
    `Hi${p.name ? ' ' + p.name : ''},`,
    '',
    `You're on the waiting list at ${venue.name} for:`,
    '',
    `  ${dayText(p.dateISO)}`,
    `  ${p.windowText || ''}`,
    p.bayText ? `  ${p.bayText}` : null,
    '',
    'If a bay comes free we will contact you straight away, and hold it for you while you decide.',
    p.quietText || null,
    '',
    p.manageUrl ? `Changed your mind? ${p.manageUrl}` : (venue.phone ? `Changed your mind? Call us at ${venue.phone}.` : null),
  ].filter((l) => l !== null).join('\n'),
  sms: (p, venue) =>
    `${venue.name}: you're on the waiting list for ${dayText(p.dateISO)}${p.windowText ? ', ' + p.windowText : ''}. ` +
    `We'll message you if a bay frees up.`,
};

// Tell one customer their slot is waiting. Called by api/waitlist.js for every live offer that has
// not been delivered yet — including offers from an earlier sweep whose message failed, which is
// why it is keyed on the offer id and safe to call again.
//
// Best-effort like every other consumer in this file: an offer that could not be announced is left
// for the next sweep, and nothing here can throw at the sweep that called it.
export async function notifyWaitlistOffer({
  offerId, dateISO, bayId, bayName, startMin, endMin, expiresText, holdSlot = true,
  claimUrl, declineUrl, name, email, phone, emailOk = false, smsOk = false,
  customerId, env = process.env, sendNow = true,
} = {}) {
  const payload = {
    offerId, dateISO, bayId, bayName, startMin, endMin,
    expiresText: expiresText || null, holdSlot: !!holdSlot,
    claimUrl: claimUrl || null, declineUrl: declineUrl || null, name: name || null,
  };
  const out = { email: null, sms: null, channels: [], sent: [] };
  if (!offerId) return out;
  try {
    if (emailOk && isEmail(email)) {
      out.email = await enqueue({
        channel: 'email', recipient: email, template: 'waitlist.offer',
        payload, dedupeKey: `waitlist.offer:email:${offerId}`, customerId,
      });
      if (out.email && !out.email.error) out.channels.push('email');
    }
    if (smsOk && isPhone(phone)) {
      out.sms = await enqueue({
        channel: 'sms', recipient: phone, template: 'waitlist.offer',
        payload, dedupeKey: `waitlist.offer:sms:${offerId}`, customerId,
      });
      if (out.sms && !out.sms.error) out.channels.push('sms');
    }
    // Send immediately. A claim window measured in minutes cannot wait for a queue worker, and
    // the row is already durable, so a failure here just means the next sweep retries it.
    if (sendNow) {
      const venue = venueIdentity(await getSettings(), env);
      for (const r of [out.email, out.sms]) {
        if (r && r.row) out.sent.push(await sendOne(r.row, { env, venue }));
      }
    }
  } catch (err) {
    console.error('notifyWaitlistOffer:', err && err.message ? err.message : err);
  }
  return out;
}

// "You're on the list." Sent once, when they join.
export async function notifyWaitlistJoined({
  entryId, dateISO, windowText, bayText, quietText, manageUrl,
  name, email, phone, emailOk = false, smsOk = false, customerId, env = process.env, sendNow = true,
} = {}) {
  const payload = { entryId, dateISO, windowText: windowText || null, bayText: bayText || null,
                    quietText: quietText || null, manageUrl: manageUrl || null, name: name || null };
  const out = { email: null, sms: null, sent: [] };
  if (!entryId) return out;
  try {
    if (emailOk && isEmail(email)) {
      out.email = await enqueue({
        channel: 'email', recipient: email, template: 'waitlist.joined',
        payload, dedupeKey: `waitlist.joined:email:${entryId}`, customerId,
      });
    } else if (smsOk && isPhone(phone)) {
      // Only one "you're on the list" message, and only by text when there is no email to use —
      // the confirmation is not worth two notifications.
      out.sms = await enqueue({
        channel: 'sms', recipient: phone, template: 'waitlist.joined',
        payload, dedupeKey: `waitlist.joined:sms:${entryId}`, customerId,
      });
    }
    if (sendNow) {
      const venue = venueIdentity(await getSettings(), env);
      for (const r of [out.email, out.sms]) {
        if (r && r.row) out.sent.push(await sendOne(r.row, { env, venue }));
      }
    }
  } catch (err) {
    console.error('notifyWaitlistJoined:', err && err.message ? err.message : err);
  }
  return out;
}


// ----- Customer account sign-in code (migration 0025) -----------------------------------
//
// The one-time code that proves somebody holds the phone number they typed. Transactional by any
// reading of CASL: it is a security step the person just asked for, not a solicitation, so it is
// exempt from the express-consent requirement the commercial templates carry — a customer signing
// up has not consented to anything yet, and could not receive this if it were commercial.
//
// The code is in the payload and therefore in the notifications row. That is deliberate: the row
// is what a retry re-renders from. It is short-lived and single-use, api/account.js stores only a
// SHA-256 of it, and the outbox is server-only under RLS (0025 revokes it from anon and
// authenticated alike). Do not add it to any email or log line beyond this.
TEMPLATES['account.code'] = {
  msgClass: 'transactional',
  subject: (p, venue) => `Your ${venue.name} sign-in code`,
  email: (p, venue) => [
    `Your ${venue.name} code is ${p.code}.`,
    '',
    `It expires in ${p.minutes} minutes and can be used once.`,
    '',
    'If you did not ask for this, you can ignore it — nobody can use it without your phone.',
  ].join('\n'),
  // Kept to one line: it is read off a lock screen, and some handsets truncate a preview hard.
  sms: (p, venue) => `${venue.name}: your code is ${p.code}. Expires in ${p.minutes} min. If this wasn't you, ignore it.`,
};

// ----- League team invite (migration 0031) ---------------------------------------------
//
// "Murad has paid for your spot on Aces — here's the link." Transactional, on the same reading as
// the gift-card template above: somebody has already paid for this, the recipient cannot use what
// was bought for them without the link, and nothing in it invites a purchase. The captain typed
// their friend's number themselves, which is the only way an invite ever exists.
//
// THE LINK IS THE SECRET. It is single-use and revocable (lib/db.js claimTeamInvite), so it is
// treated the way the waiting-list claim link is: sent to the one number it was made for, never
// logged beyond the normal "would have sent" line, and never shown to anyone else on the team.
TEMPLATES['league.invite'] = {
  msgClass: 'transactional',
  subject: (p, venue) => `${p.invitedBy ? p.invitedBy + ' has' : 'You have'} a spot on ${p.teamName || 'a team'} at ${venue.name}`,
  email: (p, venue) => [
    `Hi${p.name ? ' ' + p.name : ''},`,
    '',
    p.invitedBy
      ? `${p.invitedBy} has paid for your spot on ${p.teamName} in ${p.leagueName} at ${venue.name}.`
      : `You have a spot on ${p.teamName} in ${p.leagueName} at ${venue.name}.`,
    '',
    'There is nothing to pay and no fixed league night: your team plays once a week, whenever suits',
    `you${p.weeklyMins ? `, about ${Math.round((p.weeklyMins / 60) * 10) / 10} hours a round` : ''}. Any one of you books the week's round and everybody sees it.`,
    '',
    p.link ? `Join the team: ${p.link}` : (venue.phone ? `Call us to join: ${venue.phone}` : null),
    '',
    'The link works once and is just for you.',
  ].filter((l) => l !== null).join('\n'),
  sms: (p, venue) =>
    `${venue.name}: ${p.invitedBy ? p.invitedBy + ' has' : "you've"} got you a spot on ${p.teamName}` +
    `${p.leagueName ? ' in ' + p.leagueName : ''} — nothing to pay.${p.link ? ' Join: ' + p.link : ''}`,
};

// Send one invite. Best-effort in the same way as every other consumer here: a captain's invite
// is created and shown to them on screen whether or not a message can go out, so nothing below
// may throw at the API route that called it.
export async function notifyTeamInvite({
  inviteId, phone, name, link, teamName, leagueName, invitedBy, weeklyMins = null,
  customerId = null, env = process.env, sendNow = true,
} = {}) {
  const out = { sms: null, sent: [] };
  if (!inviteId || !isPhone(phone)) return out;
  const payload = { teamName: teamName || null, leagueName: leagueName || null, invitedBy: invitedBy || null,
    link: link || null, name: name || null, weeklyMins: weeklyMins || null };
  try {
    out.sms = await enqueue({
      channel: 'sms', recipient: phone, template: 'league.invite',
      payload, dedupeKey: `league.invite:sms:${inviteId}`, customerId,
    });
    if (sendNow && out.sms && out.sms.row) {
      out.sent.push(await sendOne(out.sms.row, { env, venue: venueIdentity(await getSettings(), env) }));
    }
  } catch (err) {
    console.error('notifyTeamInvite:', err && err.message ? err.message : err);
  }
  return out;
}
