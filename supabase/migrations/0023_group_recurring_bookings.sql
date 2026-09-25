-- Invictus Golf — group + recurring bookings, and the minimum refunds ledger they need.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHY ONE MIGRATION FOR TWO FEATURES
-- The build plan noticed that `booking_groups.series_id` (proposed by the group-booking research)
-- and `booking_series` (proposed by the recurring-booking research) are the same concept invented
-- twice. They are: a GROUP is "N bays at one moment", a SERIES is "that moment, repeated". Modelled
-- separately you get two ways to write several booking rows at once, two conflict stories and two
-- cancellation stories. Modelled together there is one table for the definition, one table per
-- occurrence, and — the part that actually matters — ONE function that writes booking rows in bulk.
--
--   booking_series   the definition: which bays, what time, how often, until when.
--                    A one-off group is a series with freq = 'once'. No special case.
--   booking_groups   one occurrence of that definition. Always exists, even for a single bay,
--                    so "cancel the Tuesday" and "refund two of the six bays" have one shape.
--   bookings         unchanged, plus group_id / series_id so the tee sheet can draw the rail.
--
-- THE ATOMICITY RULE, which is the whole point of book_group() below.
-- `bookings_no_overlap` is a gist EXCLUDE constraint: overlapping non-cancelled rows in the same
-- bay on the same day are physically impossible. So reserving six bays is six inserts any one of
-- which can fail, and a partial failure would leave a customer holding four bays of a six-bay
-- event and no record of what went wrong. The research reports proposed relying on PostgREST
-- sending `insert([...N rows])` as a single statement. Measured against this database that is
-- true today — a three-row insert whose third row collided left the other two out — but it is an
-- implementation detail of PostgREST's request handling, not a contract it publishes, and the
-- same reports reached the opposite conclusion (use plpgsql) for confirmation. So: every multi-row
-- booking write in this system goes through public.book_group(), which
--   (a) takes its rollback from PL/pgSQL's implicit savepoint — the whole function's work is
--       undone by the BEGIN … EXCEPTION block, so a conflict on the last bay leaves NO rows, and
--   (b) inserts IN bay_id ORDER, so two concurrent groups overlapping on two bays always take
--       their locks in the same sequence and deadlock-by-lock-ordering is structural rather than
--       a convention someone has to remember at every call site.
--
-- MATERIALISE-AHEAD, NOT GENERATE-ON-READ — see the note above booking_series.materialised_through.

-- 1) BOOKING_SERIES — the definition. -----------------------------------------------------
--
-- MATERIALISE-AHEAD. Every occurrence of a series is written into `bookings` up to a rolling
-- horizon, rather than being computed when someone looks at a calendar. Three reasons, in order
-- of how much they cost to get wrong:
--
--   1. The exclusion constraint is this system's only source of truth about whether a bay is free,
--      and a virtual occurrence cannot participate in it. A league that exists only as a rule in
--      this table would be sold out from under itself by the next walk-in, and nobody would find
--      out until somebody arrived.
--   2. Four separate readers already answer "is this slot busy?" from the `bookings` table —
--      /api/availability, the manager tee sheet, waitlist_booking_freed() in 0022, and the cart
--      hold path. Generate-on-read means teaching every one of them recurrence arithmetic: a
--      second availability implementation, which is exactly the fork this codebase keeps avoiding.
--   3. Pricing. quoteBooking() in lib/booking.js is the single pricing waterfall and it lives in
--      JavaScript. An occurrence that materialises inside the database would have to be priced
--      inside the database, forking it. Instead the horizon job runs in the API: it asks
--      booking_series_occurrences() which dates are still owed, prices each one through
--      quoteBooking(), and calls book_group() per occurrence.
--
-- The cost is a horizon to maintain, which is one scheduled call — and the plan already adopts
-- pg_cron globally for the waitlist sweep and hold cleanup, so the machinery is there.
create table if not exists public.booking_series (
  id                uuid primary key default gen_random_uuid(),
  label             text,                                   -- "Thursday night league", "Acme Corp"
  freq              text not null default 'once'
                      check (freq in ('once','daily','weekly','monthly','annual')),
  interval_n        smallint not null default 1 check (interval_n between 1 and 52),
  start_date        date not null,
  until_date        date,                                   -- inclusive; null = bounded by max_occurrences
  max_occurrences   smallint check (max_occurrences is null or max_occurrences between 1 and 520),
  bay_ids           text[] not null check (array_length(bay_ids, 1) >= 1),
  start_min         smallint not null check (start_min >= 0 and start_min < 1440),
  end_min           smallint not null check (end_min > 0 and end_min <= 1440),
  players           smallint,
  customer_id       uuid references public.customers(id) on delete set null,
  customer_name     text,
  customer_email    text,
  customer_phone    text,
  status_label      text,                                   -- workflow status stamped on each row
  source            text not null default 'manager',        -- online | manager
  note              text,
  status            text not null default 'active'
                      check (status in ('active','ended','cancelled')),
  -- How the money is collected. 'per_occurrence' is the honest default and the only one the API
  -- implements today: each occurrence carries its own price and is settled on its own. 'prepaid'
  -- (one payment for a whole season) is recorded here but deliberately NOT implemented — the build
  -- plan flags that it recreates the partial-refund problem the same research used to reject
  -- Stripe subscriptions, and that is a business decision, not an implementation detail.
  pay_mode          text not null default 'per_occurrence'
                      check (pay_mode in ('per_occurrence','prepaid','invoice')),
  -- The horizon: occurrences are written up to and including this date. Advanced by the API's
  -- materialise pass; null means nothing has been written yet.
  materialised_through date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint booking_series_times check (end_min > start_min),
  constraint booking_series_bounded check (freq = 'once' or until_date is not null or max_occurrences is not null)
);
create index if not exists booking_series_open on public.booking_series (status, materialised_through)
  where status = 'active';

-- 2) BOOKING_GROUPS — one occurrence. -----------------------------------------------------
--
-- TWO DATES, ON PURPOSE. `occurrence_date` is which slot of the recurrence this row IS — its
-- identity inside the series, unique per series, and it never changes. `booking_date` is where the
-- bookings actually sit. They are equal until somebody moves one week's league night to the Friday,
-- and keeping them apart is what stops the next horizon pass from cheerfully re-creating the
-- Thursday it was moved off. Same trick for `status = 'cancelled'`: the row stays, so the date
-- stays claimed, so a cancelled occurrence is never silently resurrected.
create table if not exists public.booking_groups (
  id                    uuid primary key default gen_random_uuid(),
  series_id             uuid not null references public.booking_series(id) on delete cascade,
  occurrence_date       date not null,                      -- recurrence identity — never moves
  seq                   integer not null default 1,         -- 1-based occurrence number
  booking_date          date not null,                      -- where the rows actually are
  start_min             smallint not null,
  end_min               smallint not null,
  status                text not null default 'confirmed'
                          check (status in ('confirmed','held','partial','cancelled')),
  bay_count             smallint not null default 0,
  players               smallint,
  list_price_cents      integer not null default 0,         -- before any discount
  amount_cents          integer not null default 0,         -- what this occurrence was charged
  refunded_cents        integer not null default 0,
  stripe_payment_intent text,
  note                  text,
  moved_at              timestamptz,
  created_at            timestamptz not null default now(),
  cancelled_at          timestamptz
);
create unique index if not exists booking_groups_occurrence
  on public.booking_groups (series_id, occurrence_date);
create index if not exists booking_groups_date on public.booking_groups (booking_date);

-- 3) BOOKING_SERIES_EXCEPTIONS — the "never silently drop an occurrence" table. ------------
--
-- A recurrence that lands on an already-booked bay is NOT dropped and NOT quietly moved. It is
-- recorded here with kind = 'skipped' and a reason, and the date is thereafter treated as spoken
-- for so the next horizon pass does not retry it behind the operator's back. The manager portal
-- reads this table to show "3 of 12 Thursdays could not be booked — here is which bay was taken".
--
-- kind:  skipped   the occurrence could not be created (reason says why: conflict, closed, past)
--        cancelled the customer or the venue called this one off (the group row carries the money)
--        moved     this occurrence sits somewhere other than its recurrence date
create table if not exists public.booking_series_exceptions (
  id              uuid primary key default gen_random_uuid(),
  series_id       uuid not null references public.booking_series(id) on delete cascade,
  occurrence_date date not null,
  kind            text not null check (kind in ('skipped','cancelled','moved')),
  reason          text,                                     -- conflict | closed | past | customer | manager
  detail          jsonb not null default '{}'::jsonb,       -- e.g. { "bays": ["B3"], "conflictIds": [...] }
  created_at      timestamptz not null default now()
);
create unique index if not exists booking_series_exceptions_uniq
  on public.booking_series_exceptions (series_id, occurrence_date);

-- 4) BOOKINGS — the two links, and the refund counter. ------------------------------------
alter table public.bookings add column if not exists group_id  uuid references public.booking_groups(id) on delete set null;
alter table public.bookings add column if not exists series_id uuid references public.booking_series(id) on delete set null;
alter table public.bookings add column if not exists refunded_cents integer not null default 0;
create index if not exists bookings_group  on public.bookings (group_id)  where group_id  is not null;
create index if not exists bookings_series on public.bookings (series_id) where series_id is not null;

-- 5) REFUNDS — the MINIMUM ledger, and a loud flag about what it is not. -------------------
--
-- ⚠ READ THIS BEFORE TRUSTING THIS TABLE. Partial cancellation of a group ("two of the six bays
-- fell through") is meaningless without somewhere to record money going back, and the build plan
-- sequences refunds as its own deliverable (#6) that has not been built. This is the minimum that
-- makes group cancellation honest, and NOTHING MORE:
--
--   · It RECORDS an obligation. It does NOT move money. No Stripe call is made from here or from
--     api/booking-series.js. A row with method = 'stripe', status = 'pending' means "somebody owes
--     this customer this much and nobody has paid it yet".
--   · .env.example steers the operator toward a restricted Stripe key scoped to Checkout Sessions,
--     which will reject POST /v1/refunds with a permissions error that reads exactly like a code
--     bug. The refunds deliverable has to grant `Refunds: write` + `Charges: read` first.
--   · There is no reversal path for stored value either: points spent on a cancelled occurrence
--     are not returned by this table, and a gift card debited for it is not credited back. Those
--     need adjust_points() / adjust_gift_card() calls that belong with the real feature.
--
-- What it does give you: an idempotent, auditable list of what is owed, and refunded_cents kept in
-- step on both the booking and the group so nothing can be refunded twice or beyond what was paid.
create table if not exists public.refunds (
  id                    uuid primary key default gen_random_uuid(),
  booking_id            uuid references public.bookings(id) on delete set null,
  group_id              uuid references public.booking_groups(id) on delete set null,
  amount_cents          integer not null check (amount_cents > 0),
  currency              text not null default 'cad',
  reason                text,
  method                text not null default 'stripe'
                          check (method in ('stripe','gift_card','points','hours','manual','none')),
  status                text not null default 'pending'
                          check (status in ('pending','succeeded','failed','cancelled')),
  stripe_payment_intent text,
  stripe_refund_id      text,
  ref                   text,                               -- idempotency key from the caller
  note                  text,
  created_by            text,
  created_at            timestamptz not null default now(),
  settled_at            timestamptz
);
-- Idempotency is per booking, not global — the gift-card research was right that a global (ref)
-- index blocks a second row legitimately keyed to the same PaymentIntent, and a six-bay group
-- refunded bay by bay is exactly that case.
create unique index if not exists refunds_booking_ref on public.refunds (booking_id, ref)
  where ref is not null and booking_id is not null;
-- A refund attached to the occurrence rather than to one of its bays still has to be idempotent.
create unique index if not exists refunds_group_ref on public.refunds (group_id, ref)
  where ref is not null and booking_id is null and group_id is not null;
create index if not exists refunds_group on public.refunds (group_id) where group_id is not null;

-- 6) RLS — same class as bookings: manager-only, nothing for anon. -------------------------
alter table public.booking_series            enable row level security;
alter table public.booking_groups            enable row level security;
alter table public.booking_series_exceptions enable row level security;
alter table public.refunds                   enable row level security;

drop policy if exists booking_series_read  on public.booking_series;
create policy booking_series_read  on public.booking_series  for select to authenticated using (true);
drop policy if exists booking_series_write on public.booking_series;
create policy booking_series_write on public.booking_series  for all to authenticated using (true) with check (true);

drop policy if exists booking_groups_read  on public.booking_groups;
create policy booking_groups_read  on public.booking_groups  for select to authenticated using (true);
drop policy if exists booking_groups_write on public.booking_groups;
create policy booking_groups_write on public.booking_groups  for all to authenticated using (true) with check (true);

drop policy if exists booking_series_exceptions_read  on public.booking_series_exceptions;
create policy booking_series_exceptions_read  on public.booking_series_exceptions for select to authenticated using (true);
drop policy if exists booking_series_exceptions_write on public.booking_series_exceptions;
create policy booking_series_exceptions_write on public.booking_series_exceptions for all to authenticated using (true) with check (true);

drop policy if exists refunds_read  on public.refunds;
create policy refunds_read  on public.refunds for select to authenticated using (true);
drop policy if exists refunds_write on public.refunds;
create policy refunds_write on public.refunds for all to authenticated using (true) with check (true);

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- 7) group_conflicts — read-only "which of these bays is already taken?". ------------------
--
-- book_group() below is safe without this: the exclusion constraint catches everything. But the
-- constraint reports the FIRST collision and then the transaction is over, so an operator holding
-- a six-bay corporate booking would be told about one bay at a time, six round trips. This answers
-- the whole question at once. It is advisory only — never the guard.
create or replace function public.group_conflicts(
  p_date date, p_bays text[], p_start integer, p_end integer, p_ignore_group uuid default null)
returns table (bay_id text, booking_id uuid, start_min integer, end_min integer, status text)
language sql stable as $$
  select b.bay_id, b.id, b.start_min::integer, b.end_min::integer, b.status
    from public.bookings b
   where b.booking_date = p_date
     and b.bay_id = any (p_bays)
     and b.status <> 'cancelled'
     and b.start_min < p_end and b.end_min > p_start
     and (p_ignore_group is null or b.group_id is distinct from p_ignore_group)
     and (b.status <> 'held' or (b.expires_at is not null and b.expires_at > now()))
   order by b.bay_id;
$$;

-- 8) book_group — THE ONLY MULTI-ROW BOOKING WRITE IN THE SYSTEM. -------------------------
--
-- Writes one booking_groups row plus one bookings row per bay, all of it or none of it.
--
-- HOW THE ALL-OR-NOTHING WORKS, precisely, because it is easy to believe and hard to see:
-- a PL/pgSQL block with an EXCEPTION clause is wrapped in an implicit subtransaction. When the
-- exclusion constraint fires on the fifth bay, control jumps to the handler and everything the
-- block did — the group row and the four bookings already inserted — is rolled back to the
-- savepoint taken when the block was entered. The handler then RETURNS a value instead of
-- re-raising, so the caller gets `{"conflict": true, "bay": "B5"}` and a clean database rather
-- than an error and a mess. Verify it, do not take my word for it: scripts/verify-group-series.mjs
-- forces a collision on exactly one bay of five and asserts the bookings table is untouched.
--
-- THE ORDER BY IS LOAD-BEARING. Rows are inserted in bay_id order, always. Two operators booking
-- overlapping sets of bays therefore acquire their locks in the same sequence and one waits for
-- the other instead of the pair deadlocking. Because every bulk write in the system comes through
-- this one function, that ordering is a property of the schema, not a rule call sites must follow.
--
-- p_group jsonb: series_id, occurrence_date, booking_date, seq, status, players, list_price_cents,
--                amount_cents, stripe_payment_intent, note
-- p_rows  jsonb: [ { bay_id, start_min, end_min, status, status_label, customer_name,
--                    customer_email, customer_phone, amount_cents, list_price_cents,
--                    stripe_payment_intent, source, note, expires_at }, … ]
--                Prices come in already computed — quoteBooking() in lib/booking.js is the one
--                pricing waterfall and it does not live here.
-- returns jsonb: { ok, groupId, bays } | { conflict, bay } | { error }
create or replace function public.book_group(p_group jsonb, p_rows jsonb)
returns jsonb language plpgsql as $$
declare
  g_id  uuid;
  r     record;
  v_bay text;
  n     integer := 0;
  g_date date := (p_group->>'booking_date')::date;
  o_date date := coalesce((p_group->>'occurrence_date')::date, (p_group->>'booking_date')::date);
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('error', 'no_rows');
  end if;

  insert into public.booking_groups (
      series_id, occurrence_date, seq, booking_date, start_min, end_min, status, bay_count,
      players, list_price_cents, amount_cents, stripe_payment_intent, note)
    values (
      (p_group->>'series_id')::uuid, o_date,
      coalesce(nullif(p_group->>'seq', '')::integer, 1), g_date,
      (p_group->>'start_min')::smallint, (p_group->>'end_min')::smallint,
      coalesce(p_group->>'status', 'confirmed'), jsonb_array_length(p_rows),
      nullif(p_group->>'players', '')::smallint,
      coalesce(nullif(p_group->>'list_price_cents', '')::integer, 0),
      coalesce(nullif(p_group->>'amount_cents', '')::integer, 0),
      nullif(p_group->>'stripe_payment_intent', ''), nullif(p_group->>'note', ''))
    returning id into g_id;

  -- ORDER BY bay_id: the deadlock ordering, structurally.
  for r in
    select e.value as v from jsonb_array_elements(p_rows) e order by e.value->>'bay_id'
  loop
    v_bay := r.v->>'bay_id';
    insert into public.bookings (
        bay_id, booking_date, start_min, end_min, status, status_label,
        customer_name, customer_email, customer_phone,
        amount_cents, stripe_payment_intent, source, note, expires_at, group_id, series_id)
      values (
        v_bay, g_date,
        (r.v->>'start_min')::smallint, (r.v->>'end_min')::smallint,
        coalesce(r.v->>'status', 'confirmed'), nullif(r.v->>'status_label', ''),
        nullif(r.v->>'customer_name', ''), nullif(r.v->>'customer_email', ''), nullif(r.v->>'customer_phone', ''),
        nullif(r.v->>'amount_cents', '')::integer, nullif(r.v->>'stripe_payment_intent', ''),
        coalesce(r.v->>'source', 'manager'), nullif(r.v->>'note', ''),
        nullif(r.v->>'expires_at', '')::timestamptz,
        g_id, (p_group->>'series_id')::uuid);
    n := n + 1;
  end loop;

  return jsonb_build_object('ok', true, 'groupId', g_id, 'bays', n,
    'occurrenceDate', o_date, 'bookingDate', g_date);
exception
  -- 23P01. Everything above is undone; report which bay lost the race.
  when exclusion_violation then
    return jsonb_build_object('conflict', true, 'bay', v_bay, 'bookingDate', g_date,
      'occurrenceDate', o_date, 'written', 0);
  -- 23505 on booking_groups_occurrence: this occurrence already exists. Also fully rolled back.
  when unique_violation then
    return jsonb_build_object('error', 'occurrence_exists', 'occurrenceDate', o_date);
end $$;

-- 9) series_dates + booking_series_occurrences — the recurrence arithmetic, once. -----------
--
-- series_dates() takes the recurrence PARAMETERS rather than a series id, so the "what would this
-- league look like?" preview and the real materialisation pass share one implementation instead of
-- the API growing a JavaScript copy of the same arithmetic. There is exactly one place in this
-- system that turns "every second Thursday until March" into a list of dates, and this is it.
--
-- MONTH-END. Dates are computed from p_start each time (p_start + n months), never by stepping the
-- previous one, so a monthly series never drifts. Postgres clamps 31 Jan + 1 month to 28 Feb, which
-- is the behaviour we want and the opposite of the JS Date.UTC bug fixed in commit 20a7de8.
create or replace function public.series_dates(
  p_freq text, p_interval integer, p_start date,
  p_until date default null, p_max integer default null, p_through date default null)
returns table (occurrence_date date, seq integer)
language sql immutable as $$
  with cfg as (
    select coalesce(p_freq, 'once') as freq,
           greatest(coalesce(p_interval, 1), 1) as step,
           p_start as d0,
           least(coalesce(p_through, p_until, p_start), coalesce(p_until, 'infinity'::date)) as horizon
  ),
  n as (select generate_series(0, least(coalesce(p_max, 520), 520) - 1) as i)
  select x.dt, x.k from (
    select (n.i + 1)::integer as k,
      case cfg.freq
        when 'once'    then cfg.d0
        when 'daily'   then cfg.d0 + (n.i * cfg.step)
        when 'weekly'  then cfg.d0 + (n.i * cfg.step * 7)
        when 'monthly' then (cfg.d0 + make_interval(months => n.i * cfg.step))::date
        when 'annual'  then (cfg.d0 + make_interval(years  => n.i * cfg.step))::date
      end as dt,
      cfg.horizon as horizon
      from cfg, n
     where cfg.freq <> 'once' or n.i = 0
  ) x
   where x.dt is not null and x.dt <= x.horizon
   order by x.k;
$$;

-- What the recurrence owes, and what became of each date.
--
-- Read-only. The API asks it which dates are still 'pending', prices those through quoteBooking(),
-- and calls book_group() for each. That split is what keeps recurrence arithmetic in SQL and
-- pricing in JavaScript without either one forking the other.
--
-- state: pending   nothing has happened to this date yet — it is owed
--        booked    a live group exists for it
--        cancelled a group exists and was called off (the date stays claimed on purpose)
--        skipped   could not be booked; booking_series_exceptions.reason says why
--        moved     it exists, somewhere other than its recurrence date
create or replace function public.booking_series_occurrences(p_series uuid, p_through date default null)
returns table (occurrence_date date, seq integer, state text, detail jsonb)
language sql stable as $$
  select d.occurrence_date, d.seq,
    coalesce(
      case when g.id is null then null
           when g.status = 'cancelled' then 'cancelled'
           when g.booking_date <> g.occurrence_date then 'moved'
           else 'booked' end,
      x.kind,
      'pending'),
    coalesce(
      case when g.id is null then null else jsonb_build_object(
        'groupId', g.id, 'status', g.status, 'bookingDate', g.booking_date,
        'startMin', g.start_min, 'endMin', g.end_min, 'bays', g.bay_count) end,
      case when x.id is null then null else jsonb_build_object(
        'reason', x.reason, 'detail', x.detail) end,
      '{}'::jsonb)
    from public.booking_series s
    cross join lateral public.series_dates(
      s.freq, s.interval_n, s.start_date, s.until_date, s.max_occurrences,
      coalesce(p_through, s.until_date, s.materialised_through, s.start_date)) d
    left join public.booking_groups g
      on g.series_id = s.id and g.occurrence_date = d.occurrence_date
    left join public.booking_series_exceptions x
      on x.series_id = s.id and x.occurrence_date = d.occurrence_date
   where s.id = p_series
   order by d.seq;
$$;

-- 10) record_series_exception — "this date did not happen, and here is why". ---------------
-- Upsert, because a date can be skipped, retried and skipped again for a different reason.
create or replace function public.record_series_exception(
  p_series uuid, p_date date, p_kind text, p_reason text default null, p_detail jsonb default '{}'::jsonb)
returns uuid language plpgsql as $$
declare x_id uuid;
begin
  insert into public.booking_series_exceptions (series_id, occurrence_date, kind, reason, detail)
    values (p_series, p_date, p_kind, p_reason, coalesce(p_detail, '{}'::jsonb))
  on conflict (series_id, occurrence_date) do update
    set kind = excluded.kind, reason = excluded.reason, detail = excluded.detail, created_at = now()
  returning id into x_id;
  return x_id;
end $$;

-- 11) cancel_group — full or PARTIAL cancellation of one occurrence. -----------------------
--
-- p_bays null cancels the whole occurrence; a subset cancels just those bays and leaves the rest
-- of the event standing. Rows are locked in bay_id order for the same reason book_group inserts in
-- that order. Returns what was cancelled AND what each row was worth, because the caller cannot
-- work out what to refund without it — this function deliberately does not decide that.
--
-- Group status afterwards: 'cancelled' when nothing is left, 'partial' when some bays survive.
-- The group row is never deleted, so the occurrence date stays claimed against re-materialisation.
create or replace function public.cancel_group(
  p_group uuid, p_bays text[] default null, p_reason text default null)
returns jsonb language plpgsql as $$
declare
  g       record;
  killed  jsonb := '[]'::jsonb;
  b       record;
  live    integer;
  refundable integer := 0;
begin
  select * into g from public.booking_groups where id = p_group for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;

  for b in
    select id, bay_id, amount_cents, refunded_cents, status
      from public.bookings
     where group_id = p_group and status <> 'cancelled'
       and (p_bays is null or bay_id = any (p_bays))
     order by bay_id
     for update
  loop
    update public.bookings
       set status = 'cancelled', cancelled_at = now(), expires_at = null
     where id = b.id;
    refundable := refundable + greatest(0, coalesce(b.amount_cents, 0) - coalesce(b.refunded_cents, 0));
    killed := killed || jsonb_build_object(
      'id', b.id, 'bayId', b.bay_id,
      'amountCents', coalesce(b.amount_cents, 0),
      'refundedCents', coalesce(b.refunded_cents, 0));
  end loop;

  select count(*) into live from public.bookings where group_id = p_group and status <> 'cancelled';

  update public.booking_groups
     set status = case when live = 0 then 'cancelled'
                       when live < bay_count then 'partial'
                       else status end,
         cancelled_at = case when live = 0 then now() else cancelled_at end
   where id = p_group;

  if live = 0 and g.series_id is not null then
    perform public.record_series_exception(g.series_id, g.occurrence_date, 'cancelled',
      coalesce(p_reason, 'manager'), jsonb_build_object('groupId', p_group));
  end if;

  return jsonb_build_object('ok', true, 'groupId', p_group, 'cancelled', killed,
    'cancelledCount', jsonb_array_length(killed), 'remaining', live,
    'refundableCents', refundable,
    'groupStatus', (select status from public.booking_groups where id = p_group));
end $$;

-- 12) move_group — put one occurrence somewhere else without breaking the series. ----------
--
-- Same all-or-nothing shape as book_group and for the same reason: a six-bay event that moved four
-- bays to Friday and left two on Thursday is worse than one that did not move. occurrence_date is
-- untouched — that is what keeps the recurrence's memory of this week intact — and the move is
-- written to booking_series_exceptions so the horizon pass can see it happened.
--
-- p_bay_map jsonb: optional { "B1": "B4", … } to land on different bays. Unlisted bays stay.
create or replace function public.move_group(
  p_group uuid, p_date date default null, p_start integer default null,
  p_end integer default null, p_bay_map jsonb default null, p_reason text default null)
returns jsonb language plpgsql as $$
declare
  g      record;
  b      record;
  v_bay  text;
  new_bay text;
  n_date date; n_start integer; n_end integer; n integer := 0;
begin
  select * into g from public.booking_groups where id = p_group for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if g.status = 'cancelled' then return jsonb_build_object('error', 'cancelled'); end if;

  n_date  := coalesce(p_date, g.booking_date);
  n_start := coalesce(p_start, g.start_min);
  n_end   := coalesce(p_end, g.end_min);
  if n_end <= n_start then return jsonb_build_object('error', 'bad_times'); end if;

  for b in
    select id, bay_id from public.bookings
     where group_id = p_group and status <> 'cancelled'
     order by bay_id
  loop
    v_bay := b.bay_id;
    new_bay := coalesce(nullif(p_bay_map->>b.bay_id, ''), b.bay_id);
    update public.bookings
       set bay_id = new_bay, booking_date = n_date, start_min = n_start::smallint, end_min = n_end::smallint
     where id = b.id;
    n := n + 1;
  end loop;

  update public.booking_groups
     set booking_date = n_date, start_min = n_start::smallint, end_min = n_end::smallint,
         moved_at = case when n_date <> occurrence_date or n_start <> start_min or n_end <> end_min
                         then now() else moved_at end
   where id = p_group;

  if g.series_id is not null then
    perform public.record_series_exception(g.series_id, g.occurrence_date, 'moved',
      coalesce(p_reason, 'manager'),
      jsonb_build_object('groupId', p_group,
        'from', jsonb_build_object('date', g.booking_date, 'startMin', g.start_min, 'endMin', g.end_min),
        'to',   jsonb_build_object('date', n_date, 'startMin', n_start, 'endMin', n_end)));
  end if;

  return jsonb_build_object('ok', true, 'groupId', p_group, 'moved', n,
    'bookingDate', n_date, 'startMin', n_start, 'endMin', n_end);
exception
  when exclusion_violation then
    return jsonb_build_object('conflict', true, 'bay', v_bay, 'bookingDate', n_date);
end $$;

-- 13) record_refund — write the obligation down, once. -------------------------------------
--
-- Again: this MOVES NO MONEY (see section 5). It records what is owed, keeps refunded_cents in
-- step on the booking and its group, and refuses to record more than was charged. Idempotent on
-- (booking_id, ref) so a retried API call does not double-count.
create or replace function public.record_refund(
  p_booking uuid, p_group uuid, p_amount integer, p_reason text default null,
  p_method text default 'stripe', p_ref text default null, p_note text default null,
  p_by text default null)
returns jsonb language plpgsql as $$
declare
  r_id     uuid;
  paid     integer;
  done     integer;
  v_group  uuid := p_group;
  v_pi     text;
begin
  if coalesce(p_amount, 0) <= 0 then return jsonb_build_object('error', 'bad_amount'); end if;

  -- IDEMPOTENCY IS CHECKED FIRST, and the order matters. A retried call carries the same ref and
  -- the same amount, and by then refunded_cents already includes it — so an over-refund guard
  -- placed above this would answer a harmless retry with 'over_refund' and make a caller believe
  -- something had gone wrong. Ask "have I already recorded this one?" before asking "is there room
  -- for another?". (Caught in testing, by exactly that sequence.)
  if p_ref is not null then
    select r.id into r_id from public.refunds r
     where r.ref = p_ref
       and (p_booking is not null and r.booking_id = p_booking
            or p_booking is null and r.booking_id is null and r.group_id = p_group)
     limit 1;
    if r_id is not null then
      return jsonb_build_object('already', true, 'refundId', r_id, 'moneyMoved', false);
    end if;
  end if;

  -- A refund can be attached to one booking (a bay of a group) or to the group as a whole.
  -- Only the booking case has an amount to check against, so only it can be over-refunded.
  if p_booking is not null then
    select coalesce(b.amount_cents, 0), coalesce(b.refunded_cents, 0), b.group_id, b.stripe_payment_intent
      into paid, done, v_group, v_pi
      from public.bookings b where b.id = p_booking for update;
    if not found then return jsonb_build_object('error', 'booking_not_found'); end if;
    v_group := coalesce(p_group, v_group);
    if done + p_amount > paid then
      return jsonb_build_object('error', 'over_refund',
        'paidCents', paid, 'refundedCents', done, 'requested', p_amount);
    end if;
  end if;

  insert into public.refunds (booking_id, group_id, amount_cents, reason, method, status,
      stripe_payment_intent, ref, note, created_by)
    values (p_booking, v_group, p_amount, p_reason,
      coalesce(p_method, 'stripe'),
      case when coalesce(p_method, 'stripe') = 'none' then 'cancelled' else 'pending' end,
      v_pi, p_ref, p_note, p_by)
    returning id into r_id;

  if p_booking is not null then
    update public.bookings set refunded_cents = coalesce(refunded_cents, 0) + p_amount where id = p_booking;
  end if;
  if v_group is not null then
    update public.booking_groups set refunded_cents = coalesce(refunded_cents, 0) + p_amount
     where id = v_group;
  end if;

  return jsonb_build_object('ok', true, 'refundId', r_id, 'amountCents', p_amount,
    'moneyMoved', false);
exception
  -- Two callers retrying at once: the unique index is the real guard, the check above is the
  -- fast path. Either way the answer is the same and refunded_cents is not touched twice.
  when unique_violation then
    select r.id into r_id from public.refunds r
     where r.ref = p_ref
       and (p_booking is not null and r.booking_id = p_booking
            or p_booking is null and r.booking_id is null and r.group_id = p_group)
     limit 1;
    return jsonb_build_object('already', true, 'refundId', r_id, 'moneyMoved', false);
end $$;
