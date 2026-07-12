import Stripe from 'stripe';
import {
  stripeStatus, normalizeSettings, priceForBooking, overrideEffects, overrideConflicts, weeklyStatusConflicts, pointsEarned,
} from '../lib/booking.js';
import {
  getSettings, getOverridesForDate, getBookingsForDate, admin,
  listHourCards, grantHours, customerHoursByContact, bookWithHours, awardBookingPoints,
} from '../lib/db.js';

// One function for the whole hour-card flow (kept single to stay within the Hobby function limit).
// Dispatch on ?action= — list | checkout | confirm | balance | book.
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((e || '').trim());
// Accepts NANP (10 digits, optional leading 1) and international numbers (+ or 00 + country code).
const validPhone = (p) => { const raw = String(p || '').trim(); let d = raw.replace(/\D/g, ''); const intl = raw.startsWith('+') || (d.startsWith('00') && d.length >= 12); if (intl && d.startsWith('00')) d = d.slice(2); return (d.length === 10 && !intl) || (d.length === 11 && d[0] === '1') || (d.length >= 11 && d.length <= 15) || (intl && d.length >= 8 && d.length <= 15); };

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || '';
  if (req.method === 'GET' || action === 'list') return res.status(200).json({ cards: await listHourCards() });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (action === 'checkout') return checkout(req, res);
  if (action === 'confirm') return confirm(req, res);
  if (action === 'balance') return balance(req, res);
  if (action === 'book') return book(req, res);
  return res.status(400).json({ error: 'Unknown action' });
}

// POST ?action=checkout — hosted Stripe Checkout to buy an hour card.
async function checkout(req, res) {
  const { enabled, secretKey } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ error: 'Online purchase isn’t available right now — please call the shop.' });
  const { cardId, name, email, phone } = req.body || {};
  if (!cardId) return res.status(400).json({ error: 'Please choose a card.' });
  if (!validPhone(phone)) return res.status(400).json({ error: 'A valid phone number is required — your hours link to it.' });
  if (!validEmail(email)) return res.status(400).json({ error: 'A valid email is required for your receipt.' });

  const db = admin();
  if (!db) return res.status(503).json({ error: 'Not configured.' });
  const { data: card } = await db.from('hour_cards').select('*').eq('id', cardId).maybeSingle();
  if (!card) return res.status(404).json({ error: 'That card was not found.' });
  if (!(card.price_cents > 0)) return res.status(400).json({ error: 'This card can’t be purchased online — please contact the shop.' });

  const settings = normalizeSettings(await getSettings());
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const stripe = new Stripe(secretKey);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: settings.currency,
          product_data: { name: `${card.name} — ${card.hours} hours`, description: `${card.hours} hours of range time` },
          unit_amount: card.price_cents,
        },
        quantity: 1,
      }],
      customer_email: (email || '').trim() || undefined,
      metadata: { kind: 'hours', cardId, hours: String(card.hours), name: (name || '').trim(), email: (email || '').trim(), phone: (phone || '').trim() },
      success_url: `${origin}/hours?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/hours?canceled=1`,
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('hours checkout:', err.message);
    res.status(400).json({ error: err.message });
  }
}

// POST ?action=confirm — re-verify the paid session and credit the hours (idempotent via session id).
async function confirm(req, res) {
  const { enabled, secretKey } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ ok: false, error: 'Stripe not configured' });
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing checkout session.' });

  const stripe = new Stripe(secretKey);
  let session;
  try { session = await stripe.checkout.sessions.retrieve(sessionId); }
  catch (_) { return res.status(400).json({ ok: false, error: 'Checkout session not found.' }); }
  if (session.payment_status !== 'paid') return res.status(400).json({ ok: false, error: 'Payment is not complete.' });

  const md = session.metadata || {};
  if (md.kind !== 'hours' || !md.cardId) return res.status(400).json({ ok: false, error: 'This session is not an hour-card purchase.' });

  const db = admin();
  const { data: card } = await db.from('hour_cards').select('name,hours').eq('id', md.cardId).maybeSingle();
  const hours = Number((card && card.hours) || md.hours || 0);
  const email = md.email || (session.customer_details && session.customer_details.email) || '';
  const r = await grantHours({ name: md.name, email, phone: md.phone, minutes: Math.round(hours * 60), ref: session.id });
  if (r.error) return res.status(500).json({ ok: false, error: r.error });
  res.status(200).json({ ok: true, cardName: (card && card.name) || 'Hour card', hours, balanceMin: r.balanceMin, email: email || null });
}

// POST ?action=balance — a customer's hours balance by phone (primary) or email (fallback).
async function balance(req, res) {
  const { email, phone } = req.body || {};
  if (!validPhone(phone) && !validEmail(email)) return res.status(200).json({ found: false });
  const cust = await customerHoursByContact({ email, phone });
  if (!cust) return res.status(200).json({ found: false });
  res.status(200).json({ found: true, name: cust.name || null, balanceMin: cust.hours_balance_min || 0 });
}

// POST ?action=book — book a slot by paying with prepaid hours (validates the slot, deducts, confirms).
async function book(req, res) {
  const { dateISO, bayId, startMin, endMin, name, email, phone } = req.body || {};
  if (!validPhone(phone) && !validEmail(email)) return res.status(400).json({ ok: false, error: 'Enter your phone number to use your hours.' });

  const settings = normalizeSettings(await getSettings());
  const overrides = await getOverridesForDate(dateISO);
  const fx = overrideEffects(overrides, settings, dateISO);
  try {
    priceForBooking({ settings, dateISO, bayId, startMin, endMin, dateHours: fx.dateHours });   // validates time/hours/alignment
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  if (overrideConflicts(fx, settings, dateISO, bayId, Number(startMin), Number(endMin)) ||
      weeklyStatusConflicts(settings, overrides, dateISO, bayId, Number(startMin), Number(endMin))) {
    return res.status(409).json({ ok: false, error: 'That time is unavailable — pick another slot.' });
  }
  const clash = (await getBookingsForDate(dateISO))
    .some((b) => b.bay_id === bayId && Number(startMin) < b.end_min && Number(endMin) > b.start_min);
  if (clash) return res.status(409).json({ ok: false, error: 'That time was just taken — pick another slot.' });

  const stg = normalizeSettings(await getSettings());
  const r = await bookWithHours({ dateISO, bayId, startMin, endMin, name, email, phone, statusLabel: stg.onlineStatusLabel || 'Booked' });
  if (r.error === 'no_account') return res.status(400).json({ ok: false, error: 'no_account' });
  if (r.error === 'insufficient') return res.status(400).json({ ok: false, error: 'insufficient', balanceMin: r.balanceMin, neededMin: r.neededMin });
  if (r.error === 'taken') return res.status(409).json({ ok: false, error: 'That time was just taken — pick another slot.' });
  if (r.error) return res.status(500).json({ ok: false, error: r.error });
  // Time played on an hours-paid session still earns loyalty points (once per booking).
  await awardBookingPoints({ customerId: r.customerId, bookingId: r.bookingId, points: pointsEarned(stg, Number(endMin) - Number(startMin)) });
  res.status(200).json({ ok: true, balanceMin: r.balanceMin });
}
