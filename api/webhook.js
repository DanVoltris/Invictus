import { stripeStatus, stripeClient, normalizeSettings } from '../lib/booking.js';
import { insertBooking, getSettings, confirmHold, upsertCustomer, bookingByPaymentIntent, setPaymentState,
         redeemGiftCard, redeemPromo, confirmLeagueCheckout, confirmLeagueTeamCheckout,
  recordStripeEvent, forgetStripeEvent } from '../lib/db.js';
import { notifyBookingConfirmed } from '../lib/notify.js';
import { applyChargeRefunded } from '../lib/refunds.js';
import { paymentPatchFor, releaseUnbookedHold } from '../lib/holds.js';

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Source of truth: only record a confirmed booking here, never on the client redirect — and the
// only place a refund issued OUTSIDE this app (the Stripe dashboard) gets written down.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(200).json({ received: true });

  // Every event must be signed. Without the secret there is no way to tell Stripe from anyone
  // else who can reach this URL, and an unsigned payment_intent.succeeded would mint a paid
  // booking for free — so refuse outright. 503 (not 400) because it is our misconfiguration:
  // Stripe keeps retrying, and the retries succeed once the secret is set.
  const whsec = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whsec) {
    console.error('Webhook refused: STRIPE_WEBHOOK_SECRET is not set. Add the endpoint in the Stripe '
      + 'dashboard (Developers → Webhooks) and copy its signing secret (whsec_…) into the environment.');
    return res.status(503).json({ error: 'Webhook signing secret not configured.' });
  }

  const stripe = stripeClient(process.env);
  let event;
  try {
    // The signature covers the exact bytes Stripe sent, never a re-serialised object.
    // - Local dev mounts this behind express.raw(), which hands us a Buffer and leaves the request
    //   stream drained — readRaw() would never resolve, so always prefer the Buffer when there is one.
    // - On Vercel, req.body is a lazy getter that JSON-parses (an object, not a Buffer), and the
    //   runtime replays the original bytes to req.on('data'/'end'), so readRaw() gets them intact.
    //   (`config.api.bodyParser` is a Next.js option; plain Vercel functions ignore it.)
    // Inside the try because that getter throws on malformed JSON — which is just another bad request.
    const buf = req.body && Buffer.isBuffer(req.body) ? req.body : null;
    event = stripe.webhooks.constructEvent(buf || await readRaw(req), req.headers['stripe-signature'], whsec);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // stripeStatus() only enables Stripe on test keys, so a genuine event here is always test mode.
  // A signed livemode event means a live endpoint's secret is configured against test keys —
  // acknowledge it (so Stripe stops retrying) but never fulfil a live payment on this prototype.
  if (event.livemode) {
    console.error(`Webhook ${event.id} ignored: livemode event received while running on test keys.`);
    return res.status(200).json({ received: true, ignored: 'livemode' });
  }

  // Global idempotency. Stripe retries until it gets a 2xx and can also deliver the same event
  // twice on purpose, so claim the event id before doing any work: a duplicate delivery loses the
  // insert with a unique violation and is acknowledged without repeating the fulfilment. This sits
  // ALONGSIDE bookingExistsForPI rather than replacing it — the client-side confirm path doesn't
  // go through here at all, and a database still on migration 0017 has no stripe_events table, in
  // which case this reports unsupported and the per-booking guard carries the load on its own.
  const claim = await recordStripeEvent(event.id);
  if (claim.duplicate) {
    console.log(`↩︎ Webhook ${event.id} already handled — skipping.`);
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    await fulfil(event, stripe);
  } catch (err) {
    // The claim is only valid if the work behind it finished. Release it so Stripe's retry is
    // treated as a first attempt instead of a duplicate of an attempt that never completed.
    if (claim.recorded) await forgetStripeEvent(event.id);
    console.error('Webhook fulfilment failed:', err && err.message ? err.message : err);
    return res.status(500).json({ received: false });
  }
  res.status(200).json({ received: true });
}

// Everything a successful payment causes: the booking row, the customer, the gift-card and promo
// settlements, and the confirmation message. Split out of the handler so a failure anywhere in it can release the
// event claim above.
async function fulfil(event, stripe) {
  const sessionKind = event.type === 'checkout.session.completed'
    ? ((event.data.object || {}).metadata || {}).kind : null;

  // A captain paying for a whole team (migration 0031). Backup for the success page, exactly like
  // the per-player sign-up below: confirmLeagueTeamCheckout re-reads the session from Stripe, and
  // league_teams.stripe_session_id is unique, so a replayed event cannot create a second team.
  if (sessionKind === 'league-team') {
    const r = await confirmLeagueTeamCheckout(stripe, event.data.object.id);
    if (r.error && r.retry) throw new Error(`league team not saved: ${r.error}`);   // 500 → Stripe retries
    if (r.error) console.warn('⚠ League team ignored:', r.error);
    else console.log(`✅ League team saved — ${(r.team && r.team.name) || r.teamId}${r.already ? ' (already there)' : ''}`);
    return;
  }

  // A paid league sign-up (api/leagues.js). Backup for the success page: a player who pays and
  // closes the tab still lands on the roster. confirmLeagueCheckout re-reads the session from
  // Stripe, so the event body itself is never trusted.
  if (sessionKind === 'league') {
    const r = await confirmLeagueCheckout(stripe, event.data.object.id);
    if (r.error && r.retry) throw new Error(`league sign-up not saved: ${r.error}`);   // 500 → Stripe retries
    if (r.error) console.warn('⚠ League sign-up ignored:', r.error);
    else console.log(`✅ League sign-up saved — ${r.league && r.league.name}${r.already ? ' (already on roster)' : ''}`);
    return;
  }
  // A refund. Two different things arrive as the same event and both matter:
  //   · somebody refunded a booking from the STRIPE DASHBOARD — nothing in this app knows about it,
  //     so refunded_cents would stay at zero and the portal would happily refund it a second time;
  //   · a refund WE issued reaching its final state, which is how our own rows settle to
  //     'succeeded' when the payment method settles later than the API call returned.
  // applyChargeRefunded tells them apart by the Stripe refund id and records only what is missing.
  // It throws nothing it can help: a booking it cannot find is logged, not failed, because Stripe
  // would retry forever over a gift-card purchase that was never in this ledger.
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const { results } = await applyChargeRefunded({ stripe, charge });
    for (const r of results) {
      if (r.error) throw new Error(`refund not recorded: ${r.error}`);     // 500 → Stripe retries
      if (r.recorded) console.log(`✅ Refund ${r.stripeRefundId || ''} recorded from Stripe — booking ${r.bookingId}`);
      else if (r.ours) console.log(`✅ Refund settled to ${r.status}${r.attached ? ' (attached to the pending record)' : ''}`);
    }
    return;
  }

  // ⚠ THE EVENT THAT MAKES CARD HOLDS WORK AT ALL, and the trap this whole change turns on.
  //
  // A booking row has always been written when payment_intent.succeeded arrived. With
  // capture_method: 'manual' that event DOES NOT FIRE at checkout — it fires when a member of staff
  // captures, which may be days later, or never. So a held booking would never be recorded: no
  // booking, no confirmation, and the tee sheet showing the slot free for somebody else to buy,
  // while the customer's card sat authorised for the amount.
  //
  // payment_intent.amount_capturable_updated is Stripe's "the authorisation landed" event, and it
  // is the moment a HELD booking becomes real. Stripe documents it in exactly those terms: "when a
  // customer completes the payment process on a PaymentIntent with manual capture, it triggers the
  // payment_intent.amount_capturable_updated event".
  //
  // The two events split the job cleanly and stay double-covered with the client-side confirm:
  //   amount_capturable_updated  → the booking exists, payment_state 'held', nothing charged
  //   succeeded                  → the money moved. Either a far-ahead booking charged in full at
  //                                checkout (unchanged), or the capture of a hold already written
  //                                down, which only needs settling to 'paid'.
  if (event.type === 'payment_intent.amount_capturable_updated' || event.type === 'payment_intent.succeeded') {
    await recordPaidOrHeldBooking(event, stripe);
  }
}

// One PaymentIntent reaching a state that means something, written down. Shared by both events
// above because a held booking and a charged one differ in exactly one thing — where the money is —
// and that difference lives entirely in paymentPatchFor().
async function recordPaidOrHeldBooking(event, stripe) {
  const pi = event.data.object;
  const md = pi.metadata || {};
  if (!md.dateISO || !md.bayId) return;
  const held = pi.status === 'requires_capture' || event.type === 'payment_intent.amount_capturable_updated';

  // Pull the customer's contact info from the charge's billing details. The charge also carries
  // capture_before — the card network's own authorisation deadline — which paymentPatchFor prefers
  // over the estimate the checkout wrote into the metadata.
  let name = null, email = pi.receipt_email || null, phone = null, charge = null;
  try {
    if (pi.latest_charge) {
      charge = await stripe.charges.retrieve(pi.latest_charge);
      const bd = charge.billing_details || {};
      name = bd.name || null;
      email = email || bd.email || null;
      phone = bd.phone || null;
    }
  } catch (_) { /* best-effort */ }

  const money = paymentPatchFor({ pi, charge });

  // The client-side confirm usually saved this already — the webhook is the backup path. For a
  // HELD booking there is a second, ordinary reason to land here: the row was written at
  // authorisation and this is the capture arriving days later. That is not a duplicate to skip; it
  // is the moment the money actually moved, and if our own capture endpoint did not manage to write
  // it down (or a manager captured from the Stripe dashboard instead), this is what puts the
  // booking right. Idempotent: settling 'paid' to 'paid' updates nothing.
  const existing0 = await bookingByPaymentIntent(pi.id);
  // A CANCELLED row for this PaymentIntent is not "already saved" — it is a booking that was
  // cancelled and refunded or released. bookingExistsForPI() has always excluded those, and this
  // keeps that exact rule rather than quietly changing it.
  const existing = existing0 && existing0.status !== 'cancelled' ? existing0 : null;
  if (existing) {
    if (!held && existing.payment_state === 'held') {
      await setPaymentState({ bookingId: existing.id, state: 'paid', expect: 'held',
        patch: { amount_cents: money.amount_cents, captured_at: money.captured_at } });
      console.log(`✅ Hold captured (from Stripe) — booking ${existing.id}, ${money.amount_cents} cents`);
    }
    return;
  }

  const settings = normalizeSettings(await getSettings());
  const slot = { dateISO: md.dateISO, bayId: md.bayId, startMin: Number(md.startMin), endMin: Number(md.endMin) };
  const patch = {
    status_label: settings.onlineStatusLabel || null,   // workflow label for a self-booked online reservation
    customer_name: name,
    customer_email: email,
    customer_phone: phone,
    stripe_payment_intent: pi.id,
    source: 'online',
    ...money,     // amount_cents (0 while held), authorized_cents, hold_expires_at, captured_at
  };
  // Prefer flipping the customer's live cart hold → confirmed; fall back to a fresh insert if it
  // lapsed. NOTE the two senses of "hold" that meet here and are not the same thing: `status:
  // 'held'` is the five-minute CART lock on the slot, and payment_state 'held' is the money.
  const flip = await confirmHold({ ...slot, patch });
  let error = flip.error || null;
  let bookingId = flip.id;
  if (!flip.updated) {
    const ins = await insertBooking({ bay_id: slot.bayId, booking_date: slot.dateISO, start_min: slot.startMin, end_min: slot.endMin, status: 'confirmed', ...patch });
    error = ins.error;
    bookingId = ins.id;
    // Slot taken and the card only held: nothing else will ever release it (see lib/holds.js).
    if (ins.conflict && held) await releaseUnbookedHold({ stripe, pi });
  }
  console.log(error
    ? `⚠ Booking save failed (${md.summary}): ${error}`
    : `✅ Booking ${held ? 'HELD' : 'PAID'} & saved — ${md.bayName} · ${md.summary}`);
  // Save the booker into the customer database (contact only; the SMS toggle is set at pay time).
  const up = await upsertCustomer({ name, email, phone });
  // Loyalty points are retired: no balance is spent or earned when a payment lands.

  // Gift card and promo are settled HERE, not only in the browser. Previously the sole caller
  // of either redemption was demo/index.html after the Stripe confirm resolved, so a customer
  // whose tab died between "payment succeeded" and that call still got the booking (this
  // webhook writes it) while the gift-card reservation quietly lapsed and the balance was
  // restored in full — paid less AND kept the card. Same for a promo's redemption count.
  //
  // Both are idempotent, so the browser calling them too is harmless: redeem_gift_card keys on
  // the PaymentIntent id, and redeem_promo on the reservation, which can only be spent once.
  //
  // They settle at AUTHORISATION, not at capture, and on purpose: a reservation that is not spent
  // lapses and hands the balance back, so waiting for a capture that might be five days away would
  // give the customer their discount AND their gift-card balance back for those five days.
  const giftUsed = Number(md.giftUsedCents) || 0;
  if (!error && giftUsed > 0 && md.giftCardId) {
    const r = await redeemGiftCard({
      cardId: md.giftCardId, ref: pi.id, chargedCents: giftUsed, bookingId,
      note: `Booking ${slot.dateISO}`,
    });
    if (r && r.error) console.error(`⚠ gift card ${md.giftCardId} not settled for ${pi.id}: ${r.error}`);
  }
  if (!error && md.promoReservationId) {
    const r = await redeemPromo({ reservationId: md.promoReservationId, bookingId, ref: pi.id });
    if (r && r.error) console.error(`⚠ promo reservation ${md.promoReservationId} not settled for ${pi.id}: ${r.error}`);
  }
  // Tell the customer. Queued in the outbox keyed on the booking, so the client-side confirm
  // enqueuing the same receipt cannot produce a second one; delivery is best-effort and can
  // never fail a payment that has already been taken (see lib/notify.js).
  if (!error) {
    await notifyBookingConfirmed({
      bookingId, dateISO: slot.dateISO, bayId: slot.bayId, bayName: md.bayName,
      startMin: slot.startMin, endMin: slot.endMin, players: Number(md.players) || null,
      amountCents: pi.amount, name, email, phone, customerId: up.id || null,
    });
  }
}
