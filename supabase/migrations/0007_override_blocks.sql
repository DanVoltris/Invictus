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
