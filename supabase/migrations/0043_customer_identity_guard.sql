-- 0043 — An account holder cannot rewrite their own phone or email.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
-- Does not depend on 0042 (the league make-up rounds), which can be run before or after it.
--
-- WHAT WAS WRONG
-- customers_self_update (0025) lets a signed-in customer update their own row, and
-- customer_guard_self_columns refuses the columns the shop owns: balances, membership, user_id,
-- the Stripe id. It did not refuse phone or email — and those two are how everything else decides
-- who somebody IS. bookings_self_read (0025) shows an account the bookings whose phone or email
-- match its customer row, and the server credits prepaid hours to whichever row a phone resolves
-- to. So an account holder who set their phone to another customer's, straight through the API
-- with their own login, could read that customer's bookings and collect hours bought for them.
--
-- WHAT THIS DOES
-- Adds phone and email to the guard — for the account holder only. Staff edit customers' contact
-- details all day in the portal (any role, with or without the Money permission) and the server
-- sets them at sign-up; neither is touched. My Account itself only ever saves address and
-- occupation, so nothing a customer can do on the site changes.

create or replace function public.customer_guard_self_columns() returns trigger
language plpgsql as $fn$
begin
  -- WHO somebody is. Refused to everyone who is neither the server nor staff — which, given the
  -- policies on this table, is exactly an account holder editing their own row.
  if (new.phone is distinct from old.phone or new.email is distinct from old.email)
     and not public.rbac_is_service() and public.staff_role() is null then
    raise exception 'permission denied: ask the shop to change the phone number or email on your account'
      using errcode = '42501';
  end if;

  -- Staff paths are unaffected: money.write covers the shop, service_role covers the server.
  if public.staff_can('money.write') then return new; end if;
  if new.points_balance    is distinct from old.points_balance
     or new.hours_balance_min is distinct from old.hours_balance_min
     or new.membership_id     is distinct from old.membership_id
     or new.membership_expires is distinct from old.membership_expires
     or new.user_id           is distinct from old.user_id
     or new.stripe_customer_id is distinct from old.stripe_customer_id then
    raise exception 'permission denied: that field is set by the shop, not by the account holder'
      using errcode = '42501';
  end if;
  return new;
end $fn$;

-- The trigger has been in place since 0025; re-stated so this file stands on its own.
drop trigger if exists customer_guard_self on public.customers;
create trigger customer_guard_self before update on public.customers
  for each row execute function public.customer_guard_self_columns();

-- Fail loudly rather than leave the hole open behind a green "Success".
do $$
begin
  if not exists (select 1 from pg_trigger
                  where tgname = 'customer_guard_self' and tgrelid = 'public.customers'::regclass and tgenabled <> 'D') then
    raise exception '0043: customer_guard_self is not active on public.customers';
  end if;
  if position('new.phone is distinct from old.phone' in pg_get_functiondef('public.customer_guard_self_columns()'::regprocedure)) = 0 then
    raise exception '0043: customer_guard_self_columns does not guard phone/email';
  end if;
  raise notice '0043 applied: account holders can no longer change their own phone or email.';
end $$;
