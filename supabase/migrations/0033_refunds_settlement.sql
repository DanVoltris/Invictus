-- Invictus Golf — refunds that actually move money (migration 0033)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHAT WAS WRONG
-- Migration 0023 section 5 said it out loud: `public.refunds` RECORDS an obligation, it does NOT
-- move money. Nothing in this repo called Stripe's refund API. Meanwhile /manage told customers
-- "Free cancellation up to 24 hours before your tee time", settings.pay.paymentDisclaimer promised
-- "Refunds will be issued if cancellation notice is provided at least 24 hours prior", and
-- api/booking.js cancelled the booking and kept the money. The venue was promising refunds it had
-- no way to give.
--
-- WHAT THIS ADDS
-- The missing HALF of the ledger. record_refund() writes the row 'pending' and reserves the amount
-- against bookings.refunded_cents. settle_refund() below is what happens next: it attaches the
-- Stripe refund id and marks the row 'succeeded', or — when Stripe refused — marks it 'failed' and
-- GIVES THE RESERVATION BACK, so money that never moved stops counting against what is still
-- refundable. Without that second half, one failed Stripe call would permanently shrink a booking's
-- refundable balance and the customer could never be made whole.
--
-- The pair is what makes "no way to move money without recording it" true: the API records first,
-- calls Stripe second, and settles third. A crash anywhere leaves a 'pending' row — an obligation
-- somebody can see and chase — never a silent transfer and never a false 'succeeded'.
--
-- ⚠ BEFORE THIS WORKS AT ALL: the Stripe key needs `Refunds: write` and `Charges: read`.
-- .env.example steers the operator toward a RESTRICTED key scoped to Checkout Sessions, and such a
-- key answers POST /v1/refunds with a 403 permissions error that reads exactly like a code bug.
-- The API detects that one failure and names the two permissions in its error message.

-- 1) One Stripe refund, one row. ------------------------------------------------------------
--
-- (booking_id, ref) already stops the same REQUEST being recorded twice. This stops the same
-- STRIPE REFUND being recorded twice under two different refs — which is exactly what happens when
-- a refund we issued also arrives back through the charge.refunded webhook, or when a manager
-- refunds in the dashboard while the portal button is mid-flight.
create unique index if not exists refunds_stripe_refund_id
  on public.refunds (stripe_refund_id) where stripe_refund_id is not null;

-- 2) settle_refund — what became of the money. ----------------------------------------------
--
-- p_status is where the refund ended up: 'succeeded' (Stripe moved it), 'failed' (Stripe refused),
-- 'cancelled' (nobody is going to issue it), or 'pending' (accepted by Stripe, not settled yet —
-- some payment methods take days, and charge.refunded finishes the job later).
--
-- Idempotent: settling a row to the status it already has touches nothing and reports 'already',
-- so a replayed webhook and a retried API call are both harmless.
create or replace function public.settle_refund(
  p_refund uuid, p_status text, p_stripe_refund_id text default null, p_note text default null)
returns jsonb language plpgsql as $$
declare
  r      public.refunds%rowtype;
  paid   integer;
  done   integer;
  freed  boolean := false;
  took   boolean := false;
begin
  if p_status is null or p_status not in ('pending', 'succeeded', 'failed', 'cancelled') then
    return jsonb_build_object('error', 'bad_status', 'status', p_status);
  end if;

  select * into r from public.refunds where id = p_refund for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;

  -- Already there. Still let a Stripe refund id be attached to a row that has none — that is the
  -- webhook filling in an id for a refund our own call recorded but never got an answer for.
  if r.status = p_status then
    if p_stripe_refund_id is not null and r.stripe_refund_id is null then
      update public.refunds set stripe_refund_id = p_stripe_refund_id where id = r.id;
    end if;
    return jsonb_build_object('already', true, 'refundId', r.id, 'status', r.status,
      'amountCents', r.amount_cents, 'moneyMoved', r.status = 'succeeded');
  end if;

  -- MONEY THAT NEVER MOVED MUST NOT KEEP COUNTING. record_refund() reserved this amount against
  -- the booking the moment the row was written; a refund that fails or is abandoned hands that
  -- reservation back, so the next attempt has room for it.
  if p_status in ('failed', 'cancelled') and r.status not in ('failed', 'cancelled') then
    freed := true;
  end if;
  -- ...and the reverse. A row that was given back and is now succeeding takes the reservation
  -- again, and must pass the same over-refund test record_refund() applies.
  if p_status in ('pending', 'succeeded') and r.status in ('failed', 'cancelled') then
    took := true;
    if r.booking_id is not null then
      select coalesce(b.amount_cents, 0), coalesce(b.refunded_cents, 0) into paid, done
        from public.bookings b where b.id = r.booking_id for update;
      if found and done + r.amount_cents > paid then
        return jsonb_build_object('error', 'over_refund',
          'paidCents', paid, 'refundedCents', done, 'requested', r.amount_cents);
      end if;
    end if;
  end if;

  if freed or took then
    if r.booking_id is not null then
      update public.bookings
         set refunded_cents = greatest(0, coalesce(refunded_cents, 0) + case when took then r.amount_cents else -r.amount_cents end)
       where id = r.booking_id;
    end if;
    if r.group_id is not null then
      update public.booking_groups
         set refunded_cents = greatest(0, coalesce(refunded_cents, 0) + case when took then r.amount_cents else -r.amount_cents end)
       where id = r.group_id;
    end if;
  end if;

  update public.refunds
     set status           = p_status,
         stripe_refund_id = coalesce(p_stripe_refund_id, stripe_refund_id),
         note             = coalesce(p_note, note),
         settled_at       = case when p_status = 'succeeded' then now() else settled_at end
   where id = r.id;

  return jsonb_build_object('ok', true, 'refundId', r.id, 'status', p_status,
    'amountCents', r.amount_cents, 'moneyMoved', p_status = 'succeeded');
exception
  -- Another row already carries this Stripe refund id (the index in section 1). The refund is
  -- recorded — just not on this row. Say so rather than failing the caller.
  when unique_violation then
    return jsonb_build_object('already', true, 'refundId', r.id, 'conflict', 'stripe_refund_id',
      'status', r.status, 'amountCents', r.amount_cents);
end $$;

comment on function public.settle_refund(uuid, text, text, text) is
  'Second half of record_refund(): attach the Stripe refund id and mark the row succeeded/failed/cancelled, releasing or retaking the amount reserved on bookings.refunded_cents. Idempotent on (refund, status).';

-- 3) The warning on public.refunds is now out of date. ---------------------------------------
comment on table public.refunds is
  'Every refund, recorded BEFORE it is attempted. lib/refunds.js records the row (record_refund), calls Stripe, then settles it (settle_refund) — so a row can exist without money having moved, but money can never move without a row. status: pending = accepted or in flight, succeeded = Stripe moved it, failed = Stripe refused and the amount was given back to the booking.';
