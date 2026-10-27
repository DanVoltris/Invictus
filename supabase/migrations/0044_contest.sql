-- 0044 — Spin the Wheel: periods, prizes, blocks, spins, claims.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
-- Needs 0024 (staff roles) and 0027 (address/career). Independent of 0042/0043.
--
-- HOW A WIN IS DECIDED
-- A period is cut into blocks of Y spins. When a block opens, X of its positions 1..Y are picked
-- with pgcrypto's gen_random_bytes (a CSPRNG) and stored on the block. Each spin takes the next
-- position; landing on a stored one is a win. All of it happens in public.contest_spin(), in one
-- transaction holding a lock on the period, so two spins at the same instant cannot share a
-- position. Nothing here is readable by a customer: the server (service role) calls the function
-- and hands the browser only "won / did not win" and the prize. Block positions are hidden from
-- staff too until the block has closed (contest_block_log).
--
-- A won prize is not awarded until the skill-testing question is answered (api/account.js). A
-- wrong answer, a timeout, or a failed ID check at the counter returns the win to the pool when the
-- period says so: a later free position in the same block, or the next block if this one is full.
--
-- Age: date of birth is collected and required to spin, but it does not filter prizes. Staff check
-- ID when an 18+ prize is redeemed (contest_refuse_claim if it fails).

create extension if not exists pgcrypto with schema extensions;

-- ============================================================================
-- 1) Customers: first/last name and date of birth
-- ============================================================================
alter table public.customers add column if not exists first_name    text;
alter table public.customers add column if not exists last_name     text;
alter table public.customers add column if not exists date_of_birth date;

-- Existing names split at the first space. A single word stays unsplit, so that person is asked
-- for the missing half before they can spin.
update public.customers
   set first_name = split_part(btrim(name), ' ', 1),
       last_name  = btrim(substr(btrim(name), length(split_part(btrim(name), ' ', 1)) + 1))
 where first_name is null and last_name is null
   and position(' ' in btrim(coalesce(name, ''))) > 0;

-- `name` is what every other screen reads, so it follows first/last; a `name` edited on its own
-- (the portal, sign-up) re-splits into first/last.
create or replace function public.customer_sync_names() returns trigger
language plpgsql as $fn$
declare n text;
begin
  if tg_op = 'UPDATE'
     and (new.first_name is distinct from old.first_name or new.last_name is distinct from old.last_name) then
    n := btrim(concat_ws(' ', nullif(btrim(new.first_name), ''), nullif(btrim(new.last_name), '')));
    if n <> '' then new.name := n; end if;
  elsif (tg_op = 'INSERT' and new.first_name is null and new.last_name is null)
     or (tg_op = 'UPDATE' and new.name is distinct from old.name) then
    n := btrim(coalesce(new.name, ''));
    if position(' ' in n) > 0 then
      new.first_name := split_part(n, ' ', 1);
      new.last_name  := btrim(substr(n, length(split_part(n, ' ', 1)) + 1));
    elsif n <> '' then
      new.first_name := n; new.last_name := null;
    end if;
  end if;
  return new;
end $fn$;
drop trigger if exists customer_sync_names on public.customers;
create trigger customer_sync_names before insert or update on public.customers
  for each row execute function public.customer_sync_names();

-- The 0043 guard, plus: an account holder may enter a date of birth once, never change it.
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
  -- Date of birth: set once by the account holder; after that only staff or the server change it.
  if old.date_of_birth is not null and new.date_of_birth is distinct from old.date_of_birth
     and not public.rbac_is_service() and public.staff_role() is null then
    raise exception 'permission denied: ask the shop to correct your date of birth'
      using errcode = '42501';
  end if;
  if new.date_of_birth is not null
     and (new.date_of_birth < date '1900-01-01' or new.date_of_birth > current_date) then
    raise exception 'That date of birth is not valid.' using errcode = '22007';
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
drop trigger if exists customer_guard_self on public.customers;
create trigger customer_guard_self before update on public.customers
  for each row execute function public.customer_guard_self_columns();

-- ============================================================================
-- 2) Tables
-- ============================================================================
create table if not exists public.contest_periods (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  wins_per_block  integer not null check (wins_per_block >= 1),          -- X
  block_size      integer not null check (block_size >= 1),              -- Y
  incomplete_mode text not null default 'draw' check (incomplete_mode in ('draw', 'carry')),
  forfeit_mode    text not null default 'return' check (forfeit_mode in ('return', 'void')),
  carry_wins      integer not null default 0 check (carry_wins >= 0),    -- wins owed to the next block
  resolved_at     timestamptz,                                           -- unawarded wins dealt with
  resolution      text,
  resolved_by     uuid,
  created_at      timestamptz not null default now(),
  check (ends_at > starts_at),
  check (wins_per_block <= block_size)
);
-- Periods never overlap, so "the active period" is always one row.
do $$ begin
  alter table public.contest_periods add constraint contest_periods_no_overlap
    exclude using gist (tstzrange(starts_at, ends_at) with &&);
exception when duplicate_object or duplicate_table then null; end $$;

create table if not exists public.contest_prizes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  kind        text not null default 'other' check (kind in ('round', 'hours', 'credit', 'other')),
  value_cents integer not null default 0 check (value_cents >= 0),        -- approximate retail value
  adults_only boolean not null default false,
  weight      integer not null default 1 check (weight >= 0),            -- relative chance among prizes
  active      boolean not null default true,
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.contest_blocks (
  id                uuid primary key default gen_random_uuid(),
  period_id         uuid not null references public.contest_periods(id) on delete restrict,
  seq               integer not null,
  size              integer not null,
  winning_positions integer[] not null default '{}',
  spins_taken       integer not null default 0,
  created_at        timestamptz not null default now(),
  closed_at         timestamptz,
  unique (period_id, seq)
);

create table if not exists public.contest_spins (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  period_id   uuid not null references public.contest_periods(id) on delete restrict,
  block_id    uuid not null references public.contest_blocks(id) on delete restrict,
  position    integer not null,
  won         boolean not null,
  prize_id    uuid references public.contest_prizes(id) on delete restrict,
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists contest_spins_customer on public.contest_spins (customer_id, created_at desc);
create index if not exists contest_spins_period   on public.contest_spins (period_id, created_at desc);

-- One row per prize won, by a spin or by an end-of-period draw. The prize is copied, so editing
-- or retiring it later does not rewrite what somebody won.
create table if not exists public.contest_claims (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null references public.customers(id) on delete restrict,
  period_id           uuid not null references public.contest_periods(id) on delete restrict,
  block_id            uuid references public.contest_blocks(id) on delete restrict,
  spin_id             uuid references public.contest_spins(id) on delete restrict,
  source              text not null default 'spin' check (source in ('spin', 'draw')),
  prize_id            uuid not null references public.contest_prizes(id) on delete restrict,
  prize_name          text not null,
  prize_description   text,
  prize_kind          text not null,
  prize_value_cents   integer not null,
  prize_adults_only   boolean not null,
  -- pending: won, question not opened · question: opened, clock running · won: answered right
  -- wrong / timeout: forfeited at the question · refused: ID check failed at the counter
  status              text not null default 'pending'
                      check (status in ('pending', 'question', 'won', 'wrong', 'timeout', 'refused')),
  question            text,
  answer              integer,
  question_issued_at  timestamptz,
  question_expires_at timestamptz,
  given_answer        text,
  answered_at         timestamptz,
  returned_to_pool    boolean,
  redeemed_at         timestamptz,
  redeemed_by         uuid,
  redeemed_by_email   text,
  refused_note        text,
  created_at          timestamptz not null default now()
);
create index if not exists contest_claims_customer on public.contest_claims (customer_id, created_at desc);
create index if not exists contest_claims_status   on public.contest_claims (status, created_at desc);

-- ============================================================================
-- 3) Who may see and change what
-- ============================================================================
insert into public.capabilities (key, label, description, sort) values
  ('contest.manage', 'Contest', 'Run Spin the Wheel: periods, prizes, odds, end-of-period draws and the contest logs.', 6)
on conflict (key) do nothing;
insert into public.role_permissions (role, capability, allowed) values
  ('employee', 'contest.manage', false),
  ('readonly', 'contest.manage', false)
on conflict (role, capability) do nothing;

alter table public.contest_periods enable row level security;
alter table public.contest_prizes  enable row level security;
alter table public.contest_blocks  enable row level security;
alter table public.contest_spins   enable row level security;
alter table public.contest_claims  enable row level security;
revoke all on public.contest_periods, public.contest_prizes, public.contest_blocks,
              public.contest_spins, public.contest_claims from anon;

-- Periods and prizes: any staff reads, contest.manage writes. Nothing for customers — the rules
-- page and the wheel get their values from the server.
drop policy if exists contest_periods_read  on public.contest_periods;
drop policy if exists contest_periods_write on public.contest_periods;
create policy contest_periods_read  on public.contest_periods for select to authenticated
  using ((select public.staff_role()) is not null);
create policy contest_periods_write on public.contest_periods for all to authenticated
  using ((select public.staff_can('contest.manage'))) with check ((select public.staff_can('contest.manage')));
drop policy if exists contest_prizes_read  on public.contest_prizes;
drop policy if exists contest_prizes_write on public.contest_prizes;
create policy contest_prizes_read  on public.contest_prizes for select to authenticated
  using ((select public.staff_role()) is not null);
create policy contest_prizes_write on public.contest_prizes for all to authenticated
  using ((select public.staff_can('contest.manage'))) with check ((select public.staff_can('contest.manage')));

-- Blocks: no policy at all, so nobody signed in reads them directly. contest_block_log() shows
-- them to contest.manage with an open block's positions withheld.
revoke all on public.contest_blocks from authenticated;

-- Spins: an audit log. contest.manage reads it; nobody writes but contest_spin().
drop policy if exists contest_spins_read on public.contest_spins;
create policy contest_spins_read on public.contest_spins for select to authenticated
  using ((select public.staff_can('contest.manage')));
revoke insert, update, delete on public.contest_spins from authenticated;

-- Claims: any staff reads (the counter has to find a winner's prize); the answer is a column a
-- curious employee could read off an open question, so `answer` is not granted to them.
-- Changes go through contest_redeem_claim / contest_refuse_claim only.
drop policy if exists contest_claims_read on public.contest_claims;
create policy contest_claims_read on public.contest_claims for select to authenticated
  using ((select public.staff_role()) is not null);
revoke all on public.contest_claims from authenticated;
grant select (id, customer_id, period_id, block_id, spin_id, source, prize_id, prize_name,
              prize_description, prize_kind, prize_value_cents, prize_adults_only, status, question,
              question_issued_at, question_expires_at, given_answer, answered_at, returned_to_pool,
              redeemed_at, redeemed_by, redeemed_by_email, refused_note, created_at)
  on public.contest_claims to authenticated;
grant select, insert, update, delete on public.contest_periods, public.contest_prizes to authenticated;
grant select on public.contest_spins to authenticated;

-- ============================================================================
-- 4) Randomness
-- ============================================================================
-- A uniform integer 1..n from the CSPRNG, by rejection so no value is favoured.
create or replace function public.contest_rand_int(n integer) returns integer
language plpgsql volatile set search_path = public, extensions, pg_temp as $fn$
declare r bigint; lim bigint;
begin
  if n is null or n < 1 then raise exception 'contest_rand_int: n must be >= 1'; end if;
  lim := 4294967296 - (4294967296 % n);
  loop
    r := ('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint;
    if r < lim then return (r % n)::integer + 1; end if;
  end loop;
end $fn$;

-- k distinct positions from lo..hi, excluding `taken`, in ascending order.
create or replace function public.contest_pick_positions(lo integer, hi integer, k integer, taken integer[])
returns integer[] language plpgsql volatile set search_path = public, pg_temp as $fn$
declare pool integer[]; out integer[] := '{}'; i integer; j integer; tmp integer;
begin
  select coalesce(array_agg(p order by p), '{}') into pool
    from generate_series(lo, hi) p where not (p = any(coalesce(taken, '{}')));
  k := least(k, coalesce(array_length(pool, 1), 0));
  -- Partial Fisher–Yates: the first k slots end up a uniform random k-subset.
  for i in 1..k loop
    j := i - 1 + public.contest_rand_int(array_length(pool, 1) - i + 1);
    tmp := pool[i]; pool[i] := pool[j]; pool[j] := tmp;
    out := out || pool[i];
  end loop;
  return (select coalesce(array_agg(x order by x), '{}') from unnest(out) x);
end $fn$;

-- One active prize, by weight. Null when no prize has a weight above zero.
create or replace function public.contest_pick_prize() returns public.contest_prizes
language plpgsql volatile set search_path = public, pg_temp as $fn$
declare total integer; r integer; acc integer := 0; p public.contest_prizes;
begin
  select coalesce(sum(weight), 0) into total from public.contest_prizes where active and weight > 0;
  if total = 0 then return null; end if;
  r := public.contest_rand_int(total);
  for p in select * from public.contest_prizes where active and weight > 0 order by sort, created_at, id loop
    acc := acc + p.weight;
    if r <= acc then return p; end if;
  end loop;
  return null;
end $fn$;

-- ============================================================================
-- 5) The spin
-- ============================================================================
create or replace function public.contest_active_period() returns public.contest_periods
language sql stable set search_path = public, pg_temp as $fn$
  select * from public.contest_periods where now() >= starts_at and now() < ends_at limit 1;
$fn$;

-- What is missing before this customer may spin.
create or replace function public.contest_missing_fields(c public.customers) returns text[]
language sql stable as $fn$
  select array_remove(array[
    case when nullif(btrim(c.first_name), '') is null then 'first_name' end,
    case when nullif(btrim(c.last_name),  '') is null then 'last_name'  end,
    case when nullif(btrim(c.email),      '') is null then 'email'      end,
    case when nullif(btrim(c.phone),      '') is null then 'phone'      end,
    case when nullif(btrim(c.address),    '') is null then 'address'    end,
    case when nullif(btrim(c.career),     '') is null then 'career'     end,
    case when c.date_of_birth is null                 then 'date_of_birth' end
  ], null);
$fn$;

-- Returns { ok, reason?, next_at?, won, claim_id?, prize? }. Never the block, the position, or the
-- winning positions. Called by the server only (execute is revoked from everyone else below).
create or replace function public.contest_spin(p_customer uuid, p_ip text default null, p_ua text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  c public.customers; per public.contest_periods; blk public.contest_blocks;
  last_at timestamptz; pos integer; won boolean; prz public.contest_prizes;
  spin_id uuid; claim_id uuid; missing text[];
begin
  -- One spin at a time per customer, so a double-click cannot slip two past the 24-hour check.
  perform pg_advisory_xact_lock(hashtext('contest_spin:' || p_customer::text));

  select * into c from public.customers where id = p_customer;
  if not found or c.user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_account');
  end if;
  missing := public.contest_missing_fields(c);
  if array_length(missing, 1) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'profile', 'missing', to_jsonb(missing));
  end if;

  per := public.contest_active_period();
  if per.id is null then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  -- The period row is the lock every spin in it queues on: one position handed out at a time.
  select * into per from public.contest_periods where id = per.id for update;

  select max(created_at) into last_at from public.contest_spins where customer_id = p_customer;
  if last_at is not null and last_at > now() - interval '24 hours' then
    return jsonb_build_object('ok', false, 'reason', 'wait', 'next_at', last_at + interval '24 hours');
  end if;

  select * into blk from public.contest_blocks
   where period_id = per.id and closed_at is null order by seq desc limit 1 for update;
  if blk.id is null then
    insert into public.contest_blocks (period_id, seq, size, winning_positions)
    values (per.id,
            coalesce((select max(seq) from public.contest_blocks where period_id = per.id), 0) + 1,
            per.block_size,
            public.contest_pick_positions(1, per.block_size, least(per.wins_per_block + per.carry_wins, per.block_size), '{}'))
    returning * into blk;
    -- Owed wins went into this block; whatever did not fit stays owed to the next one.
    update public.contest_periods
       set carry_wins = per.wins_per_block + per.carry_wins - coalesce(array_length(blk.winning_positions, 1), 0)
     where id = per.id;
  end if;

  pos := blk.spins_taken + 1;
  won := pos = any(blk.winning_positions);
  update public.contest_blocks
     set spins_taken = pos, closed_at = case when pos >= size then now() end
   where id = blk.id;

  if won then
    prz := public.contest_pick_prize();
    if prz.id is null then won := false; end if;   -- no prize configured: logged as a loss
  end if;

  insert into public.contest_spins (customer_id, period_id, block_id, position, won, prize_id, ip, user_agent)
  values (p_customer, per.id, blk.id, pos, won, case when won then prz.id end, p_ip, left(p_ua, 300))
  returning id into spin_id;

  if won then
    insert into public.contest_claims (customer_id, period_id, block_id, spin_id, source, prize_id,
      prize_name, prize_description, prize_kind, prize_value_cents, prize_adults_only)
    values (p_customer, per.id, blk.id, spin_id, 'spin', prz.id,
      prz.name, prz.description, prz.kind, prz.value_cents, prz.adults_only)
    returning id into claim_id;
  end if;

  return jsonb_build_object('ok', true, 'won', won, 'next_at', now() + interval '24 hours',
    'claim_id', claim_id,
    'prize', case when won then jsonb_build_object('name', prz.name, 'description', prz.description,
      'kind', prz.kind, 'value_cents', prz.value_cents, 'adults_only', prz.adults_only) end);
end $fn$;

-- ============================================================================
-- 6) Returning a forfeited win to the pool
-- ============================================================================
-- A later free position in the claim's block; if the block has none left (or is closed), owed to
-- the period's next block. No-op when the period's forfeit_mode is 'void'. Returns true if returned.
create or replace function public.contest_return_win(p_claim uuid) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare cl public.contest_claims; per public.contest_periods; blk public.contest_blocks; add integer[];
begin
  select * into cl from public.contest_claims where id = p_claim;
  if not found then return false; end if;
  select * into per from public.contest_periods where id = cl.period_id for update;
  if per.forfeit_mode <> 'return' then return false; end if;
  if cl.block_id is not null then
    select * into blk from public.contest_blocks where id = cl.block_id for update;
    if blk.closed_at is null and blk.spins_taken < blk.size then
      add := public.contest_pick_positions(blk.spins_taken + 1, blk.size, 1, blk.winning_positions);
      if array_length(add, 1) = 1 then
        update public.contest_blocks
           set winning_positions = (select array_agg(x order by x) from unnest(winning_positions || add) x)
         where id = blk.id;
        return true;
      end if;
    end if;
  end if;
  update public.contest_periods set carry_wins = carry_wins + 1 where id = per.id;
  return true;
end $fn$;

-- The question was answered wrong or ran out of time. Server only.
create or replace function public.contest_forfeit_claim(p_claim uuid, p_status text, p_given text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare cl public.contest_claims; ret boolean;
begin
  if p_status not in ('wrong', 'timeout') then raise exception 'contest_forfeit_claim: bad status'; end if;
  select * into cl from public.contest_claims where id = p_claim for update;
  if not found or cl.status not in ('pending', 'question') then
    return jsonb_build_object('ok', false, 'status', cl.status);
  end if;
  ret := public.contest_return_win(p_claim);
  update public.contest_claims
     set status = p_status, given_answer = p_given, answered_at = now(), returned_to_pool = ret
   where id = p_claim;
  return jsonb_build_object('ok', true, 'status', p_status, 'returned_to_pool', ret);
end $fn$;

-- ============================================================================
-- 7) The counter: redeem, or refuse after an ID check
-- ============================================================================
create or replace function public.contest_redeem_claim(p_claim uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare cl public.contest_claims; who text;
begin
  if not public.staff_can('customer.write') then
    raise exception 'permission denied: redeeming a prize needs the Customers permission' using errcode = '42501';
  end if;
  select * into cl from public.contest_claims where id = p_claim for update;
  if not found then raise exception 'No such prize.'; end if;
  if cl.status <> 'won' then raise exception 'This prize has not been claimed (status: %).', cl.status; end if;
  if cl.redeemed_at is not null then raise exception 'Already redeemed on %.', cl.redeemed_at; end if;
  select email into who from public.staff where user_id = public.rbac_uid();
  update public.contest_claims
     set redeemed_at = now(), redeemed_by = public.rbac_uid(), redeemed_by_email = who
   where id = p_claim;
  return jsonb_build_object('ok', true, 'redeemed_at', now());
end $fn$;

-- An 18+ prize whose winner could not show ID of age. The win returns to the pool per the period.
create or replace function public.contest_refuse_claim(p_claim uuid, p_note text default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare cl public.contest_claims; ret boolean; who text;
begin
  if not public.staff_can('customer.write') then
    raise exception 'permission denied: this needs the Customers permission' using errcode = '42501';
  end if;
  select * into cl from public.contest_claims where id = p_claim for update;
  if not found then raise exception 'No such prize.'; end if;
  if not cl.prize_adults_only then raise exception 'Only an 18+ prize can be refused on an ID check.'; end if;
  if cl.status <> 'won' or cl.redeemed_at is not null then raise exception 'This prize cannot be refused now.'; end if;
  ret := public.contest_return_win(p_claim);
  select email into who from public.staff where user_id = public.rbac_uid();
  update public.contest_claims
     set status = 'refused', returned_to_pool = ret, refused_note = left(p_note, 300),
         redeemed_by = public.rbac_uid(), redeemed_by_email = who, redeemed_at = null
   where id = p_claim;
  return jsonb_build_object('ok', true, 'returned_to_pool', ret);
end $fn$;

-- ============================================================================
-- 8) End of a period with wins left over
-- ============================================================================
-- Wins a finished period never handed out: positions past the last spin of its open block, plus
-- any owed to a next block that never came.
create or replace function public.contest_unawarded(p_period uuid) returns integer
language sql stable set search_path = public, pg_temp as $fn$
  select coalesce((select carry_wins from public.contest_periods where id = p_period), 0)
       + coalesce((select count(*)::integer from public.contest_blocks b, unnest(b.winning_positions) w
                    where b.period_id = p_period and w > b.spins_taken), 0);
$fn$;

-- For the portal: every period, with the flag for "ended with wins left over and nobody has
-- decided what happens to them".
create or replace function public.contest_period_status() returns table (
  id uuid, unawarded integer, spins bigint, needs_resolution boolean)
language sql stable security definer set search_path = public, pg_temp as $fn$
  select p.id, public.contest_unawarded(p.id),
         (select count(*) from public.contest_spins s where s.period_id = p.id),
         (p.ends_at <= now() and p.resolved_at is null and public.contest_unawarded(p.id) > 0)
    from public.contest_periods p
   where public.staff_role() is not null or public.rbac_is_service();
$fn$;

-- p_mode 'draw': that many winners drawn from the last block's entrants who did not win, one prize
-- each by the same weights; they answer the skill-testing question in My Account like anyone else.
-- p_mode 'carry': the wins move to the next period still to run, which must already exist.
create or replace function public.contest_resolve_period(p_period uuid, p_mode text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  per public.contest_periods; nxt public.contest_periods; n integer; blk public.contest_blocks;
  pool uuid[]; picks integer[]; i integer; prz public.contest_prizes; drawn integer := 0;
begin
  if not public.staff_can('contest.manage') then
    raise exception 'permission denied: this needs the Contest permission' using errcode = '42501';
  end if;
  if p_mode not in ('draw', 'carry') then raise exception 'Choose draw or carry.'; end if;
  select * into per from public.contest_periods where id = p_period for update;
  if not found then raise exception 'No such period.'; end if;
  if per.ends_at > now() then raise exception 'This period has not ended yet.'; end if;
  if per.resolved_at is not null then raise exception 'Already resolved: %.', per.resolution; end if;
  n := public.contest_unawarded(p_period);
  if n = 0 then raise exception 'Every win in this period was handed out.'; end if;

  if p_mode = 'carry' then
    -- The next period still to run: carrying into one that has already ended would lose the wins.
    select * into nxt from public.contest_periods
     where starts_at >= per.ends_at and ends_at > now() order by starts_at limit 1 for update;
    if nxt.id is null then raise exception 'Create the next period first, then carry the prizes into it.'; end if;
    update public.contest_periods set carry_wins = carry_wins + n where id = nxt.id;
    update public.contest_periods
       set resolved_at = now(), resolved_by = public.rbac_uid(),
           resolution = format('carried %s to %s', n, nxt.name)
     where id = per.id;
    return jsonb_build_object('ok', true, 'carried', n, 'to', nxt.name);
  end if;

  -- Draw: distinct customers among the last block's spins that did not win.
  select * into blk from public.contest_blocks where period_id = per.id order by seq desc limit 1;
  select coalesce(array_agg(customer_id order by customer_id), '{}') into pool from (
    select distinct s.customer_id from public.contest_spins s
     where s.block_id = blk.id and not s.won) q;
  if coalesce(array_length(pool, 1), 0) = 0 then
    raise exception 'Nobody in the last block is left to draw from. Carry the prizes instead.';
  end if;
  picks := public.contest_pick_positions(1, array_length(pool, 1), n, '{}');
  foreach i in array picks loop
    prz := public.contest_pick_prize();
    exit when prz.id is null;
    insert into public.contest_claims (customer_id, period_id, block_id, source, prize_id,
      prize_name, prize_description, prize_kind, prize_value_cents, prize_adults_only)
    values (pool[i], per.id, blk.id, 'draw', prz.id,
      prz.name, prz.description, prz.kind, prz.value_cents, prz.adults_only);
    drawn := drawn + 1;
  end loop;
  update public.contest_periods
     set resolved_at = now(), resolved_by = public.rbac_uid(), carry_wins = 0,
         resolution = format('drew %s of %s from the last block', drawn, n)
   where id = per.id;
  return jsonb_build_object('ok', true, 'drawn', drawn, 'unawarded', n);
end $fn$;

-- Blocks for the portal's log. An open block's winning positions are withheld — showing them would
-- tell whoever reads the screen which upcoming spins win.
create or replace function public.contest_block_log(p_period uuid) returns table (
  id uuid, seq integer, size integer, spins_taken integer, wins integer,
  winning_positions integer[], created_at timestamptz, closed_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $fn$
  select b.id, b.seq, b.size, b.spins_taken, coalesce(array_length(b.winning_positions, 1), 0),
         case when b.closed_at is not null or (select ends_at from public.contest_periods where id = b.period_id) <= now()
              then b.winning_positions end,
         b.created_at, b.closed_at
    from public.contest_blocks b
   where b.period_id = p_period and public.staff_can('contest.manage')
   order by b.seq;
$fn$;

-- ============================================================================
-- 9) Execute rights
-- ============================================================================
revoke all on function public.contest_rand_int(integer)                          from public, anon, authenticated;
revoke all on function public.contest_pick_positions(integer, integer, integer, integer[]) from public, anon, authenticated;
revoke all on function public.contest_pick_prize()                               from public, anon, authenticated;
revoke all on function public.contest_spin(uuid, text, text)                     from public, anon, authenticated;
revoke all on function public.contest_return_win(uuid)                           from public, anon, authenticated;
revoke all on function public.contest_forfeit_claim(uuid, text, text)            from public, anon, authenticated;
revoke all on function public.contest_redeem_claim(uuid)                         from public, anon;
revoke all on function public.contest_refuse_claim(uuid, text)                   from public, anon;
revoke all on function public.contest_resolve_period(uuid, text)                 from public, anon;
revoke all on function public.contest_period_status()                            from public, anon;
revoke all on function public.contest_block_log(uuid)                            from public, anon;
grant execute on function public.contest_redeem_claim(uuid)            to authenticated;
grant execute on function public.contest_refuse_claim(uuid, text)      to authenticated;
grant execute on function public.contest_resolve_period(uuid, text)    to authenticated;
grant execute on function public.contest_period_status()               to authenticated;
grant execute on function public.contest_block_log(uuid)               to authenticated;
grant execute on function public.contest_spin(uuid, text, text)        to service_role;
grant execute on function public.contest_forfeit_claim(uuid, text, text) to service_role;
grant execute on function public.contest_return_win(uuid)              to service_role;

do $$ begin
  if public.contest_rand_int(1) <> 1 then raise exception '0044: contest_rand_int is broken'; end if;
  raise notice '0044 applied: Spin the Wheel tables, the spin, claims and draws are in place.';
end $$;
