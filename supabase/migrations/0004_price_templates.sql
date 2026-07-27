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
