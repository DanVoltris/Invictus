import { admin, getSettings, creditBackOnCancel } from '../lib/db.js';
import { normalizeSettings, bayName, fmtMin, hoursUntilBooking, winnipegTodayISO,
         stripeStatus, stripeClient } from '../lib/booking.js';
import { issueRefund } from '../lib/refunds.js';
import { releaseHold as releaseAuthorisation } from '../lib/holds.js';

// Customer self-service, one function (keeps the deployment under Vercel's function cap):
//   GET  ?id=…                    → read-only lookup of a booking (customer-safe fields only)
//   POST {id}                     → cancel the booking AND refund it (24-hour policy, server-side)
//   POST ?action=league-round     → retired: league rounds are paid bookings made at checkout
// The old GET ?phone=… account summary is gone: it handed out a customer's name, balances and
// bookings to anyone who typed their number. My Account (migration 0025) needs a sign-in instead.
// Payment states in which the customer has not been charged a cent — cancelling releases, never refunds.
const NEVER_CHARGED = ['held', 'card_saved', 'hold_failed'];

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || '';
  if (req.method === 'POST' && action === 'league-round') return leagueRound(req, res);
  if (req.method === 'POST') return cancel(req, res);
  return lookup(req, res);
}

async function lookup(req, res) {
  const id = (req.query && req.query.id) || '';
  if (!/^[0-9a-fA-F-]{10,}$/.test(id)) return res.status(400).json({ ok: false, error: 'Invalid link.' });
  const db = admin();
  if (!db) return res.status(503).json({ ok: false, error: 'Not configured.' });

  const { data, error } = await db
    .from('bookings')
    .select('*')     // payment_state and authorized_cents included — see the cancel handler below
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ ok: false, error: 'Booking not found.' });

  const settings = normalizeSettings(await getSettings());
  const hoursUntil = hoursUntilBooking(data.booking_date, data.start_min);
  res.status(200).json({
    ok: true,
    booking: {
      id: data.id,
      bay: bayName(settings, data.bay_id) || data.bay_id,
      booking_date: data.booking_date,
      start: fmtMin(data.start_min),
      end: fmtMin(data.end_min),
      status: data.status,
      customerName: data.customer_name || null,
      hoursUntil,
      canCancel: data.status === 'confirmed' && hoursUntil >= 24,
      // What cancelling now would send back, so the page can say the number before the customer
      // commits rather than after. Customer-safe: it is their own booking and their own money.
      paidCents: Math.max(0, Number(data.amount_cents) || 0),
      refundableCents: Math.max(0, (Number(data.amount_cents) || 0) - (Number(data.refunded_cents) || 0)),
      // …and whether there is anything to send back at all. A HELD booking was never charged:
      // paidCents is 0, authorizedCents is what is reserved, and cancelling releases it rather than
      // refunding it. A page that shows "You'll be refunded $25" to a held booking is wrong twice.
      paymentState: data.payment_state || null,
      authorizedCents: Math.max(0, Number(data.authorized_cents) || 0),
      holdExpiresAt: data.hold_expires_at || null,
      // A saved card (migration 0035) was never charged either, so it releases too.
      cancelEffect: NEVER_CHARGED.includes(data.payment_state) ? 'release' : 'refund',
    },
  });
}

// ----- customer self-cancellation ------------------------------------------------------------
//
// WHAT THIS USED TO DO, AND WHY IT WAS WRONG. It flipped the booking to 'cancelled', answered
// `{ ok: true }`, and kept the money — silently. Meanwhile /manage told the customer "Free
// cancellation up to 24 hours before your tee time" and settings.pay.paymentDisclaimer promised
// "Refunds will be issued if cancellation notice is provided at least 24 hours prior". Two
// promises, no refund path, and a customer with no way to know the difference.
//
// THE CHOICE MADE HERE: it refunds. Not because a refund is always right, but because THE GATE
// THIS FUNCTION ALREADY ENFORCES IS THE REFUND POLICY. The 24-hour rule below is not a booking
// rule that happens to sit near a money rule — it is the venue's cancellation policy, and it
// already refuses every cancellation the policy would not refund ("please call the shop"). So
// every cancellation that gets past it is, by the venue's own published terms, a refundable one.
// Cancelling it without paying it back would mean enforcing the half of the policy that protects
// the venue and ignoring the half that protects the customer. The alternative — keep cancelling
// and merely warn "no refund" — would have meant changing the promise on three pages and giving
// the customer a worse deal than the one they booked under.
//
// WHAT IT NEVER DOES: fail the cancellation because the refund failed. The customer asked to
// cancel; that part is theirs and it is done first. If Stripe is off, misconfigured, or the
// booking was not paid by card, the obligation is still RECORDED (method 'manual') and the answer
// says plainly that the money has not moved yet and who will move it. The response's `refund`
// object is the only thing a page should believe — `moneyMoved` in particular.
//
// The refund is the full remaining balance and the amount is never taken from the request body:
// the caller supplies a booking id and nothing else, exactly as before.
async function cancel(req, res) {
  const id = (req.body && req.body.id) || '';
  if (!/^[0-9a-fA-F-]{10,}$/.test(id)) return res.status(400).json({ ok: false, error: 'Invalid request.' });
  const db = admin();
  if (!db) return res.status(503).json({ ok: false, error: 'Not configured.' });

  // select('*') so payment_state comes with it: whether this cancellation RELEASES a hold or
  // REFUNDS a charge is decided from that column, and a named list would be the one thing that
  // breaks on a database still on migration 0033 instead of falling back to the old behaviour.
  const { data, error } = await db
    .from('bookings')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ ok: false, error: 'Booking not found.' });

  if (data.status === 'cancelled') return res.status(200).json({ ok: true, already: true });
  if (data.status !== 'confirmed') return res.status(400).json({ ok: false, error: "This booking can't be cancelled online." });

  const hoursUntil = hoursUntilBooking(data.booking_date, data.start_min);
  if (hoursUntil < 24) {
    return res.status(403).json({
      ok: false,
      code: 'too_late',
      error: 'Cancellations must be made at least 24 hours before your tee time. Please call the shop to cancel.',
    });
  }

  // Try to record the cancellation time; fall back to a plain status update if the column
  // isn't there yet (migration 0005 not run).
  let upd = await db.from('bookings').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', id);
  if (upd.error && /cancelled_at/.test(upd.error.message || '')) {
    upd = await db.from('bookings').update({ status: 'cancelled' }).eq('id', id);
  }
  if (upd.error) return res.status(500).json({ ok: false, error: upd.error.message });

  // WHICH WAY THE MONEY GOES IS NOT A PREFERENCE, IT IS A FACT ABOUT THIS BOOKING.
  //
  //   payment_state 'held'  the card was AUTHORISED and never charged, because the session was near
  //                         enough for a hold to survive. Cancelling RELEASES the authorisation.
  //                         There is nothing to refund and saying "refunded" would send a customer
  //                         hunting their statement for money that never left it.
  //   anything else         the card was charged in full at booking. Cancelling REFUNDS it, through
  //                         the path in lib/refunds.js, exactly as before.
  //   'card_saved' / 'hold_failed'  a far-ahead booking whose card was only SAVED (migration 0035).
  //                         Never charged either: releasing just forgets the card.
  // Gift-card value and prepaid hours spent on it come back too — before, only a card was refunded,
  // and a booking paid entirely with either was told "nothing to refund".
  const credit = creditMessage(await creditBackOnCancel(id));
  if (NEVER_CHARGED.includes(data.payment_state)) {
    return res.status(200).json({ ok: true, release: await releaseOnSelfCancel(id), ...(credit && { credit }) });
  }
  const refund = await refundOnSelfCancel(id);
  // "Nothing to refund" is only true of the card when something else paid for it.
  if (credit && refund.status === 'none') refund.message = 'Your booking is cancelled.';
  res.status(200).json({ ok: true, refund, ...(credit && { credit }) });
}

// What came back besides money on a card, in the customer's words — or null when nothing did.
function creditMessage(c) {
  if (!c || (!c.giftCents && !c.hoursMin)) return null;
  const parts = [];
  if (c.giftCents) parts.push(`$${(c.giftCents / 100).toFixed(2)} back on your gift card`);
  if (c.hoursMin) parts.push(`${+(c.hoursMin / 60).toFixed(2)} prepaid hour${c.hoursMin === 60 ? '' : 's'} back on your account`);
  return { giftCents: c.giftCents, hoursMin: c.hoursMin, message: `We've put ${parts.join(' and ')}.` };
}

// The release half of the cancellation above — the hold version of refundOnSelfCancel. Same
// contract: it never throws, and it never claims anything about the customer's money that it did
// not get an answer for.
async function releaseOnSelfCancel(bookingId) {
  const { enabled } = stripeStatus(process.env);
  if (!enabled) {
    return { released: false, moneyMoved: false, status: 'pending',
      message: 'Your booking is cancelled. Your card was only held, never charged, and the hold is '
        + 'being released — it clears on your bank’s own schedule.' };
  }
  let out;
  try {
    out = await releaseAuthorisation({ stripe: stripeClient(process.env), bookingId, reason: 'cancelled online (24-hour policy)', by: 'customer' });
  } catch (err) {
    console.error('self-cancel release:', err && err.message);
    out = null;
  }
  if (!out || !out.ok) {
    // The booking IS cancelled either way — that part is the customer's and it is done. The hold
    // expires on its own within about seven days even if nobody touches it, so the worst case is a
    // wait, never a charge. Say exactly that.
    return { released: false, moneyMoved: false, status: 'pending',
      message: 'Your booking is cancelled. Your card was only held, never charged. We could not '
        + 'release the hold automatically — it will clear on its own within about a week, and you '
        + 'can call the shop if your bank is still showing it after that.' };
  }
  return { released: true, moneyMoved: false, status: out.paymentState,
    amountCents: out.releasedCents || 0, message: out.message };
}

// The refund half of the cancellation above. Returns a small object a page can show verbatim —
// it never throws, and it never reports money moved unless Stripe said so.
async function refundOnSelfCancel(bookingId) {
  const { enabled } = stripeStatus(process.env);
  let out;
  try {
    out = await issueRefund({
      stripe: enabled ? stripeClient(process.env) : null,
      bookingId,
      amountCents: null,                       // everything still refundable — never from the body
      reason: 'cancelled online (24-hour policy)',
      // One key per booking: a customer who double-clicks Cancel, or retries after a dropped
      // connection, gets one refund. A second cancellation of the same booking is impossible
      // anyway (the status check above), but the key is what makes that true of the money.
      ref: `self-cancel:${bookingId}`,
      by: 'customer',
      allowManual: true,                       // no card on file → record the obligation, don't drop it
    });
  } catch (err) {
    console.error('self-cancel refund:', err && err.message);
    return { moneyMoved: false, status: 'pending', amountCents: null,
      message: 'Your booking is cancelled. Your refund could not be sent automatically — please call the shop and we will issue it.' };
  }

  if (out.nothingToRefund) {
    return { moneyMoved: false, status: 'none', amountCents: 0,
      message: 'There was nothing to pay for this booking, so there is nothing to refund.' };
  }
  if (!out.ok) {
    // Recorded-but-not-sent, or refused outright. Either way the customer is told the truth and
    // given the next step; staff see the obligation in the refunds table.
    console.warn(`self-cancel refund for ${bookingId}: ${out.error}`);
    return { moneyMoved: false, status: 'pending', refundId: out.refundId || null, amountCents: out.amountCents || null,
      message: 'Your booking is cancelled. Your refund has not gone through automatically — the shop has been notified '
        + 'and will issue it. Please call us if it has not arrived within 10 business days.' };
  }
  return {
    moneyMoved: !!out.moneyMoved,
    status: out.status,
    amountCents: out.amountCents,
    refundId: out.refundId,
    message: out.moneyMoved
      ? out.message
      : (out.method === 'manual'
        ? 'Your booking is cancelled. This one was not paid by card, so the shop will put the money back the way you paid it.'
        : out.message),
  };
}

// ----- A team's weekly league round: no longer booked here -----------------------------
//
// This used to book a team's round for nothing. League teams pay for their bay time, so a league
// round is now an ordinary paid booking made through checkout (api/checkout.js, `teamId`), where it
// is tagged as the team's round and gets the league discount. This action only says so — a page
// still open from before the change must not be able to book free bay time.
async function leagueRound(req, res) {
  return res.status(410).json({ ok: false, code: 'league_round_moved',
    error: 'League rounds are now booked and paid for at checkout. Refresh this page, pick your time, and choose your team at checkout to count it as your league round.' });
}
