-- Invictus Golf — customer accounts (migration 0025)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- ============================================================================
-- WHAT THIS REPLACES
-- ============================================================================
-- /account today asks for a phone number and nothing else. Type any customer's number and you
-- see their bookings, their points, their prepaid hours and their membership. There is no
-- password because there are no customer logins — customers exist only as rows the shop created.
--
-- This gives them real accounts: a Supabase auth user (email + password) linked to their
-- customer row, and RLS that lets each one see exactly their own data and nothing else.
--
-- ============================================================================
-- WHY A PHONE CODE, AND WHY THE ANSWER IS WITHHELD UNTIL IT IS ENTERED
-- ============================================================================
-- Customer rows were imported from GolfBooking carrying real balances. If signing up simply
-- claimed the row matching a typed phone number, then knowing somebody's number would be enough
-- to take their points, their prepaid hours and their membership discount. So the number has to
-- be PROVEN, not merely typed — a one-time code sent to it, checked before any linking happens.
--
-- Equally, "we sent you a code" must be the answer for EVERY number. Saying "no account found"
-- turns this endpoint into a directory: type numbers, learn who is a customer. So a code is
-- always issued, and whether an account exists is only disclosed once the code is verified —
-- i.e. only to somebody holding the phone.
--
-- Codes are stored HASHED. A leaked backup of this table must not be a pile of live codes.

-- ============================================================================
-- 1) THE LINK — one auth user, one customer row.
-- ============================================================================
alter table public.customers add column if not exists user_id uuid;
alter table public.customers add column if not exists account_created_at timestamptz;
-- Partial unique: many customer rows legitimately have no login, but one auth user must never
-- be attached to two of them.
create unique index if not exists customers_user_id_key on public.customers (user_id) where user_id is not null;

do $$
begin
  if to_regclass('auth.users') is not null
     and not exists (select 1 from pg_constraint
                      where conname = 'customers_user_fk' and conrelid = 'public.customers'::regclass) then
    alter table public.customers
      add constraint customers_user_fk foreign key (user_id) references auth.users (id) on delete set null;
  end if;
exception when others then
  raise notice '0025: could not add the auth.users foreign key (%). The column works without it.', sqlerrm;
end $$;

-- ============================================================================
-- 2) ONE-TIME CODES.
-- ============================================================================
-- Keyed on the E.164 phone. One live code per number: requesting again replaces the previous one,
-- so an attacker cannot bank a pile of valid codes.
create table if not exists public.phone_codes (
  phone       text primary key,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    smallint not null default 0,
  sent_count  smallint not null default 1,
  last_sent   timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists phone_codes_expiry on public.phone_codes (expires_at);

-- Short-lived proof that somebody entered the code for this number. The signup call presents this
-- instead of the code, so the code itself is used exactly once.
create table if not exists public.phone_verifications (
  token      text primary key,
  phone      text not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists phone_verifications_expiry on public.phone_verifications (expires_at);

-- Failed attempts per phone AND per caller, so one number cannot be brute-forced and one caller
-- cannot sweep many numbers. Mirrors gift_card_attempts / promo_attempts from 0020 and 0021.
create table if not exists public.phone_attempts (
  id         bigint generated always as identity primary key,
  key        text not null,
  ok         boolean not null default false,
  at         timestamptz not null default now()
);
create index if not exists phone_attempts_key on public.phone_attempts (key, at desc);

-- ============================================================================
-- 2b) PHONE NORMALISATION — one definition, used by the policy above.
-- ============================================================================
-- lib/db.js normalises phones in JavaScript ("(204) 990-6530" and "+12049906530" are the same
-- person). The booking policy needs the same rule in SQL or it would miss a customer's own
-- bookings purely because of formatting.
create or replace function public.norm_phone(p text) returns text
language sql immutable as $fn$
  select nullif(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '')
$fn$;
grant execute on function public.norm_phone(text) to authenticated;

-- ============================================================================
-- 3) RLS — a customer sees their own row, and nothing else.
-- ============================================================================
-- Existing policies from 0024 are staff-only (they test staff_role()/staff_can()). A customer is
-- authenticated but not staff, so today they get nothing at all — verified before this migration
-- was written. These policies are additive: Postgres ORs permissive policies together, so a
-- customer gains access to their own row without widening anything for anyone else.
--
-- IMPORTANT: `using` matches on user_id = the caller's JWT subject. It never matches on phone or
-- email, which a caller controls. The only way to be attached to a row is through the verified
-- signup path in api/account.js.

create or replace function public.customer_id_for_caller() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_uid uuid; v_id uuid;
begin
  v_uid := public.rbac_uid();          -- from 0024; null when there is no JWT subject
  if v_uid is null then return null; end if;
  select id into v_id from public.customers where user_id = v_uid;
  return v_id;
end $fn$;
grant execute on function public.customer_id_for_caller() to authenticated;

drop policy if exists customers_self_read  on public.customers;
create policy customers_self_read on public.customers
  for select to authenticated
  using (user_id is not null and user_id = (select public.rbac_uid()));

-- A customer may correct their own name, email and SMS preference. Deliberately NOT
-- points_balance, hours_balance_min, membership_id or membership_expires: those are the shop's
-- to set, and 0024's money guard already refuses them to anyone without money.write.
drop policy if exists customers_self_update on public.customers;
create policy customers_self_update on public.customers
  for update to authenticated
  using (user_id is not null and user_id = (select public.rbac_uid()))
  with check (user_id is not null and user_id = (select public.rbac_uid()));

create or replace function public.customer_guard_self_columns() returns trigger
language plpgsql as $fn$
begin
  -- Staff paths are unaffected: money.write covers the shop, service_role covers the server.
  if public.staff_can('money.write') then return new; end if;
  if new.points_balance    is distinct from old.points_balance
     or new.hours_balance_min is distinct from old.hours_balance_min
     or new.membership_id     is distinct from old.membership_id
     or new.membership_expires is distinct from old.membership_expires
     or new.user_id           is distinct from old.user_id then
    raise exception 'permission denied: that field is set by the shop, not by the account holder'
      using errcode = '42501';
  end if;
  return new;
end $fn$;
drop trigger if exists customer_guard_self on public.customers;
create trigger customer_guard_self before update on public.customers
  for each row execute function public.customer_guard_self_columns();

-- Their own bookings, matched through the customer row rather than through a typed email.
drop policy if exists bookings_self_read on public.bookings;
create policy bookings_self_read on public.bookings
  for select to authenticated
  using (
    exists (
      select 1 from public.customers c
       where c.user_id = (select public.rbac_uid())
         and (
           (c.email is not null and public.bookings.customer_email is not null
             and lower(c.email) = lower(public.bookings.customer_email))
           or (c.phone is not null and public.bookings.customer_phone is not null
             and public.norm_phone(c.phone) = public.norm_phone(public.bookings.customer_phone))
         )
    )
  );

-- The three code tables are server-only: RLS on, no policies. anon and authenticated get nothing;
-- the service-role key the server uses bypasses RLS and keeps working.
do $$
declare t text;
begin
  foreach t in array array['phone_codes','phone_verifications','phone_attempts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ============================================================================
-- 5) HOUSEKEEPING — expired codes are rubbish, not history.
-- ============================================================================
create or replace function public.phone_codes_sweep() returns integer
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare n integer;
begin
  delete from public.phone_codes where expires_at < now() - interval '1 hour';
  get diagnostics n = row_count;
  delete from public.phone_verifications where expires_at < now() - interval '1 day';
  delete from public.phone_attempts where at < now() - interval '7 days';
  return n;
end $fn$;
revoke all on function public.phone_codes_sweep() from public, anon;
grant execute on function public.phone_codes_sweep() to service_role;

-- Re-assert 0024's policies so the new tables are covered by the role system too.
do $$
begin
  if to_regprocedure('public.rbac_apply()') is not null then perform public.rbac_apply(); end if;
end $$;
