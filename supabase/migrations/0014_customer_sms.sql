-- Invictus Golf — SMS-notification preference on customers
-- The booking site's "Text me updates about this booking" toggle is saved here, alongside the
-- customer's contact info (which is now upserted into this table on every online booking).
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

alter table public.customers add column if not exists sms_opt_in boolean not null default true;
