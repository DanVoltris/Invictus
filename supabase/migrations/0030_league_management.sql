-- Invictus Golf — league management: payments per player and cancelled nights (migration 0030)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- ============================================================================
-- 1) Who has paid their league fee.
-- ============================================================================
-- league_members.paid_cents (0028) is how much; paid_at is when, and null means not paid yet. An
-- online sign-up is paid the moment Stripe says so; staff mark counter and e-transfer payments.
alter table public.league_members add column if not exists paid_at timestamptz;
update public.league_members set paid_at = joined_at where paid_at is null and paid_cents > 0;

-- ============================================================================
-- 2) League nights that are not happening.
-- ============================================================================
-- A holiday, a tournament, the shop closed. A cancelled night drops out of the players' schedule
-- and the results sheet; results already entered for it are kept, not deleted.
create table if not exists public.league_cancelled_nights (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references public.leagues(id) on delete cascade,
  night      date not null,
  reason     text,
  created_at timestamptz not null default now()
);
create unique index if not exists league_cancelled_nights_once on public.league_cancelled_nights (league_id, night);

-- Same rule as the other league tables (0028): staff read with any role, write with booking.write.
alter table public.league_cancelled_nights enable row level security;
drop policy if exists league_cancelled_nights_read on public.league_cancelled_nights;
drop policy if exists league_cancelled_nights_write on public.league_cancelled_nights;
create policy league_cancelled_nights_read on public.league_cancelled_nights
  for select to authenticated using ((select public.staff_role()) is not null);
create policy league_cancelled_nights_write on public.league_cancelled_nights
  for all to authenticated using ((select public.staff_can('booking.write'))) with check ((select public.staff_can('booking.write')));
