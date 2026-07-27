-- Invictus Golf — apply Schedule statuses to the tee sheet
-- Lets a manager "paint" a status (Maintenance, Break, Happy Hour…) across slots on the tee sheet.
-- Each painted region is a schedule_override that carries the status's colour + open/closed behaviour.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- Denormalised status colour so a painted tile keeps its exact colour even if the status is edited later.
alter table public.schedule_overrides add column if not exists status_color text;

-- true  = an "Open" status (Happy Hour, Open Prime Rate…): colours the tee sheet but does NOT block booking.
-- false = a "Closed" status (Maintenance, Break…) or a plain block: the time is unavailable.
alter table public.schedule_overrides add column if not exists status_open boolean not null default false;
