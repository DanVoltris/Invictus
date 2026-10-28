-- 0051 — Spin the Wheel: each group of spins hands out exactly the prizes set for it.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run. Needs 0044 and 0045.
--
-- Until now the draw's groups made WHICH spins win exact (X winning spins in every Y), and each win
-- then picked its prize at random by the prizes' numbers — so a group set to 5 + 10 could hand out
-- 4 and 11. Now every group gets a PRIZE BAG when it opens: one slip per win, made from the prizes'
-- numbers ("winners in each group"). A winning spin draws a slip it may have and the slip does not
-- go back, so a group of 15 wins set to 5 + 10 hands out exactly 5 and 10.
--
--   * Numbers that add up to the draw's winners give exact counts. If they don't, every whole round
--     of the numbers is exact and the rest are drawn without repeats.
--   * A winner under 18 can't take an 18+ slip. Their win goes back to a later spin as before, and
--     the slip stays for that spin — in the group, or carried with the win to the next group.
--   * A forfeited prize (wrong answer, time ran out) puts its own slip back with its win.
--   * A prize switched off after a group opened: its slip is spent on a prize the winner may have.
--   * Groups opened before this migration have no bag and keep picking at random, as before.

alter table public.contest_blocks  add column if not exists prize_bag    uuid[];
alter table public.contest_periods add column if not exists carry_prizes uuid[] not null default '{}';

comment on column public.contest_blocks.prize_bag     is 'Prize slips still to hand out in this group, one per remaining win (0051). NULL = a group from before 0051.';
comment on column public.contest_periods.carry_prizes is 'Prize slips owed to the next group along with carry_wins (0051).';

-- ============================================================================
-- 1) Making and shuffling slips
-- ============================================================================
-- k slips from the active prizes' numbers: every whole round of the numbers, then the remainder
-- drawn without repeats (partial Fisher–Yates on the CSPRNG).
create or replace function public.contest_make_bag(k integer) returns uuid[]
language plpgsql volatile set search_path = public, pg_temp as $fn$
declare base uuid[] := '{}'; p record; out uuid[] := '{}'; n integer; i integer; j integer; tmp uuid;
begin
  if k is null or k <= 0 then return '{}'; end if;
  for p in select id, weight from public.contest_prizes where active and weight > 0 order by created_at, id loop
    base := base || array_fill(p.id, array[p.weight]);
  end loop;
  n := coalesce(array_length(base, 1), 0);
  if n = 0 then return '{}'; end if;
  for i in 1..(k / n) loop out := out || base; end loop;
  for i in 1..(k % n) loop
    j := i - 1 + public.contest_rand_int(n - i + 1);
    tmp := base[i]; base[i] := base[j]; base[j] := tmp;
    out := out || base[i];
  end loop;
  return out;
end $fn$;

create or replace function public.contest_shuffle(a uuid[]) returns uuid[]
language plpgsql volatile set search_path = public, pg_temp as $fn$
declare n integer := coalesce(array_length(a, 1), 0); i integer; j integer; tmp uuid;
begin
  for i in 1..greatest(n - 1, 0) loop
    j := i - 1 + public.contest_rand_int(n - i + 1);
    tmp := a[i]; a[i] := a[j]; a[j] := tmp;
  end loop;
  return coalesce(a, '{}');
end $fn$;

-- ============================================================================
-- 2) A winning spin takes a slip from its group's bag
-- ============================================================================
create or replace function public.contest_take_prize(p_block uuid, p_adult boolean) returns public.contest_prizes
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare blk public.contest_blocks; bag uuid[]; ok integer[] := '{}'; dead integer[] := '{}';
        i integer; k integer; prz public.contest_prizes; one public.contest_prizes;
begin
  select * into blk from public.contest_blocks where id = p_block for update;
  bag := blk.prize_bag;
  if bag is null then return public.contest_pick_prize(p_adult); end if;     -- a group from before 0051
  for i in 1..coalesce(array_length(bag, 1), 0) loop
    select * into one from public.contest_prizes where id = bag[i];
    if one.id is null or not one.active then dead := dead || i;
    elsif p_adult or not one.adults_only then ok := ok || i; end if;
  end loop;
  if coalesce(array_length(ok, 1), 0) > 0 then
    k := ok[public.contest_rand_int(array_length(ok, 1))];
    select * into prz from public.contest_prizes where id = bag[k];
    update public.contest_blocks set prize_bag = bag[1:k-1] || bag[k+1:] where id = blk.id;
    return prz;
  end if;
  -- A prize switched off since the group opened: its slip goes on something this winner may have.
  if coalesce(array_length(dead, 1), 0) > 0 then
    prz := public.contest_pick_prize(p_adult);
    if prz.id is not null then
      k := dead[1];
      update public.contest_blocks set prize_bag = bag[1:k-1] || bag[k+1:] where id = blk.id;
    end if;
    return prz;
  end if;
  -- An empty bag (no active prizes when the group opened, or more wins than slips): pick as before.
  if coalesce(array_length(bag, 1), 0) = 0 then return public.contest_pick_prize(p_adult); end if;
  return null;          -- only 18+ slips are left and this winner is under 18: the slip waits
end $fn$;

-- ============================================================================
-- 3) A win going back to a later spin takes its slip with it
-- ============================================================================
-- p_prize: the slip being returned (a forfeited prize). NULL: the win was never given out (a winner
-- under 18 with only 18+ slips left), so its slip is still in the group's bag.
drop function if exists public.contest_requeue_win(uuid, uuid);
create or replace function public.contest_requeue_win(p_period uuid, p_block uuid, p_prize uuid default null) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare per public.contest_periods; blk public.contest_blocks; add integer[]; k integer; slip uuid;
begin
  select * into per from public.contest_periods where id = p_period for update;
  if per.forfeit_mode <> 'return' then return false; end if;
  if p_block is not null then
    select * into blk from public.contest_blocks where id = p_block for update;
    if blk.closed_at is null and blk.spins_taken < blk.size then
      add := public.contest_pick_positions(blk.spins_taken + 1, blk.size, 1, blk.winning_positions);
      if array_length(add, 1) = 1 then
        update public.contest_blocks
           set winning_positions = (select array_agg(x order by x) from unnest(winning_positions || add) x),
               prize_bag = case when p_prize is not null and prize_bag is not null then prize_bag || p_prize else prize_bag end
         where id = blk.id;
        return true;
      end if;
    end if;
  end if;
  -- No room left in the group: the win, and its slip, are owed to the next group.
  slip := p_prize;
  if slip is null and blk.id is not null and coalesce(array_length(blk.prize_bag, 1), 0) > 0 then
    k := public.contest_rand_int(array_length(blk.prize_bag, 1));
    slip := blk.prize_bag[k];
    update public.contest_blocks set prize_bag = prize_bag[1:k-1] || prize_bag[k+1:] where id = blk.id;
  end if;
  update public.contest_periods
     set carry_wins = carry_wins + 1,
         carry_prizes = case when slip is not null then carry_prizes || slip else carry_prizes end
   where id = per.id;
  return true;
end $fn$;

create or replace function public.contest_return_win(p_claim uuid) returns boolean
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare cl public.contest_claims;
begin
  select * into cl from public.contest_claims where id = p_claim;
  if not found then return false; end if;
  return public.contest_requeue_win(cl.period_id, cl.block_id, cl.prize_id);
end $fn$;

-- ============================================================================
-- 4) The spin: a new group gets its bag; a win takes a slip
-- ============================================================================
create or replace function public.contest_spin(p_customer uuid, p_ip text default null, p_ua text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  c public.customers; per public.contest_periods; blk public.contest_blocks;
  last_at timestamptz; pos integer; won boolean; prz public.contest_prizes;
  spin_id uuid; claim_id uuid; missing text[];
  total integer; npos integer; carried uuid[]; bag uuid[];
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
    -- The group's wins (its own plus any owed) and one slip for each: owed slips first, the group's
    -- own from the prizes' numbers, and slips made up for owed wins that came without one.
    total := per.wins_per_block + per.carry_wins;
    carried := coalesce(per.carry_prizes, '{}');
    carried := carried[1:per.carry_wins];
    bag := public.contest_shuffle(carried || public.contest_make_bag(per.wins_per_block)
             || public.contest_make_bag(per.carry_wins - coalesce(array_length(carried, 1), 0)));
    npos := least(total, per.block_size);
    insert into public.contest_blocks (period_id, seq, size, winning_positions, prize_bag)
    values (per.id,
            coalesce((select max(seq) from public.contest_blocks where period_id = per.id), 0) + 1,
            per.block_size,
            public.contest_pick_positions(1, per.block_size, npos, '{}'),
            coalesce(bag[1:npos], '{}'))
    returning * into blk;
    -- Owed wins that did not fit stay owed to the next group, with their slips.
    update public.contest_periods
       set carry_wins = total - coalesce(array_length(blk.winning_positions, 1), 0),
           carry_prizes = coalesce(bag[npos+1:], '{}')
     where id = per.id;
  end if;

  pos := blk.spins_taken + 1;
  won := pos = any(blk.winning_positions);
  update public.contest_blocks
     set spins_taken = pos, closed_at = case when pos >= size then now() end
   where id = blk.id;

  if won then
    prz := public.contest_take_prize(blk.id, public.contest_is_adult(c.date_of_birth));
    -- Nothing this entrant may have (under 18 and only 18+ slips are left, or no prizes at all): no
    -- win for them, and the win — with its slip — goes back to a later spin.
    if prz.id is null then
      won := false;
      perform public.contest_requeue_win(per.id, blk.id, null);
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
-- 5) The end-of-period draw hands out the slips still owed; carrying moves them on
-- ============================================================================
create or replace function public.contest_resolve_period(p_period uuid, p_mode text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $fn$
declare
  per public.contest_periods; nxt public.contest_periods; n integer; blk public.contest_blocks;
  pool uuid[]; picks integer[]; i integer; prz public.contest_prizes; one public.contest_prizes;
  drawn integer := 0; dob date; slips uuid[]; ok integer[]; s integer; k integer; adult boolean;
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
  select * into blk from public.contest_blocks where period_id = per.id order by seq desc limit 1 for update;
  -- The slips still owed: what is left in the last group's bag, and any owed to a next group.
  slips := coalesce(blk.prize_bag, '{}') || coalesce(per.carry_prizes, '{}');

  if p_mode = 'carry' then
    -- The next period still to run: carrying into one that has already ended would lose the wins.
    select * into nxt from public.contest_periods
     where starts_at >= per.ends_at and ends_at > now() order by starts_at limit 1 for update;
    if nxt.id is null then raise exception 'Create the next period first, then carry the prizes into it.'; end if;
    update public.contest_periods set carry_wins = carry_wins + n, carry_prizes = carry_prizes || slips[1:n] where id = nxt.id;
    update public.contest_blocks set prize_bag = '{}' where id = blk.id and prize_bag is not null;
    update public.contest_periods
       set resolved_at = now(), resolved_by = public.rbac_uid(), carry_prizes = '{}',
           resolution = format('carried %s to %s', n, nxt.name)
     where id = per.id;
    return jsonb_build_object('ok', true, 'carried', n, 'to', nxt.name);
  end if;

  -- Draw: distinct customers among the last block's spins that did not win, in random order;
  -- each drawn entrant gets a slip they may have (or, with none left, a prize by the numbers), and
  -- one with nothing to give is passed over.
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
    adult := public.contest_is_adult(dob);
    ok := '{}';
    for s in 1..coalesce(array_length(slips, 1), 0) loop
      select * into one from public.contest_prizes where id = slips[s];
      if one.id is not null and one.active and (adult or not one.adults_only) then ok := ok || s; end if;
    end loop;
    if coalesce(array_length(ok, 1), 0) > 0 then
      k := ok[public.contest_rand_int(array_length(ok, 1))];
      select * into prz from public.contest_prizes where id = slips[k];
      slips := slips[1:k-1] || slips[k+1:];
    else
      prz := public.contest_pick_prize(adult);
    end if;
    continue when prz.id is null;
    insert into public.contest_claims (customer_id, period_id, block_id, source, prize_id,
      prize_name, prize_description, prize_kind, prize_value_cents, prize_adults_only)
    values (pool[i], per.id, blk.id, 'draw', prz.id,
      prz.name, prz.description, prz.kind, prz.value_cents, prz.adults_only);
    drawn := drawn + 1;
  end loop;
  update public.contest_blocks set prize_bag = '{}' where id = blk.id and prize_bag is not null;
  update public.contest_periods
     set resolved_at = now(), resolved_by = public.rbac_uid(), carry_wins = 0, carry_prizes = '{}',
         resolution = format('drew %s of %s from the last block', drawn, n)
   where id = per.id;
  return jsonb_build_object('ok', true, 'drawn', drawn, 'unawarded', n);
end $fn$;

-- ============================================================================
-- 6) Execute rights
-- ============================================================================
revoke all on function public.contest_make_bag(integer)                   from public, anon, authenticated;
revoke all on function public.contest_shuffle(uuid[])                     from public, anon, authenticated;
revoke all on function public.contest_take_prize(uuid, boolean)           from public, anon, authenticated;
revoke all on function public.contest_requeue_win(uuid, uuid, uuid)       from public, anon, authenticated;
revoke all on function public.contest_return_win(uuid)                    from public, anon, authenticated;
revoke all on function public.contest_spin(uuid, text, text)              from public, anon, authenticated;
revoke all on function public.contest_resolve_period(uuid, text)          from public, anon;
grant execute on function public.contest_resolve_period(uuid, text) to authenticated;
grant execute on function public.contest_spin(uuid, text, text)     to service_role;

do $$ begin
  raise notice '0051 applied: every group of spins hands out exactly the prizes set for it.';
end $$;
