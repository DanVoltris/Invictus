// A waiting-list offer holds a bay for one person for a few minutes. It used to be marked
// "notified" as soon as a text was QUEUED — so a text that failed, or was never allowed, left the
// bay held for somebody who was never told — and a failed text could go out the next morning for
// an offer long gone. Names and numbers are invented.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('../', import.meta.url).href;
const realDb = await import(ROOT + 'lib/db.js?real');
let calls = [], OUT = null, PENDING = [];
const fakeDb = {};
for (const [name, val] of Object.entries(realDb)) {
  fakeDb[name] = typeof val !== 'function' ? val : async (...a) => { calls.push([name, a]); return {}; };
}
Object.assign(fakeDb, {
  waitlistConfig: realDb.waitlistConfig,
  getSettings: async () => ({}),
  pendingWaitlistOffers: async () => PENDING,
  markWaitlistOfferNotified: async (...a) => { calls.push(['markWaitlistOfferNotified', a]); return {}; },
  declineWaitlistOffer: async (...a) => { calls.push(['declineWaitlistOffer', a]); return { ok: true }; },
  updateNotification: async (...a) => { calls.push(['updateNotification', a]); return {}; },
  customerHoursByContact: async () => ({ id: 'c1', sms_consent: true }),
});
mock.module(ROOT + 'lib/db.js', { namedExports: fakeDb });
const realNotify = await import(ROOT + 'lib/notify.js?real');
mock.module(ROOT + 'lib/notify.js', { namedExports: { ...realNotify, notifyWaitlistOffer: async () => OUT } });
const { announcePendingOffers } = await import(ROOT + 'api/waitlist.js');
const { sendOne } = realNotify;

const offer = { id: 'o1', claim_token: '11111111-2222-4333-8444-555555555555', booking_date: '2099-01-01', bay_id: 'B1',
  start_min: 1140, end_min: 1200, expires_at: new Date(Date.now() + 600000).toISOString(), entry: { phone: '2045550101', sms_ok: true } };
const req = { headers: { host: 'invictus.test' } };
const named = (n) => calls.filter(([c]) => c === n);
beforeEach(() => { calls = []; PENDING = [offer]; });

test('a text that went out marks the offer notified', async () => {
  OUT = { channels: ['sms'], sent: ['sent'] };
  const r = await announcePendingOffers(req);
  assert.equal(r.notified, 1);
  assert.equal(named('markWaitlistOfferNotified').length, 1);
  assert.equal(named('declineWaitlistOffer').length, 0);
});

test('a text being retried is left alone: not marked, not passed on', async () => {
  OUT = { channels: ['sms'], sent: ['retry'] };
  await announcePendingOffers(req);
  assert.equal(named('markWaitlistOfferNotified').length, 0, 'the person has not been told yet');
  assert.equal(named('declineWaitlistOffer').length, 0);
});

test('nobody can be told: the offer goes to the next person instead of holding the bay', async () => {
  for (const o of [{ channels: ['sms'], sent: ['skipped'] }, { channels: ['sms'], sent: ['failed'] }, { channels: [], sent: [] }]) {
    calls = []; OUT = o;
    await announcePendingOffers(req);
    assert.equal(named('markWaitlistOfferNotified').length, 0, JSON.stringify(o));
    assert.equal(named('declineWaitlistOffer').length, 1, JSON.stringify(o));
    assert.equal(named('declineWaitlistOffer')[0][1][0], offer.claim_token);
  }
});

test('an offer text whose claim window has closed is never sent', async () => {
  const row = { id: 'n1', channel: 'sms', recipient: '+12045550101', template: 'waitlist.offer', msg_class: 'transactional',
    payload: { expiresAt: new Date(Date.now() - 60000).toISOString(), bayName: 'Bay 1', dateISO: '2099-01-01', startMin: 1140, endMin: 1200 } };
  const status = await sendOne(row, { env: {}, venue: { name: 'Invictus Golf', address: 'x', phone: 'y' } });
  assert.equal(status, 'skipped');
  assert.match(named('updateNotification')[0][1][1].last_error, /offer expired before it could be sent/);
});
