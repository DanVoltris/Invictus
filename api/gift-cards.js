import {
  stripeStatus, stripeClient, normalizeSettings, giftConfig,
  priceForBooking, overrideEffects, overrideConflicts, weeklyStatusConflicts,
  quoteBooking, taxPctOf, winnipegTodayISO, bookingWindowError
} from '../lib/booking.js';
import {
  getSettings, getOverridesForDate, getBookingsForDate,
  createGiftCard, giftCardByCode, giftCardAvailable, promoByCode,
  reserveGiftCard, releaseGiftCard, redeemGiftCard, giftCardReservationsForRef,
  markGiftCardDelivered, recordGiftCardAttempt, giftCardAttemptsBlocked,
  bookWithGiftCard, customerHoursByContact, upsertCustomer,
  reservePromo, releasePromo, redeemPromo, customerKeyFor, isLeaguePlayer, leaguePlayerForRequest
} from '../lib/db.js';
import { notifyGiftCard } from '../lib/notify.js';

// One function for the whole gift-card flow (kept single to stay within the Hobby function limit).
// Dispatch on ?action= — list | checkout | confirm | balance | quote | book | reserve | release | redeem.
//
// THE ONE THING TO UNDERSTAND HERE: a gift card is never debited speculatively. demo/index.html
// rebuilds its PaymentIntent on every slot change and every promo apply/remove, abandoning the
// previous one, so debiting at PaymentIntent creation would drain a real card while a customer
// browses. Applying a card takes a RESERVATION with the same 5-minute TTL as the cart hold
// (migration 0020 §3); the debit happens only once Stripe says the payment beside it succeeded.
// The two spending paths are therefore:
//
//   card path   ?action=reserve  → (customer pays)     → ?action=redeem
//   zero-charge ?action=book     — the card covers the whole session, no Stripe involved at all
//
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((e || '').trim());
// Accepts NANP (10 digits, optional leading 1) and international numbers (+ or 00 + country code).
const validPhone = (p) => { const raw = String(p || '').trim(); let d = raw.replace(/\D/g, ''); const intl = raw.startsWith('+') || (d.startsWith('00') && d.length >= 12); if (intl && d.startsWith('00')) d = d.slice(2); return (d.length === 10 && !intl) || (d.length === 11 && d[0] === '1') || (d.length >= 11 && d.length <= 15) || (intl && d.length >= 8 && d.length <= 15); };
// Whoever is asking, for the brute-force throttle. Vercel and most proxies put the real client
// first in x-forwarded-for; fall back to the socket for a direct local request.
const clientIp = (req) => String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '')
  .split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || null;

// The card faces the buyer chooses. Purely presentational — a design changes the artwork on the
// message, never the value — so they live here rather than in the database, exactly as migration
// 0020 §5 says the API supplies these defaults. An operator who wants their own overrides them
// with settings.gift.designs without a deploy.
const DEFAULT_DESIGNS = [
  { id: 'classic',  name: 'Invictus Classic', accent: '#14161A' },
  { id: 'birthday', name: 'Happy Birthday',   accent: '#F0523D' },
  { id: 'holiday',  name: 'Season’s Greetings', accent: '#067647' },
  { id: 'thanks',   name: 'Thank You',        accent: '#4AA3FF' },
];

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || '';
  if (req.method === 'GET' || action === 'list') return list(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (action === 'checkout') return checkout(req, res);
  if (action === 'confirm') return confirm(req, res);
  if (action === 'balance') return balance(req, res);
  if (action === 'quote') return quote(req, res);
  if (action === 'book') return book(req, res);
  if (action === 'reserve') return reserve(req, res);
  if (action === 'release') return release(req, res);
  if (action === 'redeem') return redeem(req, res);
  return res.status(400).json({ error: 'Unknown action' });
}

// GET ?action=list — what can be bought: the designs and the amounts. Public, no customer data.
async function list(_req, res) {
  const row = await getSettings();
  const cfg = giftConfig(row);
  const designs = Array.isArray(row && row.gift && row.gift.designs) && row.gift.designs.length
    ? row.gift.designs : DEFAULT_DESIGNS;
  const { enabled } = stripeStatus(process.env);
  res.status(200).json({
    purchasable: enabled,
    currency: 'cad',
    designs,
    presetsCents: cfg.presetsCents,
    minCents: cfg.minCents,
    maxCents: cfg.maxCents,
    // Manitoba: cards this app issues never expire and carry no fees. See the LEGAL NOTE at the
    // foot of migration 0020 — the levers exist in settings but nothing here turns them on.
    expires: false,
    fees: false,
  });
}

// Shared amount validation for a purchase. Whole dollars only: a $27.43 gift card is a data-entry
// slip, not a product, and the presets are all round numbers.
function validAmount(cents, cfg) {
  const c = Math.round(Number(cents) || 0);
  if (!(c > 0)) return { error: 'Choose an amount for the gift card.' };
  if (c % 100) return { error: 'Gift cards are sold in whole dollars.' };
  if (c < cfg.minCents) return { error: `The smallest gift card is $${(cfg.minCents / 100).toFixed(2)}.` };
  if (c > cfg.maxCents) return { error: `The largest gift card is $${(cfg.maxCents / 100).toFixed(2)}. Call the shop for more.` };
  return { cents: c };
}

// POST ?action=checkout — hosted Stripe Checkout to buy a gift card.
// No card row is created here. The card is minted in ?action=confirm (or by the webhook) against
// the paid session id, so an abandoned checkout leaves nothing behind to sweep.
async function checkout(req, res) {
  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ error: 'Gift cards aren’t available online right now — please call the shop.' });

  const b = req.body || {};
  const row = await getSettings();
  const cfg = giftConfig(row);
  const amt = validAmount(b.amountCents, cfg);
  if (amt.error) return res.status(400).json({ error: amt.error });

  // The buyer's email is not optional: it is the receipt, and it is the fallback delivery address
  // when they are buying the card for themselves.
  if (!validEmail(b.purchaserEmail)) return res.status(400).json({ error: 'A valid email is required for your receipt.' });
  const recipientEmail = (b.recipientEmail || '').trim();
  const recipientPhone = (b.recipientPhone || '').trim();
  if (recipientEmail && !validEmail(recipientEmail)) return res.status(400).json({ error: 'That recipient email doesn’t look right.' });
  if (recipientPhone && !validPhone(recipientPhone)) return res.status(400).json({ error: 'That recipient phone number doesn’t look right.' });

  // Scheduled delivery, at most a year out. A date in the past just means "send it now".
  let deliverAt = null;
  if (b.deliverAt) {
    const t = Date.parse(b.deliverAt);
    if (!Number.isFinite(t)) return res.status(400).json({ error: 'That delivery date doesn’t look right.' });
    if (t > Date.now() + 366 * 86400000) return res.status(400).json({ error: 'Delivery can be scheduled up to a year ahead.' });
    if (t > Date.now()) deliverAt = new Date(t).toISOString();
  }

  const designs = Array.isArray(row && row.gift && row.gift.designs) && row.gift.designs.length ? row.gift.designs : DEFAULT_DESIGNS;
  const design = designs.find((d) => d.id === b.design) || designs[0];
  const settings = normalizeSettings(row);
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const stripe = stripeClient(process.env);

  // Stripe caps a metadata value at 500 characters. Clamp the free-text fields rather than let
  // Stripe reject the whole session over a long gift message.
  const clamp = (s, n) => String(s || '').trim().slice(0, n);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: settings.currency,
          product_data: {
            name: `${design.name} gift card`,
            description: `$${(amt.cents / 100).toFixed(2)} of range time at Invictus Golf — never expires`,
          },
          unit_amount: amt.cents,
        },
        quantity: 1,
      }],
      customer_email: clamp(b.purchaserEmail, 200) || undefined,
      metadata: {
        kind: 'gift',
        amountCents: String(amt.cents),
        design: design.id,
        purchaserName: clamp(b.purchaserName, 120),
        purchaserEmail: clamp(b.purchaserEmail, 200),
        purchaserPhone: clamp(b.purchaserPhone, 40),
        recipientName: clamp(b.recipientName, 120),
        recipientEmail: clamp(recipientEmail, 200),
        recipientPhone: clamp(recipientPhone, 40),
        message: clamp(b.message, 450),
        deliverAt: deliverAt || '',
      },
      success_url: `${origin}/gift-cards?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/gift-cards?canceled=1`,
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('gift checkout:', err.message);
    res.status(400).json({ error: err.message });
  }
}

// POST ?action=confirm — re-verify the paid session, mint the card, and queue its delivery.
//
// Idempotent on the Checkout session id (unique index gift_cards_session): refreshing the success
// page finds the card that already exists rather than minting a second one. THE CODE COMES BACK
// EXACTLY ONCE, on the call that actually created it — a repeat returns { already: true } and no
// code, because nothing anywhere can recover it (only its sha256 is stored).
async function confirm(req, res) {
  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ ok: false, error: 'Stripe not configured' });
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing checkout session.' });

  const stripe = stripeClient(process.env);
  let session;
  try { session = await stripe.checkout.sessions.retrieve(sessionId); }
  catch (_) { return res.status(400).json({ ok: false, error: 'Checkout session not found.' }); }
  if (session.payment_status !== 'paid') return res.status(400).json({ ok: false, error: 'Payment is not complete.' });

  const md = session.metadata || {};
  if (md.kind !== 'gift') return res.status(400).json({ ok: false, error: 'This session is not a gift-card purchase.' });

  // Trust the session's own amount over the metadata — it is what Stripe actually collected.
  const cents = Math.round(Number(session.amount_total) || Number(md.amountCents) || 0);
  if (!(cents > 0)) return res.status(400).json({ ok: false, error: 'That purchase has no amount on it.' });

  const purchaserEmail = md.purchaserEmail || (session.customer_details && session.customer_details.email) || '';
  const r = await createGiftCard({
    amountCents: cents,
    purchaserName: md.purchaserName, purchaserEmail, purchaserPhone: md.purchaserPhone,
    recipientName: md.recipientName, recipientEmail: md.recipientEmail, recipientPhone: md.recipientPhone,
    message: md.message, deliverAt: md.deliverAt || null,
    issuedBy: 'online', ref: session.id,
    paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
    // expires_at is deliberately never set. See the LEGAL NOTE in migration 0020.
  });
  if (r.unsupported) return res.status(503).json({ ok: false, error: 'Gift cards aren’t switched on yet — please call the shop.' });
  if (r.error) return res.status(500).json({ ok: false, error: r.error });

  if (r.already) {
    return res.status(200).json({
      ok: true, already: true, amountCents: r.card.initial_cents, balanceCents: r.card.balance_cents,
      last4: r.card.code_hint || null,
      note: 'This card was already issued and its code emailed — we can’t show it again.',
    });
  }

  // Delivery. Best-effort: the card exists and is spendable whether or not the message goes out.
  const up = await upsertCustomer({ name: md.purchaserName, email: purchaserEmail, phone: md.purchaserPhone });
  await notifyGiftCard({
    cardId: r.card.id, code: r.formattedCode, amountCents: cents,
    purchaserName: md.purchaserName, purchaserEmail, purchaserPhone: md.purchaserPhone,
    recipientName: md.recipientName, recipientEmail: md.recipientEmail, recipientPhone: md.recipientPhone,
    message: md.message, deliverAt: md.deliverAt || null, customerId: up.id || null,
  });
  // Stamp the card as delivered only when there was nothing scheduled — a card queued for a future
  // date has not been delivered yet, and marking it so would hide that from the manager portal.
  if (!md.deliverAt) await markGiftCardDelivered(r.card.id);

  res.status(200).json({
    ok: true, code: r.formattedCode, amountCents: cents, balanceCents: r.card.balance_cents,
    last4: r.card.code_hint || null, deliverAt: md.deliverAt || null,
    sentTo: md.recipientEmail || md.recipientPhone || purchaserEmail || null,
  });
}

// POST ?action=balance — what is on a card, for the code the customer is holding.
// Rate-limited per IP: 80 bits of entropy is not guessable, but a scripted sweep should be
// expensive and visible. Fails OPEN on a database that cannot answer (lib/db.js).
async function balance(req, res) {
  const ip = clientIp(req);
  const { code } = req.body || {};
  if (await giftCardAttemptsBlocked(ip)) {
    return res.status(429).json({ found: false, error: 'Too many tries — wait a few minutes, or call the shop.' });
  }
  const card = await giftCardByCode(code);
  await recordGiftCardAttempt({ ip, codeHint: String(code || '').replace(/[^0-9A-Za-z]/g, ''), ok: !!card });
  if (!card) return res.status(200).json({ found: false });

  const available = await giftCardAvailable(card.id);
  res.status(200).json({
    found: true,
    status: card.status,
    balanceCents: card.balance_cents,
    // What is spendable right now — the balance less anything a checkout in progress is holding.
    availableCents: available,
    last4: card.code_hint || null,
    // Always null on a card this app issued; surfaced so the portal never has to assume.
    expiresAt: card.expires_at || null,
  });
}

// Price + availability for a slot, shared by quote / book / reserve. Throws with a .code for the
// HTTP status. Same checks, in the same order, as api/hour-cards.js.
async function priceSlot({ dateISO, bayId, startMin, endMin }) {
  const row = await getSettings();
  const settings = normalizeSettings(row);
  const overrides = await getOverridesForDate(dateISO);
  const fx = overrideEffects(overrides, settings, dateISO);
  const amount = priceForBooking({ settings, dateISO, bayId, startMin, endMin, dateHours: fx.dateHours });
  if (overrideConflicts(fx, settings, dateISO, bayId, Number(startMin), Number(endMin)) ||
      weeklyStatusConflicts(settings, overrides, dateISO, bayId, Number(startMin), Number(endMin))) {
    throw Object.assign(new Error('That time is unavailable — pick another slot.'), { code: 409 });
  }
  return { row, settings, amount };
}

// The whole waterfall for one slot, with this gift card applied. ONE call to quoteBooking, so
// this agrees with every other booking path by construction rather than by review.
async function quoteFor({ dateISO, bayId, startMin, endMin, email, phone, code, promoCode, partialOnly }) {
  const { row, settings, amount } = await priceSlot({ dateISO, bayId, startMin, endMin });
  const cust = await customerHoursByContact({ email, phone });
  const leaguePlayer = await isLeaguePlayer({ email, phone });

  const card = code ? await giftCardByCode(code) : null;
  const availableCents = card ? await giftCardAvailable(card.id) : 0;
  const promo = promoCode ? await promoByCode(promoCode) : null;

  const q = quoteBooking({
    settings, amountCents: amount, plan: null, todayISO: winnipegTodayISO(), taxPct: taxPctOf(settings),
    giftBalanceCents: availableCents, applyGift: !!card, giftPartialOnly: partialOnly !== false,
    promo,
    promoContext: {
      dateISO, bayId, startMin: Number(startMin), endMin: Number(endMin), leaguePlayer,
    },
  });
  return { row, settings, amount, cust, card, availableCents, quote: q };
}

// POST ?action=quote — what this card is worth against this slot. Reads only; reserves nothing.
// The browser sends a code and a slot and gets back numbers it did not compute.
async function quote(req, res) {
  const b = req.body || {};
  if (!b.code) return res.status(400).json({ ok: false, error: 'Enter a gift-card code.' });
  try {
    const r = await quoteFor({ ...b, partialOnly: b.partialOnly !== false });
    if (!r.card) return res.status(200).json({ ok: false, found: false, error: 'We don’t recognise that gift-card code.' });
    if (r.card.status !== 'active') return res.status(200).json({ ok: false, found: true, error: `That card is ${r.card.status}.` });
    return res.status(200).json({
      ok: true, found: true,
      last4: r.card.code_hint || null,
      balanceCents: r.card.balance_cents,
      availableCents: r.availableCents,
      fullAmountCents: r.quote.fullAmount,
      memberDiscountCents: r.quote.memberDiscountCents,
      promoDiscountCents: r.quote.promoDiscountCents,
      giftUsedCents: r.quote.giftUsedCents,
      chargeCents: r.quote.charge,
      coversWholeBooking: r.quote.charge === 0,
    });
  } catch (e) {
    return res.status(e.code || 400).json({ ok: false, error: e.message });
  }
}

// POST ?action=book — the zero-charge path: the card covers the whole session and Stripe is never
// involved. This is the one redemption path that needs no PaymentIntent, and it debits directly
// (bookWithGiftCard) rather than reserving, because there is no payment to wait for.
async function book(req, res) {
  const b = req.body || {};
  if (!b.code) return res.status(400).json({ ok: false, error: 'Enter a gift-card code.' });
  const tooFar = bookingWindowError({ settings: normalizeSettings(await getSettings()), dateISO: b.dateISO,
    league: await leaguePlayerForRequest(req) });
  if (tooFar) return res.status(400).json({ ok: false, error: tooFar, code: 'booking_window' });
  let r;
  try {
    // partialOnly:false — no Stripe charge has to remain here, so a card that covers everything
    // should cover everything.
    r = await quoteFor({ ...b, partialOnly: false });
  } catch (e) {
    return res.status(e.code || 400).json({ ok: false, error: e.message });
  }
  if (!r.card) return res.status(400).json({ ok: false, error: 'We don’t recognise that gift-card code.' });
  if (r.card.status !== 'active') return res.status(400).json({ ok: false, error: `That card is ${r.card.status}.` });
  if (r.quote.charge > 0) {
    return res.status(400).json({
      ok: false, error: 'insufficient',
      shortfallCents: r.quote.charge, availableCents: r.availableCents,
      message: 'That card doesn’t cover the whole booking — pay the difference by card.',
    });
  }

  // Re-check the slot immediately before spending. bookWithGiftCard credits the card back if the
  // insert loses a race, but not clashing in the first place is cheaper and clearer.
  const clash = (await getBookingsForDate(b.dateISO))
    .some((x) => x.bay_id === b.bayId && Number(b.startMin) < x.end_min && Number(b.endMin) > x.start_min);
  if (clash) return res.status(409).json({ ok: false, error: 'That time was just taken — pick another slot.' });

  // A promo code applied on this path has to be COUNTED on this path. Without this, a code that
  // reduced the price of a gift-card-covered booking would never touch promo_redemptions, so its
  // "one per customer" and "50 uses total" limits would not bind here at all — the discount would
  // be free and unlimited on the one booking path that needs no payment. Reserve before spending,
  // release if the booking fails, redeem once it is saved.
  const promoRef = `book:${b.dateISO}:${b.bayId}:${b.startMin}-${b.endMin}`;
  let promoReservationId = null;
  if (r.quote.promoDiscountCents > 0 && r.quote.promoCode) {
    const key = customerKeyFor({ email: b.email, phone: b.phone });
    if (!key) return res.status(400).json({ ok: false, error: 'Enter your phone number or email to use a code.' });
    const pr = await reservePromo({
      code: r.quote.promoCode, customerKey: key, customerId: (r.cust && r.cust.id) || null,
      discountCents: r.quote.promoDiscountCents, ttlSeconds: 300, ref: promoRef,
    });
    if (pr.reason) return res.status(200).json({ ok: false, reason: pr.reason, error: 'That code can’t be used on this booking.' });
    if (pr.error) return res.status(500).json({ ok: false, error: pr.error });
    promoReservationId = pr.reservationId;
  }

  const out = await bookWithGiftCard({
    dateISO: b.dateISO, bayId: b.bayId, startMin: b.startMin, endMin: b.endMin,
    name: b.name, email: b.email, phone: b.phone,
    cardId: r.card.id, amountCents: r.quote.giftUsedCents,
    statusLabel: r.settings.onlineStatusLabel || 'Booked',
  });
  if (out.error && promoReservationId) await releasePromo(promoReservationId);   // nothing was booked
  if (out.error === 'insufficient') return res.status(400).json({ ok: false, error: 'insufficient', availableCents: r.availableCents });
  if (out.error === 'expired' || out.error === 'inactive') return res.status(400).json({ ok: false, error: `That card is ${out.error}.` });
  if (out.error === 'duplicate') return res.status(409).json({ ok: false, error: 'That booking was already made.' });
  if (out.error === 'taken') return res.status(409).json({ ok: false, error: 'That time was just taken — pick another slot.' });
  if (out.error === 'unsupported') return res.status(503).json({ ok: false, error: 'Gift cards aren’t switched on yet — please call the shop.' });
  if (out.error) return res.status(500).json({ ok: false, error: out.error });

  if (promoReservationId) {
    await redeemPromo({ reservationId: promoReservationId, bookingId: out.bookingId || null, ref: promoRef });
  }
  res.status(200).json({
    ok: true, balanceCents: out.balance, bookingId: out.bookingId || null,
    spentCents: r.quote.giftUsedCents, promoDiscountCents: r.quote.promoDiscountCents,
  });
}

// POST ?action=reserve — apply a card to a PaymentIntent that already exists.
//
// The reservation's expected_charge_cents is taken from STRIPE, not from the browser, and the
// PaymentIntent's amount is checked against a fresh server-side quote first. That check is what
// makes the whole scheme safe: if the PaymentIntent was built without this gift card applied, its
// amount is the undiscounted price, we refuse here, and the customer is never both charged in full
// and debited. (Settlement re-checks the same thing in redeem_gift_card as a second rail.)
async function reserve(req, res) {
  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ ok: false, error: 'Stripe not configured' });
  const b = req.body || {};
  if (!b.code) return res.status(400).json({ ok: false, error: 'Enter a gift-card code.' });
  if (!b.paymentIntentId) return res.status(400).json({ ok: false, error: 'Missing payment reference.' });

  const stripe = stripeClient(process.env);
  let pi;
  try { pi = await stripe.paymentIntents.retrieve(b.paymentIntentId); }
  catch (_) { return res.status(400).json({ ok: false, error: 'Payment not found.' }); }
  if (pi.status === 'succeeded' || pi.status === 'canceled') {
    return res.status(409).json({ ok: false, error: 'That payment is already finished.' });
  }

  // The slot is read off the PaymentIntent's own metadata, never off the request body — the
  // browser does not get to tell the server what it is paying for.
  const md = pi.metadata || {};
  if (!md.dateISO || !md.bayId) return res.status(400).json({ ok: false, error: 'Booking details missing on the payment.' });

  let r;
  try {
    r = await quoteFor({
      dateISO: md.dateISO, bayId: md.bayId, startMin: Number(md.startMin), endMin: Number(md.endMin),
      email: b.email, phone: b.phone,
      code: b.code, promoCode: md.promoCode || b.promoCode, partialOnly: true,
    });
  } catch (e) {
    return res.status(e.code || 400).json({ ok: false, error: e.message });
  }
  if (!r.card) return res.status(400).json({ ok: false, error: 'We don’t recognise that gift-card code.' });
  if (r.card.status !== 'active') return res.status(400).json({ ok: false, error: `That card is ${r.card.status}.` });
  if (!(r.quote.giftUsedCents > 0)) {
    return res.status(400).json({ ok: false, error: 'There is nothing left on that card to apply.' });
  }

  if (pi.amount !== r.quote.charge) {
    // The loud failure the design depends on: this PaymentIntent was not built with the gift card
    // applied, so spending the card against it would charge the customer twice over. Refuse, and
    // tell the caller to rebuild the payment.
    console.warn(`gift reserve: PaymentIntent ${pi.id} is ${pi.amount}¢ but the gift-applied quote is ${r.quote.charge}¢ — refusing to reserve.`);
    return res.status(409).json({
      ok: false, error: 'stale_payment',
      chargeCents: r.quote.charge, paymentAmountCents: pi.amount,
      message: 'Your total changed — reopening the payment.',
    });
  }

  const out = await reserveGiftCard({
    cardId: r.card.id, amountCents: r.quote.giftUsedCents, ref: pi.id,
    expectedChargeCents: r.quote.charge, ttlSeconds: 300,   // matches HOLD_MINUTES in lib/db.js
  });
  if (out.unsupported) return res.status(503).json({ ok: false, error: 'Gift cards aren’t switched on yet — please call the shop.' });
  if (out.error) return res.status(400).json({ ok: false, error: out.error });

  res.status(200).json({
    ok: true, reservedCents: out.reserved || 0, availableCents: out.available || 0,
    expiresAt: out.expiresAt || null, chargeCents: r.quote.charge, last4: r.card.code_hint || null,
  });
}

// POST ?action=release — give the claim back (checkout closed, card removed, slot changed).
// Best-effort and always 200: the caller is usually a beacon from a closing tab, and the 5-minute
// TTL is the real backstop.
async function release(req, res) {
  const b = req.body || {};
  if (!b.paymentIntentId) return res.status(200).json({ ok: true, released: 0 });
  // By code when the browser still has it, otherwise everything held against this payment.
  const card = b.code ? await giftCardByCode(b.code) : null;
  if (card) {
    const out = await releaseGiftCard({ cardId: card.id, ref: b.paymentIntentId });
    return res.status(200).json({ ok: true, released: out.released });
  }
  let released = 0;
  for (const r of await giftCardReservationsForRef(b.paymentIntentId)) {
    const out = await releaseGiftCard({ cardId: r.gift_card_id, ref: b.paymentIntentId });
    released += out.released;
  }
  res.status(200).json({ ok: true, released });
}

// POST ?action=redeem — settle: turn the reservation into a real debit, once Stripe says the
// payment beside it actually succeeded.
//
// Safe to expose publicly. It re-verifies the PaymentIntent with Stripe, and it can only ever
// spend a reservation the server itself created against that exact payment; redeem_gift_card
// refuses if the amount charged is not the amount the reservation was quoted against, and the
// ledger's (gift_card_id, ref) unique index makes a second call a no-op. That is what lets the
// client-side confirm and a Stripe webhook both call this, which is how this repo already
// double-covers booking confirmation.
//
// The card CODE is not required: settlement finds the reservations by payment id, because the
// server never stores a code and the webhook would not have one.
async function redeem(req, res) {
  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ ok: false, error: 'Stripe not configured' });
  const b = req.body || {};
  if (!b.paymentIntentId) return res.status(400).json({ ok: false, error: 'Missing payment reference.' });

  const stripe = stripeClient(process.env);
  let pi;
  try { pi = await stripe.paymentIntents.retrieve(b.paymentIntentId); }
  catch (_) { return res.status(400).json({ ok: false, error: 'Payment not found.' }); }
  if (pi.status !== 'succeeded') return res.status(400).json({ ok: false, error: 'Payment is not complete.' });

  const reservations = await giftCardReservationsForRef(pi.id);
  if (!reservations.length) {
    // Nothing held against this payment: either no card was applied, or this is the second caller
    // and the first already settled. Both are success — the ledger is the authority, not us.
    return res.status(200).json({ ok: true, redeemedCents: 0, cards: 0 });
  }

  let redeemedCents = 0, already = 0;
  const results = [];
  for (const r of reservations) {
    const out = await redeemGiftCard({
      cardId: r.gift_card_id, ref: pi.id, chargedCents: pi.amount,
      bookingId: b.bookingId || r.booking_id || null,
      note: (pi.metadata && pi.metadata.dateISO) ? `Booking ${pi.metadata.dateISO}` : 'Booking',
    });
    if (out.already) { already += 1; results.push({ already: true, balanceCents: out.balance }); continue; }
    if (out.error) { console.warn(`gift redeem (${pi.id}):`, out.error); results.push({ error: out.error }); continue; }
    redeemedCents += Number(out.redeemed) || 0;
    results.push({ redeemedCents: out.redeemed, balanceCents: out.balance });
  }
  res.status(200).json({ ok: true, redeemedCents, already, cards: reservations.length, results });
}
