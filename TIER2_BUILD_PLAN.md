<!-- Generated 2026-08-18 by a 9-agent research pass over the Tier 2 feature set.
     Claims marked 'verified' were independently re-checked against the tree. -->

# Invictus Golf — Consolidated Build Plan

*Eight L-sized proposals, one codebase of ~7,100 lines. What follows is the order I'd build them in, what has to be shared, and where the research is wrong.*

---

## 1. The three facts that dictate everything

I verified these against the tree before writing the plan.

**(a) Six of the eight reports each claim "the last Vercel Hobby function slot."** `api/` holds exactly 11 handlers; the Hobby cap is 12. Collectively the reports are proposing seven new endpoints into one slot. Every one of them responds by contorting a feature into a `?action=` megafile. This is bad reasoning twice over: the cap costs $20/month to remove on a system that will process real bookings, and `api/availability.js`, `api/create-payment-intent.js`, `api/release-hold.js` and `api/confirm-booking.js` are one coherent checkout flow that should have been one module regardless. **Consolidate those four into `api/checkout.js` (11 → 8) and budget for Pro.** Do not let a platform tier define module boundaries for the next six features.

**(b) `server.js` contains hand-copied duplicates of `api/create-payment-intent.js` (lines 155–200) and `api/webhook.js` (lines 37–84), while already delegating five other handlers correctly.** Every single one of the eight features edits one or both. This is the highest-leverage fix in the entire plan and it is roughly half a day: delete both blocks, mount the shared handlers as lines 103–108 already do. Until this lands, every feature is a two-place edit with a silent-drift failure mode where local dev prices differently from production.

**(c) The anon-read exposure is live today and the fix is free.** `supabase/setup.sql` grants `for select using (true)` — i.e. to the `anon` role — on `settings`, `memberships`, `price_templates`, `hour_cards`, `hour_transactions`, `point_transactions`, `schedule_overrides`, `schedule_templates`, `booking_statuses`, `bay_categories`, `tags`. `/api/config` hands that anon key to every visitor. The two ledgers expose `customer_id`, balances and notes like `Booking 2026-08-20`. Critically — and this is the part no report checked — **`grep -l createClient demo/*.html` returns only `admin.html`**, which authenticates first. No public page reads Supabase directly. So narrowing those policies to `authenticated` breaks nothing and can ship in week one, decoupled entirely from the L-sized RBAC feature it was bundled into.

---

## 2. Build order

### Phase 0 — Foundations (~1.5 weeks, no user-visible feature)

| # | Work | Why first |
|---|---|---|
| 0.1 | Delete the `server.js` webhook + PI duplicates; delegate to the `api/` handlers | Removes the drift trap from all eight features |
| 0.2 | Merge availability / create-PI / release-hold / confirm-booking into `api/checkout.js`; upgrade to Vercel Pro | Frees the budget six features are fighting over |
| 0.3 | Migration **0018**: narrow anon SELECT policies; add `stripe_events` dedup table | Closes a live PII exposure; webhook idempotency is global, not subscription-specific |
| 0.4 | Single `stripeClient(env)` in `lib/booking.js` with a pinned `apiVersion`; make `STRIPE_WEBHOOK_SECRET` mandatory; parameterise the live-key refusal in `stripeStatus()` | Five files do bare `new Stripe(key)`. The subscription report's API-version trap is real and under-weighted: Basil moved `subscription.current_period_end`, so a version mismatch writes `membership_expires: null` for **every member at once**. `package.json` pins `stripe: ^17.5.0` — check the lockfile and pin explicitly in code *and* on the endpoint. |
| 0.5 | `npm run build:schema` regenerating `supabase/setup.sql` from `schema.sql + migrations/*` | `setup.sql` is the documented install path and is currently hand-maintained. Nine more migrations are coming. |
| 0.6 | Extract the fulfilment logic out of `api/webhook.js` + `api/confirm-booking.js` into `lib/fulfil.js`, dispatching on `metadata.kind` | Subscriptions, gift cards, groups, waitlist and promos each add a branch here. One dispatch table, one case per feature. |

### Phase 1 — The keystone (~1 week)

**1.1 Apply `memberships.discount_pct` and build the single price waterfall.** Confirmed by grep: `discount_pct` appears in the plan editor, in `DEMO_MEMBERSHIPS`, on the marketing page (`membership.html:101`) and in the `select` in `api/membership.js` — and **nowhere in the pricing path**. The venue advertises a benefit it does not deliver.

Three separate reports propose three different names for the same function (`settleBooking`, `quoteBooking`, `membershipEntitlement`). Ship **one** pure function in `lib/booking.js`, and fix the two reports that contradict each other on ordering:

```
base (priceForBooking)
  → membership %          price reduction
  → promo (% then $)      price reduction
  → floor at 0
  → points                stored value, perishable, shop-controlled → burn first
  → gift card             stored value, permanent legal liability → burn second
  → Stripe (≥ 50¢, else route to a zero-charge booking path)
```

Called from `api/checkout.js`, `api/points.js?action=book`, `api/hour-cards.js?action=book` and the admin manual-booking path. Stamp `member_discount_pct` and `membership_id_at_booking` onto the booking row at pay time so a lapse three weeks later can never reprice past play.

**1.2 Migration 0019 — the shared booking columns.** Five features independently propose columns on `bookings`. Add them once: `customer_id` (+ backfill via `normPhone`), `players`, `list_price_cents`, `refunded_cents`, `member_discount_pct`, `membership_id_at_booking`, `discount_cents`. Plus `booking_statuses.outcome`, the unified `payments` table, `hour_transactions.amount_cents`, and a shared `refunds` table.

**1.3 Fix `membershipExpiryISO('month')` now.** Verified: `Date.UTC(2026, 1, 31)` → 2026-03-03. Thirty-one free days for anyone buying on the 31st. Three lines, even though subscriptions will supersede it.

### Phase 2 — First shippable feature: Operator Dashboard v1 (~2 weeks)

Read-only, zero Stripe dependency, zero legal dependency, zero email dependency, and it is the feature that tells the operator which of the remaining six to fund. With 1.2 landed, no-show rate, member mix, repeat rate and RevPABH are all honest. Extract `weeklyStatusAt` into `demo/assets/analytics.js` as part of this — it currently exists twice (`lib/booking.js` and `admin.html:2184`) and a third copy is guaranteed otherwise.

Non-negotiable: the prime-time toggle. 6 bays × 24h = 144 bay-hours/day means honest utilisation reads ~12% against a 40–70% industry benchmark. Ship both numbers or the operator concludes the dashboard is broken.

### Phase 3 — Notification infrastructure (~1.5 weeks + calendar time)

See §6. Ship the outbox with **booking confirmation emails** as its first consumer — the app sends nothing today, so that alone is a visible product improvement, and it proves the pipe before the waitlist bets on it.

### Phase 4 onward, in order

4. **Subscription memberships** — recurring revenue; also fixes the bug where a customer who pays and closes the tab is charged and never granted anything. Can lean on Stripe's own dunning emails, so it doesn't hard-depend on Phase 3.
5. **Gift cards** — seasonal revenue, self-contained data model, reuses the Phase-1 waterfall. Needs Phase 3 for delivery.
6. **Refunds** *(pulled out of the staff-roles feature — see §5)* — a prerequisite for both groups and gift cards.
7. **Group bookings** — largest revenue per transaction, heaviest UI surgery.
8. **Recurring bookings / leagues** — build after groups so they share `booking_series`.
9. **Promo codes** — undefinable before the waterfall exists; now trivial to slot in.
10. **Full staff RBAC + audit log** — the exposure fix already shipped in 0018. The role system matters when they hire a second employee, not before.

---

## 3. File conflict map

**`demo/admin.html` (3,147 lines) is touched by all eight features.** The registration points collide precisely:

- `TAB_IDS` / `TAB_LOADERS` (~line 988) and the `.side-nav` block (471–487): **seven new tabs** (Dashboard, Promos, Gift Cards, Waiting List, Recurring, Staff, Activity) all edit the same twenty lines.
- `renderGrid` / `cellMeta` (~2455–2540): groups (coloured rail + chip), recurring (repeat glyph), staff (permission gating), waitlist (no change).
- `openManage` (~2810): group banner, recurring three-way cancel scope, refund button, permission gating.
- `dbInsert/dbUpdate/dbDelete` (1000–1002) and `isAuthError` (952): staff roles adds `42501` handling.

**Mitigation:** before Phase 4, do a mechanical extraction pass — make the tab registry a data-driven array so a new tab is an added object plus a new `<div>`, not an edit to shared lines. Then **serialise admin.html work anyway**; two parallel branches touching this file will produce merges nobody can review.

**`demo/index.html` (1,355 lines)** — groups, gift cards, promos and waitlist all add a control to the same checkout column (~496–510) and all edit `createPI()` (~989), `mountStripe()`, and `closePayment()` (~1085). Build the applied-credit strip **once** as a loop over `[{label, amount, onRemove}]` rather than four hand-added divs, or the fourth feature will be rewriting the first three.

**`lib/db.js`** — append-only additions from every feature; low conflict. **`server.js`** — stops being a conflict site after 0.1. **`lib/booking.js`** — the waterfall is the contested surface; fix its signature in Phase 1 and everything else is additive.

**Shared data models to unify before anyone writes SQL:**

- `booking_groups.series_id` (groups) and `booking_series` (recurring) are the same concept invented twice. One table; groups references it.
- The `notifications` outbox appears in the waitlist design and is needed by gift cards, subscriptions and recurring. One table, Phase 3.
- `stripe_events` (subscriptions) belongs in Phase 0 as global webhook idempotency.
- `refunds` + `bookings.refunded_cents` + gift-card clawback + `booking_groups.amount_refunded_cents` — one ledger, migration 0019.
- `payments` (dashboard) and subscription invoice records — merge.
- Four ledger tables (`hour_transactions`, `point_transactions`, `gift_card_transactions`, `promo_redemptions`) share a shape. Keep them separate — the semantics differ — but standardise the idempotency index as `(parent_id, ref)`. Note migration 0016 used a **global** `(ref)` partial index for points; the gift-card report is right that copying that would block a second card redeeming against the same PaymentIntent.

---

## 4. Consolidated migration plan

Numbering continues from 0017. House style throughout: `if not exists`, `drop policy if exists`, safe to re-run. **Regenerate `setup.sql` after each** (0.5).

| # | Contents | Shares with |
|---|---|---|
| **0018** | Narrow anon SELECT policies; `stripe_events` dedup | Everything |
| **0019** | Shared booking columns (`customer_id` + backfill, `players`, `list_price_cents`, `refunded_cents`, `member_discount_pct`, `membership_id_at_booking`, `discount_cents`); `booking_statuses.outcome`; `payments`; `refunds`; `hour_transactions.amount_cents`; `cleanupExpiredHolds` → soft cancel | Dashboard + groups + subs + promos + analytics — **five reports proposed overlapping subsets of this; it must be one migration** |
| **0020** | `v_booking_facts` (`security_invoker = on`, revoked from anon), `booking_rollup`, `customer_rollup` | Dashboard. Separate because views/functions get re-created often |
| **0021** | Membership subscriptions: `memberships.stripe_price_id/product_id`, `customers.stripe_*`, `membership_status`, `membership_renews_at`, `membership_synced_at` | — |
| **0022** | `notifications` outbox + pg_cron schedule | Waitlist, gift cards, recurring, subs |
| **0023** | Gift cards + `gift_card_transactions` + `adjust_gift_card` + `gift_card_attempts`; `settings.gift` | Uses 0019's `refunds` |
| **0024** | Waitlist entries/offers/wakeups, triggers, `waitlist_process`; `settings.waitlist` | Uses 0022 |
| **0025** | `booking_series` + `booking_groups` + `bookings.series_id/group_id`; `confirm_group()` and `materialise_series()` | **One migration** — same tables, same "insert N booking rows atomically" primitive |
| **0026** | Promo codes + redemptions + `redeem_promo`/`release_promo` | Depends on Phase 1 waterfall |
| **0027** | `staff`, `role_permissions`, `audit_log`, RBAC policy rewrite, `adjust_*` → security definer | — |

**Every new column needs the repo's degrade-gracefully convention** (see the `expires_at` / `note` / `sms_opt_in` retry-on-missing-column fallbacks in `lib/db.js`), and **`demo/assets/demo-mode.js` must be extended in the same commit** — the no-database demo is the sales surface and it currently stubs `rpc()` to return an error.

---

## 5. Research conclusions I think are wrong or risky

**Gift cards: "debit the card at PaymentIntent creation."** The reasoning against confirm-time debit is sound, but PI-creation-time debit is *worse in this codebase specifically*: `demo/index.html` speculatively creates a PaymentIntent on every slot change and every points apply/remove, abandoning the previous one. The report notices this and proposes sweepers plus compensating credits. Simpler: **kill the speculative prefetch first** (it's a UX micro-optimisation), then reserve against the balance with a TTL matching the existing cart hold, swept by the same job. Don't bolt real money onto a known-leaky prefetch.

**Subscriptions: "the webhook becomes the sole writer; `?action=confirm` goes read-only."** Right in principle, wrong for this deployment. The repo deliberately double-covers client-confirm and webhook (`bookingExistsForPI` is the guard) precisely *because* `STRIPE_WEBHOOK_SECRET` is optional and the endpoint may not be configured at all. Making the webhook the sole grant path means a misconfigured endpoint silently grants nobody a membership, forever, with no fallback. **Keep the double-cover:** confirm may grant idempotently keyed on subscription id; the webhook is authoritative for *state transitions*. (Phase 0.4 makes the secret mandatory, which reduces but does not eliminate the risk.)

**Groups: "PostgREST sends `insert([...N rows])` as one statement, therefore atomic."** That's an implementation detail of PostgREST, not a contract, and the report reaches the *opposite* conclusion for confirmation (use plpgsql). Apply the same standard to creation. Also, the deadlock-ordering argument only holds if every writer sorts by `bay_id` — put all multi-row booking writes behind one function so that's structurally guaranteed rather than a convention.

**Refunds are misfiled.** They appear only inside the staff-roles feature, which I'm sequencing last. But partial cancellation is the *core* of group bookings and clawback is core to gift cards. Pull refunds out as an independent deliverable at #6. Note `.env.example` steers the operator toward a restricted key scoped to Checkout Sessions — it will reject `POST /v1/refunds` until `Refunds: write` + `Charges: read` are granted, and this will look like a code bug at deploy time.

**Tax is a business decision being treated as an implementation detail.** Four reports independently flag that `settings.pay.taxPct = 12` (MB GST 5% + PST 7%) is displayed in the admin receipt and never charged. Noise on a $20 booking; on a $600 six-bay event, a $150 gift card, or a $99/month subscription it is a real liability and retroactively fixing collected tax on subscriptions is painful. **This gates groups, gift cards and subscriptions and needs an owner + accountant decision before any of the three start.**

**Manitoba gift-card statute encoded as a `CHECK` constraint.** The no-expiry / no-fee analysis is probably right, but a `CHECK` constraint is an awkward place to be wrong. Get it confirmed by the owner's counsel before it becomes schema.

**Recurring `pay_mode='prepaid'`** (one Checkout Session per season) recreates exactly the partial-refund problem the report uses to reject Stripe subscriptions. Its own answer — credit back as hours via `adjust_hours` — is fine, but that's a hard design commitment (hour cards become the refund currency for leagues), not a footnote.

**Scheduling.** Three reports separately hit "Vercel Hobby cron is daily-only." One of them proposes Supabase `pg_cron` + `pg_net`. Adopt that **globally** — waitlist sweeps, series materialisation, expired-hold cleanup, subscription reconciliation — and the blocker disappears from all three at once.

---

## 6. Email and SMS: the app sends nothing at all

Confirmed: `package.json` dependencies are `@supabase/supabase-js`, `dotenv`, `express`, `stripe`. No nodemailer, no Resend, no Twilio. There is no booking confirmation email today — customers get a screen and Stripe's receipt. The "Text me updates about this booking" toggle in `demo/index.html` writes `customers.sms_opt_in` and has never sent anything.

**Hard-blocked:** waiting list (worthless without it), gift-card delivery (degrades to "code shown once, forward it yourself"), recurring/subscription dunning that isn't Stripe's own.

**Recommendation:** Resend + a verified sending domain on invictusgolfwpg.ca (SPF/DKIM), one small dependency, plus the `notifications` outbox table from the waitlist design as the shared abstraction (`dedupe_key`, `send_after`, retry, provider id). Phase 3, ~1.5 weeks.

**SMS is calendar time, not dev time.** Canadian A2P 10DLC brand/campaign registration through Twilio is days-to-weeks and gates the channel entirely. Start the paperwork the day the decision is made — it runs in parallel with everything else. Only the waitlist genuinely needs SMS (a 7pm email about a 7:30pm slot is useless); everything else ships email-only.

**CASL:** express consent captured at the point of collection (`consent_at` + `consent_ip`), separate unticked boxes for email and SMS, venue name + physical mailing address + contact in every message, working unsubscribe live for 60 days. **`customers.sms_opt_in` defaults to `true` and is therefore not consent** — do not reuse it.

---

## 7. The smallest first slice

**"Foundations, plus the membership discount the site already promises."** Roughly 2–2.5 weeks.

Contents: 0.1 (server.js delegation) · 0.2 (api consolidation + Pro) · migration 0018 (anon read tightening + `stripe_events`) · 0.4 (pinned `stripeClient`, mandatory webhook secret) · 0.5 (`build:schema`) · 1.1 (the price waterfall, with `discount_pct` actually applied) · 1.3 (`membershipExpiryISO` month-end fix).

It's the right first slice because it (a) removes the two-place-edit drift trap before seven features pile onto it, (b) closes a live PII exposure at zero UX cost, (c) fixes a silent 31-day-free-membership bug, and (d) makes a benefit the venue already advertises and charges for actually work.

**What must be true before it ships:**

1. `setup.sql` regenerated and the new build script in `package.json`, or a fresh install silently lacks 0018.
2. `demo/assets/demo-mode.js` updated so the no-database demo still renders — it's already dirty in the working tree.
3. Verified (I did): no public page reads Supabase directly, so narrowing anon SELECT is safe. Re-verify after any new page.
4. A conscious decision on the live-key gate. `stripeStatus()` refuses live keys *by design* — "this is a prototype." Phase 0.4 parameterises it; the moment it's parameterised, the rail that has been protecting the demo from charging real cards is gone. Treat flipping it as a separate, reviewed change with its own sign-off.
5. Accept, explicitly, that member identification at checkout is a typed phone/email matched by `customerHoursByContact`. A guest who types a member's phone gets the member discount. That's a $2–5 exposure and it's fine **for a discount** — it is emphatically not fine for a Stripe Billing Portal link, which is why the subscription phase must gate the portal behind the existing `waiver_code` or email the link instead of returning it in an HTTP response.
6. A regression test covering the waterfall (member + points + 50¢ floor + zero-charge path) — this function will be modified by four subsequent features and it's the only place in the system that decides what a customer pays.