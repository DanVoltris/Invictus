// Runs the real api/staff.js against a fake lib/db.js + fake Supabase auth that records every call.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('../', import.meta.url).href;
const S = {};   // per-test state the mocks read and write
const call = (name, ...args) => { S.calls.push([name, ...args]); };

function fakeDb() {
  return {
    auth: {
      admin: {
        inviteUserByEmail: async (email, o) => { call('invite', email, o); return S.invite; },
        generateLink: async (o) => { call('generateLink', o.type, o.email); return S.gen[o.type]; },
        deleteUser: async (id) => { call('deleteUser', id); return {}; },
        createUser: async (o) => { call('createUser', o); return S.create; },
        getUserById: async (id) => { call('getUserById', id); return S.users[id] ? { data: { user: S.users[id] } } : { error: { message: 'nf' }, data: {} }; },
      },
      resetPasswordForEmail: async (email) => { call('reset', email); return S.reset; },
    },
    // select() alone = the status list; .eq(...).eq(...).limit() = "is there an active admin?"
    from: () => ({ select: () => {
      const q = { eq: () => { q.filtered = true; return q; }, limit: () => q,
        then: (ok, bad) => Promise.resolve(q.filtered ? { data: S.admins, error: S.staffErr } : { data: S.staffRows, error: null }).then(ok, bad) };
      return q; } }),
  };
}

mock.module(ROOT + 'lib/db.js', { namedExports: {
  admin: () => fakeDb(),
  staffContext: async (auth, cap) => { call('staffContext', auth, cap); return S.ctx; },
  staffByUserId: async (id) => S.staffById[id] || null,
  upsertStaff: async (row) => { call('upsertStaff', row.userId, row.role); return S.upsert(row); },
} });
const { default: handler } = await import(ROOT + 'api/staff.js');

function reset(over = {}) {
  Object.assign(S, {
    calls: [], ctx: { user: { id: 'ADMIN', email: 'murad@voltrisai.com' }, role: 'admin', can: true, bootstrap: false },
    invite: { data: { user: { id: 'NEW' } } }, reset: {}, gen: {}, users: {}, staffById: {}, staffRows: [],
    upsert: () => ({ staff: {} }), admins: [], staffErr: null, create: { data: { user: { id: 'FIRST' } } },
  }, over);
}
async function run(action, body, { method = 'POST' } = {}) {
  let code, out;
  const res = { status(c) { code = c; return this; }, json(b) { out = b; return this; } };
  await handler({ method, query: { action }, body, headers: { authorization: 'Bearer t', host: 'localhost:4243' } }, res);
  return { code, out };
}
const LINK = (t) => ({ data: { user: { id: t === 'recovery' ? 'EXISTING' : 'NEW' }, properties: { action_link: `https://x.supabase.co/auth/v1/verify?type=${t}` } } });
const names = () => S.calls.map((c) => c[0]);

test('not signed in -> 401, no permission -> 403', async () => {
  reset({ ctx: { error: 'unauthorized' } });
  assert.equal((await run('invite', {})).code, 401);
  reset({ ctx: { error: 'forbidden', reason: 'staff.manage' } });
  assert.equal((await run('invite', {})).code, 403);
});

test('asks staffContext for the staff.manage capability', async () => {
  reset(); await run('status', {});
  assert.deepEqual(S.calls[0], ['staffContext', 'Bearer t', 'staff.manage']);
});

test('invalid email / role are refused before touching auth', async () => {
  reset();
  assert.equal((await run('invite', { email: 'nope', role: 'employee' })).code, 400);
  assert.equal((await run('invite', { email: 'a@b.co', role: 'owner' })).code, 400);
  assert.ok(!names().includes('invite'));
});

test('an employee with staff.manage cannot create an admin', async () => {
  reset({ ctx: { user: { id: 'E', email: 'e@x.co' }, role: 'employee', can: true } });
  const r = await run('invite', { email: 'a@b.co', role: 'admin' });
  assert.equal(r.code, 403); assert.ok(!names().includes('invite'));
});

test('cannot invite your own login', async () => {
  reset(); assert.equal((await run('invite', { email: 'MURAD@voltrisai.com', role: 'employee' })).code, 400);
});

test('happy path: emailed, staff row saved with the role, redirect is /admin', async () => {
  reset();
  const r = await run('invite', { email: ' Sam@Shop.ca ', name: 'Sam', role: 'employee' });
  assert.equal(r.code, 200); assert.equal(r.out.emailed, true); assert.equal(r.out.link, null);
  const inv = S.calls.find((c) => c[0] === 'invite');
  assert.equal(inv[1], 'sam@shop.ca'); assert.equal(inv[2].redirectTo, 'http://localhost:4243/admin');
  assert.deepEqual(S.calls.find((c) => c[0] === 'upsertStaff'), ['upsertStaff', 'NEW', 'employee']);
});

test('Supabase cannot send the email -> login made via generateLink, link returned', async () => {
  reset({ invite: { error: { message: 'Error sending invite email', status: 500 } }, gen: { invite: LINK('invite') } });
  const r = await run('invite', { email: 'sam@shop.ca', role: 'readonly' });
  assert.equal(r.code, 200); assert.equal(r.out.emailed, false);
  assert.match(r.out.link, /type=invite/);
  assert.deepEqual(S.calls.find((c) => c[0] === 'upsertStaff'), ['upsertStaff', 'NEW', 'readonly']);
});

test('email already has a login, not staff yet -> role attached, recovery link, login NOT deleted', async () => {
  reset({ invite: { error: { code: 'email_exists', message: 'A user with this email address has already been registered' } }, gen: { recovery: LINK('recovery') } });
  const r = await run('invite', { email: 'cust@x.co', role: 'employee' });
  assert.equal(r.code, 200); assert.equal(r.out.existing, true); assert.match(r.out.link, /type=recovery/);
  assert.deepEqual(S.calls.find((c) => c[0] === 'upsertStaff'), ['upsertStaff', 'EXISTING', 'employee']);
});

test('email already on the staff list -> 409, nothing saved', async () => {
  reset({ invite: { error: { message: 'already been registered' } }, gen: { recovery: LINK('recovery') }, staffById: { EXISTING: { role: 'employee' } } });
  const r = await run('invite', { email: 'sam@shop.ca', role: 'employee' });
  assert.equal(r.code, 409); assert.ok(!names().includes('upsertStaff'));
});

test('staff row fails after creating a NEW login -> that login is deleted', async () => {
  reset({ upsert: () => ({ error: 'boom' }) });
  const r = await run('invite', { email: 'sam@shop.ca', role: 'employee' });
  assert.equal(r.code, 500); assert.deepEqual(S.calls.find((c) => c[0] === 'deleteUser'), ['deleteUser', 'NEW']);
});

test('staff row fails for a PRE-EXISTING login -> it is kept', async () => {
  reset({ invite: { error: { code: 'email_exists', message: 'x' } }, gen: { recovery: LINK('recovery') }, upsert: () => ({ error: 'boom' }) });
  const r = await run('invite', { email: 'cust@x.co', role: 'employee' });
  assert.equal(r.code, 500); assert.ok(!names().includes('deleteUser'));
});

test('bootstrap caller is recorded as admin BEFORE the employee is created', async () => {
  reset({ ctx: { user: { id: 'FIRST', email: 'murad@voltrisai.com' }, role: 'admin', can: true, bootstrap: true } });
  await run('invite', { email: 'sam@shop.ca', role: 'employee' });
  const ups = S.calls.filter((c) => c[0] === 'upsertStaff');
  assert.deepEqual(ups[0], ['upsertStaff', 'FIRST', 'admin']);
  assert.ok(names().indexOf('upsertStaff') < names().indexOf('invite'));
});

test('resend: invite not accepted -> invite again; accepted + mail fails -> recovery link', async () => {
  reset({ staffById: { U1: { role: 'employee' } }, users: { U1: { email: 'sam@shop.ca', email_confirmed_at: null } } });
  let r = await run('resend', { userId: 'U1' });
  assert.equal(r.out.kind, 'invite'); assert.equal(r.out.emailed, true); assert.ok(names().includes('invite'));

  reset({ staffById: { U1: { role: 'employee' } }, users: { U1: { email: 'sam@shop.ca', email_confirmed_at: '2026-09-01' } },
          reset: { error: { message: 'smtp' } }, gen: { recovery: LINK('recovery') } });
  r = await run('resend', { userId: 'U1' });
  assert.equal(r.out.kind, 'reset'); assert.equal(r.out.emailed, false); assert.match(r.out.link, /type=recovery/);
});

test('resend for someone not on the staff list -> 404', async () => {
  reset(); assert.equal((await run('resend', { userId: 'ghost' })).code, 404);
});

test('status: pending / signed-in / deleted login', async () => {
  reset({ staffRows: [{ user_id: 'A' }, { user_id: 'B' }, { user_id: 'C' }],
          users: { A: { email_confirmed_at: null }, B: { email_confirmed_at: 'x', last_sign_in_at: '2026-09-11T10:00:00Z' } } });
  const r = await run('status', {});
  assert.deepEqual(r.out.staff, { A: { pending: true, lastSignIn: null }, B: { pending: false, lastSignIn: '2026-09-11T10:00:00Z' }, C: { missing: true } });
});

// ---- first run (no login) ----
test('needs-setup: true with no admin, false with one, false when staff table missing; never asks for a login', async () => {
  reset({ admins: [] });                       assert.equal((await run('needs-setup', {})).out.setup, true);
  reset({ admins: [{ user_id: 'boss' }] });    assert.equal((await run('needs-setup', {})).out.setup, false);
  reset({ staffErr: { message: 'relation "staff" does not exist' } }); assert.equal((await run('needs-setup', {})).out.setup, false);
  assert.ok(!names().includes('staffContext'));
});

test('setup: creates a confirmed login and makes it admin, without a login of its own', async () => {
  reset({ ctx: { error: 'unauthorized' } });   // proves no auth is needed
  const r = await run('setup', { name: 'Murad', email: ' Murad@VoltrisAI.com ', password: 'longenough' });
  assert.equal(r.code, 200);
  const c = S.calls.find((x) => x[0] === 'createUser')[1];
  assert.equal(c.email, 'murad@voltrisai.com'); assert.equal(c.email_confirm, true); assert.equal(c.user_metadata.source, 'staff_setup');
  assert.deepEqual(S.calls.find((x) => x[0] === 'upsertStaff'), ['upsertStaff', 'FIRST', 'admin']);
});

test('setup: REFUSED once an admin exists, and no login is created', async () => {
  reset({ admins: [{ user_id: 'boss' }] });
  const r = await run('setup', { email: 'attacker@evil.co', password: 'longenough' });
  assert.equal(r.code, 403); assert.ok(!names().includes('createUser')); assert.ok(!names().includes('upsertStaff'));
});

test('setup: short password / bad email rejected before anything is created', async () => {
  reset();
  assert.equal((await run('setup', { email: 'a@b.co', password: 'short' })).code, 400);
  assert.equal((await run('setup', { email: 'nope', password: 'longenough' })).code, 400);
  assert.ok(!names().includes('createUser'));
});

test('setup: email already has a login -> 409; staff row fails -> login deleted', async () => {
  reset({ create: { error: { code: 'email_exists', message: 'already registered' } } });
  assert.equal((await run('setup', { email: 'a@b.co', password: 'longenough' })).code, 409);
  reset({ upsert: () => ({ error: 'boom' }) });
  assert.equal((await run('setup', { email: 'a@b.co', password: 'longenough' })).code, 500);
  assert.deepEqual(S.calls.find((x) => x[0] === 'deleteUser'), ['deleteUser', 'FIRST']);
});
