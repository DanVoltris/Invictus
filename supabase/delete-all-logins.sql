-- =============================================================================
-- NOT A MIGRATION. Run by hand only, and only when you mean it.
-- Kept out of supabase/migrations/ on purpose: everything in that folder is bundled into
-- setup.sql, and this must never run as part of setting up or re-running a database.
-- =============================================================================
-- Invictus Golf: delete EVERY login (staff and customers). CANNOT BE UNDONE.
-- Kept: customer records, bookings, points, prepaid hours, memberships. Only the sign-ins go.
begin;
  -- Normally refuses to remove the last admin; off for this one transaction only.
  alter table public.staff disable trigger staff_keep_one_admin;
  delete from public.staff;
  update public.customers set user_id = null, account_created_at = null where user_id is not null;
  delete from auth.users;
  alter table public.staff enable trigger staff_keep_one_admin;
commit;

-- Check: all three should be 0.
select (select count(*) from auth.users)                                   as logins,
       (select count(*) from public.staff)                                 as staff,
       (select count(*) from public.customers where user_id is not null)   as linked_customers;
