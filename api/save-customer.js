import { upsertCustomer } from '../lib/db.js';

// Called by the booking site right after a successful payment to save the customer's contact +
// their SMS-notification choice. The webhook also upserts the contact (reliable backup); this call
// carries the SMS toggle value read at pay time. Idempotent — matches an existing profile by email/phone.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  const { name, email, phone, sms } = req.body || {};
  const r = await upsertCustomer({ name, email, phone, smsOptIn: typeof sms === 'boolean' ? sms : undefined });
  res.status(200).json({ ok: !r.error, error: r.error || null });
}
