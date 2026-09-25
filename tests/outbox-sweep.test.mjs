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
  insertNotification: async () => ({ unsupported: true }),
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
