-- Invictus Golf — card holds: authorise at booking, capture at check-in (migration 0034)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHAT WAS WRONG
-- The portal's Payment Settings screen has always offered "Capture method: Credit Card Hold" and
-- nothing anywhere read it. api/checkout.js created every PaymentIntent without a capture_method,
-- and Stripe's default is `automatic`, so every booking was CHARGED IN FULL the moment the customer
-- pressed pay. The screen described a policy the software did not have.
--
-- WHAT THIS ADDS
-- Somewhere to write down that a booking is HELD rather than PAID, and when that hold dies.
-- Columns only — nothing is dropped, nothing is rewritten, and every existing booking keeps the
-- meaning it already had (see the backfill in section 2).
--
-- ⚠ THE SEVEN-DAY CLIFF, because every column below exists because of it.
-- A card authorisation is not permanent. Stripe documents the windows at
-- docs.stripe.com/payments/place-a-hold-on-a-payment-method: for an online (card-not-present)
-- customer-initiated payment, Visa 7 days (4d18h when the network reads it as merchant-initiated),
-- Mastercard 7, American Express 7, Discover 7. When the window passes, "the funds are released and
-- the payment status changes to `canceled`" — the money was never taken and the card is gone.
-- The booking window here is 10 days for everyone and 60 for league players, so a large minority of
-- bookings CANNOT be held and are charged in full at booking instead. Which is which is decided by
-- settings.pay.hold.cutoffDays (default 5 days — two days of margin under the 7), read by
-- holdPlan() in lib/booking.js. Nothing in this file hard-codes it.
--
-- ⚠ AND THE REASON hold_expires_at IS INDEXED. Capture is MANUAL: staff press a button. A hold
-- nobody presses simply evaporates, and that is real money the venue never sees. Section 3 is the
-- index the portal's warning list sorts on.

-- 1) The four things a booking has to remember about a hold. -------------------------------
--
-- payment_state is the whole state machine, and it is deliberately NOT the booking's `status`:
-- a held booking is a perfectly ordinary CONFIRMED booking that occupies its slot. What differs is
-- only where the money is.
--
--   held      authorised, not captured. The customer has not been charged a cent.
--   paid      captured (or charged in full at booking — the far-ahead path).
--   released  the authorisation was cancelled. The customer is never charged.
--   refunded  it was captured and then fully refunded through lib/refunds.js.
--   NULL      a booking with no card payment at all: staff-entered, gift card, prepaid hours,
--             league round, or anything written before this migration ran.
alter table public.bookings add column if not exists payment_state     text;
alter table public.bookings add column if not exists authorized_cents  integer;
alter table public.bookings add column if not exists hold_expires_at   timestamptz;
alter table public.bookings add column if not exists captured_at       timestamptz;
alter table public.bookings add column if not exists released_at       timestamptz;

comment on column public.bookings.payment_state is
  'held | paid | released | refunded, or NULL for a booking with no card payment. A HELD booking is confirmed and occupies its slot — nothing has been charged. amount_cents stays 0 until capture; authorized_cents is what is on hold.';
comment on column public.bookings.authorized_cents is
  'What the card is authorised for while payment_state = held. NOT money received: amount_cents is, and it stays 0 until capture, so nothing can be refunded out of a hold.';
comment on column public.bookings.hold_expires_at is
  'When the card authorisation expires and the money is gone for good (Stripe: the charge''s payment_method_details.card.capture_before). Capture is manual, so this is the deadline staff chase — the portal''s warning list sorts on it.';

-- The check constraint, added the re-runnable way: a plain `add constraint` fails on the second run.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_payment_state_check') then
    alter table public.bookings add constraint bookings_payment_state_check
      check (payment_state is null or payment_state in ('held', 'paid', 'released', 'refunded'));
  end if;
end $$;

-- 2) Backfill: say what is already true, and nothing more. ----------------------------------
--
-- Every booking written before today was captured at the moment it was paid — that is exactly the
-- behaviour this migration replaces. So a booking with money on it is 'paid', and one without is
-- left NULL (no card was involved). Nothing here invents a hold that never existed.
update public.bookings
   set payment_state = 'paid'
 where payment_state is null
   and coalesce(amount_cents, 0) > 0
   and stripe_payment_intent is not null;

-- 3) The warning list's index. --------------------------------------------------------------
--
-- "Which holds are about to expire?" is the one query that has to stay fast and the one nobody can
-- afford to have go stale. Partial, because only held rows are ever asked about.
create index if not exists bookings_held_expiring
  on public.bookings (hold_expires_at)
  where payment_state = 'held';

-- Looking a booking up by its PaymentIntent is now on the hot path twice over — a held booking gets
-- payment_intent.amount_capturable_updated at authorisation and payment_intent.succeeded at
-- capture, and bookingExistsForPI() runs on both. NOT unique: a slot can legitimately be sold again
-- after a cancellation, and an index that refuses that would turn a rebooking into a 500.
create index if not exists bookings_by_payment_intent
  on public.bookings (stripe_payment_intent)
  where stripe_payment_intent is not null;
