import Stripe from 'stripe';
import { stripeStatus, membershipExpiryISO } from '../lib/booking.js';
import { admin, grantMembership } from '../lib/db.js';

// Called when the customer returns from Stripe Checkout. Re-verifies the session was paid, then links
// the plan to their customer profile (creating/matching it by email) and sets the expiry. Idempotent.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
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
  if (md.kind !== 'membership' || !md.membershipId) return res.status(400).json({ ok: false, error: 'This session is not a membership purchase.' });

  const db = admin();
  if (!db) return res.status(503).json({ ok: false, error: 'Not configured.' });
  const { data: plan } = await db.from('memberships').select('name,period').eq('id', md.membershipId).maybeSingle();
  const period = (plan && plan.period) || md.period || 'month';
  const expiresAt = membershipExpiryISO(period);
  const email = md.email || (session.customer_details && session.customer_details.email) || '';

  const r = await grantMembership({ name: md.name, email, phone: md.phone, membershipId: md.membershipId, expiresAt });
  if (r.error) return res.status(500).json({ ok: false, error: r.error });

  res.status(200).json({ ok: true, planName: (plan && plan.name) || 'Membership', period, expiresAt, email: email || null });
}
