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

-- Seed current settings (matches the values the site ships with).
insert into public.settings (id, bays, hours, rates, min_mins, max_party, slot_step)
values (
  1,
  '[{"id":"B1","name":"The Tee Time Tavern Bay","sim":"Uneekor"},
    {"id":"B2","name":"The Bunker Bistro Bay","sim":"Uneekor"},
    {"id":"B3","name":"The Bogey Barn Bay","sim":"Uneekor"},
    {"id":"B4","name":"The Mulligan Manor Bay","sim":"TrackMan"},
    {"id":"B5","name":"The Sunset Sipper Bay","sim":"TrackMan"}]'::jsonb,
  '{"0":[9,21],"1":[11,23],"2":[11,23],"3":[11,23],"4":[11,23],"5":[11,23],"6":[9,23]}'::jsonb,
  '{"weekdayOffPeak":25,"weekdayPeak":32,"weekendOffPeak":30,"weekendPeak":36,"peakStartHour":17}'::jsonb,
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
