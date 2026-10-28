-- 0050 — Undo 0048: a team never plays the same league week twice, not even when staff book it.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- 0048 let staff book a second round for a week that already had one (bookings.league_extra). That
-- was a misunderstanding: a team may play two DIFFERENT weeks' rounds in one calendar week (week 4
-- and week 5, say) — which the index already allows, because it is built on the week each round
-- counts for — but never week 4 and then week 4 again. This puts the one-round-per-team-per-week
-- index back exactly as 0031 made it and removes the column. It stops if any booking was marked as
-- a second round, so nothing is lost without someone looking at it first.

do $$ begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'bookings' and column_name = 'league_extra') then
    if exists (select 1 from public.bookings where league_extra and status <> 'cancelled') then
      raise exception '0050: some bookings are marked as a second round for a week. Cancel or move them first, then run this again.';
    end if;
  end if;
end $$;

drop index if exists public.bookings_league_round_once;
create unique index bookings_league_round_once
  on public.bookings (league_team_id, league_week)
  where league_team_id is not null and status <> 'cancelled';

alter table public.bookings drop column if exists league_extra;

do $$ begin
  raise notice '0050 applied: one round per team per week again, for staff bookings too.';
end $$;
