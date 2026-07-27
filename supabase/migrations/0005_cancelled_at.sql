-- Invictus Golf — record when a booking was cancelled (for the customer audit trail)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

alter table public.bookings add column if not exists cancelled_at timestamptz;
