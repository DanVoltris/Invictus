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
