// api/webhook.js signature enforcement.
//
// The Stripe SDK is faked, but its webhooks helper is the REAL one (loaded separately through the
// CommonJS build), so signing and verification are exactly what production runs. lib/db.js and
// lib/notify.js are mocked and every write they would make is recorded in `writes`.
//
//   node --experimental-test-module-mocks --test <this file>
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const url = (...p) => pathToFileURL(path.join(ROOT, ...p)).href;
const WHSEC = 'whsec_test_only_not_a_real_secret';

// Real signing/verification, from a module instance the mock below cannot touch.
const RealStripe = createRequire(path.join(ROOT, 'package.json'))('stripe');
const realWebhooks = new RealStripe('sk_test_dummy').webhooks;

// ----- fakes -------------------------------------------------------------------------------
let writes = [];
const rec = (name, ret) => async (...args) => { writes.push({ name, args }); return ret; };

class FakeStripe {
  constructor() {
    this.webhooks = realWebhooks;
    this.charges = { retrieve: async () => ({ billing_details: { name: 'Pat Golfer', email: 'pat@example.test', phone: null } }) };
  }
}
mock.module(url('node_modules', 'stripe', 'esm', 'stripe.esm.node.js'), { defaultExport: FakeStripe });

mock.module(url('lib', 'db.js'), { namedExports: {
  insertBooking: rec('insertBooking', { id: 'bk_1' }),
  getSettings: async () => ({}),
  confirmHold: rec('confirmHold', { updated: false }),
  upsertCustomer: rec('upsertCustomer', { id: 'cu_1' }),
  bookingExistsForPI: async () => false,
  redeemGiftCard: rec('redeemGiftCard', {}),
  redeemPromo: rec('redeemPromo', {}),
  confirmLeagueCheckout: rec('confirmLeagueCheckout', {}),
  confirmLeagueTeamCheckout: rec('confirmLeagueTeamCheckout', {}),
  recordStripeEvent: rec('recordStripeEvent', { recorded: true }),
  forgetStripeEvent: rec('forgetStripeEvent', {}),
} });
mock.module(url('lib', 'notify.js'), { namedExports: {
  notifyBookingConfirmed: rec('notifyBookingConfirmed', {}),
} });

const { default: handler } = await import(process.env.WEBHOOK_UNDER_TEST || url('api', 'webhook.js'));

// ----- harness -----------------------------------------------------------------------------
const evt = (over = {}) => ({
  id: 'evt_test_1', object: 'event', type: 'payment_intent.succeeded', livemode: false,
  data: { object: {
    id: 'pi_test_1', object: 'payment_intent', amount: 5000, latest_charge: 'ch_1', receipt_email: null,
    metadata: { dateISO: '2026-10-01', bayId: 'bay1', bayName: 'Bay 1', startMin: '600', endMin: '660',
                summary: 'Thu 10:00', giftCardId: 'gc_1', giftUsedCents: '1000', promoReservationId: 'pr_1' },
  } },
  ...over,
});
const sign = (payload, secret = WHSEC) => realWebhooks.generateTestHeaderString({ payload, secret });

function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}
// Local (Express) shape: express.raw() hands over a Buffer and the stream is already drained.
const expressReq = (raw, headers) => ({ method: 'POST', headers, body: Buffer.from(raw) });
// Vercel shape: a faithful copy of @vercel/node's addHelpers() (packages/node/src/serverless-
// functions/helpers.ts). It drains the stream into a Buffer BEFORE the handler, replays those bytes
// to req.on('data'/'end') via restoreBody(), and defines req.body as a lazy getter that JSON-parses
// (throwing on malformed JSON). There is no bodyParser opt-out on plain Vercel functions.
async function vercelReq(raw, headers) {
  const req = Object.assign(Readable.from([Buffer.from(raw)]), { method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
  const chunks = []; for await (const c of req) chunks.push(c);   // the runtime drains it
  const body = Buffer.concat(chunks);
  const replay = new PassThrough(); const on = replay.on.bind(replay); const originalOn = req.on.bind(req);
  req.read = replay.read.bind(replay);
  req.on = req.addListener = (name, cb) => (name === 'data' || name === 'end' ? on(name, cb) : originalOn(name, cb));
  replay.write(body); replay.end();
  let parsed, done = false;
  Object.defineProperty(req, 'body', { configurable: true, enumerable: true, get() {
    if (!done) { const str = body.toString(); try { parsed = str ? JSON.parse(str) : {}; } catch { throw new Error('Invalid JSON'); } done = true; }
    return parsed;
  } });
  return req;
}

async function call(req) { const res = makeRes(); await handler(req, res); return res; }

beforeEach(() => {
  writes = [];
  process.env.STRIPE_SECRET_KEY = 'sk_test_realistic123';
  process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_realistic123';
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
});
const quiet = () => { mock.method(console, 'error', () => {}); mock.method(console, 'log', () => {}); mock.method(console, 'warn', () => {}); };

// ----- tests -------------------------------------------------------------------------------
test('Vercel: malformed JSON (lazy getter throws) is a 400, nothing written', async () => {
  quiet();
  const raw = '{not json';
  const res = await call(await vercelReq(raw, { 'stripe-signature': sign(raw) }));
  assert.equal(res.statusCode, 400);
  assert.deepEqual(writes, []);
});

test('(a) correctly signed event is processed — Express Buffer path', async () => {
  quiet();
  const raw = JSON.stringify(evt());
  const res = await call(expressReq(raw, { 'stripe-signature': sign(raw) }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true });
  const names = writes.map((w) => w.name);
  for (const n of ['recordStripeEvent', 'confirmHold', 'insertBooking', 'upsertCustomer', 'redeemGiftCard', 'redeemPromo', 'notifyBookingConfirmed'])
    assert.ok(names.includes(n), `expected ${n} to run, got ${names}`);
  assert.equal(writes.find((w) => w.name === 'insertBooking').args[0].stripe_payment_intent, 'pi_test_1');
});

test('(a) correctly signed event is processed — Vercel raw-stream path', async () => {
  quiet();
  const raw = JSON.stringify(evt(), null, 2);   // Stripe sends pretty-printed JSON: bytes must be verbatim
  const res = await call(await vercelReq(raw, { 'stripe-signature': sign(raw) }));
  assert.equal(res.statusCode, 200);
  assert.ok(writes.some((w) => w.name === 'insertBooking'));
});

test('(b) unsigned request is rejected with 400 and nothing is written', async () => {
  quiet();
  const raw = JSON.stringify(evt());
  const res = await call(expressReq(raw, {}));
  assert.equal(res.statusCode, 400);
  assert.deepEqual(writes, []);
});

test('(b) forged request signed with the wrong secret is rejected with 400 and nothing is written', async () => {
  quiet();
  const raw = JSON.stringify(evt());
  const res = await call(expressReq(raw, { 'stripe-signature': sign(raw, 'whsec_attacker_guess') }));
  assert.equal(res.statusCode, 400);
  assert.deepEqual(writes, []);
});

test('(b) a parsed object on req.body is never trusted when the raw bytes are unavailable', async () => {
  quiet();
  const raw = JSON.stringify(evt());
  // bodyParser ON would give an object and a drained stream; with a real signature it must still
  // not be accepted from the object — the stream is empty, so verification fails closed.
  const req = Object.assign(Readable.from([]), { method: 'POST', headers: { 'stripe-signature': sign(raw) }, body: evt() });
  const res = await call(req);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(writes, []);
});

test('(c) no secret configured: refuses instead of trusting the body', async () => {
  const errs = [];
  mock.method(console, 'error', (...a) => errs.push(a.join(' ')));
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const raw = JSON.stringify(evt());
  for (const req of [expressReq(raw, {}), await vercelReq(raw, {}), { method: 'POST', headers: {}, body: evt() }]) {
    const res = await call(req);
    assert.equal(res.statusCode, 503);
  }
  assert.deepEqual(writes, []);
  assert.ok(errs.some((e) => e.includes('STRIPE_WEBHOOK_SECRET')), 'log names the variable to set');
});

test('(c) empty-string secret is treated as not configured', async () => {
  quiet();
  process.env.STRIPE_WEBHOOK_SECRET = '';
  const raw = JSON.stringify(evt());
  const res = await call(expressReq(raw, {}));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(writes, []);
});

test('(d) tampered body with a valid signature for the original fails', async () => {
  quiet();
  const original = JSON.stringify(evt());
  const header = sign(original);
  const tampered = original.replace('"amount":5000', '"amount":1');
  assert.notEqual(tampered, original);
  const res = await call(expressReq(tampered, { 'stripe-signature': header }));
  assert.equal(res.statusCode, 400);
  assert.deepEqual(writes, []);
  // Same through the Vercel stream path.
  const res2 = await call(await vercelReq(tampered, { 'stripe-signature': header }));
  assert.equal(res2.statusCode, 400);
  assert.deepEqual(writes, []);
});

test('signed livemode event is acknowledged but not fulfilled', async () => {
  quiet();
  const raw = JSON.stringify(evt({ livemode: true }));
  const res = await call(expressReq(raw, { 'stripe-signature': sign(raw) }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ignored, 'livemode');
  assert.deepEqual(writes, []);
});

test('Stripe not enabled (no test keys): unchanged early 200, nothing written', async () => {
  quiet();
  delete process.env.STRIPE_SECRET_KEY;
  const res = await call(expressReq('{}', {}));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(writes, []);
});
