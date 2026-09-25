-- Invictus Golf — waiting list: entries, exclusive offers, and the triggers that fire them
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHAT THIS IS
-- A customer asks for a time that is already taken. Instead of losing them, we record what they
-- want (date, bay preference, time window, how long) and watch for that time to come free. Three
-- things free a slot in this system and all three are covered here by database triggers, because
-- two of them never pass through an API route at all:
--
--   1. a booking is CANCELLED          — api/booking.js, or a manager in demo/admin.html
--   2. a cart HOLD EXPIRES or is released — lib/db.js cleanupExpiredHolds() / releaseHold()
--   3. a schedule OVERRIDE IS REMOVED   — a manager deleting a closure/maintenance block, which
--                                         is a direct PostgREST delete from the manager portal
--
-- A trigger on each writes a row into waitlist_wakeups: "this exact slot may now be free". The
-- sweep (waitlist_process) drains that queue.
--
-- THE ONE RULE THAT MAKES THIS A FEATURE RATHER THAN A STAMPEDE
-- When a slot frees, exactly ONE waiting customer is told, and they get an EXCLUSIVE window
-- (default 15 minutes) to take it before anybody else on the list hears about it. Texting six
-- people about one bay produces five people who feel cheated and one booking that would probably
-- have happened anyway. Three separate mechanisms enforce the exclusivity, deliberately
-- overlapping, because this is the part that cannot be allowed to fail:
--
--   (a) a partial UNIQUE INDEX on (date, bay, start, end) where status = 'offered' — the database
--       physically cannot hold two live offers for the same slot;
--   (b) a real 'held' row in public.bookings for the length of the claim window (settings knob
--       waitlist.holdSlot, on by default), so the slot is genuinely reserved — the existing
--       bookings_no_overlap exclusion constraint makes that insert the atomic proof that the slot
--       was free, and availability already renders 'held' as busy;
--   (c) pg_try_advisory_xact_lock around the whole sweep, so two overlapping cron runs cannot
--       both offer the same slot — the second run finds the lock taken and returns immediately.
--
-- QUIET HOURS. The venue is open 24 hours. A text message at 3am is not a courtesy, and a claim
-- window that opens while the customer is asleep wastes the slot as well as the goodwill. During
-- quiet hours the sweep processes nothing and LEAVES the wakeups queued, so the slot is offered
-- the moment the window opens. Configurable in settings.waitlist — never hardcoded (§2).
--
-- SCHEDULING. Vercel Hobby cron is daily-only, which is useless for a claim window measured in
-- minutes, so the sweep is driven by pg_cron + pg_net inside Postgres — see §10 and the helper
-- public.waitlist_schedule_sweep(). Any external cron hitting POST /api/waitlist?action=sweep
-- works just as well; nothing below depends on which one you use.

-- 1) THE THREE TABLES. ----------------------------------------------------------------------

-- (a) ENTRIES — who is waiting, and for what.
--
-- customer_key is the dedupe identity: the normalized phone (or lowercased email) the customer
-- typed, the same key promo_redemptions uses (migration 0021), NOT customers.id — somebody
-- joining a waiting list may never have booked before and so has no customer row yet.
--
-- email_ok / sms_ok are CASL EXPRESS CONSENT for this specific purpose, captured at the point of
-- collection along with consent_at + consent_ip. An entry with neither flag set is never offered
-- anything: there would be no way to tell them, and an offer nobody is told about silently burns
-- the slot for the length of the claim window. api/waitlist.js also mirrors the consent onto
-- public.customers (migration 0019), which is where lib/notify.js enforces it at send time.
create table if not exists public.waitlist_entries (
  id               uuid primary key default gen_random_uuid(),
  -- The secret in the customer's own "you're on the list / take me off it" link. Random so it
  -- cannot be guessed or walked, exactly like customers.unsub_token in migration 0019.
  token            uuid not null default gen_random_uuid(),
  customer_id      uuid references public.customers(id) on delete set null,
  customer_key     text not null,
  name             text,
  email            text,
  phone            text,
  email_ok         boolean not null default false,
  sms_ok           boolean not null default false,
  consent_at       timestamptz,
  consent_ip       text,

  booking_date     date not null,
  -- Bay preference. Empty array = "any bay", matching how bay_ids already works on
  -- schedule_overrides (0007) and promos (0021), so the manager UI can reuse the same control.
  bay_ids          text[]   not null default '{}',
  -- The window they are available in, and how long they actually want. A 7am–11am window with a
  -- 60-minute duration means "any hour in there" — the offer is one duration-long slot inside it,
  -- never the whole window, or a four-hour cancellation would hold four hours for one player.
  window_start_min smallint not null default 0,
  window_end_min   smallint not null default 1440,
  duration_min     smallint not null default 60,
  players          smallint,
  note             text,

  status           text not null default 'active'
                     check (status in ('active','offered','claimed','cancelled','expired')),
  offers_sent      smallint not null default 0,
  last_offer_at    timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint waitlist_entries_window  check (window_end_min > window_start_min),
  constraint waitlist_entries_bounds  check (window_start_min >= 0 and window_end_min <= 1440),
  constraint waitlist_entries_duration check (duration_min >= 15 and duration_min <= window_end_min - window_start_min)
);
create unique index if not exists waitlist_entries_token on public.waitlist_entries (token);
-- The queue order is first-come, first-served, per day.
create index if not exists waitlist_entries_match on public.waitlist_entries (booking_date, status, created_at);
-- One live entry per customer per day+window: re-submitting the same request returns the entry
-- they already have instead of quietly putting them on the list twice and offering them the same
-- slot twice. A different window on the same day is a different request and is allowed.
create unique index if not exists waitlist_entries_live
  on public.waitlist_entries (customer_key, booking_date, window_start_min, window_end_min)
  where status in ('active','offered');

-- (b) OFFERS — one slot, offered to one entry, with a deadline.
create table if not exists public.waitlist_offers (
  id              uuid primary key default gen_random_uuid(),
  entry_id        uuid not null references public.waitlist_entries(id) on delete cascade,
  -- The secret in the claim link. This is the only thing standing between the offer and whoever
  -- else has the URL, so it is a uuid, it is never logged, and it dies with the offer.
  claim_token     uuid not null default gen_random_uuid(),
  booking_date    date     not null,
  bay_id          text     not null,
  start_min       smallint not null,
  end_min         smallint not null,
  status          text not null default 'offered'
                    check (status in ('offered','claimed','declined','expired','cancelled')),
  reason          text,                    -- what freed the slot: booking_cancelled | hold_expired | …
  -- The 'held' bookings row reserving the slot for the length of the claim window, when
  -- settings.waitlist.holdSlot is on. Null means the slot was offered without being held.
  hold_booking_id uuid,
  expires_at      timestamptz not null,    -- the end of the exclusive claim window
  offered_at      timestamptz not null default now(),
  -- Set by the sweep endpoint once the customer has actually been told. An offer that was created
  -- but never delivered (provider down, endpoint unreachable) is retried on the next sweep rather
  -- than sitting there silently expiring — see api/waitlist.js.
  notified_at     timestamptz,
  notify_channels text[] not null default '{}',
  claimed_at      timestamptz,
  closed_at       timestamptz,
  booking_id      uuid
);
create unique index if not exists waitlist_offers_claim_token on public.waitlist_offers (claim_token);
-- (a) from the header: one live offer per slot, enforced by the database rather than by the code
-- that happens to be running. This is the anti-stampede guarantee.
create unique index if not exists waitlist_offers_one_per_slot
  on public.waitlist_offers (booking_date, bay_id, start_min, end_min) where status = 'offered';
-- And one live offer per person: nobody is asked to decide about two slots at once.
create unique index if not exists waitlist_offers_one_per_entry
  on public.waitlist_offers (entry_id) where status = 'offered';
create index if not exists waitlist_offers_due on public.waitlist_offers (expires_at) where status = 'offered';
create index if not exists waitlist_offers_entry on public.waitlist_offers (entry_id, offered_at desc);

-- (c) WAKEUPS — the work queue the triggers write to.
--
-- A row means "this slot may have come free"; it is a hint, never a fact. The sweep re-checks the
-- slot against live bookings and schedule overrides before it offers anything, because by the time
-- it looks, a walk-in may already have taken it.
--
-- The partial unique index is what makes the whole thing idempotent: a cancellation and a lapsed
-- hold on the same slot, or the same trigger firing twice, collapse into ONE pending row, and
-- every insert below is "on conflict do nothing". Two overlapping sweeps therefore cannot find two
-- copies of the same work.
create table if not exists public.waitlist_wakeups (
  id           bigserial primary key,
  booking_date date     not null,
  bay_id       text     not null,
  start_min    smallint not null,
  end_min      smallint not null,
  reason       text,
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  offer_id     uuid
);
create unique index if not exists waitlist_wakeups_pending
  on public.waitlist_wakeups (booking_date, bay_id, start_min, end_min) where processed_at is null;
create index if not exists waitlist_wakeups_queue on public.waitlist_wakeups (created_at) where processed_at is null;

-- 2) SETTINGS.WAITLIST — every knob, none of them hardcoded. ---------------------------------
--
--   claimMinutes      how long the exclusive claim window lasts (minutes)
--   checkoutMinutes   grace after a claim, during which the slot is not re-offered to anyone else
--   maxOffersPerEntry stop pestering somebody who has ignored this many offers
--   minLeadMinutes    never offer a slot starting sooner than this — nobody can drive there in 10 min
--   quietStartMin /   quiet hours in venue-local minutes from midnight. 21:00 → 08:00 by default.
--   quietEndMin       Set them equal to switch quiet hours off entirely.
--   timezone          the venue's wall clock; the rest of the app uses America/Winnipeg
--   holdSlot          reserve the slot with a real 'held' bookings row for the claim window
--   sweepLimit        max wakeups processed per run
--   lookaheadDays     how far ahead an override deletion is allowed to generate wakeups
--
-- The defaults live in waitlist_config() below and are mirrored in lib/db.js (WAITLIST_DEFAULTS).
alter table public.settings add column if not exists waitlist jsonb not null default '{}'::jsonb;

-- Defaults merged with whatever the operator has set. jsonb || jsonb is right-biased, so a key
-- present in settings.waitlist wins and everything else falls back.
create or replace function public.waitlist_config()
returns jsonb language sql stable as $$
  select jsonb_build_object(
           'claimMinutes',      15,
           'checkoutMinutes',   10,
           'maxOffersPerEntry',  3,
           'minLeadMinutes',    60,
           'quietStartMin',   1260,
           'quietEndMin',      480,
           'timezone',        'America/Winnipeg',
           'holdSlot',        true,
           'sweepLimit',        25,
           'lookaheadDays',     14
         ) || coalesce((select waitlist from public.settings where id = 1), '{}'::jsonb);
$$;

-- Are we inside quiet hours right now? Wraps midnight when start > end (21:00 → 08:00), and is
-- off entirely when the two are equal.
create or replace function public.waitlist_quiet_now()
returns boolean language plpgsql stable as $$
declare
  cfg jsonb := public.waitlist_config();
  s   int   := (cfg->>'quietStartMin')::int;
  e   int   := (cfg->>'quietEndMin')::int;
  m   int;
begin
  if s = e then return false; end if;                 -- equal = quiet hours switched off
  select (extract(hour from t) * 60 + extract(minute from t))::int
    into m
    from (select (now() at time zone (cfg->>'timezone'))::time as t) x;
  if s < e then return m >= s and m < e; end if;      -- a window inside one day
  return m >= s or m < e;                             -- a window that wraps midnight (21:00 → 08:00)
end $$;

-- 3) IS THIS SLOT ACTUALLY FREE? --------------------------------------------------------------
--
-- Mirrors lib/booking.js overrideEffects() in SQL: a closure, a bay-specific closure, a timed
-- maintenance block, or narrowed special hours all make a slot unofferable. An "Open" status
-- (status_open) paints the tee sheet without blocking, exactly as it does in JS.
--
-- settings.weekly_status is deliberately NOT consulted: a wakeup only ever fires for a slot that
-- was occupied a moment ago, and a slot cannot have been booked inside a weekly closed band.
create or replace function public.waitlist_slot_blocked(p_date date, p_bay text, p_start int, p_end int)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.schedule_overrides o
     where o.is_active is not false
       and p_date >= o.override_date
       and p_date <= coalesce(o.end_date, o.override_date)
       and (cardinality(o.bay_ids) = 0 or p_bay = any (o.bay_ids))
       and (
            (o.start_min is null and o.is_closed)
         or (o.start_min is not null and o.end_min is not null and o.end_min > o.start_min
             and not coalesce(o.status_open, false)
             and int4range(o.start_min, o.end_min) && int4range(p_start, p_end))
         or (o.start_min is null and not o.is_closed and o.open_hour is not null
             and (p_start < o.open_hour * 60 or p_end > coalesce(o.close_hour, 24) * 60))
       )
  );
$$;

-- Anything occupying the slot right now: a confirmed booking, a manager block, or somebody else's
-- live cart hold. Lapsed holds do not count — they are rows nobody has swept yet.
create or replace function public.waitlist_slot_taken(p_date date, p_bay text, p_start int, p_end int)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.bookings b
     where b.booking_date = p_date
       and b.bay_id = p_bay
       and b.status <> 'cancelled'
       and (b.status <> 'held' or (b.expires_at is not null and b.expires_at > now()))
       and int4range(b.start_min, b.end_min) && int4range(p_start, p_end)
  )
  or exists (
    -- Somebody else's live offer, for the holdSlot = false configuration where there is no
    -- bookings row to collide with.
    select 1 from public.waitlist_offers o
     where o.status = 'offered' and o.booking_date = p_date and o.bay_id = p_bay
       and int4range(o.start_min, o.end_min) && int4range(p_start, p_end)
  );
$$;

-- 4) THE TRIGGERS. ----------------------------------------------------------------------------

-- One place that queues a wakeup, so every trigger agrees on the rules: nothing for a past date,
-- nothing while a customer who just claimed this slot is still at the checkout (their own claim
-- deletes the hold row, and without this guard that deletion would immediately offer the slot
-- they are paying for to the next person on the list), and duplicates collapse.
--
-- SECURITY DEFINER, and this is load-bearing: waitlist_wakeups has RLS on with no policies, so a
-- manager deleting a booking or a closure in the portal (role `authenticated`) could not insert
-- the wakeup, and the trigger would turn their delete into a permission error. Running as the
-- owner keeps the queue server-only AND keeps the portal working. search_path is pinned, as it
-- must be on any definer function.
create or replace function public.waitlist_note_free_slot(
  p_date date, p_bay text, p_start int, p_end int, p_reason text
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  cfg   jsonb := public.waitlist_config();
  v_now date  := (now() at time zone (cfg->>'timezone'))::date;
begin
  if p_date is null or p_bay is null or p_start is null or p_end is null then return; end if;
  if p_date < v_now then return; end if;
  if p_end <= p_start then return; end if;

  if exists (
    select 1 from public.waitlist_offers o
     where o.status = 'claimed' and o.booking_date = p_date and o.bay_id = p_bay
       and int4range(o.start_min, o.end_min) && int4range(p_start, p_end)
       and o.claimed_at > now() - make_interval(mins => (cfg->>'checkoutMinutes')::int)
  ) then
    return;
  end if;

  insert into public.waitlist_wakeups (booking_date, bay_id, start_min, end_min, reason)
  values (p_date, p_bay, p_start, p_end, p_reason)
  on conflict do nothing;
exception when others then
  -- This runs inside somebody else's DELETE or UPDATE. A waiting list that cannot queue a wakeup
  -- — a mistyped settings.waitlist value, a table that has been dropped — must never turn a
  -- manager cancelling a booking into an error. Complain in the log and let their write commit.
  raise warning 'waitlist: wakeup not queued for % % %-% (%)', p_date, p_bay, p_start, p_end, sqlerrm;
end $$;

-- (a) BOOKINGS: a cancellation, a deleted booking, or a cart hold that expired or was released.
--     cleanupExpiredHolds() in lib/db.js deletes lapsed 'held' rows in bulk; every one of those
--     deletions is a slot coming back, which is one of the three triggers this feature promises.
create or replace function public.waitlist_booking_freed() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
      perform public.waitlist_note_free_slot(old.booking_date, old.bay_id, old.start_min, old.end_min, 'booking_cancelled');
    end if;
  elsif tg_op = 'DELETE' then
    if old.status is distinct from 'cancelled' then
      perform public.waitlist_note_free_slot(old.booking_date, old.bay_id, old.start_min, old.end_min,
        case when old.status = 'held' then 'hold_expired' else 'booking_deleted' end);
    end if;
  end if;
  return null;
end $$;

drop trigger if exists waitlist_bookings_freed on public.bookings;
create trigger waitlist_bookings_freed
  after update or delete on public.bookings
  for each row execute function public.waitlist_booking_freed();

-- (b) SCHEDULE OVERRIDES: a closure or maintenance block being removed hands back every slot it
--     was covering. The manager portal deletes these straight through PostgREST, so there is no
--     API route to hook — this has to be a trigger or it does not happen at all.
--
--     Bounded on purpose: dates are clamped to today … today + lookaheadDays, and an override with
--     no bay_ids expands to the bays in settings, so deleting a year-long closure queues a few
--     dozen wakeups rather than a few thousand.
create or replace function public.waitlist_note_override(o public.schedule_overrides, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  cfg    jsonb := public.waitlist_config();
  v_today date := (now() at time zone (cfg->>'timezone'))::date;
  v_from date;
  v_to   date;
  v_s    int  := coalesce(o.start_min, 0);
  v_e    int  := coalesce(o.end_min, 1440);
  v_bays text[];
  d      date;
  b      text;
begin
  -- Only a blocking override frees anything when it goes away. An "Open" status (Happy Hour)
  -- never blocked booking in the first place — lib/booking.js overrideEffects() skips it too.
  if o.is_active is false then return; end if;
  if not (o.is_closed
          or o.open_hour is not null
          or (o.start_min is not null and not coalesce(o.status_open, false))) then
    return;
  end if;
  if v_e <= v_s then return; end if;

  v_from := greatest(o.override_date, v_today);
  v_to   := least(coalesce(o.end_date, o.override_date), v_today + (cfg->>'lookaheadDays')::int);
  if v_to < v_from then return; end if;

  -- No bay_ids means the override covered every real bay; "holding" bays are not bookable,
  -- so they are excluded here exactly as normalizeSettings() excludes them in lib/booking.js.
  if cardinality(o.bay_ids) > 0 then
    v_bays := o.bay_ids;
  else
    select coalesce(array_agg(x->>'id'), '{}')
      into v_bays
      from jsonb_array_elements(coalesce((select bays from public.settings where id = 1), '[]'::jsonb)) x
     where coalesce((x->>'holding')::boolean, false) = false
       and coalesce(x->>'id', '') <> '';
  end if;

  for d in select generate_series(v_from, v_to, interval '1 day')::date loop
    foreach b in array coalesce(v_bays, '{}') loop
      perform public.waitlist_note_free_slot(d, b, v_s, v_e, p_reason);
    end loop;
  end loop;
exception when others then
  -- Same rule as above: removing a closure must succeed whether or not the waiting list can
  -- work out what it freed.
  raise warning 'waitlist: override wakeups not queued for % (%)', o.id, sqlerrm;
end $$;

create or replace function public.waitlist_override_freed() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform public.waitlist_note_override(old, 'override_removed');
  elsif tg_op = 'UPDATE' then
    -- Deactivating it, opening it up, or moving its window all hand back the time it used to
    -- cover. The sweep re-checks availability anyway, so a wakeup that turns out to still be
    -- blocked costs one row and nothing else.
    if (old.is_active, old.is_closed, old.start_min, old.end_min, old.open_hour, old.close_hour,
        old.status_open, old.bay_ids, old.override_date, old.end_date)
       is distinct from
       (new.is_active, new.is_closed, new.start_min, new.end_min, new.open_hour, new.close_hour,
        new.status_open, new.bay_ids, new.override_date, new.end_date)
    then
      perform public.waitlist_note_override(old, 'override_changed');
    end if;
  end if;
  return null;
end $$;

drop trigger if exists waitlist_overrides_freed on public.schedule_overrides;
create trigger waitlist_overrides_freed
  after update or delete on public.schedule_overrides
  for each row execute function public.waitlist_override_freed();

-- 5) THE SWEEP. -------------------------------------------------------------------------------
--
-- Idempotent by construction, which is the requirement for anything a cron job runs:
--
--   * pg_try_advisory_xact_lock — a second concurrent run returns {"skipped":"locked"} instead of
--     racing the first one. The lock is released when the transaction ends, always.
--   * every wakeup it looks at is marked processed in the same transaction as the offer it
--     created, so a run that fails half way rolls both back together;
--   * the offer insert is guarded by a unique index and the hold insert by the bookings exclusion
--     constraint, so even without the lock the second run could not double-offer a slot;
--   * it does not send anything. It creates offers; api/waitlist.js delivers them through the
--     outbox (migration 0019), where dedupe_key stops a message going out twice.
--
-- Returns a jsonb tally, and the offers it created so the caller can notify them immediately.
create or replace function public.waitlist_process(p_limit integer default null)
returns jsonb language plpgsql as $$
declare
  cfg        jsonb := public.waitlist_config();
  tz         text  := cfg->>'timezone';
  v_today    date  := (now() at time zone tz)::date;
  v_limit    int   := greatest(1, least(200, coalesce(p_limit, (cfg->>'sweepLimit')::int)));
  v_expired  int   := 0;
  v_closed   int   := 0;
  v_seen     int   := 0;
  v_made     int   := 0;
  v_offers   jsonb := '[]'::jsonb;
  o          record;
  w          record;
  e          record;
  v_start    int;
  v_end      int;
  v_slot_at  timestamptz;
  v_deadline timestamptz;
  v_hold     uuid;
  v_offer    uuid;
  v_token    uuid;
  v_placed   boolean;
begin
  if not pg_try_advisory_xact_lock(hashtext('invictus.waitlist.sweep')) then
    return jsonb_build_object('skipped', 'locked');
  end if;

  -- (1) Lapsed claim windows. The customer was told and did not take it, so the slot goes back to
  --     the pool and the NEXT person gets their turn — which is a fresh wakeup, queued here.
  for o in select * from public.waitlist_offers where status = 'offered' and expires_at <= now() loop
    update public.waitlist_offers set status = 'expired', closed_at = now() where id = o.id;
    update public.waitlist_entries set status = 'active', updated_at = now()
     where id = o.entry_id and status = 'offered';
    if o.hold_booking_id is not null then
      delete from public.bookings where id = o.hold_booking_id and status = 'held';
    end if;
    perform public.waitlist_note_free_slot(o.booking_date, o.bay_id, o.start_min, o.end_min, 'offer_expired');
    v_expired := v_expired + 1;
  end loop;

  -- (2) Entries whose day has been and gone. Nothing to offer them ever again.
  update public.waitlist_entries set status = 'expired', updated_at = now()
   where status in ('active','offered') and booking_date < v_today;
  get diagnostics v_closed = row_count;

  -- (3) Quiet hours. Everything above is bookkeeping and is safe at any hour; everything below
  --     ends in somebody's phone lighting up, so it waits. The wakeups stay queued.
  if public.waitlist_quiet_now() then
    return jsonb_build_object('quiet', true, 'expired', v_expired, 'entriesClosed', v_closed,
                              'processed', 0, 'created', 0, 'offers', v_offers);
  end if;

  -- (4) Drain the queue.
  for w in
    select * from public.waitlist_wakeups
     where processed_at is null
     order by created_at, id
     limit v_limit
    for update skip locked
  loop
    v_seen := v_seen + 1;
    v_placed := false;
    v_offer  := null;

    -- Too late to be worth anybody's time, or the slot is not actually free after all.
    if (w.booking_date + make_interval(mins => w.start_min)) at time zone tz
         > now() + make_interval(mins => (cfg->>'minLeadMinutes')::int)
       and not public.waitlist_slot_blocked(w.booking_date, w.bay_id, w.start_min, w.end_min)
    then
      -- First matching entry wins: oldest first, and only entries we can actually reach.
      for e in
        select * from public.waitlist_entries en
         where en.status = 'active'
           and en.booking_date = w.booking_date
           and (cardinality(en.bay_ids) = 0 or w.bay_id = any (en.bay_ids))
           and greatest(en.window_start_min, w.start_min) + en.duration_min
               <= least(en.window_end_min, w.end_min)
           and en.offers_sent < (cfg->>'maxOffersPerEntry')::int
           and ((en.email_ok and en.email is not null) or (en.sms_ok and en.phone is not null))
           -- Don't offer somebody the same slot they already let lapse or turned down.
           and not exists (
             select 1 from public.waitlist_offers o2
              where o2.entry_id = en.id and o2.booking_date = w.booking_date and o2.bay_id = w.bay_id
                and o2.status in ('expired','declined','cancelled')
                and int4range(o2.start_min, o2.end_min) && int4range(w.start_min, w.end_min))
         order by en.created_at, en.id
      loop
        -- The offered slot is one duration-long block at the start of the overlap, never the
        -- whole freed range.
        v_start := greatest(e.window_start_min, w.start_min);
        v_end   := v_start + e.duration_min;
        if v_end > least(e.window_end_min, w.end_min) then continue; end if;

        v_slot_at  := (w.booking_date + make_interval(mins => v_start)) at time zone tz;
        -- The claim window never runs past the slot itself: a deadline after the tee time is not
        -- a deadline. Skip the entry if what is left is too short to act on.
        v_deadline := least(now() + make_interval(mins => (cfg->>'claimMinutes')::int),
                            v_slot_at - interval '5 minutes');
        if v_deadline <= now() + interval '2 minutes' then exit; end if;

        if public.waitlist_slot_taken(w.booking_date, w.bay_id, v_start, v_end) then exit; end if;

        v_hold := null;
        if (cfg->>'holdSlot')::boolean then
          -- The atomic proof that the slot is free. bookings_no_overlap turns a race into an
          -- exception rather than a double booking; if we lose it, the slot was never ours.
          begin
            insert into public.bookings (bay_id, booking_date, start_min, end_min, status,
                                         expires_at, source, customer_name, customer_email, customer_phone)
            values (w.bay_id, w.booking_date, v_start, v_end, 'held',
                    v_deadline, 'waitlist', e.name, e.email, e.phone)
            returning id into v_hold;
          exception when exclusion_violation or unique_violation then
            v_hold := null;
            exit;                              -- somebody got there first; nothing to offer
          end;
        end if;

        begin
          insert into public.waitlist_offers (entry_id, booking_date, bay_id, start_min, end_min,
                                              reason, hold_booking_id, expires_at)
          values (e.id, w.booking_date, w.bay_id, v_start, v_end, w.reason, v_hold, v_deadline)
          returning id, claim_token into v_offer, v_token;
        exception when unique_violation then
          -- A live offer already exists for this slot or this entry. Give the hold back and stop.
          if v_hold is not null then delete from public.bookings where id = v_hold and status = 'held'; end if;
          exit;
        end;

        update public.waitlist_entries
           set status = 'offered', offers_sent = offers_sent + 1, last_offer_at = now(), updated_at = now()
         where id = e.id;

        v_made   := v_made + 1;
        v_placed := true;
        v_offers := v_offers || jsonb_build_object(
          'offerId', v_offer, 'entryId', e.id, 'claimToken', v_token,
          'dateISO', w.booking_date, 'bayId', w.bay_id,
          'startMin', v_start, 'endMin', v_end, 'expiresAt', v_deadline, 'reason', w.reason);
        exit;
      end loop;
    end if;

    update public.waitlist_wakeups
       set processed_at = now(), offer_id = case when v_placed then v_offer else null end
     where id = w.id;
  end loop;

  return jsonb_build_object('quiet', false, 'expired', v_expired, 'entriesClosed', v_closed,
                            'processed', v_seen, 'created', v_made, 'offers', v_offers);
end $$;

-- 6) CLAIM — the customer says yes. -----------------------------------------------------------
--
-- Under a row lock on the offer, so two taps on the link in a text message cannot both claim.
-- The hold row is RELEASED here rather than kept: the customer goes straight into the ordinary
-- checkout, which creates its own cart hold (lib/db.js createHold), and a leftover waitlist hold
-- would collide with it on the exclusion constraint and refuse the booking the customer was just
-- promised. The slot is protected across that handover by waitlist_note_free_slot(), which
-- suppresses wakeups for a slot claimed within the last checkoutMinutes.
create or replace function public.waitlist_claim(p_token uuid)
returns jsonb language plpgsql as $$
declare
  o   public.waitlist_offers%rowtype;
  cfg jsonb := public.waitlist_config();
begin
  select * into o from public.waitlist_offers where claim_token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;

  if o.status = 'claimed' then
    return jsonb_build_object('ok', true, 'already', true, 'offerId', o.id, 'entryId', o.entry_id,
                              'dateISO', o.booking_date, 'bayId', o.bay_id,
                              'startMin', o.start_min, 'endMin', o.end_min,
                              'checkoutBy', o.claimed_at + make_interval(mins => (cfg->>'checkoutMinutes')::int));
  end if;
  if o.status <> 'offered' then
    return jsonb_build_object('ok', false, 'reason', o.status);
  end if;
  if o.expires_at <= now() then
    -- Let the sweep do the tidying and the re-offering; just say no here.
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  update public.waitlist_offers
     set status = 'claimed', claimed_at = now(), closed_at = now()
   where id = o.id;
  update public.waitlist_entries set status = 'claimed', updated_at = now() where id = o.entry_id;
  if o.hold_booking_id is not null then
    delete from public.bookings where id = o.hold_booking_id and status = 'held';
  end if;

  return jsonb_build_object('ok', true, 'offerId', o.id, 'entryId', o.entry_id,
                            'dateISO', o.booking_date, 'bayId', o.bay_id,
                            'startMin', o.start_min, 'endMin', o.end_min,
                            'checkoutBy', now() + make_interval(mins => (cfg->>'checkoutMinutes')::int));
end $$;

-- 7) DECLINE — "no thanks", which is worth having because it hands the slot to the next person
--    immediately instead of after the full claim window.
create or replace function public.waitlist_decline(p_token uuid, p_leave boolean default false)
returns jsonb language plpgsql as $$
declare o public.waitlist_offers%rowtype;
begin
  select * into o from public.waitlist_offers where claim_token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if o.status <> 'offered' then return jsonb_build_object('ok', false, 'reason', o.status); end if;

  update public.waitlist_offers set status = 'declined', closed_at = now() where id = o.id;
  update public.waitlist_entries
     set status = case when p_leave then 'cancelled' else 'active' end, updated_at = now()
   where id = o.entry_id;
  if o.hold_booking_id is not null then
    delete from public.bookings where id = o.hold_booking_id and status = 'held';
  end if;
  perform public.waitlist_note_free_slot(o.booking_date, o.bay_id, o.start_min, o.end_min, 'offer_declined');
  return jsonb_build_object('ok', true, 'left', coalesce(p_leave, false));
end $$;

-- 8) LEAVE — the customer takes themselves off the list, from their own link.
create or replace function public.waitlist_leave(p_token uuid)
returns jsonb language plpgsql as $$
declare
  e public.waitlist_entries%rowtype;
  o public.waitlist_offers%rowtype;
begin
  select * into e from public.waitlist_entries where token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if e.status in ('cancelled','expired') then return jsonb_build_object('ok', true, 'already', true); end if;

  update public.waitlist_entries set status = 'cancelled', updated_at = now() where id = e.id;
  -- Any live offer of theirs is withdrawn, and the slot goes straight back to the pool so the
  -- next person on the list gets it instead of waiting out a claim window nobody is using.
  update public.waitlist_offers set status = 'cancelled', closed_at = now()
   where entry_id = e.id and status = 'offered';
  for o in select * from public.waitlist_offers
            where entry_id = e.id and status = 'cancelled' and closed_at > now() - interval '1 minute' loop
    if o.hold_booking_id is not null then
      delete from public.bookings where id = o.hold_booking_id and status = 'held';
    end if;
    perform public.waitlist_note_free_slot(o.booking_date, o.bay_id, o.start_min, o.end_min, 'entry_left');
  end loop;
  return jsonb_build_object('ok', true);
end $$;

-- 9) ROW LEVEL SECURITY. -----------------------------------------------------------------------
-- The server reaches all of this with SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS entirely, so
-- these policies exist for the manager portal alone (demo/admin.html signs in first and holds an
-- `authenticated` JWT). Reads are narrowed to `authenticated`, per migration 0018 — entries and
-- offers hold customer names, emails and phone numbers.
--
-- The anon role gets nothing. That is load-bearing twice over: an anon SELECT on waitlist_offers
-- would hand every visitor the claim tokens for every live offer, and an anon SELECT on
-- waitlist_entries is a customer contact list.
alter table public.waitlist_entries enable row level security;
drop policy if exists waitlist_entries_read on public.waitlist_entries;
create policy waitlist_entries_read on public.waitlist_entries for select to authenticated using (true);
drop policy if exists waitlist_entries_write on public.waitlist_entries;
create policy waitlist_entries_write on public.waitlist_entries for all to authenticated using (true) with check (true);

alter table public.waitlist_offers enable row level security;
drop policy if exists waitlist_offers_read on public.waitlist_offers;
create policy waitlist_offers_read on public.waitlist_offers for select to authenticated using (true);
drop policy if exists waitlist_offers_write on public.waitlist_offers;
create policy waitlist_offers_write on public.waitlist_offers for all to authenticated using (true) with check (true);

-- The wakeup queue is server bookkeeping, not something the portal renders: RLS on with NO
-- policies denies anon and authenticated everything, the same treatment stripe_events (0019) and
-- promo_attempts (0021) get.
alter table public.waitlist_wakeups enable row level security;
drop policy if exists waitlist_wakeups_write on public.waitlist_wakeups;
drop policy if exists waitlist_wakeups_read on public.waitlist_wakeups;

-- 10) SCHEDULING — pg_cron + pg_net. -----------------------------------------------------------
--
-- Vercel Hobby cron runs once a day. A claim window is fifteen minutes. Those two facts cannot be
-- reconciled, so the clock lives in Postgres instead: pg_cron ticks every minute and pg_net posts
-- to the app, which runs the sweep and sends the messages. Both extensions ship with Supabase but
-- are off until enabled — Dashboard → Database → Extensions, or the two statements below.
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'waitlist: could not create extension pg_cron (%). Enable it in Supabase → Database → Extensions.', sqlerrm;
  end;
  begin
    create extension if not exists pg_net;
  exception when others then
    raise notice 'waitlist: could not create extension pg_net (%). Enable it in Supabase → Database → Extensions.', sqlerrm;
  end;
end $$;

-- Schedule (or re-schedule) the sweep. Run it once with your deployment's URL and the value you
-- put in WAITLIST_SWEEP_SECRET:
--
--   select public.waitlist_schedule_sweep(
--     'https://<your-app>/api/waitlist?action=sweep', '<WAITLIST_SWEEP_SECRET>');
--
-- Every minute is the right cadence: the claim window is measured in minutes, the sweep is a
-- no-op when the wakeup queue is empty, and it holds an advisory lock so a slow run simply makes
-- the next one return immediately.
create or replace function public.waitlist_schedule_sweep(
  p_url text, p_secret text default null, p_schedule text default '* * * * *'
) returns text language plpgsql as $$
declare v_sql text; v_id bigint;
begin
  if to_regclass('cron.job') is null then
    return 'pg_cron is not installed — enable it in Supabase → Database → Extensions, then run this again.';
  end if;
  if to_regproc('net.http_post') is null then
    return 'pg_net is not installed — enable it in Supabase → Database → Extensions, then run this again.';
  end if;

  perform cron.unschedule(jobid) from cron.job where jobname = 'waitlist-sweep';

  v_sql := format(
    'select net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb, timeout_milliseconds := 8000)',
    p_url,
    jsonb_build_object('Content-Type', 'application/json',
                       'x-waitlist-secret', coalesce(p_secret, ''))::text,
    '{}');
  select cron.schedule('waitlist-sweep', p_schedule, v_sql) into v_id;
  return format('waitlist-sweep scheduled as job %s (%s) → %s', v_id, p_schedule, p_url);
end $$;

-- Stop it again (holidays, a broken deployment, or before rotating the secret):
--   select public.waitlist_unschedule_sweep();
create or replace function public.waitlist_unschedule_sweep()
returns text language plpgsql as $$
begin
  if to_regclass('cron.job') is null then return 'pg_cron is not installed.'; end if;
  perform cron.unschedule(jobid) from cron.job where jobname = 'waitlist-sweep';
  return 'waitlist-sweep unscheduled.';
end $$;
-- ============================================================================
-- FUNCTION GRANTS — keep the internals off the anon key.
-- ============================================================================
-- Postgres grants EXECUTE on a new function to PUBLIC by default, and /api/config hands the anon
-- key to every visitor of the site. That made waitlist_note_free_slot() callable by anyone, with
-- no auth and no rate limit: an anonymous caller could flood waitlist_wakeups and drive the sweep.
-- Nothing in the application calls it directly -- every caller is a trigger or another function
-- in this file, which run as their definer -- so revoking it from anon costs nothing.
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.waitlist_note_free_slot(date,text,int,int,text)',
    'public.waitlist_process(integer)',
    'public.waitlist_sweep_expired()'
  ] loop
    if to_regprocedure(fn) is null then continue; end if;
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('grant execute on function %s to service_role', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
exception when others then
  raise notice '0022: could not tighten waitlist function grants (%).', sqlerrm;
end $$;


