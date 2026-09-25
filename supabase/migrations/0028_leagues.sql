-- Invictus Golf — leagues (replacing memberships) and the advance-booking window (migration 0028)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHAT CHANGES FOR CUSTOMERS
--   · Memberships are retired from the site. Their tables and customer columns are LEFT IN PLACE —
--     nothing here drops data — but no page sells them and no price uses their discount.
--   · A league is a season of weekly play: a night, a time, bays, a roster, and results.
--   · Players join from the /leagues page (and pay, when the league has a fee) or are added by staff.
--   · Being on an active league roster is the perk: book up to settings.booking_window.leagueDays
--     ahead instead of regularDays. No price discount.

-- ============================================================================
-- 1) LEAGUES
-- ============================================================================
create table if not exists public.leagues (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  day_of_week   smallint check (day_of_week between 0 and 6),        -- 0 = Sunday
  start_min     smallint check (start_min between 0 and 1440),
  end_min       smallint check (end_min between 0 and 1440),
  season_start  date,
  season_end    date,
  bay_ids       text[] not null default '{}',
  fee_cents     integer not null default 0 check (fee_cents >= 0),     -- per player, per season; 0 = free
  capacity      integer check (capacity is null or capacity > 0),       -- players; null = no limit
  team_mode     boolean not null default false,                         -- players play in teams
  scoring       text not null default 'points' check (scoring in ('points','strokes')),  -- points: high wins, strokes: low wins
  join_online   boolean not null default true,                          -- listed on /leagues with a Join button
  is_active     boolean not null default true,
  series_id     uuid,                                                   -- booking_series this season is booked as (0023)
  color         text,
  sort          integer not null default 0,
  created_at    timestamptz not null default now(),
  constraint leagues_time_order check (start_min is null or end_min is null or end_min > start_min),
  constraint leagues_season_order check (season_start is null or season_end is null or season_end >= season_start)
);

create table if not exists public.league_teams (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references public.leagues(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists league_teams_name on public.league_teams (league_id, lower(name));

-- One row per player per league. `status` keeps history: someone who left still has their results.
create table if not exists public.league_members (
  id                uuid primary key default gen_random_uuid(),
  league_id         uuid not null references public.leagues(id) on delete cascade,
  customer_id       uuid not null references public.customers(id) on delete cascade,
  team_id           uuid references public.league_teams(id) on delete set null,
  status            text not null default 'active' check (status in ('active','left')),
  source            text not null default 'staff' check (source in ('staff','online')),
  paid_cents        integer not null default 0,
  stripe_session_id text,
  note              text,
  joined_at         timestamptz not null default now()
);
create unique index if not exists league_members_once on public.league_members (league_id, customer_id);
-- A refresh of the payment success page must find the same membership, not create a second.
create unique index if not exists league_members_session on public.league_members (stripe_session_id) where stripe_session_id is not null;
create index if not exists league_members_customer on public.league_members (customer_id) where status = 'active';

-- One score per team (team leagues) or per player (individual leagues) per night played.
create table if not exists public.league_results (
  id          uuid primary key default gen_random_uuid(),
  league_id   uuid not null references public.leagues(id) on delete cascade,
  played_on   date not null,
  team_id     uuid references public.league_teams(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete cascade,
  score       numeric(8,2) not null,
  note        text,
  created_at  timestamptz not null default now(),
  constraint league_results_who check ((team_id is null) <> (customer_id is null))
);
create unique index if not exists league_results_team_night on public.league_results (league_id, played_on, team_id) where team_id is not null;
create unique index if not exists league_results_player_night on public.league_results (league_id, played_on, customer_id) where customer_id is not null;

-- ============================================================================
-- 2) THE ADVANCE-BOOKING WINDOW
-- ============================================================================
-- How far ahead a customer may book online. Staff bookings on the tee sheet are not limited.
alter table public.settings add column if not exists booking_window jsonb not null default '{}'::jsonb;
update public.settings
   set booking_window = jsonb_build_object('regularDays', 10, 'leagueDays', 60)
 where id = 1 and (booking_window is null or booking_window = '{}'::jsonb);

-- ============================================================================
-- 3) ROW LEVEL SECURITY
-- ============================================================================
-- Staff: read with any role, write with booking.write — the same rule rbac_apply (0024) gives the
-- tee sheet, since running a league is running bookings. Customers and the public get their league
-- information through api/leagues.js on the service-role key, which returns only what a player
-- should see (team names, first names, standings) — never a teammate's phone or email.
do $$
declare t text;
begin
  foreach t in array array['leagues','league_teams','league_members','league_results'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.staff_role()) is not null)', t || '_read', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select public.staff_can(''booking.write''))) with check ((select public.staff_can(''booking.write'')))', t || '_write', t);
  end loop;
end $$;
