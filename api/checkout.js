import { priceForBooking, summaryFor, stripeStatus, stripeClient, normalizeSettings, bayName, overrideEffects, overrideConflicts, weeklyStatusConflicts, quoteBooking, taxPctOf, winnipegTodayISO, bookingWindowError, holdPlan, leagueRoundDiscountCents, leagueRoundTaken, holdChangesEnabled, HOLD_KEEPS_CARD_MESSAGE } from '../lib/booking.js';
import { getSettings, getBookingsForDate, getOverridesForDate, createHold, promoByCode, giftCardByCode, giftCardAvailable, leaguePlayerForRequest,
         confirmHold, insertBooking, upsertCustomer, bookingExistsForPI, setCustomerNote, recordConsent, clientIp,
         releaseHold, deferredHoldsReady, bookingExistsForSetupIntent, stripeCustomerForContact,
         rememberStripeCustomer, crossDayProblem, accountCustomerForRequest, teamMembershipFor, leagueRoundTarget, teamMoneyFor } from '../lib/db.js';
import { paymentPatchFor, releaseUnbookedHold, savedCardPatchFor, forgetSavedCard } from '../lib/holds.js';
import { notifyBookingConfirmed } from '../lib/notify.js';

// One customer checkout, start to finish. Dispatch on ?action=, the same shape as
// api/gift-cards.js, api/leagues.js and api/waitlist.js:
//
//   create-payment-intent  POST   price the slot, hold it, and open a PaymentIntent
//   confirm-booking        POST   the payment succeeded — turn the hold into a real booking
//   release-hold           POST   checkout was closed before paying — give the slot back
//
// WHY THESE THREE SHARE A FILE. Vercel's Hobby plan allows 12 Serverless Functions and api/ held
// 16, so the project could not deploy at all. These three are the single flow one customer walks
// through in one sitting — price, pay, or walk away — so they cost one slot between them instead
// of three. Nothing about any of the three answers changed.
//
// THE OLD URLS ARE UNCHANGED. /api/create-payment-intent, /api/confirm-booking and
// /api/release-hold still work: vercel.json rewrites each onto this file with the right ?action=,
// and server.js mounts the same three paths on the same dispatcher below. Stripe's success URLs,
// demo/index.html and anything else pointing at the old paths keep working untouched.
//
// Each section below keeps its OWN method check, so an old path answers a GET exactly as its own
// file used to — the three did not agree on the shape of that 405 and this is not the place to
// start changing answers.

// Which of the three is being asked for. Normally ?action=, set by the rewrite. `forced` is how
// server.js names the action for a path it mounts directly — Vercel only ever passes (req, res),
// so the default applies there.
const ACTIONS = ['create-payment-intent', 'confirm-booking', 'release-hold'];
export default async function handler(req, res, forced) {
  const action = forced || actionOf(req, ACTIONS);
  if (action === 'create-payment-intent') return createPaymentIntent(req, res);
  if (action === 'confirm-booking') return confirmBooking(req, res);
  if (action === 'release-hold') return releaseHoldAction(req, res);
  return res.status(400).json({ error: 'Unknown action' });
}

// A rewrite MERGES the incoming query string with the destination's, so if a caller ever sent its
// own ?action= to one of the old paths the key arrives twice, as an array. Pick the first value
// this file actually recognises rather than whichever end happened to win.
function actionOf(req, known) {
  const raw = (req.query && req.query.action);
  const list = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v == null ? '' : v));
  return list.find((v) => known.includes(v)) || list[0] || '';
}

// ---- ?action=create-payment-intent (was api/create-payment-intent.js) -------------------
// Creates a PaymentIntent for a booking. Price + availability are validated server-side.
export async function createPaymentIntent(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ error: 'Stripe not configured' });

  try {
    const stripe = stripeClient(process.env);
    const { dateISO, bayId, startMin, endMin, party, hold, email, phone,
            promoCode, giftCode, promoReservationId, teamId } = req.body || {};

    const settings = normalizeSettings(await getSettings());
    // How far ahead this customer may book: further for league players (migration 0028).
    const leaguePlayer = await leaguePlayerForRequest(req);
    const tooFar = bookingWindowError({ settings, dateISO, league: leaguePlayer });
    if (tooFar) return res.status(400).json({ error: tooFar, code: 'booking_window' });
    const overrides = await getOverridesForDate(dateISO);
    // Resolve schedule overrides up front: dateHours lets priceForBooking accept widened
    // special hours; overrideConflicts rejects blocked/closed slots.
    const fx = overrideEffects(overrides, settings, dateISO);
    const amount = priceForBooking({ settings, dateISO, bayId, startMin, endMin, dateHours: fx.dateHours });
    const players = Math.min(Math.max(parseInt(party, 10) || 1, 1), settings.maxParty);

    // Reject if the slot is really taken (confirmed booking / manager block). Cart holds are handled
    // by createHold below — its atomic insert is the real guard, so they don't count here.
    const conflict = (await getBookingsForDate(dateISO))
      .some((b) => b.status !== 'held' && b.bay_id === bayId && Number(startMin) < b.end_min && Number(endMin) > b.start_min);
    if (conflict) return res.status(409).json({ error: 'That time was just booked — pick another slot.' });

    if (overrideConflicts(fx, settings, dateISO, bayId, Number(startMin), Number(endMin)) ||
        weeklyStatusConflicts(settings, overrides, dateISO, bayId, Number(startMin), Number(endMin))) {
      return res.status(409).json({ error: 'That time is unavailable — pick another slot.' });
    }
    // Past midnight (0038): the next day's closures, and last night's late sessions still in the bay.
    const spill = await crossDayProblem({ settings, dateISO, bayId, startMin, endMin });
    if (spill) return res.status(409).json({ error: spill.error });

    // A TEAM'S LEAGUE ROUND (teamId). League teams pay for their bay time like anyone else; what
    // makes this booking the team's round for the week is the tag, and what it earns is so much an
    // hour off. Everything is proven here, before the slot is held and before Stripe is asked for
    // anything — who is asking (the signed-in account, never a name in the body), that they are on
    // the team, that the date is in the season, and that the team has not already played this week
    // — so nobody pays for a round the database would then refuse to count.
    let leagueRound = null;
    if (teamId) {
      const me = await accountCustomerForRequest(req);
      if (!me) return res.status(401).json({ error: 'Sign in to book your team’s league round.', code: 'sign_in' });
      const m = await teamMembershipFor({ teamId: String(teamId), customerId: me.id });
      if (!m || !m.team || !m.league) return res.status(404).json({ error: 'That team isn’t in a league any more.', code: 'no_team' });
      if (!m.member) {
        return res.status(403).json({ code: 'not_on_team', error: m.sub
          ? `You’re a substitute for ${m.team.name}, and the league round is booked by one of the team’s players. Book this as an ordinary session, or ask the captain to book the round.`
          : 'You’re not on that team, so you can’t book its league round.' });
      }
      const lg = m.league;
      if ((lg.season_start && dateISO < lg.season_start) || (lg.season_end && dateISO > lg.season_end)) {
        return res.status(400).json({ code: 'outside_season',
          error: `${lg.name} runs ${lg.season_start || '…'} to ${lg.season_end || '…'}, so that date can’t be a league round. Book it as an ordinary session, or pick a date in the season.` });
      }
      // The league's own rules, each one switched on by the manager on the league form
      // (InvictusLeagues.leagueDates): fees paid before the first round, and the season deadline.
      const L = globalThis.InvictusLeagues, rules = L.leagueDates(lg);
      if (rules.feesFirst) {
        const found = await teamMoneyFor(m.team.id);
        const money = found && found.money;
        const owed = money && money.split ? money.owedCents : ((lg.fee_cents > 0 && !(m.team.paid_cents > 0)) ? lg.fee_cents : 0);
        if (owed > 0) {
          return res.status(403).json({ code: 'fees_unpaid',
            error: `${m.team.name} still has $${(owed / 100).toFixed(2)} of its league fee to pay, and the fee has to be paid in full before the team’s first league round. Pay it on My Account or at the desk, then book your round. You can still book this as an ordinary session.` });
        }
      }
      // Rounds are played in order: this booking counts for the earliest week the team has not
      // played — a missed week first — and for nothing once the regular-season deadline has passed.
      const target = await leagueRoundTarget(m.team.id, dateISO, lg);
      if (!target.ok && target.code === 'after_deadline') {
        return res.status(400).json({ code: 'after_deadline',
          error: `${lg.name}’s regular season ended on ${target.regularEnd}, and rounds after that date do not count`
            + `${target.playoffsStart ? ` (playoffs start ${target.playoffsStart})` : ''}. Book this as an ordinary session.` });
      }
      if (!target.ok && target.existing) return res.status(409).json(leagueRoundTaken(settings, m.team, target.existing, target));
      if (!target.ok) return res.status(400).json({ code: 'outside_season', error: `That date is not in ${lg.name}’s season, so it can’t be a league round.` });
      leagueRound = { team: m.team, league: lg, week: target.week, makeup: !!target.makeup,
        discountCents: leagueRoundDiscountCents({ settings, startMin, endMin }) };
    }

    // Cart hold: lock the slot for ~5 min while the customer checks out (see lib/db.js createHold).
    let expiresAt = null;
    if (hold) {
      const h = await createHold({ dateISO, bayId, startMin: Number(startMin), endMin: Number(endMin) });
      if (h.conflict) return res.status(409).json({ error: 'That time was just taken — pick another slot.' });
      if (h.error) return res.status(500).json({ error: h.error });
      expiresAt = h.expiresAt;
    }

    // Promo code and gift card. The browser sends these; until now this handler destructured
    // neither, so quoteBooking() never saw them and the card was charged the undiscounted price
    // while /api/promos and /api/gift-cards quoted a lower one. Three answers, one of them the
    // one that actually took the money.
    //
    // Both are looked up server-side from the code alone — the browser sends a string, never an
    // amount. An unknown or exhausted code is simply not applied; it is not an error, because the
    // customer must still be able to pay. What was applied comes back in the response and in the
    // PaymentIntent metadata, so the client shows the same figure the card is charged and the
    // webhook can settle it (see api/webhook.js fulfil()).
    const promo = promoCode ? await promoByCode(String(promoCode)) : null;
    const giftCard = giftCode ? await giftCardByCode(String(giftCode)) : null;
    const giftBalanceCents = giftCard ? await giftCardAvailable(giftCard.id) : 0;

    const q = quoteBooking({
      settings, amountCents: amount, plan: null,   // memberships retired (0028): leagues carry no discount
      todayISO: winnipegTodayISO(),                // loyalty points retired: no stage for them here
      promo,
      promoContext: {
        dateISO, bayId, startMin: Number(startMin), endMin: Number(endMin),
        leaguePlayer,
      },
      giftBalanceCents, applyGift: !!giftCard,
      taxPct: taxPctOf(settings),                  // sales tax on top, from Payment Settings
      leagueDiscountCents: leagueRound ? leagueRound.discountCents : 0,
    });
    const charge = q.charge;

    // Saved cards (migration 0029) are retired: no Stripe Customer is created or attached here,
    // and no Customer Session is opened, so customers.stripe_customer_id is never read. Apple Pay
    // and Google Pay are unaffected — they come from automatic_payment_methods below, which has
    // nothing to do with a Customer.
    // HOLD OR CHARGE. The Payment Settings screen has always claimed "Capture method: Credit Card
    // Hold" while every booking was captured on the spot. holdPlan() is what makes it true, and it
    // is a DATE question, not a preference: a card authorisation lasts about seven days (Stripe's
    // documented windows are in lib/booking.js), the booking window is 10 days — 60 for league
    // players — so a session further ahead than settings.pay.hold.cutoffDays cannot be held at
    // checkout. Since migration 0035 its card is SAVED instead ('save'): nothing is charged, and the
    // server holds it leadDays before the session. Without 0035 it is charged in full, as before.
    // The answer goes back to the caller below so the customer is told which one before they
    // confirm, not after their card is taken.
    // Migration 0035 is also where a booking keeps a card, so it gates both saving a card for a
    // far-ahead booking AND keeping the card behind a hold (below).
    const cardsKeepable = charge > 0 && await deferredHoldsReady();
    let plan = holdPlan({ settings, dateISO, startMin, deferAvailable: cardsKeepable });

    const description = `${bayName(settings, bayId)} — simulator session`;
    const metadataFor = (p) => ({
      // Which way this payment was set up, carried on the PaymentIntent itself so the webhook and
      // the client-side confirm cannot disagree about it — neither of them re-runs the decision.
      paymentMode: p.mode,
      holdExpiresAt: p.holdExpiresAt || '',
      bayId,
      bayName: bayName(settings, bayId),
      dateISO,
      startMin: String(startMin),
      endMin: String(endMin),
      players: String(players),
      summary: summaryFor({ dateISO, startMin, endMin, players }),
      promoId: (q.promoDiscountCents > 0 && promo) ? String(promo.id) : '',
      promoReservationId: (q.promoDiscountCents > 0 && promoReservationId) ? String(promoReservationId) : '',
      promoDiscountCents: String(q.promoDiscountCents || 0),
      giftCardId: (q.giftUsedCents > 0 && giftCard) ? String(giftCard.id) : '',
      giftUsedCents: String(q.giftUsedCents || 0),
      memberDiscountPct: String(q.memberPct),
      memberDiscountCents: String(q.memberDiscountCents),
      // The team this booking is the league round for. paymentPatchFor / savedCardPatchFor
      // (lib/holds.js) read it, so the client-side confirm and the webhook write the same row.
      leagueTeamId: leagueRound ? String(leagueRound.team.id) : '',
      // Only for a make-up: the first day of the earlier week this round stands in for.
      leagueForWeek: leagueRound && leagueRound.makeup ? String(leagueRound.week.start) : '',
      leagueDiscountCents: String(q.leagueDiscountCents || 0),
      subtotalCents: String(q.subtotalCents),
      taxPct: String(q.taxPct),
      taxCents: String(q.taxCents),
    });

    // SAVE: a SetupIntent, not a PaymentIntent — the card is checked by the bank and saved, and not
    // a cent is authorised. chargeCents is what will be held later, written here so nothing
    // downstream takes an amount from the browser. Cards only (Apple Pay and Google Pay are cards):
    // the later hold is a manual-capture card payment, and a saved method that cannot do that would
    // only be discovered two days before the session.
    //
    // A RESTRICTED Stripe key without Customers / SetupIntents / PaymentMethods write cannot save a
    // card at all. That is a configuration gap, not the customer's problem: charge in full as before
    // and say loudly in the log what to fix, rather than refusing every far-ahead booking.
    let intent = null;
    if (plan.mode === 'save') {
      try {
        intent = await createSetupIntent(stripe, { email, phone, description,
          metadata: { ...metadataFor(plan), chargeCents: String(charge), holdDueAt: plan.holdDueAt } });
      } catch (err) {
        if (!err || err.type !== 'StripePermissionError') throw err;
        console.error(`⚠ Saved-card checkout is off — the Stripe key may not save cards (${err.message}). `
          + 'Give the restricted key write access to Customers, SetupIntents and PaymentMethods. '
          + 'Far-ahead bookings are charged in full until then.');
        plan = holdPlan({ settings, dateISO, startMin, deferAvailable: false });
      }
    }
    const paymentIntent = {
      amount: charge,
      currency: settings.currency,
      automatic_payment_methods: { enabled: true }, // dynamic payment methods, no hardcoded card-only
      // Only sent for a hold. Stripe's default is already 'automatic', so the charge-now path is
      // byte for byte the request it has always been.
      ...(plan.mode === 'hold' ? { capture_method: 'manual' } : {}),
      description,
      metadata: metadataFor(plan),
    };
    // A HOLD KEEPS THE CARD while it is open, so staff can raise or lower it (lib/holds.js
    // adjustHold) — a bank will not edit an authorisation, it can only be replaced by a new one on
    // the same card. The card is removed the moment the hold is charged or released. Same fallback
    // as saving a card above: a key that may not keep cards still places the hold, just without it.
    if (!intent && plan.mode === 'hold' && cardsKeepable && holdChangesEnabled(process.env)) {
      try {
        intent = await withStripeCustomer(stripe, { email, phone }, (customer) =>
          stripe.paymentIntents.create({ ...paymentIntent, customer, setup_future_usage: 'off_session' }));
        plan = { ...plan, message: HOLD_KEEPS_CARD_MESSAGE };   // say so before they confirm
      } catch (err) {
        if (!err || err.type !== 'StripePermissionError') throw err;
        console.error(`⚠ Holds are placed without keeping the card — the Stripe key may not save cards (${err.message}). `
          + 'Give the restricted key write access to Customers and PaymentMethods, or hold amounts cannot be changed.');
      }
    }
    if (!intent) intent = await stripe.paymentIntents.create(paymentIntent);

    res.status(200).json({ clientSecret: intent.client_secret, amount: charge, fullAmount: amount,
      memberPct: q.memberPct, memberDiscountCents: q.memberDiscountCents,
      promoDiscountCents: q.promoDiscountCents || 0, promoBlocked: q.promoBlocked || null,
      leagueDiscountCents: q.leagueDiscountCents || 0,
      leagueRound: leagueRound ? { teamId: leagueRound.team.id, teamName: leagueRound.team.name, leagueName: leagueRound.league.name,
        week: { start: leagueRound.week.start, end: leagueRound.week.end, number: leagueRound.week.number }, makeup: leagueRound.makeup } : null,
      giftUsedCents: q.giftUsedCents || 0, expiresAt,
      subtotalCents: q.subtotalCents, taxPct: q.taxPct, taxCents: q.taxCents, totalCents: q.totalCents,
      // WHAT THE CUSTOMER MUST BE TOLD BEFORE THEY CONFIRM. `mode` is 'hold', 'save' or 'charge';
      // `message` is a sentence ready to put on the screen; `captureBy` is when a hold dies if
      // nobody captures it, and `holdDueAt` when a saved card will be held. A checkout page that
      // shows nothing from here is telling a customer their card was charged when it was only
      // held, or the reverse. For 'save' the clientSecret is a SetupIntent's: confirmSetup, not
      // confirmPayment.
      payment: {
        mode: plan.mode,
        captureMethod: plan.captureMethod,
        amountCents: charge,
        holdExpiresAt: plan.holdExpiresAt,
        captureBy: plan.captureBy,
        holdDueAt: plan.holdDueAt,
        leadDays: plan.leadDays,
        cutoffDays: plan.cutoffDays,
        message: plan.message,
      },
      // The same answer flat, for callers that only want the one word.
      paymentMode: plan.mode });
  } catch (err) {
    console.error('create-payment-intent:', err.message);
    res.status(400).json({ error: err.message });
  }
}

// The saved-card half of checkout. The card has to belong to a Stripe Customer to be charged later
// with nobody at the keyboard, so one is needed — the one already linked to this contact when there
// is one, so a regular does not gain a new Customer in the Stripe dashboard for every booking.
// A linked Customer that was deleted in Stripe is replaced rather than failing the checkout.
async function createSetupIntent(stripe, { email, phone, description, metadata }) {
  return withStripeCustomer(stripe, { email, phone }, (customer) => stripe.setupIntents.create({
    customer, usage: 'off_session', payment_method_types: ['card'], description, metadata,
  }));
}

// Run `make(customerId)` with this contact's Stripe Customer: the linked one when there is one, a
// new one otherwise (or when the linked one was deleted in Stripe).
async function withStripeCustomer(stripe, { email, phone }, make) {
  const fresh = async () => (await stripe.customers.create({
    email: String(email || '').trim() || undefined, phone: String(phone || '').trim() || undefined,
    metadata: { source: 'invictus-booking' },
  })).id;
  const linked = await stripeCustomerForContact({ email, phone });
  if (linked) {
    try { return await make(linked); }
    catch (err) {
      if (!/No such customer/i.test(String(err && err.message))) throw err;
    }
  }
  return make(await fresh());
}

// ---- ?action=confirm-booking (was api/confirm-booking.js) -------------------------------
// Called by the booking site the moment a payment succeeds. It re-verifies the PaymentIntent with
// Stripe (so it can't be spoofed), then turns the customer's live cart hold into a confirmed booking
// and saves the customer. This makes bookings work without relying on a Stripe webhook; if a webhook
// IS configured it stays a backup — bookingExistsForPI keeps the two from double-booking.
export async function confirmBooking(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const { enabled } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ ok: false, error: 'Stripe not configured' });

  // note: typed at checkout, after the PaymentIntent already existed — so it arrives here, not in its metadata.
  // smsConsent: the express-consent tick box on the checkout form (migration 0019). `sms` beside it
  // is the old UI preference, which defaults to true and is NOT consent — the two are kept apart.
  const { paymentIntentId, name, email, phone, sms, smsConsent, note } = req.body || {};
  if (!paymentIntentId) return res.status(400).json({ ok: false, error: 'Missing payment reference.' });

  const stripe = stripeClient(process.env);
  // A far-ahead booking finished with its card SAVED, not paid: a SetupIntent (seti_…). Same job,
  // different Stripe object — see confirmSavedCard below.
  if (String(paymentIntentId).startsWith('seti_')) return confirmSavedCard(req, res, stripe);
  let pi;
  try { pi = await stripe.paymentIntents.retrieve(paymentIntentId); }
  catch (_) { return res.status(400).json({ ok: false, error: 'Payment not found.' }); }
  // TWO statuses mean "the customer is done and the slot is theirs", not one:
  //   succeeded         the card was charged — the far-ahead path, and what this handler has always
  //                     accepted, unchanged.
  //   requires_capture  the card was AUTHORISED. With capture_method: 'manual' this is as far as a
  //                     held booking ever gets at checkout, and `succeeded` will not arrive until a
  //                     member of staff captures at check-in — possibly days later. Refusing it here
  //                     would leave a customer who has had money reserved with no booking at all,
  //                     and the slot showing free.
  if (pi.status !== 'succeeded' && pi.status !== 'requires_capture') {
    return res.status(400).json({ ok: false, error: 'Payment is not complete.' });
  }
  const held = pi.status === 'requires_capture';

  const md = pi.metadata || {};
  if (!md.dateISO || !md.bayId) return res.status(400).json({ ok: false, error: 'Booking details missing on the payment.' });

  // Already saved (webhook or a retry got here first)? Nothing more to do.
  if (await bookingExistsForPI(pi.id)) {
    await upsertCustomer({ name, email, phone, smsOptIn: typeof sms === 'boolean' ? sms : undefined });
    await saveSmsConsent(req, { name, email, phone, smsConsent });
    await setCustomerNote({ paymentIntentId: pi.id, note, onlyIfEmpty: true });   // the webhook saved it without the note
    return res.status(200).json({ ok: true, already: true });
  }

  // Prefer what the customer typed; fall back to the card's billing details. The charge is also
  // where the card network's own authorisation deadline lives (capture_before), which is why it is
  // handed to paymentPatchFor below rather than thrown away after the billing details.
  let n = name, e = email, p = phone, charge = null;
  try {
    if (pi.latest_charge) {
      charge = await stripe.charges.retrieve(pi.latest_charge);
      const bd = charge.billing_details || {};
      n = n || bd.name; e = e || pi.receipt_email || bd.email; p = p || bd.phone;
    }
  } catch (_) { /* best-effort */ }

  const settings = normalizeSettings(await getSettings());
  const slot = { dateISO: md.dateISO, bayId: md.bayId, startMin: Number(md.startMin), endMin: Number(md.endMin) };
  const patch = {
    status_label: settings.onlineStatusLabel || null, customer_name: n || null, customer_email: e || null, customer_phone: p || null,
    stripe_payment_intent: pi.id, source: 'online',
    // amount_cents, authorized_cents, hold_expires_at and captured_at all come from here, so this
    // path and the webhook record the identical row. A held booking gets amount_cents 0.
    ...paymentPatchFor({ pi, charge }),
  };

  const flip = await confirmHold({ ...slot, patch });
  let bookingId = flip.id, roundDropped = !!flip.leagueRoundDropped;
  if (!flip.updated) {
    const ins = await insertBooking({ bay_id: slot.bayId, booking_date: slot.dateISO, start_min: slot.startMin, end_min: slot.endMin, status: 'confirmed', ...patch });
    roundDropped = roundDropped || !!ins.leagueRoundDropped;
    if (ins.error) {
      if (!held) {
        return res.status(409).json({ ok: false, error: 'That slot is no longer available — please contact the shop; your payment went through.' });
      }
      // A held card with no booking is on no list anywhere, so let it go now — but only when the
      // slot really is taken, never because the database hiccupped.
      const rel = ins.conflict ? await releaseUnbookedHold({ stripe, pi }) : { released: false };
      if (rel.booked) return res.status(200).json({ ok: true, already: true });
      return res.status(409).json({ ok: false, error: rel.released
        ? 'That slot is no longer available — please contact the shop. Your card was only held, not charged, and the hold has been released.'
        : 'We could not save your booking — please contact the shop. Your card was only held, not charged, and the hold clears on its own within about a week.' });
    }
    bookingId = ins.id;
  }
  await setCustomerNote({ bookingId, note });
  const up = await upsertCustomer({ name: n, email: e, phone: p, smsOptIn: typeof sms === 'boolean' ? sms : undefined });
  await saveSmsConsent(req, { name: n, email: e, phone: p, smsConsent });
  await sendReceipt({ bookingId, slot, md, name: n, email: e, phone: p, customerId: up && up.id,
    paymentState: held ? 'held' : 'paid', amountCents: held ? (patch.authorized_cents || pi.amount) : (patch.amount_cents || pi.amount) });

  // Loyalty points are retired: nothing is spent and nothing is earned here any more. Gift cards
  // and promo codes are still settled by api/webhook.js, exactly as before.
  return res.status(200).json({
    ok: true, bookingId,
    // Which of the two happened, so the confirmation screen says "held" or "charged" and not
    // whichever one it was written for.
    paymentState: held ? 'held' : 'paid',
    holdExpiresAt: held ? (patch.hold_expires_at || null) : null,
    amountCents: held ? (patch.authorized_cents || 0) : (patch.amount_cents || 0),
    leagueRound: leagueRoundOutcome(patch, roundDropped),
  });
}

// confirm-booking for a SAVED card (migration 0035). The SetupIntent is re-read from Stripe, so it
// cannot be spoofed; the slot, the amount and when the hold is due all come from its metadata,
// which api/checkout.js wrote. The booking is 'card_saved' with amount_cents 0 — nothing has been
// charged or even authorised, and lib/holds.js placeDueHolds() holds the card leadDays out.
async function confirmSavedCard(req, res, stripe) {
  const { paymentIntentId: siId, name, email, phone, sms, smsConsent, note } = req.body || {};
  let si;
  try { si = await stripe.setupIntents.retrieve(siId); }
  catch (_) { return res.status(400).json({ ok: false, error: 'Payment not found.' }); }
  if (si.status !== 'succeeded') return res.status(400).json({ ok: false, error: 'Your card has not been saved yet.' });
  const md = si.metadata || {};
  if (!md.dateISO || !md.bayId) return res.status(400).json({ ok: false, error: 'Booking details missing on the payment.' });

  if (await bookingExistsForSetupIntent(si.id)) {
    await upsertCustomer({ name, email, phone, smsOptIn: typeof sms === 'boolean' ? sms : undefined });
    await saveSmsConsent(req, { name, email, phone, smsConsent });
    return res.status(200).json({ ok: true, already: true });
  }

  // Prefer what the customer typed; fall back to the card's billing details.
  let n = name, e = email, p = phone;
  try {
    if (si.payment_method) {
      const pm = typeof si.payment_method === 'string' ? await stripe.paymentMethods.retrieve(si.payment_method) : si.payment_method;
      const bd = (pm && pm.billing_details) || {};
      n = n || bd.name; e = e || bd.email; p = p || bd.phone;
    }
  } catch (_) { /* best-effort */ }

  const settings = normalizeSettings(await getSettings());
  const slot = { dateISO: md.dateISO, bayId: md.bayId, startMin: Number(md.startMin), endMin: Number(md.endMin) };
  const saved = savedCardPatchFor({ si });
  const patch = {
    status_label: settings.onlineStatusLabel || null, customer_name: n || null, customer_email: e || null, customer_phone: p || null,
    source: 'online', ...saved,
  };

  const flip = await confirmHold({ ...slot, patch });
  let bookingId = flip.id, roundDropped = !!flip.leagueRoundDropped;
  if (!flip.updated) {
    const ins = await insertBooking({ bay_id: slot.bayId, booking_date: slot.dateISO, start_min: slot.startMin, end_min: slot.endMin, status: 'confirmed', ...patch });
    roundDropped = roundDropped || !!ins.leagueRoundDropped;
    if (ins.error) {
      // "Taken" by the webhook's own row for this very SetupIntent is not taken at all.
      if (ins.conflict && await bookingExistsForSetupIntent(si.id)) return res.status(200).json({ ok: true, already: true });
      // Nothing was charged, so there is nothing to give back — only the card to forget, and only
      // when the slot really is taken (never because the database hiccupped).
      if (ins.conflict) await forgetSavedCard(stripe, { id: 'unbooked', stripe_payment_method: saved.stripe_payment_method });
      return res.status(409).json({ ok: false, error: ins.conflict
        ? 'That slot is no longer available — please pick another time. Nothing was charged to your card.'
        : 'We could not save your booking — please contact the shop. Nothing was charged to your card.' });
    }
    bookingId = ins.id;
  }
  await setCustomerNote({ bookingId, note });
  const up = await upsertCustomer({ name: n, email: e, phone: p, smsOptIn: typeof sms === 'boolean' ? sms : undefined });
  await rememberStripeCustomer({ email: e, phone: p, stripeCustomerId: saved.stripe_customer });
  await saveSmsConsent(req, { name: n, email: e, phone: p, smsConsent });
  await sendReceipt({ bookingId, slot, md, name: n, email: e, phone: p, customerId: up && up.id,
    paymentState: 'card_saved', amountCents: saved.deferred_cents });

  return res.status(200).json({
    ok: true, bookingId,
    paymentState: 'card_saved',
    holdDueAt: saved.hold_due_at,
    amountCents: saved.deferred_cents,
    leagueRound: leagueRoundOutcome(patch, roundDropped),
  });
}

// Was this booking a team's league round, and did it count? `counted: false` is the rare race: a
// teammate booked the week's round while this one was being paid for. The booking still stands as
// an ordinary session — nobody loses a slot they paid for — and the page says so.
function leagueRoundOutcome(patch, dropped) {
  if (!patch || !patch.league_team_id) return null;
  return { counted: !dropped };
}

// The customer's booking text. The webhook queues the same one; both are keyed on the booking, so
// whichever arrives first sends it and the other is a no-op (lib/notify.js dedupe). Until this was
// here, the browser — which usually wins — wrote the booking and the webhook then found it and
// returned, so most customers were never sent a confirmation at all. Best-effort: a booking that
// has been paid for is never failed over a message.
async function sendReceipt({ bookingId, slot, md, name, email, phone, customerId, paymentState, amountCents }) {
  try {
    await notifyBookingConfirmed({
      bookingId, dateISO: slot.dateISO, bayId: slot.bayId, bayName: md.bayName,
      startMin: slot.startMin, endMin: slot.endMin, players: Number(md.players) || null,
      amountCents, paymentState, name, email, phone, customerId: customerId || null,
    });
  } catch (err) {
    console.error('confirm-booking: receipt not queued —', err && err.message ? err.message : err);
  }
}

// The consent tick, written where lib/notify.js looks for it. Three rules, all of them here:
//   • no smsConsent in the request → nothing is written, ever. Silence is not consent, and a
//     client that has not been updated must not be read as one that sent `false`.
//   • true  → sms_consent, with the time, the IP and source 'checkout' (CASL's point-of-collection
//     record), and sms_unsub_at cleared.
//   • false → recorded as a NO, not skipped: the box starts empty, so the customer has looked at
//     it and chosen to leave it that way. That withdraws any earlier yes rather than leaving the
//     old one standing, which is why recordConsent() stamps sms_unsub_at on a false.
// Best-effort, like the note and the receipt: a paid booking is never failed over a preference.
async function saveSmsConsent(req, { name, email, phone, smsConsent }) {
  if (typeof smsConsent !== 'boolean') return;
  try {
    await recordConsent({ name, email, phone, smsConsent, ip: clientIp(req), source: 'checkout' });
  } catch (err) {
    console.error('confirm-booking: consent not recorded —', err && err.message ? err.message : err);
  }
}

// ---- ?action=release-hold (was api/release-hold.js) -------------------------------------
// Release a cart hold when checkout is closed/abandoned before payment.
// Best-effort — the 5-minute TTL (cleanupExpiredHolds) is the real backstop.
// Named releaseHoldAction because lib/db.js already exports releaseHold, which is what it calls.
export async function releaseHoldAction(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { dateISO, bayId, startMin, endMin } = req.body || {};
  if (dateISO && bayId) await releaseHold({ dateISO, bayId, startMin: Number(startMin), endMin: Number(endMin) });
  res.status(200).json({ ok: true });
}
