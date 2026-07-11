-- Joy House Golf — loyalty points
-- Customers earn points for time played (rate configurable, e.g. 5 pts per hour) and redeem them
-- as dollars off a booking (e.g. 100 pts = $10) — online at checkout or by staff in person.
-- Mirrors the hour-cards design: balance on the customer + an append-only ledger + one atomic fn.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- 1) BALANCE — whole points on the customer profile.
alter table public.customers add column if not exists points_balance integer not null default 0;

-- 2) RATES — configurable in the admin (Payment Settings → Loyalty points).
--    { "earnPerHour": 5, "redeemPer100": 10 }  → 5 pts per hour played; 100 pts = $10 off.
alter table public.settings add column if not exists points jsonb not null default '{}'::jsonb;

-- 3) LEDGER — every change (earn / redeem / adjust), with guards for "once only".
create table if not exists public.point_transactions (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  points      integer not null,                -- + earn/adjust up, − redeem/adjust down
  kind        text not null default 'adjust',  -- earn | redeem | adjust
  note        text,
  booking_id  uuid,
  ref         text,                            -- e.g. a Stripe PaymentIntent id (idempotency)
  created_at  timestamptz not null default now()
);
create index if not exists point_tx_customer on public.point_transactions (customer_id, created_at desc);
-- A booking can only EARN once, ever (auto-award + staff button can't double up)…
create unique index if not exists point_tx_earn_once on public.point_transactions (booking_id) where kind = 'earn' and booking_id is not null;
-- …and a payment reference can only redeem once (retry of the confirm call can't double-spend).
create unique index if not exists point_tx_ref_once on public.point_transactions (ref) where ref is not null;

-- 4) ATOMIC balance change + ledger entry. Rejects a redemption that would go negative.
create or replace function public.adjust_points(p_customer uuid, p_delta integer, p_kind text, p_note text, p_booking uuid, p_ref text default null)
returns integer language plpgsql as $$
declare new_bal integer;
begin
  update public.customers
     set points_balance = coalesce(points_balance, 0) + p_delta
   where id = p_customer
   returning points_balance into new_bal;
  if new_bal is null then raise exception 'customer not found'; end if;
  if new_bal < 0 then raise exception 'insufficient points'; end if;
  insert into public.point_transactions (customer_id, points, kind, note, booking_id, ref)
    values (p_customer, p_delta, coalesce(p_kind, 'adjust'), p_note, p_booking, p_ref);
  return new_bal;
end $$;

-- RLS — same shape as the other tables (server uses the service-role key and bypasses this).
alter table public.point_transactions enable row level security;
drop policy if exists point_transactions_read on public.point_transactions;
create policy point_transactions_read on public.point_transactions for select using (true);
drop policy if exists point_transactions_write on public.point_transactions;
create policy point_transactions_write on public.point_transactions for all to authenticated using (true) with check (true);
