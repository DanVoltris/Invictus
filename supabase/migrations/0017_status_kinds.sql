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
