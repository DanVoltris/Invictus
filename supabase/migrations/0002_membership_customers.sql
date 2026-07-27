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
