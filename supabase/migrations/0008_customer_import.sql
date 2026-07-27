-- Invictus Golf — GolfBooking customer import support
-- Adds membership expiry + review flag, waiver on file, and legacy booking counts,
-- and allows family members to share one email address.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- Family members may share an email (e.g. parent + kids) — email is no longer unique.
alter table public.customers drop constraint if exists customers_email_key;
create index if not exists customers_email on public.customers (email);

alter table public.customers add column if not exists membership_expires date;
alter table public.customers add column if not exists membership_flag    text;      -- review note shown as an amber badge
alter table public.customers add column if not exists waiver_code        text;
alter table public.customers add column if not exists waiver_signed_at   timestamptz;

-- Booking history carried over from the old GolfBooking system.
alter table public.customers add column if not exists legacy_bookings  smallint not null default 0;
alter table public.customers add column if not exists legacy_cancelled smallint not null default 0;
alter table public.customers add column if not exists legacy_no_show   smallint not null default 0;
alter table public.customers add column if not exists legacy_attendee  smallint not null default 0;
