import { admin } from '../lib/db.js';

// Public list of membership plans for the /membership page (no customer data).
export default async function handler(req, res) {
  const db = admin();
  if (!db) return res.status(200).json({ plans: [] });
  const { data, error } = await db.from('memberships')
    .select('id,name,price_cents,period,discount_pct,perks,color,sort').order('sort');
  if (error) { console.error('memberships:', error.message); return res.status(200).json({ plans: [] }); }
  res.status(200).json({ plans: data || [] });
}
