import Stripe from 'stripe';
import { stripeStatus, normalizeSettings, membershipExpiryISO } from '../lib/booking.js';
import { getSettings, admin, grantMembership } from '../lib/db.js';

// One function for the whole membership flow (kept as a single serverless function to stay within
// the Hobby-plan limit). Dispatch on ?action=  —  list | checkout | confirm.
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((e || '').trim());

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || '';
  if (req.method === 'GET' || action === 'list') return listPlans(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (action === 'checkout') return createCheckout(req, res);
  if (action === 'confirm') return confirmPurchase(req, res);
  return res.status(400).json({ error: 'Unknown action' });
}

// GET ?action=list — public list of plans for the /membership page (no customer data).
async function listPlans(_req, res) {
  const db = admin();
  if (!db) return res.status(200).json({ plans: [] });
  const { data, error } = await db.from('memberships')
    .select('id,name,price_cents,period,discount_pct,perks,color,sort').order('sort');
  if (error) { console.error('memberships list:', error.message); return res.status(200).json({ plans: [] }); }
  res.status(200).json({ plans: data || [] });
}

// POST ?action=checkout — start a hosted Stripe Checkout for a one-time membership purchase.
async function createCheckout(req, res) {
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
    console.error('membership checkout:', err.message);
    res.status(400).json({ error: err.message });
  }
}

// POST ?action=confirm — re-verify the paid session and link the plan to the customer (idempotent).
async function confirmPurchase(req, res) {
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
