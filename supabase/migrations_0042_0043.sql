-- Invictus Golf — everything your database is missing, in one paste (migrations 0042-0043)
--
-- Supabase → SQL Editor → New query → paste this whole file → Run.
-- Safe to re-run. Nothing is deleted; every change only adds what is not already there.
-- Supabase runs the whole file as one transaction: if anything fails, nothing is applied.
--
--   0042  league make-up rounds (a round can count for a missed week) and scorecard photos
--   0043  an account holder cannot change their own phone number or email (the shop and the
--         server still can)
--
-- Safe to run before the new league code is deployed: the current site never fills the new
-- column, and with it empty league weeks are worked out exactly as they are today.
-- Ends with a check: if the phone/email guard is not in place, it stops with an error and
-- nothing in this file is applied. Success ends with the notice "0043 applied: …".

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


-- 0043 — An account holder cannot rewrite their own phone or email.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
-- Does not depend on 0042 (the league make-up rounds), which can be run before or after it.
--
-- WHAT WAS WRONG
-- customers_self_update (0025) lets a signed-in customer update their own row, and
-- customer_guard_self_columns refuses the columns the shop owns: balances, membership, user_id,
-- the Stripe id. It did not refuse phone or email — and those two are how everything else decides
-- who somebody IS. bookings_self_read (0025) shows an account the bookings whose phone or email
-- match its customer row, and the server credits prepaid hours to whichever row a phone resolves
-- to. So an account holder who set their phone to another customer's, straight through the API
-- with their own login, could read that customer's bookings and collect hours bought for them.
--
-- WHAT THIS DOES
-- Adds phone and email to the guard — for the account holder only. Staff edit customers' contact
-- details all day in the portal (any role, with or without the Money permission) and the server
-- sets them at sign-up; neither is touched. My Account itself only ever saves address and
-- occupation, so nothing a customer can do on the site changes.

create or replace function public.customer_guard_self_columns() returns trigger
language plpgsql as $fn$
begin
  -- WHO somebody is. Refused to everyone who is neither the server nor staff — which, given the
  -- policies on this table, is exactly an account holder editing their own row.
  if (new.phone is distinct from old.phone or new.email is distinct from old.email)
     and not public.rbac_is_service() and public.staff_role() is null then
    raise exception 'permission denied: ask the shop to change the phone number or email on your account'
      using errcode = '42501';
  end if;

  -- Staff paths are unaffected: money.write covers the shop, service_role covers the server.
  if public.staff_can('money.write') then return new; end if;
  if new.points_balance    is distinct from old.points_balance
     or new.hours_balance_min is distinct from old.hours_balance_min
     or new.membership_id     is distinct from old.membership_id
     or new.membership_expires is distinct from old.membership_expires
     or new.user_id           is distinct from old.user_id
     or new.stripe_customer_id is distinct from old.stripe_customer_id then
    raise exception 'permission denied: that field is set by the shop, not by the account holder'
      using errcode = '42501';
  end if;
  return new;
end $fn$;

-- The trigger has been in place since 0025; re-stated so this file stands on its own.
drop trigger if exists customer_guard_self on public.customers;
create trigger customer_guard_self before update on public.customers
  for each row execute function public.customer_guard_self_columns();

-- Fail loudly rather than leave the hole open behind a green "Success".
do $$
begin
  if not exists (select 1 from pg_trigger
                  where tgname = 'customer_guard_self' and tgrelid = 'public.customers'::regclass and tgenabled <> 'D') then
    raise exception '0043: customer_guard_self is not active on public.customers';
  end if;
  if position('new.phone is distinct from old.phone' in pg_get_functiondef('public.customer_guard_self_columns()'::regprocedure)) = 0 then
    raise exception '0043: customer_guard_self_columns does not guard phone/email';
  end if;
  raise notice '0043 applied: account holders can no longer change their own phone or email.';
end $$;
