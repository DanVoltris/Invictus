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
//
// DEFERRED HOLDS (migration 0035). A session too far ahead to hold at checkout is booked with the
// card SAVED and nothing charged — payment_state 'card_saved'. placeDueHolds() below turns it into
// an ordinary 'held' booking settings.pay.hold.leadDays before the session; if the card is declined
// the booking becomes 'hold_failed', which staff see and the customer is not told about. The saved
// card is detached once the booking is paid, released or cancelled: the venue does not keep cards.
import { bookingForHold, setPaymentState, bookingExistsForPI, getSettings, dueDeferredHolds } from './db.js';
import { holdExpiryFrom, normalizeSettings, bayName } from './booking.js';

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

// A SetupIntent the customer has just finished — a far-ahead booking with the card saved — as
// columns on a booking row. The SetupIntent twin of paymentPatchFor, shared by the client-side
// confirm and the webhook for the same reason. chargeCents and holdDueAt were written into the
// metadata by api/checkout.js, server-side, so neither comes from the browser.
export function savedCardPatchFor({ si } = {}) {
  if (!si) return {};
  const md = si.metadata || {};
  const idOf = (v) => (typeof v === 'string' ? v : (v && v.id) || null);
  return {
    payment_state: 'card_saved',
    amount_cents: 0,
    deferred_cents: Math.max(0, Number(md.chargeCents) || 0),
    hold_due_at: md.holdDueAt || null,
    stripe_setup_intent: si.id,
    stripe_payment_method: idOf(si.payment_method),
    stripe_customer: idOf(si.customer),
    hold_error: null,
  };
}

// The thing checkout handed the browser, read back from Stripe: a PaymentIntent (pi_…) for a hold
// or a charge, or a SetupIntent (seti_…) for a saved card. A SetupIntent has no amount, so the one
// checkout computed is read from its metadata, and its statuses are named like a PaymentIntent's —
// which is what lets the gift-card and promo endpoints check either with the same code.
export async function retrieveCheckoutIntent(stripe, id) {
  const ref = String(id || '');
  if (!ref.startsWith('seti_')) return stripe.paymentIntents.retrieve(ref);
  const si = await stripe.setupIntents.retrieve(ref);
  const md = si.metadata || {};
  return { ...si, amount: Math.max(0, Number(md.chargeCents) || 0), metadata: md };
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
  let booking = await bookingForHold(bookingId);
  if (!booking) return { code: 404, error: 'That booking no longer exists.' };

  // A saved card with no hold on it yet: the daily job has not reached it, or the card was declined
  // when it did. At the counter "Charge now" means exactly that, so place the hold on the saved card
  // first and capture it below like any other.
  if (booking.payment_state === 'card_saved' || booking.payment_state === 'hold_failed') {
    const placed = await placeDeferredHold({ stripe, booking, now });
    if (!placed.ok) {
      return { code: placed.code || 402, reason: placed.reason || 'declined', moneyMoved: false,
        paymentState: placed.paymentState || booking.payment_state, error: placed.error };
    }
    booking = await bookingForHold(bookingId);
    if (!booking) return { code: 404, error: 'That booking no longer exists.' };
  }
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
  await forgetSavedCard(stripe, booking);
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
export async function releaseHold({ stripe, bookingId, reason = null, by = null, now = new Date(), _raced = false } = {}) {
  const booking = await bookingForHold(bookingId);
  if (!booking) return { code: 404, error: 'That booking no longer exists.' };
  const { view, pi, state } = readHold(booking, now);

  // A saved card with no hold on it (or a declined one): there is nothing at Stripe to cancel, only
  // the card to forget. Compare-and-set on the state, because the daily job may be placing the hold
  // at this very moment — if it won, the booking is now 'held' and is released the ordinary way.
  if (state === 'card_saved' || state === 'hold_failed') {
    const settled = await setPaymentState({ bookingId: booking.id, state: 'released', expect: state,
      patch: { released_at: now.toISOString() } });
    if (!settled.error && !settled.updated && !_raced) {
      return releaseHold({ stripe, bookingId, reason, by, now, _raced: true });
    }
    await forgetSavedCard(stripe, booking);
    console.log(`✅ Saved card released — booking ${booking.id}, no hold had been placed`
      + `${by ? ` by ${by}` : ''}${reason ? ` (${String(reason).slice(0, 120)})` : ''}`);
    return {
      ok: true, moneyMoved: false, paymentState: 'released', releasedCents: 0,
      ledgerWarning: settled.error ? 'The booking was not updated — try again.' : undefined,
      message: 'No hold had been placed on this card yet, so nothing was charged. The saved card has been removed.',
    };
  }

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
  await forgetSavedCard(stripe, booking);
  return {
    ok: true, moneyMoved: false, paymentState: 'released', releasedCents: view.authorizedCents,
    ledgerWarning: settled.error ? 'The hold was released but the booking was not updated.' : undefined,
    message: view.expired
      ? 'This hold had already lapsed, so nothing was charged. It is now marked released and off the list.'
      : `The ${money(view.authorizedCents)} hold has been released. The customer is not charged, and nothing `
        + 'will appear on their statement — any pending line their bank is showing clears on the bank’s own schedule.',
  };
}

// ----- deferred holds: put the hold on a saved card (migration 0035) --------------------------
//
// ONE booking whose card was saved at checkout, turned into an ordinary 'held' booking. Called by
// placeDueHolds() when leadDays before the session arrives, and by captureHold() when staff press
// Charge on a saved card the job has not reached (or that was declined and may work now).
//
// The hold is MERCHANT-initiated — off_session, nobody at the keyboard — which is why it is placed
// only leadDays out: Visa honours those for 4 days 18 hours. capture_before on the charge is still
// the real deadline, and the 4d18h fallback is only used if Stripe does not say.
//
// Three outcomes, and they are kept apart on purpose:
//   held      the bank said yes. payment_state 'held', exactly as if it had been held at checkout.
//   declined  the bank said no, or wants the customer to confirm it themselves. payment_state
//             'hold_failed'. The booking STANDS and the customer is NOT told (the owner's rule);
//             it is on the staff Holds to Charge screen, and staff take payment at the counter.
//   retry     Stripe could not be reached. Nothing changes and the next run tries again, with the
//             SAME idempotency key — so if the first try did land at Stripe, the retry gets that
//             hold back instead of placing a second one.
//
// Compare-and-set on the way out: if the booking was cancelled or released while Stripe was
// answering, the hold just placed is let go at once instead of sitting on the card of a customer
// with no booking.
const MIT_WINDOW_MS = (4 * 24 + 18) * 3600000;

export async function placeDeferredHold({ stripe, booking, settings = null, now = new Date() } = {}) {
  const from = booking && booking.payment_state;
  if (!booking || (from !== 'card_saved' && from !== 'hold_failed')) {
    return { ok: false, code: 409, reason: 'not_saved', paymentState: from || null,
      error: 'This booking has no saved card waiting for a hold.' };
  }
  if (booking.status !== 'confirmed') {
    return { ok: false, code: 409, reason: 'not_confirmed', paymentState: from,
      error: 'This booking is not confirmed, so its card is not held.' };
  }
  const attempt = Math.max(0, Number(booking.hold_attempts) || 0);
  const amount = Math.max(0, Number(booking.deferred_cents) || 0);
  if (!booking.stripe_payment_method || !booking.stripe_customer || !(amount > 0)) {
    return markHoldFailed({ booking, from, attempt, why: 'no saved card is recorded on this booking' });
  }

  const s = settings || normalizeSettings(await getSettings());
  const bay = bayName(s, booking.bay_id) || booking.bay_id;
  let pi;
  try {
    pi = await stripe.paymentIntents.create({
      amount,
      currency: s.currency,
      customer: booking.stripe_customer,
      payment_method: booking.stripe_payment_method,
      off_session: true,
      confirm: true,
      capture_method: 'manual',
      payment_method_types: ['card'],
      expand: ['latest_charge'],
      description: `${bay} — simulator session`,
      // deferredBookingId is how the webhook knows this PaymentIntent belongs to an EXISTING booking.
      // dateISO/bayId are left out on purpose: they are what makes the webhook write a NEW booking.
      metadata: { deferredBookingId: booking.id, paymentMode: 'hold', bookingDate: String(booking.booking_date || ''), bayName: bay },
    }, { idempotencyKey: `invictus_deferred_hold_${booking.id}_${attempt}` });
  } catch (err) {
    if (!cardRefused(err)) {
      console.error(`Deferred hold for booking ${booking.id} could not reach Stripe:`, err && err.message);
      return { ok: false, code: 502, reason: 'stripe_failed', paymentState: from,
        error: `Stripe could not be reached to hold the card: ${(err && err.message) || 'unknown error'}. `
          + 'Nothing was charged, and it will be tried again.' };
    }
    const failed = err.payment_intent || (err.raw && err.raw.payment_intent);
    if (failed && failed.id) await cancelQuietly(stripe, failed.id);
    return markHoldFailed({ booking, from, attempt, why: refusalText(err) });
  }

  if (!pi || pi.status !== 'requires_capture') {
    if (pi && pi.id) await cancelQuietly(stripe, pi.id);
    return markHoldFailed({ booking, from, attempt, why: `the bank left the payment at "${pi && pi.status}"` });
  }

  const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const authorised = Math.max(0, Number(pi.amount_capturable) || amount);
  const patch = {
    stripe_payment_intent: pi.id,
    authorized_cents: authorised,
    hold_expires_at: holdExpiryFrom(charge, new Date(now.getTime() + MIT_WINDOW_MS).toISOString()),
    hold_error: null,
  };
  const set = await setPaymentState({ bookingId: booking.id, state: 'held', expect: from, patch });
  if (set.error) {
    // The hold IS on the card. The webhook (deferredBookingId) will write it down; say so.
    return { ok: true, paymentState: 'held', paymentIntent: pi.id, authorizedCents: authorised,
      holdExpiresAt: patch.hold_expires_at, ledgerWarning: 'The card was held but the booking was not updated — the Stripe webhook will finish it.' };
  }
  if (!set.updated) {
    const latest = await bookingForHold(booking.id);
    if (latest && latest.payment_state === 'held' && latest.stripe_payment_intent === pi.id) {
      return { ok: true, paymentState: 'held', paymentIntent: pi.id, authorizedCents: authorised, holdExpiresAt: latest.hold_expires_at };
    }
    await cancelQuietly(stripe, pi.id);
    return { ok: false, code: 409, reason: 'changed', paymentState: latest && latest.payment_state,
      error: 'This booking changed while its card was being held (it was cancelled or released), so the new hold '
        + 'was let go at once. Nothing was charged.' };
  }
  console.log(`✅ Deferred hold placed — booking ${booking.id}, ${money(authorised)} on the saved card`);
  return { ok: true, paymentState: 'held', paymentIntent: pi.id, authorizedCents: authorised, holdExpiresAt: patch.hold_expires_at };
}

// Every saved card whose hold is due, one at a time. Single-flight inside a process so a slow run
// and the next tick cannot overlap; across processes the idempotency key above is what stops a
// booking being held twice.
let placing = false;
export async function placeDueHolds({ stripe, now = new Date(), limit = 50 } = {}) {
  if (placing) return { busy: true };
  placing = true;
  try {
    const due = await dueDeferredHolds({ nowISO: now.toISOString(), limit });
    if (due.unsupported) return { unsupported: true, due: 0 };
    if (due.error) return { error: due.error };
    const settings = due.rows.length ? normalizeSettings(await getSettings()) : null;
    const tally = { due: due.rows.length, held: 0, declined: 0, retry: 0, skipped: 0, results: [] };
    for (const b of due.rows) {
      const r = await placeDeferredHold({ stripe, booking: b, settings, now });
      if (r.ok) tally.held += 1;
      else if (r.reason === 'declined') tally.declined += 1;
      else if (r.reason === 'stripe_failed') tally.retry += 1;
      else tally.skipped += 1;
      tally.results.push({ bookingId: b.id, ok: !!r.ok, reason: r.reason || null });
    }
    return tally;
  } finally {
    placing = false;
  }
}

async function markHoldFailed({ booking, from, attempt, why }) {
  // attempt + 1 also moves the idempotency key on, so a later retry is a genuinely new request
  // rather than Stripe replaying this decline.
  await setPaymentState({ bookingId: booking.id, state: 'hold_failed', expect: from,
    patch: { hold_error: String(why).slice(0, 300), hold_attempts: attempt + 1 } });
  console.warn(`⚠ Deferred hold declined — booking ${booking.id}: ${why}`);
  return { ok: false, code: 402, reason: 'declined', paymentState: 'hold_failed',
    error: `The saved card could not be held — ${why}. Nothing was charged. Take payment at the counter.` };
}

// The bank (or Stripe, about this card) said no. Anything else — a timeout, an outage, a rate
// limit — is ours to retry, not the customer's card to blame.
function cardRefused(err) {
  if (!err) return false;
  return err.type === 'StripeCardError' || err.type === 'StripeInvalidRequestError'
    || err.code === 'authentication_required' || err.code === 'card_declined';
}
function refusalText(err) {
  if (err && err.code === 'authentication_required') return 'the bank wants the customer to confirm this payment themselves';
  const msg = (err && err.message) ? String(err.message).replace(/\.$/, '') : 'the card was declined';
  return msg.charAt(0).toLowerCase() + msg.slice(1);
}
async function cancelQuietly(stripe, piId) {
  try {
    await stripe.paymentIntents.cancel(piId, { cancellation_reason: 'abandoned' },
      { idempotencyKey: `invictus_release_deferred_${piId}` });
  } catch (err) {
    if (!unexpectedState(err)) console.error(`Could not let go of ${piId}:`, err && err.message);
  }
}

// The venue does not keep cards. Once a booking with a saved card is paid, released or cancelled,
// the card is detached from its Stripe Customer. Best-effort: a card already detached, or a Stripe
// hiccup, never fails the capture or the release that called this.
export async function forgetSavedCard(stripe, booking) {
  const pm = booking && booking.stripe_payment_method;
  if (!stripe || !pm) return;
  try { await stripe.paymentMethods.detach(pm); }
  catch (err) {
    if (!/not attached|No such PaymentMethod/i.test(String(err && err.message))) {
      console.error(`Could not remove the saved card ${pm} (booking ${booking.id}):`, err && err.message);
    }
  }
}
