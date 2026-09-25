-- Invictus Golf — gift cards
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHAT THIS IS
-- A gift card is stored value the venue owes to whoever holds the code. That makes it different
-- from every other balance in this database: prepaid hours and loyalty points belong to a known
-- customer row, but a gift card belongs to a bearer, is transferable, and (see the legal note at
-- the bottom) is a permanent liability on the venue's books rather than something that expires.
--
-- The shape deliberately mirrors hour cards (0015) and points (0016) so there is one thing to
-- learn: a balance, an append-only ledger beside it, and ONE atomic function that changes both
-- together. What is new here is the RESERVATION table, and the reason for it is in section 3.

-- ============================================================================
-- 1) GIFT CARDS — the balance.
-- ============================================================================
--
-- THE CODE IS NOT STORED. Only sha256(normalized code) is, plus the last four characters so a
-- human can tell two cards apart on a screen. Three consequences, all intended:
--   · a leaked database dump is not a stack of spendable cards;
--   · lookup is still a single indexed equality (hash the typed code, select by hash);
--   · nobody — including the owner — can recover a lost code. Staff re-issue instead: disable
--     the old card and create a new one for the remaining balance, which the ledger records.
--
-- Codes are generated in the application (lib/db.js: newGiftCode) as 16 Crockford-base32
-- characters — 80 bits of randomness, no I/L/O/U so nothing is misread off a printed card.
-- Guessing one is not feasible; gift_card_attempts in section 4 makes trying cheap to stop.
create table if not exists public.gift_cards (
  id            uuid primary key default gen_random_uuid(),
  code_hash     text not null,                  -- sha256 of the normalized code (never the code)
  code_hint     text,                           -- last 4 characters, for staff display only
  balance_cents integer not null default 0 check (balance_cents >= 0),
  initial_cents integer not null default 0,
  currency      text not null default 'cad',
  status        text not null default 'active' check (status in ('active','disabled','void')),

  -- EXPIRY: null = never expires, and that is the default for every card this app issues.
  -- Deliberately a nullable column and NOT a check constraint — see the legal note at the end.
  expires_at    timestamptz,

  -- Who bought it, who it is for, and what the giver wanted to say.
  purchaser_customer_id uuid references public.customers(id) on delete set null,
  purchaser_name  text,
  purchaser_email text,
  purchaser_phone text,
  recipient_name  text,
  recipient_email text,
  recipient_phone text,
  message         text,

  -- Delivery (the notifications outbox from 0019 does the sending).
  deliver_at   timestamptz,                     -- null = send as soon as it is paid for
  delivered_at timestamptz,

  -- Provenance. stripe_session_id is what makes an online purchase idempotent: a refresh of the
  -- success page finds the card that was already created instead of minting a second one.
  issued_by         text not null default 'online',   -- online | staff
  stripe_session_id text,
  stripe_payment_intent text,
  note        text,
  created_at  timestamptz not null default now()
);
create unique index if not exists gift_cards_code_hash on public.gift_cards (code_hash);
create unique index if not exists gift_cards_session on public.gift_cards (stripe_session_id) where stripe_session_id is not null;
create index if not exists gift_cards_purchaser on public.gift_cards (purchaser_email);
create index if not exists gift_cards_recipient on public.gift_cards (recipient_email);

-- ============================================================================
-- 2) LEDGER — append-only, one row per movement of money.
-- ============================================================================
--
-- Same columns as hour_transactions / point_transactions, same meaning: + credit, − debit.
-- kind: issue | redeem | refund | adjust | fee | void.
--
-- IDEMPOTENCY IS KEYED ON (gift_card_id, ref), NOT ON ref ALONE. Migration 0016 made the points
-- ledger's guard a GLOBAL unique index on (ref); copying that here would be a bug, because `ref`
-- at redemption is a Stripe PaymentIntent id and one booking may legitimately be settled against
-- two different gift cards. A global index would let the first card redeem and then reject the
-- second — the customer's money gone from one card and the venue short. Per-card is the correct
-- scope: the same card may only ever move once against the same payment.
create table if not exists public.gift_card_transactions (
  id           uuid primary key default gen_random_uuid(),
  gift_card_id uuid not null references public.gift_cards(id) on delete cascade,
  cents        integer not null,                 -- + issue/refund/adjust up, − redeem/fee/adjust down
  kind         text not null default 'adjust',
  note         text,
  booking_id   uuid,
  ref          text,                             -- Stripe PaymentIntent / Checkout Session id
  created_at   timestamptz not null default now()
);
create index if not exists gift_card_tx_card on public.gift_card_transactions (gift_card_id, created_at desc);
create unique index if not exists gift_card_tx_ref_once on public.gift_card_transactions (gift_card_id, ref) where ref is not null;

-- ============================================================================
-- 3) RESERVATIONS — why the balance is not debited when a PaymentIntent is created.
-- ============================================================================
--
-- demo/index.html creates a PaymentIntent speculatively: every slot change, and every apply or
-- remove of loyalty points, builds a new one and abandons the last. If applying a gift card
-- debited the balance at that moment, a customer who changed their mind twice would watch a
-- $100 card drain to $40 without ever paying for anything. Real money must not ride on a
-- prefetch.
--
-- So an applied gift card takes a RESERVATION instead: a short-lived row that lowers the card's
-- available balance without touching balance_cents. It carries the same 5-minute TTL as the cart
-- hold in lib/db.js (HOLD_MINUTES), and it is swept the same way — expired rows are deleted
-- inside reserve_gift_card before availability is computed, so a lapsed reservation can never
-- hold value hostage even if no cleanup job ever runs.
--
-- expected_charge_cents is a safety rail, not bookkeeping. It records what the customer was
-- quoted to pay on their card AFTER this gift card was applied. Settlement refuses to redeem
-- unless the PaymentIntent actually charged that amount, which means a reservation created
-- against a PaymentIntent that was never discounted is discarded rather than spent — the
-- customer is never charged full price and debited as well.
create table if not exists public.gift_card_reservations (
  id           uuid primary key default gen_random_uuid(),
  gift_card_id uuid not null references public.gift_cards(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  expected_charge_cents integer,                 -- what the card is due to be charged alongside
  ref          text not null,                    -- the Stripe PaymentIntent id this belongs to
  booking_id   uuid,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);
-- One reservation per card per payment: re-applying the same card to the same PaymentIntent
-- updates the existing row rather than stacking a second claim on the balance.
create unique index if not exists gift_card_res_ref on public.gift_card_reservations (gift_card_id, ref);
create index if not exists gift_card_res_expiry on public.gift_card_reservations (expires_at);

-- ============================================================================
-- 4) ATTEMPTS — rate limiting the "check my balance" form.
-- ============================================================================
--
-- 80 bits of entropy is not guessable, but it is still worth making a scripted sweep expensive
-- and visible. One row per code lookup; the API refuses an IP that has produced too many misses
-- in the last quarter hour. Prune it periodically — it is the only table here that is pure noise.
create table if not exists public.gift_card_attempts (
  id         uuid primary key default gen_random_uuid(),
  ip         text,
  code_hint  text,                               -- last 4 typed characters; never the whole code
  ok         boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists gift_card_attempts_ip on public.gift_card_attempts (ip, created_at desc);

-- ============================================================================
-- 5) SETTINGS.GIFT — what the owner can change without a deploy.
-- ============================================================================
--
-- Shape (all optional, api/gift-cards.js supplies the defaults shown):
--   { "minCents": 2500, "maxCents": 50000, "presetsCents": [2500,5000,10000,15000],
--     "expiryMonths": null, "dormancyFeeCents": 0 }
--
-- expiryMonths and dormancyFeeCents exist so the two levers are configurable rather than
-- compiled in. Both ship OFF. See the legal note at the end before either is turned on.
alter table public.settings add column if not exists gift jsonb not null default '{}'::jsonb;

-- ============================================================================
-- 6) FUNCTIONS.
-- ============================================================================

-- The atomic one, exactly like adjust_hours (0015) and adjust_points (0016): change the balance
-- and write the ledger row in one statement, or do neither. Everything else below calls this.
--
-- Debits carry two extra guards a points balance does not need, because a gift card is a bearer
-- instrument: the card must be active, and it must not have passed an expiry date if one was set.
create or replace function public.adjust_gift_card(p_card uuid, p_delta integer, p_kind text, p_note text, p_booking uuid, p_ref text default null)
returns integer language plpgsql as $$
declare new_bal integer; st text; exp timestamptz;
begin
  select status, expires_at into st, exp from public.gift_cards where id = p_card for update;
  if st is null then raise exception 'gift card not found'; end if;
  if p_delta < 0 then
    if st <> 'active' then raise exception 'gift card is %', st; end if;
    if exp is not null and exp <= now() then raise exception 'gift card expired'; end if;
  end if;

  update public.gift_cards
     set balance_cents = coalesce(balance_cents, 0) + p_delta
   where id = p_card
   returning balance_cents into new_bal;
  if new_bal < 0 then raise exception 'insufficient gift card balance'; end if;

  insert into public.gift_card_transactions (gift_card_id, cents, kind, note, booking_id, ref)
    values (p_card, p_delta, coalesce(p_kind, 'adjust'), p_note, p_booking, p_ref);
  return new_bal;
end $$;

-- Delete every reservation whose time has run out. Returns how many were freed, so a cron job
-- (or a script, or an opportunistic call from the API) has something to log.
create or replace function public.sweep_gift_card_reservations()
returns integer language plpgsql as $$
declare n integer;
begin
  delete from public.gift_card_reservations where expires_at < now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Spendable right now: the balance, less everything currently reserved against it. Expired
-- reservations are excluded by the where clause, so this is correct even before a sweep runs.
create or replace function public.gift_card_available(p_card uuid)
returns integer language sql stable as $$
  select greatest(0, coalesce((select balance_cents from public.gift_cards where id = p_card), 0)
    - coalesce((select sum(amount_cents) from public.gift_card_reservations
                 where gift_card_id = p_card and expires_at > now()), 0))::integer;
$$;

-- Claim part of a balance for p_ttl_seconds against one PaymentIntent. Nothing is debited.
--
-- The card row is locked first so two checkouts racing on the same code cannot both be told
-- there is enough; the loser sees the smaller availability and reserves less (or nothing).
-- Re-reserving the same (card, payment) combination REPLACES the previous claim rather than
-- adding to it, which is what makes it safe to call on every re-quote.
--
-- Returns jsonb: { reserved, requested, available, balance, expiresAt, error }.
create or replace function public.reserve_gift_card(
  p_card uuid, p_amount integer, p_ref text,
  p_charge integer default null, p_booking uuid default null, p_ttl_seconds integer default 300)
returns jsonb language plpgsql as $$
declare st text; exp timestamptz; bal integer; avail integer; take integer; until timestamptz;
begin
  select status, expires_at, balance_cents into st, exp, bal from public.gift_cards where id = p_card for update;
  if st is null then return jsonb_build_object('error', 'not_found'); end if;
  if st <> 'active' then return jsonb_build_object('error', st, 'balance', bal); end if;
  if exp is not null and exp <= now() then return jsonb_build_object('error', 'expired', 'balance', bal); end if;

  -- Free this card's lapsed claims before measuring, and drop our own previous claim so the
  -- amount below is recomputed from scratch instead of stacking on top of it.
  delete from public.gift_card_reservations where gift_card_id = p_card and (expires_at < now() or ref = p_ref);

  avail := public.gift_card_available(p_card);
  take := least(greatest(coalesce(p_amount, 0), 0), avail);
  if take <= 0 then
    return jsonb_build_object('reserved', 0, 'requested', coalesce(p_amount, 0), 'available', avail, 'balance', bal);
  end if;

  until := now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 300), 30));
  insert into public.gift_card_reservations (gift_card_id, amount_cents, expected_charge_cents, ref, booking_id, expires_at)
    values (p_card, take, p_charge, p_ref, p_booking, until);

  return jsonb_build_object('reserved', take, 'requested', coalesce(p_amount, 0),
    'available', avail - take, 'balance', bal, 'expiresAt', until);
end $$;

-- Give a claim back (checkout closed, gift card removed, slot changed). Best-effort by design:
-- releasing something that is already gone is success, because the TTL would have done it anyway.
create or replace function public.release_gift_card(p_card uuid, p_ref text)
returns integer language plpgsql as $$
declare n integer;
begin
  delete from public.gift_card_reservations where gift_card_id = p_card and ref = p_ref;
  get diagnostics n = row_count;
  return n;
end $$;

-- Settle: turn a reservation into a real debit, once the payment beside it has actually
-- succeeded. This is the ONLY place a booking spends a gift card.
--
-- p_charged is what Stripe reports the customer was charged. It must match what the reservation
-- said the customer would be charged; a mismatch means the PaymentIntent was not built with this
-- gift card applied, so the reservation is dropped and nothing is debited. Without that check, a
-- gift card applied against a PaymentIntent created before the discount wiring existed would be
-- spent on a booking the customer had already paid for in full.
--
-- Idempotent through the (gift_card_id, ref) unique index on the ledger: a retry of the confirm
-- call, or the Stripe webhook arriving after the client already settled, comes back as
-- { already: true } instead of debiting twice.
--
-- Returns jsonb: { redeemed, balance, already, error }.
create or replace function public.redeem_gift_card(
  p_card uuid, p_ref text, p_charged integer default null,
  p_booking uuid default null, p_note text default null)
returns jsonb language plpgsql as $$
declare res record; bal integer; done uuid;   -- `done` receives gift_card_transactions.id, which is a UUID.
                                             -- Declared integer, the idempotency lookup below raised 22P02 on the
                                             -- SECOND redeem of a ref, so the "already redeemed" no-op branch and the
                                             -- unique_violation handler under it were both unreachable.
begin
  select id into done from public.gift_card_transactions
   where gift_card_id = p_card and ref = p_ref and kind = 'redeem' limit 1;
  if found then
    delete from public.gift_card_reservations where gift_card_id = p_card and ref = p_ref;
    select balance_cents into bal from public.gift_cards where id = p_card;
    return jsonb_build_object('already', true, 'balance', bal);
  end if;

  select * into res from public.gift_card_reservations
   where gift_card_id = p_card and ref = p_ref for update;
  if not found then return jsonb_build_object('error', 'no_reservation'); end if;

  if res.expected_charge_cents is not null and p_charged is not null
     and res.expected_charge_cents <> p_charged then
    delete from public.gift_card_reservations where id = res.id;
    return jsonb_build_object('error', 'charge_mismatch',
      'expected', res.expected_charge_cents, 'charged', p_charged);
  end if;

  bal := public.adjust_gift_card(p_card, -res.amount_cents, 'redeem',
           coalesce(p_note, 'Booking'), coalesce(p_booking, res.booking_id), p_ref);
  delete from public.gift_card_reservations where id = res.id;
  return jsonb_build_object('redeemed', res.amount_cents, 'balance', bal);
exception when unique_violation then
  -- Lost a race with the other settlement path; that path did the debit.
  delete from public.gift_card_reservations where gift_card_id = p_card and ref = p_ref;
  select balance_cents into bal from public.gift_cards where id = p_card;
  return jsonb_build_object('already', true, 'balance', bal);
end $$;

-- ============================================================================
-- 7) ROW LEVEL SECURITY.
-- ============================================================================
--
-- Every one of these tables is customer data or spendable value, so SELECT is narrowed to
-- `authenticated` (the manager portal) exactly as migration 0018 did for the other ledgers —
-- never to `anon`, which /api/config hands to every visitor of the site. Customers reach their
-- own card through /api/gift-cards, which runs on the service-role key and returns only the
-- balance for a code they already hold.
do $$
declare t text;
begin
  foreach t in array array['gift_cards','gift_card_transactions','gift_card_reservations','gift_card_attempts']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select to authenticated using (true)', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_write on public.%I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;

-- ============================================================================
-- LEGAL NOTE — Manitoba expiry and fees. READ BEFORE CHANGING THE DEFAULTS.
-- ============================================================================
--
-- Manitoba's Consumer Protection Act and the Prepaid Purchase Cards Regulation restrict expiry
-- dates and fees on prepaid purchase cards. The SAFEST reading — the one this migration encodes —
-- is that a gift card sold for general use at this venue must not expire and must not carry
-- dormancy, maintenance or activation fees. So:
--
--   · gift_cards.expires_at defaults to NULL and the application never sets it;
--   · settings.gift.expiryMonths defaults to null and settings.gift.dormancyFeeCents to 0;
--   · the ledger has a 'fee' kind, and nothing in the codebase ever writes one.
--
-- It is encoded as DEFAULTS AND CONFIGURATION, not as a CHECK constraint, on purpose. A check
-- constraint is an awful place to be wrong about the law: the exemptions (promotional cards
-- given away at no charge, cards for a single named service, some multi-merchant arrangements)
-- are real, and if any of them applies the fix should be an owner changing a setting, not a
-- migration to drop a constraint from a table full of live liabilities.
--
-- ACTION REQUIRED: the venue's counsel should confirm this reading — in particular whether any
-- promotional or comped card the shop hands out is exempt — before the owner is told the
-- no-expiry behaviour is a legal guarantee rather than a conservative default.
--
-- Related and also unresolved: settings.pay.taxPct is displayed on receipts and never charged.
-- Whether GST/PST applies at the sale of a gift card or at its redemption is an accountant's
-- decision, not a developer's, and it is worth more on a $150 card than on a $20 booking.
