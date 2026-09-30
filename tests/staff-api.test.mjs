// Runs the real api/staff.js against a fake lib/db.js + fake Supabase auth that records every call.
//
// Staff are invited by NAME and MOBILE — no email (texts only, for now). The login is made under a
// placeholder address, and the TEXTED link opens the portal's own "set up your login" screen
// (?action=claim), where the person types their email and a password. These tests pin that flow.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('../', import.meta.url).href;
const S = {};   // per-test state the mocks read and write
const call = (name, ...args) => { S.calls.push([name, ...args]); };

function fakeDb() {
  return {
    auth: {
      admin: {
        inviteUserByEmail: async (email, o) => { call('invite', email, o); return { error: { message: 'must not be called' } }; },
        generateLink: async (o) => { call('generateLink', o.type, o.email); return { error: { message: 'must not be called' } }; },
        deleteUser: async (id) => { call('deleteUser', id); delete S.users[id]; return {}; },
        createUser: async (o) => {
          call('createUser', o);
          if (S.create.error) return S.create;
          const id = S.create.data.user.id;
          S.users[id] = { id, email: o.email, user_metadata: o.user_metadata || {}, email_confirmed_at: '2026-09-28T10:00:00Z' };
          return { data: { user: S.users[id] } };
        },
        getUserById: async (id) => { call('getUserById', id); return S.users[id] ? { data: { user: S.users[id] } } : { error: { message: 'nf' }, data: {} }; },
        updateUserById: async (id, o) => {
          call('updateUserById', id, o);
          if (S.updErr) return { error: S.updErr };
          const u = S.users[id]; if (!u) return { error: { message: 'nf' } };
          if (o.user_metadata) u.user_metadata = o.user_metadata;
          if (o.email) u.email = o.email;
          if (o.password) u.password = o.password;
          return { data: { user: u } };
        },
      },
      resetPasswordForEmail: async (email) => { call('reset', email); return {}; },
    },
    // select() alone = the status list; .eq(...).eq(...).limit() = "is there an active admin?"
    // customers + ilike/not = "is this email somebody's My Account login?" (claim's 409 wording)
    from: (table) => ({ select: () => {
      const q = { eq: () => { q.filtered = true; return q; }, ilike: () => q, not: () => q, limit: () => q,
        then: (ok, bad) => Promise.resolve(table === 'customers' ? { data: S.customerLogins || [], error: null }
          : q.filtered ? { data: S.admins, error: S.staffErr } : { data: S.staffRows, error: null }).then(ok, bad) };
      return q; } }),
  };
}

mock.module(ROOT + 'lib/db.js', { namedExports: {
  admin: () => fakeDb(),
  staffContext: async (auth, cap) => { call('staffContext', auth, cap); return S.ctx; },
  staffByUserId: async (id) => S.staffById[id] || null,
  upsertStaff: async (row) => { call('upsertStaff', row.userId, row.role, row.email); return S.upsert(row); },
} });
// Texts are captured, not sent. S.textOutcome is what lib/notify.js would report ('sent' | 'skipped' | 'failed').
mock.module(ROOT + 'lib/notify.js', { namedExports: {
  notifyStaffInvite: async (o) => { call('text', o); return S.textOutcome; },
} });
const { default: handler, mobileE164, PENDING_DOMAIN } = await import(ROOT + 'api/staff.js');

function reset(over = {}) {
  Object.assign(S, {
    calls: [], ctx: { user: { id: 'ADMIN', email: 'murad@voltrisai.com', user_metadata: { name: 'Murad' } }, role: 'admin', can: true, bootstrap: false },
    users: {}, staffById: {}, staffRows: [], updErr: null,
    upsert: () => ({ staff: {} }), admins: [], staffErr: null, create: { data: { user: { id: 'NEW' } } },
    textOutcome: 'sent',
  }, over);
}
async function run(action, body, { method = 'POST' } = {}) {
  let code, out;
  const res = { status(c) { code = c; return this; }, json(b) { out = b; return this; } };
  await handler({ method, query: { action }, body, headers: { authorization: 'Bearer t', host: 'localhost:4243' } }, res);
  return { code, out };
}
const names = () => S.calls.map((c) => c[0]);
const lastText = () => S.calls.filter((c) => c[0] === 'text').at(-1)[1];
const tokenFrom = (link) => decodeURIComponent(/staff-(?:invite|reset)=([^&]+)/.exec(link)[1]);
const neverEmailed = () => assert.ok(!names().some((n) => ['invite', 'generateLink', 'reset'].includes(n)), 'Supabase must never be asked to email');

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

test('mobile numbers are read the way people type them', () => {
  assert.equal(mobileE164('204-555-0123'), '+12045550123');
  assert.equal(mobileE164('(204) 555 0123'), '+12045550123');
  assert.equal(mobileE164('1 204 555 0123'), '+12045550123');
  assert.equal(mobileE164('+44 7700 900123'), '+447700900123');
  assert.equal(mobileE164(''), null);
  assert.equal(mobileE164('555-0123'), null);
});

test('no name, no usable mobile, or an unknown role: refused before any login is made', async () => {
  reset();
  assert.equal((await run('invite', { phone: '204-555-0123', role: 'employee' })).code, 400);
  const r = await run('invite', { name: 'Justin', phone: '555', role: 'employee' });
  assert.equal(r.code, 400); assert.match(r.out.error, /mobile number/);
  assert.equal((await run('invite', { name: 'Justin', phone: '204-555-0123', role: 'owner' })).code, 400);
  assert.ok(!names().includes('createUser'));
});

test('an employee with staff.manage cannot create an admin', async () => {
  reset({ ctx: { user: { id: 'E', email: 'e@x.co' }, role: 'employee', can: true } });
  const r = await run('invite', { name: 'Justin', phone: '204-555-0123', role: 'admin' });
  assert.equal(r.code, 403); assert.ok(!names().includes('createUser'));
});

test('invite: no email asked for — a placeholder login, the staff row, and a TEXTED set-up link', async () => {
  reset();
  const r = await run('invite', { name: 'Justin', phone: '(204) 555-0123', role: 'employee' });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(r.out.texted, true); assert.equal(r.out.link, undefined, 'the link went to their phone — the admin never needs to see it');
  const made = S.calls.find((c) => c[0] === 'createUser')[1];
  assert.match(made.email, new RegExp(`^invite-[0-9a-f]{16}@${PENDING_DOMAIN.replace('.', '\\.')}$`));
  assert.deepEqual([made.user_metadata.name, made.user_metadata.phone], ['Justin', '+12045550123']);
  assert.deepEqual(S.calls.find((c) => c[0] === 'upsertStaff'), ['upsertStaff', 'NEW', 'employee', null]);
  const t = lastText();
  assert.equal(t.kind, 'invite'); assert.equal(t.roleLabel, 'an employee'); assert.equal(t.invitedBy, 'Murad');
  assert.match(t.link, /^http:\/\/localhost:4243\/admin\?staff-invite=NEW\./);
  // Only a hash of the secret is kept, with an expiry about a week out.
  const inv = S.users.NEW.user_metadata.staff_invite;
  assert.match(inv.hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(inv).includes(tokenFrom(t.link).split('.')[1]), 'the secret itself is not stored');
  const days = (Date.parse(inv.expires) - Date.now()) / 864e5;
  assert.ok(days > 6.9 && days < 7.1);
  neverEmailed();
});

test('the text does not go out -> the admin gets the link on screen, and why', async () => {
  reset({ textOutcome: 'skipped' });
  const r = await run('invite', { name: 'Justin', phone: '2045550123', role: 'employee' });
  assert.equal(r.code, 200); assert.equal(r.out.texted, false);
  assert.match(r.out.link, /staff-invite=NEW\./); assert.match(r.out.textError, /not set up/);
});

test('staff row fails after creating the login -> that login is deleted', async () => {
  reset({ upsert: () => ({ error: 'boom' }) });
  const r = await run('invite', { name: 'Justin', phone: '204-555-0123', role: 'employee' });
  assert.equal(r.code, 500); assert.deepEqual(S.calls.find((c) => c[0] === 'deleteUser'), ['deleteUser', 'NEW']);
});

test('bootstrap caller is recorded as admin BEFORE the employee is created', async () => {
  reset({ ctx: { user: { id: 'FIRST', email: 'murad@voltrisai.com' }, role: 'admin', can: true, bootstrap: true } });
  await run('invite', { name: 'Justin', phone: '204-555-0123', role: 'employee' });
  const ups = S.calls.filter((c) => c[0] === 'upsertStaff');
  assert.deepEqual(ups[0].slice(0, 3), ['upsertStaff', 'FIRST', 'admin']);
  assert.ok(names().indexOf('upsertStaff') < names().indexOf('createUser'));
});

// ---- the texted link's own screen ----
async function invited() {
  reset({ staffById: { NEW: { role: 'employee', name: 'Justin', is_active: true } } });
  await run('invite', { name: 'Justin', phone: '204-555-0123', role: 'employee' });
  return tokenFrom(lastText().link);
}

test('claim: they type their own email and a password; the link then stops working', async () => {
  const token = await invited();
  let r = await run('claim', { token, email: ' Justin@Shop.CA ', password: 'longenough' });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.deepEqual([r.out.email, r.out.first], ['justin@shop.ca', true]);
  assert.equal(S.users.NEW.email, 'justin@shop.ca'); assert.equal(S.users.NEW.password, 'longenough');
  assert.equal(S.users.NEW.user_metadata.staff_invite, undefined, 'used up');
  assert.equal(S.users.NEW.user_metadata.phone, '+12045550123', 'the number stays, for the next reset text');
  assert.deepEqual(S.calls.filter((c) => c[0] === 'upsertStaff').at(-1), ['upsertStaff', 'NEW', 'employee', 'justin@shop.ca']);
  r = await run('claim', { token, email: 'someone@else.co', password: 'longenough' });
  assert.equal(r.code, 400); assert.match(r.out.error, /expired or has already been used/);
  neverEmailed();
});

test('claim: a wrong secret, an expired link, or a bad email are all refused', async () => {
  const token = await invited();
  const [id] = token.split('.');
  assert.equal((await run('claim', { token: `${id}.not-the-secret`, email: 'j@shop.ca', password: 'longenough' })).code, 400);
  assert.equal((await run('claim', { token, email: 'not-an-email', password: 'longenough' })).code, 400);
  assert.equal((await run('claim', { token, email: `x@${PENDING_DOMAIN}`, password: 'longenough' })).code, 400);
  assert.equal((await run('claim', { token, email: 'j@shop.ca', password: 'short' })).code, 400);
  S.users.NEW.user_metadata.staff_invite.expires = new Date(Date.now() - 1000).toISOString();
  const r = await run('claim', { token, email: 'j@shop.ca', password: 'longenough' });
  assert.equal(r.code, 400); assert.match(r.out.error, /expired/);
});

test('claim: an email somebody else already signs in with -> 409, and the link still works after', async () => {
  const token = await invited();
  S.updErr = { code: 'email_exists', message: 'A user with this email address has already been registered' };
  assert.equal((await run('claim', { token, email: 'taken@shop.ca', password: 'longenough' })).code, 409);
  S.updErr = null;
  assert.equal((await run('claim', { token, email: 'justin@shop.ca', password: 'longenough' })).code, 200);
});

test('claim: a customer\'s own My Account email is refused with the reason, not a vague "taken"', async () => {
  const token = await invited();
  S.updErr = { code: 'email_exists', message: 'A user with this email address has already been registered' };
  S.customerLogins = [{ id: 'c-1' }];
  try {
    const r = await run('claim', { token, email: 'golfer@home.ca', password: 'longenough' });
    assert.equal(r.code, 409);
    assert.match(r.out.error, /already your My Account login/);
  } finally { S.updErr = null; S.customerLogins = null; }
});

test('claim: a suspended staff member cannot use an old link', async () => {
  const token = await invited();
  S.staffById.NEW.is_active = false;
  assert.equal((await run('claim', { token, email: 'j@shop.ca', password: 'longenough' })).code, 403);
});

test('"Send reset link": unfinished set-up texts a new set-up link; finished texts a password-only link', async () => {
  const token = await invited();
  let r = await run('resend', { userId: 'NEW' });
  assert.deepEqual([r.out.kind, r.out.texted], ['invite', true]);
  const second = tokenFrom(lastText().link);
  assert.equal((await run('claim', { token, email: 'j@shop.ca', password: 'longenough' })).code, 400, 'the older link died when a new one was made');
  assert.equal((await run('claim', { token: second, email: 'j@shop.ca', password: 'longenough' })).code, 200);

  r = await run('resend', { userId: 'NEW' });
  assert.deepEqual([r.out.kind, r.out.texted], ['reset', true]);
  assert.match(lastText().link, /\?staff-reset=NEW\./);
  const again = await run('claim', { token: tokenFrom(lastText().link), password: 'brandnewpw' });
  assert.deepEqual([again.code, again.out.email, again.out.first], [200, 'j@shop.ca', false]);
  assert.equal(S.users.NEW.password, 'brandnewpw'); assert.equal(S.users.NEW.email, 'j@shop.ca', 'a reset never changes the email');
  neverEmailed();
});

test('"Send reset link" for someone with no mobile on file: the link comes back for the admin to pass on', async () => {
  reset({ staffById: { OLD: { role: 'admin' } }, users: { OLD: { id: 'OLD', email: 'boss@shop.ca', user_metadata: {}, email_confirmed_at: 'x' } } });
  const r = await run('resend', { userId: 'OLD' });
  assert.equal(r.code, 200); assert.equal(r.out.texted, false); assert.match(r.out.link, /staff-reset=OLD\./);
  assert.match(r.out.textError, /no mobile number/);
  neverEmailed();
});

test('resend for someone not on the staff list -> 404', async () => {
  reset(); assert.equal((await run('resend', { userId: 'ghost' })).code, 404);
});

test('status: waiting for set-up (with the number it was texted to) / signed-in / deleted login', async () => {
  reset({ staffRows: [{ user_id: 'A' }, { user_id: 'B' }, { user_id: 'C' }],
          users: { A: { email: `invite-1@${PENDING_DOMAIN}`, email_confirmed_at: 'x', user_metadata: { phone: '+12045550123' } },
                   B: { email: 'b@shop.ca', email_confirmed_at: 'x', last_sign_in_at: '2026-09-11T10:00:00Z', user_metadata: {} } } });
  const r = await run('status', {});
  assert.deepEqual(r.out.staff, {
    A: { pending: true, lastSignIn: null, phone: '+12045550123' },
    B: { pending: false, lastSignIn: '2026-09-11T10:00:00Z', phone: null },
    C: { missing: true } });
});

// ---- first run (no login) ----
test('needs-setup: true with no admin, false with one, false when staff table missing; never asks for a login', async () => {
  reset({ admins: [] });                       assert.equal((await run('needs-setup', {})).out.setup, true);
  reset({ admins: [{ user_id: 'boss' }] });    assert.equal((await run('needs-setup', {})).out.setup, false);
  reset({ staffErr: { message: 'relation "staff" does not exist' } }); assert.equal((await run('needs-setup', {})).out.setup, false);
  assert.ok(!names().includes('staffContext'));
});

test('setup: creates a confirmed login and makes it admin, without a login of its own', async () => {
  reset({ ctx: { error: 'unauthorized' }, create: { data: { user: { id: 'FIRST' } } } });   // proves no auth is needed
  const r = await run('setup', { name: 'Murad', email: ' Murad@VoltrisAI.com ', password: 'longenough' });
  assert.equal(r.code, 200);
  const c = S.calls.find((x) => x[0] === 'createUser')[1];
  assert.equal(c.email, 'murad@voltrisai.com'); assert.equal(c.email_confirm, true); assert.equal(c.user_metadata.source, 'staff_setup');
  assert.deepEqual(S.calls.find((x) => x[0] === 'upsertStaff').slice(0, 3), ['upsertStaff', 'FIRST', 'admin']);
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
  reset({ upsert: () => ({ error: 'boom' }), create: { data: { user: { id: 'FIRST' } } } });
  assert.equal((await run('setup', { email: 'a@b.co', password: 'longenough' })).code, 500);
  assert.deepEqual(S.calls.find((x) => x[0] === 'deleteUser'), ['deleteUser', 'FIRST']);
});

// ---- "Forgot password?" on the staff login: no login needed, texted, never tells who is staff ----
function staffWithPhone(id, phone, over = {}) {
  S.users[id] = { id, email: `${id.toLowerCase()}@shop.ca`, user_metadata: { name: id, phone } };
  const row = { user_id: id, name: id, role: 'employee', is_active: true, ...over };
  S.staffRows.push(row);
  S.staffById[id] = row;
}

test('forgot: a staff mobile gets a texted reset link that then works, with no login', async () => {
  reset();
  staffWithPhone('ANA', '+12045550111');
  const r = await run('forgot', { phone: '(204) 555-0111' });
  assert.equal(r.code, 200);
  assert.match(r.out.message, /If that number belongs to a staff login/);
  const link = lastText().link;
  assert.match(link, /staff-reset=/, 'a finished login gets a password-only link');
  const claimed = await run('claim', { token: tokenFrom(link), password: 'a-new-password' });
  assert.equal(claimed.code, 200, JSON.stringify(claimed.out));
  assert.equal(S.users.ANA.password, 'a-new-password');
  neverEmailed();
});

test('forgot: an unknown or suspended number gets the SAME answer and no text', async () => {
  reset();
  staffWithPhone('ANA', '+12045550111');
  staffWithPhone('GONE', '+12045550222', { is_active: false });
  const known = await run('forgot', { phone: '204-555-0111' });
  S.calls = [];
  const stranger = await run('forgot', { phone: '204-555-0999' });
  const suspended = await run('forgot', { phone: '204-555-0222' });
  assert.deepEqual(stranger.out, known.out, 'nobody can use the page to find out who works here');
  assert.deepEqual(suspended.out, known.out);
  assert.ok(!names().includes('text'), 'no text to a stranger or a suspended login');
});

test('forgot: at most one text a minute per login, and a bad number is asked for again', async () => {
  reset();
  staffWithPhone('ANA', '+12045550111');
  await run('forgot', { phone: '204-555-0111' });
  await run('forgot', { phone: '204-555-0111' });
  assert.equal(S.calls.filter((c) => c[0] === 'text').length, 1);
  const bad = await run('forgot', { phone: '555' });
  assert.equal(bad.code, 400);
});
