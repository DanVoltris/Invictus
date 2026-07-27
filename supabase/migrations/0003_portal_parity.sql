-- Invictus Golf — portal parity (payment settings + status type)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- Payment settings live in a jsonb column on the single settings row.
alter table public.settings         add column if not exists pay  jsonb not null default '{}'::jsonb;
-- Each booking status is either an "open" (bookable) or "closed" (block) tile, like GolfBooking.
alter table public.booking_statuses add column if not exists kind text  not null default 'open';

-- Seed sensible default payment settings (only if not set yet).
update public.settings set pay = jsonb_build_object(
  'taxPct', 12,
  'currency', 'CAD',
  'acceptPayments', true,
  'captureMethod', 'Credit Card Hold',
  'priorityCapture', 'No Payment',
  'processor', 'Stripe',
  'holdDisclaimer', 'Held funds will be released upon payment on-site or within 7 days, provided all terms are met.',
  'paymentDisclaimer', 'Funds will be charged to the provided credit card. Refunds will be issued if cancellation notice is provided at least 24 hours prior to the booking.'
) where id = 1 and (pay is null or pay = '{}'::jsonb);
