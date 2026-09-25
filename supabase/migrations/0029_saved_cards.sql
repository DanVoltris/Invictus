-- Invictus Golf — saved cards and wallets through Stripe (migration 0029)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHAT THIS IS
-- Card numbers are never stored here. A customer's saved cards (and Apple Pay / Google Pay) live on
-- a Stripe Customer; this column is only the link to it. Because the counter's Stripe card reader
-- (Stripe Terminal) works in the same Stripe account, the shop sees the same Customer and the same
-- saved cards in the Stripe Dashboard.
--
-- The server creates the Stripe Customer the first time a signed-in customer checks out or adds a
-- card (lib/db.js stripeCustomerIdFor). Saved cards are only ever offered to that signed-in
-- customer — never to someone who merely types a matching phone number at checkout.

alter table public.customers add column if not exists stripe_customer_id text;
create unique index if not exists customers_stripe_customer on public.customers (stripe_customer_id) where stripe_customer_id is not null;

-- THE LINK IS SHOP-OWNED. customers_self_update (0025) lets a signed-in customer edit their own row;
-- without this, they could write someone else's cus_… id into stripe_customer_id and be shown that
-- person's saved cards. Same guard as 0025, one more column.
create or replace function public.customer_guard_self_columns() returns trigger
language plpgsql as $fn$
begin
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
