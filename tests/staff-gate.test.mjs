// Manager-only actions in api/booking-series.js and api/waitlist.js must need a STAFF login,
// not just any Supabase session — customer accounts sign in to the same auth project.
//
// What is real and what is fake:
//   · @supabase/supabase-js is mocked with an in-memory client (auth.getUser + table reads).
//   · lib/db.js is mocked so no handler can touch a database, BUT its staffContext/verifyManager
//     are the REAL ones from lib/db.js, running against that fake client. So the rule under test
//     (staff table, role_permissions, the customer_signup marker) is the production code.
//   · Every other lib/db.js export is a spy; any call to a write function is recorded.
//
//   node --experimental-test-module-mocks --test <this file>
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const url = (...p) => pathToFileURL(path.join(ROOT, ...p)).href;
const SECRET = 'test-only-not-a-real-secret';

// ----- fake Supabase ------------------------------------------------------------------------
const users = {
  'tok-admin':    { id: 'u-admin', email: 'admin@invictus.test', user_metadata: { source: 'staff_setup' } },
  'tok-employee': { id: 'u-emp',   email: 'emp@invictus.test',   user_metadata: { source: 'staff_invite' } },
  'tok-readonly': { id: 'u-ro',    email: 'ro@invictus.test',    user_metadata: { source: 'staff_invite' } },
  'tok-customer': { id: 'u-cust',  email: 'golfer@example.com',  user_metadata: { source: 'customer_signup', phone: '2045550100' } },
};
const tables = {
  staff: [
    { user_id: 'u-admin', role: 'admin',    is_active: true },
    { user_id: 'u-emp',   role: 'employee', is_active: true },
    { user_id: 'u-ro',    role: 'readonly', is_active: true },
  ],
  customers: [{ id: 'c-1', user_id: 'u-cust' }],
  capabilities: ['booking.write', 'customer.write', 'money.write', 'config.write', 'staff.manage', 'audit.read']
    .map((key, sort) => ({ key, sort })),
  // Migration 0024's seed, verbatim.
  role_permissions: [
    ['employee', 'booking.write', true], ['employee', 'customer.write', true], ['employee', 'money.write', false],
    ['employee', 'config.write', false], ['employee', 'staff.manage', false], ['employee', 'audit.read', false],
    ...['booking.write', 'customer.write', 'money.write', 'config.write', 'staff.manage', 'audit.read']
      .map((c) => ['readonly', c, false]),
  ].map(([role, capability, allowed]) => ({ role, capability, allowed })),
};
let rawWrites = [];
function from(table) {
  let rows = [...(tables[table] || [])];
  const write = (op) => () => { rawWrites.push({ table, op }); return q; };
  const q = {
    select() { return q; },
    eq(col, val) { rows = rows.filter((r) => r[col] === val); return q; },
    order() { return q; },
    limit(n) { rows = rows.slice(0, n); return q; },
    insert: write('insert'), update: write('update'), upsert: write('upsert'), delete: write('delete'),
    maybeSingle: async () => ({ data: rows[0] || null, error: null }),
    single: async () => ({ data: rows[0] || null, error: rows[0] ? null : { message: 'no rows' } }),
    then(ok, bad) { return Promise.resolve({ data: rows, error: null }).then(ok, bad); },
  };
  return q;
}
const fakeClient = {
  auth: {
    getUser: async (t) => (users[t]
      ? { data: { user: users[t] }, error: null }
      : { data: { user: null }, error: { message: 'invalid JWT' } }),
  },
  from,
  rpc: async (fn) => { rawWrites.push({ rpc: fn }); return { data: null, error: null }; },
};
mock.module(url('node_modules', '@supabase', 'supabase-js', 'dist', 'index.mjs'), {
  namedExports: { createClient: () => fakeClient },
});

process.env.SUPABASE_URL = 'https://fake.supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';

// The real lib/db.js under a different URL, so the mock below does not shadow it.
const realDb = await import(url('lib', 'db.js') + '?real');

// ----- mocked lib/db.js ---------------------------------------------------------------------
const WRITES = new Set([
  'createSeries', 'bookGroup', 'cancelGroup', 'moveGroup', 'recordRefund', 'updateSeries',
  'recordSeriesException', 'runWaitlistSweep', 'updateNotification',
  'markWaitlistOfferNotified', 'insertNotification', 'dueNotifications',
]);
let calls = [];
const returns = {
  getSettings: async () => ({}),
  seriesById: async () => null,
  seriesNeedingHorizon: async () => [],
  cancelGroup: async () => ({
    ok: true, cancelled: [{ id: 'b-1', bayId: 'bay-1', amountCents: 5000, refundedCents: 0 }],
    cancelledCount: 1, remaining: 0, groupStatus: 'cancelled', refundableCents: 5000,
  }),
  recordRefund: async () => ({ ok: true }),
  runWaitlistSweep: async () => ({ ok: true, offered: 0 }),
  pendingWaitlistOffers: async () => [],
  dueNotifications: async () => [],
  customerHoursByContact: async () => null,
};
const fakeDb = {};
for (const name of Object.keys(realDb)) {
  const val = realDb[name];
  if (typeof val !== 'function') { fakeDb[name] = val; continue; }
  fakeDb[name] = async (...args) => {
    calls.push(name);
    return returns[name] ? returns[name](...args) : {};
  };
}
// The two functions under test are the real ones.
fakeDb.staffContext = realDb.staffContext;
fakeDb.verifyManager = realDb.verifyManager;
mock.module(url('lib', 'db.js'), { namedExports: fakeDb });

const { default: series } = await import(url('api', 'booking-series.js'));
const { default: waitlist } = await import(url('api', 'waitlist.js'));

// ----- harness ------------------------------------------------------------------------------
const call = async (handler, { method = 'POST', action, token, headers = {}, body = {}, query = {} }) => {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const req = { method, query: { action, ...query }, body, headers: h, socket: {} };
  const res = {
    code: 200, body: null,
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
  };
  await handler(req, res);
  return res;
};
const writes = () => calls.filter((n) => WRITES.has(n));
const GID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  calls = []; rawWrites = [];
  process.env.WAITLIST_SWEEP_SECRET = SECRET;
  process.env.OUTBOX_SWEEP_SECRET = SECRET;
  process.env.SERIES_SWEEP_SECRET = SECRET;
  globalThis.fetch = async () => { throw new Error('no network in tests'); };
});

const SERIES_WRITES = [
  { action: 'create', body: { startDate: '2099-01-01', startMin: 600, endMin: 660, bayIds: ['B1'], customerName: 'Mallory', customerEmail: 'golfer@example.com' } },
  { action: 'cancel', body: { groupId: GID, refund: true } },
  { action: 'end',    body: { seriesId: SID } },
  { action: 'move',   body: { groupId: GID, dateISO: '2099-01-02' } },
  { action: 'extend', body: {} },
];

// ----- (a) not signed in -> 401 ------------------------------------------------------------
test('(a) booking-series: no token -> 401 on every action, nothing written', async () => {
  for (const a of [...SERIES_WRITES, { action: 'preview', body: {} }]) {
    const res = await call(series, a);
    assert.equal(res.code, 401, `${a.action}: ${JSON.stringify(res.body)}`);
  }
  const get = await call(series, { method: 'GET', action: 'get', query: { id: SID } });
  assert.equal(get.code, 401);
  assert.deepEqual(writes(), []);
});

test('(a) booking-series: a token Supabase rejects -> 401', async () => {
  const res = await call(series, { action: 'cancel', token: 'tok-forged', body: { groupId: GID } });
  assert.equal(res.code, 401);
  assert.match(res.body.error, /sign in/i);
  assert.deepEqual(writes(), []);
});

test('(a) waitlist sweep/outbox: no token and no secret -> 401, nothing runs', async () => {
  for (const action of ['sweep', 'outbox']) {
    const res = await call(waitlist, { action });
    assert.equal(res.code, 401, action);
  }
  assert.deepEqual(writes(), []);
});

// ----- (b) a customer's valid token -> 403, and NO write -----------------------------------
test('(b) booking-series: customer token -> 403 on every action, nothing written', async () => {
  for (const a of [...SERIES_WRITES, { action: 'preview', body: {} }]) {
    const res = await call(series, { ...a, token: 'tok-customer' });
    assert.equal(res.code, 403, `${a.action}: ${res.code} ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, /staff login/i, `${a.action} says what is needed`);
  }
  const get = await call(series, { method: 'GET', action: 'get', token: 'tok-customer', query: { id: SID } });
  assert.equal(get.code, 403);
  assert.deepEqual(writes(), [], 'no write function was reached');
  assert.deepEqual(rawWrites, [], 'nothing was written to the database');
});

test('(b) waitlist sweep/outbox: customer token -> 403, nothing runs or sends', async () => {
  for (const action of ['sweep', 'outbox']) {
    const res = await call(waitlist, { action, token: 'tok-customer' });
    assert.equal(res.code, 403, `${action}: ${res.code} ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, /booking\.write/);
  }
  assert.deepEqual(writes(), []);
  assert.deepEqual(rawWrites, []);
});

test('(b) read-only staff cannot write bookings or run the sweep/outbox', async () => {
  for (const a of SERIES_WRITES) {
    const res = await call(series, { ...a, token: 'tok-readonly' });
    assert.equal(res.code, 403, `${a.action}: ${res.code} ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, /booking\.write/);
  }
  for (const action of ['sweep', 'outbox']) {
    assert.equal((await call(waitlist, { action, token: 'tok-readonly' })).code, 403, action);
  }
  assert.deepEqual(writes(), []);
});

test('(b) employee without money.write: cancel with refund -> 403 BEFORE anything is cancelled', async () => {
  const res = await call(series, { action: 'cancel', token: 'tok-employee', body: { groupId: GID, refund: true } });
  assert.equal(res.code, 403);
  assert.match(res.body.error, /money\.write/);
  assert.deepEqual(writes(), [], 'the cancellation did not happen either');
});

// ----- (c) real staff with the capability -> allowed --------------------------------------
test('(c) employee (booking.write): cancel without refund goes through', async () => {
  const res = await call(series, { action: 'cancel', token: 'tok-employee', body: { groupId: GID } });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual(writes(), ['cancelGroup']);
});

test('(c) admin: cancel with refund goes through and records the refund', async () => {
  const res = await call(series, { action: 'cancel', token: 'tok-admin', body: { groupId: GID, refund: true } });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual(writes(), ['cancelGroup', 'recordRefund']);
  assert.equal(res.body.moneyMoved, false);
});

test('(c) employee: extend by hand goes through', async () => {
  const res = await call(series, { action: 'extend', token: 'tok-employee' });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.ok(calls.includes('seriesNeedingHorizon'));
});

test('(c) read-only staff may still read: preview and get get past the gate', async () => {
  const p = await call(series, { action: 'preview', token: 'tok-readonly', body: {} });
  assert.equal(p.code, 400, 'reached validation, not refused'); // empty definition
  const g = await call(series, { method: 'GET', action: 'get', token: 'tok-readonly', query: { id: SID } });
  assert.equal(g.code, 404, 'reached the lookup, not refused');
  assert.deepEqual(writes(), []);
});

test('(c) employee: sweep and outbox run by hand', async () => {
  const s = await call(waitlist, { action: 'sweep', token: 'tok-employee' });
  assert.equal(s.code, 200, JSON.stringify(s.body));
  assert.ok(calls.includes('runWaitlistSweep'));
  const o = await call(waitlist, { action: 'outbox', token: 'tok-employee' });
  assert.equal(o.code, 200, JSON.stringify(o.body));
});

// ----- (d) the cron-secret doors still work with no token at all ---------------------------
test('(d) waitlist sweep: x-waitlist-secret, no token -> runs', async () => {
  const res = await call(waitlist, { action: 'sweep', headers: { 'x-waitlist-secret': SECRET } });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.ok(calls.includes('runWaitlistSweep'));
});

test('(d) waitlist outbox: x-outbox-secret, no token -> runs', async () => {
  const res = await call(waitlist, { action: 'outbox', headers: { 'x-outbox-secret': SECRET } });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.ok(calls.includes('dueNotifications'));
});

test('(d) wrong secret of the right length is still refused', async () => {
  const wrong = SECRET.slice(0, -1) + 'X';
  const res = await call(waitlist, { action: 'sweep', headers: { 'x-waitlist-secret': wrong } });
  assert.equal(res.code, 401);
  assert.deepEqual(writes(), []);
});

test('(d) booking-series extend: x-series-secret, no token -> runs', async () => {
  const res = await call(series, { action: 'extend', headers: { 'x-series-secret': SECRET } });
  assert.equal(res.code, 200, JSON.stringify(res.body));
});

test('(d) no secret configured: sweep/outbox/extend still refuse with 503 and say what to set', async () => {
  delete process.env.WAITLIST_SWEEP_SECRET; delete process.env.OUTBOX_SWEEP_SECRET; delete process.env.SERIES_SWEEP_SECRET;
  assert.equal((await call(waitlist, { action: 'sweep' })).code, 503);
  assert.equal((await call(waitlist, { action: 'outbox' })).code, 503);
  assert.equal((await call(series, { action: 'extend' })).code, 503);
  assert.deepEqual(writes(), []);
});
