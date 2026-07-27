-- Invictus Golf — per-booking note (shown on the reservation popup and the tee-sheet tile)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

alter table public.bookings add column if not exists note text;
