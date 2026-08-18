-- =============================================================================
-- Invictus Golf - complete database setup, in one file.
--
-- HOW TO RUN
--   Supabase -> SQL Editor -> New query -> paste this whole file -> Run.
--
-- This is the base schema plus all 17 migrations, in the order they were
-- written, followed by nothing else you need to run separately.
--
-- SAFE TO RE-RUN. Every statement uses "if not exists", "add column if not
-- exists", or "drop policy if exists", and the settings seed uses "on conflict
-- do nothing" - so running it twice changes nothing and never overwrites data.
--
-- AFTER RUNNING, create the manager login:
--   Supabase -> Authentication -> Users -> Add user (email + password).
--   Every table below grants write access to "authenticated" only.
-- =============================================================================


-- ==========================================================================
-- BASE SCHEMA - settings, bookings, row level security
-- ==========================================================================

-- Invictus Golf — manager portal schema
-- Paste this whole file into Supabase → SQL Editor → New query → Run.

create extension if not exists btree_gist;

-- 1) SETTINGS — a single editable row the manager controls.
create table if not exists public.settings (
  id         smallint primary key default 1 check (id = 1),
  bays       jsonb    not null,   -- [{ "id":"B1", "name":"…", "sim":"Uneekor" }, …]
  hours      jsonb    not null,   -- { "0":[9,20], "1":[15,23], … }  (weekday -> [open,close])
  rates      jsonb    not null,   -- { weekdayOffPeak, weekdayPeak, weekendOffPeak, weekendPeak, peakStartHour }
  min_mins   smallint not null default 60,
  max_party  smallint not null default 4,
  slot_step  smallint not null default 30,
  weekly_status jsonb not null default '{}'::jsonb,  -- recurring per-weekday tee-sheet status pattern (see migration 0010)
  online_status_label text not null default 'Booked',  -- status stamped on self-serve online bookings (see migration 0011)
  updated_at timestamptz not null default now()
);

-- 2) BOOKINGS — real reservations + manager blocks.
create table if not exists public.bookings (
  id                     uuid primary key default gen_random_uuid(),
  bay_id                 text     not null,
  booking_date           date     not null,
  start_min              smallint not null,   -- minutes from midnight
  end_min                smallint not null,
  status                 text     not null default 'confirmed'
                           check (status in ('confirmed','blocked','cancelled','held')),
  customer_name          text,
  customer_email         text,
  customer_phone         text,
  amount_cents           integer,
  stripe_payment_intent  text,
  source                 text     not null default 'online',  -- online | manager
  expires_at             timestamptz,   -- set on 'held' cart rows; null for real bookings (see migration 0012)
  created_at             timestamptz not null default now()
);
create index if not exists bookings_date_bay on public.bookings (booking_date, bay_id);

-- Make overlapping bookings in the same bay/day physically impossible (ignores cancelled).
alter table public.bookings drop constraint if exists bookings_no_overlap;
alter table public.bookings add constraint bookings_no_overlap
  exclude using gist (
    bay_id       with =,
    booking_date with =,
    int4range(start_min, end_min) with &&
  ) where (status <> 'cancelled');

-- Seed the manager's single settings row with Invictus Golf's real configuration:
-- the six bays from their GolfBook sheet, open 24/7, CA$20/hr Mon-Thu and CA$25/hr Fri-Sun.
-- "on conflict do nothing" means re-running this file never overwrites live settings.
insert into public.settings (id, bays, hours, rates, min_mins, max_party, slot_step)
values (
  1,
  '[{"id":"B1","name":"Assiniboine Credit Union Bay #1","sim":"Golfzon TwoVision","description":"Right hand only","max_players":4,"sort":1},
    {"id":"B2","name":"Birchwood Bay #2","sim":"Golfzon TwoVision","max_players":4,"sort":2},
    {"id":"B3","name":"Manitopia Realty Bay #3","sim":"Golfzon TwoVision","max_players":4,"sort":3},
    {"id":"B4","name":"Public Bay #4","sim":"Golfzon TwoVision","description":"Flat base","max_players":4,"sort":4},
    {"id":"B5","name":"McNaught Private Room #1","sim":"Golfzon TwoVision","description":"Private room","max_players":4,"sort":5},
    {"id":"B6","name":"Private Room #2","sim":"Golfzon TwoVision","description":"Private room","max_players":4,"sort":6}]'::jsonb,
  '{"0":[0,24],"1":[0,24],"2":[0,24],"3":[0,24],"4":[0,24],"5":[0,24],"6":[0,24]}'::jsonb,
  '{"weekdayOffPeak":20,"weekdayPeak":20,"weekendOffPeak":25,"weekendPeak":25,"peakStartHour":17}'::jsonb,
  60, 4, 30
)
on conflict (id) do nothing;

-- Row Level Security ---------------------------------------------------------
alter table public.settings enable row level security;
alter table public.bookings enable row level security;

-- Settings: anyone may read (no personal data here); only a signed-in manager may change.
drop policy if exists settings_read  on public.settings;
create policy settings_read  on public.settings for select using (true);
drop policy if exists settings_write on public.settings;
create policy settings_write on public.settings for all to authenticated using (true) with check (true);

-- Bookings: only a signed-in manager has direct access. The public booking page never
-- reads this table directly — it gets sanitized availability (busy time ranges, no names)
-- from a server endpoint that uses the service-role key.
drop policy if exists bookings_admin on public.bookings;
create policy bookings_admin on public.bookings for all to authenticated using (true) with check (true);


-- ==========================================================================
-- MIGRATION 0001 - MANAGER TABS
-- ==========================================================================

-- Invictus Golf — manager portal expansion
-- Adds: bay categories, schedule overrides, schedule templates,
--        custom booking statuses, tags, and per-booking tags/status label.
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once.

-- 1) BAY CATEGORIES — simulator / room types (TrackMan, Uneekor, …)
create table if not exists public.bay_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  color      text not null default '#F0523D',
  sort       smallint not null default 0,
  created_at timestamptz not null default now()
);

-- 2) SCHEDULE OVERRIDES — date-specific exceptions (holiday closures / special hours)
create table if not exists public.schedule_overrides (
  id            uuid primary key default gen_random_uuid(),
  override_date date not null unique,
  is_closed     boolean not null default false,
  open_hour     smallint,            -- null when closed
  close_hour    smallint,            -- null when closed
  note          text,
  created_at    timestamptz not null default now()
);

-- 3) SCHEDULE TEMPLATES — reusable weekly opening-hours presets
create table if not exists public.schedule_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  hours      jsonb not null,         -- { "0":[9,20], "1":[15,23], … }
  created_at timestamptz not null default now()
);

-- 4) BOOKING STATUSES — custom workflow labels (Checked-in, No-show, …)
create table if not exists public.booking_statuses (
  id         uuid primary key default gen_random_uuid(),
  label      text not null,
  color      text not null default '#4ec06a',
  sort       smallint not null default 0,
  created_at timestamptz not null default now()
);

-- 5) TAGS — free-form labels managers can attach to bookings
create table if not exists public.tags (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  color      text not null default '#c4e538',
  created_at timestamptz not null default now()
);

-- 6) Extend bookings with workflow status label + tags (kept separate from the
--    `status` column, which the availability logic relies on: confirmed/blocked/cancelled).
alter table public.bookings add column if not exists status_label text;
alter table public.bookings add column if not exists tags text[] not null default '{}';

-- Seeds (only when empty) -----------------------------------------------------
insert into public.bay_categories (name, color, sort)
select * from (values ('Uneekor','#F0523D',0), ('TrackMan','#4ec06a',1)) as v(name,color,sort)
where not exists (select 1 from public.bay_categories);

insert into public.booking_statuses (label, color, sort)
select * from (values
  ('Confirmed','#4ec06a',0), ('Checked-in','#4aa3ff',1),
  ('Completed','#9b8cff',2), ('No-show','#ff5b5b',3)) as v(label,color,sort)
where not exists (select 1 from public.booking_statuses);

insert into public.tags (name, color)
select * from (values
  ('VIP','#c4e538'), ('Birthday','#ff8fb1'), ('League','#4aa3ff'), ('Walk-in','#B5B5B5')) as v(name,color)
where not exists (select 1 from public.tags);

-- Row Level Security ----------------------------------------------------------
-- Mirrors the existing settings policy: anyone may read (no personal data here),
-- only a signed-in manager may change.
do $$
declare t text;
begin
  foreach t in array array['bay_categories','schedule_overrides','schedule_templates','booking_statuses','tags']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select using (true)', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_write on public.%I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;


-- ==========================================================================
-- MIGRATION 0002 - MEMBERSHIP CUSTOMERS
-- ==========================================================================

-- Invictus Golf — membership plans + customer database
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once.

-- 1) MEMBERSHIPS — membership plans / tiers managers can offer
create table if not exists public.memberships (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  price_cents  integer not null default 0,
  period       text not null default 'month',   -- month | year | once
  discount_pct smallint not null default 0,
  perks        text,
  color        text not null default '#c4e538',
  sort         smallint not null default 0,
  created_at   timestamptz not null default now()
);

-- 2) CUSTOMERS — customer database (manager-curated; can be imported from bookings)
create table if not exists public.customers (
  id            uuid primary key default gen_random_uuid(),
  name          text,
  email         text unique,                      -- Postgres allows many NULLs in a unique col
  phone         text,
  membership_id uuid references public.memberships(id) on delete set null,
  notes         text,
  created_at    timestamptz not null default now()
);
create index if not exists customers_name on public.customers (name);

-- Seed a few membership tiers (only when empty) -------------------------------
insert into public.memberships (name, price_cents, period, discount_pct, perks, color, sort)
select * from (values
  ('Bronze',  4900,  'month', 5,  '5% off all bookings · priority email support',                  '#cd7f32', 0),
  ('Silver',  9900,  'month', 10, '10% off all bookings · 1 free guest pass / month',              '#c0c0c0', 1),
  ('Gold',   17900, 'month', 20, '20% off all bookings · 2 free guest passes · early event access','#e5c100', 2)
) as v(name,price_cents,period,discount_pct,perks,color,sort)
where not exists (select 1 from public.memberships);

-- Row Level Security ----------------------------------------------------------
-- Memberships: anyone may read (plans aren't sensitive); only a manager may change.
alter table public.memberships enable row level security;
drop policy if exists memberships_read  on public.memberships;
create policy memberships_read  on public.memberships for select using (true);
drop policy if exists memberships_write on public.memberships;
create policy memberships_write on public.memberships for all to authenticated using (true) with check (true);

-- Customers: personal data — signed-in managers only (mirrors the bookings policy).
alter table public.customers enable row level security;
drop policy if exists customers_admin on public.customers;
create policy customers_admin on public.customers for all to authenticated using (true) with check (true);


-- ==========================================================================
-- MIGRATION 0003 - PORTAL PARITY
-- ==========================================================================

-- Invictus Golf — portal parity (payment settings + status type)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- Payment settings live in a jsonb column on the single settings row.
alter table public.settings         add column if not exists pay  jsonb not null default '{}'::jsonb;
-- Each booking status is either an "open" (bookable) or "closed" (block) tile, like GolfBooking.
alter table public.booking_statuses add column if not exists kind text  not null default 'open';

-- Seed sensible default payment settings (only if not set yet).
update public.settings set pay = jsonb_build_object(
  'taxPct', 12,
  'currency', 'CAD',
  'acceptPayments', true,
  'captureMethod', 'Credit Card Hold',
  'priorityCapture', 'No Payment',
  'processor', 'Stripe',
  'holdDisclaimer', 'Held funds will be released upon payment on-site or within 7 days, provided all terms are met.',
  'paymentDisclaimer', 'Funds will be charged to the provided credit card. Refunds will be issued if cancellation notice is provided at least 24 hours prior to the booking.'
) where id = 1 and (pay is null or pay = '{}'::jsonb);


-- ==========================================================================
-- MIGRATION 0004 - PRICE TEMPLATES
-- ==========================================================================

-- Invictus Golf — seasonal price templates + per-bay pricing
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- Saved price presets (Summer, Winter, Holiday…). bay_ids empty = applies to all bays.
create table if not exists public.price_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  rates      jsonb not null,                 -- {weekdayOffPeak,weekdayPeak,weekendOffPeak,weekendPeak,peakStartHour}
  bay_ids    text[] not null default '{}',   -- empty = all bays
  created_at timestamptz not null default now()
);

-- Per-bay rate overrides on the single settings row: { "B1": {rates…}, … }. Bays not listed use settings.rates.
alter table public.settings add column if not exists bay_rates jsonb not null default '{}'::jsonb;

alter table public.price_templates enable row level security;
drop policy if exists price_templates_read  on public.price_templates;
create policy price_templates_read  on public.price_templates for select using (true);
drop policy if exists price_templates_write on public.price_templates;
create policy price_templates_write on public.price_templates for all to authenticated using (true) with check (true);


-- ==========================================================================
-- MIGRATION 0005 - CANCELLED AT
-- ==========================================================================

-- Invictus Golf — record when a booking was cancelled (for the customer audit trail)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

alter table public.bookings add column if not exists cancelled_at timestamptz;


-- ==========================================================================
-- MIGRATION 0006 - BOOKING NOTE
-- ==========================================================================

-- Invictus Golf — per-booking note (shown on the reservation popup and the tee-sheet tile)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

alter table public.bookings add column if not exists note text;


-- ==========================================================================
-- MIGRATION 0007 - OVERRIDE BLOCKS
-- ==========================================================================

-- Invictus Golf — GolfBooking-style schedule overrides
-- Adds: per-bay targeting, partial-day time blocks with a reason, multi-day ranges,
-- enable/disable, and allows multiple overrides on the same date.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- Multiple overrides may now exist for one date (e.g. a Break on two bays + a closure).
alter table public.schedule_overrides drop constraint if exists schedule_overrides_override_date_key;

alter table public.schedule_overrides add column if not exists end_date  date;              -- null = single day
alter table public.schedule_overrides add column if not exists start_min smallint;          -- null = whole day
alter table public.schedule_overrides add column if not exists end_min   smallint;
alter table public.schedule_overrides add column if not exists bay_ids   text[] not null default '{}';  -- empty = all bays
alter table public.schedule_overrides add column if not exists is_active boolean not null default true;

create index if not exists schedule_overrides_date on public.schedule_overrides (override_date);


-- ==========================================================================
-- MIGRATION 0008 - CUSTOMER IMPORT
-- ==========================================================================

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


-- ==========================================================================
-- MIGRATION 0009 - SCHEDULE STATUS
-- ==========================================================================

-- Invictus Golf — apply Schedule statuses to the tee sheet
-- Lets a manager "paint" a status (Maintenance, Break, Happy Hour…) across slots on the tee sheet.
-- Each painted region is a schedule_override that carries the status's colour + open/closed behaviour.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- Denormalised status colour so a painted tile keeps its exact colour even if the status is edited later.
alter table public.schedule_overrides add column if not exists status_color text;

-- true  = an "Open" status (Happy Hour, Open Prime Rate…): colours the tee sheet but does NOT block booking.
-- false = a "Closed" status (Maintenance, Break…) or a plain block: the time is unavailable.
alter table public.schedule_overrides add column if not exists status_open boolean not null default false;


-- ==========================================================================
-- MIGRATION 0010 - WEEKLY STATUS
-- ==========================================================================

-- Invictus Golf — recurring weekly tee-sheet status pattern
-- Lets a manager set the default status for each weekday (e.g. Open every day, Closed on
-- Mondays, a Happy-Hour band 5–7pm) that auto-applies to every future matching day. One-off
-- exceptions still live in schedule_overrides and sit on top of this weekly base.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- Shape: { "<weekday 0-6>": [ band, … ] } where each band is
--   { "statusId":"…", "label":"…", "color":"#…", "open":true|false,
--     "full":true         -- whole day + all bays (the weekday's default)
--     | "start":540,"end":1380,"bays":["B1"]   -- a time band (minutes from midnight; bays [] = all)
--   }
alter table public.settings add column if not exists weekly_status jsonb not null default '{}'::jsonb;


-- ==========================================================================
-- MIGRATION 0011 - ONLINE STATUS
-- ==========================================================================

-- Invictus Golf — default status for self-serve online bookings
-- When a customer completes a booking on the public site, the payment webhook stamps this
-- workflow status on the reservation (defaults to "Booked"). Managers pick it in the Statuses tab.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

alter table public.settings add column if not exists online_status_label text not null default 'Booked';


-- ==========================================================================
-- MIGRATION 0012 - CART HOLDS
-- ==========================================================================

-- Invictus Golf — cart holds (Ticketmaster-style temporary reservations)
-- When a customer opens checkout, the slot is locked with a short-lived `held` booking row that
-- expires after ~5 min. Others see it as unavailable ("Held") until it's paid (→ confirmed) or
-- it expires (→ released). The existing bookings_no_overlap exclusion constraint makes the hold
-- atomic — two people can never hold the same slot.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- Allow the new 'held' status alongside the existing ones.
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('confirmed','blocked','cancelled','held'));

-- When a hold lapses (cart abandoned). Null for real bookings/blocks.
alter table public.bookings add column if not exists expires_at timestamptz;

-- Sweep stale holds quickly.
create index if not exists bookings_held_expiry on public.bookings (expires_at) where status = 'held';


-- ==========================================================================
-- MIGRATION 0013 - WAIVER SIGNING
-- ==========================================================================

-- Invictus Golf — customer-signed waiver
-- Lets a customer sign the participant waiver online (clickwrap: typed name + "I agree").
-- Reuses the existing waiver_code + waiver_signed_at columns (migration 0008) and adds the
-- signer's typed name and the waiver version they agreed to. Per the waiver's clause 12 the
-- signature is per-customer and covers all future visits, so it lives on the customer row.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

alter table public.customers add column if not exists waiver_name    text;   -- the name they typed when signing
alter table public.customers add column if not exists waiver_version text;   -- e.g. 'v2' — which waiver text they agreed to


-- ==========================================================================
-- MIGRATION 0014 - CUSTOMER SMS
-- ==========================================================================

-- Invictus Golf — SMS-notification preference on customers
-- The booking site's "Text me updates about this booking" toggle is saved here, alongside the
-- customer's contact info (which is now upserted into this table on every online booking).
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

alter table public.customers add column if not exists sms_opt_in boolean not null default true;


-- ==========================================================================
-- MIGRATION 0015 - HOUR CARDS
-- ==========================================================================

-- Invictus Golf — prepaid hour cards (virtual punch cards)
-- The owner sells blocks of range time at a discount (e.g. 10 hours for the price of 8). Customers
-- buy a card online; the hours land on their customer profile as a balance (in minutes) and get
-- drawn down as they play — deducted by staff or self-serve at online checkout.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- 1) HOUR CARD PACKAGES — owner-configured, like membership plans.
create table if not exists public.hour_cards (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  hours       numeric not null default 0,     -- hours granted (supports halves, e.g. 5.5)
  price_cents integer not null default 0,
  color       text not null default '#4aa3ff',
  sort        smallint not null default 0,
  created_at  timestamptz not null default now()
);

-- 2) CUSTOMER BALANCE — prepaid range time, stored in minutes for exactness (30-min slots).
alter table public.customers add column if not exists hours_balance_min integer not null default 0;

-- 3) LEDGER — every change to a balance (purchase / redeem / manual adjust) for a clear history.
create table if not exists public.hour_transactions (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  minutes     integer not null,               -- + credit (purchase/adjust up), − debit (redeem/adjust down)
  kind        text not null default 'adjust',  -- purchase | redeem | adjust
  note        text,
  booking_id  uuid,
  ref         text,                            -- e.g. the Stripe Checkout session id (idempotency)
  created_at  timestamptz not null default now()
);
create index if not exists hour_tx_customer on public.hour_transactions (customer_id, created_at desc);
create index if not exists hour_tx_ref on public.hour_transactions (ref) where ref is not null;

-- 4) ATOMIC balance change + ledger entry in one step. Rejects a redemption that would go negative.
create or replace function public.adjust_hours(p_customer uuid, p_delta_min integer, p_kind text, p_note text, p_booking uuid, p_ref text default null)
returns integer language plpgsql as $$
declare new_bal integer;
begin
  update public.customers
     set hours_balance_min = coalesce(hours_balance_min, 0) + p_delta_min
   where id = p_customer
   returning hours_balance_min into new_bal;
  if new_bal is null then raise exception 'customer not found'; end if;
  if new_bal < 0 then raise exception 'insufficient hours'; end if;
  insert into public.hour_transactions (customer_id, minutes, kind, note, booking_id, ref)
    values (p_customer, p_delta_min, coalesce(p_kind, 'adjust'), p_note, p_booking, p_ref);
  return new_bal;
end $$;

-- Seed a few example cards (only when the table is empty) so the /hours page has something to sell.
insert into public.hour_cards (name, hours, price_cents, color, sort)
select * from (values
  ('5-Hour Card',  5,  11000, '#4aa3ff', 0),
  ('10-Hour Card', 10, 20000, '#4ec06a', 1),
  ('20-Hour Card', 20, 38000, '#9b8cff', 2)
) as v(name,hours,price_cents,color,sort)
where not exists (select 1 from public.hour_cards);

-- Row Level Security — mirror the other manager tables: anyone may read the card list; only a
-- signed-in manager may change cards or the ledger. (The server uses the service-role key and
-- bypasses RLS for online purchases / self-serve redemption.)
do $$
declare t text;
begin
  foreach t in array array['hour_cards','hour_transactions']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select using (true)', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_write on public.%I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;


-- ==========================================================================
-- MIGRATION 0016 - POINTS
-- ==========================================================================

-- Invictus Golf — loyalty points
-- Customers earn points for time played (rate configurable, e.g. 5 pts per hour) and redeem them
-- as dollars off a booking (e.g. 100 pts = $10) — online at checkout or by staff in person.
-- Mirrors the hour-cards design: balance on the customer + an append-only ledger + one atomic fn.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- 1) BALANCE — whole points on the customer profile.
alter table public.customers add column if not exists points_balance integer not null default 0;

-- 2) RATES — configurable in the admin (Payment Settings → Loyalty points).
--    { "earnPerHour": 5, "redeemPer100": 10 }  → 5 pts per hour played; 100 pts = $10 off.
alter table public.settings add column if not exists points jsonb not null default '{}'::jsonb;

-- 3) LEDGER — every change (earn / redeem / adjust), with guards for "once only".
create table if not exists public.point_transactions (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  points      integer not null,                -- + earn/adjust up, − redeem/adjust down
  kind        text not null default 'adjust',  -- earn | redeem | adjust
  note        text,
  booking_id  uuid,
  ref         text,                            -- e.g. a Stripe PaymentIntent id (idempotency)
  created_at  timestamptz not null default now()
);
create index if not exists point_tx_customer on public.point_transactions (customer_id, created_at desc);
-- A booking can only EARN once, ever (auto-award + staff button can't double up)…
create unique index if not exists point_tx_earn_once on public.point_transactions (booking_id) where kind = 'earn' and booking_id is not null;
-- …and a payment reference can only redeem once (retry of the confirm call can't double-spend).
create unique index if not exists point_tx_ref_once on public.point_transactions (ref) where ref is not null;

-- 4) ATOMIC balance change + ledger entry. Rejects a redemption that would go negative.
create or replace function public.adjust_points(p_customer uuid, p_delta integer, p_kind text, p_note text, p_booking uuid, p_ref text default null)
returns integer language plpgsql as $$
declare new_bal integer;
begin
  update public.customers
     set points_balance = coalesce(points_balance, 0) + p_delta
   where id = p_customer
   returning points_balance into new_bal;
  if new_bal is null then raise exception 'customer not found'; end if;
  if new_bal < 0 then raise exception 'insufficient points'; end if;
  insert into public.point_transactions (customer_id, points, kind, note, booking_id, ref)
    values (p_customer, p_delta, coalesce(p_kind, 'adjust'), p_note, p_booking, p_ref);
  return new_bal;
end $$;

-- RLS — same shape as the other tables (server uses the service-role key and bypasses this).
alter table public.point_transactions enable row level security;
drop policy if exists point_transactions_read on public.point_transactions;
create policy point_transactions_read on public.point_transactions for select using (true);
drop policy if exists point_transactions_write on public.point_transactions;
create policy point_transactions_write on public.point_transactions for all to authenticated using (true) with check (true);


-- ==========================================================================
-- MIGRATION 0017 - STATUS KINDS
-- ==========================================================================

-- Invictus Golf — correct the kind on the seeded booking statuses
-- Migration 0001 seeded Confirmed/Checked-in/Completed/No-show before a `kind` column existed;
-- 0003 then added `kind` with a default of 'open', which classified all four as SCHEDULE statuses.
-- They are booking-workflow labels, so they belong to kind 'booking'. Also adds a genuinely
-- blocking schedule status ('closed'), which nothing seeded until now.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
--   kind = 'booking'  → a workflow label on one reservation (Confirmed, No-show…)
--   kind = 'open'     → paints the schedule, time stays bookable (Happy Hour…)
--   kind = 'closed'   → paints the schedule AND blocks the time (Maintenance…)

-- Only touch the four originals, and only while they still carry the defaulted 'open'
-- so a deliberate later change by a manager is never clobbered.
update public.booking_statuses
   set kind = 'booking'
 where kind = 'open'
   and label in ('Confirmed', 'Checked-in', 'Completed', 'No-show');

-- A blocking schedule status, so time can actually be closed off to customers.
insert into public.booking_statuses (label, color, kind, sort)
select 'Maintenance', '#6b7280', 'closed', 10
where not exists (select 1 from public.booking_statuses where label = 'Maintenance');
