import { admin, getSettings, accountSummary } from '../lib/db.js';
import { normalizeSettings, bayName, fmtMin, hoursUntilBooking, winnipegTodayISO } from '../lib/booking.js';

// Customer self-service, one function (keeps the deployment under Vercel's function cap):
//   GET  ?id=…            → read-only lookup of a booking (customer-safe fields only)
//   GET  ?phone=… / ?email=… → account summary: profile, balances, membership, bookings
//   POST {id}             → cancel the booking (24-hour policy enforced server-side)
export default async function handler(req, res) {
  if (req.method === 'POST') return cancel(req, res);
  if (req.query && (req.query.phone || req.query.email) && !req.query.id) return account(req, res);
  return lookup(req, res);
}

async function account(req, res) {
  const { phone, email } = req.query || {};
  const sum = await accountSummary({ email, phone });
  if (!sum) return res.status(404).json({ ok: false, error: 'not_found' });
  const settings = normalizeSettings(await getSettings());
  const c = sum.customer, today = winnipegTodayISO();
  res.status(200).json({
    ok: true,
    account: {
      name: c.name || null,
      pointsBalance: c.points_balance || 0,
      hoursBalanceMin: c.hours_balance_min || 0,
      membership: sum.membership,
      waiverSigned: !!c.waiver_signed_at,
      smsOptIn: c.sms_opt_in !== false,
    },
    bookings: sum.bookings.map((b) => ({
      id: b.id,
      date: b.booking_date,
      start: fmtMin(b.start_min),
      end: fmtMin(b.end_min),
      bay: bayName(settings, b.bay_id) || b.bay_id,
      status: b.status,
      source: b.source || null,
      upcoming: b.status === 'confirmed' && b.booking_date >= today,
    })),
  });
}

async function lookup(req, res) {
  const id = (req.query && req.query.id) || '';
  if (!/^[0-9a-fA-F-]{10,}$/.test(id)) return res.status(400).json({ ok: false, error: 'Invalid link.' });
  const db = admin();
  if (!db) return res.status(503).json({ ok: false, error: 'Not configured.' });

  const { data, error } = await db
    .from('bookings')
    .select('id,bay_id,booking_date,start_min,end_min,status,customer_name')
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
    },
  });
}

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
  res.status(200).json({ ok: true });
}
