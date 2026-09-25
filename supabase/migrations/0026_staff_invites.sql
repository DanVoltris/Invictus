-- Invictus Golf — staff invites, and closing the bootstrap to customer accounts (migration 0026)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- ============================================================================
-- WHY
-- ============================================================================
-- 1) CLOSES A HOLE. staff_role() (0024, guarantee G3) treats ANY signed-in user as an admin while
--    no active admin exists, on the stated assumption that "this database has no public sign-up".
--    Migration 0025 added public customer sign-up. On a fresh database — exactly the state of a new
--    project — the first customer to make an account on the website would become an admin: refunds,
--    rates, the customer list, staff. The bootstrap now skips customer accounts, and anyone who
--    already has a staff row (a suspended employee stays suspended).
--
-- 2) THE OWNER is murad@voltrisai.com, and becomes an admin the moment that login is created, so the
--    bootstrap closes on the owner's first sign-in instead of staying open until somebody adds an
--    admin row by hand. More admins are added from the portal's Staff tab like any other employee.
--
-- 3) Employees are now invited from the Staff tab (api/staff.js creates the login and the staff row
--    together), so nothing here changes the staff table itself.

-- ============================================================================
-- 1) staff_role() — the bootstrap no longer admits customers.
-- ============================================================================
-- Same contract as 0024: the role of the signed-in user, or null. `create or replace` keeps the
-- existing grant to authenticated and every policy that calls it.
create or replace function public.staff_role() returns text
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare v_uid uuid; v_role text; v_customer boolean := false;
begin
  v_uid := public.rbac_uid();
  if v_uid is null then return null; end if;

  select role into v_role from public.staff where user_id = v_uid and is_active;
  if v_role is not null then return v_role; end if;

  -- The bootstrap (0024 G3): nobody is an admin yet, so whoever signs in can set the system up.
  if exists (select 1 from public.staff where role = 'admin' and is_active) then return null; end if;
  -- ...but not somebody the staff table already knows about (suspended, or not an admin)...
  if exists (select 1 from public.staff where user_id = v_uid) then return null; end if;
  -- ...and never a customer. Two checks, because api/account.js creates the login a moment before
  -- it links the customer row: the metadata covers that gap, the link covers everything else.
  -- Dynamic SQL so this still compiles on a database without 0025 or without GoTrue; if either
  -- lookup fails for any reason the answer is "no", not "admin".
  begin
    if to_regclass('auth.users') is not null then
      execute $q$select exists (select 1 from auth.users
                                where id = $1 and raw_user_meta_data ->> 'source' = 'customer_signup')$q$
        into v_customer using v_uid;
      if v_customer then return null; end if;
    end if;
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'customers' and column_name = 'user_id') then
      execute 'select exists (select 1 from public.customers where user_id = $1)' into v_customer using v_uid;
      if v_customer then return null; end if;
    end if;
  exception when others then
    return null;
  end;

  return 'admin';
end $fn$;

-- ============================================================================
-- 2) The owner email.
-- ============================================================================
-- Only replaces the placeholder 0024 shipped with, so an owner email somebody has already set on
-- purpose is left alone on a re-run.
update public.settings
   set staff = coalesce(staff, '{}'::jsonb) || jsonb_build_object('owner_email', 'murad@voltrisai.com')
 where id = 1
   and coalesce(nullif(staff ->> 'owner_email', ''), 'john@gmail.com') = 'john@gmail.com';

-- ============================================================================
-- 3) The owner is an admin from the moment the login exists.
-- ============================================================================
-- A trigger on auth.users, which every login goes through — the Supabase dashboard, an invite from
-- the Staff tab, a customer sign-up. It must NEVER stop a login from being created, so any failure
-- is logged and swallowed.
create or replace function public.staff_claim_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_owner text;
begin
  select nullif(staff ->> 'owner_email', '') into v_owner from public.settings where id = 1;
  if v_owner is not null and new.email is not null and lower(new.email) = lower(v_owner) then
    insert into public.staff (user_id, email, role, is_active, note)
    values (new.id, new.email, 'admin', true, 'owner account — made admin when the login was created (0026)')
    on conflict (user_id) do update
      set role = 'admin', is_active = true, email = excluded.email, updated_at = now();
  end if;
  return new;
exception when others then
  raise warning 'staff_claim_owner: % — the login was still created', sqlerrm;
  return new;
end $fn$;

do $$
begin
  if to_regclass('auth.users') is null then
    raise notice '0026: no auth.users table here — skipping the owner trigger.';
    return;
  end if;
  execute 'drop trigger if exists staff_claim_owner on auth.users';
  execute 'create trigger staff_claim_owner after insert on auth.users
             for each row execute function public.staff_claim_owner()';
exception when others then
  raise notice '0026: could not add the owner trigger (%). Re-run this file after the owner login exists instead.', sqlerrm;
end $$;

-- If the owner login already exists, make it an admin now (0024's G2, with the new email).
do $$
declare v_owner text; n integer;
begin
  if to_regclass('auth.users') is null then return; end if;
  select nullif(staff ->> 'owner_email', '') into v_owner from public.settings where id = 1;
  if v_owner is null then return; end if;
  insert into public.staff (user_id, email, role, is_active, note)
  select u.id, u.email, 'admin', true, 'owner account — confirmed as admin by migration 0026'
    from auth.users u
   where lower(u.email) = lower(v_owner)
  on conflict (user_id) do update
    set role = 'admin', is_active = true, email = excluded.email, updated_at = now();
  get diagnostics n = row_count;
  raise notice '0026: owner % — %', v_owner,
    case when n = 0 then 'no login yet; becomes admin automatically when it is created' else 'active admin' end;
exception when others then
  raise notice '0026: could not confirm the owner row (%).', sqlerrm;
end $$;
