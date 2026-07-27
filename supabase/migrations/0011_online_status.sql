-- Invictus Golf — default status for self-serve online bookings
-- When a customer completes a booking on the public site, the payment webhook stamps this
-- workflow status on the reservation (defaults to "Booked"). Managers pick it in the Statuses tab.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

alter table public.settings add column if not exists online_status_label text not null default 'Booked';
