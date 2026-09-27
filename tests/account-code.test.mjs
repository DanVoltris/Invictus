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
    return { data: rows.filter(match), error: null };
  };
  const q = {
    select() { return q; }, eq(c, v) { st.f.push([c, v]); return q; }, is() { return q; }, not() { return q; },
    like() { return q; }, ilike(c, v) { st.f.push([c, v]); return q; }, limit() { return q; }, order() { return q; }, gte() { return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; },
    upsert(p) { st.op = 'upsert'; st.payload = p; return q; },
    maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
    single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; },
    then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
  };
  return q;
}
mock.module(ROOT + 'node_modules/@supabase/supabase-js/dist/index.mjs', { namedExports: {
  createClient: () => ({ from: (t) => builder(t), rpc: async () => ({ data: null, error: null }), auth: {} }),
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
async function start(phone) {
  let code = 200, out;
  const req = { method: 'POST', query: { action: 'start' }, body: { phone }, headers: {}, socket: {} };
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

test('a Twilio outage never changes the answer, and the row is left to retry', async () => {
  world();
  twilioStatus = 503;
  const r = await start('204-990-6530');
  assert.equal(r.code, 200, 'same answer for every number, whether or not the text went');
  assert.deepEqual(r.out, { ok: true, sent: true, expiresInMinutes: r.out.expiresInMinutes });
  assert.equal(S.db.notifications[0].status, 'queued');
  assert.equal(S.db.notifications[0].attempts, 1, 'tried once, due again later');
});
