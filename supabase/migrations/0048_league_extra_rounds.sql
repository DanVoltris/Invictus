-- 0048 — Staff may book a second round for a league week that already has one.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run. Needs 0042.
--
-- One live round per team per week (bookings_league_round_once, migration 0031) stays the rule for
-- every booking a customer makes. Staff can step outside it from the portal: a booking they put in
-- a week the team already has a round for is marked league_extra, and the index leaves it out.
-- Customers cannot write bookings directly (only the website and staff with booking.write can),
-- so only staff can set it.

alter table public.bookings add column if not exists league_extra boolean not null default false;
comment on column public.bookings.league_extra is 'A second league round staff booked for a week the team already has a round in (0048). Not held to one round per team per week.';

drop index if exists public.bookings_league_round_once;
create unique index bookings_league_round_once
  on public.bookings (league_team_id, league_week)
  where league_team_id is not null and status <> 'cancelled' and not league_extra;

do $$ begin
  raise notice '0048 applied: staff can book an extra league round for a week that already has one.';
end $$;
