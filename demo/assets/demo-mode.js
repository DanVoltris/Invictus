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

  const FLAT = { weekdayOffPeak: 20, weekdayPeak: 20, weekendOffPeak: 20, weekendPeak: 20 };

  /* ---------- customers ---------- */
  const CUSTOMERS = [
    ['Avery Thompson', 'avery.thompson@example.com', '+12045550111', 240, 90, 'demo-clubhouse'],
    ['Jordan Reyes', 'jordan.reyes@example.com', '+12045550112', 0, 0, null],
    ['Priya Raman', 'priya.raman@example.com', '+12045550113', 480, 260, 'demo-elite'],
    ['Marcus Bell', 'marcus.bell@example.com', '+12045550114', 60, 20, null],
    ['Chloe Nguyen', 'chloe.nguyen@example.com', '+12045550115', 0, 140, 'demo-range'],
    ['Sam Okafor', 'sam.okafor@example.com', '+12045550116', 120, 0, null],
    ['Riley Fontaine', 'riley.fontaine@example.com', '+12045550117', 300, 75, 'demo-clubhouse'],
    ['Dana Whitecloud', 'dana.whitecloud@example.com', '+12045550118', 0, 0, null],
    ['Owen Brar', 'owen.brar@example.com', '+12045550119', 90, 310, 'demo-elite'],
    ['Mei Lin', 'mei.lin@example.com', '+12045550120', 0, 45, null],
    ['Tobias Kern', 'tobias.kern@example.com', '+12045550121', 180, 0, 'demo-range'],
    ['Harper Vance', 'harper.vance@example.com', '+12045550122', 0, 15, null],
  ].map(([name, email, phone, hours_balance_min, points_balance, membership_id], i) => ({
    id: uid('cust'), name, email, phone,
    membership_id,
    membership_expires: membership_id ? dayOffset(200 + i * 9) : null,
    membership_flag: null,
    notes: i === 2 ? 'Prefers Bay #3. Left-handed setup.' : null,
    hours_balance_min, points_balance,
    sms_opt_in: i % 3 !== 0,
    waiver_signed_at: i % 4 === 0 ? hoursAgo(72 + i * 11) : null,
    waiver_name: i % 4 === 0 ? name : null,
    waiver_version: i % 4 === 0 ? 'v2' : null,
    waiver_code: i % 4 === 0 ? 'WV-' + (2200 + i) : null,
    legacy_bookings: 0, legacy_attendee: 0, legacy_cancelled: 0, legacy_no_show: 0,
    created_at: hoursAgo(600 + i * 40),
  }));

  /* ---------- bookings: a busy but plausible week ---------- */
  const NAMES = CUSTOMERS.map((c) => [c.name, c.email, c.phone]);
  const BOOKINGS = [];
  const SLOTS = [
    [600, 690], [690, 810], [780, 870], [870, 990], [960, 1050],
    [1050, 1170], [1140, 1230], [1230, 1350], [540, 630], [1320, 1410],
  ];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };

  for (let d = -3; d <= 6; d++) {
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

  /* ---------- everything the manager tabs read ---------- */
  const DB = {
    settings: [{
      id: 1, bays: BAYS,
      hours: { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] },
      rates: FLAT, bay_rates: {}, min_mins: 60, max_party: 4, slot_step: 30,
      weekly_status: {}, online_status_label: 'Booked',
      pay: {}, points: { earnPerDollar: 1, redeemvalue: 0.05 },
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
    point_transactions: [],
    price_templates: [
      { id: uid('tpl'), name: 'Standard — CA$20 flat', rates: FLAT, bay_ids: [], created_at: hoursAgo(700) },
      { id: uid('tpl'), name: 'Private rooms — CA$25', rates: { weekdayOffPeak: 25, weekdayPeak: 25, weekendOffPeak: 25, weekendPeak: 25 }, bay_ids: ['B5', 'B6'], created_at: hoursAgo(690) },
    ],
    schedule_overrides: [
      { id: uid('ovr'), override_date: dayOffset(9), end_date: null, is_closed: true, open_hour: null, close_hour: null, note: 'Staff training — closed', bay_ids: [], start_min: null, end_min: null, status_color: null, status_open: false, is_active: true, created_at: hoursAgo(100) },
      { id: uid('ovr'), override_date: dayOffset(14), end_date: null, is_closed: false, open_hour: 8, close_hour: 18, note: 'Corporate event — short day', bay_ids: [], start_min: null, end_min: null, status_color: null, status_open: false, is_active: true, created_at: hoursAgo(90) },
    ],
    schedule_templates: [
      { id: uid('tmpl'), name: 'Regular week (24 hours)', hours: { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] }, created_at: hoursAgo(650) },
    ],
  };

  // ledger rows referencing real customers
  CUSTOMERS.forEach((c, i) => {
    if (c.points_balance > 0) {
      DB.point_transactions.push({
        id: uid('pt'), customer_id: c.id, points: c.points_balance, kind: 'earn',
        note: 'Bay session', booking_id: null, ref: null, created_at: hoursAgo(30 + i * 17),
      });
    }
    if (i % 5 === 0) {
      DB.point_transactions.push({
        id: uid('pt'), customer_id: c.id, points: -20, kind: 'redeem',
        note: 'Redeemed against booking', booking_id: null, ref: null, created_at: hoursAgo(12 + i * 9),
      });
    }
    if (c.hours_balance_min > 0) {
      DB.hour_transactions.push({
        id: uid('ht'), customer_id: c.id, minutes: c.hours_balance_min, kind: 'purchase',
        note: 'Hour card purchase', booking_id: null, ref: null, created_at: hoursAgo(48 + i * 21),
      });
    }
  });

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
        rows.push(...incoming);
        const data = st.single ? incoming[0] : (st.returning ? incoming : null);
        return { data: data ?? null, error: null, count: incoming.length };
      }

      if (st.mode === 'update') {
        const hits = applyFilters(rows, st.filters);
        hits.forEach((r) => Object.assign(r, st.payload));
        return { data: st.returning ? hits : null, error: null, count: hits.length };
      }

      if (st.mode === 'delete') {
        const hits = applyFilters(rows, st.filters);
        DB[table] = rows.filter((r) => !hits.includes(r));
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

      // embedded relation, e.g. select('points,...,customers(name)')
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
      // storage/rpc are unused by the manager view, but stubbed so a stray call
      // surfaces as a clean error instead of a TypeError
      rpc: async () => ({ data: null, error: { message: 'Not available in demo mode' } }),
    };
  };
})();
