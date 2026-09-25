// The ONE place this app moves money backwards.
//
// Before this file existed the system could not refund anybody. `public.refunds` and
// record_refund() (migration 0023) recorded an obligation and said so in their own comments —
// "It RECORDS an obligation. It does NOT move money." — while /manage promised customers "Free
// cancellation up to 24 hours before your tee time" and settings.pay.paymentDisclaimer promised
// "Refunds will be issued if cancellation notice is provided at least 24 hours prior". The venue
// was promising refunds it had no way to give. This closes that.
//
// THE ORDER IS THE WHOLE DESIGN — record, move, settle:
//
//   1. record_refund()  writes the row 'pending' and reserves the amount on bookings.refunded_cents.
//                       It refuses to reserve more than was charged, and is idempotent on
//                       (booking_id, ref), so the same request twice reserves once.
//   2. stripe.refunds.create(…, { idempotencyKey })  moves the money. The key is the refund row's
//                       own id, so even a retry that gets past step 1 cannot make Stripe pay twice.
//   3. settle_refund()  writes down what happened: 'succeeded' with the Stripe refund id, or
//                       'failed' — which HANDS THE RESERVATION BACK so a refund that never moved
//                       stops counting against what is still refundable (migration 0033).
//
// Which means: a row can exist without money having moved (an obligation somebody can see and
// chase), but money can never move without a row, and a Stripe failure never leaves a 'succeeded'
// record behind. If the process dies between 2 and 3 the row stays 'pending' with no Stripe id —
// understating what was paid, never overstating it — and the charge.refunded webhook finishes the
// job by attaching the id to that same row (see pendingRefundFor).
import {
  recordRefund, settleRefund, refundById, refundByStripeId, pendingRefundFor,
  bookingForRefund, bookingByPaymentIntent, setPaymentState,
} from './db.js';

const money = (cents) => `$${((Number(cents) || 0) / 100).toFixed(2)}`;

// ----- the restricted-key trap ---------------------------------------------------------------
//
// .env.example tells the operator to use a RESTRICTED key (rk_test_…) "with write access limited
// to: Checkout Sessions". Such a key answers POST /v1/refunds with HTTP 403 and a message about
// permissions — which reads exactly like a bug in this code, and has nothing to do with it. The
// two permissions a refund needs are `Refunds: write` (to create it) and `Charges: read` (Stripe
// resolves the PaymentIntent's charge to refund it). Name them, so the owner fixes it in one step.
export const REFUND_KEY_PERMISSIONS = 'Refunds: write, Charges: read';
export const REFUND_KEY_HELP =
  'Stripe refused this refund because the API key is not allowed to issue one. This is a key '
  + 'permission, not a fault in the booking. In the Stripe dashboard go to Developers → API keys, '
  + 'edit the restricted key this app uses (STRIPE_SECRET_KEY) and turn on both "Refunds: write" '
  + 'and "Charges: read", then try again. No money moved and nothing was recorded as refunded.';

export function isKeyPermissionError(err) {
  if (!err) return false;
  if (err.type === 'StripePermissionError' || err.statusCode === 403) return true;
  const msg = String(err.message || '');
  // Belt and braces: some Stripe responses arrive as invalid_request_error with the same meaning.
  return /permission|not (allowed|authorized|permitted)|restricted key/i.test(msg);
}

// Stripe's refund states, in this table's vocabulary. Note the spelling: Stripe says 'canceled',
// the refunds table's check constraint says 'cancelled'.
function settledStatus(stripeStatus) {
  if (stripeStatus === 'succeeded') return 'succeeded';
  if (stripeStatus === 'failed') return 'failed';
  if (stripeStatus === 'canceled' || stripeStatus === 'cancelled') return 'cancelled';
  return 'pending';                     // 'pending', 'requires_action', or anything new
}

// ----- issue a refund -------------------------------------------------------------------------
//
//   stripe       a client from stripeClient(process.env); null means "record only, move nothing"
//   bookingId    the booking to refund
//   amountCents  null / omitted = everything still refundable on it; a number = a partial refund
//   ref          the idempotency key. The SAME ref twice moves money once. Defaults to a key
//                derived from the booking and amount, so a caller that forgets is still safe.
//   allowManual  the booking was not paid by card (no PaymentIntent): record the obligation as
//                'manual' rather than refusing. Used by customer self-cancellation, which must
//                never leave a promised refund unwritten just because it cannot be automated.
//
// Returns { ok, refundId, amountCents, moneyMoved, status, stripeRefundId, already?, method }
// or { code, error, … } — `code` is the HTTP status the caller should answer with.
export async function issueRefund({
  stripe = null, bookingId, amountCents = null, reason = null, ref = null,
  by = null, note = null, allowManual = false,
} = {}) {
  const booking = await bookingForRefund(bookingId);
  if (!booking) return { code: 404, error: 'That booking no longer exists.' };

  const paid = Math.max(0, Number(booking.amount_cents) || 0);
  const done = Math.max(0, Number(booking.refunded_cents) || 0);
  const refundable = Math.max(0, paid - done);

  if (paid <= 0) {
    return { code: 400, reason: 'nothing_paid', nothingToRefund: true,
      error: 'Nothing was charged for this booking, so there is nothing to refund.' };
  }
  const amount = amountCents == null ? refundable : Math.round(Number(amountCents));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { code: 400, reason: 'bad_amount', error: 'Enter a refund amount greater than zero.' };
  }
  // The fast, friendly version of the guard. record_refund() enforces it again in the database,
  // inside the row lock, and that is the one that actually counts — this only exists so the
  // common mistake gets a sentence instead of an error code.
  if (amount > refundable) {
    return { code: 409, reason: 'over_refund', paidCents: paid, refundedCents: done, refundableCents: refundable,
      error: refundable === 0
        ? `This booking has already been refunded in full (${money(paid)}). There is nothing left to refund.`
        : `That is more than is left to refund. ${money(paid)} was charged, ${money(done)} has already gone back, so ${money(refundable)} is refundable.` };
  }

  const pi = booking.stripe_payment_intent || null;
  if (!pi && !allowManual) {
    return { code: 409, reason: 'no_payment_intent',
      error: 'This booking has no card payment on file, so it cannot be refunded through Stripe. '
        + 'Refund it the way it was paid and record it from the booking’s cancel screen.' };
  }
  const method = pi && stripe ? 'stripe' : 'manual';
  const key = ref || `refund:${booking.id}:${amount}`;

  // ---- 1. RECORD FIRST. Nothing below this line can move money that is not written down. ----
  const rec = await recordRefund({
    bookingId: booking.id, groupId: booking.group_id || null, amountCents: amount,
    reason: reason ? String(reason).slice(0, 120) : null, method, ref: key,
    note: note ? String(note).slice(0, 500) : null, by,
  });
  if (rec.unsupported) {
    return { code: 503, reason: 'schema',
      error: 'Refunds aren’t switched on in this database yet — apply migrations 0023 and 0033.' };
  }
  if (rec.error === 'over_refund') {
    return { code: 409, reason: 'over_refund', paidCents: rec.paidCents, refundedCents: rec.refundedCents,
      error: `That is more than is left to refund. ${money(rec.paidCents)} was charged and ${money(rec.refundedCents)} has already gone back.` };
  }
  if (rec.error === 'booking_not_found') return { code: 404, error: 'That booking no longer exists.' };
  if (rec.error === 'bad_amount') return { code: 400, reason: 'bad_amount', error: 'Enter a refund amount greater than zero.' };
  if (rec.error) return { code: 500, error: `The refund could not be recorded, so nothing was refunded: ${rec.error}` };

  const refundId = rec.refundId;
  // From here on the LEDGER's amount is the authority, not the request's. They are the same on a
  // first call; on a resumed one (same ref, different amount in the body) the row is what was
  // reserved against the booking, and sending anything else would move money the ledger never
  // accounted for.
  let sending = amount;

  // ---- This exact refund has been asked for before. Decide without touching Stripe. ----
  if (rec.already) {
    const row = await refundById(refundId);
    const st = (row && row.status) || 'pending';
    if (st === 'succeeded') {
      return { ok: true, already: true, moneyMoved: true, status: 'succeeded', refundId,
        amountCents: (row && row.amount_cents) || amount, stripeRefundId: (row && row.stripe_refund_id) || null,
        message: `Already refunded — ${money((row && row.amount_cents) || amount)} went back on ${(row && row.settled_at) || 'an earlier attempt'}.` };
    }
    if (st === 'failed' || st === 'cancelled') {
      return { code: 409, reason: 'already_failed', refundId,
        error: `A refund with this reference was already attempted and ${st === 'failed' ? 'failed' : 'cancelled'}. `
          + 'Send a new `ref` to try again — reusing this one would be treated as the same request.' };
    }
    if (row && row.stripe_refund_id) {
      return { ok: true, already: true, moneyMoved: true, status: 'pending', refundId,
        amountCents: row.amount_cents, stripeRefundId: row.stripe_refund_id,
        message: `Already sent to Stripe — ${money(row.amount_cents)} is on its way back.` };
    }
    // 'pending' with no Stripe id: a previous attempt recorded the row and then died. Fall through
    // and send it, with the idempotency key below making sure Stripe only ever pays it once.
    if (row && row.amount_cents) sending = row.amount_cents;
  }

  // ---- No card to refund to. The obligation is recorded; a human will settle it. ----
  if (method === 'manual') {
    return { ok: true, refundId, amountCents: amount, moneyMoved: false, status: 'pending', method: 'manual',
      message: `${money(amount)} is recorded as owed. It has not been sent yet — the shop issues this one by hand.` };
  }

  // ---- 2. MOVE THE MONEY. ----
  let refund;
  try {
    refund = await stripe.refunds.create({
      payment_intent: pi,
      amount: sending,
      // Stripe only accepts three values here and none of them is free text; ours goes in metadata.
      reason: 'requested_by_customer',
      metadata: {
        invictus_refund_id: String(refundId),
        invictus_booking_id: String(booking.id),
        invictus_reason: reason ? String(reason).slice(0, 200) : '',
        invictus_by: by ? String(by).slice(0, 60) : '',
      },
    }, { idempotencyKey: `invictus_refund_${refundId}` });
  } catch (err) {
    // ---- 3a. SETTLE AS FAILED. This is what stops a Stripe failure leaving a 'succeeded'
    // record behind, and hands the reserved amount back so the refund can be tried again. ----
    const settled = await settleRefund({ refundId, status: 'failed', note: String(err && err.message || 'Stripe error').slice(0, 500) });
    const permission = isKeyPermissionError(err);
    if (permission) console.error('Refund refused by Stripe — key permissions:', err && err.message);
    else console.error('Refund failed at Stripe:', err && err.message);
    return {
      code: permission ? 503 : 502,
      reason: permission ? 'stripe_key_permission' : 'stripe_failed',
      refundId, amountCents: sending, moneyMoved: false, status: 'failed',
      missingPermissions: permission ? REFUND_KEY_PERMISSIONS : undefined,
      released: !settled.error,
      error: permission ? REFUND_KEY_HELP
        : `Stripe could not issue this refund: ${err && err.message ? err.message : 'unknown error'}. `
          + 'Nothing moved and nothing is recorded as refunded — you can try again.',
    };
  }

  // ---- 3b. SETTLE. ----
  const status = settledStatus(refund && refund.status);
  const settled = await settleRefund({ refundId, status, stripeRefundId: refund && refund.id });
  if (status === 'failed') {
    return { code: 502, reason: 'stripe_failed', refundId, amountCents: sending, moneyMoved: false,
      status: 'failed', stripeRefundId: refund.id,
      error: 'Stripe accepted the refund and then failed it. Nothing was refunded — check the payment in Stripe.' };
  }
  if (settled.error) {
    // The money HAS moved. Say so, and leave the row 'pending' rather than claiming success it
    // could not write down — the charge.refunded webhook attaches the id to this same row.
    console.error(`Refund ${refund.id} succeeded at Stripe but was not settled in the ledger: ${settled.error}`);
  }

  // Nothing left on the booking → payment_state 'refunded' (migration 0034), so the portal can tell
  // "charged and given back" from "charged" without re-deriving it from two counters. Best-effort
  // and last: refunded_cents is still the authority, and a refund is never failed over a label.
  if (status === 'succeeded' && done + sending >= paid) {
    await setPaymentState({ bookingId: booking.id, state: 'refunded', expect: 'paid' });
  }

  return {
    ok: true, refundId, amountCents: sending, stripeRefundId: refund.id,
    status, moneyMoved: status === 'succeeded', method: 'stripe',
    ledgerWarning: settled.error ? 'The refund was issued but the record was not updated — it will settle from the Stripe webhook.' : undefined,
    message: status === 'succeeded'
      ? `${money(sending)} is on its way back to the card it was paid with. Card refunds usually appear within 5–10 business days.`
      : `${money(sending)} has been sent to Stripe and is still processing. It will show as refunded once Stripe settles it.`,
  };
}

// ----- the other direction: a refund that happened in Stripe, not here -------------------------
//
// Somebody refunds a booking from the Stripe dashboard. Without this the money leaves the account
// and this database never hears about it — refunded_cents stays at zero and the same booking can
// be refunded a second time from the portal. charge.refunded is also how OUR refunds reach
// 'succeeded' when the payment method settles later than the API call.
export async function applyChargeRefunded({ stripe, charge } = {}) {
  if (!charge) return { results: [] };
  const pi = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : (charge.payment_intent && charge.payment_intent.id) || null;

  // The event's own charge carries its refunds, but the list is paginated and an old charge with
  // many refunds can arrive truncated — ask Stripe when it looks incomplete.
  let list = (charge.refunds && Array.isArray(charge.refunds.data)) ? charge.refunds.data : [];
  if ((!list.length || (charge.refunds && charge.refunds.has_more)) && stripe && stripe.refunds && stripe.refunds.list) {
    try {
      const page = await stripe.refunds.list({ charge: charge.id, limit: 100 });
      if (page && Array.isArray(page.data) && page.data.length) list = page.data;
    } catch (err) {
      console.error('charge.refunded: could not list refunds —', err && err.message);
    }
  }

  const results = [];
  for (const r of list) results.push(await applyStripeRefund({ refund: r, paymentIntent: pi }));
  return { results };
}

async function applyStripeRefund({ refund, paymentIntent }) {
  if (!refund || !refund.id) return { skipped: 'no_refund' };
  const status = settledStatus(refund.status);

  // 1. One of ours, already filed. Just move it to where Stripe says it is.
  const mine = await refundByStripeId(refund.id);
  if (mine) {
    const s = await settleRefund({ refundId: mine.id, status, stripeRefundId: refund.id });
    return { refundId: mine.id, status, already: !!s.already, ours: true };
  }

  const booking = await bookingByPaymentIntent(paymentIntent);
  if (!booking) {
    // A gift-card purchase or a league sign-up refunded in the dashboard — there is no booking to
    // put it against. Not an error; there is simply nothing in this ledger for it.
    console.log(`↩︎ Stripe refund ${refund.id} has no booking here (payment intent ${paymentIntent || '—'}) — nothing recorded.`);
    return { skipped: 'no_booking', stripeRefundId: refund.id };
  }

  // 2. One of ours whose id we never managed to write down (issueRefund died between the Stripe
  // call and the settle). Attach it to THAT row — writing a new one would count it twice.
  const orphan = await pendingRefundFor({ bookingId: booking.id, amountCents: refund.amount });
  if (orphan) {
    const s = await settleRefund({ refundId: orphan.id, status, stripeRefundId: refund.id });
    return { refundId: orphan.id, status, ours: true, attached: true, already: !!s.already, error: s.error };
  }

  // 3. Genuinely issued elsewhere. Record it, then settle it — same two steps, same order.
  const rec = await recordRefund({
    bookingId: booking.id, groupId: booking.group_id || null, amountCents: refund.amount,
    reason: 'refunded in Stripe', method: 'stripe', ref: `stripe:${refund.id}`,
    note: 'Issued outside this app (Stripe dashboard or API).', by: 'stripe-webhook',
  });
  if (rec.unsupported) return { skipped: 'schema', stripeRefundId: refund.id };
  if (rec.error === 'over_refund') {
    // Stripe and this ledger disagree about what has gone back. Never paper over it by writing a
    // row the booking cannot support — say it loudly enough to be found in the log.
    console.error(`⚠ Stripe refund ${refund.id} (${money(refund.amount)}) exceeds what booking ${booking.id} `
      + `has left to refund (charged ${money(rec.paidCents)}, already refunded ${money(rec.refundedCents)}). Not recorded — reconcile by hand.`);
    return { skipped: 'over_refund', stripeRefundId: refund.id, bookingId: booking.id };
  }
  if (rec.error) {
    console.error(`⚠ Stripe refund ${refund.id} not recorded: ${rec.error}`);
    return { error: rec.error, stripeRefundId: refund.id };
  }
  const s = await settleRefund({ refundId: rec.refundId, status, stripeRefundId: refund.id });
  return { refundId: rec.refundId, stripeRefundId: refund.id, status, recorded: true, bookingId: booking.id, error: s.error };
}
