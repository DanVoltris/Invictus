// The security fix in lib/db.js staffContext(): who counts as "admin because nobody is admin yet".
// The real function runs; only the Supabase client underneath it is fake.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake';

const ROOT = new URL('../', import.meta.url).href;
const S = {};
// A tiny query builder: records filters, resolves to rows from S.tables[table] that match them.
function builder(table) {
  const f = [];
  const q = {
    select() { return q; }, order() { return q; }, limit() { return q; },
    eq(col, val) { f.push([col, val]); return q; },
    maybeSingle: async () => { const r = rows(); return { data: r[0] || null, error: null }; },
    then(res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej); },
  };
  const rows = () => (S.tables[table] || []).filter((r) => f.every(([c, v]) => r[c] === v));
  return q;
}
mock.module(ROOT + 'node_modules/@supabase/supabase-js/dist/index.mjs', { namedExports: {
  createClient: () => ({
    auth: { getUser: async () => (S.user ? { data: { user: S.user } } : { error: { message: 'bad jwt' }, data: {} }) },
    from: (t) => builder(t),
  }),
} });
const { staffContext } = await import(process.env.DB_URL || ROOT + 'lib/db.js');

const CAPS = [{ key: 'booking.write' }, { key: 'staff.manage' }];
function world({ user, staff = [], customers = [] }) {
  Object.assign(S, { user, tables: { staff, customers, capabilities: CAPS, role_permissions: [] } });
}
const U = (id, meta = {}) => ({ id, email: `${id}@x.co`, user_metadata: meta });

test('fresh database, brand-new login -> bootstrap admin', async () => {
  world({ user: U('owner') });
  const r = await staffContext('Bearer t', 'staff.manage');
  assert.equal(r.role, 'admin'); assert.equal(r.bootstrap, true);
});

test('fresh database, CUSTOMER sign-up (metadata) -> forbidden', async () => {
  world({ user: U('cust', { source: 'customer_signup' }) });
  const r = await staffContext('Bearer t', 'staff.manage');
  assert.equal(r.error, 'forbidden');
});

test('fresh database, login linked to a customer row -> forbidden', async () => {
  world({ user: U('cust2'), customers: [{ id: 'c1', user_id: 'cust2' }] });
  assert.equal((await staffContext('Bearer t', 'staff.manage')).error, 'forbidden');
});

test('fresh database, SUSPENDED staff row -> forbidden (stays suspended)', async () => {
  world({ user: U('sus'), staff: [{ user_id: 'sus', role: 'employee', is_active: false }] });
  assert.equal((await staffContext('Bearer t', 'staff.manage')).error, 'forbidden');
});

test('an admin exists, unknown login -> forbidden', async () => {
  world({ user: U('rando'), staff: [{ user_id: 'boss', role: 'admin', is_active: true }] });
  assert.equal((await staffContext('Bearer t', 'staff.manage')).error, 'forbidden');
});

test('real admin row -> admin, not bootstrap', async () => {
  world({ user: U('boss'), staff: [{ user_id: 'boss', role: 'admin', is_active: true }] });
  const r = await staffContext('Bearer t', 'staff.manage');
  assert.equal(r.role, 'admin'); assert.equal(r.bootstrap, false);
});

test('employee without staff.manage -> forbidden', async () => {
  world({ user: U('emp'), staff: [{ user_id: 'boss', role: 'admin', is_active: true }, { user_id: 'emp', role: 'employee', is_active: true }] });
  assert.equal((await staffContext('Bearer t', 'staff.manage')).error, 'forbidden');
});

test('invalid token -> unauthorized', async () => {
  world({ user: null });
  assert.equal((await staffContext('Bearer t', 'staff.manage')).error, 'unauthorized');
});
