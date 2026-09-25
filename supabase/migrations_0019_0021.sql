-- =============================================================================
-- Invictus Golf - migrations 0019-0021, in one file.
--
-- Paste into Supabase -> SQL Editor -> New query -> Run.
-- Safe to re-run: every statement uses "if not exists" / "add column if not
-- exists" / "drop policy if exists", and seeds use "on conflict do nothing".
--
-- NOTE: as of generation these three were ALREADY APPLIED to the live project
-- (notifications, gift_cards and promo_codes all answer). Re-running is a no-op.
--
-- 0022-0024 (waiting list, group + recurring bookings, staff roles) are NOT in
-- this file - they had not been written when it was generated.
-- =============================================================================


-- ==========================================================================
-- MIGRATION 0019 - NOTIFICATIONS OUTBOX
-- ==========================================================================

-- Invictus Golf — notification outbox (email + SMS), CASL consent, and the stripe_events fix
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHY
-- The app has never sent a message of any kind: no booking confirmation, no reminder, nothing.
-- Several planned features (waiting list, gift-card delivery, recurring bookings, subscription
-- dunning) each need "send this person a message, exactly once, and retry if the provider is
-- down". That is one table, not four, so it lands here before the first of them is built.
--
-- The queue is an OUTBOX, not a log: a row is a message that still has to happen. lib/notify.js
-- inserts rows (enqueue) and a worker walks the due ones (sendDue). Delivery is deliberately
-- separated from the request that caused it, so a slow or broken provider can never fail a
-- customer's checkout.

-- 1) NOTIFICATIONS — the outbox. ---------------------------------------------------------
--
-- dedupe_key is the heart of the table. Every caller must supply a key that identifies the
-- message rather than the attempt ("booking.confirmed:<booking id>"), and the unique index
-- below makes a second enqueue of the same message a unique violation instead of a second
-- text message to the customer. That is what makes it safe for both the Stripe webhook and
-- the client-side confirm — the two paths this repo deliberately double-covers — to enqueue
-- the same confirmation without the customer hearing about their booking twice.
create table if not exists public.notifications (
  id                  uuid primary key default gen_random_uuid(),
  channel             text not null check (channel in ('email','sms')),
  recipient           text not null,                  -- email address or E.164 phone number
  template            text not null,                  -- key into TEMPLATES in lib/notify.js
  payload             jsonb not null default '{}'::jsonb,
  dedupe_key          text not null,
  msg_class           text not null default 'transactional'
                        check (msg_class in ('transactional','commercial')),
  status              text not null default 'queued'
                        check (status in ('queued','sent','skipped','failed')),
  customer_id         uuid references public.customers(id) on delete set null,
  send_after          timestamptz not null default now(),   -- retry backoff / scheduled sends
  attempts            smallint not null default 0,
  sent_at             timestamptz,
  last_error          text,
  provider_message_id text,                           -- Resend id / Twilio message SID
  created_at          timestamptz not null default now()
);

-- The dedupe guarantee. Deliberately global and unconditional: a message that was skipped or
-- that permanently failed must NOT be silently re-queued by a later code path either — the
-- operator decides that, by deleting the row.
create unique index if not exists notifications_dedupe on public.notifications (dedupe_key);
-- The worker's only query: "queued rows whose time has come, oldest first."
create index if not exists notifications_due on public.notifications (send_after) where status = 'queued';

-- RLS. The outbox holds customer email addresses and phone numbers, so it is manager-only,
-- same class as `customers`. The server writes it with the service-role key, which bypasses
-- RLS entirely; these policies exist for the manager portal, which may want a delivery log.
alter table public.notifications enable row level security;
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated using (true);
drop policy if exists notifications_write on public.notifications;
create policy notifications_write on public.notifications for all to authenticated using (true) with check (true);

-- 2) CASL CONSENT on customers. -----------------------------------------------------------
--
-- Canada's Anti-Spam Legislation governs every commercial electronic message sent to a
-- Canadian address. Three things it requires, and where each one lives:
--
--   (a) EXPRESS CONSENT, recorded at the point of collection, with the date and how it was
--       given. Hence <channel>_consent + _at + _ip + _source below, per channel, because
--       consent to be emailed is not consent to be texted.
--   (b) IDENTIFICATION — sender name, physical mailing address, and a way to be contacted —
--       in the message itself. That is settings.venue, section 3.
--   (c) A WORKING UNSUBSCRIBE, honoured within 10 business days and usable for at least 60
--       days after the message was sent. unsub_token is the per-customer secret in that link;
--       <channel>_unsub_at is when they withdrew.
--
-- customers.sms_opt_in (migration 0014) DEFAULTS TO TRUE, so it records nothing about what
-- the customer chose — it is a UI preference, and reusing it as consent would mean claiming
-- consent from every customer who has never seen a checkbox. It is left exactly as it is;
-- sms_consent below is the column that decides whether an SMS may be sent.
alter table public.customers add column if not exists email_consent        boolean not null default false;
alter table public.customers add column if not exists email_consent_at     timestamptz;
alter table public.customers add column if not exists email_consent_ip     text;
alter table public.customers add column if not exists email_consent_source text;   -- e.g. 'checkout', 'membership', 'manager'
alter table public.customers add column if not exists email_unsub_at       timestamptz;
alter table public.customers add column if not exists sms_consent          boolean not null default false;
alter table public.customers add column if not exists sms_consent_at       timestamptz;
alter table public.customers add column if not exists sms_consent_ip       text;
alter table public.customers add column if not exists sms_consent_source   text;
alter table public.customers add column if not exists sms_unsub_at         timestamptz;
-- The secret in an unsubscribe link. Random per customer so the link cannot be guessed or
-- walked, and stable so a link stays live long past CASL's 60-day minimum.
alter table public.customers add column if not exists unsub_token          uuid not null default gen_random_uuid();
create unique index if not exists customers_unsub_token on public.customers (unsub_token);

-- 3) SETTINGS.VENUE — the identification block CASL requires in every message. -------------
--
-- Left EMPTY on purpose. lib/notify.js refuses to send anything until name + address are
-- filled in and logs what it would have sent instead, because a message without a physical
-- mailing address is a message that should not have gone out. Nobody can guess this for the
-- owner, so the owner fills it in — run this once, with the venue's real details:
--
--   update public.settings set venue = jsonb_build_object(
--     'name',           'Invictus Golf',
--     'address',        '<street address, Winnipeg, MB  <postal code>>',
--     'phone',          '(204) 488-6177',
--     'email',          '<the address that will receive unsubscribe requests>',
--     'website',        'https://invictusgolfwpg.ca',
--     'unsubscribeUrl', '<https://…/unsubscribe — optional; the email above is used if blank>'
--   ) where id = 1;
--
-- CASL accepts EITHER a link OR an electronic address that unsubscribe requests can be sent
-- to, so 'email' alone is a compliant mechanism as long as somebody reads that inbox.
alter table public.settings add column if not exists venue jsonb not null default '{}'::jsonb;

-- 4) STRIPE_EVENTS — make the policy say what migration 0018 meant. ------------------------
--
-- 0018 created this table for global webhook idempotency, and until now nothing read or wrote
-- it: api/webhook.js is wired into it in the same change as this migration. Its comment said
-- "no read policy at all — not even for authenticated", but the policy it created was
-- "for all to authenticated", and FOR ALL includes SELECT — so the comment and the grant
-- disagreed, and the grant was the one the database enforced.
--
-- The comment described the intent correctly, so the policy is what changes: dropped, leaving
-- RLS enabled with no policies, which denies anon and authenticated everything. The webhook is
-- unaffected — it uses the service-role key, which bypasses RLS.
--
-- create-table repeated (harmlessly, "if not exists") so this migration is self-contained and
-- has something to act on even when it is applied to a database that is behind on 0018.
create table if not exists public.stripe_events (
  id          text primary key,               -- Stripe's evt_… id
  received_at timestamptz not null default now()
);
create index if not exists stripe_events_received on public.stripe_events (received_at);
alter table public.stripe_events enable row level security;
drop policy if exists stripe_events_write on public.stripe_events;


-- ==========================================================================
-- MIGRATION 0020 - GIFT CARDS
-- ==========================================================================

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
declare res record; bal integer; done integer;
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


-- ==========================================================================
-- MIGRATION 0021 - PROMO CODES
-- ==========================================================================

-- Invictus Golf — promo codes / coupons
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHY OUR OWN AND NOT STRIPE COUPONS
-- Stripe Coupons only exist on a Stripe payment. Three of this venue's four booking paths never
-- create one: a points-covered booking (api/points.js ?action=book), an hour-card booking
-- (api/hour-cards.js ?action=book) and a manager's manual booking in the tee sheet are all
-- $0 to Stripe. A Stripe Coupon on the card path would mean "PROMO20 works online but the shop
-- can't honour it at the counter", which is not a coupon system, it is a Stripe feature.
-- The server already recomputes every price from saved settings and never trusts the browser
-- (lib/booking.js quoteBooking), so the discount belongs in that same waterfall, once, for all
-- four paths. Stripe also cannot express the restrictions an operator actually wants — this bay,
-- these weekdays, this time window, members only — nor "release the reservation when the cart is
-- abandoned", because a Stripe Coupon is only consumed at payment and has no reserved state.
--
-- WHAT THIS MIGRATION IS AND IS NOT RESPONSIBLE FOR
--   This file is the authority on REDEMPTION LIMITS and the VALIDITY WINDOW: the counters are
--   enforced under a row lock on the promo, so no amount of concurrency can over-redeem a code.
--   It is NOT the authority on the discount AMOUNT — the server computes that in quoteBooking
--   and passes it in. That split is safe because every function below runs only through the
--   service-role key from api/*; the browser has no route to them (see the RLS section).

-- 1) PROMOS — the codes themselves. ---------------------------------------------------------
--
-- Deliberately NOT seeded. A migration that ships a working discount code is a migration that
-- gives money away on every fresh install; the operator creates codes in the manager portal.
create table if not exists public.promos (
  id                     uuid primary key default gen_random_uuid(),
  code                   text not null,
  kind                   text not null default 'percent' check (kind in ('percent','amount')),
  percent_off            numeric(5,2) not null default 0 check (percent_off >= 0 and percent_off <= 100),
  amount_off_cents       integer not null default 0 check (amount_off_cents >= 0),
  -- Cap on a percentage code, so "50% off" on a six-hour private-room booking can't run away.
  max_discount_cents     integer check (max_discount_cents is null or max_discount_cents > 0),
  -- Minimum spend, measured on the post-membership subtotal — the number the discount is
  -- actually taken off, so a member cannot clear a threshold they never paid.
  min_subtotal_cents     integer not null default 0 check (min_subtotal_cents >= 0),

  -- Validity window. Null on either side = open-ended.
  starts_at              timestamptz,
  ends_at                timestamptz,

  -- Redemption limits. max_redemptions null = unlimited globally; max_per_customer is per
  -- customer_key (see promo_redemptions) and is 1 unless the operator says otherwise.
  max_redemptions        integer check (max_redemptions is null or max_redemptions > 0),
  max_per_customer       integer not null default 1 check (max_per_customer > 0),
  -- Live count of reservations + completed redemptions. Only ever changed inside the functions
  -- below, all of which hold "select … for update" on this row first, so it cannot drift.
  redeemed_count         integer not null default 0 check (redeemed_count >= 0),

  -- Restrictions. An empty array means "no restriction", matching how bay_ids already works on
  -- schedule_overrides (migration 0007), so the manager UI can reuse the same control.
  bay_ids                text[]   not null default '{}',
  weekdays               smallint[] not null default '{}',   -- 0=Sun … 6=Sat
  start_min              smallint,          -- time-of-day window, minutes from midnight
  end_min                smallint,
  membership_scope       text not null default 'any' check (membership_scope in ('any','members','non_members')),
  membership_ids         uuid[]   not null default '{}',     -- when scope='members': these plans only

  -- Stacking, per code. See the STACKING section in lib/booking.js — these two flags are the
  -- only knobs, and quoteBooking enforces them identically on every booking path.
  stacks_with_membership boolean not null default true,
  stacks_with_points     boolean not null default true,

  active                 boolean not null default true,
  note                   text,
  created_at             timestamptz not null default now()
);

-- Codes are case- and whitespace-insensitive to the customer, so uniqueness has to be too:
-- "promo20", "PROMO20 " and "Promo20" are one code, not three. upper() and btrim() are both
-- immutable, so they are legal in an index expression.
create unique index if not exists promos_code_key on public.promos (upper(btrim(code)));

-- 2) PROMO_REDEMPTIONS — the ledger, and the reservation. ------------------------------------
--
-- A row is created 'reserved' when the customer applies the code at checkout, and becomes
-- 'redeemed' when the payment succeeds or 'released' when the cart is abandoned or lapses.
-- This mirrors the cart-hold lifecycle in migration 0012 exactly, including the TTL, because
-- it is the same problem: something is locked while a customer decides.
--
-- customer_key is who the per-customer limit counts. It is the normalized phone (or lowercased
-- email) the customer typed, NOT customers.id — a first-time booker has no customer row yet,
-- and a limit that only binds registered customers is not a limit.
create table if not exists public.promo_redemptions (
  id             uuid primary key default gen_random_uuid(),
  promo_id       uuid not null references public.promos(id) on delete cascade,
  customer_key   text not null,
  customer_id    uuid references public.customers(id) on delete set null,
  booking_id     uuid,
  ref            text,                      -- Stripe PaymentIntent id at redeem time (idempotency)
  status         text not null default 'reserved' check (status in ('reserved','redeemed','released')),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  expires_at     timestamptz,               -- set while 'reserved'; cleared on redeem
  created_at     timestamptz not null default now(),
  redeemed_at    timestamptz,
  released_at    timestamptz
);
create index if not exists promo_redemptions_promo on public.promo_redemptions (promo_id, status);
-- The per-customer limit count, and the "does this customer already hold a live reservation?"
-- lookup that stops an abandoned-checkout replay from burning a code repeatedly.
create index if not exists promo_redemptions_customer on public.promo_redemptions (promo_id, customer_key) where status <> 'released';
create index if not exists promo_redemptions_expiry on public.promo_redemptions (expires_at) where status = 'reserved';
-- Idempotency, in the shape the other three ledgers standardised on: (parent_id, ref) rather
-- than a global (ref). Two different codes could never share a PaymentIntent today — only one
-- code applies per booking — but a global index here would silently block that forever, which
-- is the bug migration 0016's global point_tx_ref_once index already has.
create unique index if not exists promo_redemptions_ref_once on public.promo_redemptions (promo_id, ref) where ref is not null and status <> 'released';

-- 3) PROMO_ATTEMPTS — brute-force protection. ------------------------------------------------
--
-- A promo code is a short shared secret typed into a public form, so it is enumerable by
-- definition: without a limiter an attacker walks the keyspace until something validates.
-- Every validate call lands here, and the count of recent FAILED attempts per key is what
-- api/promos.js gates on. Successes are recorded too, for the operator's own diagnostics.
create table if not exists public.promo_attempts (
  id          bigserial primary key,
  attempt_key text not null,                 -- normalized contact when known, else the client IP
  code        text,
  ok          boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists promo_attempts_key on public.promo_attempts (attempt_key, created_at desc);

-- 4) SETTINGS.PROMO — operator-tunable knobs, same shape as settings.points (migration 0016).
--    { "ttlSeconds": 300, "maxFailed": 10, "windowSeconds": 3600 }
--    ttlSeconds defaults to 300 to match HOLD_MINUTES = 5 in lib/db.js: the promo reservation
--    and the cart hold must lapse together, or one outlives the booking it belonged to.
alter table public.settings add column if not exists promo jsonb not null default '{}'::jsonb;

-- 5) RESERVE — the atomic claim. -------------------------------------------------------------
--
-- Everything that can over-redeem a code happens here, so everything is done under one lock:
-- "select … from promos … for update" serializes every concurrent reserver of the SAME code
-- (and only that code, so two different codes never wait on each other). Under that lock, in
-- order: sweep this code's lapsed reservations, fold back this customer's own live one, check
-- the window, check the global limit, check the per-customer limit, insert, increment.
--
-- LOCK ORDER, EVERYWHERE IN THIS FILE: promos first, then promo_redemptions. release_promo and
-- redeem_promo take the promo lock even when they only need the redemption row, purely so the
-- order is the same in all four functions and they cannot deadlock against each other.
--
-- p_discount_cents is recorded, not verified — the server computed it in quoteBooking and the
-- browser cannot reach this function (service-role only). See the header.
create or replace function public.reserve_promo(
  p_code text,
  p_customer_key text,
  p_customer uuid default null,
  p_discount_cents integer default 0,
  p_ttl_seconds integer default 300,
  p_ref text default null
) returns jsonb language plpgsql as $$
declare
  v         public.promos%rowtype;
  v_row     public.promo_redemptions%rowtype;
  v_now     timestamptz := now();
  v_freed   integer := 0;
  v_n       integer := 0;
begin
  if coalesce(btrim(p_customer_key), '') = '' then raise exception 'promo_no_customer_key'; end if;

  select * into v from public.promos
   where upper(btrim(code)) = upper(btrim(coalesce(p_code, '')))
   for update;
  if not found  then raise exception 'promo_not_found'; end if;
  if not v.active then raise exception 'promo_inactive'; end if;
  if v.starts_at is not null and v_now < v.starts_at then raise exception 'promo_not_started'; end if;
  if v.ends_at   is not null and v_now > v.ends_at   then raise exception 'promo_expired'; end if;

  -- (a) Abandoned carts belonging to anyone: reservations whose TTL has passed are not holds.
  update public.promo_redemptions
     set status = 'released', released_at = v_now
   where promo_id = v.id and status = 'reserved' and expires_at is not null and expires_at < v_now;
  get diagnostics v_freed = row_count;

  -- (b) This customer's own live reservation. demo/index.html creates a fresh PaymentIntent on
  --     every slot change and every points apply/remove, abandoning the previous one, so the
  --     same person re-applying the same code is the NORMAL case, not an attack — and without
  --     this, one indecisive customer could exhaust a 50-use code by themselves. One live
  --     reservation per (code, customer), always: the old one is released, the new one replaces
  --     it, and the counter nets to zero.
  update public.promo_redemptions
     set status = 'released', released_at = v_now
   where promo_id = v.id and status = 'reserved' and customer_key = p_customer_key;
  get diagnostics v_n = row_count;
  v_freed := v_freed + v_n;

  if v_freed > 0 then
    update public.promos set redeemed_count = greatest(0, redeemed_count - v_freed)
     where id = v.id returning * into v;
  end if;

  if v.max_redemptions is not null and v.redeemed_count >= v.max_redemptions then
    raise exception 'promo_exhausted';
  end if;

  -- Per-customer: what is left after (b) is this customer's COMPLETED redemptions, plus any
  -- reservation of theirs that has already been paid. Live reservations were just folded back.
  select count(*) into v_n from public.promo_redemptions
   where promo_id = v.id and customer_key = p_customer_key and status <> 'released';
  if v_n >= v.max_per_customer then raise exception 'promo_already_used'; end if;

  insert into public.promo_redemptions (promo_id, customer_key, customer_id, ref, status, discount_cents, expires_at)
  values (v.id, p_customer_key, p_customer, p_ref, 'reserved', greatest(0, coalesce(p_discount_cents, 0)),
          v_now + make_interval(secs => greatest(30, least(3600, coalesce(p_ttl_seconds, 300)))))
  returning * into v_row;

  update public.promos set redeemed_count = redeemed_count + 1 where id = v.id;

  return jsonb_build_object(
    'reservationId', v_row.id,
    'promoId',       v.id,
    'code',          v.code,
    'expiresAt',     v_row.expires_at,
    'discountCents', v_row.discount_cents,
    'redeemedCount', v.redeemed_count + 1
  );
end $$;

-- 6) RELEASE — the other half of the pair. ---------------------------------------------------
-- Idempotent by design: releasing a reservation that is already released, already redeemed, or
-- simply gone returns false rather than raising, because the callers are a beacon from a closing
-- browser tab and a TTL sweeper, neither of which can handle an error usefully.
create or replace function public.release_promo(p_reservation uuid)
returns boolean language plpgsql as $$
declare
  v_promo uuid;
  v_stat  text;
begin
  select promo_id into v_promo from public.promo_redemptions where id = p_reservation;
  if v_promo is null then return false; end if;
  perform 1 from public.promos where id = v_promo for update;     -- promos first: see LOCK ORDER

  select status into v_stat from public.promo_redemptions where id = p_reservation;
  if v_stat is distinct from 'reserved' then return false; end if;

  update public.promo_redemptions set status = 'released', released_at = now() where id = p_reservation;
  update public.promos set redeemed_count = greatest(0, redeemed_count - 1) where id = v_promo;
  return true;
end $$;

-- 7) REDEEM — reserved → redeemed, at payment success. ---------------------------------------
--
-- Idempotent on (reservation, ref): the client-side confirm and the Stripe webhook both call
-- this for the same payment, on purpose (see api/confirm-booking.js), and the second one must
-- be a no-op rather than a second redemption.
--
-- THE LAPSED-RESERVATION CASE, stated explicitly because it is a money decision, not a
-- technical one: if the customer sat on a 3-D Secure challenge for longer than the TTL, the
-- reservation is already 'released' by the time the payment succeeds. We resurrect it and
-- redeem it anyway — even if that pushes redeemed_count one past max_redemptions. The
-- alternative is charging a customer the discounted amount and then not honouring the
-- discount, or failing a booking that is already paid for. Over-redeeming a marketing code by
-- one is the cheapest of the three, and it is bounded: this path is reachable only from a
-- succeeded PaymentIntent carrying a reservation id the server itself stamped.
create or replace function public.redeem_promo(p_reservation uuid, p_booking uuid default null, p_ref text default null)
returns boolean language plpgsql as $$
declare
  v_promo uuid;
  v_stat  text;
  v_ref   text;
begin
  select promo_id into v_promo from public.promo_redemptions where id = p_reservation;
  if v_promo is null then return false; end if;
  perform 1 from public.promos where id = v_promo for update;     -- promos first: see LOCK ORDER

  select status, ref into v_stat, v_ref from public.promo_redemptions where id = p_reservation;
  if v_stat = 'redeemed' then
    -- Already done. Backfill the booking id if the first caller didn't have one yet.
    if p_booking is not null then
      update public.promo_redemptions set booking_id = coalesce(booking_id, p_booking) where id = p_reservation;
    end if;
    return true;
  end if;

  if v_stat = 'released' then
    -- Resurrect: the TTL lapsed but the payment went through. See the note above.
    raise warning 'redeem_promo: reservation % lapsed before payment — honouring it anyway', p_reservation;
    update public.promos set redeemed_count = redeemed_count + 1 where id = v_promo;
  end if;

  update public.promo_redemptions
     set status = 'redeemed', redeemed_at = now(), expires_at = null, released_at = null,
         booking_id = coalesce(p_booking, booking_id), ref = coalesce(p_ref, ref)
   where id = p_reservation;
  return true;
end $$;

-- 8) SWEEP — the backstop, for codes nobody is currently reserving. ---------------------------
-- reserve_promo already sweeps its own code on every call, which keeps the hot path honest.
-- This exists so redeemed_count is also honest on the manager's promo list for a code whose
-- last reservation was abandoned an hour ago. Locks promos in id order so two concurrent
-- sweeps (or a sweep and a reserve) cannot deadlock.
create or replace function public.sweep_promo_reservations()
returns integer language plpgsql as $$
declare
  v_promo uuid;
  v_n     integer;
  v_total integer := 0;
begin
  for v_promo in
    select distinct promo_id from public.promo_redemptions
     where status = 'reserved' and expires_at is not null and expires_at < now()
     order by 1
  loop
    perform 1 from public.promos where id = v_promo for update;
    update public.promo_redemptions
       set status = 'released', released_at = now()
     where promo_id = v_promo and status = 'reserved' and expires_at is not null and expires_at < now();
    get diagnostics v_n = row_count;
    if v_n > 0 then
      update public.promos set redeemed_count = greatest(0, redeemed_count - v_n) where id = v_promo;
      v_total := v_total + v_n;
    end if;
  end loop;
  return v_total;
end $$;

-- 9) RATE LIMIT helpers. ---------------------------------------------------------------------
-- Split in two so a code that turns out to be invalid is counted, and a valid one is not held
-- against the customer. Both are cheap; promo_log_attempt also prunes opportunistically so the
-- table cannot grow without bound on a site that is being scanned.
create or replace function public.promo_rate_ok(p_key text, p_window_seconds integer default 3600, p_max_failed integer default 10)
returns boolean language sql stable as $$
  select coalesce(count(*), 0) < greatest(1, coalesce(p_max_failed, 10))
    from public.promo_attempts
   where attempt_key = p_key
     and not ok
     and created_at > now() - make_interval(secs => greatest(60, coalesce(p_window_seconds, 3600)));
$$;

create or replace function public.promo_log_attempt(p_key text, p_code text, p_ok boolean)
returns void language plpgsql as $$
begin
  insert into public.promo_attempts (attempt_key, code, ok) values (p_key, left(coalesce(p_code, ''), 64), coalesce(p_ok, false));
  -- 1-in-50 prune. The rate window is at most an hour; a day of history is generous.
  if random() < 0.02 then
    delete from public.promo_attempts where created_at < now() - interval '1 day';
  end if;
end $$;

-- 10) Row Level Security. --------------------------------------------------------------------
-- The server reaches all of the above with SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS
-- entirely, so these policies exist only for the manager portal (demo/admin.html, which signs
-- in first and holds an `authenticated` JWT). Reads are narrowed to `authenticated` per the
-- policy migration 0018 established — a promo row is the discount structure of the business and
-- promo_redemptions holds customer phone numbers in customer_key.
--
-- The anon role gets nothing anywhere in this migration. That is load-bearing: an anon SELECT on
-- promos would let any visitor read every live code straight out of the database and skip the
-- brute-force limiter entirely, which is the whole feature defeated in one query.
alter table public.promos enable row level security;
drop policy if exists promos_read on public.promos;
create policy promos_read on public.promos for select to authenticated using (true);
drop policy if exists promos_write on public.promos;
create policy promos_write on public.promos for all to authenticated using (true) with check (true);

alter table public.promo_redemptions enable row level security;
drop policy if exists promo_redemptions_read on public.promo_redemptions;
create policy promo_redemptions_read on public.promo_redemptions for select to authenticated using (true);
drop policy if exists promo_redemptions_write on public.promo_redemptions;
create policy promo_redemptions_write on public.promo_redemptions for all to authenticated using (true) with check (true);

-- promo_attempts is server-only: RLS enabled with NO policies, which denies anon and
-- authenticated everything. Same treatment migration 0019 settled on for stripe_events, and for
-- the same reason — it is webhook/endpoint bookkeeping, not something the portal renders.
alter table public.promo_attempts enable row level security;
drop policy if exists promo_attempts_write on public.promo_attempts;

