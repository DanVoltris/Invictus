-- Invictus Golf — notification outbox (email + SMS), CASL consent, and the stripe_events fix
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHY
-- The app has never sent a message of any kind: no booking confirmation, no reminder, nothing.
-- Several planned features (waiting list, gift-card delivery, recurring bookings, subscription
-- dunning) each need "send this person a message, exactly once, and retry if the provider is
-- down". That is one table, not four, so it lands here before the first of them is built.
--
-- The queue is an OUTBOX, not a log: a row is a message that still has to happen. lib/notify.js
-- inserts rows (enqueue) and a worker walks the due ones (sendDue). Delivery is deliberately
-- separated from the request that caused it, so a slow or broken provider can never fail a
-- customer's checkout.

-- 1) NOTIFICATIONS — the outbox. ---------------------------------------------------------
--
-- dedupe_key is the heart of the table. Every caller must supply a key that identifies the
-- message rather than the attempt ("booking.confirmed:<booking id>"), and the unique index
-- below makes a second enqueue of the same message a unique violation instead of a second
-- text message to the customer. That is what makes it safe for both the Stripe webhook and
-- the client-side confirm — the two paths this repo deliberately double-covers — to enqueue
-- the same confirmation without the customer hearing about their booking twice.
create table if not exists public.notifications (
  id                  uuid primary key default gen_random_uuid(),
  channel             text not null check (channel in ('email','sms')),
  recipient           text not null,                  -- email address or E.164 phone number
  template            text not null,                  -- key into TEMPLATES in lib/notify.js
  payload             jsonb not null default '{}'::jsonb,
  dedupe_key          text not null,
  msg_class           text not null default 'transactional'
                        check (msg_class in ('transactional','commercial')),
  status              text not null default 'queued'
                        check (status in ('queued','sent','skipped','failed')),
  customer_id         uuid references public.customers(id) on delete set null,
  send_after          timestamptz not null default now(),   -- retry backoff / scheduled sends
  attempts            smallint not null default 0,
  sent_at             timestamptz,
  last_error          text,
  provider_message_id text,                           -- Resend id / Twilio message SID
  created_at          timestamptz not null default now()
);

-- The dedupe guarantee. Deliberately global and unconditional: a message that was skipped or
-- that permanently failed must NOT be silently re-queued by a later code path either — the
-- operator decides that, by deleting the row.
create unique index if not exists notifications_dedupe on public.notifications (dedupe_key);
-- The worker's only query: "queued rows whose time has come, oldest first."
create index if not exists notifications_due on public.notifications (send_after) where status = 'queued';

-- RLS. The outbox holds customer email addresses and phone numbers, so it is manager-only,
-- same class as `customers`. The server writes it with the service-role key, which bypasses
-- RLS entirely; these policies exist for the manager portal, which may want a delivery log.
alter table public.notifications enable row level security;
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated using (true);
drop policy if exists notifications_write on public.notifications;
create policy notifications_write on public.notifications for all to authenticated using (true) with check (true);

-- 2) CASL CONSENT on customers. -----------------------------------------------------------
--
-- Canada's Anti-Spam Legislation governs every commercial electronic message sent to a
-- Canadian address. Three things it requires, and where each one lives:
--
--   (a) EXPRESS CONSENT, recorded at the point of collection, with the date and how it was
--       given. Hence <channel>_consent + _at + _ip + _source below, per channel, because
--       consent to be emailed is not consent to be texted.
--   (b) IDENTIFICATION — sender name, physical mailing address, and a way to be contacted —
--       in the message itself. That is settings.venue, section 3.
--   (c) A WORKING UNSUBSCRIBE, honoured within 10 business days and usable for at least 60
--       days after the message was sent. unsub_token is the per-customer secret in that link;
--       <channel>_unsub_at is when they withdrew.
--
-- customers.sms_opt_in (migration 0014) DEFAULTS TO TRUE, so it records nothing about what
-- the customer chose — it is a UI preference, and reusing it as consent would mean claiming
-- consent from every customer who has never seen a checkbox. It is left exactly as it is;
-- sms_consent below is the column that decides whether an SMS may be sent.
alter table public.customers add column if not exists email_consent        boolean not null default false;
alter table public.customers add column if not exists email_consent_at     timestamptz;
alter table public.customers add column if not exists email_consent_ip     text;
alter table public.customers add column if not exists email_consent_source text;   -- e.g. 'checkout', 'membership', 'manager'
alter table public.customers add column if not exists email_unsub_at       timestamptz;
alter table public.customers add column if not exists sms_consent          boolean not null default false;
alter table public.customers add column if not exists sms_consent_at       timestamptz;
alter table public.customers add column if not exists sms_consent_ip       text;
alter table public.customers add column if not exists sms_consent_source   text;
alter table public.customers add column if not exists sms_unsub_at         timestamptz;
-- The secret in an unsubscribe link. Random per customer so the link cannot be guessed or
-- walked, and stable so a link stays live long past CASL's 60-day minimum.
alter table public.customers add column if not exists unsub_token          uuid not null default gen_random_uuid();
create unique index if not exists customers_unsub_token on public.customers (unsub_token);

-- 3) SETTINGS.VENUE — the identification block CASL requires in every message. -------------
--
-- Left EMPTY on purpose. lib/notify.js refuses to send anything until name + address are
-- filled in and logs what it would have sent instead, because a message without a physical
-- mailing address is a message that should not have gone out. Nobody can guess this for the
-- owner, so the owner fills it in — run this once, with the venue's real details:
--
--   update public.settings set venue = jsonb_build_object(
--     'name',           'Invictus Golf',
--     'address',        '<street address, Winnipeg, MB  <postal code>>',
--     'phone',          '(204) 488-6177',
--     'email',          '<the address that will receive unsubscribe requests>',
--     'website',        'https://invictusgolfwpg.ca',
--     'unsubscribeUrl', '<https://…/unsubscribe — optional; the email above is used if blank>'
--   ) where id = 1;
--
-- CASL accepts EITHER a link OR an electronic address that unsubscribe requests can be sent
-- to, so 'email' alone is a compliant mechanism as long as somebody reads that inbox.
alter table public.settings add column if not exists venue jsonb not null default '{}'::jsonb;

-- 4) STRIPE_EVENTS — make the policy say what migration 0018 meant. ------------------------
--
-- 0018 created this table for global webhook idempotency, and until now nothing read or wrote
-- it: api/webhook.js is wired into it in the same change as this migration. Its comment said
-- "no read policy at all — not even for authenticated", but the policy it created was
-- "for all to authenticated", and FOR ALL includes SELECT — so the comment and the grant
-- disagreed, and the grant was the one the database enforced.
--
-- The comment described the intent correctly, so the policy is what changes: dropped, leaving
-- RLS enabled with no policies, which denies anon and authenticated everything. The webhook is
-- unaffected — it uses the service-role key, which bypasses RLS.
--
-- create-table repeated (harmlessly, "if not exists") so this migration is self-contained and
-- has something to act on even when it is applied to a database that is behind on 0018.
create table if not exists public.stripe_events (
  id          text primary key,               -- Stripe's evt_… id
  received_at timestamptz not null default now()
);
create index if not exists stripe_events_received on public.stripe_events (received_at);
alter table public.stripe_events enable row level security;
drop policy if exists stripe_events_write on public.stripe_events;
