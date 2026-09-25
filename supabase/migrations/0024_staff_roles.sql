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
  ('money.write',    'Money',        'Refunds, gift cards, promo codes and prepaid-hour balances, and the price on an existing booking.', 2),
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
   -- ...but NEVER a customer's login. When 0024 was written the only logins were staff. Customers
   -- have had their own accounts since 0025, and leagues (0031) ask every player to make one — so
   -- without this, re-running the file would hand the manager portal to every customer.
   where not exists (select 1 from public.customers c where c.user_id = u.id)
     and coalesce(u.raw_user_meta_data ->> 'source', '') <> 'customer_signup'
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
