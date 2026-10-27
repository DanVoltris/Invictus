-- 0045 — Spin the Wheel: a verified Manitoba address, and 18+ prizes only for entrants 18+.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run. Needs 0044.
--
-- ADDRESS
-- The address is picked from OpenStreetMap suggestions and confirmed by the server, which looks the
-- place up again and records its province (lib/address.js). Only the server or staff can write
-- those verification columns, and any other change to the address text clears them — so a
-- hand-typed or edited address is never "verified". Spinning needs a verified Manitoba address.
--
-- AGE
-- 0044 handed out any prize to anyone and left the age check to the counter. Now an entrant under
-- 18 (date of birth, Winnipeg date) is only ever given a prize without the 18+ box ticked. If the
-- winning spin finds no prize they may have, it is logged as no win and the win goes back into the
-- group, the same way a forfeit does. Staff still check ID on 18+ prizes at the counter.

alter table public.customers add column if not exists address_place_id    text;
alter table public.customers add column if not exists address_province    text;
alter table public.customers add column if not exists address_verified_at timestamptz;

-- ============================================================================
-- 1) The customer guard: 0044's, plus the address verification columns
-- ============================================================================
create or replace function public.customer_guard_self_columns() returns trigger
language plpgsql as $fn$
declare trusted boolean := public.rbac_is_service();
begin
  -- WHO somebody is. Refused to everyone who is neither the server nor staff — which, given the
  -- policies on this table, is exactly an account holder editing their own row.
  if (new.phone is distinct from old.phone or new.email is distinct from old.email)
     and not trusted and public.staff_role() is null then
    raise exception 'permission denied: ask the shop to change the phone number or email on your account'
      using errcode = '42501';
  end if;
  -- Date of birth: set once by the account holder; after that only staff or the server change it.
  if old.date_of_birth is not null and new.date_of_birth is distinct from old.date_of_birth
     and not trusted and public.staff_role() is null then
    raise exception 'permission denied: ask the shop to correct your date of birth'
      using errcode = '42501';
  end if;
  if new.date_of_birth is not null
     and (new.date_of_birth < date '1900-01-01' or new.date_of_birth > current_date) then
    raise exception 'That date of birth is not valid.' using errcode = '22007';
  end if;
  -- Address verification is the server's word only. Anyone else changing the address text — the
  -- account holder or staff — leaves an unverified address behind.
  if not trusted then
    if new.address is distinct from old.address then
      new.address_place_id := null; new.address_province := null; new.address_verified_at := null;
    elsif new.address_place_id is distinct from old.address_place_id
       or new.address_province is distinct from old.address_province
       or new.address_verified_at is distinct from old.address_verified_at then
      raise exception 'permission denied: choose your address from the suggestions to confirm it'
        using errcode = '42501';
    end if;
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
-- 2) What a customer needs before spinning
-- ============================================================================
-- 'address_verified': an address not picked from the suggestions. 'manitoba': picked, but outside MB.
create or replace function public.contest_missing_fields(c public.customers) returns text[]
language sql stable as $fn$
  select array_remove(array[
    case when nullif(btrim(c.first_name), '') is null then 'first_name' end,
    case when nullif(btrim(c.last_name),  '') is null then 'last_name'  end,
    case when nullif(btrim(c.email),      '') is null then 'email'      end,
    case when nullif(btrim(c.phone),      '') is null then 'phone'      end,
    case when nullif(btrim(c.address),    '') is null then 'address'
         when c.address_verified_at is null           then 'address_verified'
         when c.address_province is distinct from 'MB' then 'manitoba' end,
    case when nullif(btrim(c.career),     '') is null then 'career'     end,
    case when c.date_of_birth is null                 then 'date_of_birth' end
  ], null);
$fn$;

-- 18 or older today, Winnipeg date. A fixed UTC−5: Manitoba keeps daylight time all year from
-- November 2026, which the database's own time-zone data may not know yet.
create or replace function public.contest_is_adult(p_dob date) returns boolean
language sql stable as $fn$
  select p_dob is not null and p_dob <= ((now() at time zone interval '-05:00')::date - interval '18 years')::date;
$fn$;

-- ============================================================================
-- 3) Prize choice by age
-- ============================================================================
drop function if exists public.contest_pick_prize();
create or replace function public.contest_pick_prize(p_adult boolean) returns public.contest_prizes
language plpgsql volatile set search_path = public, pg_temp as $fn$
declare total integer; r integer; acc integer := 0; p public.contest_prizes;
begin
  select coalesce(sum(weight), 0) into total from public.contest_prizes
   where active and weight > 0 and (p_adult or not adults_only);
  if total = 0 then return null; end if;
  r := public.contest_rand_int(total);
  for p in select * from public.contest_prizes
            where active and weight > 0 and (p_adult or not adults_only) order by sort, created_at, id loop
    acc := acc + p.weight;
    if r <= acc then return p; end if;
  end loop;
  return null;
end $fn$;

-- One win back into the pool: a later free position in the block, else owed to the next block.
-- Shared by a forfeited claim and a winning spin that found no prize the entrant may have.
create or replace function public.contest_requeue_win(p_period uuid, p_block uuid) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare per public.contest_periods; blk public.contest_blocks; add integer[];
begin
  select * into per from public.contest_periods where id = p_period for update;
  if per.forfeit_mode <> 'return' then return false; end if;
  if p_block is not null then
    select * into blk from public.contest_blocks where id = p_block for update;
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

create or replace function public.contest_return_win(p_claim uuid) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare cl public.contest_claims;
begin
  select * into cl from public.contest_claims where id = p_claim;
  if not found then return false; end if;
  return public.contest_requeue_win(cl.period_id, cl.block_id);
end $fn$;

-- ============================================================================
-- 4) The spin, with the prize chosen by age
-- ============================================================================
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
    prz := public.contest_pick_prize(public.contest_is_adult(c.date_of_birth));
    -- Nothing this entrant may have (under 18 and every prize is 18+, or no prizes at all): no win
    -- for them, and the win goes back to a later spin.
    if prz.id is null then
      won := false;
      perform public.contest_requeue_win(per.id, blk.id);
    end if;
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
-- 5) The end-of-period draw, with the prize chosen by each winner's age
-- ============================================================================
create or replace function public.contest_resolve_period(p_period uuid, p_mode text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  per public.contest_periods; nxt public.contest_periods; n integer; blk public.contest_blocks;
  pool uuid[]; picks integer[]; i integer; prz public.contest_prizes; drawn integer := 0; dob date;
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

  -- Draw: distinct customers among the last block's spins that did not win, in random order;
  -- each drawn entrant gets a prize they may have, and one with none to give is passed over.
  select * into blk from public.contest_blocks where period_id = per.id order by seq desc limit 1;
  select coalesce(array_agg(customer_id order by customer_id), '{}') into pool from (
    select distinct s.customer_id from public.contest_spins s
     where s.block_id = blk.id and not s.won) q;
  if coalesce(array_length(pool, 1), 0) = 0 then
    raise exception 'Nobody in the last block is left to draw from. Carry the prizes instead.';
  end if;
  -- Every entrant in a CSPRNG-shuffled order; the first n who can be given a prize win.
  select array_agg(g order by extensions.gen_random_bytes(8)) into picks
    from generate_series(1, array_length(pool, 1)) g;
  foreach i in array picks loop
    exit when drawn >= n;
    select date_of_birth into dob from public.customers where id = pool[i];
    prz := public.contest_pick_prize(public.contest_is_adult(dob));
    continue when prz.id is null;
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

-- ============================================================================
-- 6) Execute rights
-- ============================================================================
revoke all on function public.contest_pick_prize(boolean)         from public, anon, authenticated;
revoke all on function public.contest_requeue_win(uuid, uuid)     from public, anon, authenticated;
revoke all on function public.contest_return_win(uuid)            from public, anon, authenticated;
revoke all on function public.contest_spin(uuid, text, text)      from public, anon, authenticated;
revoke all on function public.contest_resolve_period(uuid, text)  from public, anon;
grant execute on function public.contest_resolve_period(uuid, text) to authenticated;
grant execute on function public.contest_spin(uuid, text, text)     to service_role;

do $$ begin
  if not public.contest_is_adult((current_date - interval '30 years')::date)
     or public.contest_is_adult((current_date - interval '10 years')::date) then
    raise exception '0045: contest_is_adult is broken';
  end if;
  raise notice '0045 applied: spins need a verified Manitoba address; 18+ prizes go only to entrants 18+.';
end $$;
