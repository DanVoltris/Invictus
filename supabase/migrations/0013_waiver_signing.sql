-- Invictus Golf — customer-signed waiver
-- Lets a customer sign the participant waiver online (clickwrap: typed name + "I agree").
-- Reuses the existing waiver_code + waiver_signed_at columns (migration 0008) and adds the
-- signer's typed name and the waiver version they agreed to. Per the waiver's clause 12 the
-- signature is per-customer and covers all future visits, so it lives on the customer row.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.

alter table public.customers add column if not exists waiver_name    text;   -- the name they typed when signing
alter table public.customers add column if not exists waiver_version text;   -- e.g. 'v2' — which waiver text they agreed to
