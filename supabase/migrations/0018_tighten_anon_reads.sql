-- Invictus Golf — narrow the public-read policies + webhook idempotency
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHY
-- Eleven tables were created with "for select using (true)". A policy with no "to" clause
-- applies to PUBLIC, which includes the `anon` role — and /api/config hands the anon key to
-- every visitor of the site. So today an anonymous browser can read every one of them.
--
-- WHAT ACTUALLY NEEDS ANON SELECT: nothing.
--   · The server (server.js + api/*) uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS
--     entirely — every public page gets its data through an endpoint, already sanitized.
--   · `grep -l createClient demo/*.html` returns only demo/admin.html, and that page signs in
--     with email/password before it reads anything, so it holds an `authenticated` JWT.
--   · The anon key is still needed for auth.signInWithPassword(); logging in does not go
--     through RLS, so narrowing these policies does not affect the manager login.
-- Re-verify point two after adding any new public page that talks to Supabase directly.
--
-- Per-table reasoning is inline below. Every table keeps its existing
-- "<table>_write ... for all to authenticated" policy unchanged; only SELECT is narrowed.

-- 1) Tables whose read policy was created inline, one statement each. -----------------

-- settings: internal configuration, not public content — rates and bay_rates (the venue's
-- price list before discounts), pay (tax %, capture method, legal disclaimers), weekly_status
-- and online_status_label. The booking page receives the slice it needs from the server.
drop policy if exists settings_read on public.settings;
create policy settings_read on public.settings for select to authenticated using (true);

-- memberships: plan names and prices are public on membership.html — but that page renders
-- from /api/membership (service-role), never from Supabase directly, and discount_pct is the
-- input to the pricing waterfall, which is not something a customer should be able to enumerate.
drop policy if exists memberships_read on public.memberships;
create policy memberships_read on public.memberships for select to authenticated using (true);

-- price_templates: seasonal pricing presets, including rates that are not currently live.
-- Purely an internal planning tool in the manager portal; no public page has ever read it.
drop policy if exists price_templates_read on public.price_templates;
create policy price_templates_read on public.price_templates for select to authenticated using (true);

-- point_transactions: the loyalty ledger — customer_id, point balances, staff notes and the
-- Stripe PaymentIntent id in `ref`. This is customer data and the clearest exposure of the set.
drop policy if exists point_transactions_read on public.point_transactions;
create policy point_transactions_read on public.point_transactions for select to authenticated using (true);

-- 2) Tables whose read policy was created by a do-block loop (migrations 0001 and 0015).
--    Same loop shape, so re-running this migration is as safe as re-running those. ------

-- bay_categories      internal simulator/room taxonomy used by the manager's bay editor.
-- schedule_overrides  date-specific closures and special hours, with internal notes; the public
--                     booking page sees the *result* as availability, never the override rows.
-- schedule_templates  reusable opening-hours presets — an internal planning tool.
-- booking_statuses    internal workflow labels (No-show, Maintenance…) and their colours.
-- tags                internal labels staff attach to reservations (VIP, Walk-in…).
-- hour_cards          prepaid package list; the purchase page gets it from the server.
-- hour_transactions   the prepaid-time ledger — customer_id, minute balances and notes such as
--                     "Booking 2026-08-20". Customer data, same class as point_transactions.
do $$
declare t text;
begin
  foreach t in array array['bay_categories','schedule_overrides','schedule_templates','booking_statuses','tags','hour_cards','hour_transactions']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select to authenticated using (true)', t, t);
  end loop;
end $$;

-- Not touched, because they were already correct: `bookings` and `customers` have only an
-- admin-scoped "for all to authenticated" policy and never had a public read policy.

-- 3) STRIPE EVENTS — global webhook idempotency. ------------------------------------
-- Stripe retries a webhook until it gets a 2xx, and the same event can also arrive twice on
-- purpose. Every fulfilment path (bookings today; subscriptions, gift cards and refunds later)
-- needs the same answer to "have I already processed this event?", so the record is one table
-- keyed on Stripe's own event id rather than a per-feature column. Insert the id first: a
-- duplicate raises a unique-violation, which is the signal to skip the work and return 200.
create table if not exists public.stripe_events (
  id          text primary key,               -- Stripe's evt_… id
  received_at timestamptz not null default now()
);
-- Supports pruning old rows; this table only ever grows otherwise.
create index if not exists stripe_events_received on public.stripe_events (received_at);

-- RLS: written only by the webhook, which uses the service-role key and bypasses RLS.
-- No read policy at all — not even for `authenticated`; nothing in the manager portal reads it.
alter table public.stripe_events enable row level security;
drop policy if exists stripe_events_write on public.stripe_events;
create policy stripe_events_write on public.stripe_events for all to authenticated using (true) with check (true);
