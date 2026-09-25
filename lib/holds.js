// The ONE place this app turns a card HOLD into money, or gives it back.
//
// lib/refunds.js is the mirror of this file and the two must not be confused, because telling a
// customer the wrong one is a real-world lie:
//
//     a HELD booking has never been charged.   Cancelling it RELEASES the authorisation.
//     a PAID booking has been charged.         Cancelling it REFUNDS through lib/refunds.js.
//
// A release is not a refund. Nothing appears on the customer's statement, there is nothing to wait
// five business days for, and nothing belongs in public.refunds. Saying "refunded" to someone who
// was never charged sends them looking for money that was never taken.
//
// ⚠ THE DEADLINE THAT MAKES THIS URGENT. A card authorisation expires — Stripe documents ~7 days
// for an online card payment, and when it passes "the funds are released and the payment status
// changes to `canceled`". Capture is MANUAL here: a human presses a button. So a hold nobody
// presses is not a stuck task, it is money the venue never receives, and no error is ever raised.
// bookings.hold_expires_at is the deadline and heldBookings() in lib/db.js is the list that makes
// the forgotten ones visible. Sort it on hold_expires_at ascending.
//
// THE ORDER HERE IS THE OPPOSITE OF A REFUND, and deliberately. A refund records the obligation
// FIRST because money that moves without a record is unaccountable. A capture has nothing to record
// in advance — there is no obligation, only an authorisation Stripe is already holding — so it
// moves the money first and writes the state second. If the write fails, the booking is understated
// (it still reads 'held' while the money is in the bank) and TWO things put that right by
// themselves: the payment_intent.succeeded webhook, and pressing Capture again, which finds the
// PaymentIntent already captured and settles the row without touching Stripe twice.
import { bookingForHold, setPaymentState, bookingExistsForPI } from './db.js';
import { holdExpiryFrom } from './booking.js';

const money = (cents) => `$${((Number(cents) || 0) / 100).toFixed(2)}`;

// A PaymentIntent that a customer has just finished, as columns on a booking row. ONE function, so
// the client-side confirm in api/checkout.js and the webhook in api/webhook.js cannot record the
// same payment two different ways — they are deliberately double-covered and must agree exactly.
//
//   requires_capture  the authorisation landed. The booking is REAL and the slot is taken, but
//                     nothing has been charged: amount_cents stays 0 so nothing can be refunded out
//                     of a hold, and authorized_cents carries what is reserved.
//   succeeded         money has moved, either captured or charged in full at booking.
//
// `charge` is optional and only sharpens hold_expires_at: its
// payment_method_details.card.capture_before is the card network's own deadline, which beats the
// estimate the checkout wrote into the PaymentIntent's metadata.
export function paymentPatchFor({ pi, charge = null } = {}) {
  if (!pi) return {};
  const md = pi.metadata || {};
  if (pi.status === 'requires_capture') {
    const authorised = Math.max(0, Number(pi.amount_capturable) || Number(pi.amount) || 0);
    return {
      payment_state: 'held',
      amount_cents: 0,
      authorized_cents: authorised,
      hold_expires_at: holdExpiryFrom(charge, md.holdExpiresAt || null),
    };
  }
  const received = Math.max(0, Number(pi.amount_received) || Number(pi.amount) || 0);
  return {
    payment_state: 'paid',
    amount_cents: received,
    // A far-ahead booking charged in full was never authorised separately, so there is no hold to
    // record — authorized_cents is only set when the money really did sit on hold first.
    ...(md.paymentMode === 'hold' ? { authorized_cents: received } : {}),
    captured_at: new Date().toISOString(),
  };
}

// Stripe refuses a capture or a cancel on a PaymentIntent that is not in the state it expects —
// already captured, already cancelled, or expired out from under us. That is not a failure to
// report as one: it is Stripe telling us the world already looks the way the caller wanted.
function unexpectedState(err) {
  if (!err) return false;
  return err.code === 'payment_intent_unexpected_state'
    || /unexpected state|already been captured|already captured|already canceled|already cancelled/i.test(String(err.message || ''));
}

// What the portal, and a person, need to know about a hold right now.
export function holdView(booking, now = new Date()) {
  if (!booking) return null;
  const state = booking.payment_state || null;
  const expires = booking.hold_expires_at ? new Date(booking.hold_expires_at) : null;
  const msLeft = expires ? expires.getTime() - now.getTime() : null;
  return {
    bookingId: booking.id,
    paymentState: state,
    authorizedCents: Math.max(0, Number(booking.authorized_cents) || 0),
    capturedCents: Math.max(0, Number(booking.amount_cents) || 0),
    holdExpiresAt: booking.hold_expires_at || null,
    // Negative once the hold is gone. Rounded to a tenth of an hour so a list can say "3.4h left"
    // without every row being a different length.
    hoursLeft: msLeft == null ? null : Math.round((msLeft / 3600000) * 10) / 10,
    expired: msLeft != null && msLeft <= 0,
    capturable: state === 'held' && (msLeft == null || msLeft > 0),
  };
}

// The reading every guard below shares, so "is this capturable" is answered once.
function readHold(booking, now) {
  const view = holdView(booking, now);
  const pi = booking.stripe_payment_intent || null;
  return { view, pi, state: view.paymentState };
}

// ----- capture: charge a held booking ---------------------------------------------------------
//
//   stripe       a client from stripeClient(process.env)
//   bookingId    the booking to charge
//   amountCents  null / omitted = the whole authorised amount. A NUMBER captures less — a session
//                that ran shorter than it was booked. It can never be MORE: Stripe would refuse it
//                (overcapture is a separate feature) and so does the guard below, with a sentence.
//   by, note     who pressed the button, for the log
//
// ⚠ A PARTIAL CAPTURE IS FINAL. Stripe: "A partial capture automatically releases the remaining
// amount" and "you can only perform one capture on an authorised payment". Capturing $20 of a $25
// hold does not leave $5 on hold for later — the other $5 is gone. The message says so.
//
// Idempotent three times over: the state check refuses a second capture outright, the Stripe
// idempotency key would make a repeat of the same call return the same capture rather than a second
// one, and a PaymentIntent Stripe says is already captured settles the row instead of erroring.
export async function captureHold({ stripe, bookingId, amountCents = null, by = null, note = null, now = new Date() } = {}) {
  const booking = await bookingForHold(bookingId);
  if (!booking) return { code: 404, error: 'That booking no longer exists.' };
  const { view, pi, state } = readHold(booking, now);

  if (state === 'paid') {
    return { ok: true, already: true, moneyMoved: true, capturedCents: view.capturedCents, paymentState: 'paid',
      message: `Already captured — ${money(view.capturedCents)} has been taken.` };
  }
  if (state === 'released') {
    return { code: 409, reason: 'released', paymentState: 'released',
      error: 'This hold was released, so the customer was never charged and there is nothing to capture. '
        + 'Take payment at the counter, or have them book again.' };
  }
  if (state === 'refunded') {
    return { code: 409, reason: 'refunded', paymentState: 'refunded',
      error: 'This booking was charged and then refunded. There is nothing left to capture.' };
  }
  if (state !== 'held') {
    return { code: 409, reason: 'not_held', paymentState: state,
      error: 'This booking is not on hold. It was charged in full when it was booked — the session was '
        + 'further ahead than a card hold can last — so there is nothing to capture at check-in.' };
  }
  if (!pi) {
    return { code: 409, reason: 'no_payment_intent',
      error: 'This booking is marked as held but has no card payment on file, so nothing can be captured. '
        + 'Take payment at the counter and record it against the booking.' };
  }

  // THE CLIFF. Past this point the money is not late, it is gone, and pretending otherwise would
  // have staff standing at a counter waiting for a charge that can never land.
  if (view.expired) {
    return { code: 409, reason: 'expired', paymentState: 'held', holdExpiresAt: view.holdExpiresAt,
      error: `This hold expired on ${new Date(view.holdExpiresAt).toLocaleString('en-CA', { timeZone: 'America/Winnipeg' })}. `
        + 'A card authorisation only lasts about seven days, and once it lapses the bank releases the money — '
        + 'it cannot be captured now. Take payment at the counter, then release this hold to tidy the list.' };
  }

  const authorised = view.authorizedCents;
  const amount = amountCents == null ? authorised : Math.round(Number(amountCents));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { code: 400, reason: 'bad_amount', error: 'Enter an amount greater than zero, or leave it out to capture the full hold.' };
  }
  if (authorised > 0 && amount > authorised) {
    return { code: 400, reason: 'over_capture', authorizedCents: authorised,
      error: `You can only capture up to what is on hold. ${money(authorised)} was authorised, so ${money(amount)} cannot be taken. `
        + 'Capture the hold and take the difference separately.' };
  }

  let captured;
  try {
    captured = await stripe.paymentIntents.capture(pi, { amount_to_capture: amount },
      // Keyed on the booking AND the amount: pressing the same button twice captures once, while a
      // genuinely different amount is a genuinely different request rather than a silent no-op.
      { idempotencyKey: `invictus_capture_${booking.id}_${amount}` });
  } catch (err) {
    // ⚠ TWO OPPOSITE THINGS ARRIVE AS THIS ONE ERROR, and guessing between them is the difference
    // between a booking that says 'paid' with money behind it and one that says 'paid' with nothing
    // behind it at all:
    //     already captured → the money moved and only our row is behind. Settle it.
    //     canceled         → the hold was released, or it EXPIRED and Stripe cancelled it by itself.
    //                        Nothing moved and nothing ever will.
    // So ASK Stripe which it is instead of assuming the happy one.
    if (unexpectedState(err)) return reconcileAfterCapture({ stripe, booking, pi, amount });
    console.error('Capture failed at Stripe:', err && err.message);
    return { code: 502, reason: 'stripe_failed', moneyMoved: false,
      error: `Stripe could not capture this hold: ${err && err.message ? err.message : 'unknown error'}. `
        + 'Nothing was charged and the hold is still in place — you can try again.' };
  }

  const took = Math.max(0, Number(captured && captured.amount_received) || amount);
  console.log(`✅ Hold captured — booking ${booking.id}, ${money(took)}${by ? ` by ${by}` : ''}${note ? ` (${String(note).slice(0, 120)})` : ''}`);
  const settled = await settleCaptured({ booking, amount: took });
  const short = authorised > 0 && took < authorised;
  return {
    ok: true, moneyMoved: true, paymentState: 'paid',
    capturedCents: took, authorizedCents: authorised, releasedCents: short ? authorised - took : 0,
    ledgerWarning: settled.error
      ? 'The money was captured but the booking was not updated — the Stripe webhook will finish it.' : undefined,
    message: short
      ? `${money(took)} captured of the ${money(authorised)} held. The remaining ${money(authorised - took)} `
        + 'has been released back to the customer and cannot be captured later.'
      : `${money(took)} captured. The customer's card has now been charged.`,
  };
}

// amount_cents is what MOVED — that is the number lib/refunds.js measures a refund against, so a
// capture is the moment a booking first has anything refundable at all.
// Stripe refused the capture because the PaymentIntent is not where we thought it was. Read the
// PaymentIntent and believe IT, not the booking row.
async function reconcileAfterCapture({ stripe, booking, pi, amount }) {
  let live = null;
  try { live = await stripe.paymentIntents.retrieve(pi); } catch (_) { /* fall through to the honest answer */ }
  const status = live && live.status;

  if (status === 'succeeded') {
    const took = Math.max(0, Number(live.amount_received) || amount);
    const settled = await settleCaptured({ booking, amount: took });
    return { ok: true, already: true, moneyMoved: true, capturedCents: took, paymentState: 'paid',
      ledgerWarning: settled.error ? 'The capture went through but the booking was not updated.' : undefined,
      message: `${money(took)} was already captured at Stripe — the booking has been brought into line.` };
  }

  if (status === 'canceled') {
    // Released by hand, or expired and cancelled by Stripe. Either way the money is gone and the
    // row must stop claiming otherwise, or it sits on the warning list for ever saying "capture me".
    await setPaymentState({ bookingId: booking.id, state: 'released', expect: 'held',
      patch: { released_at: new Date().toISOString() } });
    return { code: 409, reason: 'expired', moneyMoved: false, paymentState: 'released',
      error: 'Stripe has already cancelled this authorisation — either it was released, or it lapsed. '
        + 'A card hold only lasts about seven days, and once it is gone the money cannot be captured. '
        + 'Nothing was charged. Take payment at the counter if the session went ahead.' };
  }

  return { code: 502, reason: 'stripe_state', moneyMoved: false,
    error: `Stripe would not capture this hold${status ? ` — the payment is "${status}"` : ''}. `
      + 'Nothing was charged. Check the payment in Stripe before trying again.' };
}

async function settleCaptured({ booking, amount }) {
  return setPaymentState({
    bookingId: booking.id, state: 'paid', expect: 'held',
    patch: { amount_cents: amount, captured_at: new Date().toISOString() },
  });
}

// ----- release a hold that never became a booking -----------------------------------------------
//
// The card was authorised, but the slot went to someone else before the booking could be saved.
// With no booking row, this hold is on no list anywhere and would sit on the customer's card for a
// week. Cancel it at Stripe now.
//
// ⚠ CHECK FIRST. The client-side confirm and the webhook race for the same PaymentIntent, and the
// "slot taken" one of them sees can be the OTHER one's row for this very payment. Releasing then
// would leave a real booking with nothing behind it — so a booking for this PaymentIntent wins.
export async function releaseUnbookedHold({ stripe, pi } = {}) {
  if (!pi || pi.status !== 'requires_capture') return { released: false };
  if (await bookingExistsForPI(pi.id)) return { released: false, booked: true };
  try {
    await stripe.paymentIntents.cancel(pi.id, { cancellation_reason: 'abandoned' },
      { idempotencyKey: `invictus_release_unbooked_${pi.id}` });
  } catch (err) {
    console.error(`Could not release the hold on ${pi.id} after its slot was taken:`, err && err.message);
    return { released: false, error: (err && err.message) || 'unknown error' };
  }
  console.log(`✅ Hold released — ${pi.id}, slot was taken before the booking could be saved`);
  return { released: true };
}

// ----- release: cancel the authorisation ------------------------------------------------------
//
// The customer is never charged. Nothing reaches their statement, nothing is recorded in
// public.refunds, and the pending line their bank may be showing disappears within a few days —
// how fast is the issuer's business, not Stripe's, which is the one thing to say out loud.
export async function releaseHold({ stripe, bookingId, reason = null, by = null, now = new Date() } = {}) {
  const booking = await bookingForHold(bookingId);
  if (!booking) return { code: 404, error: 'That booking no longer exists.' };
  const { view, pi, state } = readHold(booking, now);

  if (state === 'released') {
    return { ok: true, already: true, moneyMoved: false, paymentState: 'released',
      message: 'This hold was already released — the customer was never charged.' };
  }
  if (state === 'paid' || state === 'refunded') {
    return { code: 409, reason: 'already_captured', paymentState: state,
      error: 'This booking has already been charged, so there is no hold to release. Refund it instead.' };
  }
  if (state !== 'held') {
    return { code: 409, reason: 'not_held', paymentState: state,
      error: 'This booking is not on hold, so there is nothing to release.' };
  }
  if (!pi) {
    // Nothing at Stripe to cancel, but the row says 'held' and would otherwise sit on the warning
    // list for ever. Mark it released and say what happened.
    await setPaymentState({ bookingId: booking.id, state: 'released', expect: 'held', patch: { released_at: new Date().toISOString() } });
    return { ok: true, moneyMoved: false, paymentState: 'released',
      message: 'There was no card payment on this booking, so nothing was held and nothing was released.' };
  }

  try {
    await stripe.paymentIntents.cancel(pi, { cancellation_reason: 'abandoned' },
      { idempotencyKey: `invictus_release_${booking.id}` });
  } catch (err) {
    if (!unexpectedState(err)) {
      console.error('Release failed at Stripe:', err && err.message);
      return { code: 502, reason: 'stripe_failed', moneyMoved: false,
        error: `Stripe could not release this hold: ${err && err.message ? err.message : 'unknown error'}. `
          + 'The hold is still in place — try again, or let it expire on its own.' };
    }
    // Already cancelled, or expired on its own. Either way the customer is not charged, which is
    // the whole point — fall through and write it down.
  }

  console.log(`✅ Hold released — booking ${booking.id}, ${money(view.authorizedCents)} never charged`
    + `${by ? ` by ${by}` : ''}${reason ? ` (${String(reason).slice(0, 120)})` : ''}`);
  const settled = await setPaymentState({
    bookingId: booking.id, state: 'released', expect: 'held',
    patch: { released_at: new Date().toISOString(), authorized_cents: view.authorizedCents || null },
  });
  return {
    ok: true, moneyMoved: false, paymentState: 'released', releasedCents: view.authorizedCents,
    ledgerWarning: settled.error ? 'The hold was released but the booking was not updated.' : undefined,
    message: view.expired
      ? 'This hold had already lapsed, so nothing was charged. It is now marked released and off the list.'
      : `The ${money(view.authorizedCents)} hold has been released. The customer is not charged, and nothing `
        + 'will appear on their statement — any pending line their bank is showing clears on the bank’s own schedule.',
  };
}
