#!/usr/bin/env node
// Live-database verification for gift cards + promo codes.
// Runs against SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from .env, creates rows prefixed ZZTEST,
// asserts the ledgers balance and the limits bite, then deletes every row it made.
//   node scripts/verify-gift-promo.mjs
import 'dotenv/config';
import {
  admin, createGiftCard, giftCardAvailable, reserveGiftCard, releaseGiftCard, redeemGiftCard,
  giftCardTransactions, giftCardById, giftCardReservationsForRef,
  promoByCode, reservePromo, releasePromo, redeemPromo, promoReservationById,
  promoRateOk, promoLogAttempt, customerKeyFor, sweepPromoReservations,
} from '../lib/db.js';

const PREFIX = 'ZZTEST';
const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
const db = admin();
if (!db) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.'); process.exit(1); }

let fails = 0;
const chk = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  →  ${JSON.stringify(got)}${ok ? '' : `  (expected ${JSON.stringify(want)})`}`);
};

// Are the migrations actually applied? Say so plainly instead of failing 30 assertions.
const probe = async (t) => { const { error } = await db.from(t).select('*').limit(1); return !error; };
const haveGift = await probe('gift_cards');
const havePromo = await probe('promos');
console.log(`schema: gift_cards=${haveGift ? 'present' : 'MISSING'}  promos=${havePromo ? 'present' : 'MISSING'}`);
if (!haveGift || !havePromo) {
  console.error('\nMigrations 0020 / 0021 are not applied to this project. Paste supabase/setup.sql');
  console.error('(or migrations 0019, 0020, 0021 in order) into Supabase → SQL Editor → Run, then re-run this script.');
  process.exit(2);
}

const madeCards = [];
const madePromos = [];
const SESSION = `${PREFIX}-sess-${rnd}`;
const PI = `${PREFIX}-pi-${rnd}`;
const PI2 = `${PREFIX}-pi2-${rnd}`;

try {
  // ---------- GIFT CARDS ----------
  console.log('\nGIFT CARDS');
  const made = await createGiftCard({
    amountCents: 5000, purchaserName: `${PREFIX} Buyer`, purchaserEmail: `zztest-${rnd}@invictus.test`,
    note: PREFIX, issuedBy: 'staff', ref: SESSION,
  });
  if (made.error || !made.card) throw new Error('createGiftCard: ' + (made.error || 'no card'));
  madeCards.push(made.card.id);
  const cardId = made.card.id;
  console.log(`  created card ${cardId}  code ${made.formattedCode}  hint ${made.card.code_hint}`);
  chk('opening balance is $50.00', made.card.balance_cents, 5000);
  chk('expires_at is null (Manitoba: no expiry)', (await giftCardById(cardId)).expires_at, null);
  chk('available = balance with nothing reserved', await giftCardAvailable(cardId), 5000);

  // Reserve, do NOT debit. This is the whole point of the design.
  const rsv = await reserveGiftCard({ cardId, amountCents: 1800, ref: PI, expectedChargeCents: 500, ttlSeconds: 300 });
  chk('reserved $18.00 against the PaymentIntent', rsv.reserved, 1800);
  chk('balance UNCHANGED by the reservation', (await giftCardById(cardId)).balance_cents, 5000);
  chk('available drops to $32.00', await giftCardAvailable(cardId), 3200);
  chk('reservation is findable by payment id', (await giftCardReservationsForRef(PI)).length, 1);

  // The safety rail: a charge that does not match what the reservation was quoted against.
  const bad = await redeemGiftCard({ cardId, ref: PI, chargedCents: 999 });
  chk('charge mismatch refuses to debit', bad.error, 'charge_mismatch');
  chk('balance still $50.00 after the refusal', (await giftCardById(cardId)).balance_cents, 5000);
  chk('the bad reservation was dropped', await giftCardAvailable(cardId), 5000);

  // Settle for real.
  const rsv2 = await reserveGiftCard({ cardId, amountCents: 1800, ref: PI, expectedChargeCents: 500, ttlSeconds: 300 });
  chk('re-reserved $18.00', rsv2.reserved, 1800);
  const red = await redeemGiftCard({ cardId, ref: PI, chargedCents: 500, note: `${PREFIX} booking` });
  chk('redeemed $18.00', red.redeemed, 1800);
  chk('balance is now $32.00', red.balance, 3200);
  const again = await redeemGiftCard({ cardId, ref: PI, chargedCents: 500 });
  chk('second redeem of the same payment is a no-op', [again.already, again.balance], [true, 3200]);

  // Two cards on one payment must both be able to settle — the (card, ref) index, not a global one.
  const made2 = await createGiftCard({ amountCents: 1000, purchaserName: `${PREFIX} Buyer2`, purchaserEmail: `zztest2-${rnd}@invictus.test`, note: PREFIX, issuedBy: 'staff', ref: SESSION + '-b' });
  madeCards.push(made2.card.id);
  await reserveGiftCard({ cardId, amountCents: 200, ref: PI2, expectedChargeCents: 50 });
  await reserveGiftCard({ cardId: made2.card.id, amountCents: 300, ref: PI2, expectedChargeCents: 50 });
  const a = await redeemGiftCard({ cardId, ref: PI2, chargedCents: 50 });
  const b = await redeemGiftCard({ cardId: made2.card.id, ref: PI2, chargedCents: 50 });
  chk('two different cards settle against ONE payment', [a.redeemed, b.redeemed], [200, 300]);

  // Release gives a claim back.
  await reserveGiftCard({ cardId, amountCents: 500, ref: `${PI}-rel`, expectedChargeCents: 50 });
  const availHeld = await giftCardAvailable(cardId);
  const rel = await releaseGiftCard({ cardId, ref: `${PI}-rel` });
  chk('release hands the claim back', [rel.released, availHeld, await giftCardAvailable(cardId)], [1, 2500, 3000]);

  // THE LEDGER MUST EQUAL THE BALANCE.
  const tx = await giftCardTransactions(cardId);
  const sum = tx.reduce((n, t) => n + t.cents, 0);
  const bal = (await giftCardById(cardId)).balance_cents;
  console.log('  ledger: ' + tx.map((t) => `${t.kind} ${t.cents > 0 ? '+' : ''}${t.cents}`).join(', '));
  chk('ledger sums to the balance', [sum, bal], [3000, 3000]);

  // ---------- PROMO CODES ----------
  console.log('\nPROMO CODES');
  const code = `${PREFIX}-P20-${rnd}`;
  const { data: promoRow, error: pErr } = await db.from('promos').insert({
    code, kind: 'percent', percent_off: 20, max_redemptions: 2, max_per_customer: 1, note: PREFIX,
  }).select('*').maybeSingle();
  if (pErr) throw new Error('insert promo: ' + pErr.message);
  madePromos.push(promoRow.id);
  console.log(`  created promo ${code} (20%, max 2 uses, 1 per customer)`);

  chk('lookup is case-insensitive', (await promoByCode(code.toLowerCase())).id, promoRow.id);

  const k1 = customerKeyFor({ phone: '204-555-0111' });
  const k2 = customerKeyFor({ phone: '204-555-0222' });
  const k3 = customerKeyFor({ email: 'ZZTest3@Invictus.test' });
  chk('customer key is a normalized phone', k1, 'p:12045550111');
  chk('customer key falls back to a lowercased email', k3, 'e:zztest3@invictus.test');

  const r1 = await reservePromo({ code, customerKey: k1, discountCents: 800, ttlSeconds: 300, ref: PI });
  chk('customer 1 reserves (count 1/2)', [!!r1.reservationId, r1.discountCents, r1.redeemedCount], [true, 800, 1]);

  // Re-applying the same code (the slot changed) must not consume a second use.
  const r1b = await reservePromo({ code, customerKey: k1, discountCents: 700, ttlSeconds: 300, ref: PI });
  chk('re-applying replaces the claim, count stays 1', r1b.redeemedCount, 1);

  const done = await redeemPromo({ reservationId: r1b.reservationId, ref: PI });
  chk('redeem at payment success', done.redeemed, true);
  chk('reservation is now redeemed', (await promoReservationById(r1b.reservationId)).status, 'redeemed');
  const done2 = await redeemPromo({ reservationId: r1b.reservationId, ref: PI });
  chk('redeeming twice is a no-op', done2.redeemed, true);

  // THE LIMIT: the same customer cannot use it again.
  const r1c = await reservePromo({ code, customerKey: k1, discountCents: 800, ttlSeconds: 300 });
  chk('max_per_customer blocks a SECOND use by customer 1', r1c.reason, 'promo_already_used');

  // A different customer can, until the global limit is reached.
  const r2 = await reservePromo({ code, customerKey: k2, discountCents: 800, ttlSeconds: 300 });
  chk('customer 2 reserves (count 2/2)', r2.redeemedCount, 2);
  const r3 = await reservePromo({ code, customerKey: k3, discountCents: 800, ttlSeconds: 300 });
  chk('max_redemptions blocks customer 3', r3.reason, 'promo_exhausted');

  // Abandoning gives the use back.
  const rel2 = await releasePromo(r2.reservationId);
  chk('release on abandon', rel2.released, true);
  const r3b = await reservePromo({ code, customerKey: k3, discountCents: 800, ttlSeconds: 300 });
  chk('customer 3 can now reserve the freed use', r3b.redeemedCount, 2);
  await releasePromo(r3b.reservationId);

  const { data: after } = await db.from('promos').select('redeemed_count').eq('id', promoRow.id).maybeSingle();
  chk('redeemed_count settles at 1 (the one real redemption)', after.redeemed_count, 1);

  // Rate limiter.
  const rk = `${PREFIX}:rate:${rnd}`;
  for (let i = 0; i < 10; i++) await promoLogAttempt({ key: rk, code: 'GUESS' + i, ok: false });
  chk('rate limiter trips after 10 failed guesses', await promoRateOk({ key: rk, windowSeconds: 3600, maxFailed: 10 }), false);
  chk('a different key is unaffected', await promoRateOk({ key: rk + 'x', windowSeconds: 3600, maxFailed: 10 }), true);
  await db.from('promo_attempts').delete().eq('attempt_key', rk);

  chk('sweep runs clean', typeof (await sweepPromoReservations()).swept, 'number');
} catch (err) {
  fails++;
  console.error('\nERROR:', err && err.message ? err.message : err);
} finally {
  // ---------- CLEANUP ----------
  console.log('\nCLEANUP');
  for (const id of madePromos) {
    await db.from('promo_redemptions').delete().eq('promo_id', id);   // no cascade needed, but explicit
    await db.from('promos').delete().eq('id', id);
  }
  for (const id of madeCards) {
    await db.from('gift_card_reservations').delete().eq('gift_card_id', id);
    await db.from('gift_card_transactions').delete().eq('gift_card_id', id);
    await db.from('gift_cards').delete().eq('id', id);
  }
  await db.from('notifications').delete().like('dedupe_key', `%${PREFIX}%`);
  await db.from('customers').delete().like('email', `zztest%${rnd}@invictus.test`);
  await db.from('customers').delete().eq('email', 'zztest3@invictus.test');

  const counts = {};
  for (const [t, col] of [['gift_cards', 'note'], ['promos', 'note']]) {
    const { count } = await db.from(t).select('id', { count: 'exact', head: true }).eq(col, PREFIX);
    counts[t] = count;
  }
  const { count: rsvLeft } = await db.from('gift_card_reservations').select('id', { count: 'exact', head: true }).like('ref', `${PREFIX}%`);
  const { count: attLeft } = await db.from('promo_attempts').select('id', { count: 'exact', head: true }).like('attempt_key', `${PREFIX}%`);
  console.log(`  rows left with the ${PREFIX} marker:`, JSON.stringify({ ...counts, gift_card_reservations: rsvLeft, promo_attempts: attLeft }));
  if (counts.gift_cards || counts.promos || rsvLeft || attLeft) { fails++; console.log('  FAIL — test rows survived cleanup'); }
  else console.log('  PASS — tables are clean');
}

console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL LIVE CHECKS PASSED');
process.exit(fails ? 1 : 0);
