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
