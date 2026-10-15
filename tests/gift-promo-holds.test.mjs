// Card holds are the venue's default way to pay: the card is authorised at checkout and captured at
// check-in, so a finished checkout's PaymentIntent is 'requires_capture', not 'succeeded'. The
// gift-card and promo redeem steps only accepted 'succeeded', so on a held booking the gift card was
// never debited (its value could be spent again) and a one-per-customer promo was never counted.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('../', import.meta.url).href;
Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_PUBLISHABLE_KEY: 'pk_test_fake' });

let PI = null, calls = [];
const rec = (name, ret) => async (...a) => { calls.push([name, a[0]]); return typeof ret === 'function' ? ret(...a) : ret; };
const none = async () => null;
mock.module(ROOT + 'lib/holds.js', { namedExports: { retrieveCheckoutIntent: async () => PI } });
mock.module(ROOT + 'lib/notify.js', { namedExports: { notifyGiftCard: none } });
mock.module(ROOT + 'lib/db.js', { namedExports: {
  getSettings: async () => ({}), getOverridesForDate: async () => [], getBookingsForDate: async () => [],
  createGiftCard: none, giftCardByCode: none, giftCardAvailable: none, promoByCode: none,
  reserveGiftCard: none, releaseGiftCard: none, markGiftCardDelivered: none, recordGiftCardAttempt: none,
  giftCardAttemptsBlocked: async () => false, bookWithGiftCard: none, customerHoursByContact: none, upsertCustomer: none,
  reservePromo: none, releasePromo: none, customerKeyFor: () => null, isLeaguePlayer: async () => false,
  leaguePlayerForRequest: none, crossDayProblem: none, promoRateOk: async () => true, promoLogAttempt: none,
  giftCardReservationsForRef: async () => [{ gift_card_id: 'gc_1', booking_id: null }],
  redeemGiftCard: rec('redeemGiftCard', { redeemed: 1000, balance: 4000 }),
  promoReservationById: async (id) => (id === 'pr_1' ? { id: 'pr_1', status: 'reserved' } : null),
  redeemPromo: rec('redeemPromo', { ok: true }),
  bookingIdForPayment: async () => 'bk_from_pi',
} });
const { default: gift } = await import(ROOT + 'api/gift-cards.js');
const { default: promos } = await import(ROOT + 'api/promos.js');

async function post(handler, action, body) {
  let code = 200, out;
  const res = { setHeader() { return this; }, status(c) { code = c; return this; }, json(b) { out = b; return this; }, end() { return this; } };
  await handler({ method: 'POST', query: { action }, body, headers: {} }, res);
  return { code, out };
}
beforeEach(() => { calls = []; PI = { id: 'pi_1', status: 'requires_capture', amount: 3480, metadata: { dateISO: '2026-10-20' } }; });

test('gift card: a held booking is debited at checkout, against what the card pays', async () => {
  const r = await post(gift, 'redeem', { paymentIntentId: 'pi_1' });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.equal(r.out.redeemedCents, 1000);
  const [, args] = calls.find(([n]) => n === 'redeemGiftCard');
  assert.equal(args.chargedCents, 3480, 'the card amount — what the reservation expects');
  assert.equal(args.bookingId, 'bk_from_pi', 'tied to the booking, so a cancellation can give it back');
});

test('promo: a held booking counts the use', async () => {
  const r = await post(promos, 'redeem', { paymentIntentId: 'pi_1', reservationId: 'pr_1' });
  assert.equal(r.code, 200, JSON.stringify(r.out));
  assert.ok(calls.some(([n]) => n === 'redeemPromo'));
});

test('a checkout that is not finished still debits nothing', async () => {
  PI.status = 'requires_payment_method';
  assert.equal((await post(gift, 'redeem', { paymentIntentId: 'pi_1' })).code, 400);
  assert.equal((await post(promos, 'redeem', { paymentIntentId: 'pi_1', reservationId: 'pr_1' })).code, 400);
  assert.equal(calls.length, 0);
});
