-- 0042 — League: make-up rounds and scorecard photos (the 2026-27 Winter League rules).
--
-- 1) MAKE-UP ROUNDS. Rule 1: a team that could not play in its scheduled week may play that round
--    in another week. Rounds are played IN ORDER — a team that missed week 5 plays week 5 next,
--    then week 6 — so a booking made in week 6 can be the round for week 5.
--
--    Until now the week a round counted for was always the week of the day it was booked for
--    (bookings.league_week, kept by the 0040 trigger). Now a booking may say otherwise:
--
--      bookings.league_for_week   a day in the league week this round counts for. NULL (every
--                                 booking until now) = the week of booking_date, exactly as before.
--
--    league_week stays the one column the "one round per team per week" index is built on; the
--    trigger simply reads league_for_week first. So a team still cannot have two rounds counting
--    for the same week, whichever days they are played on.
--
-- 2) SCORECARD PHOTOS. Rule 5: after every league round the team hands in a photo of the final
--    scoreboard. league_scorecards records each photo (the image itself lives in the private
--    Storage bucket "league-scorecards", which the server creates on first upload) against the
--    team and the week it is for, so staff can open any week and find a team's scorecard.
--
-- Safe to run more than once.

alter table public.bookings add column if not exists league_for_week date;
comment on column public.bookings.league_for_week is 'A day in the league week this round counts for, when that is not the week of booking_date (a make-up round). NULL = the week it is played in.';

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
  -- A make-up says which week it is for; anything else counts for the week it is played in. A
  -- booking that is no longer a league round forgets any week it was standing in for.
  new.league_week := public.league_week_of(
    coalesce(case when new.league_team_id is not null then new.league_for_week end, new.booking_date),
    coalesce(v_start, 1::smallint));
  return new;
end $$;

-- Changing the day a league's week starts re-files its rounds: by the week each one counts for.
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
         set league_week = public.league_week_of(coalesce(b.league_for_week, b.booking_date), new.week_start)
        from public.league_teams t
       where t.id = b.league_team_id and t.league_id = new.id;
    exception when unique_violation then
      raise exception 'A team in this league already has two rounds that would fall in the same week with that start day. Move or cancel one of them first.'
        using errcode = '23505';
    end;
  end if;
  return new;
end $$;

create table if not exists public.league_scorecards (
  id            uuid primary key default gen_random_uuid(),
  league_id     uuid not null references public.leagues(id) on delete cascade,
  team_id       uuid not null references public.league_teams(id) on delete cascade,
  league_week   date not null,                 -- first day of the league week the card is for
  booking_id    uuid references public.bookings(id) on delete set null,
  path          text not null,                 -- object path inside the league-scorecards bucket
  content_type  text not null default 'image/jpeg',
  bytes         integer not null default 0,
  uploaded_by   uuid references public.customers(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists league_scorecards_week on public.league_scorecards (league_id, league_week);
create index if not exists league_scorecards_team on public.league_scorecards (team_id, league_week);

-- Any staff role reads the list (the photo itself is only ever handed out by the server, as a
-- short-lived link). Rows are written by the server; staff with Bookings may remove a wrong one.
alter table public.league_scorecards enable row level security;
drop policy if exists league_scorecards_read   on public.league_scorecards;
drop policy if exists league_scorecards_delete on public.league_scorecards;
create policy league_scorecards_read on public.league_scorecards
  for select to authenticated using ((select public.staff_role()) is not null);
create policy league_scorecards_delete on public.league_scorecards
  for delete to authenticated using ((select public.staff_can('booking.write')));
