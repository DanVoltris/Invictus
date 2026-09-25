/* ============================================================================
   DEMO MODE — an in-memory stand-in for Supabase.

   The manager view talks to Supabase directly from the browser. With no
   database configured it has nothing to read, so it used to stop at a
   "Not configured" screen. This file hands it a fake client backed by plain
   arrays instead, so the whole manager view is browsable for a demo.

   Scope, so nobody is surprised:
     - Edits apply to the in-memory arrays, so the UI reacts like the real
       thing, but NOTHING PERSISTS. A refresh restores the starting data.
     - Login is bypassed entirely. There is no auth here.
     - It activates ONLY when /api/config reports no Supabase. Configure
       Supabase and this file is never loaded.

   Delete this file and the demo-mode branch in admin.html once the real
   database is connected.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- date helpers: data is generated around today so the tee sheet
       always has something on it, whenever the demo is opened ---------- */
  // Must match the app's own todayISO(), which works in America/Winnipeg. Using UTC
  // here would drift by a day near midnight and empty out today's tee sheet.
  const fmtWpg = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Winnipeg', year: 'numeric', month: '2-digit', day: '2-digit' });
  const iso = (d) => fmtWpg.format(d);
  const today = new Date();
  const dayOffset = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };
  const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const uid = (() => { let n = 0; return (p) => `${p}-${String(++n).padStart(4, '0')}`; })();

  const BAYS = [
    { id: 'B1', name: 'Assiniboine Credit Union Bay #1', sim: 'Golfzon TwoVision', description: 'Right hand only' },
    { id: 'B2', name: 'Birchwood Bay #2', sim: 'Golfzon TwoVision' },
    { id: 'B3', name: 'Manitopia Realty Bay #3', sim: 'Golfzon TwoVision' },
    { id: 'B4', name: 'Public Bay #4', sim: 'Golfzon TwoVision', description: 'Flat base' },
    { id: 'B5', name: 'McNaught Private Room #1', sim: 'Golfzon TwoVision', description: 'Private room' },
    { id: 'B6', name: 'Private Room #2', sim: 'Golfzon TwoVision', description: 'Private room' },
  ];

  // CA$20/hour Mon–Thu, CA$25/hour Fri–Sun — matches lib/booking.js DEFAULT_SETTINGS.
  const FLAT = { weekdayOffPeak: 20, weekdayPeak: 20, weekendOffPeak: 25, weekendPeak: 25 };

  /* ---------- customers ---------- */
  const CUSTOMERS = [
    ['Avery Thompson', 'avery.thompson@example.com', '+12045550111', 240, 'demo-clubhouse'],
    ['Jordan Reyes', 'jordan.reyes@example.com', '+12045550112', 0, null],
    ['Priya Raman', 'priya.raman@example.com', '+12045550113', 480, 'demo-elite'],
    ['Marcus Bell', 'marcus.bell@example.com', '+12045550114', 60, null],
    ['Chloe Nguyen', 'chloe.nguyen@example.com', '+12045550115', 0, 'demo-range'],
    ['Sam Okafor', 'sam.okafor@example.com', '+12045550116', 120, null],
    ['Riley Fontaine', 'riley.fontaine@example.com', '+12045550117', 300, 'demo-clubhouse'],
    ['Dana Whitecloud', 'dana.whitecloud@example.com', '+12045550118', 0, null],
    ['Owen Brar', 'owen.brar@example.com', '+12045550119', 90, 'demo-elite'],
    ['Mei Lin', 'mei.lin@example.com', '+12045550120', 0, null],
    ['Tobias Kern', 'tobias.kern@example.com', '+12045550121', 180, 'demo-range'],
    ['Harper Vance', 'harper.vance@example.com', '+12045550122', 0, null],
  ].map(([name, email, phone, hours_balance_min, membership_id], i) => ({
    id: uid('cust'), name, email, phone,
    membership_id,
    membership_expires: membership_id ? dayOffset(200 + i * 9) : null,
    membership_flag: null,
    notes: i === 2 ? 'Prefers Bay #3. Left-handed setup.' : null,
    hours_balance_min,
    sms_opt_in: i % 3 !== 0,
    waiver_signed_at: i % 4 === 0 ? hoursAgo(72 + i * 11) : null,
    waiver_name: i % 4 === 0 ? name : null,
    waiver_version: i % 4 === 0 ? 'v2' : null,
    waiver_code: i % 4 === 0 ? 'WV-' + (2200 + i) : null,
    legacy_bookings: 0, legacy_attendee: 0, legacy_cancelled: 0, legacy_no_show: 0,
    created_at: hoursAgo(600 + i * 40),
  }));

  /* ---------- leagues (migrations 0028 + 0031) ----------
     A league is sold BY THE TEAM: one captain pays one price for the whole team and invites
     friends by phone. There is no league night — each team books its own round once a week from
     the ordinary booking page, flagged with league_team_id. Seeded so every manager screen has
     something to show: a paid team, an unpaid one, pending and claimed invites, rounds booked
     week after week, and teams that have missed a week (including this one). */
  const pad2 = (n) => String(n).padStart(2, '0');
  const isoUTC = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const plusDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return isoUTC(x); };
  // Monday of that date's week — the same rule as Postgres date_trunc('week') and leagues.js.
  const weekOf = (d) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return isoUTC(x); };
  const pastWeekdays = (dow, fromOffset) => {
    const out = [];
    for (let n = fromOffset; n < 0; n++) { const d = dayOffset(n); if (new Date(d + 'T00:00:00Z').getUTCDay() === dow) out.push(d); }
    return out;
  };
  const THIS_WEEK = weekOf(dayOffset(0));
  const LEAGUE_THU = { id: uid('lg'), name: 'Winter Team League', description: 'Buy a team, bring three friends, play your round any time that suits you — once a week, all season.',
    day_of_week: null, start_min: null, end_min: null,
    season_start: plusDays(THIS_WEEK, -35), season_end: plusDays(THIS_WEEK, 48),
    bay_ids: ['B1', 'B2', 'B3', 'B4'], fee_cents: 40000, capacity: 16, team_size: 4, weekly_min_mins: 180,
    team_mode: true, scoring: 'points', join_online: true,
    is_active: true, series_id: null, color: '#F0523D', sort: 0, created_at: hoursAgo(1200) };
  const LEAGUE_SUN = { id: uid('lg'), name: 'Sunday Stroke Play', description: 'Play your own round. Lowest average across the season takes the jacket.',
    day_of_week: null, start_min: null, end_min: null, season_start: dayOffset(-20), season_end: dayOffset(40),
    bay_ids: ['B3'], fee_cents: 0, capacity: null, team_size: null, weekly_min_mins: 120,
    team_mode: false, scoring: 'strokes', join_online: true,
    is_active: true, series_id: null, color: '#4AA3FF', sort: 1, created_at: hoursAgo(700) };

  // Each team: its captain, what it paid, and the bay/day/time its round usually lands on.
  const TEAM_SEED = [
    { name: 'Aces',     captain: 0, paid: 40000, hoursSince: 1100, session: 'cs_demo_team_aces',  bay: 'B1', dow: 1, start: 960,  end: 1140 },
    { name: 'Birdies',  captain: 2, paid: 40000, hoursSince: 1040, session: 'cs_demo_team_birds', bay: 'B2', dow: 2, start: 1020, end: 1200 },
    { name: 'Chippers', captain: 4, paid: 40000, hoursSince: 980,  session: null,                 bay: 'B4', dow: 3, start: 600,  end: 780 },
    { name: 'Divots',   captain: 6, paid: 0,     hoursSince: null, session: null,                 bay: 'B3', dow: 4, start: 900,  end: 1080 },
  ];
  const LEAGUE_TEAMS = TEAM_SEED.map((t) => ({
    id: uid('lt'), league_id: LEAGUE_THU.id, name: t.name,
    captain_customer_id: CUSTOMERS[t.captain].id,
    paid_cents: t.paid, paid_at: t.paid ? hoursAgo(t.hoursSince) : null,
    stripe_session_id: t.session,
    note: t.paid ? null : 'Paying at the counter — chase this week.',
    created_at: hoursAgo(1100),
  }));
  const LEAGUE_MEMBERS = [
    ...CUSTOMERS.slice(0, 8).map((c, i) => ({ id: uid('lm'), league_id: LEAGUE_THU.id, customer_id: c.id, team_id: LEAGUE_TEAMS[Math.floor(i / 2)].id,
      status: 'active', source: i % 2 ? 'online' : 'staff', paid_cents: 0, paid_at: null,
      stripe_session_id: null, note: i % 2 === 0 ? 'Captain — bought the team' : null, joined_at: hoursAgo(1000 - i * 10) })),
    ...CUSTOMERS.slice(6, 12).map((c, i) => ({ id: uid('lm'), league_id: LEAGUE_SUN.id, customer_id: c.id, team_id: null,
      status: 'active', source: 'online', paid_cents: 0, paid_at: null, stripe_session_id: null, note: null, joined_at: hoursAgo(600 - i * 10) })),
  ];
  // "Here's the link, you're on my team." One claimed, two still out, one withdrawn.
  const LEAGUE_INVITES = [
    { id: uid('li'), team_id: LEAGUE_TEAMS[0].id, phone: '+12045550131', name: 'Nolan Pike', token: 'demo-invite-1',
      invited_by: CUSTOMERS[0].id, claimed_at: null, claimed_customer_id: null, revoked_at: null, created_at: hoursAgo(50) },
    { id: uid('li'), team_id: LEAGUE_TEAMS[0].id, phone: CUSTOMERS[1].phone, name: CUSTOMERS[1].name, token: 'demo-invite-2',
      invited_by: CUSTOMERS[0].id, claimed_at: hoursAgo(990), claimed_customer_id: CUSTOMERS[1].id, revoked_at: null, created_at: hoursAgo(1000) },
    { id: uid('li'), team_id: LEAGUE_TEAMS[3].id, phone: '+12045550132', name: 'Gwen Arsenault', token: 'demo-invite-3',
      invited_by: CUSTOMERS[6].id, claimed_at: null, claimed_customer_id: null, revoked_at: null, created_at: hoursAgo(12) },
    { id: uid('li'), team_id: LEAGUE_TEAMS[2].id, phone: '+12045550133', name: 'Ira Blondeau', token: 'demo-invite-4',
      invited_by: CUSTOMERS[4].id, claimed_at: null, claimed_customer_id: null, revoked_at: hoursAgo(200), created_at: hoursAgo(400) },
  ];
  // The weekly rounds each team booked for itself, five weeks back and one week forward. Chippers
  // skipped the week before last and Divots has not booked this week — the two states staff chase.
  // Aces has already booked NEXT week, which is what makes "this team is taken that week" visible
  // from the tee sheet at any time of day: the current week may be entirely in the past.
  const LEAGUE_ROUNDS = [];
  for (let w = -5; w <= 1; w++) {
    const week = plusDays(THIS_WEEK, w * 7);
    TEAM_SEED.forEach((t, k) => {
      if (t.name === 'Chippers' && w === -2) return;       // missed a week
      if (t.name === 'Divots' && w === 0) return;          // has not booked this week yet
      if (w === 1 && t.name !== 'Aces') return;            // only Aces has booked ahead
      LEAGUE_ROUNDS.push({ team_id: LEAGUE_TEAMS[k].id, team: t.name, league_week: week,
        booking_date: plusDays(week, t.dow), bay_id: t.bay, start_min: t.start, end_min: t.end,
        captain: CUSTOMERS[t.captain], weeksAgo: -w });
    });
  }
  const LEAGUE_RESULTS = [
    // Scores are entered per week, against the day that team actually played.
    ...LEAGUE_ROUNDS.filter((r) => r.weeksAgo > 0).map((r, i) => ({ id: uid('lr'), league_id: LEAGUE_THU.id,
      played_on: r.booking_date, team_id: r.team_id, customer_id: null,
      score: [8, 6, 5, 3][(i + r.weeksAgo) % 4] + (r.team === 'Aces' ? 2 : 0), note: null, created_at: hoursAgo(20) })),
    ...pastWeekdays(0, -20).flatMap((d, w) => CUSTOMERS.slice(6, 12).map((c, k) => ({ id: uid('lr'), league_id: LEAGUE_SUN.id, played_on: d,
      team_id: null, customer_id: c.id, score: 70 + ((k * 3 + w * 2) % 9), note: null, created_at: hoursAgo(20) }))),
  ];
  // 0030's cancelled nights: a league with no fixed night has none to cancel, so the table sits
  // empty rather than being deleted with its history (migration 0031).
  const LEAGUE_CANCELLED = [];

  /* ---------- bookings ----------
     The tee sheet starts empty. Flip SEED_BOOKINGS to true to generate a busy but
     plausible week of sample bookings again (the generator below is left intact). */
  const SEED_BOOKINGS = false;
  const NAMES = CUSTOMERS.map((c) => [c.name, c.email, c.phone]);
  const BOOKINGS = [];
  const SLOTS = [
    [600, 690], [690, 810], [780, 870], [870, 990], [960, 1050],
    [1050, 1170], [1140, 1230], [1230, 1350], [540, 630], [1320, 1410],
  ];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };

  for (let d = -3; SEED_BOOKINGS && d <= 6; d++) {
    const date = dayOffset(d);
    const perDay = 5 + rnd(6);
    const used = {};
    for (let k = 0; k < perDay; k++) {
      const bay = BAYS[rnd(BAYS.length)].id;
      const slot = SLOTS[rnd(SLOTS.length)];
      const key = bay + ':' + slot[0];
      if (used[key]) continue;
      used[key] = 1;
      const [nm, em, ph] = NAMES[rnd(NAMES.length)];
      const mins = slot[1] - slot[0];
      const past = d < 0;
      const status = past ? (rnd(9) === 0 ? 'cancelled' : 'confirmed')
                          : (rnd(11) === 0 ? 'cancelled' : 'confirmed');
      BOOKINGS.push({
        id: uid('bk'), bay_id: bay, booking_date: date,
        start_min: slot[0], end_min: slot[1],
        status,
        status_label: status === 'cancelled' ? 'Cancelled' : (past ? 'Checked In' : 'Booked'),
        customer_name: nm, customer_email: em, customer_phone: ph,
        amount_cents: Math.round((mins / 60) * 2000),
        stripe_payment_intent: null,
        source: rnd(3) === 0 ? 'admin' : 'online',
        note: rnd(7) === 0 ? 'Bringing own clubs.' : null,
        tags: rnd(6) === 0 ? ['League'] : [],
        expires_at: null,
        cancelled_at: status === 'cancelled' ? hoursAgo(rnd(60) + 2) : null,
        created_at: hoursAgo(rnd(300) + 5),
      });
    }
  }


  /* ---------- booking history (the operator dashboard's data) ----------
     The tee sheet above deliberately starts empty, but a dashboard with no
     history is a screen of zeros — useless in a sales demo. So this generates
     PAST bookings only (yesterday back 60 days); today and everything ahead of
     it stay clean. Set SEED_HISTORY to false to turn the dashboard back to zeros.

     The shape is chosen to make the venue's real problem visible: Invictus is
     open 24 hours, so the whole-day utilisation number is always going to look
     dismal next to the ~50-60% it does in the 4pm-10pm prime window. Overnight
     hours are near-empty, evenings are busy. */
  const SEED_HISTORY = true;
  const HISTORY_DAYS = 60;

  // Chance a bay starts a new booking at a given half-hour, by hour of day.
  const START_ODDS = (h) => (h < 8 ? 0.008 : h < 12 ? 0.03 : h < 16 ? 0.08 : h < 22 ? 0.34 : 0.05);
  const DURATIONS = [60, 60, 60, 90, 90, 120];       // most sessions are an hour

  // rnd() above returns seed % n, and for a small n that leans on an LCG's weakest low bits.
  // Taking the low 30 of the 31 seed bits instead gives a fraction that is actually spread out,
  // which matters here because these odds decide the demo's headline percentages.
  const rnd01 = () => rnd(1073741824) / 1073741824;
  const pick = (arr) => arr[Math.floor(rnd01() * arr.length)];

  // A long tail of one-and-done guests plus a few regulars, so the repeat-customer
  // rate is something other than 0% or 100%. These are booking contacts only — they
  // are NOT in the customers table, exactly like a real walk-in who never signed up.
  const FIRST = ['Aiden','Brooke','Callum','Delia','Emmett','Farah','Gus','Hana','Isaac','Jules','Kira','Liam',
                 'Mara','Nolan','Odette','Pierce','Quinn','Rosa','Silas','Tess','Ulric','Vera','Wes','Xena'];
  const LAST  = ['Archer','Boyd','Castellan','Doyle','Ellsworth','Farrow','Gagnon','Hollis','Ivers','Janzen',
                 'Kowalchuk','Lemay','Mercier','Novak','Oland','Pruden','Quill','Rondeau','Sandhu','Thibault',
                 'Underhill','Vachon','Wiebe','Yakimchuk'];
  const guest = (i) => {
    const name = FIRST[i % FIRST.length] + ' ' + LAST[Math.floor(i / FIRST.length) % LAST.length];
    return [name, name.toLowerCase().replace(/[^a-z]/g, '.') + (1000 + i) + '@example.com', '+1204555' + (1000 + i)];
  };
  const GUEST_POOL = FIRST.length * LAST.length;     // 576 possible walk-in identities

  const memberOf = (email) => CUSTOMERS.find((c) => c.email === email) || null;
  const DISCOUNT = { 'demo-range': 10, 'demo-clubhouse': 15, 'demo-elite': 25 };

  // Leave the teams' weekly rounds alone. Same reason the league night below only fills future
  // weeks: two bookings in one bay at one time just hide each other on the tee sheet, and the
  // one that would lose is the round staff need to be able to see.
  const roundHere = (bay, date, s, e) => LEAGUE_ROUNDS.some(
    (r) => r.bay_id === bay && r.booking_date === date && s < r.end_min && e > r.start_min);

  for (let d = -HISTORY_DAYS; SEED_HISTORY && d <= -1; d++) {
    const date = dayOffset(d);
    const wd = new Date(date + 'T00:00:00Z').getUTCDay();
    const weekend = wd === 0 || wd === 5 || wd === 6;          // Fri-Sun is the busy, CA$25 band
    const rate = weekend ? 25 : 20;
    const busy = weekend ? 1.25 : 1;

    for (const bay of BAYS) {
      for (let m = 0; m < 1440;) {
        if (rnd01() > START_ODDS(Math.floor(m / 60)) * busy) { m += 30; continue; }
        const mins = pick(DURATIONS);
        if (m + mins > 1440) { m += 30; continue; }
        if (roundHere(bay.id, date, m, m + mins)) { m += 30; continue; }

        // A third of bookings come from the twelve known customers (the regulars);
        // the rest are guests drawn with a square-law bias toward the low indices,
        // which produces a handful of frequent faces and a long single-visit tail.
        let nm, em, ph;
        if (rnd01() < 0.34) { const c = pick(CUSTOMERS); nm = c.name; em = c.email; ph = c.phone; }
        else { [nm, em, ph] = guest(Math.floor(rnd01() * rnd01() * GUEST_POOL)); }

        const roll = rnd01() * 100;
        const cancelled = roll < 7;
        const noShow = !cancelled && roll < 14;
        const cust = memberOf(em);
        const pctOff = cust && cust.membership_id ? (DISCOUNT[cust.membership_id] || 0) : 0;
        const gross = Math.round((mins / 60) * rate * 100);
        const s2 = rnd01();
        const src = s2 < 0.62 ? 'online' : s2 < 0.92 ? 'admin' : 'hours';

        BOOKINGS.push({
          id: uid('bk'), bay_id: bay.id, booking_date: date,
          start_min: m, end_min: m + mins,
          status: cancelled ? 'cancelled' : 'confirmed',
          status_label: cancelled ? 'Cancelled' : noShow ? 'No Show' : 'Checked In',
          customer_name: nm, customer_email: em, customer_phone: ph,
          amount_cents: src === 'hours' ? 0 : gross - Math.round(gross * pctOff / 100),
          stripe_payment_intent: null,
          source: src,
          note: rnd01() < 0.05 ? 'Bringing own clubs.' : null,
          tags: rnd01() < 0.08 ? ['League'] : [],
          expires_at: null,
          cancelled_at: cancelled ? hoursAgo(-d * 24 + rnd(40) + 4) : null,
          created_at: hoursAgo(-d * 24 + rnd(240) + 6),
        });
        m += mins;
      }
    }
  }

  const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /* ---------- Tier 2 tables: gift cards, promos, waiting list, groups & series, staff ----------
     Everything below is seeded around today, exactly like the tee sheet above, so a demo opened
     on any date shows a live-looking venue. Ids are literal rather than generated, because these
     rows reference each other and a group booking has to point at the series it belongs to. */

  // A gift card in the real database stores sha256 of the code and its last four characters —
  // never the code. The demo keeps the same shape, hash included, so the manager screens are
  // exercised against the data they will really get.
  const GIFT_CARDS = [
    ['gc-1', 'K3M9', 10000, 10000, 'active',   'Nadia Kowal',     'nadia.kowal@example.com',   'Peter Kowal',     'peter.kowal@example.com',   'online', 'Happy birthday — go break something.', 20],
    ['gc-2', '7QT2',  3500,  5000, 'active',   'Devon Marchand',  'devon.marchand@example.com','Invictus Golf',   null,                        'staff',  null, 12],
    ['gc-3', 'X48B',     0,  2500, 'active',   'Simone Beaulieu', 'simone.b@example.com',      'Ray Beaulieu',    'ray.b@example.com',         'online', 'Enjoy!', 34],
    ['gc-4', 'PW61', 15000, 15000, 'active',   'Corporate — Halbrite', 'events@example.com',   'Halbrite Ltd',    'ap@example.com',            'staff',  'Client appreciation', 6],
    ['gc-5', 'M2H5',  2000,  5000, 'disabled', 'Unknown',         null,                        'Walk-in',         null,                        'staff',  'Reported lost — held pending confirmation', 45],
    ['gc-6', 'ZB93',  5000,  5000, 'active',   'Tomas Reyes',     'tomas.reyes@example.com',   'Jordan Reyes',    'jordan.reyes@example.com',  'online', 'Merry Christmas!', 3],
    ['gc-7', 'D7K4',     0, 10000, 'void',     'Cancelled order', null,                        'Chargeback',      null,                        'online', 'Refunded after a disputed payment', 52],
  ].map(([id, hint, bal, initial, status, rname, remail, pname, pemail, issued, message, ago]) => ({
    id, code_hash: 'demo-' + id, code_hint: hint,
    balance_cents: bal, initial_cents: initial, currency: 'cad', status,
    expires_at: null,
    purchaser_customer_id: null, purchaser_name: pname, purchaser_email: pemail, purchaser_phone: null,
    recipient_name: rname, recipient_email: remail, recipient_phone: null,
    message, deliver_at: null, delivered_at: issued === 'online' ? hoursAgo(ago * 24 - 1) : null,
    issued_by: issued, stripe_session_id: null, stripe_payment_intent: null,
    note: id === 'gc-5' ? 'Customer says the card was lost.' : null,
    created_at: hoursAgo(ago * 24),
  }));

  // The ledger. Every card's transactions sum to its balance, which is the one property a
  // manager will check by eye on the sheet.
  const GIFT_TX = [];
  let gtx = 0;
  const giftTx = (cardId, cents, kind, note, hoursBack) => GIFT_TX.push({
    id: 'gtx-' + (++gtx), gift_card_id: cardId, cents, kind, note,
    booking_id: null, ref: null, created_at: hoursAgo(hoursBack),
  });
  giftTx('gc-1', 10000, 'purchase', 'Bought online', 20 * 24);
  giftTx('gc-2',  5000, 'issue',    'Issued at the counter', 12 * 24);
  giftTx('gc-2', -1500, 'redeem',   'Bay session', 5 * 24);
  giftTx('gc-3',  2500, 'purchase', 'Bought online', 34 * 24);
  giftTx('gc-3', -2500, 'redeem',   'Bay session', 9 * 24);
  giftTx('gc-4', 15000, 'issue',    'Issued at the counter', 6 * 24);
  giftTx('gc-5',  5000, 'issue',    'Issued at the counter', 45 * 24);
  giftTx('gc-5', -3000, 'redeem',   'Bay session', 40 * 24);
  giftTx('gc-6',  5000, 'purchase', 'Bought online', 3 * 24);
  giftTx('gc-7', 10000, 'purchase', 'Bought online', 52 * 24);
  giftTx('gc-7',-10000, 'refund',   'Payment disputed — card voided', 50 * 24);

  // Promo codes. Chosen to cover every branch the manager screen has to render: live, scheduled,
  // expired, used up, switched off, and both stacking rules turned off.
  const PROMOS = [
    { id: 'pr-1', code: 'WELCOME15', kind: 'percent', percent_off: 15, amount_off_cents: 0,
      max_discount_cents: 3000, min_subtotal_cents: 0, starts_at: null, ends_at: null,
      max_redemptions: null, max_per_customer: 1, redeemed_count: 38, bay_ids: [], weekdays: [],
      start_min: null, end_min: null, membership_scope: 'non_members', membership_ids: [],
      stacks_with_membership: true, stacks_with_points: true, active: true,
      note: 'Evergreen first-visit offer.', created_at: hoursAgo(2000) },
    { id: 'pr-2', code: 'OFFPEAK10', kind: 'amount', percent_off: 0, amount_off_cents: 1000,
      max_discount_cents: null, min_subtotal_cents: 4000, starts_at: null, ends_at: null,
      max_redemptions: null, max_per_customer: 4, redeemed_count: 12, bay_ids: [],
      weekdays: [1, 2, 3, 4], start_min: 480, end_min: 900, membership_scope: 'any', membership_ids: [],
      stacks_with_membership: false, stacks_with_points: true, active: true,
      note: 'Fills the dead hours. Not on top of a membership.', created_at: hoursAgo(900) },
    { id: 'pr-3', code: 'LEAGUE25', kind: 'percent', percent_off: 25, amount_off_cents: 0,
      max_discount_cents: 5000, min_subtotal_cents: 0,
      starts_at: new Date(Date.now() + 6 * 86400e3).toISOString(),
      ends_at: new Date(Date.now() + 46 * 86400e3).toISOString(),
      max_redemptions: 100, max_per_customer: 2, redeemed_count: 0, bay_ids: ['B5', 'B6'],
      weekdays: [], start_min: null, end_min: null, membership_scope: 'members', membership_ids: [],
      stacks_with_membership: true, stacks_with_points: false, active: true,
      note: 'Private rooms only, members only, starts next week.', created_at: hoursAgo(200) },
    { id: 'pr-4', code: 'GRANDOPEN', kind: 'percent', percent_off: 50, amount_off_cents: 0,
      max_discount_cents: 4000, min_subtotal_cents: 0,
      starts_at: new Date(Date.now() - 120 * 86400e3).toISOString(),
      ends_at: new Date(Date.now() - 60 * 86400e3).toISOString(),
      max_redemptions: 200, max_per_customer: 1, redeemed_count: 200, bay_ids: [], weekdays: [],
      start_min: null, end_min: null, membership_scope: 'any', membership_ids: [],
      stacks_with_membership: true, stacks_with_points: true, active: true,
      note: 'Opening week. Fully used and long finished.', created_at: hoursAgo(3000) },
    { id: 'pr-5', code: 'STAFF100', kind: 'percent', percent_off: 100, amount_off_cents: 0,
      max_discount_cents: null, min_subtotal_cents: 0, starts_at: null, ends_at: null,
      max_redemptions: null, max_per_customer: 99, redeemed_count: 4, bay_ids: [], weekdays: [],
      start_min: null, end_min: null, membership_scope: 'any', membership_ids: [],
      stacks_with_membership: true, stacks_with_points: true, active: false,
      note: 'Staff comp code. Kept switched off between events.', created_at: hoursAgo(1500) },
  ];
  const PROMO_REDEMPTIONS = [
    ['prr-1', 'pr-1', 'avery.thompson@example.com', 'redeemed', 600, 4],
    ['prr-2', 'pr-1', '+12045550119',               'redeemed', 450, 26],
    ['prr-3', 'pr-2', 'mei.lin@example.com',        'redeemed', 1000, 50],
    ['prr-4', 'pr-1', 'sam.okafor@example.com',     'released', 0, 8],
    ['prr-5', 'pr-2', 'tobias.kern@example.com',    'reserved', 1000, 0.2],
    ['prr-6', 'pr-1', 'harper.vance@example.com',   'redeemed', 525, 74],
  ].map(([id, promo_id, customer_key, status, discount_cents, ago]) => ({
    id, promo_id, customer_key, customer_id: null, booking_id: null, ref: null,
    status, discount_cents,
    expires_at: status === 'reserved' ? new Date(Date.now() + 240e3).toISOString() : null,
    created_at: hoursAgo(ago),
    redeemed_at: status === 'redeemed' ? hoursAgo(ago) : null,
    released_at: status === 'released' ? hoursAgo(ago) : null,
  }));

  // Waiting list. The interesting states are all here: plain waiting, an offer open right now,
  // somebody who claimed one, and somebody who has ignored three offers.
  const WAITLIST = [
    ['wl-1', 'Grace Ferland',  'grace.ferland@example.com',  '+12045550131', 2, [],           600,  840,  60, 2, 'active',  0, null],
    ['wl-2', 'Ibrahim Sesay',  'ibrahim.sesay@example.com',  '+12045550132', 0, ['B5', 'B6'], 1020, 1320, 120, 6, 'offered', 1, 0.3],
    ['wl-3', 'Lena Ostrowski', 'lena.ostrowski@example.com', '+12045550133', 1, [],           960,  1200, 90, 4, 'active',  0, null],
    ['wl-4', 'Marcus Bell',    'marcus.bell@example.com',    '+12045550114', 5, ['B1'],       1080, 1260, 60, 2, 'claimed', 1, 118],
    ['wl-5', 'Priya Raman',    'priya.raman@example.com',    '+12045550113', 3, [],           540,  780,  60, 1, 'active',  3, 30],
    ['wl-6', 'Wes Underhill',  'wes.underhill@example.com',  '+12045550134', 9, ['B4'],       1140, 1380, 120, 4, 'cancelled', 0, null],
  ].map(([id, name, email, phone, dayAhead, bay_ids, ws, we, dur, players, status, offers_sent, lastOfferAgo], i) => ({
    id, token: 'demo-token-' + id, customer_id: null, customer_key: email,
    name, email, phone, email_ok: true, sms_ok: i % 3 !== 2,
    consent_at: hoursAgo(80 + i * 9), consent_ip: null,
    booking_date: dayOffset(dayAhead), bay_ids,
    window_start_min: ws, window_end_min: we, duration_min: dur, players,
    note: i === 1 ? 'Birthday group — will take either private room.' : null,
    status, offers_sent,
    last_offer_at: lastOfferAgo == null ? null : hoursAgo(lastOfferAgo),
    created_at: hoursAgo(80 + i * 9), updated_at: hoursAgo(lastOfferAgo == null ? 80 + i * 9 : lastOfferAgo),
  }));
  const WAITLIST_OFFERS = [
    { id: 'wo-1', entry_id: 'wl-2', claim_token: 'demo-claim-1', booking_date: dayOffset(0), bay_id: 'B5',
      start_min: 1140, end_min: 1260, status: 'offered', reason: 'booking_cancelled', hold_booking_id: null,
      expires_at: new Date(Date.now() + 11 * 60e3).toISOString(), offered_at: hoursAgo(0.3),
      notified_at: hoursAgo(0.3), notify_channels: ['sms', 'email'], claimed_at: null, closed_at: null, booking_id: null },
    { id: 'wo-2', entry_id: 'wl-4', claim_token: 'demo-claim-2', booking_date: dayOffset(-1), bay_id: 'B1',
      start_min: 1080, end_min: 1140, status: 'claimed', reason: 'hold_expired', hold_booking_id: null,
      expires_at: hoursAgo(117), offered_at: hoursAgo(118), notified_at: hoursAgo(118),
      notify_channels: ['sms'], claimed_at: hoursAgo(117.6), closed_at: hoursAgo(117.6), booking_id: null },
    { id: 'wo-3', entry_id: 'wl-5', claim_token: 'demo-claim-3', booking_date: dayOffset(3), bay_id: 'B2',
      start_min: 600, end_min: 660, status: 'expired', reason: 'booking_cancelled', hold_booking_id: null,
      expires_at: hoursAgo(29.75), offered_at: hoursAgo(30), notified_at: hoursAgo(30),
      notify_channels: ['email'], claimed_at: null, closed_at: hoursAgo(29.75), booking_id: null },
    { id: 'wo-4', entry_id: 'wl-5', claim_token: 'demo-claim-4', booking_date: dayOffset(3), bay_id: 'B3',
      start_min: 660, end_min: 720, status: 'declined', reason: 'override_removed', hold_booking_id: null,
      expires_at: hoursAgo(53.75), offered_at: hoursAgo(54), notified_at: hoursAgo(54),
      notify_channels: ['email'], claimed_at: null, closed_at: hoursAgo(53.8), booking_id: null },
  ];

  /* ---------- Groups and series (migration 0023) ----------
     Two things the tee sheet has to be able to say out loud: a corporate party is ONE booking
     across three bays, and a league night is one arrangement repeating every week. Both are
     placed on today so they are the first thing a demo shows. */
  const TODAY_ISO = dayOffset(0);
  const TODAY_WD = new Date(TODAY_ISO + 'T00:00:00').getDay();

  const BOOKING_SERIES = [
    { id: 'ser-corp', label: 'Halbrite Ltd — team afternoon', freq: 'once', interval_n: 1,
      start_date: TODAY_ISO, until_date: TODAY_ISO, max_occurrences: 1,
      bay_ids: ['B1', 'B2', 'B3'], start_min: 720, end_min: 840, players: 9,
      customer_id: null, customer_name: 'Halbrite Ltd', customer_email: 'events@example.com',
      customer_phone: '+12045550140', status_label: 'Booked', source: 'manager',
      note: 'Nine people, three bays, invoice on the day.', status: 'active',
      pay_mode: 'per_occurrence', materialised_through: TODAY_ISO,
      created_at: hoursAgo(300), updated_at: hoursAgo(300) },
    { id: 'ser-league', label: DOW_NAMES[TODAY_WD] + ' Night League', freq: 'weekly', interval_n: 1,
      start_date: dayOffset(-28), until_date: dayOffset(56), max_occurrences: null,
      bay_ids: ['B5', 'B6'], start_min: 1140, end_min: 1260, players: 8,
      customer_id: null, customer_name: 'Winnipeg Sim League', customer_email: 'league@example.com',
      customer_phone: '+12045550141', status_label: 'Booked', source: 'manager',
      note: 'Both private rooms. Same eight players every week.', status: 'active',
      pay_mode: 'per_occurrence', materialised_through: dayOffset(56),
      created_at: hoursAgo(750), updated_at: hoursAgo(24) },
  ];

  const BOOKING_GROUPS = [
    { id: 'grp-corp', series_id: 'ser-corp', occurrence_date: TODAY_ISO, seq: 1, booking_date: TODAY_ISO,
      start_min: 720, end_min: 840, status: 'confirmed', bay_count: 3, players: 9,
      list_price_cents: 12000, amount_cents: 12000, refunded_cents: 0,
      stripe_payment_intent: null, note: null, moved_at: null, created_at: hoursAgo(300), cancelled_at: null },
  ];

  // Weekly occurrences from four weeks back to eight weeks ahead. Only the ones from today
  // onward get real bookings rows: the past weeks of this demo are already filled by the
  // history generator above, and two bookings in one bay at one time would just hide each other.
  const LEAGUE_ROWS = [];
  for (let k = 0, d = -28; d <= 56; d += 7, k++) {
    const date = dayOffset(d);
    BOOKING_GROUPS.push({
      id: 'grp-league-' + k, series_id: 'ser-league', occurrence_date: date, seq: k + 1,
      booking_date: date, start_min: 1140, end_min: 1260,
      status: 'confirmed', bay_count: 2, players: 8,
      list_price_cents: 10000, amount_cents: 10000, refunded_cents: 0,
      stripe_payment_intent: null, note: null, moved_at: null,
      created_at: hoursAgo(750), cancelled_at: null,
    });
    if (d >= 0) LEAGUE_ROWS.push(['grp-league-' + k, date]);
  }

  // The bookings themselves — one row per bay per occurrence, which is what the grid needs.
  const groupBooking = (bay, date, s, e, groupId, seriesId, name, email, phone, cents) => ({
    id: uid('bk'), bay_id: bay, booking_date: date, start_min: s, end_min: e,
    status: 'confirmed', status_label: 'Booked',
    customer_name: name, customer_email: email, customer_phone: phone,
    amount_cents: cents, stripe_payment_intent: null, source: 'admin', note: null, tags: ['League'],
    expires_at: null, cancelled_at: null, created_at: hoursAgo(300),
    group_id: groupId, series_id: seriesId, refunded_cents: 0,
  });
  ['B1', 'B2', 'B3'].forEach((bay) => BOOKINGS.push(
    groupBooking(bay, TODAY_ISO, 720, 840, 'grp-corp', 'ser-corp',
      'Halbrite Ltd', 'events@example.com', '+12045550140', 4000)));
  LEAGUE_ROWS.forEach(([groupId, date]) => ['B5', 'B6'].forEach((bay) => BOOKINGS.push(
    groupBooking(bay, date, 1140, 1260, groupId, 'ser-league',
      'Winnipeg Sim League', 'league@example.com', '+12045550141', 5000))));

  /* ---------- league rounds (migration 0031) ----------
     A team's weekly round is an ordinary booking with league_team_id on it, made by whoever on
     the team got there first. It costs nothing: the team paid for the season up front. */
  LEAGUE_ROUNDS.forEach((r) => BOOKINGS.push({
    id: uid('bk'), bay_id: r.bay_id, booking_date: r.booking_date,
    start_min: r.start_min, end_min: r.end_min,
    status: 'confirmed', status_label: r.weeksAgo > 0 ? 'Checked In' : 'Booked',
    customer_name: r.captain.name, customer_email: r.captain.email, customer_phone: r.captain.phone,
    amount_cents: 0, stripe_payment_intent: null, source: 'online',
    note: r.team + ' — league round', tags: ['League'],
    expires_at: null, cancelled_at: null, created_at: hoursAgo(Math.max(0, r.weeksAgo) * 168 + 40),
    group_id: null, series_id: null, refunded_cents: 0,
    league_team_id: r.team_id, league_week: r.league_week,
  }));

  /* ---------- Staff, roles and the activity log (migration 0024) ---------- */
  const CAPABILITIES = [
    { key: 'booking.write',  label: 'Bookings',     description: 'Create, move and cancel reservations, blocks, groups, leagues and the waiting list.', sort: 0 },
    { key: 'customer.write', label: 'Customers',    description: 'Edit customer records, contact details and marketing consent.', sort: 1 },
    { key: 'money.write',    label: 'Money',        description: 'Refunds, gift cards, promo codes and prepaid-hour balances, and the price on an existing booking.', sort: 2 },
    { key: 'config.write',   label: 'Setup',        description: 'Rates, opening hours, bays, membership plans, hour packages and status labels.', sort: 3 },
    { key: 'staff.manage',   label: 'Staff',        description: 'Add and remove staff logins and change what each role may do.', sort: 4 },
    { key: 'audit.read',     label: 'Activity log', description: 'Read the record of who changed what.', sort: 5 },
  ];
  const ROLE_PERMISSIONS = [];
  [['employee', ['booking.write', 'customer.write']], ['readonly', []]].forEach(([role, yes]) =>
    CAPABILITIES.forEach((c) => ROLE_PERMISSIONS.push({
      role, capability: c.key, allowed: yes.includes(c.key), updated_at: hoursAgo(500),
    })));
  const STAFF = [
    { user_id: 'demo-user', email: 'manager@invictusgolf.demo', name: 'Demo Manager', role: 'admin', is_active: true, note: 'Owner account.', created_by: null, created_at: hoursAgo(4000), updated_at: hoursAgo(4000) },
    { user_id: '8f2a1c44-1d3e-4f7a-9b21-6c5d0e8a7b31', email: 'counter@invictusgolf.demo', name: 'Sam Okafor', role: 'employee', is_active: true, note: 'Weekend counter.', created_by: null, created_at: hoursAgo(900), updated_at: hoursAgo(120) },
    { user_id: '3b71d905-6a24-4c18-8e55-2f9a4c6b1d77', email: 'evenings@invictusgolf.demo', name: 'Riley Fontaine', role: 'employee', is_active: true, note: null, created_by: null, created_at: hoursAgo(600), updated_at: hoursAgo(600) },
    { user_id: 'c0d94e12-77b8-4a63-9f10-5e8b3a2c4d09', email: 'books@invictusgolf.demo', name: 'Dana Whitecloud', role: 'readonly', is_active: true, note: 'Bookkeeper — figures only.', created_by: null, created_at: hoursAgo(400), updated_at: hoursAgo(400) },
    { user_id: 'a17f6c83-2e49-4b50-91cd-7a3e5f8d2b64', email: 'summer@invictusgolf.demo', name: 'Tobias Kern', role: 'employee', is_active: false, note: 'Seasonal — suspended out of season.', created_by: null, created_at: hoursAgo(2200), updated_at: hoursAgo(300) },
  ];
  const AUDIT_LOG = [
    ['update', 'bookings',         'Moved to Bay #3, 7:00 PM', 'counter@invictusgolf.demo',  'employee', 2],
    ['update', 'gift_cards',       'Card put on hold — reported lost', 'manager@invictusgolf.demo', 'admin', 5],
    ['insert', 'promos',           'LEAGUE25 created', 'manager@invictusgolf.demo', 'admin', 9],
    ['update', 'settings',         'Weekend rate changed', 'manager@invictusgolf.demo', 'admin', 26],
    ['delete', 'bookings',         'Cancelled — customer called', 'evenings@invictusgolf.demo', 'employee', 30],
    ['update', 'customers',        'Phone number corrected', 'counter@invictusgolf.demo', 'employee', 33],
    ['insert', 'gift_card_transactions', 'Issued at the counter', 'manager@invictusgolf.demo', 'admin', 48],
    ['update', 'role_permissions', 'Employees may no longer touch money', 'manager@invictusgolf.demo', 'admin', 72],
    ['insert', 'staff',            'Riley Fontaine added as an employee', 'manager@invictusgolf.demo', 'admin', 600],
  ].map(([action, table_name, note, actor_email, actor_role, ago], i) => ({
    id: i + 1, at: hoursAgo(ago), actor_id: null, actor_email, actor_role, action,
    table_name, row_id: null, changed: null, row_before: null, row_after: null,
    note, source: 'trigger',
  }));

  /* ---------- everything the manager tabs read ---------- */
  const DB = {
    settings: [{
      id: 1, bays: BAYS,
      hours: { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] },
      rates: FLAT, bay_rates: {}, min_mins: 60, max_party: 4, slot_step: 30,
      weekly_status: {}, online_status_label: 'Booked',
      pay: {}, booking_window: { regularDays: 10, leagueDays: 60 },
      updated_at: hoursAgo(20),
    }],
    bookings: BOOKINGS,
    customers: CUSTOMERS,
    booking_statuses: [
      { id: uid('st'), label: 'Booked', color: '#4AA3FF', sort: 1, kind: 'open', created_at: hoursAgo(900) },
      { id: uid('st'), label: 'Checked In', color: '#067647', sort: 2, kind: 'open', created_at: hoursAgo(900) },
      { id: uid('st'), label: 'No Show', color: '#B26A15', sort: 3, kind: 'open', created_at: hoursAgo(900) },
      { id: uid('st'), label: 'Cancelled', color: '#D92D20', sort: 4, kind: 'closed', created_at: hoursAgo(900) },
      { id: uid('st'), label: 'Maintenance', color: '#555C68', sort: 5, kind: 'closed', created_at: hoursAgo(900) },
    ],
    bay_categories: [
      { id: uid('cat'), name: 'Sponsored Bays', color: '#F0523D', sort: 1, created_at: hoursAgo(900) },
      { id: uid('cat'), name: 'Public', color: '#4AA3FF', sort: 2, created_at: hoursAgo(900) },
      { id: uid('cat'), name: 'Private Rooms', color: '#067647', sort: 3, created_at: hoursAgo(900) },
    ],
    tags: [
      { id: uid('tag'), name: 'VIP', color: '#F0523D', created_at: hoursAgo(800) },
      { id: uid('tag'), name: 'League', color: '#4AA3FF', created_at: hoursAgo(800) },
      { id: uid('tag'), name: 'Lesson', color: '#067647', created_at: hoursAgo(800) },
      { id: uid('tag'), name: 'Birthday', color: '#B26A15', created_at: hoursAgo(800) },
    ],
    memberships: [
      { id: 'demo-range', name: 'Range Pass', price_cents: 4900, period: 'month', discount_pct: 10, perks: '10% off every bay booking\nPriority booking window\nMember-only league nights', color: '#4AA3FF', sort: 1, created_at: hoursAgo(900) },
      { id: 'demo-clubhouse', name: 'Clubhouse', price_cents: 9900, period: 'month', discount_pct: 15, perks: '15% off every bay booking\nTwo guest passes a month\nComplimentary coffee on every visit', color: '#F0523D', sort: 2, created_at: hoursAgo(900) },
      { id: 'demo-elite', name: 'Invictus Elite', price_cents: 19900, period: 'month', discount_pct: 25, perks: '25% off every bay booking\nUnlimited guest passes\nAnnual club-fitting session\nReserved bay on request', color: '#14161A', sort: 3, created_at: hoursAgo(900) },
    ],
    hour_cards: [
      { id: 'demo-5h', name: '5-Hour Card', hours: 5, price_cents: 13500, color: '#4AA3FF', sort: 1, created_at: hoursAgo(900) },
      { id: 'demo-10h', name: '10-Hour Card', hours: 10, price_cents: 25000, color: '#067647', sort: 2, created_at: hoursAgo(900) },
      { id: 'demo-20h', name: '20-Hour Card', hours: 20, price_cents: 46000, color: '#F0523D', sort: 3, created_at: hoursAgo(900) },
    ],
    hour_transactions: [],
    price_templates: [
      { id: uid('tpl'), name: 'Standard — CA$20 flat', rates: FLAT, bay_ids: [], created_at: hoursAgo(700) },
      { id: uid('tpl'), name: 'Private rooms — CA$25', rates: { weekdayOffPeak: 25, weekdayPeak: 25, weekendOffPeak: 25, weekendPeak: 25 }, bay_ids: ['B5', 'B6'], created_at: hoursAgo(690) },
    ],
    // public_reason (migration 0032) decides whether customers read the reason on the booking
    // page or only staff read it on the tee sheet. One of each here, plus one with no reason at
    // all — which has nothing to show either way.
    schedule_overrides: [
      { id: uid('ovr'), override_date: dayOffset(9), end_date: null, is_closed: true, open_hour: null, close_hour: null, note: 'Staff training — closed', bay_ids: [], start_min: null, end_min: null, status_color: null, status_open: false, is_active: true, public_reason: false, created_at: hoursAgo(100) },
      { id: uid('ovr'), override_date: dayOffset(14), end_date: null, is_closed: false, open_hour: 8, close_hour: 18, note: 'Corporate event — short day', bay_ids: [], start_min: null, end_min: null, status_color: null, status_open: false, is_active: true, public_reason: true, created_at: hoursAgo(90) },
      { id: uid('ovr'), override_date: dayOffset(21), end_date: null, is_closed: true, open_hour: null, close_hour: null, note: null, bay_ids: [], start_min: null, end_min: null, status_color: null, status_open: false, is_active: true, public_reason: true, created_at: hoursAgo(80) },
    ],
    schedule_templates: [
      { id: uid('tmpl'), name: 'Regular week (24 hours)', hours: { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] }, created_at: hoursAgo(650) },
    ],

    // ---- Tier 2 (migrations 0019-0024). The empty ones are here on purpose: the manager view
    // never reads them, but a stray query lands on a real empty table instead of undefined.
    gift_cards: GIFT_CARDS,
    gift_card_transactions: GIFT_TX,
    gift_card_reservations: [],
    gift_card_attempts: [],
    promos: PROMOS,
    promo_redemptions: PROMO_REDEMPTIONS,
    promo_attempts: [],
    waitlist_entries: WAITLIST,
    waitlist_offers: WAITLIST_OFFERS,
    waitlist_wakeups: [],
    booking_series: BOOKING_SERIES,
    booking_groups: BOOKING_GROUPS,
    booking_series_exceptions: [],
    refunds: [],
    notifications: [],
    staff: STAFF,
    capabilities: CAPABILITIES,
    role_permissions: ROLE_PERMISSIONS,
    audit_log: AUDIT_LOG,
    leagues: [LEAGUE_THU, LEAGUE_SUN],
    league_teams: LEAGUE_TEAMS,
    league_members: LEAGUE_MEMBERS,
    league_results: LEAGUE_RESULTS,
    league_team_invites: LEAGUE_INVITES,
    league_cancelled_nights: LEAGUE_CANCELLED,
    booking_feedback: [],
  };

  // ledger rows referencing real customers
  CUSTOMERS.forEach((c, i) => {
    if (c.hours_balance_min > 0) {
      DB.hour_transactions.push({
        id: uid('ht'), customer_id: c.id, minutes: c.hours_balance_min, kind: 'purchase',
        note: 'Hour card purchase', booking_id: null, ref: null, created_at: hoursAgo(48 + i * 21),
      });
    }
  });

  /* ---------- the two things migration 0031 makes the DATABASE do to a booking ----------
     Both belong here, not in the manager portal: the portal checks the week first only so it can
     show a useful sentence, and then leans on the database to be what actually refuses. Without
     these, the demo would accept a team's second round in a week and the backstop the real schema
     provides could never be seen. */

  // bookings.league_week is generated always as date_trunc('week', booking_date) — never supplied.
  const stampWeek = (r) => { if (r && r.booking_date) r.league_week = weekOf(r.booking_date); return r; };

  // The partial unique index bookings_league_round_once: one LIVE round per team per week. A
  // cancelled round frees the week again, exactly as the index's WHERE clause says.
  const DUP_ROUND = { code: '23505', message: 'duplicate key value violates unique constraint "bookings_league_round_once"' };
  function leagueRoundTaken(row, self) {
    if (!row || !row.league_team_id || row.status === 'cancelled') return null;
    return (DB.bookings || []).find((b) => b !== self && b.id !== row.id
      && b.league_team_id === row.league_team_id && b.league_week === row.league_week
      && b.status !== 'cancelled') || null;
  }

  /* ---------- filtering ---------- */
  const norm = (v) => (v == null ? '' : String(v).toLowerCase());

  function testOne(row, col, op, val) {
    const v = row[col];
    switch (op) {
      case 'eq': return String(v) === String(val);
      case 'neq': return String(v) !== String(val);
      case 'gt': return v > val;
      case 'gte': return v >= val;
      case 'lt': return v < val;
      case 'lte': return v <= val;
      case 'is': return val === null || val === 'null' ? (v === null || v === undefined) : v === val;
      case 'in': return (val || []).map(String).includes(String(v));
      case 'like':
      case 'ilike': {
        const pat = norm(val).replace(/%/g, '');
        return norm(v).includes(pat) && pat !== '';
      }
      default: return true;
    }
  }

  // PostgREST-style "col.op.value,col.op.value" — any match passes
  function testOr(row, expr) {
    return String(expr || '').split(',').filter(Boolean).some((part) => {
      const [col, op, ...rest] = part.split('.');
      return testOne(row, col, op, rest.join('.'));
    });
  }

  function applyFilters(rows, filters) {
    return rows.filter((r) => filters.every((f) => {
      if (f.op === 'or') return testOr(r, f.val);
      const hit = testOne(r, f.col, f.op, f.val);
      return f.negate ? !hit : hit;
    }));
  }

  /* ---------- the chainable query builder ---------- */
  function from(table) {
    const st = {
      table, mode: 'select', cols: '*', filters: [], orders: [],
      limitN: null, head: false, count: false, payload: null,
      single: false, maybeSingle: false, returning: false,
    };

    const addF = (col, op, val, negate) => { st.filters.push({ col, op, val, negate: !!negate }); return api; };

    const run = () => {
      const rows = DB[table] || [];

      if (st.mode === 'insert') {
        const incoming = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((r) => ({
          id: r.id || uid(table.slice(0, 3)),
          created_at: r.created_at || new Date().toISOString(),
          ...r,
        }));
        if (table === 'bookings') {
          incoming.forEach(stampWeek);
          if (incoming.some((r) => leagueRoundTaken(r))) return { data: null, error: DUP_ROUND, count: 0 };
        }
        rows.push(...incoming);
        const data = st.single ? incoming[0] : (st.returning ? incoming : null);
        return { data: data ?? null, error: null, count: incoming.length };
      }

      if (st.mode === 'update') {
        const hits = applyFilters(rows, st.filters);
        if (table === 'bookings') {
          for (const r of hits) if (leagueRoundTaken(stampWeek({ ...r, ...st.payload }), r)) return { data: null, error: DUP_ROUND, count: 0 };
        }
        hits.forEach((r) => { Object.assign(r, st.payload); if (table === 'bookings') stampWeek(r); });
        return { data: st.returning ? hits : null, error: null, count: hits.length };
      }

      if (st.mode === 'delete') {
        const hits = applyFilters(rows, st.filters);
        DB[table] = rows.filter((r) => !hits.includes(r));
        // Mirror the schema's foreign keys (0028/0030/0031) so deleting a team or league behaves
        // like the real database.
        const ids = hits.map((r) => r.id);
        if (table === 'league_teams') {
          (DB.league_members || []).forEach((m) => { if (ids.includes(m.team_id)) m.team_id = null; });
          DB.league_results = (DB.league_results || []).filter((r) => !ids.includes(r.team_id));
          DB.league_team_invites = (DB.league_team_invites || []).filter((r) => !ids.includes(r.team_id));
          (DB.bookings || []).forEach((b) => { if (ids.includes(b.league_team_id)) b.league_team_id = null; });
        }
        if (table === 'leagues') {
          const teamIds = (DB.league_teams || []).filter((t) => ids.includes(t.league_id)).map((t) => t.id);
          DB.league_team_invites = (DB.league_team_invites || []).filter((r) => !teamIds.includes(r.team_id));
          (DB.bookings || []).forEach((b) => { if (teamIds.includes(b.league_team_id)) b.league_team_id = null; });
          ['league_teams', 'league_members', 'league_results', 'league_cancelled_nights']
            .forEach((t) => { if (DB[t]) DB[t] = DB[t].filter((r) => !ids.includes(r.league_id)); });
        }
        return { data: null, error: null, count: hits.length };
      }

      // select
      let out = applyFilters(rows, st.filters).slice();
      st.orders.forEach(({ col, asc }) => {
        out.sort((a, b) => {
          const x = a[col], y = b[col];
          if (x === y) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          return (x > y ? 1 : -1) * (asc ? 1 : -1);
        });
      });
      const total = out.length;
      if (st.limitN != null) out = out.slice(0, st.limitN);
      if (st.head) return { data: null, error: null, count: total };

      // embedded relation, e.g. select('minutes,...,customers(name)')
      if (/customers\s*\(/.test(st.cols)) {
        out = out.map((r) => ({
          ...r,
          customers: DB.customers.find((c) => c.id === r.customer_id) || null,
        }));
      }
      out = out.map((r) => ({ ...r }));   // hand back copies, not live refs

      if (st.single) return { data: out[0] || null, error: out.length ? null : { message: 'No rows found' }, count: total };
      if (st.maybeSingle) return { data: out[0] || null, error: null, count: total };
      return { data: out, error: null, count: total };
    };

    const api = {
      select(cols, opts) {
        if (st.mode === 'select') { st.cols = cols || '*'; }
        else { st.returning = true; }
        if (opts && opts.head) st.head = true;
        if (opts && opts.count) st.count = true;
        return api;
      },
      insert(payload) { st.mode = 'insert'; st.payload = payload; return api; },
      update(payload) { st.mode = 'update'; st.payload = payload; return api; },
      delete() { st.mode = 'delete'; return api; },
      upsert(payload) { st.mode = 'insert'; st.payload = payload; return api; },

      eq: (c, v) => addF(c, 'eq', v),
      neq: (c, v) => addF(c, 'neq', v),
      gt: (c, v) => addF(c, 'gt', v),
      gte: (c, v) => addF(c, 'gte', v),
      lt: (c, v) => addF(c, 'lt', v),
      lte: (c, v) => addF(c, 'lte', v),
      is: (c, v) => addF(c, 'is', v),
      in: (c, v) => addF(c, 'in', v),
      like: (c, v) => addF(c, 'like', v),
      ilike: (c, v) => addF(c, 'ilike', v),
      not: (c, op, v) => addF(c, op, v, true),
      or: (expr) => addF(null, 'or', expr),

      order(col, opts) { st.orders.push({ col, asc: !opts || opts.ascending !== false }); return api; },
      limit(n) { st.limitN = n; return api; },
      range(a, b) { st.limitN = b - a + 1; return api; },
      single() { st.single = true; return api; },
      maybeSingle() { st.maybeSingle = true; return api; },

      // makes the builder awaitable, exactly like the real client
      then(resolve, reject) {
        try { return Promise.resolve(run()).then(resolve, reject); }
        catch (e) { return Promise.resolve({ data: null, error: { message: String(e) } }).then(resolve); }
      },
    };
    return api;
  }

  /* ---------- the fake client ---------- */
  const SESSION = {
    access_token: 'demo-mode',
    user: { id: 'demo-user', email: 'manager@invictusgolf.demo' },
  };

  window.createDemoSupabase = function () {
    return {
      __demo: true,
      from,
      auth: {
        getSession: async () => ({ data: { session: SESSION }, error: null }),
        getUser: async () => ({ data: { user: SESSION.user }, error: null }),
        signInWithPassword: async () => ({ data: { session: SESSION }, error: null }),
        signOut: async () => ({ error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
      // Two RPCs the manager view genuinely depends on, stood up in memory so the demo shows
      // the real screens rather than an error state. Anything else still answers with a clean
      // error instead of a TypeError.
      rpc: async (fn, args) => {
        const a = args || {};
        // Who is signed in and what may they do. The demo is the owner, so: everything.
        if (fn === 'staff_whoami') {
          return { data: {
            user_id: SESSION.user.id, email: SESSION.user.email, name: 'Demo Manager',
            role: 'admin', bootstrap: false, capabilities: DB.capabilities.map((c) => c.key),
          }, error: null };
        }
        // Balance and ledger row in one step, exactly like the SQL function it stands in for —
        // including its two refusals, so the manager screen's error paths are demonstrable.
        if (fn === 'adjust_gift_card') {
          const card = DB.gift_cards.find((c) => c.id === a.p_card);
          if (!card) return { data: null, error: { message: 'gift card not found' } };
          const delta = Math.round(Number(a.p_delta) || 0);
          if (delta < 0 && card.status !== 'active') return { data: null, error: { message: 'gift card is ' + card.status } };
          if (card.balance_cents + delta < 0) return { data: null, error: { message: 'insufficient gift card balance' } };
          card.balance_cents += delta;
          DB.gift_card_transactions.unshift({
            id: uid('gtx'), gift_card_id: card.id, cents: delta, kind: a.p_kind || 'adjust',
            note: a.p_note || null, booking_id: a.p_booking || null, ref: a.p_ref || null,
            created_at: new Date().toISOString(),
          });
          return { data: card.balance_cents, error: null };
        }
        return { data: null, error: { message: 'Not available in demo mode' } };
      },
    };
  };
})();
