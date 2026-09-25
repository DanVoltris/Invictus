// Lawful texting, both halves of it.
//
//   1. THE TICK BOX AT CHECKOUT is what makes a text legal to send, so it has to reach
//      customers.sms_consent — with the time, the IP and the source CASL wants (migration 0019).
//      An unticked box is a recorded NO, and a request that never mentions consent must leave
//      whatever is on file completely alone.
//   2. THE REPLY "STOP" is what makes it illegal again. Twilio stops the message at the carrier;
//      this proves our own record stops with it, and that a stranger who can reach the public
//      webhook URL cannot unsubscribe — or re-subscribe — anybody.
//
// The real api/confirm-booking.js, api/hour-cards.js, api/waitlist.js and lib/db.js all run.
// Only Supabase and the Stripe SDK are fake.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

Object.assign(process.env, { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake',
  STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_PUBLISHABLE_KEY: 'pk_test_fake' });
const ROOT = new URL('../', import.meta.url).href;

// ----- the fake database (same shape as tests/security-balances.test.mjs) --------------------
const S = {};
let seq = 0;
function builder(table) {
  const st = { f: [], op: 'select', payload: null };
  const match = (r) => st.f.every(([k, c, v]) => k === 'eq' ? r[c] === v : k === 'in' ? v.includes(r[c]) : k === 'is' ? (r[c] ?? null) === v
    : k === 'like' ? String(r[c] || '').includes(String(v).replace(/%/g, '')) : k === 'not' ? r[c] != null : k === 'gte' ? r[c] >= v : k === 'lte' ? r[c] <= v : k === 'lt' ? r[c] < v : k === 'neq' ? r[c] !== v : true);
  const run = () => {
    const rows = S.db[table] = S.db[table] || [];
    if (st.op === 'insert') { const row = { id: `${table}-${++seq}`, ...st.payload }; rows.push(row); S.writes.push([table, 'insert', st.payload]); return { data: row, error: null }; }
    if (st.op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, st.payload)); S.writes.push([table, 'update', st.payload]); return { data: hit, error: null }; }
    if (st.op === 'delete') { S.db[table] = rows.filter((r) => !match(r)); return { data: null, error: null }; }
    return { data: rows.filter(match), error: null };
  };
  const q = {};
  for (const k of ['eq', 'in', 'is', 'like', 'gte', 'lte', 'lt', 'neq']) q[k] = (c, v) => { st.f.push([k, c, v]); return q; };
  Object.assign(q, {
    select() { return q; }, order() { return q; }, limit() { return q; }, not(c) { st.f.push(['not', c]); return q; }, ilike(c, v) { st.f.push(['eq', c, v]); return q; },
    insert(p) { st.op = 'insert'; st.payload = p; return q; }, update(p) { st.op = 'update'; st.payload = p; return q; }, delete() { st.op = 'delete'; return q; },
    maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
    single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; },
    then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
  });
  return q;
}
mock.module(ROOT + 'node_modules/@supabase/supabase-js/dist/index.mjs', { namedExports: {
  createClient: () => ({ from: (t) => builder(t),
    rpc: async (fn, args) => { S.writes.push(['rpc', fn]);
      if (fn === 'adjust_hours') { const c = S.db.customers.find((x) => x.id === args.p_customer); c.hours_balance_min += args.p_delta_min; return { data: c.hours_balance_min, error: null }; }
      return { data: null, error: null }; },
    auth: { getUser: async (tok) => (S.tokens[tok] ? { data: { user: { id: S.tokens[tok] } } } : { error: { message: 'bad jwt' }, data: {} }) } }),
} });

// Fake Stripe: one succeeded PaymentIntent carrying the booking in its metadata.
class FakeStripe {
  constructor() {
    this.paymentIntents = { retrieve: async (id) => (S.pi && S.pi.id === id ? S.pi : (() => { throw new Error('No such payment_intent'); })()) };
    this.charges = { retrieve: async () => ({ billing_details: {} }) };
  }
}
mock.module(ROOT + 'node_modules/stripe/esm/stripe.esm.node.js', { defaultExport: FakeStripe });

const { default: confirmBooking } = await import(ROOT + 'api/confirm-booking.js');
const { default: hourCards } = await import(ROOT + 'api/hour-cards.js');
const { default: waitlist } = await import(ROOT + 'api/waitlist.js');

// ----- world ---------------------------------------------------------------------------------
const soon = (() => { const d = new Date(); d.setDate(d.getDate() + 2); return d.toISOString().slice(0, 10); })();
const SLOT = { dateISO: soon, bayId: 'B1', startMin: 600, endMin: 660 };

function world(customerPatch = {}) {
  seq = 0;
  Object.assign(S, {
    writes: [], tokens: { 'tok-murad': 'user-murad' },
    pi: { id: 'pi_1', status: 'succeeded', amount: 5000, latest_charge: null,
      metadata: { dateISO: SLOT.dateISO, bayId: SLOT.bayId, startMin: String(SLOT.startMin), endMin: String(SLOT.endMin) } },
    db: {
      customers: [{
        id: 'c-murad', name: 'Murad', phone: '+12045550111', email: 'murad@example.com',
        user_id: 'user-murad', hours_balance_min: 600,
        sms_opt_in: true, sms_consent: false, sms_consent_at: null, sms_consent_ip: null,
        sms_consent_source: null, sms_unsub_at: null, ...customerPatch,
      }],
      settings: [{ id: 1, bays: [{ id: 'B1', name: 'Bay 1' }],
        hours: { 0: [0, 24], 1: [0, 24], 2: [0, 24], 3: [0, 24], 4: [0, 24], 5: [0, 24], 6: [0, 24] },
        rates: { weekdayOffPeak: 20, weekdayPeak: 25, weekendOffPeak: 25, weekendPeak: 25, peakStartHour: 17 },
        min_mins: 60, max_party: 4, slot_step: 30, booking_window: { regularDays: 10, leagueDays: 60 },
        venue: { name: 'Invictus Golf', address: '1 Test Rd, Winnipeg MB', phone: '(204) 488-6177', email: 'hello@invictus.test' } }],
      bookings: [], schedule_overrides: [], league_members: [], leagues: [], hour_transactions: [],
    },
  });
}
const me = () => S.db.customers.find((c) => c.id === 'c-murad');

// A handler call. Returns the status code plus whatever the handler answered with.
async function call(handler, { method = 'POST', action, body = {}, headers = {}, url } = {}) {
  let code = 200, out, text = null;
  const req = { method, query: action ? { action } : {}, body, url,
    headers: { host: 'invictus.test', ...headers }, socket: { remoteAddress: '127.0.0.1' } };
  const res = {
    setHeader() { return this; }, status(c) { code = c; return this; },
    json(b) { out = b; return this; }, send(b) { text = b; return this; }, end(b) { if (b) text = b; return this; },
  };
  await handler(req, res);
  return { code, out, text };
}

// ========== 1. consent at checkout ============================================================

test('checkout: ticking the box records express consent — with the time, the IP and source "checkout"', async () => {
  world();
  const r = await call(confirmBooking, { body: {
    paymentIntentId: 'pi_1', name: 'Murad', email: 'murad@example.com', phone: '+12045550111',
    sms: true, smsConsent: true,
  }, headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });

  assert.equal(r.code, 200);
  assert.equal(r.out.ok, true);
  const c = me();
  assert.equal(c.sms_consent, true, 'consent must be on the column lib/notify.js reads');
  assert.equal(c.sms_consent_source, 'checkout');
  assert.equal(c.sms_consent_ip, '203.0.113.9', 'the customer\'s address, not the proxy\'s');
  assert.ok(c.sms_consent_at && Date.now() - Date.parse(c.sms_consent_at) < 60000, 'stamped now');
  assert.equal(c.sms_unsub_at, null);
});

test('checkout: leaving the box unticked is recorded as a NO, and withdraws an earlier yes', async () => {
  world({ sms_consent: true, sms_consent_at: '2026-01-01T00:00:00.000Z', sms_consent_source: 'checkout' });
  const r = await call(confirmBooking, { body: {
    paymentIntentId: 'pi_1', name: 'Murad', email: 'murad@example.com', phone: '+12045550111',
    sms: true, smsConsent: false,
  } });

  assert.equal(r.out.ok, true);
  const c = me();
  assert.equal(c.sms_consent, false, 'an untouched box is the customer saying no');
  assert.ok(c.sms_unsub_at, 'and it stops the texts an earlier yes allowed');
  assert.equal(c.sms_opt_in, true, 'the old UI preference is left alone — it was never consent');
});

test('checkout: a request with no consent field changes nothing at all', async () => {
  world({ sms_consent: true, sms_consent_at: '2026-01-01T00:00:00.000Z', sms_consent_ip: '198.51.100.7', sms_consent_source: 'waitlist' });
  const r = await call(confirmBooking, { body: {
    paymentIntentId: 'pi_1', name: 'Murad', email: 'murad@example.com', phone: '+12045550111', sms: false,
  } });

  assert.equal(r.out.ok, true);
  const c = me();
  assert.deepEqual(
    [c.sms_consent, c.sms_consent_at, c.sms_consent_ip, c.sms_consent_source, c.sms_unsub_at],
    [true, '2026-01-01T00:00:00.000Z', '198.51.100.7', 'waitlist', null],
    'an older client that sends no consent field must never be read as a yes OR a no');
});

test('hours checkout: paying with prepaid hours records the same tick the same way', async () => {
  world();
  const r = await call(hourCards, { action: 'book', body: { ...SLOT, name: 'Murad', smsConsent: true },
    headers: { authorization: 'Bearer tok-murad', 'x-forwarded-for': '203.0.113.42' } });

  assert.equal(r.out.ok, true, JSON.stringify(r.out));
  const c = me();
  assert.equal(c.sms_consent, true);
  assert.equal(c.sms_consent_source, 'checkout');
  assert.equal(c.sms_consent_ip, '203.0.113.42');
});

test('hours checkout: no consent field, no change', async () => {
  world({ sms_consent: true, sms_consent_source: 'checkout' });
  const r = await call(hourCards, { action: 'book', body: { ...SLOT, name: 'Murad' },
    headers: { authorization: 'Bearer tok-murad' } });

  assert.equal(r.out.ok, true, JSON.stringify(r.out));
  assert.deepEqual([me().sms_consent, me().sms_unsub_at], [true, null]);
});

// ========== 2. the reply "STOP" ===============================================================

const TOKEN = 'test-only-auth-token';
const INBOUND_URL = 'https://invictus.test/api/waitlist?action=sms-reply';

// Twilio's scheme: the full URL, then every POST field in alphabetical order as key+value,
// HMAC-SHA1 with the account's auth token, base64.
function sign(params, { token = TOKEN, url = INBOUND_URL } = {}) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + String(params[k]), url);
  return createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}
async function inbound(params, { signature, token = TOKEN, headers = {} } = {}) {
  const before = process.env.TWILIO_AUTH_TOKEN;
  if (token === null) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = token;
  try {
    return await call(waitlist, { action: 'sms-reply', body: params, url: '/api/waitlist?action=sms-reply',
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'invictus.test',
        'x-twilio-signature': signature === undefined ? sign(params) : signature, ...headers } });
  } finally {
    if (before === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = before;
  }
}
const msg = (body, from = '+12045550111') => ({ From: from, To: '+12049900000', Body: body, MessageSid: 'SM123' });

test('STOP: a correctly signed reply unsubscribes the customer and clears their consent', async () => {
  world({ sms_consent: true, sms_consent_at: '2026-01-01T00:00:00.000Z' });
  const r = await inbound(msg('STOP'));

  assert.equal(r.code, 200);
  assert.match(r.text, /^<\?xml[^>]*\?><Response><\/Response>$/, 'empty TwiML: Twilio sends the opt-out confirmation itself');
  const c = me();
  assert.equal(c.sms_consent, false);
  assert.ok(c.sms_unsub_at && Date.now() - Date.parse(c.sms_unsub_at) < 60000);
});

test('STOP: the other carrier keywords, and punctuation, count too', async () => {
  for (const word of ['stopall', 'Unsubscribe', 'CANCEL', 'end', 'Quit.', ' STOP ']) {
    world({ sms_consent: true });
    await inbound(msg(word));
    assert.equal(me().sms_consent, false, `"${word}" must stop the texts`);
  }
});

test('STOP: an UNSIGNED request is refused and writes nothing', async () => {
  world({ sms_consent: true });
  const r = await inbound(msg('STOP'), { signature: '' });

  assert.equal(r.code, 403);
  assert.match(r.text, /not signed by Twilio/i);
  assert.match(r.text, /A message comes in/, 'the refusal says what to fix');
  assert.equal(me().sms_consent, true, 'consent untouched');
  assert.deepEqual(S.writes, [], 'nothing was written at all');
});

test('STOP: a request signed with the WRONG token is refused and writes nothing', async () => {
  world({ sms_consent: true });
  const params = msg('STOP');
  const r = await inbound(params, { signature: sign(params, { token: 'someone-elses-token' }) });

  assert.equal(r.code, 403);
  assert.equal(me().sms_consent, true);
  assert.deepEqual(S.writes, []);
});

test('STOP: a signature for a DIFFERENT body (or URL) does not carry over', async () => {
  world({ sms_consent: true });
  const original = msg('HELP');
  const r = await inbound(msg('STOP'), { signature: sign(original) });
  assert.equal(r.code, 403);
  assert.equal(me().sms_consent, true);

  world({ sms_consent: true });
  const params = msg('STOP');
  const r2 = await inbound(params, { signature: sign(params, { url: 'https://evil.test/api/waitlist?action=sms-reply' }) });
  assert.equal(r2.code, 403);
  assert.equal(me().sms_consent, true);
});

test('STOP: with no TWILIO_AUTH_TOKEN set the endpoint refuses instead of trusting the body', async () => {
  world({ sms_consent: true });
  const r = await inbound(msg('STOP'), { token: null });

  assert.equal(r.code, 503);
  assert.match(r.text, /TWILIO_AUTH_TOKEN/, 'says exactly what is missing');
  assert.equal(me().sms_consent, true);
  assert.deepEqual(S.writes, []);
});

test('START: restores consent, recorded like any other consent', async () => {
  world({ sms_consent: false, sms_unsub_at: '2026-02-02T00:00:00.000Z' });
  const r = await inbound(msg('Start'), { headers: { 'x-forwarded-for': '203.0.113.77' } });

  assert.equal(r.code, 200);
  const c = me();
  assert.equal(c.sms_consent, true);
  assert.equal(c.sms_unsub_at, null, 'the unsubscribe is lifted');
  assert.equal(c.sms_consent_source, 'sms-reply');
  assert.equal(c.sms_consent_ip, '203.0.113.77');
  assert.ok(c.sms_consent_at && Date.now() - Date.parse(c.sms_consent_at) < 60000);
});

test('the number is matched by its digits, however it was stored', async () => {
  world({ phone: '(204) 555-0111', sms_consent: true });
  await inbound(msg('STOP', '+12045550111'));
  assert.equal(me().sms_consent, false, '"(204) 555-0111" and "+12045550111" are one customer');
});

test('an unknown number is handled without error, and creates nobody', async () => {
  world({ sms_consent: true });
  const stop = await inbound(msg('STOP', '+12045559999'));
  assert.equal(stop.code, 200);
  const start = await inbound(msg('START', '+12045559999'));
  assert.equal(start.code, 200);

  assert.equal(S.db.customers.length, 1, 'no profile invented for a stranger');
  assert.equal(me().sms_consent, true, 'and nobody else was touched');
  assert.deepEqual(S.writes, [], 'a number we do not know changes nothing');
});

test('HELP: answers politely and changes nothing', async () => {
  world({ sms_consent: true });
  const r = await inbound(msg('HELP'));

  assert.equal(r.code, 200);
  assert.match(r.text, /<Message>/);
  assert.match(r.text, /Invictus Golf/);
  assert.match(r.text, /STOP/);
  assert.equal(me().sms_consent, true);
  assert.deepEqual(S.writes, [], 'HELP is a question, not an instruction');
});

test('an ordinary reply ("thanks, see you Saturday") is left for a human and changes nothing', async () => {
  world({ sms_consent: true });
  const r = await inbound(msg('thanks, see you Saturday'));

  assert.equal(r.code, 200);
  assert.equal(me().sms_consent, true);
  assert.deepEqual(S.writes, []);
});
