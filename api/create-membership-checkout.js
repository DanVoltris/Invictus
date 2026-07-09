import Stripe from 'stripe';
import { stripeStatus, normalizeSettings } from '../lib/booking.js';
import { getSettings, admin } from '../lib/db.js';

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((e || '').trim());

// Start a hosted Stripe Checkout for a one-time membership purchase. On success Stripe sends the
// customer back to /membership?success=1&session_id=… where confirm-membership links it to them.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { enabled, secretKey } = stripeStatus(process.env);
  if (!enabled) return res.status(503).json({ error: 'Online membership purchase isn’t available right now — please call the shop.' });

  const { membershipId, name, email, phone } = req.body || {};
  if (!membershipId) return res.status(400).json({ error: 'Please choose a plan.' });
  if (!validEmail(email)) return res.status(400).json({ error: 'A valid email is required so we can link your membership.' });

  const db = admin();
  if (!db) return res.status(503).json({ error: 'Not configured.' });
  const { data: plan } = await db.from('memberships').select('*').eq('id', membershipId).maybeSingle();
  if (!plan) return res.status(404).json({ error: 'That plan was not found.' });
  if (!(plan.price_cents > 0)) return res.status(400).json({ error: 'This plan can’t be purchased online — please contact the shop.' });

  const settings = normalizeSettings(await getSettings());
  const origin = req.headers.origin || `https://${req.headers.host}`;
  const stripe = new Stripe(secretKey);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: settings.currency,
          product_data: { name: `${plan.name} membership`, description: plan.perks || undefined },
          unit_amount: plan.price_cents,
        },
        quantity: 1,
      }],
      customer_email: (email || '').trim() || undefined,
      metadata: {
        kind: 'membership', membershipId, period: plan.period,
        name: (name || '').trim(), email: (email || '').trim(), phone: (phone || '').trim(),
      },
      success_url: `${origin}/membership?success=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/membership?canceled=1`,
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-membership-checkout:', err.message);
    res.status(400).json({ error: err.message });
  }
}
