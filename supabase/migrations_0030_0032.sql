-- Invictus Golf — everything your database is missing, in one paste (migrations 0030, 0031, 0032)
--
-- Supabase → SQL Editor → New query → paste this whole file → Run.
-- Safe to re-run. Nothing is deleted; every change only adds what is not already there.
--
--   0030  league payments (written earlier, never run here)
--   0031  leagues sold by the team: captains, invites, and the weekly round a team books itself
--   0032  lets staff choose which schedule-override reasons customers can see
--
-- Supabase runs the whole file as one transaction: if anything fails, nothing is applied.

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


-- Invictus Golf — leagues sold by the team, played on the team's own time (migration 0031)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHAT CHANGED, AND WHY
--
-- 0028 modelled a league the usual way: one night a week, everybody in at 7pm, the shop books the
-- bays for the season. That is not how this venue runs leagues. Here:
--
--   · A league is sold BY THE TEAM. One captain pays one price for the whole team.
--   · The captain invites their friends by phone number. A friend who already has an account taps
--     the link and is on the team; a friend who doesn't makes one first.
--   · There is NO fixed night. Each team plays once a week, whenever suits them, in whichever bay
--     is free — booked from the ordinary booking page and flagged as that team's league round.
--   · The round is free: the team paid for the season up front.
--   · Any member of the team can book the week's round, and all of them see it.
--   · Staff enter the scores and watch for teams who have not booked this week.
--
-- So the league's own night/time columns stop being the schedule, teams gain a captain and a
-- payment, invites get a home, and a booking can say "this is team X's round for week Y".
--
-- Nothing is dropped. day_of_week/start_min/end_min stay on the table (already nullable) so a
-- league booked the old way keeps its history; they are simply not used to build the schedule any
-- more. The same goes for league_cancelled_nights (0030): a league with no fixed nights has no
-- nights to cancel, so the table sits unused rather than being deleted with its history.

-- ============================================================================
-- 1) The league: sold by the team, with a recommended round length
-- ============================================================================
alter table public.leagues
  add column if not exists team_size       integer,
  add column if not exists weekly_min_mins integer not null default 180;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leagues_team_size_positive') then
    alter table public.leagues add constraint leagues_team_size_positive
      check (team_size is null or team_size > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leagues_weekly_min_positive') then
    alter table public.leagues add constraint leagues_weekly_min_positive
      check (weekly_min_mins > 0);
  end if;
end $$;

comment on column public.leagues.fee_cents       is 'Price for ONE TEAM for the season (0031). Was per player in 0028.';
comment on column public.leagues.team_size       is 'How many players fit on a team. Null = no limit.';
comment on column public.leagues.weekly_min_mins is 'Recommended length of a team''s weekly round, in minutes. A suggestion shown when booking, never enforced.';
comment on column public.leagues.capacity        is 'Unused since 0031 (team_size replaced it). Kept so older rows keep their value.';
comment on column public.leagues.day_of_week     is 'Unused since 0031 — teams book their own time. Kept for leagues created before it.';

-- The old per-player price becomes the per-team price, and the old player cap becomes the team
-- size. For a league that already exists, those are the closest honest readings of what was there.
update public.leagues set team_size = capacity where team_size is null and capacity is not null;

-- ============================================================================
-- 2) The team: who captains it, and what was paid for it
-- ============================================================================
alter table public.league_teams
  add column if not exists captain_customer_id uuid references public.customers(id) on delete set null,
  add column if not exists paid_cents          integer not null default 0,
  add column if not exists paid_at             timestamptz,
  add column if not exists stripe_session_id   text,
  add column if not exists note                text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'league_teams_paid_nonneg') then
    alter table public.league_teams add constraint league_teams_paid_nonneg check (paid_cents >= 0);
  end if;
end $$;

comment on column public.league_teams.captain_customer_id is 'The player who bought the team and invites the others. Null for teams staff made by hand.';
comment on column public.league_teams.stripe_session_id   is 'The Checkout Session that paid for this team. Unique, so a replayed webhook cannot create a second team.';

-- One team per Checkout Session: the webhook and the success page both settle the same payment.
create unique index if not exists league_teams_session_once
  on public.league_teams (stripe_session_id) where stripe_session_id is not null;

-- Two teams called "Birdies" in one league would make the standings a guessing game. Only added
-- when the existing data allows it, so this migration can never fail on a live database.
do $$
begin
  if not exists (
    select 1 from public.league_teams
     group by league_id, lower(name) having count(*) > 1
  ) then
    create unique index if not exists league_teams_name_per_league
      on public.league_teams (league_id, lower(name));
  else
    raise notice '0031: two teams share a name in the same league — rename one and re-run to add the unique index.';
  end if;
end $$;

-- What each team has paid, carried over from the per-player payments 0028/0030 recorded.
update public.league_teams t set
  paid_cents = coalesce((select sum(m.paid_cents) from public.league_members m where m.team_id = t.id), 0)
where t.paid_cents = 0;
update public.league_teams t set
  paid_at = (select min(m.paid_at) from public.league_members m where m.team_id = t.id and m.paid_at is not null)
where t.paid_at is null;
-- The longest-standing active member is the closest thing an old team has to a captain.
update public.league_teams t set
  captain_customer_id = (
    select m.customer_id from public.league_members m
     where m.team_id = t.id and m.status = 'active'
     order by m.joined_at limit 1)
where t.captain_customer_id is null;

-- ============================================================================
-- 3) Invites: "here's the link, you're on my team"
-- ============================================================================
-- The captain types a phone number; we text a link carrying the token. Whoever opens it proves
-- nothing about who they are — so the token is the only secret, it is single-use, and it can be
-- revoked. It is never shown in a list that anyone but the team can read.
create table if not exists public.league_team_invites (
  id                  uuid primary key default gen_random_uuid(),
  team_id             uuid not null references public.league_teams(id) on delete cascade,
  phone               text not null,
  name                text,
  token               uuid not null default gen_random_uuid(),
  invited_by          uuid references public.customers(id) on delete set null,
  claimed_at          timestamptz,
  claimed_customer_id uuid references public.customers(id) on delete set null,
  revoked_at          timestamptz,
  created_at          timestamptz not null default now()
);
create unique index if not exists league_team_invites_token on public.league_team_invites (token);
-- One live invite per number per team: inviting the same friend twice just re-sends the first one.
create unique index if not exists league_team_invites_open
  on public.league_team_invites (team_id, phone)
  where claimed_at is null and revoked_at is null;
create index if not exists league_team_invites_team on public.league_team_invites (team_id);

-- ============================================================================
-- 4) The weekly round: a booking that belongs to a team
-- ============================================================================
-- league_week is generated, never supplied: date_trunc('week') is the Monday of that booking's
-- week, so a team cannot book twice and claim the two rounds fell in different weeks.
alter table public.bookings
  add column if not exists league_team_id uuid references public.league_teams(id) on delete set null;

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'bookings' and column_name = 'league_week') then
    -- booking_date::timestamp is deliberate: date_trunc('week', <date>) resolves to the
    -- timestamptz form, which depends on the server's TimeZone setting and is therefore only
    -- STABLE — Postgres refuses it in a generated column (42P17). Casting to a plain timestamp
    -- picks the immutable form, and the answer is identical: the Monday of that calendar date.
    alter table public.bookings
      add column league_week date generated always as (date_trunc('week', booking_date::timestamp)::date) stored;
  end if;
end $$;

comment on column public.bookings.league_team_id is 'Set when this booking IS a team''s league round for the week (free, booked by any member).';
comment on column public.bookings.league_week    is 'Monday of booking_date''s week. Generated — the one round per team per week rule leans on it.';

-- The rule itself: one live round per team per week. A cancelled round frees the week again.
create unique index if not exists bookings_league_round_once
  on public.bookings (league_team_id, league_week)
  where league_team_id is not null and status <> 'cancelled';

create index if not exists bookings_league_team on public.bookings (league_team_id) where league_team_id is not null;

-- ============================================================================
-- 5) Results, grouped by the week a team played
-- ============================================================================
-- Teams no longer play on the same night, so "the 3rd Thursday" is not a column any more. The week
-- is. Same trick as above: generated from played_on so it cannot disagree with it.
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'league_results' and column_name = 'week') then
    -- Same immutability rule as bookings.league_week above.
    alter table public.league_results
      add column week date generated always as (date_trunc('week', played_on::timestamp)::date) stored;
  end if;
end $$;

create index if not exists league_results_week on public.league_results (league_id, week);

-- ============================================================================
-- 6) Row level security
-- ============================================================================
-- Same rule as every other league table (0028 §RLS, re-asserted by 0024's rbac_apply): any staff
-- role may read, booking.write may change. Customers never touch these tables directly — the
-- server reads them with the service-role key on their behalf, exactly as it does for My Account.
alter table public.league_team_invites enable row level security;
drop policy if exists league_team_invites_read  on public.league_team_invites;
drop policy if exists league_team_invites_write on public.league_team_invites;
create policy league_team_invites_read on public.league_team_invites
  for select to authenticated using ((select public.staff_role()) is not null);
create policy league_team_invites_write on public.league_team_invites
  for all to authenticated
  using ((select public.staff_can('booking.write')))
  with check ((select public.staff_can('booking.write')));

-- Tying a booking to a team needs booking.write, NOT money.write — which is what the bookings
-- write policy (0024 rbac_apply) already requires, so no extra trigger.
--
-- It was money.write at first, on the reading that a free round is a discount. In this venue the
-- person who answers the phone when a team rings is the employee, and an owner-only button would
-- mean either fetching the owner for a routine call or booking the round as an ordinary
-- reservation — which quietly loses the league record. The protection that matters is not who
-- clicks: the team already paid for the season, the season dates are checked, and the unique index
-- above allows exactly one round per team per week whoever is asking. Handing out a second free
-- round is impossible; the remaining risk is a scheduling mistake, recorded in the audit log with
-- the employee's name on it. The dangerous thing — rewriting the PRICE of a paying customer's
-- booking — is still money.write, guarded by rbac_money_bookings (amount_cents, refunded_cents).
--
-- Dropped rather than replaced, so a database that ran the earlier version of this file loses it.
do $$
begin
  if to_regclass('public.bookings') is not null then
    drop trigger if exists rbac_league_round_bookings on public.bookings;
  end if;
end $$;


-- Invictus Golf — say WHY a time is unavailable, when staff want customers to know (migration 0032)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHAT WAS WRONG
-- A schedule override carries a note ("Christmas", "Maintenance") — the column is `note`; there
-- has never been a `reason` column, which is what the first version of this code read, finding
-- nothing. And until now that note never left the building: api/availability.js merged blocked
-- time into the busy ranges with the
-- comment "no reason leaked". So a customer looking at Christmas Day saw every slot marked
-- "Booked" — which is not merely unhelpful, it is untrue. Nobody booked it; the venue is shut.
--
-- WHY A COLUMN AND NOT JUST "SHOW IT"
-- Some reasons are for customers ("Closed for Christmas") and some are not ("Dave's leaving do",
-- "hold for the Henderson party"). Staff cannot know, when they type it, which of the two a future
-- reader will treat it as — so the choice is made per override, at the moment it is written, by
-- the person who knows. Default true: the common case is a closure the customer benefits from
-- understanding, and an operator who types something private can untick the switch in front of
-- them. The field's label changes from "shown on the tee sheet" to say so.
--
-- The reason is still only ever shown for time that is genuinely unavailable. An "Open" status
-- (Happy Hour) never reaches the customer's availability at all, so nothing changes there.

alter table public.schedule_overrides
  add column if not exists public_reason boolean not null default true;

comment on column public.schedule_overrides.public_reason is
  'true = show this override''s note to customers on the booking page as well as to staff on the tee sheet. Staff pick this per override; the default is true.';

-- Existing rows keep the default (true). There is one deliberate exception: a row with no reason
-- has nothing to show either way, so the flag is irrelevant to it.

-- RLS: unchanged. schedule_overrides is already staff-read / config.write via 0024's rbac_apply,
-- and customers never read this table — the server sends them the reason through
-- /api/availability on the service-role key, exactly as it sends them opening hours.
