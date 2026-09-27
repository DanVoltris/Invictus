// The outbox drain: /api/waitlist?action=outbox.
//
// Proves the three things that matter about a scheduled sender: it will not run for a stranger,
// it delivers what is due, and it leaves alone what is not. lib/db.js is mocked (so no database
// and no network), but lib/notify.js is the REAL one — the due filter, the CASL gates, the
// attempt counter and the provider call all run for real, with fetch() stubbed at the edge.
//
//   node --experimental-test-module-mocks --test <this file>
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const url = (...p) => pathToFileURL(path.join(ROOT, ...p)).href;

const SECRET = 'test-only-not-a-real-secret';

// ----- the fake database -------------------------------------------------------------------
// `rows` stands in for public.notifications. dueNotifications applies the same filter lib/db.js
// applies (queued, send_after in the past, oldest first), which is the behaviour under test.
let rows = [];
let insertImpl = async () => ({ unsupported: true });

const db = {
  getSettings: async () => ({
    venue: { name: 'Invictus Golf', address: '1 Test Rd, Winnipeg MB', email: 'hello@invictus.test' },
  }),
  dueNotifications: async ({ limit = 20, nowISO } = {}) => {
    const now = nowISO || new Date().toISOString();
    return rows
      .filter((r) => r.status === 'queued' && r.send_after <= now)
      .sort((a, b) => (a.send_after < b.send_after ? -1 : 1))
      .slice(0, limit);
  },
  updateNotification: async (id, patch) => {
    const row = rows.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
    return { ok: true };
  },
  customerHoursByContact: async () => null,
  // Swappable per test: the gift-card test needs real rows back from the queue.
  insertNotification: async (r) => insertImpl(r),
  // Nobody is signed in during these tests: the secret is the only door.
  verifyManager: async () => ({ user: null }),
  staffContext: async () => ({ error: 'unauthorized' }),
  // Present so the ESM named imports in api/waitlist.js link; unused by ?action=outbox.
  waitlistConfig: () => ({}), waitlistQuietNow: () => false, customerKeyFor: () => null,
  recordConsent: async () => ({}), applySmsReply: async () => ({}), createWaitlistEntry: async () => ({}),
  waitlistEntryByToken: async () => null, leaveWaitlist: async () => ({}),
  waitlistOfferByToken: async () => null, claimWaitlistOffer: async () => ({}),
  declineWaitlistOffer: async () => ({}), runWaitlistSweep: async () => ({}),
  pendingWaitlistOffers: async () => [], markWaitlistOfferNotified: async () => ({}),
  leaguePlayerForRequest: async () => null,
};
mock.module(url('lib', 'db.js'), { namedExports: db });

const { default: handler } = await import(url('api', 'waitlist.js'));
const { notifyGiftCard } = await import(url('lib', 'notify.js'));

// ----- harness -----------------------------------------------------------------------------
let fetched = [];
const call = async (headers = {}, body = {}) => {
  const req = { method: 'POST', query: { action: 'outbox' }, body, headers, socket: {} };
  const res = {
    code: 200, body: null,
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return this; },
  };
  await handler(req, res);
  return res;
};

const iso = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60000).toISOString();
const row = (id, sendAfter) => ({
  id, channel: 'email', recipient: `${id}@invictus.test`, template: 'booking.confirmed',
  payload: { dateISO: '2026-09-20', bayId: 'bay-1', bayName: 'Bay 1', startMin: 600, endMin: 660, amountCents: 5000 },
  msg_class: 'transactional', status: 'queued', attempts: 0, send_after: sendAfter,
});

beforeEach(() => {
  rows = [row('due', iso(-5)), row('later', iso(+60))];
  insertImpl = async () => ({ unsupported: true });
  delete process.env.CRON_SECRET;
  fetched = [];
  process.env.OUTBOX_SWEEP_SECRET = SECRET;
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_FROM = 'Invictus Golf <bookings@invictus.test>';
  delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_FROM;
  globalThis.fetch = async (u, init) => {
    fetched.push({ url: String(u), body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ id: 'msg_test_1' }) };
  };
});

// ----- (a) it refuses to run unauthenticated ------------------------------------------------

test('no secret header: refused, nothing sent', async () => {
  const res = await call();
  assert.equal(res.code, 401);
  assert.equal(res.body.ok, false);
  assert.equal(fetched.length, 0);
  assert.deepEqual(rows.map((r) => r.status), ['queued', 'queued']);
});

test('wrong secret: refused', async () => {
  // Same length as the real one, so the constant-time compare is what rejects it.
  const wrong = SECRET.slice(0, -1) + 'X';
  assert.equal(wrong.length, SECRET.length);
  const res = await call({ 'x-outbox-secret': wrong });
  assert.equal(res.code, 401);
  assert.equal(fetched.length, 0);
});

test('no secret configured at all: refuses with 503 and says what to set', async () => {
  delete process.env.OUTBOX_SWEEP_SECRET;
  delete process.env.WAITLIST_SWEEP_SECRET;
  const res = await call({ 'x-outbox-secret': SECRET });
  assert.equal(res.code, 503);
  assert.match(res.body.error, /OUTBOX_SWEEP_SECRET/);
  assert.equal(fetched.length, 0);
});

// ----- (b) an authenticated call delivers what is due ---------------------------------------

test('authenticated: delivers the due row and reports a tally', async () => {
  const res = await call({ 'x-outbox-secret': SECRET });
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.outbox, { picked: 1, sent: 1, skipped: 0, failed: 0, retry: 0 });

  assert.equal(fetched.length, 1);
  assert.match(fetched[0].url, /api\.resend\.com/);
  assert.deepEqual(fetched[0].body.to, ['due@invictus.test']);

  const due = rows.find((r) => r.id === 'due');
  assert.equal(due.status, 'sent');
  assert.equal(due.attempts, 1);
  assert.equal(due.provider_message_id, 'msg_test_1');
});

test('the x-cron-secret header works too (one secret for every job)', async () => {
  const res = await call({ 'x-cron-secret': SECRET });
  assert.equal(res.code, 200);
  assert.equal(res.body.outbox.sent, 1);
});

test('called again straight away: nothing is sent twice', async () => {
  await call({ 'x-outbox-secret': SECRET });
  const again = await call({ 'x-outbox-secret': SECRET });
  assert.deepEqual(again.body.outbox, { picked: 0, sent: 0, skipped: 0, failed: 0, retry: 0 });
  assert.equal(fetched.length, 1);
});

test('two calls at once: the second sees the first running and changes nothing', async () => {
  const [a, b] = await Promise.all([call({ 'x-outbox-secret': SECRET }), call({ 'x-outbox-secret': SECRET })]);
  const busy = [a, b].filter((r) => r.body.busy === true);
  assert.equal(busy.length, 1, 'exactly one of the two concurrent calls should back off');
  assert.equal(fetched.length, 1, 'the row is delivered once');
});

// ----- (c) rows that are not due are left alone ---------------------------------------------

test('a row queued for later is untouched', async () => {
  await call({ 'x-outbox-secret': SECRET });
  const later = rows.find((r) => r.id === 'later');
  assert.equal(later.status, 'queued');
  assert.equal(later.attempts, 0);
  assert.equal(later.sent_at, undefined);
  assert.ok(!fetched.some((f) => f.body.to.includes('later@invictus.test')));
});

test('nothing due at all: a clean empty tally, no provider call', async () => {
  rows = [row('later', iso(+60))];
  const res = await call({ 'x-outbox-secret': SECRET });
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.outbox, { picked: 0, sent: 0, skipped: 0, failed: 0, retry: 0 });
  assert.equal(fetched.length, 0);
});


// ----- (c) the daily Vercel run, and what it does that the instant send cannot ---------------
//
// Every message is sent the moment it is created; this daily run is only the catch-up for retries
// and gift cards dated for a later day. Vercel Cron calls it as a GET with its own secret.

test('Vercel Cron: a GET with Bearer CRON_SECRET runs the outbox; a wrong one is refused', async () => {
  process.env.CRON_SECRET = 'cron-test-secret';
  const get = (authorization) => {
    const req = { method: 'GET', query: { action: 'outbox' }, body: {}, headers: authorization ? { authorization } : {}, socket: {} };
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
    return handler(req, res).then(() => res);
  };
  assert.equal((await get('Bearer not-it-at-all!')).code, 401);
  assert.equal((await get()).code, 401);
  assert.equal(fetched.length, 0);
  const ok = await get('Bearer cron-test-secret');
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.outbox.sent, 1);
});

test('a gift card delivered by the daily run has its code taken out of the row, like an instant one', async () => {
  rows = [{ id: 'gift', channel: 'email', recipient: 'friend@invictus.test', template: 'gift.issued',
    payload: { cardId: 'gc1', code: 'ABCD-EFGH-JKLM', amountCents: 5000, name: 'Sam' },
    msg_class: 'transactional', status: 'queued', attempts: 0, send_after: iso(-1) }];
  const res = await call({ 'x-outbox-secret': SECRET });
  assert.equal(res.body.outbox.sent, 1);
  assert.equal(rows[0].payload.code, undefined, 'the spendable code is gone from the database');
  assert.equal(rows[0].payload.codeRedacted, true);
});

test('a gift card scheduled for later: the CARD waits, but the buyer\'s receipt goes out now', async () => {
  let n = 0;
  insertImpl = async (r) => { const made = { id: `n${++n}`, status: 'queued', attempts: 0, ...r }; rows.push(made); return { id: made.id, row: made }; };
  rows = [];
  await notifyGiftCard({ cardId: 'gc2', code: 'WXYZ-1234-5678', amountCents: 5000,
    purchaserName: 'Pat', purchaserEmail: 'pat@invictus.test', recipientName: 'Sam', recipientEmail: 'sam@invictus.test',
    deliverAt: iso(60 * 24 * 3) });
  const card = rows.find((r) => r.template === 'gift.issued'), receipt = rows.find((r) => r.template === 'gift.purchased');
  assert.equal(receipt.status, 'sent', 'the buyer hears straight away');
  assert.equal(card.status, 'queued', 'the card waits for its day');
  assert.deepEqual(fetched.map((f) => f.body.to[0]), ['pat@invictus.test']);
});

test('an EXPIRED sign-in code is never texted — not by a retry, not by the daily run', async () => {
  process.env.TWILIO_ACCOUNT_SID = 'AC_x'; process.env.TWILIO_AUTH_TOKEN = 't'; process.env.TWILIO_FROM = '+12045550000';
  const code = (id, minutesAgo) => ({ id, channel: 'sms', recipient: '+12049906530', template: 'account.code',
    payload: { code: '123456', minutes: 10 }, msg_class: 'transactional', status: 'queued', attempts: 0,
    created_at: iso(-minutesAgo), send_after: iso(-minutesAgo) });
  rows = [code('stale', 11), code('fresh', 2)];
  // Twilio takes a form, not JSON — capture it as one.
  globalThis.fetch = async (u, init) => { fetched.push({ url: String(u), form: new URLSearchParams(init.body) });
    return { ok: true, status: 201, json: async () => ({ sid: 'SM_1' }) }; };
  const res = await call({ 'x-outbox-secret': SECRET });
  assert.deepEqual(res.body.outbox, { picked: 2, sent: 1, skipped: 1, failed: 0, retry: 0 });
  assert.equal(rows.find((r) => r.id === 'stale').status, 'skipped');
  assert.match(rows.find((r) => r.id === 'stale').last_error, /expired/);
  assert.equal(rows.find((r) => r.id === 'fresh').status, 'sent');
  assert.equal(fetched.length, 1, 'only the fresh code reached Twilio');
});
