-- Invictus Golf — say WHY a time is unavailable, when staff want customers to know (migration 0032)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHAT WAS WRONG
-- A schedule override carries a note ("Christmas", "Maintenance") — the column is `note`; there
-- has never been a `reason` column, which is what the first version of this code read, finding
-- nothing. And until now that note never left the building: api/availability.js merged blocked
-- time into the busy ranges with the
-- comment "no reason leaked". So a customer looking at Christmas Day saw every slot marked
-- "Booked" — which is not merely unhelpful, it is untrue. Nobody booked it; the venue is shut.
--
-- WHY A COLUMN AND NOT JUST "SHOW IT"
-- Some reasons are for customers ("Closed for Christmas") and some are not ("Dave's leaving do",
-- "hold for the Henderson party"). Staff cannot know, when they type it, which of the two a future
-- reader will treat it as — so the choice is made per override, at the moment it is written, by
-- the person who knows. Default true: the common case is a closure the customer benefits from
-- understanding, and an operator who types something private can untick the switch in front of
-- them. The field's label changes from "shown on the tee sheet" to say so.
--
-- The reason is still only ever shown for time that is genuinely unavailable. An "Open" status
-- (Happy Hour) never reaches the customer's availability at all, so nothing changes there.

alter table public.schedule_overrides
  add column if not exists public_reason boolean not null default true;

comment on column public.schedule_overrides.public_reason is
  'true = show this override''s note to customers on the booking page as well as to staff on the tee sheet. Staff pick this per override; the default is true.';

-- Existing rows keep the default (true). There is one deliberate exception: a row with no reason
-- has nothing to show either way, so the flag is irrelevant to it.

-- RLS: unchanged. schedule_overrides is already staff-read / config.write via 0024's rbac_apply,
-- and customers never read this table — the server sends them the reason through
-- /api/availability on the service-role key, exactly as it sends them opening hours.
