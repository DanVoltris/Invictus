/* ============================================================================
   ANALYTICS — the metrics layer behind the operator dashboard.

   Loaded as a plain <script> by demo/admin.html (no modules, no build step) and
   published as window.InvictusAnalytics. It does three things:

     1. FETCH   booking rows (+ the customer rows needed to tell a member from a
                guest) out of Supabase, paging past PostgREST's 1000-row cap and
                degrading gracefully when an optional column isn't there yet.
     2. DERIVE  one flat "fact" per booking: minutes, no-show, member, and a
                stable customer key.
     3. COMPUTE the seven dashboard metrics from those facts.

   WHY THIS IS JAVASCRIPT AND NOT A SQL VIEW
   -----------------------------------------
   The tempting shape is a `v_booking_facts` view with security_invoker. It was
   rejected for two reasons:

     · The denominator is the hard part, and it isn't in the bookings table.
       "Available bay-minutes" is a function of settings.hours, the weekly
       tee-sheet status pattern (settings.weekly_status), schedule_overrides and
       manager blocks. That resolution logic already exists in JavaScript twice
       over (lib/booking.js for the server, demo/admin.html for the tee sheet).
       Writing it a third time in plpgsql would put the venue's opening rules in
       a second language, where it would silently drift away from the rules that
       actually decide what a customer can book.
     · The prime-time window is a live toggle, not a stored setting. PostgREST
       cannot pass a parameter into a view, so a SQL denominator would mean
       baking 16:00-22:00 into the schema and shipping a migration every time the
       operator wants to try a different window.

   The usual argument for a view — payload — does not bite here. Six bays on
   30-minute slots caps at 288 bookings a day, the dashboard's windows are days
   to months, and the rows are eleven narrow columns. The customers table is
   already downloaded whole by the Customers tab, so joining in the browser adds
   no exposure and no new request.

   Where a view WOULD earn its place: a multi-year trend chart. If the volume
   chart ever needs 24 months at once, add a per-day rollup view
   (`select booking_date, count(*), sum(...) ... group by booking_date`) with
   `security_invoker = on` and SELECT revoked from anon, and point volumeOverTime
   at it. Nothing else needs to move.

   SHARED WITH THE TEE SHEET
   -------------------------
   weeklyStatusAt lives here for the browser. demo/admin.html carries its own
   copy at ~line 2184 — DELETE IT and call InvictusAnalytics.weeklyStatusAt
   instead (see the header comment on the function for the exact call sites).
   lib/booking.js keeps its own copy because it is a Node ES module on the
   server; that's one implementation per runtime, which is the floor without a
   build step.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- small helpers ---------- */

  const isoOf = (d) => d.toISOString().slice(0, 10);
  // Weekday of a YYYY-MM-DD, computed in UTC so it can't shift with the viewer's clock.
  const weekdayOf = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();

  // Every ISO date from `from` to `to` inclusive. Capped so a fat-fingered range
  // can't spin the browser; the dashboard never asks for more than a couple of years.
  function datesBetween(from, to, maxDays = 800) {
    const out = [];
    if (!from || !to || to < from) return out;
    let t = Date.parse(from + 'T00:00:00Z');
    const end = Date.parse(to + 'T00:00:00Z');
    if (!isFinite(t) || !isFinite(end)) return out;
    while (t <= end && out.length < maxDays) { out.push(isoOf(new Date(t))); t += 86400000; }
    return out;
  }

  // Minutes shared by two [start,end) ranges.
  const overlap = (aStart, aEnd, bStart, bEnd) =>
    Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

  // Bays that hold real reservations ("holding" bays are UI spacers on the tee sheet).
  const realBays = (settings) =>
    ((settings && settings.bays) || []).filter((b) => b && !b.holding).map((b) => b.id);

  // Digits-only key for matching a booking's typed phone to a customer record.
  // Deliberately coarser than lib/db.js normPhone: last 10 digits, which is the
  // part a Winnipeg customer types the same way every time regardless of "+1".
  function phoneKey(p) {
    const d = String(p == null ? '' : p).replace(/\D/g, '');
    if (!d) return null;
    return d.length >= 10 ? d.slice(-10) : d;
  }

  const emailKey = (e) => {
    const s = String(e == null ? '' : e).trim().toLowerCase();
    return s || null;
  };

  // "No-show", "No Show", "no_show" all mean the same thing to an operator.
  const isNoShowLabel = (label) =>
    String(label == null ? '' : label).toLowerCase().replace(/[^a-z]/g, '') === 'noshow';

  const pct = (n, d) => (d > 0 ? Math.round((n * 1000) / d) / 10 : 0);

  /* ---------- weekly tee-sheet status pattern ------------------------------
     Shared copy for the browser. Same rules and same return shape as
     weeklyStatusAt in lib/booking.js, plus `full` (which admin.html's tee sheet
     uses to decide whether to print the band's label on the cell).

     demo/admin.html should delete its local weeklyStatusAt (~line 2184) and call:
       InvictusAnalytics.weeklyStatusAt(SETTINGS, wd, '*', m)      // ~line 1311
       InvictusAnalytics.weeklyStatusAt(SETTINGS, wd, bayId, m)    // ~line 2225
     SETTINGS is the raw settings row, so the reader below accepts either the raw
     `weekly_status` column or the normalized `weeklyStatus` field.
     ---------------------------------------------------------------------- */

  function weeklyBandsForWeekday(settings, weekday) {
    const ws = (settings && (settings.weekly_status || settings.weeklyStatus)) || {};
    const bands = ws[weekday] != null ? ws[weekday] : ws[String(weekday)];
    return Array.isArray(bands) ? bands : [];
  }

  function weeklyStatusAt(settings, weekday, bayId, minute) {
    let hit = null;
    for (const b of weeklyBandsForWeekday(settings, weekday)) {
      const bays = (Array.isArray(b.bays) && b.bays.length) ? b.bays : null;
      if (bays && !bays.includes(bayId)) continue;
      const s = b.full ? 0 : Number(b.start);
      const e = b.full ? 1440 : Number(b.end);
      if (!isFinite(s) || !isFinite(e)) continue;
      if (minute >= s && minute < e) hit = b;      // last matching band wins
    }
    if (!hit) return null;
    return { label: hit.label || '', color: hit.color || null, open: hit.open !== false, full: !!hit.full };
  }

  /* ---------- availability (the utilisation denominator) ------------------- */

  const ovOn = (o, iso) => iso >= o.override_date && iso <= (o.end_date || o.override_date);

  function overridesOn(overrides, iso) {
    return (overrides || []).filter((o) => o && o.is_active !== false && ovOn(o, iso));
  }

  // Effective [openHour, closeHour] for a date. Mirrors hoursForDate/venueOverride in
  // admin.html and overrideEffects in lib/booking.js: a closure always wins, otherwise
  // the most recently created venue-wide override applies.
  function venueHoursFor(settings, overrides, dateISO) {
    const venue = overridesOn(overrides, dateISO)
      .filter((o) => o.start_min == null && (!o.bay_ids || !o.bay_ids.length));
    if (venue.some((o) => o.is_closed)) return [0, 0];
    const last = venue[venue.length - 1];
    if (last) return [Number(last.open_hour) || 0, Number(last.close_hour) || 0];
    const hours = (settings && settings.hours) || {};
    const wd = weekdayOf(dateISO);
    const band = hours[wd] || hours[String(wd)] || [0, 0];
    return [Number(band[0]) || 0, Number(band[1]) || 0];
  }

  // Does a date-specific "Open" status override re-open this cell? (Mirrors
  // dateOpenStatusCovers in lib/booking.js — an Open paint beats a Closed weekly band.)
  function dateOpenCovers(overrides, dateISO, bayId, minute) {
    for (const o of overridesOn(overrides, dateISO)) {
      if (!o.status_open) continue;
      const bays = (o.bay_ids && o.bay_ids.length) ? o.bay_ids : null;
      if (bays && !bays.includes(bayId)) continue;
      if (o.start_min == null) return true;
      if (minute >= Number(o.start_min) && minute < Number(o.end_min)) return true;
    }
    return false;
  }

  // Minute ranges a bay is NOT sellable on a date: manual/painted closures from
  // schedule_overrides, plus Closed bands in the weekly pattern.
  function closedRangesForBay(settings, overrides, dateISO, bayId, openMin, closeMin) {
    const out = [];
    for (const o of overridesOn(overrides, dateISO)) {
      if (o.start_min == null) continue;      // whole-day rows are handled by venueHoursFor
      if (o.status_open) continue;            // an "Open" paint colours the sheet, it doesn't block
      const bays = (o.bay_ids && o.bay_ids.length) ? o.bay_ids : null;
      if (bays && !bays.includes(bayId)) continue;
      const s = Number(o.start_min), e = Number(o.end_min);
      if (e > s) out.push([s, e]);            // the window applies on every day of the range
    }
    const step = Number(settings && settings.slot_step) || Number(settings && settings.slotStep) || 30;
    const wd = weekdayOf(dateISO);
    let run = null;
    for (let m = openMin; m < closeMin; m += step) {
      const st = weeklyStatusAt(settings, wd, bayId, m);
      const closed = !!(st && !st.open) && !dateOpenCovers(overrides, dateISO, bayId, m);
      if (closed && run == null) run = m;
      if (!closed && run != null) { out.push([run, m]); run = null; }
    }
    if (run != null) out.push([run, closeMin]);
    return out;
  }

  // Sellable bay-minutes across a set of dates, optionally clipped to a window
  // (the prime-time toggle). Returns totals plus per-date and per-bay breakdowns.
  function availableBayMinutes({ settings, overrides, dates, bays, window: win }) {
    const startMin = win ? Math.max(0, Number(win.startMin) || 0) : 0;
    const endMin = win ? Math.min(1440, Number(win.endMin) || 0) : 1440;
    const bayIds = bays && bays.length ? bays : realBays(settings);
    const perDate = {}, perBay = {};
    bayIds.forEach((id) => { perBay[id] = 0; });
    let total = 0;

    for (const iso of dates) {
      const [openH, closeH] = venueHoursFor(settings, overrides, iso);
      const dayOpen = Math.max(openH * 60, startMin);
      const dayClose = Math.min(closeH * 60, endMin);
      let dayTotal = 0;
      if (dayClose > dayOpen) {
        for (const id of bayIds) {
          let mins = dayClose - dayOpen;
          for (const [s, e] of closedRangesForBay(settings, overrides, iso, id, openH * 60, closeH * 60)) {
            mins -= overlap(s, e, dayOpen, dayClose);
          }
          mins = Math.max(0, mins);
          perBay[id] += mins;
          dayTotal += mins;
        }
      }
      perDate[iso] = dayTotal;
      total += dayTotal;
    }
    return { totalMin: total, perDate, perBay, bays: bayIds, window: { startMin, endMin } };
  }

  /* ---------- facts --------------------------------------------------------
     One flat row per booking, with the two things the bookings table can't tell
     you on its own: was this a member, and is this the same person as that other
     booking. Shaped exactly like the `v_booking_facts` view we chose not to build,
     so swapping to one later is a change of source, not of consumers.
     ---------------------------------------------------------------------- */

  function factsFrom(bookings, customers) {
    const byPhone = new Map(), byEmail = new Map();
    for (const c of customers || []) {
      const pk = phoneKey(c.phone);
      if (pk && !byPhone.has(pk)) byPhone.set(pk, c);
      const ek = emailKey(c.email);
      if (ek && !byEmail.has(ek)) byEmail.set(ek, c);
    }

    return (bookings || []).filter((b) => b && b.status !== 'held').map((b) => {
      const pk = phoneKey(b.customer_phone);
      const ek = emailKey(b.customer_email);
      // Phone first, email as the fallback — the same identity order lib/db.js uses.
      const cust = (pk && byPhone.get(pk)) || (ek && byEmail.get(ek)) || null;
      const minutes = Math.max(0, (Number(b.end_min) || 0) - (Number(b.start_min) || 0));
      const expires = cust && cust.membership_expires;
      return {
        id: b.id,
        booking_date: b.booking_date,
        start_min: Number(b.start_min) || 0,
        end_min: Number(b.end_min) || 0,
        minutes,
        bay_id: b.bay_id,
        status: b.status,
        status_label: b.status_label || null,
        source: b.source || 'online',
        amount_cents: Number(b.amount_cents) || 0,
        is_block: b.status === 'blocked',
        is_cancelled: b.status === 'cancelled',
        is_no_show: isNoShowLabel(b.status_label),
        customer_id: cust ? cust.id : null,
        // Membership as it stands today, checked against the booking date. There is no
        // historical membership stamp on a booking yet (the build plan's 0019 adds
        // membership_id_at_booking), so a lapsed member's old bookings read as guest.
        is_member: !!(cust && cust.membership_id && (!expires || String(expires) >= String(b.booking_date))),
        membership_id: cust ? (cust.membership_id || null) : null,
        // Stable identity for the repeat-customer rate. Falls back to the typed contact
        // details when no customer record exists, and finally to the booking id so two
        // anonymous rows never merge into one "repeat" customer.
        customer_key: cust ? 'c:' + cust.id : (pk ? 'p:' + pk : (ek ? 'e:' + ek : 'b:' + b.id)),
      };
    });
  }

  /* ---------- metrics ------------------------------------------------------ */

  // 4pm-10pm. Invictus is open 24 hours, so measuring against 144 bay-hours a day
  // reads ~12% against a 40-70% industry benchmark and looks like a broken dashboard.
  // Both numbers ship; this is only the default position of the toggle.
  const DEFAULT_PRIME = { startHour: 16, endHour: 22 };

  const SOURCE_CHANNEL = {
    online: 'online', web: 'online',
    manager: 'walkIn', admin: 'walkIn', walkin: 'walkIn', 'walk-in': 'walkIn',
    points: 'prepaid', hours: 'prepaid',
  };

  function bucketOf(iso, bucket) {
    if (bucket === 'month') return iso.slice(0, 7);
    if (bucket === 'week') {
      // ISO-ish week key: the Monday of that week.
      const t = Date.parse(iso + 'T00:00:00Z');
      const dow = (new Date(t).getUTCDay() + 6) % 7;   // Mon=0
      return isoOf(new Date(t - dow * 86400000));
    }
    return iso;
  }

  // The whole dashboard, computed from facts + the schedule. Pure: no I/O, no globals.
  //
  //   facts               from factsFrom()/fetchFacts()
  //   settings            the raw settings row (bays, hours, weekly_status, slot_step)
  //   overrides           schedule_overrides rows touching the range
  //   from / to           inclusive ISO date range
  //   prime               { startHour, endHour } — the operator's prime-time window
  //   todayISO            so future bookings are kept out of the no-show denominator
  //   priorCustomerKeys   optional Set of customer_key seen BEFORE `from`, which turns
  //                       repeat.returning from "booked twice in this window" into
  //                       "came back" (see fetchCustomerKeysBefore)
  //   bucket              'day' | 'week' | 'month' for the volume series
  function computeMetrics({
    facts = [], settings = {}, overrides = [], from, to,
    prime = DEFAULT_PRIME, todayISO = null, bays = null,
    priorCustomerKeys = null, bucket = 'day',
  } = {}) {
    const dates = datesBetween(from, to);
    const bayIds = (bays && bays.length ? bays : realBays(settings));
    const inRange = facts.filter((f) => f.booking_date >= from && f.booking_date <= to);

    const live = inRange.filter((f) => !f.is_block && !f.is_cancelled);
    const blocks = inRange.filter((f) => f.is_block);
    const cancelled = inRange.filter((f) => f.is_cancelled);

    const windows = {
      allDay: { startMin: 0, endMin: 1440 },
      prime: {
        startMin: Math.max(0, Math.round((Number(prime && prime.startHour) || 0) * 60)),
        endMin: Math.min(1440, Math.round((Number(prime && prime.endHour) || 0) * 60)),
      },
    };

    const utilisation = {};
    let allDayAvail = null;
    for (const key of ['allDay', 'prime']) {
      const win = windows[key];
      const sched = availableBayMinutes({ settings, overrides, dates, bays: bayIds, window: win });
      if (key === 'allDay') allDayAvail = sched;

      // A manager block takes bay time off the market; it isn't a sale, so it comes
      // out of the denominator rather than going into the numerator.
      let blockedMin = 0;
      for (const b of blocks) blockedMin += overlap(b.start_min, b.end_min, win.startMin, win.endMin);
      const availableMin = Math.max(0, sched.totalMin - blockedMin);

      let bookedMin = 0, revenueCents = 0, bookings = 0;
      const perBayBooked = {};
      for (const f of live) {
        const m = overlap(f.start_min, f.end_min, win.startMin, win.endMin);
        if (m <= 0) continue;
        bookedMin += m;
        bookings += 1;
        perBayBooked[f.bay_id] = (perBayBooked[f.bay_id] || 0) + m;
        // Revenue is pro-rated by the share of the session inside the window, so a
        // 3pm-6pm booking contributes only its 4pm-6pm slice to prime-time revenue.
        revenueCents += f.minutes > 0 ? Math.round(f.amount_cents * m / f.minutes) : f.amount_cents;
      }

      utilisation[key] = {
        window: { startHour: win.startMin / 60, endHour: win.endMin / 60 },
        availableMin, bookedMin, blockedMin, bookings, revenueCents,
        utilisationPct: pct(bookedMin, availableMin),
        // Revenue per available bay-hour — the metric that makes a 24-hour venue
        // comparable to a 12-hour one.
        revPerAvailableBayHourCents: availableMin > 0
          ? Math.round(revenueCents / (availableMin / 60)) : 0,
        perBay: bayIds.map((id) => ({
          bay_id: id,
          availableMin: sched.perBay[id] || 0,
          bookedMin: perBayBooked[id] || 0,
          utilisationPct: pct(perBayBooked[id] || 0, sched.perBay[id] || 0),
        })),
      };
    }

    // Peak vs off-peak is the same session split two ways, so off-peak is whole-day
    // minus prime rather than a second pass over a second denominator.
    const peakSplit = {
      prime: {
        minutes: utilisation.prime.bookedMin,
        revenueCents: utilisation.prime.revenueCents,
        sharePct: pct(utilisation.prime.bookedMin, utilisation.allDay.bookedMin),
        revenueSharePct: pct(utilisation.prime.revenueCents, utilisation.allDay.revenueCents),
      },
      offPeak: {
        minutes: utilisation.allDay.bookedMin - utilisation.prime.bookedMin,
        revenueCents: utilisation.allDay.revenueCents - utilisation.prime.revenueCents,
        sharePct: pct(utilisation.allDay.bookedMin - utilisation.prime.bookedMin, utilisation.allDay.bookedMin),
        revenueSharePct: pct(utilisation.allDay.revenueCents - utilisation.prime.revenueCents, utilisation.allDay.revenueCents),
      },
    };

    // No-show rate. Only sessions whose date has passed can be a no-show, so a week
    // of future bookings can't quietly deflate the rate.
    const settled = todayISO ? live.filter((f) => f.booking_date < todayISO) : live;
    const noShows = settled.filter((f) => f.is_no_show).length;
    const noShow = { noShows, settled: settled.length, ratePct: pct(noShows, settled.length) };

    // Member vs walk-in are two different axes that get conflated; report both.
    const memberCount = live.filter((f) => f.is_member).length;
    const channel = { online: 0, walkIn: 0, prepaid: 0, other: 0 };
    for (const f of live) {
      const key = SOURCE_CHANNEL[String(f.source || '').toLowerCase()] || 'other';
      channel[key] += 1;
    }
    const mix = {
      membership: {
        member: memberCount,
        guest: live.length - memberCount,
        memberPct: pct(memberCount, live.length),
        memberRevenueCents: live.filter((f) => f.is_member).reduce((s, f) => s + f.amount_cents, 0),
      },
      channel: Object.assign({}, channel, {
        walkInPct: pct(channel.walkIn, live.length),
        onlinePct: pct(channel.online, live.length),
      }),
    };

    // Repeat-customer rate. `repeat` is "booked more than once inside this window";
    // `returning` is "we had seen them before this window" and needs priorCustomerKeys.
    const counts = new Map();
    for (const f of live) counts.set(f.customer_key, (counts.get(f.customer_key) || 0) + 1);
    let repeatCustomers = 0, bookingsFromRepeat = 0;
    counts.forEach((n) => { if (n > 1) { repeatCustomers += 1; bookingsFromRepeat += n; } });
    let returning = null;
    if (priorCustomerKeys) {
      returning = 0;
      counts.forEach((_, k) => { if (priorCustomerKeys.has(k)) returning += 1; });
    }
    const repeat = {
      customers: counts.size,
      repeatCustomers,
      bookingsFromRepeat,
      ratePct: pct(repeatCustomers, counts.size),
      bookingsPerCustomer: counts.size ? Math.round((live.length * 100) / counts.size) / 100 : 0,
      returningCustomers: returning,
      returningPct: returning == null ? null : pct(returning, counts.size),
    };

    // Booking volume over time, bucketed. Availability rides along so the chart can
    // show utilisation per bucket without a second pass over the schedule.
    const series = new Map();
    const touch = (key) => {
      if (!series.has(key)) {
        series.set(key, { bucket: key, bookings: 0, minutes: 0, revenueCents: 0, noShows: 0, cancelled: 0, availableMin: 0 });
      }
      return series.get(key);
    };
    const blockedByDate = {};
    for (const b of blocks) {
      blockedByDate[b.booking_date] = (blockedByDate[b.booking_date] || 0)
        + overlap(b.start_min, b.end_min, 0, 1440);
    }
    for (const iso of dates) {
      // Same denominator as the headline number: manager blocks are off the market.
      touch(bucketOf(iso, bucket)).availableMin +=
        Math.max(0, (allDayAvail.perDate[iso] || 0) - (blockedByDate[iso] || 0));
    }
    for (const f of live) {
      const row = touch(bucketOf(f.booking_date, bucket));
      row.bookings += 1;
      row.minutes += f.minutes;
      row.revenueCents += f.amount_cents;
      if (f.is_no_show) row.noShows += 1;
    }
    for (const f of cancelled) touch(bucketOf(f.booking_date, bucket)).cancelled += 1;
    const volume = [...series.values()]
      .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0))
      .map((r) => Object.assign(r, { utilisationPct: pct(r.minutes, r.availableMin) }));

    return {
      range: { from, to, days: dates.length, bucket },
      totals: {
        bookings: live.length,
        cancelled: cancelled.length,
        blocks: blocks.length,
        minutes: utilisation.allDay.bookedMin,
        revenueCents: utilisation.allDay.revenueCents,
        avgBookingCents: live.length ? Math.round(utilisation.allDay.revenueCents / live.length) : 0,
      },
      utilisation, peakSplit, noShow, mix, repeat, volume,
    };
  }

  /* ---------- fetching -----------------------------------------------------
     Degrade-gracefully, matching the convention in lib/db.js: ask for the full
     column list, and if Postgres says a column isn't there (an un-applied
     migration), retry with the columns the base schema has always had.
     ---------------------------------------------------------------------- */

  const MISSING_COLUMN = /column .* does not exist|does not exist|schema cache|42703/i;

  const BOOKING_COLS = 'id,bay_id,booking_date,start_min,end_min,status,status_label,source,amount_cents,customer_email,customer_phone,created_at';
  const BOOKING_COLS_BASE = 'id,bay_id,booking_date,start_min,end_min,status,source,amount_cents,customer_email,customer_phone,created_at';
  const CUSTOMER_COLS = 'id,email,phone,membership_id,membership_expires';
  const CUSTOMER_COLS_BASE = 'id,email,phone,membership_id';

  // One page of a select, with the reduced-column retry.
  async function selectPage(sb, table, cols, fallbackCols, build, offset, pageSize) {
    const run = (c) => build(sb.from(table).select(c)).range(offset, offset + pageSize - 1);
    let { data, error } = await run(cols);
    if (error && fallbackCols && MISSING_COLUMN.test(error.message || '')) {
      ({ data, error } = await run(fallbackCols));
    }
    if (error) throw new Error(table + ': ' + error.message);
    return data || [];
  }

  // Pages past PostgREST's 1000-row default. Stops as soon as a page adds no new
  // ids, which also makes it safe against the demo backend (whose .range() ignores
  // the offset) and against a server that silently caps the page size.
  async function selectAll(sb, table, cols, fallbackCols, build, { pageSize = 1000, maxPages = 40 } = {}) {
    const seen = new Set(), out = [];
    for (let page = 0; page < maxPages; page++) {
      const rows = await selectPage(sb, table, cols, fallbackCols, build, page * pageSize, pageSize);
      let added = 0;
      for (const r of rows) {
        const key = r.id != null ? String(r.id) : JSON.stringify(r);
        if (seen.has(key)) continue;
        seen.add(key); out.push(r); added += 1;
      }
      if (!added || rows.length < pageSize) break;
    }
    return out;
  }

  // Everything computeMetrics needs out of Supabase for one date range.
  async function fetchFacts(sb, { from, to } = {}) {
    const bookings = await selectAll(sb, 'bookings', BOOKING_COLS, BOOKING_COLS_BASE,
      (q) => q.gte('booking_date', from).lte('booking_date', to).neq('status', 'held'));
    const customers = await selectAll(sb, 'customers', CUSTOMER_COLS, CUSTOMER_COLS_BASE, (q) => q);
    return factsFrom(bookings, customers);
  }

  // Schedule overrides that could touch the range (same filter admin.html uses).
  async function fetchOverrides(sb, { from, to } = {}) {
    const { data, error } = await sb.from('schedule_overrides').select('*').lte('override_date', to).order('created_at');
    if (error) throw new Error('schedule_overrides: ' + error.message);
    return (data || []).filter((o) => o.is_active !== false && (o.end_date || o.override_date) >= from);
  }

  // Customer keys seen in the `lookback` days before `from`. Feed the result to
  // computeMetrics as priorCustomerKeys to get a true "came back" rate.
  async function fetchCustomerKeysBefore(sb, { from, lookbackDays = 365 } = {}) {
    const start = isoOf(new Date(Date.parse(from + 'T00:00:00Z') - lookbackDays * 86400000));
    const end = isoOf(new Date(Date.parse(from + 'T00:00:00Z') - 86400000));
    if (end < start) return new Set();
    const bookings = await selectAll(sb, 'bookings', BOOKING_COLS, BOOKING_COLS_BASE,
      (q) => q.gte('booking_date', start).lte('booking_date', end).neq('status', 'held'));
    const customers = await selectAll(sb, 'customers', CUSTOMER_COLS, CUSTOMER_COLS_BASE, (q) => q);
    const keys = new Set();
    for (const f of factsFrom(bookings, customers)) {
      if (!f.is_block && !f.is_cancelled) keys.add(f.customer_key);
    }
    return keys;
  }

  // Fetch + compute in one call — what the Dashboard tab will normally use.
  async function loadDashboard(sb, { settings, from, to, prime, todayISO, bucket, withReturning = false } = {}) {
    const [facts, overrides] = await Promise.all([
      fetchFacts(sb, { from, to }),
      fetchOverrides(sb, { from, to }),
    ]);
    const priorCustomerKeys = withReturning ? await fetchCustomerKeysBefore(sb, { from }) : null;
    return computeMetrics({ facts, settings, overrides, from, to, prime, todayISO, bucket, priorCustomerKeys });
  }

  const API = {
    DEFAULT_PRIME,
    // shared with the tee sheet — admin.html should drop its own copies
    weeklyBandsForWeekday, weeklyStatusAt,
    // date + schedule helpers
    datesBetween, overlap, phoneKey, isNoShowLabel,
    venueHoursFor, closedRangesForBay, availableBayMinutes,
    // data
    factsFrom, fetchFacts, fetchOverrides, fetchCustomerKeysBefore,
    // metrics
    computeMetrics, loadDashboard,
  };

  if (typeof window !== 'undefined') window.InvictusAnalytics = API;
  // Also reachable from Node for tests; harmless in the browser.
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
