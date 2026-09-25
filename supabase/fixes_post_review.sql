-- =============================================================================
-- Invictus Golf - post-review corrections (re-run of 0020, 0022, 0024)
--
-- Paste into Supabase -> SQL Editor -> New query -> Run.
-- All three are idempotent, so re-running them is safe. They were already applied;
-- these are the CORRECTED versions after an adversarial review found three defects:
--
--   0020  redeem_gift_card() declared `done integer` but selected a UUID into it, so the
--         SECOND redeem of a payment reference raised 22P02 instead of returning
--         "already redeemed". Money was never double-debited, but the idempotency
--         no-op branch and the unique_violation handler beneath it were unreachable.
--
--   0022  waitlist_note_free_slot(), waitlist_process() and waitlist_sweep_expired()
--         were EXECUTE-able by PUBLIC, which includes the anon key handed to every
--         visitor by /api/config. Verified: 12 of 12 anonymous calls accepted, no auth
--         and no rate limit. Now revoked from anon/public, granted to the roles that
--         actually need them.
--
--   0024  rbac_guard_money_columns was attached to bookings.amount_cents but not
--         bookings.refunded_cents, so an employee WITHOUT the money permission could
--         mark any booking fully refunded, corrupting the refund ledger and the
--         dashboard revenue figures.
--
-- After running, re-assert the policies (0024 ships this helper for exactly this):
--   select public.rbac_apply();
-- =============================================================================


-- ==========================================================================
-- 0020 (corrected)
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


-- ==========================================================================
-- 0022 (corrected)
-- ==========================================================================

-- Invictus Golf — waiting list: entries, exclusive offers, and the triggers that fire them
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHAT THIS IS
-- A customer asks for a time that is already taken. Instead of losing them, we record what they
-- want (date, bay preference, time window, how long) and watch for that time to come free. Three
-- things free a slot in this system and all three are covered here by database triggers, because
-- two of them never pass through an API route at all:
--
--   1. a booking is CANCELLED          — api/booking.js, or a manager in demo/admin.html
--   2. a cart HOLD EXPIRES or is released — lib/db.js cleanupExpiredHolds() / releaseHold()
--   3. a schedule OVERRIDE IS REMOVED   — a manager deleting a closure/maintenance block, which
--                                         is a direct PostgREST delete from the manager portal
--
-- A trigger on each writes a row into waitlist_wakeups: "this exact slot may now be free". The
-- sweep (waitlist_process) drains that queue.
--
-- THE ONE RULE THAT MAKES THIS A FEATURE RATHER THAN A STAMPEDE
-- When a slot frees, exactly ONE waiting customer is told, and they get an EXCLUSIVE window
-- (default 15 minutes) to take it before anybody else on the list hears about it. Texting six
-- people about one bay produces five people who feel cheated and one booking that would probably
-- have happened anyway. Three separate mechanisms enforce the exclusivity, deliberately
-- overlapping, because this is the part that cannot be allowed to fail:
--
--   (a) a partial UNIQUE INDEX on (date, bay, start, end) where status = 'offered' — the database
--       physically cannot hold two live offers for the same slot;
--   (b) a real 'held' row in public.bookings for the length of the claim window (settings knob
--       waitlist.holdSlot, on by default), so the slot is genuinely reserved — the existing
--       bookings_no_overlap exclusion constraint makes that insert the atomic proof that the slot
--       was free, and availability already renders 'held' as busy;
--   (c) pg_try_advisory_xact_lock around the whole sweep, so two overlapping cron runs cannot
--       both offer the same slot — the second run finds the lock taken and returns immediately.
--
-- QUIET HOURS. The venue is open 24 hours. A text message at 3am is not a courtesy, and a claim
-- window that opens while the customer is asleep wastes the slot as well as the goodwill. During
-- quiet hours the sweep processes nothing and LEAVES the wakeups queued, so the slot is offered
-- the moment the window opens. Configurable in settings.waitlist — never hardcoded (§2).
--
-- SCHEDULING. Vercel Hobby cron is daily-only, which is useless for a claim window measured in
-- minutes, so the sweep is driven by pg_cron + pg_net inside Postgres — see §10 and the helper
-- public.waitlist_schedule_sweep(). Any external cron hitting POST /api/waitlist?action=sweep
-- works just as well; nothing below depends on which one you use.

-- 1) THE THREE TABLES. ----------------------------------------------------------------------

-- (a) ENTRIES — who is waiting, and for what.
--
-- customer_key is the dedupe identity: the normalized phone (or lowercased email) the customer
-- typed, the same key promo_redemptions uses (migration 0021), NOT customers.id — somebody
-- joining a waiting list may never have booked before and so has no customer row yet.
--
-- email_ok / sms_ok are CASL EXPRESS CONSENT for this specific purpose, captured at the point of
-- collection along with consent_at + consent_ip. An entry with neither flag set is never offered
-- anything: there would be no way to tell them, and an offer nobody is told about silently burns
-- the slot for the length of the claim window. api/waitlist.js also mirrors the consent onto
-- public.customers (migration 0019), which is where lib/notify.js enforces it at send time.
create table if not exists public.waitlist_entries (
  id               uuid primary key default gen_random_uuid(),
  -- The secret in the customer's own "you're on the list / take me off it" link. Random so it
  -- cannot be guessed or walked, exactly like customers.unsub_token in migration 0019.
  token            uuid not null default gen_random_uuid(),
  customer_id      uuid references public.customers(id) on delete set null,
  customer_key     text not null,
  name             text,
  email            text,
  phone            text,
  email_ok         boolean not null default false,
  sms_ok           boolean not null default false,
  consent_at       timestamptz,
  consent_ip       text,

  booking_date     date not null,
  -- Bay preference. Empty array = "any bay", matching how bay_ids already works on
  -- schedule_overrides (0007) and promos (0021), so the manager UI can reuse the same control.
  bay_ids          text[]   not null default '{}',
  -- The window they are available in, and how long they actually want. A 7am–11am window with a
  -- 60-minute duration means "any hour in there" — the offer is one duration-long slot inside it,
  -- never the whole window, or a four-hour cancellation would hold four hours for one player.
  window_start_min smallint not null default 0,
  window_end_min   smallint not null default 1440,
  duration_min     smallint not null default 60,
  players          smallint,
  note             text,

  status           text not null default 'active'
                     check (status in ('active','offered','claimed','cancelled','expired')),
  offers_sent      smallint not null default 0,
  last_offer_at    timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint waitlist_entries_window  check (window_end_min > window_start_min),
  constraint waitlist_entries_bounds  check (window_start_min >= 0 and window_end_min <= 1440),
  constraint waitlist_entries_duration check (duration_min >= 15 and duration_min <= window_end_min - window_start_min)
);
create unique index if not exists waitlist_entries_token on public.waitlist_entries (token);
-- The queue order is first-come, first-served, per day.
create index if not exists waitlist_entries_match on public.waitlist_entries (booking_date, status, created_at);
-- One live entry per customer per day+window: re-submitting the same request returns the entry
-- they already have instead of quietly putting them on the list twice and offering them the same
-- slot twice. A different window on the same day is a different request and is allowed.
create unique index if not exists waitlist_entries_live
  on public.waitlist_entries (customer_key, booking_date, window_start_min, window_end_min)
  where status in ('active','offered');

-- (b) OFFERS — one slot, offered to one entry, with a deadline.
create table if not exists public.waitlist_offers (
  id              uuid primary key default gen_random_uuid(),
  entry_id        uuid not null references public.waitlist_entries(id) on delete cascade,
  -- The secret in the claim link. This is the only thing standing between the offer and whoever
  -- else has the URL, so it is a uuid, it is never logged, and it dies with the offer.
  claim_token     uuid not null default gen_random_uuid(),
  booking_date    date     not null,
  bay_id          text     not null,
  start_min       smallint not null,
  end_min         smallint not null,
  status          text not null default 'offered'
                    check (status in ('offered','claimed','declined','expired','cancelled')),
  reason          text,                    -- what freed the slot: booking_cancelled | hold_expired | …
  -- The 'held' bookings row reserving the slot for the length of the claim window, when
  -- settings.waitlist.holdSlot is on. Null means the slot was offered without being held.
  hold_booking_id uuid,
  expires_at      timestamptz not null,    -- the end of the exclusive claim window
  offered_at      timestamptz not null default now(),
  -- Set by the sweep endpoint once the customer has actually been told. An offer that was created
  -- but never delivered (provider down, endpoint unreachable) is retried on the next sweep rather
  -- than sitting there silently expiring — see api/waitlist.js.
  notified_at     timestamptz,
  notify_channels text[] not null default '{}',
  claimed_at      timestamptz,
  closed_at       timestamptz,
  booking_id      uuid
);
create unique index if not exists waitlist_offers_claim_token on public.waitlist_offers (claim_token);
-- (a) from the header: one live offer per slot, enforced by the database rather than by the code
-- that happens to be running. This is the anti-stampede guarantee.
create unique index if not exists waitlist_offers_one_per_slot
  on public.waitlist_offers (booking_date, bay_id, start_min, end_min) where status = 'offered';
-- And one live offer per person: nobody is asked to decide about two slots at once.
create unique index if not exists waitlist_offers_one_per_entry
  on public.waitlist_offers (entry_id) where status = 'offered';
create index if not exists waitlist_offers_due on public.waitlist_offers (expires_at) where status = 'offered';
create index if not exists waitlist_offers_entry on public.waitlist_offers (entry_id, offered_at desc);

-- (c) WAKEUPS — the work queue the triggers write to.
--
-- A row means "this slot may have come free"; it is a hint, never a fact. The sweep re-checks the
-- slot against live bookings and schedule overrides before it offers anything, because by the time
-- it looks, a walk-in may already have taken it.
--
-- The partial unique index is what makes the whole thing idempotent: a cancellation and a lapsed
-- hold on the same slot, or the same trigger firing twice, collapse into ONE pending row, and
-- every insert below is "on conflict do nothing". Two overlapping sweeps therefore cannot find two
-- copies of the same work.
create table if not exists public.waitlist_wakeups (
  id           bigserial primary key,
  booking_date date     not null,
  bay_id       text     not null,
  start_min    smallint not null,
  end_min      smallint not null,
  reason       text,
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  offer_id     uuid
);
create unique index if not exists waitlist_wakeups_pending
  on public.waitlist_wakeups (booking_date, bay_id, start_min, end_min) where processed_at is null;
create index if not exists waitlist_wakeups_queue on public.waitlist_wakeups (created_at) where processed_at is null;

-- 2) SETTINGS.WAITLIST — every knob, none of them hardcoded. ---------------------------------
--
--   claimMinutes      how long the exclusive claim window lasts (minutes)
--   checkoutMinutes   grace after a claim, during which the slot is not re-offered to anyone else
--   maxOffersPerEntry stop pestering somebody who has ignored this many offers
--   minLeadMinutes    never offer a slot starting sooner than this — nobody can drive there in 10 min
--   quietStartMin /   quiet hours in venue-local minutes from midnight. 21:00 → 08:00 by default.
--   quietEndMin       Set them equal to switch quiet hours off entirely.
--   timezone          the venue's wall clock; the rest of the app uses America/Winnipeg
--   holdSlot          reserve the slot with a real 'held' bookings row for the claim window
--   sweepLimit        max wakeups processed per run
--   lookaheadDays     how far ahead an override deletion is allowed to generate wakeups
--
-- The defaults live in waitlist_config() below and are mirrored in lib/db.js (WAITLIST_DEFAULTS).
alter table public.settings add column if not exists waitlist jsonb not null default '{}'::jsonb;

-- Defaults merged with whatever the operator has set. jsonb || jsonb is right-biased, so a key
-- present in settings.waitlist wins and everything else falls back.
create or replace function public.waitlist_config()
returns jsonb language sql stable as $$
  select jsonb_build_object(
           'claimMinutes',      15,
           'checkoutMinutes',   10,
           'maxOffersPerEntry',  3,
           'minLeadMinutes',    60,
           'quietStartMin',   1260,
           'quietEndMin',      480,
           'timezone',        'America/Winnipeg',
           'holdSlot',        true,
           'sweepLimit',        25,
           'lookaheadDays',     14
         ) || coalesce((select waitlist from public.settings where id = 1), '{}'::jsonb);
$$;

-- Are we inside quiet hours right now? Wraps midnight when start > end (21:00 → 08:00), and is
-- off entirely when the two are equal.
create or replace function public.waitlist_quiet_now()
returns boolean language plpgsql stable as $$
declare
  cfg jsonb := public.waitlist_config();
  s   int   := (cfg->>'quietStartMin')::int;
  e   int   := (cfg->>'quietEndMin')::int;
  m   int;
begin
  if s = e then return false; end if;                 -- equal = quiet hours switched off
  select (extract(hour from t) * 60 + extract(minute from t))::int
    into m
    from (select (now() at time zone (cfg->>'timezone'))::time as t) x;
  if s < e then return m >= s and m < e; end if;      -- a window inside one day
  return m >= s or m < e;                             -- a window that wraps midnight (21:00 → 08:00)
end $$;

-- 3) IS THIS SLOT ACTUALLY FREE? --------------------------------------------------------------
--
-- Mirrors lib/booking.js overrideEffects() in SQL: a closure, a bay-specific closure, a timed
-- maintenance block, or narrowed special hours all make a slot unofferable. An "Open" status
-- (status_open) paints the tee sheet without blocking, exactly as it does in JS.
--
-- settings.weekly_status is deliberately NOT consulted: a wakeup only ever fires for a slot that
-- was occupied a moment ago, and a slot cannot have been booked inside a weekly closed band.
create or replace function public.waitlist_slot_blocked(p_date date, p_bay text, p_start int, p_end int)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.schedule_overrides o
     where o.is_active is not false
       and p_date >= o.override_date
       and p_date <= coalesce(o.end_date, o.override_date)
       and (cardinality(o.bay_ids) = 0 or p_bay = any (o.bay_ids))
       and (
            (o.start_min is null and o.is_closed)
         or (o.start_min is not null and o.end_min is not null and o.end_min > o.start_min
             and not coalesce(o.status_open, false)
             and int4range(o.start_min, o.end_min) && int4range(p_start, p_end))
         or (o.start_min is null and not o.is_closed and o.open_hour is not null
             and (p_start < o.open_hour * 60 or p_end > coalesce(o.close_hour, 24) * 60))
       )
  );
$$;

-- Anything occupying the slot right now: a confirmed booking, a manager block, or somebody else's
-- live cart hold. Lapsed holds do not count — they are rows nobody has swept yet.
create or replace function public.waitlist_slot_taken(p_date date, p_bay text, p_start int, p_end int)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.bookings b
     where b.booking_date = p_date
       and b.bay_id = p_bay
       and b.status <> 'cancelled'
       and (b.status <> 'held' or (b.expires_at is not null and b.expires_at > now()))
       and int4range(b.start_min, b.end_min) && int4range(p_start, p_end)
  )
  or exists (
    -- Somebody else's live offer, for the holdSlot = false configuration where there is no
    -- bookings row to collide with.
    select 1 from public.waitlist_offers o
     where o.status = 'offered' and o.booking_date = p_date and o.bay_id = p_bay
       and int4range(o.start_min, o.end_min) && int4range(p_start, p_end)
  );
$$;

-- 4) THE TRIGGERS. ----------------------------------------------------------------------------

-- One place that queues a wakeup, so every trigger agrees on the rules: nothing for a past date,
-- nothing while a customer who just claimed this slot is still at the checkout (their own claim
-- deletes the hold row, and without this guard that deletion would immediately offer the slot
-- they are paying for to the next person on the list), and duplicates collapse.
--
-- SECURITY DEFINER, and this is load-bearing: waitlist_wakeups has RLS on with no policies, so a
-- manager deleting a booking or a closure in the portal (role `authenticated`) could not insert
-- the wakeup, and the trigger would turn their delete into a permission error. Running as the
-- owner keeps the queue server-only AND keeps the portal working. search_path is pinned, as it
-- must be on any definer function.
create or replace function public.waitlist_note_free_slot(
  p_date date, p_bay text, p_start int, p_end int, p_reason text
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  cfg   jsonb := public.waitlist_config();
  v_now date  := (now() at time zone (cfg->>'timezone'))::date;
begin
  if p_date is null or p_bay is null or p_start is null or p_end is null then return; end if;
  if p_date < v_now then return; end if;
  if p_end <= p_start then return; end if;

  if exists (
    select 1 from public.waitlist_offers o
     where o.status = 'claimed' and o.booking_date = p_date and o.bay_id = p_bay
       and int4range(o.start_min, o.end_min) && int4range(p_start, p_end)
       and o.claimed_at > now() - make_interval(mins => (cfg->>'checkoutMinutes')::int)
  ) then
    return;
  end if;

  insert into public.waitlist_wakeups (booking_date, bay_id, start_min, end_min, reason)
  values (p_date, p_bay, p_start, p_end, p_reason)
  on conflict do nothing;
exception when others then
  -- This runs inside somebody else's DELETE or UPDATE. A waiting list that cannot queue a wakeup
  -- — a mistyped settings.waitlist value, a table that has been dropped — must never turn a
  -- manager cancelling a booking into an error. Complain in the log and let their write commit.
  raise warning 'waitlist: wakeup not queued for % % %-% (%)', p_date, p_bay, p_start, p_end, sqlerrm;
end $$;

-- (a) BOOKINGS: a cancellation, a deleted booking, or a cart hold that expired or was released.
--     cleanupExpiredHolds() in lib/db.js deletes lapsed 'held' rows in bulk; every one of those
--     deletions is a slot coming back, which is one of the three triggers this feature promises.
create or replace function public.waitlist_booking_freed() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
      perform public.waitlist_note_free_slot(old.booking_date, old.bay_id, old.start_min, old.end_min, 'booking_cancelled');
    end if;
  elsif tg_op = 'DELETE' then
    if old.status is distinct from 'cancelled' then
      perform public.waitlist_note_free_slot(old.booking_date, old.bay_id, old.start_min, old.end_min,
        case when old.status = 'held' then 'hold_expired' else 'booking_deleted' end);
    end if;
  end if;
  return null;
end $$;

drop trigger if exists waitlist_bookings_freed on public.bookings;
create trigger waitlist_bookings_freed
  after update or delete on public.bookings
  for each row execute function public.waitlist_booking_freed();

-- (b) SCHEDULE OVERRIDES: a closure or maintenance block being removed hands back every slot it
--     was covering. The manager portal deletes these straight through PostgREST, so there is no
--     API route to hook — this has to be a trigger or it does not happen at all.
--
--     Bounded on purpose: dates are clamped to today … today + lookaheadDays, and an override with
--     no bay_ids expands to the bays in settings, so deleting a year-long closure queues a few
--     dozen wakeups rather than a few thousand.
create or replace function public.waitlist_note_override(o public.schedule_overrides, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  cfg    jsonb := public.waitlist_config();
  v_today date := (now() at time zone (cfg->>'timezone'))::date;
  v_from date;
  v_to   date;
  v_s    int  := coalesce(o.start_min, 0);
  v_e    int  := coalesce(o.end_min, 1440);
  v_bays text[];
  d      date;
  b      text;
begin
  -- Only a blocking override frees anything when it goes away. An "Open" status (Happy Hour)
  -- never blocked booking in the first place — lib/booking.js overrideEffects() skips it too.
  if o.is_active is false then return; end if;
  if not (o.is_closed
          or o.open_hour is not null
          or (o.start_min is not null and not coalesce(o.status_open, false))) then
    return;
  end if;
  if v_e <= v_s then return; end if;

  v_from := greatest(o.override_date, v_today);
  v_to   := least(coalesce(o.end_date, o.override_date), v_today + (cfg->>'lookaheadDays')::int);
  if v_to < v_from then return; end if;

  -- No bay_ids means the override covered every real bay; "holding" bays are not bookable,
  -- so they are excluded here exactly as normalizeSettings() excludes them in lib/booking.js.
  if cardinality(o.bay_ids) > 0 then
    v_bays := o.bay_ids;
  else
    select coalesce(array_agg(x->>'id'), '{}')
      into v_bays
      from jsonb_array_elements(coalesce((select bays from public.settings where id = 1), '[]'::jsonb)) x
     where coalesce((x->>'holding')::boolean, false) = false
       and coalesce(x->>'id', '') <> '';
  end if;

  for d in select generate_series(v_from, v_to, interval '1 day')::date loop
    foreach b in array coalesce(v_bays, '{}') loop
      perform public.waitlist_note_free_slot(d, b, v_s, v_e, p_reason);
    end loop;
  end loop;
exception when others then
  -- Same rule as above: removing a closure must succeed whether or not the waiting list can
  -- work out what it freed.
  raise warning 'waitlist: override wakeups not queued for % (%)', o.id, sqlerrm;
end $$;

create or replace function public.waitlist_override_freed() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform public.waitlist_note_override(old, 'override_removed');
  elsif tg_op = 'UPDATE' then
    -- Deactivating it, opening it up, or moving its window all hand back the time it used to
    -- cover. The sweep re-checks availability anyway, so a wakeup that turns out to still be
    -- blocked costs one row and nothing else.
    if (old.is_active, old.is_closed, old.start_min, old.end_min, old.open_hour, old.close_hour,
        old.status_open, old.bay_ids, old.override_date, old.end_date)
       is distinct from
       (new.is_active, new.is_closed, new.start_min, new.end_min, new.open_hour, new.close_hour,
        new.status_open, new.bay_ids, new.override_date, new.end_date)
    then
      perform public.waitlist_note_override(old, 'override_changed');
    end if;
  end if;
  return null;
end $$;

drop trigger if exists waitlist_overrides_freed on public.schedule_overrides;
create trigger waitlist_overrides_freed
  after update or delete on public.schedule_overrides
  for each row execute function public.waitlist_override_freed();

-- 5) THE SWEEP. -------------------------------------------------------------------------------
--
-- Idempotent by construction, which is the requirement for anything a cron job runs:
--
--   * pg_try_advisory_xact_lock — a second concurrent run returns {"skipped":"locked"} instead of
--     racing the first one. The lock is released when the transaction ends, always.
--   * every wakeup it looks at is marked processed in the same transaction as the offer it
--     created, so a run that fails half way rolls both back together;
--   * the offer insert is guarded by a unique index and the hold insert by the bookings exclusion
--     constraint, so even without the lock the second run could not double-offer a slot;
--   * it does not send anything. It creates offers; api/waitlist.js delivers them through the
--     outbox (migration 0019), where dedupe_key stops a message going out twice.
--
-- Returns a jsonb tally, and the offers it created so the caller can notify them immediately.
create or replace function public.waitlist_process(p_limit integer default null)
returns jsonb language plpgsql as $$
declare
  cfg        jsonb := public.waitlist_config();
  tz         text  := cfg->>'timezone';
  v_today    date  := (now() at time zone tz)::date;
  v_limit    int   := greatest(1, least(200, coalesce(p_limit, (cfg->>'sweepLimit')::int)));
  v_expired  int   := 0;
  v_closed   int   := 0;
  v_seen     int   := 0;
  v_made     int   := 0;
  v_offers   jsonb := '[]'::jsonb;
  o          record;
  w          record;
  e          record;
  v_start    int;
  v_end      int;
  v_slot_at  timestamptz;
  v_deadline timestamptz;
  v_hold     uuid;
  v_offer    uuid;
  v_token    uuid;
  v_placed   boolean;
begin
  if not pg_try_advisory_xact_lock(hashtext('invictus.waitlist.sweep')) then
    return jsonb_build_object('skipped', 'locked');
  end if;

  -- (1) Lapsed claim windows. The customer was told and did not take it, so the slot goes back to
  --     the pool and the NEXT person gets their turn — which is a fresh wakeup, queued here.
  for o in select * from public.waitlist_offers where status = 'offered' and expires_at <= now() loop
    update public.waitlist_offers set status = 'expired', closed_at = now() where id = o.id;
    update public.waitlist_entries set status = 'active', updated_at = now()
     where id = o.entry_id and status = 'offered';
    if o.hold_booking_id is not null then
      delete from public.bookings where id = o.hold_booking_id and status = 'held';
    end if;
    perform public.waitlist_note_free_slot(o.booking_date, o.bay_id, o.start_min, o.end_min, 'offer_expired');
    v_expired := v_expired + 1;
  end loop;

  -- (2) Entries whose day has been and gone. Nothing to offer them ever again.
  update public.waitlist_entries set status = 'expired', updated_at = now()
   where status in ('active','offered') and booking_date < v_today;
  get diagnostics v_closed = row_count;

  -- (3) Quiet hours. Everything above is bookkeeping and is safe at any hour; everything below
  --     ends in somebody's phone lighting up, so it waits. The wakeups stay queued.
  if public.waitlist_quiet_now() then
    return jsonb_build_object('quiet', true, 'expired', v_expired, 'entriesClosed', v_closed,
                              'processed', 0, 'created', 0, 'offers', v_offers);
  end if;

  -- (4) Drain the queue.
  for w in
    select * from public.waitlist_wakeups
     where processed_at is null
     order by created_at, id
     limit v_limit
    for update skip locked
  loop
    v_seen := v_seen + 1;
    v_placed := false;
    v_offer  := null;

    -- Too late to be worth anybody's time, or the slot is not actually free after all.
    if (w.booking_date + make_interval(mins => w.start_min)) at time zone tz
         > now() + make_interval(mins => (cfg->>'minLeadMinutes')::int)
       and not public.waitlist_slot_blocked(w.booking_date, w.bay_id, w.start_min, w.end_min)
    then
      -- First matching entry wins: oldest first, and only entries we can actually reach.
      for e in
        select * from public.waitlist_entries en
         where en.status = 'active'
           and en.booking_date = w.booking_date
           and (cardinality(en.bay_ids) = 0 or w.bay_id = any (en.bay_ids))
           and greatest(en.window_start_min, w.start_min) + en.duration_min
               <= least(en.window_end_min, w.end_min)
           and en.offers_sent < (cfg->>'maxOffersPerEntry')::int
           and ((en.email_ok and en.email is not null) or (en.sms_ok and en.phone is not null))
           -- Don't offer somebody the same slot they already let lapse or turned down.
           and not exists (
             select 1 from public.waitlist_offers o2
              where o2.entry_id = en.id and o2.booking_date = w.booking_date and o2.bay_id = w.bay_id
                and o2.status in ('expired','declined','cancelled')
                and int4range(o2.start_min, o2.end_min) && int4range(w.start_min, w.end_min))
         order by en.created_at, en.id
      loop
        -- The offered slot is one duration-long block at the start of the overlap, never the
        -- whole freed range.
        v_start := greatest(e.window_start_min, w.start_min);
        v_end   := v_start + e.duration_min;
        if v_end > least(e.window_end_min, w.end_min) then continue; end if;

        v_slot_at  := (w.booking_date + make_interval(mins => v_start)) at time zone tz;
        -- The claim window never runs past the slot itself: a deadline after the tee time is not
        -- a deadline. Skip the entry if what is left is too short to act on.
        v_deadline := least(now() + make_interval(mins => (cfg->>'claimMinutes')::int),
                            v_slot_at - interval '5 minutes');
        if v_deadline <= now() + interval '2 minutes' then exit; end if;

        if public.waitlist_slot_taken(w.booking_date, w.bay_id, v_start, v_end) then exit; end if;

        v_hold := null;
        if (cfg->>'holdSlot')::boolean then
          -- The atomic proof that the slot is free. bookings_no_overlap turns a race into an
          -- exception rather than a double booking; if we lose it, the slot was never ours.
          begin
            insert into public.bookings (bay_id, booking_date, start_min, end_min, status,
                                         expires_at, source, customer_name, customer_email, customer_phone)
            values (w.bay_id, w.booking_date, v_start, v_end, 'held',
                    v_deadline, 'waitlist', e.name, e.email, e.phone)
            returning id into v_hold;
          exception when exclusion_violation or unique_violation then
            v_hold := null;
            exit;                              -- somebody got there first; nothing to offer
          end;
        end if;

        begin
          insert into public.waitlist_offers (entry_id, booking_date, bay_id, start_min, end_min,
                                              reason, hold_booking_id, expires_at)
          values (e.id, w.booking_date, w.bay_id, v_start, v_end, w.reason, v_hold, v_deadline)
          returning id, claim_token into v_offer, v_token;
        exception when unique_violation then
          -- A live offer already exists for this slot or this entry. Give the hold back and stop.
          if v_hold is not null then delete from public.bookings where id = v_hold and status = 'held'; end if;
          exit;
        end;

        update public.waitlist_entries
           set status = 'offered', offers_sent = offers_sent + 1, last_offer_at = now(), updated_at = now()
         where id = e.id;

        v_made   := v_made + 1;
        v_placed := true;
        v_offers := v_offers || jsonb_build_object(
          'offerId', v_offer, 'entryId', e.id, 'claimToken', v_token,
          'dateISO', w.booking_date, 'bayId', w.bay_id,
          'startMin', v_start, 'endMin', v_end, 'expiresAt', v_deadline, 'reason', w.reason);
        exit;
      end loop;
    end if;

    update public.waitlist_wakeups
       set processed_at = now(), offer_id = case when v_placed then v_offer else null end
     where id = w.id;
  end loop;

  return jsonb_build_object('quiet', false, 'expired', v_expired, 'entriesClosed', v_closed,
                            'processed', v_seen, 'created', v_made, 'offers', v_offers);
end $$;

-- 6) CLAIM — the customer says yes. -----------------------------------------------------------
--
-- Under a row lock on the offer, so two taps on the link in a text message cannot both claim.
-- The hold row is RELEASED here rather than kept: the customer goes straight into the ordinary
-- checkout, which creates its own cart hold (lib/db.js createHold), and a leftover waitlist hold
-- would collide with it on the exclusion constraint and refuse the booking the customer was just
-- promised. The slot is protected across that handover by waitlist_note_free_slot(), which
-- suppresses wakeups for a slot claimed within the last checkoutMinutes.
create or replace function public.waitlist_claim(p_token uuid)
returns jsonb language plpgsql as $$
declare
  o   public.waitlist_offers%rowtype;
  cfg jsonb := public.waitlist_config();
begin
  select * into o from public.waitlist_offers where claim_token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

  if o.status = 'claimed' then
    return jsonb_build_object('ok', true, 'already', true, 'offerId', o.id, 'entryId', o.entry_id,
                              'dateISO', o.booking_date, 'bayId', o.bay_id,
                              'startMin', o.start_min, 'endMin', o.end_min,
                              'checkoutBy', o.claimed_at + make_interval(mins => (cfg->>'checkoutMinutes')::int));
  end if;
  if o.status <> 'offered' then
    return jsonb_build_object('ok', false, 'reason', o.status);
  end if;
  if o.expires_at <= now() then
    -- Let the sweep do the tidying and the re-offering; just say no here.
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  update public.waitlist_offers
     set status = 'claimed', claimed_at = now(), closed_at = now()
   where id = o.id;
  update public.waitlist_entries set status = 'claimed', updated_at = now() where id = o.entry_id;
  if o.hold_booking_id is not null then
    delete from public.bookings where id = o.hold_booking_id and status = 'held';
  end if;

  return jsonb_build_object('ok', true, 'offerId', o.id, 'entryId', o.entry_id,
                            'dateISO', o.booking_date, 'bayId', o.bay_id,
                            'startMin', o.start_min, 'endMin', o.end_min,
                            'checkoutBy', now() + make_interval(mins => (cfg->>'checkoutMinutes')::int));
end $$;

-- 7) DECLINE — "no thanks", which is worth having because it hands the slot to the next person
--    immediately instead of after the full claim window.
create or replace function public.waitlist_decline(p_token uuid, p_leave boolean default false)
returns jsonb language plpgsql as $$
declare o public.waitlist_offers%rowtype;
begin
  select * into o from public.waitlist_offers where claim_token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if o.status <> 'offered' then return jsonb_build_object('ok', false, 'reason', o.status); end if;

  update public.waitlist_offers set status = 'declined', closed_at = now() where id = o.id;
  update public.waitlist_entries
     set status = case when p_leave then 'cancelled' else 'active' end, updated_at = now()
   where id = o.entry_id;
  if o.hold_booking_id is not null then
    delete from public.bookings where id = o.hold_booking_id and status = 'held';
  end if;
  perform public.waitlist_note_free_slot(o.booking_date, o.bay_id, o.start_min, o.end_min, 'offer_declined');
  return jsonb_build_object('ok', true, 'left', coalesce(p_leave, false));
end $$;

-- 8) LEAVE — the customer takes themselves off the list, from their own link.
create or replace function public.waitlist_leave(p_token uuid)
returns jsonb language plpgsql as $$
declare
  e public.waitlist_entries%rowtype;
  o public.waitlist_offers%rowtype;
begin
  select * into e from public.waitlist_entries where token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if e.status in ('cancelled','expired') then return jsonb_build_object('ok', true, 'already', true); end if;

  update public.waitlist_entries set status = 'cancelled', updated_at = now() where id = e.id;
  -- Any live offer of theirs is withdrawn, and the slot goes straight back to the pool so the
  -- next person on the list gets it instead of waiting out a claim window nobody is using.
  update public.waitlist_offers set status = 'cancelled', closed_at = now()
   where entry_id = e.id and status = 'offered';
  for o in select * from public.waitlist_offers
            where entry_id = e.id and status = 'cancelled' and closed_at > now() - interval '1 minute' loop
    if o.hold_booking_id is not null then
      delete from public.bookings where id = o.hold_booking_id and status = 'held';
    end if;
    perform public.waitlist_note_free_slot(o.booking_date, o.bay_id, o.start_min, o.end_min, 'entry_left');
  end loop;
  return jsonb_build_object('ok', true);
end $$;

-- 9) ROW LEVEL SECURITY. -----------------------------------------------------------------------
-- The server reaches all of this with SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS entirely, so
-- these policies exist for the manager portal alone (demo/admin.html signs in first and holds an
-- `authenticated` JWT). Reads are narrowed to `authenticated`, per migration 0018 — entries and
-- offers hold customer names, emails and phone numbers.
--
-- The anon role gets nothing. That is load-bearing twice over: an anon SELECT on waitlist_offers
-- would hand every visitor the claim tokens for every live offer, and an anon SELECT on
-- waitlist_entries is a customer contact list.
alter table public.waitlist_entries enable row level security;
drop policy if exists waitlist_entries_read on public.waitlist_entries;
create policy waitlist_entries_read on public.waitlist_entries for select to authenticated using (true);
drop policy if exists waitlist_entries_write on public.waitlist_entries;
create policy waitlist_entries_write on public.waitlist_entries for all to authenticated using (true) with check (true);

alter table public.waitlist_offers enable row level security;
drop policy if exists waitlist_offers_read on public.waitlist_offers;
create policy waitlist_offers_read on public.waitlist_offers for select to authenticated using (true);
drop policy if exists waitlist_offers_write on public.waitlist_offers;
create policy waitlist_offers_write on public.waitlist_offers for all to authenticated using (true) with check (true);

-- The wakeup queue is server bookkeeping, not something the portal renders: RLS on with NO
-- policies denies anon and authenticated everything, the same treatment stripe_events (0019) and
-- promo_attempts (0021) get.
alter table public.waitlist_wakeups enable row level security;
drop policy if exists waitlist_wakeups_write on public.waitlist_wakeups;
drop policy if exists waitlist_wakeups_read on public.waitlist_wakeups;

-- 10) SCHEDULING — pg_cron + pg_net. -----------------------------------------------------------
--
-- Vercel Hobby cron runs once a day. A claim window is fifteen minutes. Those two facts cannot be
-- reconciled, so the clock lives in Postgres instead: pg_cron ticks every minute and pg_net posts
-- to the app, which runs the sweep and sends the messages. Both extensions ship with Supabase but
-- are off until enabled — Dashboard → Database → Extensions, or the two statements below.
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'waitlist: could not create extension pg_cron (%). Enable it in Supabase → Database → Extensions.', sqlerrm;
  end;
  begin
    create extension if not exists pg_net;
  exception when others then
    raise notice 'waitlist: could not create extension pg_net (%). Enable it in Supabase → Database → Extensions.', sqlerrm;
  end;
end $$;

-- Schedule (or re-schedule) the sweep. Run it once with your deployment's URL and the value you
-- put in WAITLIST_SWEEP_SECRET:
--
--   select public.waitlist_schedule_sweep(
--     'https://<your-app>/api/waitlist?action=sweep', '<WAITLIST_SWEEP_SECRET>');
--
-- Every minute is the right cadence: the claim window is measured in minutes, the sweep is a
-- no-op when the wakeup queue is empty, and it holds an advisory lock so a slow run simply makes
-- the next one return immediately.
create or replace function public.waitlist_schedule_sweep(
  p_url text, p_secret text default null, p_schedule text default '* * * * *'
) returns text language plpgsql as $$
declare v_sql text; v_id bigint;
begin
  if to_regclass('cron.job') is null then
    return 'pg_cron is not installed — enable it in Supabase → Database → Extensions, then run this again.';
  end if;
  if to_regproc('net.http_post') is null then
    return 'pg_net is not installed — enable it in Supabase → Database → Extensions, then run this again.';
  end if;

  perform cron.unschedule(jobid) from cron.job where jobname = 'waitlist-sweep';

  v_sql := format(
    'select net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb, timeout_milliseconds := 8000)',
    p_url,
    jsonb_build_object('Content-Type', 'application/json',
                       'x-waitlist-secret', coalesce(p_secret, ''))::text,
    '{}');
  select cron.schedule('waitlist-sweep', p_schedule, v_sql) into v_id;
  return format('waitlist-sweep scheduled as job %s (%s) → %s', v_id, p_schedule, p_url);
end $$;

-- Stop it again (holidays, a broken deployment, or before rotating the secret):
--   select public.waitlist_unschedule_sweep();
create or replace function public.waitlist_unschedule_sweep()
returns text language plpgsql as $$
begin
  if to_regclass('cron.job') is null then return 'pg_cron is not installed.'; end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'waitlist-sweep';
  return 'waitlist-sweep unscheduled.';
end $$;
-- ============================================================================
-- FUNCTION GRANTS — keep the internals off the anon key.
-- ============================================================================
-- Postgres grants EXECUTE on a new function to PUBLIC by default, and /api/config hands the anon
-- key to every visitor of the site. That made waitlist_note_free_slot() callable by anyone, with
-- no auth and no rate limit: an anonymous caller could flood waitlist_wakeups and drive the sweep.
-- Nothing in the application calls it directly -- every caller is a trigger or another function
-- in this file, which run as their definer -- so revoking it from anon costs nothing.
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.waitlist_note_free_slot(date,text,int,int,text)',
    'public.waitlist_process(integer)',
    'public.waitlist_sweep_expired()'
  ] loop
    if to_regprocedure(fn) is null then continue; end if;
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('grant execute on function %s to service_role', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
exception when others then
  raise notice '0022: could not tighten waitlist function grants (%).', sqlerrm;
end $$;


-- ==========================================================================
-- 0024 (corrected)
-- ==========================================================================

-- Invictus Golf — staff accounts, roles, and an audit log (migration 0024)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- ============================================================================
-- WHAT IS WRONG TODAY
-- ============================================================================
-- Every write policy in this database says "for all to authenticated using (true)". There is one
-- Supabase auth user, so that has been harmless. The moment a second person is given a login —
-- a part-time counter employee, a bookkeeper — that person can issue refunds, rewrite the rate
-- card, adjust anybody's points balance, and read the whole customer list. There is no smaller
-- door. This migration adds three roles (admin / employee / read-only), one capability check
-- behind every write policy, and a record of who changed what.
--
-- ============================================================================
-- THE ONE THING THAT MUST NOT HAPPEN: LOCKING THE OWNER OUT
-- ============================================================================
-- There is exactly one live manager account. A role system that leaves it unable to sign in and
-- fix the problem is worse than no role system at all. Four independent guarantees, in order of
-- when they fire:
--
--   G1  SEED FROM auth.users. Section 5 copies EVERY existing auth user into public.staff as
--       role 'admin'. Not a hardcoded email — whoever can already log in keeps exactly the
--       access they have today. If there are zero users, it seeds zero rows and nothing breaks.
--   G2  NAMED OWNER. On top of G1, the email in settings.staff->>'owner_email' (default
--       john@gmail.com) is force-upserted to an active admin on every run. G1 uses
--       "on conflict do nothing" so a later demotion sticks; the owner row is the deliberate
--       exception, so re-running this file always restores the owner. If that account does not
--       exist, the statement matches no rows and is a no-op — no error, no failure.
--   G3  BOOTSTRAP FAIL-OPEN. public.staff_role() returns 'admin' to any signed-in user while the
--       staff table contains NO active admin at all. So even if G1 and G2 both failed (the SQL
--       editor role could not read auth.users, say), the next login is an admin and can fix it
--       from the portal. It self-closes the instant one admin row exists. It cannot be reached
--       by an anonymous visitor: no JWT subject, no role. And this database has no public
--       sign-up — the only way to hold an authenticated JWT is a user the owner created.
--   G4  LAST-ADMIN TRIGGER. Section 6 refuses any delete/demote/deactivate that would leave zero
--       active admins, so the failsafe in G3 stays theoretical after day one.
--
-- Two more things that keep the lights on:
--   · The server (server.js, api/*) uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS entirely.
--     Nothing here can break a customer booking, a webhook, or a cron sweep.
--   · Section 8 is a function, public.rbac_apply(). Every policy this migration writes is
--     (re)applied by calling it. Re-run it any time — after another migration, after a mistake.
--
-- ============================================================================
-- DESIGN DECISION: A staff TABLE, NOT JWT app_metadata
-- ============================================================================
-- The two options were a role claim baked into the JWT (auth.jwt()->'app_metadata'->>'role',
-- free to read inside a policy) versus a staff table RLS has to look up.
--
-- Cost of the table, measured honestly: a policy that calls public.staff_can('x') directly
-- evaluates it PER ROW. Wrapped as (select public.staff_can('x')) — which is how every policy
-- below is written — Postgres hoists it into an InitPlan and evaluates it ONCE PER STATEMENT.
-- The function is STABLE and hits one primary-key lookup on staff plus at most one on
-- role_permissions. Two index probes per query, on tables with a handful of rows that live in
-- shared_buffers permanently. On a tee sheet that reads a few hundred booking rows, that is not
-- measurable next to the round trip from the browser.
--
-- What the JWT would have cost instead:
--   · Revocation is delayed by the token lifetime. Fire an employee at 2pm and their access
--     card still opens the door for up to an hour, because their existing access token keeps
--     asserting the old role until it refreshes. For a venue whose staff handle refunds and
--     gift cards, "he can still issue himself a refund for the next 55 minutes" is not an
--     acceptable failure mode, and it is the exact scenario this feature exists for.
--   · Changing a role means calling the GoTrue admin API with the service-role key, so the
--     portal cannot do it in SQL, cannot do it transactionally, and cannot do it in the same
--     statement it writes the audit row.
--   · app_metadata is not a foreign key. Nothing joins it, nothing lists it, and "who has
--     access?" becomes a paginated admin-API call instead of `select * from staff`.
--   · Two sources of truth appear the moment anything else needs the role.
--
-- So: the table is the source of truth, read through a stable SECURITY DEFINER helper, called
-- from policies as a scalar subquery. If a slow query ever traces back to it, the mitigation is
-- a mirrored claim as a CACHE with the table still authoritative — not a rewrite.
--
-- ============================================================================
-- HOW A REQUEST IS CLASSIFIED
-- ============================================================================
--   request.jwt.claims unset      → not a PostgREST request at all: the SQL editor, psql,
--                                   pg_cron, this migration. Trusted; RBAC does not apply.
--   claims.role = 'service_role'  → the server's own key. Already bypasses RLS; treated as
--                                   trusted by the guard triggers too, which RLS cannot cover.
--   claims.role = 'authenticated' → a human in the portal. claims.sub is looked up in staff.
--   claims.role = 'anon'          → the key /api/config hands every visitor. No subject, no
--                                   role, no reads, no writes. Anywhere.

-- ============================================================================
-- 1) STAFF — who may sign in to the portal, and as what.
-- ============================================================================
-- One row per Supabase auth user. `email` and `name` are denormalised copies for display: the
-- portal holds an `authenticated` JWT and cannot read auth.users, so without them the staff
-- screen would be a list of UUIDs. api/* refreshes them through the admin API when it can.
create table if not exists public.staff (
  user_id    uuid primary key,
  email      text,
  name       text,
  role       text not null default 'employee',
  is_active  boolean not null default true,
  note       text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Added separately so the table still exists on a plain Postgres that has no GoTrue.
do $$
begin
  if to_regclass('auth.users') is not null
     and not exists (select 1 from pg_constraint
                      where conname = 'staff_user_fk' and conrelid = 'public.staff'::regclass) then
    alter table public.staff
      add constraint staff_user_fk foreign key (user_id) references auth.users (id) on delete cascade;
  end if;
exception when others then
  raise notice '0024: could not add the auth.users foreign key (%). The table works without it.', sqlerrm;
end $$;

alter table public.staff add column if not exists note text;
alter table public.staff add column if not exists created_by uuid;
alter table public.staff drop constraint if exists staff_role_check;
alter table public.staff add constraint staff_role_check check (role in ('admin','employee','readonly'));

create index if not exists staff_active_admins on public.staff (role) where is_active;
-- Deliberately NOT unique. user_id is the identity; email is a display copy that can go
-- stale (a deleted-and-recreated auth user is a new uuid with the same address), and a
-- unique index there would turn that into a migration that fails instead of a duplicate row.
create index if not exists staff_email_idx on public.staff (lower(email));

-- ============================================================================
-- 2) CAPABILITIES — the vocabulary the policies are written in.
-- ============================================================================
-- Six of them, chosen so that each one is a sentence the owner would actually say out loud, and
-- so that no policy ever has to name a role. Adding a seventh table to the system means picking
-- one of these, not inventing another.
create table if not exists public.capabilities (
  key         text primary key,
  label       text not null,
  description text,
  sort        smallint not null default 0
);

insert into public.capabilities (key, label, description, sort) values
  ('booking.write',  'Bookings',     'Create, move and cancel reservations, blocks, groups, leagues and the waiting list.', 0),
  ('customer.write', 'Customers',    'Edit customer records, contact details and marketing consent.',                       1),
  ('money.write',    'Money',        'Refunds, gift cards, promo codes, loyalty points and prepaid-hour balances, and the price on an existing booking.', 2),
  ('config.write',   'Setup',        'Rates, opening hours, bays, membership plans, hour packages and status labels.',      3),
  ('staff.manage',   'Staff',        'Add and remove staff logins and change what each role may do.',                       4),
  ('audit.read',     'Activity log', 'Read the record of who changed what.',                                                5)
on conflict (key) do update
  set label = excluded.label, description = excluded.description, sort = excluded.sort;

-- ============================================================================
-- 3) ROLE PERMISSIONS — the editable part.
-- ============================================================================
-- ADMIN IS DELIBERATELY NOT IN THIS TABLE. public.staff_can() returns true for an admin without
-- reading a row, so an admin can never lock themselves out by unticking a box, and a corrupted
-- or truncated permissions table cannot brick the portal. The screen should render admin as
-- "everything" and not let it be edited.
--
-- The defaults below are the venue's stated worry — refunds, price changes and customer data —
-- turned into rows. An employee books, moves and cancels play and keeps customer records
-- straight; they do not touch money or setup. If the owner decides counter staff should be able
-- to sell a gift card, that is one boolean in this table, not a code change.
create table if not exists public.role_permissions (
  role       text not null,
  capability text not null,
  allowed    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (role, capability)
);
alter table public.role_permissions drop constraint if exists role_permissions_role_check;
alter table public.role_permissions add constraint role_permissions_role_check check (role in ('employee','readonly'));

-- "do nothing", not "do update": once the owner has tuned these, re-running this file must not
-- silently hand an employee back a permission they were deliberately denied.
insert into public.role_permissions (role, capability, allowed) values
  ('employee', 'booking.write',  true),
  ('employee', 'customer.write', true),
  ('employee', 'money.write',    false),
  ('employee', 'config.write',   false),
  ('employee', 'staff.manage',   false),
  ('employee', 'audit.read',     false),
  ('readonly', 'booking.write',  false),
  ('readonly', 'customer.write', false),
  ('readonly', 'money.write',    false),
  ('readonly', 'config.write',   false),
  ('readonly', 'staff.manage',   false),
  ('readonly', 'audit.read',     false)
on conflict (role, capability) do nothing;

-- ============================================================================
-- 4) IDENTITY HELPERS.
-- ============================================================================
-- Everything below reads request.jwt.claims directly rather than auth.uid()/auth.jwt(), for two
-- reasons: it works on a database that has no GoTrue (setup.sql is run by hand elsewhere), and
-- current_setting(..., true) returns null instead of raising when the GUC is absent.
--
-- CRITICAL: these must never look at current_user. Inside a SECURITY DEFINER function
-- current_user is the function's owner, so a current_user test would hand every caller of
-- adjust_points() the owner's privileges — the exact hole section 9's triggers exist to close.

-- The subject of the calling JWT, or null when there isn't one.
create or replace function public.rbac_uid() returns uuid
language plpgsql stable as $fn$
declare v text;
begin
  v := nullif(current_setting('request.jwt.claims', true), '');
  if v is null then return null; end if;
  return nullif(v::jsonb ->> 'sub', '')::uuid;
exception when others then
  return null;
end $fn$;

-- True for the server's own service-role key, and for a direct database connection (SQL editor,
-- psql, pg_cron), which has no JWT at all and already has whatever the database granted it.
-- PostgREST always sets request.jwt.claims — an anon request carries the anon key, which is
-- itself a JWT with role='anon' — so "no claims" reliably means "not an API request".
create or replace function public.rbac_is_service() returns boolean
language plpgsql stable as $fn$
declare v text;
begin
  v := nullif(current_setting('request.jwt.claims', true), '');
  if v is null then return true; end if;
  return (v::jsonb ->> 'role') = 'service_role';
exception when others then
  return false;
end $fn$;

-- The signed-in human's role, or null if they are not staff. SECURITY DEFINER so that a policy
-- on `staff` itself does not have to be consulted to find out whether you may read `staff`
-- (that recursion is the classic way an RLS role system deadlocks on its own first query).
--
-- The bootstrap branch is guarantee G3 in the header. Read it before removing it.
create or replace function public.staff_role() returns text
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_uid uuid; v_role text;
begin
  v_uid := public.rbac_uid();
  if v_uid is null then return null; end if;

  select role into v_role from public.staff where user_id = v_uid and is_active;
  if v_role is not null then return v_role; end if;

  -- No active admin exists anywhere: this database has not been set up yet (or somebody has
  -- managed to remove them all). Anyone who can sign in is treated as the admin so the system
  -- can be repaired from the portal. Closes automatically the moment one admin row exists.
  if not exists (select 1 from public.staff where role = 'admin' and is_active) then
    return 'admin';
  end if;

  return null;
end $fn$;

-- The single question every write policy and every guard trigger asks.
create or replace function public.staff_can(p_capability text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_role text;
begin
  if public.rbac_is_service() then return true; end if;
  v_role := public.staff_role();
  if v_role is null then return false; end if;
  if v_role = 'admin' then return true; end if;   -- see section 3: never data-dependent
  return exists (
    select 1 from public.role_permissions
     where role = v_role and capability = p_capability and allowed);
end $fn$;

-- What the portal calls on load to decide which tabs and buttons to render. Returns a role of
-- null for anyone who is not staff, which is the signal to show "your account has no access".
create or replace function public.staff_whoami() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_uid uuid; v_role text; v_row public.staff; v_caps text[];
begin
  v_uid  := public.rbac_uid();
  v_role := public.staff_role();
  if v_role is null then
    return jsonb_build_object('user_id', v_uid, 'role', null, 'capabilities', '[]'::jsonb);
  end if;
  select * into v_row from public.staff where user_id = v_uid;
  if v_role = 'admin' then
    select array_agg(key order by sort) into v_caps from public.capabilities;
  else
    select array_agg(capability order by capability) into v_caps
      from public.role_permissions where role = v_role and allowed;
  end if;
  return jsonb_build_object(
    'user_id',      v_uid,
    'email',        v_row.email,
    'name',         v_row.name,
    'role',         v_role,
    'bootstrap',    (v_row.user_id is null),   -- true = admin only because nobody else is
    'capabilities', to_jsonb(coalesce(v_caps, '{}'::text[])));
end $fn$;

grant execute on function public.rbac_uid()               to authenticated;
grant execute on function public.rbac_is_service()        to authenticated;
grant execute on function public.staff_role()             to authenticated;
grant execute on function public.staff_can(text)          to authenticated;
grant execute on function public.staff_whoami()           to authenticated;

-- ============================================================================
-- 5) SEED — guarantees G1 and G2 from the header.
-- ============================================================================
-- Where the owner's address is configured. Change it here, not in the SQL:
--   update public.settings set staff = coalesce(staff,'{}'::jsonb) || '{"owner_email":"someone@example.com"}'::jsonb where id = 1;
alter table public.settings add column if not exists staff jsonb not null default '{}'::jsonb;

-- G1 — everyone who can already sign in keeps the access they have today.
-- "on conflict do nothing" so re-running this file never re-promotes somebody who was demoted
-- on purpose. Its own do-block: if this fails, G2 below must still get its chance.
do $$
declare n integer;
begin
  if to_regclass('auth.users') is null then
    raise notice '0024: no auth.users table here — skipping the seed. The bootstrap in staff_role() still applies.';
    return;
  end if;
  insert into public.staff (user_id, email, name, role, is_active, note)
  select u.id,
         u.email,
         nullif(coalesce(u.raw_user_meta_data ->> 'name', u.raw_user_meta_data ->> 'full_name'), ''),
         'admin',
         true,
         'seeded by migration 0024 — existing login, kept as admin'
    from auth.users u
  on conflict (user_id) do nothing;
  get diagnostics n = row_count;
  raise notice '0024: seeded % existing auth user(s) as admin.', n;
exception when others then
  raise notice '0024: could not seed from auth.users (%). Falls through to the bootstrap in staff_role().', sqlerrm;
end $$;

-- G2 — the named owner, force-restored on every run. A no-op if that account does not exist.
do $$
declare v_owner text; n integer;
begin
  if to_regclass('auth.users') is null then return; end if;
  select coalesce(nullif(s.staff ->> 'owner_email', ''), 'john@gmail.com') into v_owner
    from public.settings s where s.id = 1;
  v_owner := coalesce(v_owner, 'john@gmail.com');

  insert into public.staff (user_id, email, role, is_active, note)
  select u.id, u.email, 'admin', true, 'owner account — restored to admin by migration 0024'
    from auth.users u
   where lower(u.email) = lower(v_owner)
  on conflict (user_id) do update
    set role = 'admin', is_active = true, email = excluded.email, updated_at = now();
  get diagnostics n = row_count;
  if n = 0 then
    raise notice '0024: owner % has no auth user yet — nothing to restore. Anyone who signs in while there are no admins gets admin (G3).', v_owner;
  else
    raise notice '0024: owner % confirmed as an active admin.', v_owner;
  end if;
exception when others then
  raise notice '0024: could not confirm the owner row (%). Falls through to the bootstrap in staff_role().', sqlerrm;
end $$;

-- ============================================================================
-- 6) LAST-ADMIN TRIGGER — guarantee G4.
-- ============================================================================
-- Deleting, demoting or deactivating the final active admin is refused. It fires for the
-- service-role key and the SQL editor too, on purpose: this is not an authorisation check, it is
-- a structural rule about the database, and "I did it from the server" is not a reason to allow
-- it. Drop the trigger for one statement if you genuinely mean to empty the table.
create or replace function public.staff_keep_one_admin() returns trigger
language plpgsql as $fn$
begin
  if old.role <> 'admin' or not old.is_active then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' and new.role = 'admin' and new.is_active then
    return new;
  end if;
  if not exists (select 1 from public.staff
                  where role = 'admin' and is_active and user_id <> old.user_id) then
    raise exception 'refusing to remove the last active admin (%) — promote someone else first',
      coalesce(old.email, old.user_id::text) using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $fn$;

drop trigger if exists staff_keep_one_admin on public.staff;
create trigger staff_keep_one_admin
  before update or delete on public.staff
  for each row execute function public.staff_keep_one_admin();

-- Keep updated_at honest without asking the caller to remember.
create or replace function public.staff_touch() returns trigger
language plpgsql as $fn$
begin
  new.updated_at := now();
  return new;
end $fn$;
drop trigger if exists staff_touch on public.staff;
create trigger staff_touch before update on public.staff
  for each row execute function public.staff_touch();

-- ============================================================================
-- 7) AUDIT LOG — who changed what.
-- ============================================================================
-- One row per consequential write, captured by a trigger rather than by application code, so it
-- records the change whoever made it: the portal, the server's service-role key, a cron job, or
-- somebody typing into the SQL editor. Application code cannot forget to call it.
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,          -- the JWT subject, null for server / SQL-editor writes
  actor_email text,
  actor_role  text,          -- admin | employee | readonly | service | none
  action      text not null, -- insert | update | delete
  table_name  text not null,
  row_id      text,
  changed     jsonb,         -- update only: { column: [before, after] }
  row_before  jsonb,
  row_after   jsonb,
  note        text,          -- set by lib/db.js recordAudit() for things no trigger can see
  source      text not null default 'trigger'
);
create index if not exists audit_log_at    on public.audit_log (at desc);
create index if not exists audit_log_table on public.audit_log (table_name, at desc);
create index if not exists audit_log_actor on public.audit_log (actor_id, at desc);

-- Table-level grants for the four tables this migration creates. Supabase's default privileges
-- normally cover new tables in `public`, but RLS is only the second gate — if PostgREST's
-- `authenticated` role has no GRANT, the portal gets "permission denied for table staff" no
-- matter how permissive the policy is. Stating them removes that failure mode. `anon` gets
-- nothing here, ever: /api/config hands that key to every visitor of the site.
grant select                         on public.audit_log        to authenticated;
grant select, insert, update, delete on public.staff            to authenticated;
grant select, insert, update, delete on public.role_permissions to authenticated;
grant select, insert, update, delete on public.capabilities     to authenticated;
revoke all on public.audit_log, public.staff, public.role_permissions, public.capabilities from anon;

-- Values never worth keeping a copy of: tokens, hashes and secrets. Redacted from both
-- snapshots, so restoring the audit log to a laptop cannot leak a claim token or a card hash.
create or replace function public.audit_redact(p jsonb) returns jsonb
language sql immutable as $fn$
  select case when p is null then null else
    (select coalesce(jsonb_object_agg(k, case when k ~* '(token|secret|hash|password)' then '"[redacted]"'::jsonb else p -> k end), '{}'::jsonb)
       from jsonb_object_keys(p) k)
  end
$fn$;

create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_before jsonb; v_after jsonb; v_changed jsonb;
  v_uid uuid; v_email text; v_role text; v_claims jsonb; v_id text;
begin
  if tg_op <> 'INSERT' then v_before := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_after  := to_jsonb(new); end if;

  -- Cart holds are created and deleted for every visitor who clicks a time slot. Logging them
  -- would bury real changes under machine noise. The transition that matters — a hold becoming
  -- a real booking — is an UPDATE away from 'held' and is still recorded.
  if tg_table_name = 'bookings' then
    if tg_op = 'INSERT' and v_after ->> 'status' = 'held' then return new; end if;
    if tg_op = 'DELETE' and v_before ->> 'status' = 'held' then return old; end if;
    if tg_op = 'UPDATE' and v_before ->> 'status' = 'held' and v_after ->> 'status' = 'held' then return new; end if;
  end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(k, jsonb_build_array(v_before -> k, v_after -> k))
      into v_changed
      from jsonb_object_keys(v_after) k
     where v_before -> k is distinct from v_after -> k
       and k not in ('updated_at');
    -- A write that changed nothing (or only a timestamp) is not an event.
    if v_changed is null then return new; end if;
  end if;

  v_claims := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  v_uid    := public.rbac_uid();
  v_email  := nullif(v_claims ->> 'email', '');
  if v_uid is null then
    v_role := case coalesce(v_claims ->> 'role', '')
                when ''             then 'sql'      -- SQL editor, psql, pg_cron: no JWT at all
                when 'service_role' then 'service'  -- the app's own key
                else v_claims ->> 'role' end;
  else
    v_role := coalesce(public.staff_role(), 'none');
    if v_email is null then select email into v_email from public.staff where user_id = v_uid; end if;
  end if;

  v_id := coalesce(v_after ->> 'id', v_before ->> 'id', v_after ->> 'user_id', v_before ->> 'user_id',
                   v_after ->> 'key',  v_before ->> 'key');

  insert into public.audit_log (actor_id, actor_email, actor_role, action, table_name, row_id,
                                changed, row_before, row_after, source)
  values (v_uid, v_email, v_role, lower(tg_op), tg_table_name, v_id,
          public.audit_redact(v_changed), public.audit_redact(v_before), public.audit_redact(v_after), 'trigger');

  return case when tg_op = 'DELETE' then old else new end;
exception when others then
  -- An audit failure must never be able to stop a customer from booking. Complain loudly in the
  -- Postgres log and let the business write through.
  raise warning 'audit_log: could not record % on % (%)', tg_op, tg_table_name, sqlerrm;
  return case when tg_op = 'DELETE' then old else new end;
end $fn$;

-- ============================================================================
-- 8) GUARD TRIGGERS — the part RLS cannot do.
-- ============================================================================
-- adjust_points(), adjust_hours() and adjust_gift_card() become SECURITY DEFINER in section 9.
-- That is the right call — the ledgers must only ever be written through the function that keeps
-- the balance and the ledger row in step, so a caller needs no direct write access to them — but
-- SECURITY DEFINER means the function runs as its owner and RLS on those tables no longer
-- applies to it. Without something else in the way, `select adjust_points(...)` would become a
-- hole any signed-in employee could walk through.
--
-- Triggers are that something else. They fire inside a SECURITY DEFINER function, and
-- request.jwt.claims is a per-request setting that SECURITY DEFINER does not change, so the
-- guard still sees the real caller. Raising here aborts the transaction, which rolls back the
-- balance update the ledger insert was paired with — the two can never come apart.
--
-- All of them return true for the service-role key, so every server path (webhooks, checkout,
-- cron sweeps) is untouched.

-- Whole-table: touching this at all requires the "money" permission.
create or replace function public.rbac_guard_money() returns trigger
language plpgsql as $fn$
begin
  if not public.staff_can('money.write') then
    raise exception 'permission denied: changing % requires the "money" permission', tg_table_name
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $fn$;

-- Column-level: the rest of the row is fair game, these columns are not. Reads the columns out
-- of to_jsonb() rather than naming them, so the trigger is safe to attach to a table whose
-- migration for that column has not been applied yet.
create or replace function public.rbac_guard_money_columns() returns trigger
language plpgsql as $fn$
declare b_old jsonb; b_new jsonb; c text;
begin
  b_old := to_jsonb(old); b_new := to_jsonb(new);
  foreach c in array tg_argv loop
    if b_old -> c is distinct from b_new -> c then
      if not public.staff_can('money.write') then
        raise exception 'permission denied: changing %.% requires the "money" permission', tg_table_name, c
          using errcode = '42501';
      end if;
      return new;
    end if;
  end loop;
  return new;
end $fn$;

-- ============================================================================
-- 9) rbac_apply() — every policy, trigger and function attribute, in one re-runnable place.
-- ============================================================================
-- WHY THIS IS A FUNCTION AND NOT JUST A LIST OF STATEMENTS
--
--   · Migrations 0022 and 0023 are written but not yet applied here, and they create their
--     tables with the old "for all to authenticated using (true)" policies. Whichever order the
--     files are run in, the last word has to be this one. Apply 0022/0023, then run
--        select public.rbac_apply();
--     and the new tables are covered. It skips tables that do not exist yet and says so.
--   · Any future migration that re-creates a policy or does `create or replace function
--     adjust_points(...)` (which silently resets a function back to SECURITY INVOKER) re-opens
--     what this file closed. One call puts it back.
--
-- Run `select public.rbac_apply();` after ANY migration that touches these tables.
create or replace function public.rbac_apply() returns text
language plpgsql as $fn$
declare
  r record;
  applied text[] := '{}';
  absent  text[] := '{}';
  hardened text[] := '{}';
begin
  -- 9a) One write capability per table. Reads are open to any staff member — including
  --     read-only, which is the entire point of that role — and closed to everyone else.
  for r in
    select * from (values
      -- setup: the rate card, the calendar, the plans. The most expensive mistakes live here.
      ('settings',                  'config.write'),
      ('memberships',               'config.write'),
      ('price_templates',           'config.write'),
      ('hour_cards',                'config.write'),
      ('bay_categories',            'config.write'),
      ('schedule_overrides',        'config.write'),
      ('schedule_templates',        'config.write'),
      ('booking_statuses',          'config.write'),
      -- the tee sheet and everything that puts play on it
      ('bookings',                  'booking.write'),
      ('tags',                      'booking.write'),
      ('notifications',             'booking.write'),
      ('waitlist_entries',          'booking.write'),   -- migration 0022
      ('waitlist_offers',           'booking.write'),   -- migration 0022
      ('booking_series',            'booking.write'),   -- migration 0023
      ('booking_groups',            'booking.write'),   -- migration 0023
      ('booking_series_exceptions', 'booking.write'),   -- migration 0023
      -- customer records
      ('customers',                 'customer.write'),
      -- stored value and anything that gives money back
      ('gift_cards',                'money.write'),
      ('gift_card_transactions',    'money.write'),
      ('gift_card_reservations',    'money.write'),
      ('promos',                    'money.write'),
      ('promo_redemptions',         'money.write'),
      ('hour_transactions',         'money.write'),
      ('point_transactions',        'money.write'),
      ('refunds',                   'money.write'),     -- migration 0023
      -- the role system itself
      ('staff',                     'staff.manage'),
      ('role_permissions',          'staff.manage'),
      ('capabilities',              'staff.manage')
    ) as m(tbl, cap)
  loop
    if to_regclass('public.' || quote_ident(r.tbl)) is null then
      absent := absent || r.tbl; continue;
    end if;
    execute format('alter table public.%I enable row level security', r.tbl);
    -- Every policy name any migration in this repo has used on these tables.
    execute format('drop policy if exists %I on public.%I', r.tbl || '_read',  r.tbl);
    execute format('drop policy if exists %I on public.%I', r.tbl || '_write', r.tbl);
    execute format('drop policy if exists %I on public.%I', r.tbl || '_admin', r.tbl);
    -- (select ...) so the planner evaluates the check once per statement, not once per row.
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select public.staff_role()) is not null)',
      r.tbl || '_read', r.tbl);
    execute format(
      'create policy %I on public.%I for all to authenticated using ((select public.staff_can(%L))) with check ((select public.staff_can(%L)))',
      r.tbl || '_write', r.tbl, r.cap, r.cap);
    applied := applied || r.tbl;
  end loop;

  -- 9b) Server-only bookkeeping: RLS on with NO policies denies anon and authenticated
  --     everything, while the service-role key (which bypasses RLS) keeps working. Note this
  --     also removes the write policy migration 0018 gave stripe_events — a signed-in user
  --     being able to delete webhook idempotency records was never intended.
  for r in select unnest(array['stripe_events','gift_card_attempts','promo_attempts','waitlist_wakeups']) as tbl loop
    if to_regclass('public.' || quote_ident(r.tbl)) is null then absent := absent || r.tbl; continue; end if;
    execute format('alter table public.%I enable row level security', r.tbl);
    execute format('drop policy if exists %I on public.%I', r.tbl || '_read',  r.tbl);
    execute format('drop policy if exists %I on public.%I', r.tbl || '_write', r.tbl);
    execute format('drop policy if exists %I on public.%I', r.tbl || '_admin', r.tbl);
    applied := applied || (r.tbl || '(server-only)');
  end loop;

  -- 9c) The audit log is readable by whoever holds audit.read (admins, by default) and writable
  --     by nobody: the trigger in section 7 is SECURITY DEFINER and inserts as the table owner.
  --     Nothing in the portal may edit or delete history.
  alter table public.audit_log enable row level security;
  drop policy if exists audit_log_read  on public.audit_log;
  drop policy if exists audit_log_write on public.audit_log;
  create policy audit_log_read on public.audit_log
    for select to authenticated using ((select public.staff_can('audit.read')));

  -- 9d) Audit triggers. Ledgers, outboxes and attempt counters are left out: they are already
  --     append-only records of themselves, and mirroring them would double the write volume for
  --     no new information.
  for r in select unnest(array[
      'bookings','customers','settings','memberships','price_templates','hour_cards',
      'bay_categories','schedule_overrides','schedule_templates','booking_statuses','tags',
      'gift_cards','promos','refunds','booking_groups','booking_series',
      'staff','role_permissions']) as tbl
  loop
    if to_regclass('public.' || quote_ident(r.tbl)) is null then continue; end if;
    execute format('drop trigger if exists %I on public.%I', 'audit_' || r.tbl, r.tbl);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_row()',
                   'audit_' || r.tbl, r.tbl);
  end loop;

  -- 9e) Money guards (section 8). Whole-table on the ledgers and the card balances…
  for r in select unnest(array['point_transactions','hour_transactions','gift_card_transactions','gift_cards']) as tbl loop
    if to_regclass('public.' || quote_ident(r.tbl)) is null then continue; end if;
    execute format('drop trigger if exists %I on public.%I', 'rbac_money_' || r.tbl, r.tbl);
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function public.rbac_guard_money()',
                   'rbac_money_' || r.tbl, r.tbl);
  end loop;

  -- …and column-level where the rest of the row is an employee's job. An employee may edit a
  -- customer and may move or cancel a booking; they may not silently rewrite what it cost.
  if to_regclass('public.customers') is not null then
    drop trigger if exists rbac_money_customers on public.customers;
    create trigger rbac_money_customers before update on public.customers
      for each row execute function public.rbac_guard_money_columns('points_balance', 'hours_balance_min');
  end if;
  if to_regclass('public.bookings') is not null then
    drop trigger if exists rbac_money_bookings on public.bookings;
    create trigger rbac_money_bookings before update on public.bookings
      for each row execute function public.rbac_guard_money_columns('amount_cents', 'refunded_cents');
    -- refunded_cents belongs here too: without it an employee with no money.write could mark any
    -- booking fully refunded, corrupting the refund ledger and the dashboard's revenue figures.
  end if;

  -- 9f) The adjust_* functions. SECURITY DEFINER so the ledgers need no direct write grant, plus
  --     a pinned search_path so the definer's privileges cannot be aimed at a shadowed table.
  --     Authorisation for them is the trigger in 9e, which SECURITY DEFINER cannot bypass.
  --     ALTER rather than a re-created body: one definition of adjust_points() in this repo,
  --     still the one in migration 0016.
  for r in select unnest(array[
      'public.adjust_points(uuid,integer,text,text,uuid,text)',
      'public.adjust_hours(uuid,integer,text,text,uuid,text)',
      'public.adjust_gift_card(uuid,integer,text,text,uuid,text)']) as sig
  loop
    if to_regprocedure(r.sig) is null then absent := absent || r.sig; continue; end if;
    begin
      execute format('alter function %s security definer', r.sig);
      execute format('alter function %s set search_path = public, pg_temp', r.sig);
      hardened := hardened || r.sig;
    exception when others then
      raise notice '0024: could not harden % (%). Run this as the function owner.', r.sig, sqlerrm;
    end;
  end loop;

  return format('rbac_apply: %s table(s) covered; %s function(s) hardened; not present yet (re-run after those migrations): %s',
                cardinality(applied), cardinality(hardened),
                case when cardinality(absent) = 0 then 'none' else array_to_string(absent, ', ') end);
end $fn$;

select public.rbac_apply();

-- ============================================================================
-- 10) AFTER RUNNING THIS
-- ============================================================================
--   select public.staff_whoami();                    -- as the signed-in manager: role 'admin'
--   select * from public.staff;                      -- who has access
--   select * from public.audit_log order by at desc; -- what has changed since
--
-- Add an employee: create the login in Supabase → Authentication → Users, then
--   insert into public.staff (user_id, email, name, role)
--   values ('<uuid from that screen>', 'someone@example.com', 'Their Name', 'employee');
-- (or use the Staff tab in the manager portal, which does the same thing through the server).
--
-- Let counter staff sell gift cards after all:
--   update public.role_permissions set allowed = true where role = 'employee' and capability = 'money.write';

