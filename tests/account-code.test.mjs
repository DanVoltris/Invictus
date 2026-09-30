// The My Account sign-in code must actually be TEXTED when it is asked for.
//
// It used to be only queued in the notifications outbox, which is emptied by a scheduled job that
// was never set up on the live site — so every code sat there as 'queued' with 0 attempts and
// nobody could sign up. Now it is sent straight away, the way booking receipts and league invites
// already are; the outbox row is still written first so a failed send can be retried.
//
// The real api/account.js, lib/notify.js and lib/db.js run; Supabase is an in-memory fake and the
// network call to Twilio is captured instead of made.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake',
  TWILIO_ACCOUNT_SID: 'AC_test', TWILIO_AUTH_TOKEN: 'tok_test', TWILIO_FROM: '+12045550000',
});
const ROOT = new URL('../', import.meta.url).href;

const S = { db: {}, seq: 0 };
function builder(table) {
  const st = { f: [], op: 'select', payload: null };
  const match = (r) => st.f.every(([c, v]) => r[c] === v);
  const run = () => {
    const rows = S.db[table] = S.db[table] || [];
    if (st.op === 'insert') { const row = { id: `${table}-${++S.seq}`, status: 'queued', attempts: 0, ...st.payload }; rows.push(row); return { data: row, error: null }; }
    if (st.op === 'upsert') { const i = rows.findIndex((r) => r.phone === st.payload.phone); if (i >= 0) rows[i] = { ...rows[i], ...st.payload }; else rows.push({ ...st.payload }); return { data: null, error: null }; }
    if (st.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.payload)); return { data: hit, error: null }; }
    if (st.op === 'delete') { S.db[table] = rows.filter((r) => !match(r)); return { data: null, error: null }; }
    return { data: rows.filter(match), error: null };
  };
  const q = {
    select() { return q; }, eq(c, v) { st.f.push([c, v]); return q; }, is() { return q; }, not() { return q; },
    like() { return q; }, ilike(c, v) { st.f.push([c, v]); return q; }, limit() { return q; }, order() { return q; }, gte() { return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; },
    delete() { st.op = 'delete'; return q; },
    upsert(p) { st.op = 'upsert'; st.payload = p; return q; },
    maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
    single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; },
    then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
  };
  return q;
}
mock.module(ROOT + 'node_modules/@supabase/supabase-js/dist/index.mjs', { namedExports: {
  createClient: () => ({ from: (t) => builder(t), rpc: async () => ({ data: null, error: null }), auth: { admin: {
    updateUserById: async (id, o) => { S.pw = { id, ...o }; return { data: { user: { id, email: 'sam@shop.ca' } }, error: null }; },
    createUser: async (o) => (S.takenEmails || []).includes(o.email)
      ? { data: null, error: { message: 'A user with this email address has already been registered' } }
      : { data: { user: { id: 'NEWUSER', email: o.email } }, error: null },
    deleteUser: async () => ({}),
  } } }),
} });

// Twilio, captured.
const sent = [];
let twilioStatus = 201;
globalThis.fetch = async (url, init) => {
  sent.push({ url: String(url), body: new URLSearchParams(init.body) });
  return { ok: twilioStatus < 300, status: twilioStatus, json: async () => (twilioStatus < 300 ? { sid: 'SM_test' } : { message: 'nope' }) };
};

const { default: accountApi } = await import(ROOT + 'api/account.js');

function world() {
  S.seq = 0; sent.length = 0; twilioStatus = 201;
  S.db = {
    settings: [{ id: 1, venue: { name: 'Invictus Golf', address: '123 Main St, Winnipeg MB', email: 'hello@invictus.test' } }],
    phone_codes: [], notifications: [], customers: [],
  };
}
async function start(phone) { return act('start', { phone }); }
async function act(action, body) {
  let code = 200, out;
  const req = { method: 'POST', query: { action }, body, headers: {}, socket: {} };
  const res = { status(c) { code = c; return this; }, json(b) { out = b; return this; }, setHeader() {}, end() { return this; } };
  await accountApi(req, res);
  return { code, out };
}

test('asking for a sign-in code TEXTS it straight away — it does not wait in the outbox', async () => {
  world();
  const r = await start('204-990-6530');
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(sent.length, 1, 'Twilio was called once, during the request');
  assert.match(sent[0].url, /api\.twilio\.com\/2010-04-01\/Accounts\/AC_test\/Messages\.json$/);
  assert.match(sent[0].body.get('Body'), /Invictus Golf: your code is \d{6}\./);
  const row = S.db.notifications[0];
  assert.equal(row.template, 'account.code');
  assert.equal(row.status, 'sent', 'the outbox row records that it went');
});

test('a new staff member is TEXTED their invite link, and the stored copy loses the link once sent', async () => {
  world();
  const { notifyStaffInvite } = await import(ROOT + 'lib/notify.js');
  const link = 'https://x.supabase.co/auth/v1/verify?token=secret&type=invite';
  const outcome = await notifyStaffInvite({ userId: 'U1', phone: '+12045550123', link, invitedBy: 'Murad', roleLabel: 'an employee', email: 'sam@shop.ca' });
  assert.equal(outcome, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.get('To'), '+12045550123');
  const body = sent[0].body.get('Body');
  assert.match(body, /^Invictus Golf: Murad added you to the staff portal as an employee\. Set up your login \(your email \+ a password\): https:\/\/x\.supabase\.co\S+type=invite — works once, within 7 days\./);
  const row = S.db.notifications[0];
  assert.equal(row.template, 'staff.invite'); assert.equal(row.status, 'sent');
  assert.equal(row.payload.link, undefined, 'a delivered sign-in link is not kept in the database');
  assert.equal(row.payload.linkRedacted, true);
});

test('a Twilio outage never changes the answer, and the row is left to retry', async () => {
  world();
  twilioStatus = 503;
  const r = await start('204-990-6530');
  assert.equal(r.code, 200, 'same answer for every number, whether or not the text went');
  assert.deepEqual(r.out, { ok: true, sent: true, expiresInMinutes: r.out.expiresInMinutes });
  assert.equal(S.db.notifications[0].status, 'queued');
  assert.equal(S.db.notifications[0].attempts, 1, 'tried once, due again later');
});

// ----- forgotten password, by text (emails are off) --------------------------------------------
const codeFromText = () => /your code is (\d{6})/.exec(sent.at(-1).body.get('Body'))[1];

test('forgotten password: a texted code, then a new password — and the answer carries the email to sign in with', async () => {
  world();
  S.db.customers = [{ id: 'C1', name: 'Sam', phone: '(204) 990-6530', email: 'sam@shop.ca', user_id: 'U1' }];
  S.db.phone_verifications = []; S.db.phone_attempts = []; S.pw = null;
  await start('204-990-6530');
  const v = await act('verify', { phone: '204-990-6530', code: codeFromText() });
  assert.equal(v.out.hasAccount, true);
  const r = await act('reset', { token: v.out.token, password: 'a-new-password' });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(r.out.email, 'sam@shop.ca');
  assert.deepEqual(S.pw, { id: 'U1', password: 'a-new-password' }, 'only the password changes');
  const again = await act('reset', { token: v.out.token, password: 'another-one!' });
  assert.equal(again.code, 400, 'the proof works once');
});

test('forgotten password on a number with no account: told to create one, nothing changed', async () => {
  world();
  S.db.customers = []; S.db.phone_verifications = []; S.db.phone_attempts = []; S.pw = null;
  await start('204-990-6530');
  const v = await act('verify', { phone: '204-990-6530', code: codeFromText() });
  const r = await act('reset', { token: v.out.token, password: 'a-new-password' });
  assert.equal(r.code, 404); assert.match(r.out.error, /create one/);
  assert.equal(S.pw, null);
});

// The live bug: imported history has an unlinked copy of the same customer (same phone), and it
// came back first — so a real account holder was told "no account on that number".
test('forgotten password with a duplicate imported record: the one with the login wins', async () => {
  world();
  S.db.customers = [
    { id: 'OLD', name: 'Murad', phone: '204-990-6530', email: 'old@import.ca', user_id: null },
    { id: 'MINE', name: 'Murad', phone: '(204) 990-6530', email: 'murad@home.ca', user_id: 'U9' },
  ];
  S.db.phone_verifications = []; S.db.phone_attempts = []; S.pw = null;
  await start('204-990-6530');
  const v = await act('verify', { phone: '204-990-6530', code: codeFromText() });
  assert.equal(v.out.hasAccount, true, 'the linked record is found, not the imported copy');
  const r = await act('reset', { token: v.out.token, password: 'a-new-password' });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(S.pw.id, 'U9');
});

test('signing up for My Account with a staff email: told to use a personal one, text code not spent', async () => {
  world();
  S.db.customers = []; S.db.phone_verifications = []; S.db.phone_attempts = [];
  S.db.staff = [{ user_id: 'S1', email: 'coach@invictus.ca', role: 'employee' }];
  await start('204-990-6530');
  const v = await act('verify', { phone: '204-990-6530', code: codeFromText() });
  const r = await act('register', { token: v.out.token, email: 'coach@invictus.ca', password: 'longenough' });
  assert.equal(r.code, 409);
  assert.equal(r.out.code, 'staff_email');
  assert.match(r.out.error, /staff login .* personal email/);
  assert.ok(S.db.phone_verifications.every((x) => !x.used_at), 'they can retype a different email without a new code');
});

test('sign-up fills in the email on file for an unclaimed record — and never reveals a claimed one', async () => {
  world();
  S.db.phone_verifications = []; S.db.phone_attempts = [];
  S.db.customers = [{ id: 'C1', name: 'Murad', phone: '204-990-6530', email: 'murad@home.ca', user_id: null }];
  await start('204-990-6530');
  let v = await act('verify', { phone: '204-990-6530', code: codeFromText() });
  assert.equal(v.out.knownEmail, 'murad@home.ca');

  world();
  S.db.phone_verifications = []; S.db.phone_attempts = [];
  S.db.customers = [{ id: 'C1', name: 'Murad', phone: '204-990-6530', email: 'murad@home.ca', user_id: 'U1' }];
  await start('204-990-6530');
  v = await act('verify', { phone: '204-990-6530', code: codeFromText() });
  assert.equal(v.out.knownEmail, null, 'a claimed account only ever gets the masked hint');
  assert.match(v.out.emailHint, /•/);
});

test('sign-up with a different email than the one on file: the record follows the login', async () => {
  world();
  S.db.phone_verifications = []; S.db.phone_attempts = []; S.takenEmails = [];
  S.db.customers = [{ id: 'C1', name: 'Murad', phone: '204-990-6530', email: 'old@import.ca', user_id: null }];
  await start('204-990-6530');
  const v = await act('verify', { phone: '204-990-6530', code: codeFromText() });
  const r = await act('register', { token: v.out.token, email: 'murad@home.ca', password: 'longenough', name: 'Murad' });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(S.db.customers[0].user_id, 'NEWUSER');
  assert.equal(S.db.customers[0].email, 'murad@home.ca');
});

test('a reset needs the texted proof and a real password', async () => {
  world();
  assert.equal((await act('reset', { password: 'a-new-password' })).code, 400);
  assert.equal((await act('reset', { token: 'made-up', password: 'short' })).code, 400);
  assert.equal((await act('reset', { token: 'made-up', password: 'a-new-password' })).code, 400);
});
