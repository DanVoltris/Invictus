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
