-- Invictus Golf — prepaid hour cards (virtual punch cards)
-- The owner sells blocks of range time at a discount (e.g. 10 hours for the price of 8). Customers
-- buy a card online; the hours land on their customer profile as a balance (in minutes) and get
-- drawn down as they play — deducted by staff or self-serve at online checkout.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

-- 1) HOUR CARD PACKAGES — owner-configured, like membership plans.
create table if not exists public.hour_cards (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  hours       numeric not null default 0,     -- hours granted (supports halves, e.g. 5.5)
  price_cents integer not null default 0,
  color       text not null default '#4aa3ff',
  sort        smallint not null default 0,
  created_at  timestamptz not null default now()
);

-- 2) CUSTOMER BALANCE — prepaid range time, stored in minutes for exactness (30-min slots).
alter table public.customers add column if not exists hours_balance_min integer not null default 0;

-- 3) LEDGER — every change to a balance (purchase / redeem / manual adjust) for a clear history.
create table if not exists public.hour_transactions (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  minutes     integer not null,               -- + credit (purchase/adjust up), − debit (redeem/adjust down)
  kind        text not null default 'adjust',  -- purchase | redeem | adjust
  note        text,
  booking_id  uuid,
  ref         text,                            -- e.g. the Stripe Checkout session id (idempotency)
  created_at  timestamptz not null default now()
);
create index if not exists hour_tx_customer on public.hour_transactions (customer_id, created_at desc);
create index if not exists hour_tx_ref on public.hour_transactions (ref) where ref is not null;

-- 4) ATOMIC balance change + ledger entry in one step. Rejects a redemption that would go negative.
create or replace function public.adjust_hours(p_customer uuid, p_delta_min integer, p_kind text, p_note text, p_booking uuid, p_ref text default null)
returns integer language plpgsql as $$
declare new_bal integer;
begin
  update public.customers
     set hours_balance_min = coalesce(hours_balance_min, 0) + p_delta_min
   where id = p_customer
   returning hours_balance_min into new_bal;
  if new_bal is null then raise exception 'customer not found'; end if;
  if new_bal < 0 then raise exception 'insufficient hours'; end if;
  insert into public.hour_transactions (customer_id, minutes, kind, note, booking_id, ref)
    values (p_customer, p_delta_min, coalesce(p_kind, 'adjust'), p_note, p_booking, p_ref);
  return new_bal;
end $$;

-- Seed a few example cards (only when the table is empty) so the /hours page has something to sell.
insert into public.hour_cards (name, hours, price_cents, color, sort)
select * from (values
  ('5-Hour Card',  5,  11000, '#4aa3ff', 0),
  ('10-Hour Card', 10, 20000, '#4ec06a', 1),
  ('20-Hour Card', 20, 38000, '#9b8cff', 2)
) as v(name,hours,price_cents,color,sort)
where not exists (select 1 from public.hour_cards);

-- Row Level Security — mirror the other manager tables: anyone may read the card list; only a
-- signed-in manager may change cards or the ledger. (The server uses the service-role key and
-- bypasses RLS for online purchases / self-serve redemption.)
do $$
declare t text;
begin
  foreach t in array array['hour_cards','hour_transactions']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select using (true)', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_write on public.%I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;
