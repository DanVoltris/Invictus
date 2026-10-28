-- 0049 — Staff can mark a booking paid at the counter (cash, card machine, e-transfer).
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run. Needs 0024.
--
-- A booking staff put in by phone or at the desk is paid for in person, and until now there was
-- nowhere to say so. These columns record it. They are kept apart from amount_cents / refunded_cents
-- on purpose: those are what Stripe charged, and refunds are worked out from them — a payment taken
-- at the counter is never refunded through Stripe.
--
-- Anyone who can edit bookings may record a payment. Changing or removing one already recorded
-- needs the "money" permission, the same as the other money columns. Every change is in the audit log.

alter table public.bookings add column if not exists counter_paid_cents  integer;
alter table public.bookings add column if not exists counter_paid_method text;
alter table public.bookings add column if not exists counter_paid_at     timestamptz;
alter table public.bookings add column if not exists counter_paid_by     text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_counter_paid_valid') then
    alter table public.bookings add constraint bookings_counter_paid_valid check (
      (counter_paid_cents is null and counter_paid_method is null)
      or (counter_paid_cents >= 0 and counter_paid_method in ('cash', 'card', 'e_transfer', 'other')));
  end if;
end $$;

comment on column public.bookings.counter_paid_cents  is 'Paid in person, recorded by staff (0049). Not a Stripe charge: never refunded through Stripe.';
comment on column public.bookings.counter_paid_method is 'cash, card (the card machine), e_transfer or other (0049).';

-- Recording a payment is front-desk work; rewriting or removing one is money work.
create or replace function public.bookings_counter_paid_guard() returns trigger
language plpgsql as $fn$
begin
  if old.counter_paid_cents is not null
     and (new.counter_paid_cents, new.counter_paid_method, new.counter_paid_at, new.counter_paid_by)
         is distinct from (old.counter_paid_cents, old.counter_paid_method, old.counter_paid_at, old.counter_paid_by)
     and not public.staff_can('money.write') then
    raise exception 'permission denied: changing a recorded payment requires the "money" permission'
      using errcode = '42501';
  end if;
  return new;
end $fn$;
drop trigger if exists bookings_counter_paid_guard on public.bookings;
create trigger bookings_counter_paid_guard before update on public.bookings
  for each row execute function public.bookings_counter_paid_guard();

do $$ begin
  raise notice '0049 applied: staff can mark bookings paid at the counter.';
end $$;
