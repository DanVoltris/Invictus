-- =============================================================================
-- Invictus Golf - migrations 0026-0029, in one file.
--
-- Paste into Supabase -> SQL Editor -> New query -> Run.
-- Safe to re-run: every statement uses "if not exists" / "create or replace" /
-- "drop ... if exists", and settings updates only fill values that are still empty.
--
-- Needs 0001-0025 first (supabase/setup.sql as of 0025). Contents, in order:
--   0026  staff invites; customer sign-ups can no longer become admin; owner email
--   0027  customer booking notes, address + career, post-session feedback
--   0028  leagues (replacing memberships) and the advance-booking window
--   0029  link to saved cards on Stripe; customers cannot change that link
-- =============================================================================


-- ==========================================================================
-- MIGRATION 0026 - staff invites
-- ==========================================================================

-- Invictus Golf — staff invites, and closing the bootstrap to customer accounts (migration 0026)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- ============================================================================
-- WHY
-- ============================================================================
-- 1) CLOSES A HOLE. staff_role() (0024, guarantee G3) treats ANY signed-in user as an admin while
--    no active admin exists, on the stated assumption that "this database has no public sign-up".
--    Migration 0025 added public customer sign-up. On a fresh database — exactly the state of a new
--    project — the first customer to make an account on the website would become an admin: refunds,
--    rates, the customer list, staff. The bootstrap now skips customer accounts, and anyone who
--    already has a staff row (a suspended employee stays suspended).
--
-- 2) THE OWNER is murad@voltrisai.com, and becomes an admin the moment that login is created, so the
--    bootstrap closes on the owner's first sign-in instead of staying open until somebody adds an
--    admin row by hand. More admins are added from the portal's Staff tab like any other employee.
--
-- 3) Employees are now invited from the Staff tab (api/staff.js creates the login and the staff row
--    together), so nothing here changes the staff table itself.

-- ============================================================================
-- 1) staff_role() — the bootstrap no longer admits customers.
-- ============================================================================
-- Same contract as 0024: the role of the signed-in user, or null. `create or replace` keeps the
-- existing grant to authenticated and every policy that calls it.
create or replace function public.staff_role() returns text
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_uid uuid; v_role text; v_customer boolean := false;
begin
  v_uid := public.rbac_uid();
  if v_uid is null then return null; end if;

  select role into v_role from public.staff where user_id = v_uid and is_active;
  if v_role is not null then return v_role; end if;

  -- The bootstrap (0024 G3): nobody is an admin yet, so whoever signs in can set the system up.
  if exists (select 1 from public.staff where role = 'admin' and is_active) then return null; end if;
  -- ...but not somebody the staff table already knows about (suspended, or not an admin)...
  if exists (select 1 from public.staff where user_id = v_uid) then return null; end if;
  -- ...and never a customer. Two checks, because api/account.js creates the login a moment before
  -- it links the customer row: the metadata covers that gap, the link covers everything else.
  -- Dynamic SQL so this still compiles on a database without 0025 or without GoTrue; if either
  -- lookup fails for any reason the answer is "no", not "admin".
  begin
    if to_regclass('auth.users') is not null then
      execute $q$select exists (select 1 from auth.users
                                where id = $1 and raw_user_meta_data ->> 'source' = 'customer_signup')$q$
        into v_customer using v_uid;
      if v_customer then return null; end if;
    end if;
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'customers' and column_name = 'user_id') then
      execute 'select exists (select 1 from public.customers where user_id = $1)' into v_customer using v_uid;
      if v_customer then return null; end if;
    end if;
  exception when others then
    return null;
  end;

  return 'admin';
end $fn$;

-- ============================================================================
-- 2) The owner email.
-- ============================================================================
-- Only replaces the placeholder 0024 shipped with, so an owner email somebody has already set on
-- purpose is left alone on a re-run.
update public.settings
   set staff = coalesce(staff, '{}'::jsonb) || jsonb_build_object('owner_email', 'murad@voltrisai.com')
 where id = 1
   and coalesce(nullif(staff ->> 'owner_email', ''), 'john@gmail.com') = 'john@gmail.com';

-- ============================================================================
-- 3) The owner is an admin from the moment the login exists.
-- ============================================================================
-- A trigger on auth.users, which every login goes through — the Supabase dashboard, an invite from
-- the Staff tab, a customer sign-up. It must NEVER stop a login from being created, so any failure
-- is logged and swallowed.
create or replace function public.staff_claim_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_owner text;
begin
  select nullif(staff ->> 'owner_email', '') into v_owner from public.settings where id = 1;
  if v_owner is not null and new.email is not null and lower(new.email) = lower(v_owner) then
    insert into public.staff (user_id, email, role, is_active, note)
    values (new.id, new.email, 'admin', true, 'owner account — made admin when the login was created (0026)')
    on conflict (user_id) do update
      set role = 'admin', is_active = true, email = excluded.email, updated_at = now();
  end if;
  return new;
exception when others then
  raise warning 'staff_claim_owner: % — the login was still created', sqlerrm;
  return new;
end $fn$;

do $$
begin
  if to_regclass('auth.users') is null then
    raise notice '0026: no auth.users table here — skipping the owner trigger.';
    return;
  end if;
  execute 'drop trigger if exists staff_claim_owner on auth.users';
  execute 'create trigger staff_claim_owner after insert on auth.users
             for each row execute function public.staff_claim_owner()';
exception when others then
  raise notice '0026: could not add the owner trigger (%). Re-run this file after the owner login exists instead.', sqlerrm;
end $$;

-- If the owner login already exists, make it an admin now (0024's G2, with the new email).
do $$
declare v_owner text; n integer;
begin
  if to_regclass('auth.users') is null then return; end if;
  select nullif(staff ->> 'owner_email', '') into v_owner from public.settings where id = 1;
  if v_owner is null then return; end if;
  insert into public.staff (user_id, email, role, is_active, note)
  select u.id, u.email, 'admin', true, 'owner account — confirmed as admin by migration 0026'
    from auth.users u
   where lower(u.email) = lower(v_owner)
  on conflict (user_id) do update
    set role = 'admin', is_active = true, email = excluded.email, updated_at = now();
  get diagnostics n = row_count;
  raise notice '0026: owner % — %', v_owner,
    case when n = 0 then 'no login yet; becomes admin automatically when it is created' else 'active admin' end;
exception when others then
  raise notice '0026: could not confirm the owner row (%).', sqlerrm;
end $$;


-- ==========================================================================
-- MIGRATION 0027 - notes profile feedback
-- ==========================================================================

-- Invictus Golf — customer booking notes, profile details, and post-session feedback (migration 0027)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- ============================================================================
-- 1) The customer's own note on a booking.
-- ============================================================================
-- Separate from bookings.note (0006), which is the shop's note. A customer typing "bringing my own
-- clubs" at checkout must never overwrite what staff wrote, and staff must be able to tell the two
-- apart on the tee sheet.
alter table public.bookings add column if not exists customer_note text;

-- ============================================================================
-- 2) Profile details asked for at sign-up.
-- ============================================================================
-- Both optional. Customers can edit them on My Account through customers_self_update (0025); the
-- guard trigger there only protects balances, membership and the login link, not these.
alter table public.customers add column if not exists address text;
alter table public.customers add column if not exists career  text;

-- ============================================================================
-- 3) Feedback after a session.
-- ============================================================================
-- One answer per booking. A party across several bays is asked once: api code saves it against
-- one booking of the group and treats the whole group as answered. `skipped` records "not now" so
-- the customer is not asked about the same session again.
--
-- Written only by the server (service-role key) after it has checked the booking belongs to the
-- customer and has actually ended, so there is deliberately no insert policy.
create table if not exists public.booking_feedback (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references public.bookings(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  rating      smallint check (rating between 1 and 5),
  comment     text check (comment is null or char_length(comment) <= 1000),
  skipped     boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint booking_feedback_rating_or_skip check (skipped or rating is not null)
);
create unique index if not exists booking_feedback_booking on public.booking_feedback (booking_id);
create index if not exists booking_feedback_recent on public.booking_feedback (created_at desc) where not skipped;

alter table public.booking_feedback enable row level security;
-- Any staff member can read it (the Dashboard), same rule as every other table (0024 rbac_apply).
drop policy if exists booking_feedback_staff_read on public.booking_feedback;
create policy booking_feedback_staff_read on public.booking_feedback
  for select to authenticated
  using ((select public.staff_role()) is not null);
-- A customer can read their own answers, so My Account knows what not to ask again.
drop policy if exists booking_feedback_self_read on public.booking_feedback;
create policy booking_feedback_self_read on public.booking_feedback
  for select to authenticated
  using (customer_id is not null and exists (
    select 1 from public.customers c
     where c.id = booking_feedback.customer_id and c.user_id = (select public.rbac_uid())));


-- ==========================================================================
-- MIGRATION 0028 - leagues
-- ==========================================================================

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


-- ==========================================================================
-- MIGRATION 0029 - saved cards
-- ==========================================================================

-- Invictus Golf — saved cards and wallets through Stripe (migration 0029)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHAT THIS IS
-- Card numbers are never stored here. A customer's saved cards (and Apple Pay / Google Pay) live on
-- a Stripe Customer; this column is only the link to it. Because the counter's Stripe card reader
-- (Stripe Terminal) works in the same Stripe account, the shop sees the same Customer and the same
-- saved cards in the Stripe Dashboard.
--
-- The server creates the Stripe Customer the first time a signed-in customer checks out or adds a
-- card (lib/db.js stripeCustomerIdFor). Saved cards are only ever offered to that signed-in
-- customer — never to someone who merely types a matching phone number at checkout.

alter table public.customers add column if not exists stripe_customer_id text;
create unique index if not exists customers_stripe_customer on public.customers (stripe_customer_id) where stripe_customer_id is not null;

-- THE LINK IS SHOP-OWNED. customers_self_update (0025) lets a signed-in customer edit their own row;
-- without this, they could write someone else's cus_… id into stripe_customer_id and be shown that
-- person's saved cards. Same guard as 0025, one more column.
create or replace function public.customer_guard_self_columns() returns trigger
language plpgsql as $fn$
begin
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
