import { admin, getSettings, getBookingsForDate, getOverridesForDate, accountCustomerForRequest,
         teamMembershipFor, teamRoundForWeek, insertLeagueRound } from '../lib/db.js';
import { normalizeSettings, bayName, fmtMin, hoursUntilBooking, winnipegTodayISO,
         bookingWindowError, overrideEffects, overrideConflicts, weeklyStatusConflicts,
         stripeStatus, stripeClient } from '../lib/booking.js';
import { issueRefund } from '../lib/refunds.js';
import '../demo/assets/leagues.js';   // side effect: globalThis.InvictusLeagues (the week maths)

// Customer self-service, one function (keeps the deployment under Vercel's function cap):
//   GET  ?id=…                    → read-only lookup of a booking (customer-safe fields only)
//   POST {id}                     → cancel the booking AND refund it (24-hour policy, server-side)
//   POST ?action=league-round     → a team's free weekly league round (migration 0031)
// The old GET ?phone=… account summary is gone: it handed out a customer's name, balances and
// bookings to anyone who typed their number. My Account (migration 0025) needs a sign-in instead.
export default async function handler(req, res) {
  const action = (req.query && req.query.action) || '';
  if (req.method === 'POST' && action === 'league-round') return leagueRound(req, res);
  if (req.method === 'POST') return cancel(req, res);
  return lookup(req, res);
}

async function lookup(req, res) {
  const id = (req.query && req.query.id) || '';
  if (!/^[0-9a-fA-F-]{10,}$/.test(id)) return res.status(400).json({ ok: false, error: 'Invalid link.' });
  const db = admin();
  if (!db) return res.status(503).json({ ok: false, error: 'Not configured.' });

  const { data, error } = await db
    .from('bookings')
    .select('id,bay_id,booking_date,start_min,end_min,status,customer_name,amount_cents,refunded_cents')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ ok: false, error: 'Booking not found.' });

  const settings = normalizeSettings(await getSettings());
  const hoursUntil = hoursUntilBooking(data.booking_date, data.start_min);
  res.status(200).json({
    ok: true,
    booking: {
      id: data.id,
      bay: bayName(settings, data.bay_id) || data.bay_id,
      booking_date: data.booking_date,
      start: fmtMin(data.start_min),
      end: fmtMin(data.end_min),
      status: data.status,
      customerName: data.customer_name || null,
      hoursUntil,
      canCancel: data.status === 'confirmed' && hoursUntil >= 24,
      // What cancelling now would send back, so the page can say the number before the customer
      // commits rather than after. Customer-safe: it is their own booking and their own money.
      paidCents: Math.max(0, Number(data.amount_cents) || 0),
      refundableCents: Math.max(0, (Number(data.amount_cents) || 0) - (Number(data.refunded_cents) || 0)),
    },
  });
}

// ----- customer self-cancellation ------------------------------------------------------------
//
// WHAT THIS USED TO DO, AND WHY IT WAS WRONG. It flipped the booking to 'cancelled', answered
// `{ ok: true }`, and kept the money — silently. Meanwhile /manage told the customer "Free
// cancellation up to 24 hours before your tee time" and settings.pay.paymentDisclaimer promised
// "Refunds will be issued if cancellation notice is provided at least 24 hours prior". Two
// promises, no refund path, and a customer with no way to know the difference.
//
// THE CHOICE MADE HERE: it refunds. Not because a refund is always right, but because THE GATE
// THIS FUNCTION ALREADY ENFORCES IS THE REFUND POLICY. The 24-hour rule below is not a booking
// rule that happens to sit near a money rule — it is the venue's cancellation policy, and it
// already refuses every cancellation the policy would not refund ("please call the shop"). So
// every cancellation that gets past it is, by the venue's own published terms, a refundable one.
// Cancelling it without paying it back would mean enforcing the half of the policy that protects
// the venue and ignoring the half that protects the customer. The alternative — keep cancelling
// and merely warn "no refund" — would have meant changing the promise on three pages and giving
// the customer a worse deal than the one they booked under.
//
// WHAT IT NEVER DOES: fail the cancellation because the refund failed. The customer asked to
// cancel; that part is theirs and it is done first. If Stripe is off, misconfigured, or the
// booking was not paid by card, the obligation is still RECORDED (method 'manual') and the answer
// says plainly that the money has not moved yet and who will move it. The response's `refund`
// object is the only thing a page should believe — `moneyMoved` in particular.
//
// The refund is the full remaining balance and the amount is never taken from the request body:
// the caller supplies a booking id and nothing else, exactly as before.
async function cancel(req, res) {
  const id = (req.body && req.body.id) || '';
  if (!/^[0-9a-fA-F-]{10,}$/.test(id)) return res.status(400).json({ ok: false, error: 'Invalid request.' });
  const db = admin();
  if (!db) return res.status(503).json({ ok: false, error: 'Not configured.' });

  const { data, error } = await db
    .from('bookings')
    .select('id,booking_date,start_min,status')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return res.status(404).json({ ok: false, error: 'Booking not found.' });

  if (data.status === 'cancelled') return res.status(200).json({ ok: true, already: true });
  if (data.status !== 'confirmed') return res.status(400).json({ ok: false, error: "This booking can't be cancelled online." });

  const hoursUntil = hoursUntilBooking(data.booking_date, data.start_min);
  if (hoursUntil < 24) {
    return res.status(403).json({
      ok: false,
      code: 'too_late',
      error: 'Cancellations must be made at least 24 hours before your tee time. Please call the shop to cancel.',
    });
  }

  // Try to record the cancellation time; fall back to a plain status update if the column
  // isn't there yet (migration 0005 not run).
  let upd = await db.from('bookings').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', id);
  if (upd.error && /cancelled_at/.test(upd.error.message || '')) {
    upd = await db.from('bookings').update({ status: 'cancelled' }).eq('id', id);
  }
  if (upd.error) return res.status(500).json({ ok: false, error: upd.error.message });

  res.status(200).json({ ok: true, refund: await refundOnSelfCancel(id) });
}

// The refund half of the cancellation above. Returns a small object a page can show verbatim —
// it never throws, and it never reports money moved unless Stripe said so.
async function refundOnSelfCancel(bookingId) {
  const { enabled } = stripeStatus(process.env);
  let out;
  try {
    out = await issueRefund({
      stripe: enabled ? stripeClient(process.env) : null,
      bookingId,
      amountCents: null,                       // everything still refundable — never from the body
      reason: 'cancelled online (24-hour policy)',
      // One key per booking: a customer who double-clicks Cancel, or retries after a dropped
      // connection, gets one refund. A second cancellation of the same booking is impossible
      // anyway (the status check above), but the key is what makes that true of the money.
      ref: `self-cancel:${bookingId}`,
      by: 'customer',
      allowManual: true,                       // no card on file → record the obligation, don't drop it
    });
  } catch (err) {
    console.error('self-cancel refund:', err && err.message);
    return { moneyMoved: false, status: 'pending', amountCents: null,
      message: 'Your booking is cancelled. Your refund could not be sent automatically — please call the shop and we will issue it.' };
  }

  if (out.nothingToRefund) {
    return { moneyMoved: false, status: 'none', amountCents: 0,
      message: 'There was nothing to pay for this booking, so there is nothing to refund.' };
  }
  if (!out.ok) {
    // Recorded-but-not-sent, or refused outright. Either way the customer is told the truth and
    // given the next step; staff see the obligation in the refunds table.
    console.warn(`self-cancel refund for ${bookingId}: ${out.error}`);
    return { moneyMoved: false, status: 'pending', refundId: out.refundId || null, amountCents: out.amountCents || null,
      message: 'Your booking is cancelled. Your refund has not gone through automatically — the shop has been notified '
        + 'and will issue it. Please call us if it has not arrived within 10 business days.' };
  }
  return {
    moneyMoved: !!out.moneyMoved,
    status: out.status,
    amountCents: out.amountCents,
    refundId: out.refundId,
    message: out.moneyMoved
      ? out.message
      : (out.method === 'manual'
        ? 'Your booking is cancelled. This one was not paid by card, so the shop will put the money back the way you paid it.'
        : out.message),
  };
}

// ----- A team's weekly league round (migration 0031) -----------------------------------
//
// The team paid for the season, so the round itself is free: any bay, any time, any day of the
// week, booked by whichever member gets to it first. What this has to be sure of, in order:
//
//   1. the caller really is on that team          (never a team id alone — that is not a password)
//   2. the season actually covers the date
//   3. the date is inside their booking window    (league players get the longer one, 0028)
//   4. the slot is genuinely free                 (same checks as a paid booking)
//   5. the team has not already played this week  (the database's own partial unique index)
//
// Nothing here charges anything, so every one of those is the only thing standing between a team
// and unlimited free bay time.
const L = () => globalThis.InvictusLeagues;

async function leagueRound(req, res) {
  const db = admin();
  if (!db) return res.status(503).json({ ok: false, error: 'Not configured.' });

  // 1. Who is asking. A My Account session, or the localhost dev account the dev server marks —
  // never a phone number or a customer id out of the body.
  const me = await accountCustomerForRequest(req);
  if (!me) return res.status(401).json({ ok: false, error: 'Sign in to book your team’s round.' });

  const b = req.body || {};
  const dateISO = String(b.dateISO || '');
  const bayId = String(b.bayId || '');
  const startMin = Math.round(Number(b.startMin));
  const endMin = Math.round(Number(b.endMin));
  if (!b.teamId) return res.status(400).json({ ok: false, error: 'Which team is this round for?' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return res.status(400).json({ ok: false, error: 'Pick a date on the calendar first.' });
  if (!bayId) return res.status(400).json({ ok: false, error: 'Pick a bay.' });
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
    return res.status(400).json({ ok: false, error: 'Pick a start and end time.' });
  }

  // 2. On the team, and the team's league is still running.
  const m = await teamMembershipFor({ teamId: b.teamId, customerId: me.id });
  if (!m || !m.team) return res.status(404).json({ ok: false, error: 'That team no longer exists.' });
  if (!m.member) return res.status(403).json({ ok: false, error: 'You’re not on that team, so you can’t book its round.' });
  const { team, league } = m;
  if (!league) return res.status(404).json({ ok: false, error: 'That league no longer exists.' });
  if ((league.season_start && dateISO < league.season_start) || (league.season_end && dateISO > league.season_end)) {
    const from = league.season_start || '—', to = league.season_end || 'further notice';
    return res.status(400).json({ ok: false, code: 'outside_season',
      error: `${league.name} runs ${from} to ${to}. Pick a date inside the season.` });
  }

  const settings = normalizeSettings(await getSettings());

  // 3. How far ahead they may book. They are on a current league roster by definition here, so
  // the longer league window applies (settings.bookingWindow.leagueDays).
  const tooFar = bookingWindowError({ settings, dateISO, league: true });
  if (tooFar) return res.status(400).json({ ok: false, code: 'booking_window', error: tooFar });

  // 4. Is the slot free? Exactly the checks api/checkout.js ?action=create-payment-intent makes
  // before charging a card: a real booking or manager block, a schedule override, or a closed
  // weekly band.
  const overrides = await getOverridesForDate(dateISO);
  const fx = overrideEffects(overrides, settings, dateISO);
  const taken = (await getBookingsForDate(dateISO))
    .some((x) => x.bay_id === bayId && startMin < x.end_min && endMin > x.start_min);
  if (taken) return res.status(409).json({ ok: false, code: 'slot_taken', error: 'That time was just taken — pick another slot.' });
  if (overrideConflicts(fx, settings, dateISO, bayId, startMin, endMin) ||
      weeklyStatusConflicts(settings, overrides, dateISO, bayId, startMin, endMin)) {
    return res.status(409).json({ ok: false, code: 'slot_taken', error: 'That time is unavailable — pick another slot.' });
  }

  // 5. One round per team per week. Checked here so the answer can name the round they already
  // have, and enforced by the database's partial unique index so two members booking at the same
  // moment cannot both win.
  const existing = await teamRoundForWeek(team.id, dateISO);
  if (existing) return res.status(409).json(alreadyBooked(settings, team, existing));

  const round = await insertLeagueRound({
    bay_id: bayId, booking_date: dateISO, start_min: startMin, end_min: endMin,
    status: 'confirmed', status_label: settings.onlineStatusLabel || null,
    customer_name: me.name || null, customer_email: me.email || null, customer_phone: me.phone || null,
    amount_cents: 0, source: 'online', league_team_id: team.id,
  });
  if (round.unsupported) return res.status(503).json({ ok: false, error: round.error });
  if (round.conflict === 'slot') return res.status(409).json({ ok: false, code: 'slot_taken', error: 'That time was just taken — pick another slot.' });
  if (round.conflict === 'week') {
    const again = await teamRoundForWeek(team.id, dateISO);
    return res.status(409).json(again ? alreadyBooked(settings, team, again)
      : { ok: false, code: 'round_booked', error: 'Your team has already booked its round for this week.' });
  }
  if (round.error) return res.status(round.code || 500).json({ ok: false, error: round.error });

  return res.status(200).json({
    ok: true, bookingId: round.id,
    round: { id: round.id, teamId: team.id, booking_date: dateISO, bay: bayName(settings, bayId) || bayId,
      start: fmtMin(startMin), end: fmtMin(endMin), week: L().weekOf(dateISO) },
  });
}

// The "you already played this week" answer, with enough detail that the team can find the round
// rather than going looking for it.
function alreadyBooked(settings, team, round) {
  return {
    ok: false, code: 'round_booked',
    error: `${team.name} has already booked its round for this week — ${round.booking_date}, `
      + `${fmtMin(round.start_min)}–${fmtMin(round.end_min)} in ${bayName(settings, round.bay_id) || round.bay_id}. `
      + 'Cancel that one first if you want to move it.',
    existing: { id: round.id, booking_date: round.booking_date, bay: bayName(settings, round.bay_id) || round.bay_id,
      start: fmtMin(round.start_min), end: fmtMin(round.end_min), week: round.league_week },
  };
}
