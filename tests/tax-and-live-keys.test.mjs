// Going live: sales tax at checkout, and live Stripe keys.
//
// Tax: customers used to be charged the bare rate while the portal claimed 12% was "applied on top".
// Now the online checkout adds it — on the price AFTER discounts, and BEFORE the gift card (a gift
// card is a way of paying, so it pays the tax too). Staff group bookings are settled through Toast,
// which adds its own tax, so quoteBooking() adds none unless the caller passes taxPct.
//
// Live keys: the prototype refused them outright. They now work, but only as a matched pair.
//
//   node --test tests/tax-and-live-keys.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripeStatus, taxPctOf, quoteBooking } from '../lib/booking.js';

// ---- live keys ------------------------------------------------------------------------------

test('a test pair turns Stripe on, in test mode', () => {
  const s = stripeStatus({ STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_PUBLISHABLE_KEY: 'pk_test_abc' });
  assert.equal(s.enabled, true);
  assert.equal(s.live, false);
});

test('a live pair turns Stripe on, in live mode — restricted keys included', () => {
  assert.equal(stripeStatus({ STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_PUBLISHABLE_KEY: 'pk_live_abc' }).live, true);
  assert.equal(stripeStatus({ STRIPE_SECRET_KEY: 'rk_live_abc', STRIPE_PUBLISHABLE_KEY: 'pk_live_abc' }).live, true);
});

test('a mismatched pair leaves Stripe OFF and says so', () => {
  for (const [sk, pk] of [['sk_live_abc', 'pk_test_abc'], ['sk_test_abc', 'pk_live_abc']]) {
    const s = stripeStatus({ STRIPE_SECRET_KEY: sk, STRIPE_PUBLISHABLE_KEY: pk });
    assert.equal(s.enabled, false, `${sk} + ${pk}`);
    assert.equal(s.mismatch, true);
  }
});

test('a space or newline pasted around a key is ignored, and the trimmed key is what Stripe gets', () => {
  const s = stripeStatus({ STRIPE_SECRET_KEY: ' sk_live_abc\n', STRIPE_PUBLISHABLE_KEY: 'pk_live_abc ' });
  assert.equal(s.enabled, true);
  assert.equal(s.secretKey, 'sk_live_abc');
});

test('missing keys, placeholders and junk leave Stripe off', () => {
  for (const env of [
    {},
    { STRIPE_SECRET_KEY: 'sk_test_xxx', STRIPE_PUBLISHABLE_KEY: 'pk_test_xxx' },
    { STRIPE_SECRET_KEY: '"sk_live_abc"', STRIPE_PUBLISHABLE_KEY: 'pk_live_abc' },
    { STRIPE_SECRET_KEY: 'pk_live_abc', STRIPE_PUBLISHABLE_KEY: 'pk_live_abc' },
  ]) assert.equal(stripeStatus(env).enabled, false, JSON.stringify(env));
});

// ---- the tax rate ---------------------------------------------------------------------------

test('the tax rate comes from Payment Settings; unset means the 12% the portal shows', () => {
  assert.equal(taxPctOf({ pay: {} }), 12);
  assert.equal(taxPctOf({}), 12);
  assert.equal(taxPctOf({ pay: { taxPct: '' } }), 12);
  assert.equal(taxPctOf({ pay: { taxPct: 5 } }), 5);
  assert.equal(taxPctOf({ pay: { taxPct: 0 } }), 0, 'zero is a real choice, not "unset"');
});

test('a typo can never put a huge tax on a card', () => {
  assert.equal(taxPctOf({ pay: { taxPct: 120 } }), 30);
  assert.equal(taxPctOf({ pay: { taxPct: -5 } }), 0);
  assert.equal(taxPctOf({ pay: { taxPct: 'abc' } }), 12);
});

// ---- the charge -----------------------------------------------------------------------------

const base = { settings: {}, plan: null, todayISO: '2026-09-25' };

test('tax is added on top: a $40 session at 12% charges $44.80', () => {
  const q = quoteBooking({ ...base, amountCents: 4000, taxPct: 12 });
  assert.equal(q.subtotalCents, 4000);
  assert.equal(q.taxCents, 480);
  assert.equal(q.totalCents, 4480);
  assert.equal(q.charge, 4480);
});

test('tax is on the DISCOUNTED price — a $10-off code saves the tax on $10 too', () => {
  const promo = { active: true, code: 'TEN', amount_off_cents: 1000 };
  const q = quoteBooking({ ...base, amountCents: 4000, taxPct: 12, promo, promoContext: {} });
  assert.equal(q.promoDiscountCents, 1000, JSON.stringify(q));
  assert.equal(q.subtotalCents, 3000);
  assert.equal(q.taxCents, 360);
  assert.equal(q.charge, 3360);
});

test('a gift card pays the tax as well — it is a way of paying, not a discount', () => {
  const q = quoteBooking({ ...base, amountCents: 4000, taxPct: 12,
    giftBalanceCents: 10000, applyGift: true, giftPartialOnly: false });
  assert.equal(q.taxCents, 480, 'tax is still owed on the full sale');
  assert.equal(q.giftUsedCents, 4480);
  assert.equal(q.charge, 0);
});

test('a partial gift card leaves the card to pay the rest, tax included', () => {
  const q = quoteBooking({ ...base, amountCents: 4000, taxPct: 12, giftBalanceCents: 2500, applyGift: true });
  assert.equal(q.giftUsedCents, 2500);
  assert.equal(q.charge, 1980);
});

test('no taxPct (staff group bookings, paid through Toast) adds no tax', () => {
  const q = quoteBooking({ ...base, amountCents: 4000 });
  assert.equal(q.taxCents, 0);
  assert.equal(q.charge, 4000);
});
