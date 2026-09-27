-- Invictus Golf — deferred card holds: save the card now, hold it later (migration 0035)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHAT WAS WRONG
-- Migration 0034 holds a near booking's card at checkout, but a card authorisation only lasts about
-- seven days. So a session further ahead than settings.pay.hold.cutoffDays (5) was CHARGED IN FULL
-- at booking — up to 10 days early for everyone, and up to 60 for league players.
--
-- WHAT THIS ADDS
-- A far-ahead booking now charges nothing at checkout. Stripe saves the card (a SetupIntent), and
-- settings.pay.hold.leadDays (default 2) before the session the server places the hold on it by
-- itself — lib/holds.js placeDueHolds(), run by the daily Vercel cron in vercel.json. From then on
-- it is an ordinary 0034 hold, captured at check-in.
--
-- Why 2 days and not 5: a hold the server places with nobody at the keyboard is MERCHANT-initiated,
-- and Visa only honours those for 4 days 18 hours (docs.stripe.com/payments/place-a-hold-on-a-payment-method).
-- Placed 2 days out, a Visa hold still has ~2¾ days left after the session for staff to capture.
--
-- THE CARD IS NOT KEPT. The owner decided against remembering cards (commit 91cc8bc). The card is
-- saved for THIS booking only, never offered back at checkout, and detached from Stripe the moment
-- the booking is paid, released or cancelled.
--
-- Columns and states only — nothing is dropped and no existing booking changes meaning.

-- 1) Two new payment states. ----------------------------------------------------------------
--
--   card_saved   booked, nothing charged, no hold yet. The card is saved at Stripe and the hold is
--                due at hold_due_at.
--   hold_failed  the server tried to place the hold and the card was declined. The booking STANDS
--                (the owner's rule: keep it and take payment at the counter) and the customer is
--                NOT told — the flag is for staff only, on the Holds to Charge screen.
alter table public.bookings drop constraint if exists bookings_payment_state_check;
alter table public.bookings add constraint bookings_payment_state_check
  check (payment_state is null
         or payment_state in ('held', 'paid', 'released', 'refunded', 'card_saved', 'hold_failed'));

-- 2) What a booking has to remember until its hold is placed. -------------------------------
alter table public.bookings add column if not exists stripe_setup_intent   text;
alter table public.bookings add column if not exists stripe_payment_method text;
alter table public.bookings add column if not exists stripe_customer       text;
alter table public.bookings add column if not exists deferred_cents        integer;
alter table public.bookings add column if not exists hold_due_at           timestamptz;
alter table public.bookings add column if not exists hold_error            text;
alter table public.bookings add column if not exists hold_attempts         integer not null default 0;

comment on column public.bookings.deferred_cents is
  'What will be held on the saved card at hold_due_at (the checkout total, tax included). NOT money received — amount_cents stays 0 until capture.';
comment on column public.bookings.hold_due_at is
  'When the server places the hold on a card_saved booking: the session start minus settings.pay.hold.leadDays.';
comment on column public.bookings.hold_error is
  'Why the card was declined when the hold was placed (payment_state = hold_failed). For staff only.';

-- 3) The two lists the server and the portal read. ------------------------------------------
--
-- "Which saved cards are due to be held?" — the cron's query.
create index if not exists bookings_hold_due
  on public.bookings (hold_due_at)
  where payment_state = 'card_saved';

-- One booking per SetupIntent is how the client-side confirm and the webhook avoid writing the same
-- booking twice (the SetupIntent twin of bookings_by_payment_intent in 0034).
create index if not exists bookings_by_setup_intent
  on public.bookings (stripe_setup_intent)
  where stripe_setup_intent is not null;
