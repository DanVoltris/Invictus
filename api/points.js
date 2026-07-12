import {
  normalizeSettings, priceForBooking, overrideEffects, overrideConflicts, weeklyStatusConflicts,
  pointsRedemption, pointsEarned,
} from '../lib/booking.js';
import {
  getSettings, getOverridesForDate, getBookingsForDate,
  customerHoursByContact, bookWithPoints, awardBookingPoints,
} from '../lib/db.js';

// Loyalty points at checkout. Dispatch on ?action= — quote | book.
// (Earning happens in confirm-booking/webhook; staff award/adjust runs from the admin via RPC.)
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((e || '').trim());
// Accepts NANP (10 digits, optional leading 1) and international numbers (+ or 00 + country code).
const validPhone = (p) => { const raw = String(p || '').trim(); let d = raw.replace(/\D/g, ''); const intl = raw.startsWith('+') || (d.startsWith('00') && d.length >= 12); if (intl && d.startsWith('00')) d = d.slice(2); return (d.length === 10 && !intl) || (d.length === 11 && d[0] === '1') || (d.length >= 11 && d.length <= 15) || (intl && d.length >= 8 && d.length <= 15); };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const action = (req.query && req.query.action) || '';
  if (action === 'quote') return quote(req, res);
  if (action === 'book') return book(req, res);
  return res.status(400).json({ error: 'Unknown action' });
}

// Validate the requested slot and return its price in cents (shared by quote + book).
async function priceSlot({ dateISO, bayId, startMin, endMin }) {
  const settings = normalizeSettings(await getSettings());
  const overrides = await getOverridesForDate(dateISO);
  const fx = overrideEffects(overrides, settings, dateISO);
  const amount = priceForBooking({ settings, dateISO, bayId, startMin, endMin, dateHours: fx.dateHours });
  if (overrideConflicts(fx, settings, dateISO, bayId, Number(startMin), Number(endMin)) ||
      weeklyStatusConflicts(settings, overrides, dateISO, bayId, Number(startMin), Number(endMin))) {
    throw Object.assign(new Error('That time is unavailable — pick another slot.'), { code: 409 });
  }
  return { settings, amount };
}

// POST ?action=quote — what the customer's points are worth against this slot.
async function quote(req, res) {
  const { dateISO, bayId, startMin, endMin, email, phone } = req.body || {};
  if (!validPhone(phone) && !validEmail(email)) return res.status(200).json({ found: false });
  try {
    const { settings, amount } = await priceSlot({ dateISO, bayId, startMin, endMin });
    const cust = await customerHoursByContact({ email, phone });
    if (!cust || !(cust.points_balance > 0)) return res.status(200).json({ found: false });
    const r = pointsRedemption(settings, cust.points_balance, amount);
    if (!(r.pointsUsed > 0)) return res.status(200).json({ found: false });
    res.status(200).json({ found: true, balance: cust.points_balance, ...r, amount });
  } catch (e) {
    res.status(200).json({ found: false });
  }
}

// POST ?action=book — book the slot fully covered by points (no card).
async function book(req, res) {
  const { dateISO, bayId, startMin, endMin, name, email, phone } = req.body || {};
  if (!validPhone(phone) && !validEmail(email)) return res.status(400).json({ ok: false, error: 'Enter your phone number to use your points.' });
  let settings, amount;
  try { ({ settings, amount } = await priceSlot({ dateISO, bayId, startMin, endMin })); }
  catch (e) { return res.status(e.code || 400).json({ ok: false, error: e.message }); }

  const clash = (await getBookingsForDate(dateISO))
    .some((b) => b.bay_id === bayId && Number(startMin) < b.end_min && Number(endMin) > b.start_min);
  if (clash) return res.status(409).json({ ok: false, error: 'That time was just taken — pick another slot.' });

  const cust = await customerHoursByContact({ email, phone });
  const r = pointsRedemption(settings, (cust && cust.points_balance) || 0, amount);
  if (!cust) return res.status(400).json({ ok: false, error: 'no_account' });
  if (!r.fullCover) return res.status(400).json({ ok: false, error: 'insufficient', balance: cust.points_balance || 0 });

  const b = await bookWithPoints({ dateISO, bayId, startMin, endMin, name, email, phone, points: r.pointsUsed, statusLabel: settings.onlineStatusLabel || 'Booked' });
  if (b.error === 'no_account') return res.status(400).json({ ok: false, error: 'no_account' });
  if (b.error === 'insufficient') return res.status(400).json({ ok: false, error: 'insufficient', balance: b.balance });
  if (b.error === 'taken') return res.status(409).json({ ok: false, error: 'That time was just taken — pick another slot.' });
  if (b.error) return res.status(500).json({ ok: false, error: b.error });

  // Playing time still earns points, even on a points-paid session (once per booking).
  await awardBookingPoints({ customerId: b.customerId, bookingId: b.bookingId, points: pointsEarned(settings, Number(endMin) - Number(startMin)) });
  res.status(200).json({ ok: true, pointsUsed: r.pointsUsed, balance: b.balance });
}
