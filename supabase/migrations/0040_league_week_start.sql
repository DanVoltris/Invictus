-- Invictus Golf — a league chooses the day its week starts (migration 0040)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- A team plays one round a week, and "a week" has always meant Monday to Sunday here. A league's
-- printed schedule may not agree: the 2026-27 Winter League runs Sunday to Saturday (Nov 1–7,
-- Nov 8–14 …). With Monday weeks a team that played on Tuesday was refused the following Sunday —
-- a new week on the brochure, the same week in the database.
--
-- So the league says which day its week starts (leagues.week_start, 0 = Sunday … 6 = Saturday,
-- default 1 = Monday, which is exactly the old behaviour). Until a league is changed, nothing moves.
--
-- bookings.league_week was a GENERATED column — always the Monday. A generated column cannot look
-- at the league, so it becomes an ordinary column kept by a trigger that does. It is still never
-- supplied by anyone: the trigger overwrites it on every insert and update, so the
-- one-round-per-team-per-week index (bookings_league_round_once, migration 0031) keeps its meaning.
--
-- league_results.week is left as it is: nothing reads it — results are grouped by the same week
-- maths in demo/assets/leagues.js, which now takes the league's start day.

alter table public.leagues add column if not exists week_start smallint not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leagues_week_start_valid') then
    alter table public.leagues add constraint leagues_week_start_valid check (week_start between 0 and 6);
  end if;
end $$;

comment on column public.leagues.week_start is 'Day the league week starts: 0 = Sunday … 6 = Saturday. Default 1 (Monday). One round per team per week counts from this day.';

-- The first day of the week p_date falls in, for a week starting on p_week_start.
-- demo/assets/leagues.js weekOf() is the same sum; the two must always agree.
create or replace function public.league_week_of(p_date date, p_week_start smallint default 1)
returns date
language sql
immutable
as $$
  select p_date - ((extract(dow from p_date)::int - coalesce(p_week_start, 1)::int + 7) % 7)
$$;

-- Generated → ordinary. DROP EXPRESSION keeps every value already stored (all Mondays, which is
-- still right: every league starts on Monday until somebody changes one) and keeps the index.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'bookings'
                and column_name = 'league_week' and is_generated = 'ALWAYS') then
    alter table public.bookings alter column league_week drop expression;
  end if;
end $$;

comment on column public.bookings.league_week is 'First day of the league week booking_date falls in (the league''s week_start; Monday when the booking is not a league round). Set by trigger bookings_league_week — never supplied.';

-- Every insert and every update: whatever the caller sent for league_week is replaced.
create or replace function public.bookings_league_week()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start smallint;
begin
  if new.league_team_id is not null then
    select l.week_start into v_start
      from public.league_teams t
      join public.leagues l on l.id = t.league_id
     where t.id = new.league_team_id;
  end if;
  new.league_week := public.league_week_of(new.booking_date, coalesce(v_start, 1::smallint));
  return new;
end $$;

drop trigger if exists bookings_league_week on public.bookings;
create trigger bookings_league_week
  before insert or update on public.bookings
  for each row execute function public.bookings_league_week();

-- Changing a league's start day re-files the rounds it already has. If that would put two of one
-- team's rounds in the same week, the change is refused with a sentence instead of a constraint name.
create or replace function public.leagues_restamp_weeks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.week_start is distinct from old.week_start then
    begin
      update public.bookings b
         set league_week = public.league_week_of(b.booking_date, new.week_start)
        from public.league_teams t
       where t.id = b.league_team_id and t.league_id = new.id;
    exception when unique_violation then
      raise exception 'A team in this league already has two rounds that would fall in the same week with that start day. Move or cancel one of them first.'
        using errcode = '23505';
    end;
  end if;
  return new;
end $$;

drop trigger if exists leagues_restamp_weeks on public.leagues;
create trigger leagues_restamp_weeks
  after update of week_start on public.leagues
  for each row execute function public.leagues_restamp_weeks();
