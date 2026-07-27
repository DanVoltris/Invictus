-- Invictus Golf — cart holds (Ticketmaster-style temporary reservations)
-- When a customer opens checkout, the slot is locked with a short-lived `held` booking row that
-- expires after ~5 min. Others see it as unavailable ("Held") until it's paid (→ confirmed) or
-- it expires (→ released). The existing bookings_no_overlap exclusion constraint makes the hold
-- atomic — two people can never hold the same slot.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- Allow the new 'held' status alongside the existing ones.
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('confirmed','blocked','cancelled','held'));

-- When a hold lapses (cart abandoned). Null for real bookings/blocks.
alter table public.bookings add column if not exists expires_at timestamptz;

-- Sweep stale holds quickly.
create index if not exists bookings_held_expiry on public.bookings (expires_at) where status = 'held';
