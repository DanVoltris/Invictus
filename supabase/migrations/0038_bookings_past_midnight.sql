-- Invictus Golf — bookings that run past midnight (migration 0038)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHAT CHANGES
-- A day on the tee sheet and the booking page now runs 4:00 AM → 3:30 AM, and a session may run
-- past midnight (Saturday 11:30 PM → Sunday 3:00 AM) or past 4 AM (3:30 → 4:30 AM). A booking is
-- still ONE row, stored under the date it STARTS on, with end_min past 1440 when it runs into the
-- next day (11:30 PM → 3:00 AM is start_min 1410, end_min 1620). Nothing already booked moves.
--
-- THE RULE THAT MATTERS: bookings_no_overlap used to compare bookings on the same DATE only, so it
-- could not see Saturday 11:30 PM–3:00 AM colliding with Sunday 1:00 AM in the same bay. It now
-- compares real clock time (bookings.span), across dates. Every existing booking ends by midnight,
-- so the rule accepts today's data as it is.
--
-- Also lifted, so staff groups, recurring series and the waiting list can cross midnight too:
--   booking_series  end_min may run to 2880 (midnight the next night)
--   waitlist        windows may end the next morning; its free/closed checks look across both days,
--                   a late window matches a slot freed early the next day, and an offer is stored
--                   under the day it starts on.

-- 1) Real clock time for every booking, and the overlap rule on it. ----------------------------
alter table public.bookings add column if not exists span tsrange
  generated always as (
    case when end_min > start_min
         then tsrange(booking_date + make_interval(mins => start_min::int),
                      booking_date + make_interval(mins => end_min::int), '[)')
    end) stored;
comment on column public.bookings.span is
  'Real start and end (0038). end_min past 1440 runs into the next day. bookings_no_overlap compares this, across dates.';

alter table public.bookings drop constraint if exists bookings_no_overlap;
alter table public.bookings add constraint bookings_no_overlap
  exclude using gist (bay_id with =, span with &&) where (status <> 'cancelled');

-- 2) Recurring series and waiting-list windows may cross midnight. -------------------------------
alter table public.booking_series drop constraint if exists booking_series_end_min_check;
alter table public.booking_series add constraint booking_series_end_min_check
  check (end_min > 0 and end_min <= 2880);

alter table public.waitlist_entries drop constraint if exists waitlist_entries_bounds;
alter table public.waitlist_entries add constraint waitlist_entries_bounds
  check (window_start_min >= 0 and window_start_min < 1440 and window_end_min <= 2880);

-- 3) Waiting list: "is it closed?" and "is it taken?" across both days. -------------------------
-- The one-day closure check, unchanged, under a new name…
create or replace function public.waitlist_day_blocked(p_date date, p_bay text, p_start int, p_end int)
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

-- …and the check the sweep calls, which splits a slot that runs past midnight across both days.
create or replace function public.waitlist_slot_blocked(p_date date, p_bay text, p_start int, p_end int)
returns boolean language sql stable as $$
  select (p_start < 1440 and public.waitlist_day_blocked(p_date, p_bay, p_start, least(p_end, 1440)))
      or (p_end > 1440 and public.waitlist_day_blocked(p_date + 1, p_bay, greatest(p_start - 1440, 0), p_end - 1440));
$$;

-- Anything occupying the slot right now, compared in real time across dates.
create or replace function public.waitlist_slot_taken(p_date date, p_bay text, p_start int, p_end int)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.bookings b
     where b.bay_id = p_bay
       and b.booking_date between p_date - 1 and p_date + 1
       and b.status <> 'cancelled'
       and (b.status <> 'held' or (b.expires_at is not null and b.expires_at > now()))
       and b.span && tsrange(p_date + make_interval(mins => p_start), p_date + make_interval(mins => p_end), '[)')
  )
  or exists (
    select 1 from public.waitlist_offers o
     where o.status = 'offered' and o.bay_id = p_bay
       and o.booking_date between p_date - 1 and p_date + 1
       and tsrange(o.booking_date + make_interval(mins => o.start_min), o.booking_date + make_interval(mins => o.end_min), '[)')
        && tsrange(p_date + make_interval(mins => p_start), p_date + make_interval(mins => p_end), '[)')
  );
$$;

-- 4) The sweep: late windows reach slots freed early the next day. -------------------------------
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
  v_off      int;          -- 0038: minutes from the ENTRY's date to the freed slot's date (0 or 1440)
  r_date     date;         -- 0038: the offered slot's real date and minutes (it may start after midnight)
  r_start    int;
  r_end      int;
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
  -- 0038: a window can run past midnight ("Saturday 10 PM – 2 AM"), so an entry is done when its
  -- window has ended, not when its date has.
  update public.waitlist_entries set status = 'expired', updated_at = now()
   where status in ('active','offered')
     and (booking_date + make_interval(mins => window_end_min)) at time zone tz < now();
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
      -- 0038: entries for this date, and for the day before — a late-night window ("Saturday
      -- 10 PM – 2 AM") reaches a slot freed early on Sunday. Everything below works in the ENTRY's
      -- minutes: a slot on the next day is 1440 later.
      for e in
        select * from public.waitlist_entries en
         where en.status = 'active'
           and en.booking_date in (w.booking_date, w.booking_date - 1)
           and (cardinality(en.bay_ids) = 0 or w.bay_id = any (en.bay_ids))
           and greatest(en.window_start_min, w.start_min + (w.booking_date - en.booking_date) * 1440) + en.duration_min
               <= least(en.window_end_min, w.end_min + (w.booking_date - en.booking_date) * 1440)
           and en.offers_sent < (cfg->>'maxOffersPerEntry')::int
           and ((en.email_ok and en.email is not null) or (en.sms_ok and en.phone is not null))
           -- Don't offer somebody the same slot they already let lapse or turned down.
           and not exists (
             select 1 from public.waitlist_offers o2
              where o2.entry_id = en.id and o2.bay_id = w.bay_id
                and o2.booking_date between w.booking_date - 1 and w.booking_date + 1
                and o2.status in ('expired','declined','cancelled')
                and tsrange(o2.booking_date + make_interval(mins => o2.start_min), o2.booking_date + make_interval(mins => o2.end_min), '[)')
                 && tsrange(w.booking_date + make_interval(mins => w.start_min), w.booking_date + make_interval(mins => w.end_min), '[)'))
         order by en.created_at, en.id
      loop
        -- The offered slot is one duration-long block at the start of the overlap, never the
        -- whole freed range.
        v_off   := (w.booking_date - e.booking_date) * 1440;
        v_start := greatest(e.window_start_min, w.start_min + v_off);
        v_end   := v_start + e.duration_min;
        if v_end > least(e.window_end_min, w.end_min + v_off) then continue; end if;
        -- The slot is stored under the day it really starts on (a 1 AM Sunday slot is Sunday's).
        r_date  := e.booking_date + (v_start / 1440);
        r_start := v_start % 1440;
        r_end   := v_end - (v_start / 1440) * 1440;

        v_slot_at  := (r_date + make_interval(mins => r_start)) at time zone tz;
        -- The claim window never runs past the slot itself: a deadline after the tee time is not
        -- a deadline. Skip the entry if what is left is too short to act on.
        v_deadline := least(now() + make_interval(mins => (cfg->>'claimMinutes')::int),
                            v_slot_at - interval '5 minutes');
        if v_deadline <= now() + interval '2 minutes' then exit; end if;

        if public.waitlist_slot_taken(r_date, w.bay_id, r_start, r_end) then exit; end if;

        v_hold := null;
        if (cfg->>'holdSlot')::boolean then
          -- The atomic proof that the slot is free. bookings_no_overlap turns a race into an
          -- exception rather than a double booking; if we lose it, the slot was never ours.
          begin
            insert into public.bookings (bay_id, booking_date, start_min, end_min, status,
                                         expires_at, source, customer_name, customer_email, customer_phone)
            values (w.bay_id, r_date, r_start, r_end, 'held',
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
          values (e.id, r_date, w.bay_id, r_start, r_end, w.reason, v_hold, v_deadline)
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
          'dateISO', r_date, 'bayId', w.bay_id,
          'startMin', r_start, 'endMin', r_end, 'expiresAt', v_deadline, 'reason', w.reason);
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

-- 5) Keep the internals off the anon key (same rule as 0022). ------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.waitlist_process(integer)',
    'public.waitlist_day_blocked(date,text,int,int)'
  ] loop
    if to_regprocedure(fn) is null then continue; end if;
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('grant execute on function %s to service_role', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
exception when others then
  raise notice '0038: could not tighten waitlist function grants (%).', sqlerrm;
end $$;
