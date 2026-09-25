// Customer accounts: prove the phone, then sign in or sign up.
//
// FLOW
//   1. POST ?action=start    { phone }                     -> always "we sent a code"
//   2. POST ?action=verify   { phone, code }               -> { token, hasAccount, email? }
//   3a. POST ?action=register{ token, email, password }    -> creates the login, links the row
//   3b. the browser signs in with Supabase Auth directly using email + password
//   4. POST ?action=feedback { bookingId, rating, comment, skipped }  (Authorization: Bearer <session>)
//      -> rates a finished session on My Account (migration 0027)
//   5. POST ?action=cards | card-setup | card-remove { paymentMethodId }   (Authorization: Bearer <session>)
//      -> the signed-in customer's saved cards, a SetupIntent to add one, or removing one (migration 0029)
//
// TWO RULES THIS FILE EXISTS TO ENFORCE
//
//   A phone number must be PROVEN before it links to anything. Customer rows imported from the
//   old system carry prepaid hours and gift-card balances; if typing a number were
//   enough to claim one, knowing somebody's number would be enough to take their balance.
//
//   Whether a number is known is NEVER disclosed before the code is entered. ?action=start gives
//   the same answer for every number in the world. Otherwise this endpoint is a directory: feed
//   it numbers, learn who is a customer. The answer comes back from ?action=verify, which only
//   somebody holding the phone can reach.
import crypto from 'node:crypto';
import { getSettings, admin, customerHoursByContact, normPhone, saveBookingFeedback,
  accountCustomerForRequest, stripeCustomerIdFor, listSavedCards, removeSavedCard, cardSetupIntent } from '../lib/db.js';
import { stripeStatus, stripeClient } from '../lib/booking.js';
import { enqueue } from '../lib/notify.js';

const CODE_TTL_MIN = 10;        // a code is good for ten minutes
const TOKEN_TTL_MIN = 20;       // the proof it produces, twenty
const MAX_ATTEMPTS = 5;         // wrong guesses per code before it dies
const RESEND_COOLOFF_S = 45;    // no code-bombing a number
const MAX_SENDS_PER_HOUR = 5;

const json = (res, code, body) => res.status(code).json(body);
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
// 6 digits, uniform. crypto.randomInt avoids the modulo bias Math.random()%1e6 would introduce.
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

function callerKey(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'unknown';
}

// E.164-ish. We keep the typed form for display and match on digits only, the same way
// lib/db.js does, because stored numbers vary in formatting.
function cleanPhone(v) {
  const n = normPhone(v);
  if (!n || n.length < 7 || n.length > 15) return null;
  return n;
}

export default async function handler(req, res) {
  const action = (req.query?.action || '').toString();
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const db = admin();
  if (!db) return json(res, 503, { error: 'Accounts are not available right now.' });

  try {
    if (action === 'start')    return await start(req, res, db);
    if (action === 'verify')   return await verify(req, res, db);
    if (action === 'register') return await register(req, res, db);
    if (action === 'feedback') return await feedback(req, res, db);
    if (action === 'cards' || action === 'card-setup' || action === 'card-remove') return await cards(req, res, action);
    return json(res, 400, { error: 'Unknown action.' });
  } catch (err) {
    console.error(`account?action=${action}:`, err.message);
    return json(res, 500, { error: 'Something went wrong. Please try again.' });
  }
}

// ---- 1. send a code -------------------------------------------------------
async function start(req, res, db) {
  const phone = cleanPhone((req.body || {}).phone);
  // An unparseable number is a client-side mistake, not an enumeration probe, so it may say so.
  if (!phone) return json(res, 400, { error: 'Enter a valid phone number, including country code.' });

  const now = Date.now();
  const { data: existing } = await db.from('phone_codes').select('*').eq('phone', phone).maybeSingle();

  if (existing) {
    const since = (now - Date.parse(existing.last_sent)) / 1000;
    if (since < RESEND_COOLOFF_S) {
      return json(res, 429, { error: `Wait ${Math.ceil(RESEND_COOLOFF_S - since)}s before asking for another code.` });
    }
    const freshHour = (now - Date.parse(existing.created_at)) < 3600e3;
    if (freshHour && existing.sent_count >= MAX_SENDS_PER_HOUR) {
      return json(res, 429, { error: 'Too many codes requested for that number. Try again later, or call the shop.' });
    }
  }

  const code = newCode();
  const row = {
    phone, code_hash: sha(code),
    expires_at: new Date(now + CODE_TTL_MIN * 60e3).toISOString(),
    attempts: 0,
    sent_count: existing && (now - Date.parse(existing.created_at)) < 3600e3 ? existing.sent_count + 1 : 1,
    last_sent: new Date(now).toISOString(),
    created_at: existing && (now - Date.parse(existing.created_at)) < 3600e3 ? existing.created_at : new Date(now).toISOString(),
  };
  const { error } = await db.from('phone_codes').upsert(row, { onConflict: 'phone' });
  if (error) { console.error('phone_codes upsert:', error.message); return json(res, 500, { error: 'Could not send a code. Please try again.' }); }

  // Delivery is best-effort and deliberately NOT awaited into the response shape: whether the SMS
  // provider is configured must not change what an attacker can observe. With no Twilio
  // credentials lib/notify.js logs the code and no-ops, which is how this is tested locally.
  const settings = await getSettings();
  await enqueue({
    channel: 'sms', recipient: phone, template: 'account.code',
    payload: { code, minutes: CODE_TTL_MIN, venue: (settings && settings.venue_name) || 'Invictus Golf' },
    dedupeKey: `account_code:${phone}:${row.last_sent}`,
  });

  // Same answer for every number on earth.
  return json(res, 200, { ok: true, sent: true, expiresInMinutes: CODE_TTL_MIN });
}

// ---- 2. check it, and only now say whether they have an account -----------
async function verify(req, res, db) {
  const b = req.body || {};
  const phone = cleanPhone(b.phone);
  const code = String(b.code || '').replace(/\D/g, '');
  if (!phone || code.length !== 6) return json(res, 400, { error: 'Enter the 6-digit code we sent you.' });

  const key = callerKey(req);
  const { count: recentFails } = await db.from('phone_attempts')
    .select('*', { count: 'exact', head: true })
    .eq('key', key).eq('ok', false).gte('at', new Date(Date.now() - 3600e3).toISOString());
  if ((recentFails || 0) >= 20) {
    return json(res, 429, { error: 'Too many attempts. Wait a while, or call the shop.' });
  }

  const { data: rec } = await db.from('phone_codes').select('*').eq('phone', phone).maybeSingle();
  const bad = async () => {
    await db.from('phone_attempts').insert({ key, ok: false });
    return json(res, 400, { error: 'That code is wrong or has expired. Ask for a new one.' });
  };
  if (!rec) return bad();
  if (Date.parse(rec.expires_at) < Date.now()) { await db.from('phone_codes').delete().eq('phone', phone); return bad(); }
  if (rec.attempts >= MAX_ATTEMPTS) { await db.from('phone_codes').delete().eq('phone', phone); return bad(); }

  // Constant-time compare so the check cannot be timed character by character.
  const want = Buffer.from(rec.code_hash, 'hex');
  const got = Buffer.from(sha(code), 'hex');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
    await db.from('phone_codes').update({ attempts: rec.attempts + 1 }).eq('phone', phone);
    return bad();
  }

  // Correct. Burn the code — one use, always.
  await db.from('phone_codes').delete().eq('phone', phone);
  await db.from('phone_attempts').insert({ key, ok: true });

  const token = crypto.randomBytes(32).toString('hex');
  await db.from('phone_verifications').insert({
    token: sha(token), phone,
    expires_at: new Date(Date.now() + TOKEN_TTL_MIN * 60e3).toISOString(),
  });

  // Now — and only now, to somebody who holds the phone — say what we know.
  const cust = await customerHoursByContact({ phone });
  const hasAccount = !!(cust && cust.user_id);
  return json(res, 200, {
    ok: true, token, hasAccount,
    // Enough to prefill the sign-in box; never the whole address for an account they cannot open.
    emailHint: hasAccount && cust.email ? maskEmail(cust.email) : null,
    knownCustomer: !!cust,       // a shop record exists, but nobody has claimed it yet
    name: cust ? cust.name : null,
  });
}

const maskEmail = (e) => {
  const [u, d] = String(e).split('@');
  if (!d) return null;
  return `${u.slice(0, 2)}${'•'.repeat(Math.max(1, u.length - 2))}@${d}`;
};

// ---- 3. create the login and link the row --------------------------------
async function register(req, res, db) {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const token = String(b.token || '');
  if (!token) return json(res, 400, { error: 'Verify your phone number first.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'Enter a valid email address.' });
  if (password.length < 8) return json(res, 400, { error: 'Use a password of at least 8 characters.' });

  const { data: v } = await db.from('phone_verifications').select('*').eq('token', sha(token)).maybeSingle();
  if (!v || v.used_at || Date.parse(v.expires_at) < Date.now()) {
    return json(res, 400, { error: 'That verification has expired. Start again with your phone number.' });
  }
  // Spend the proof before doing anything else, so a replay cannot create a second account.
  const { data: spent } = await db.from('phone_verifications')
    .update({ used_at: new Date().toISOString() })
    .eq('token', sha(token)).is('used_at', null).select();
  if (!spent || !spent.length) return json(res, 400, { error: 'That verification has already been used.' });

  const phone = v.phone;
  const existing = await customerHoursByContact({ phone });
  if (existing && existing.user_id) {
    return json(res, 409, { error: 'That number already has an account — sign in instead.' });
  }

  const made = await db.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { phone, source: 'customer_signup' },
  });
  if (made.error) {
    const dup = /already|exists|registered/i.test(made.error.message);
    return json(res, dup ? 409 : 400, {
      error: dup ? 'That email already has an account — sign in instead.' : made.error.message,
    });
  }
  const userId = made.data.user.id;

  // Link. The phone is proven at this point, which is the whole reason auto-linking to an
  // existing record — and the balance on it — is safe here and would not have been earlier.
  let customerId = existing ? existing.id : null;
  if (existing) {
    const { error } = await db.from('customers')
      .update({ user_id: userId, email: existing.email || email, account_created_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) {
      await db.auth.admin.deleteUser(userId);   // do not leave an orphan login behind
      console.error('link customer:', error.message);
      return json(res, 500, { error: 'Could not finish setting up your account. Please try again.' });
    }
  } else {
    const { data, error } = await db.from('customers')
      .insert({ name: b.name || null, email, phone, user_id: userId, account_created_at: new Date().toISOString() })
      .select().single();
    if (error) {
      await db.auth.admin.deleteUser(userId);
      console.error('create customer:', error.message);
      return json(res, 500, { error: 'Could not finish setting up your account. Please try again.' });
    }
    customerId = data.id;
  }

  // Address and career (migration 0027), both optional. A separate update after the account is
  // linked, so a database without those columns still finishes the sign-up.
  const profile = {};
  const address = String(b.address || '').trim().slice(0, 200);
  const career = String(b.career || '').trim().slice(0, 120);
  if (address) profile.address = address;
  if (career) profile.career = career;
  if (customerId && Object.keys(profile).length) {
    const { error } = await db.from('customers').update(profile).eq('id', customerId);
    if (error) console.warn('register: address/career not saved —', error.message);
  }

  return json(res, 200, {
    ok: true, email, customerId,
    linkedExisting: !!existing,
    // What they just inherited, so the page can say so rather than silently showing a balance.
    inherited: existing ? {
      // No `points` here: loyalty points are retired and demo/account.html no longer shows them.
      hoursMin: existing.hours_balance_min || 0,
      membership: !!existing.membership_id,
    } : null,
  });
}

// ---- 4. feedback on a finished session ---------------------------------------
// The signed-in customer is whoever the session token says; the booking checks (theirs, went
// ahead, over) live in lib/db.js saveBookingFeedback, shared with the local no-login route.
async function feedback(req, res, db) {
  const token = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const who = token ? await db.auth.getUser(token) : null;
  const user = who && !who.error && who.data && who.data.user;
  if (!user) return json(res, 401, { error: 'Your session has ended. Sign in again.' });
  const { data: c } = await db.from('customers').select('id,email,phone').eq('user_id', user.id).maybeSingle();
  if (!c) return json(res, 403, { error: 'Your login is not linked to a customer record yet. Call the shop and we will sort it out.' });
  const b = req.body || {};
  const r = await saveBookingFeedback({ contact: { email: c.email, phone: c.phone }, customerId: c.id,
    bookingId: b.bookingId, rating: b.rating, comment: b.comment, skipped: b.skipped });
  return r.ok ? json(res, 200, r) : json(res, r.code || 400, { error: r.error });
}

// ---- 5. saved cards ----------------------------------------------------------------------------
// Only for a proven customer (lib/db.js accountCustomerForRequest). Card details stay at Stripe.
async function cards(req, res, action) {
  if (!stripeStatus(process.env).enabled) return json(res, 503, { error: 'Card payments aren’t set up yet — please call the shop.' });
  const cust = await accountCustomerForRequest(req);
  if (!cust) return json(res, 401, { error: 'Sign in to manage your saved cards.' });
  const stripe = stripeClient(process.env);
  if (action === 'cards') return json(res, 200, { ok: true, cards: await listSavedCards(stripe, cust.stripe_customer_id) });

  // Removing a card needs an existing Stripe link — nobody without one has a card to remove, and
  // creating a Stripe Customer just to say 404 would be a pointless write.
  if (action === 'card-remove' && !cust.stripe_customer_id) return json(res, 404, { error: 'That card isn’t on your account.' });
  const stripeCustomerId = await stripeCustomerIdFor(stripe, cust);
  if (!stripeCustomerId) return json(res, 503, { error: 'Saved cards aren’t switched on yet. Please try again later.' });
  if (action === 'card-setup') return json(res, 200, { ok: true, clientSecret: await cardSetupIntent(stripe, stripeCustomerId) });
  const r = await removeSavedCard(stripe, stripeCustomerId, (req.body || {}).paymentMethodId);
  return r.ok ? json(res, 200, r) : json(res, r.code || 400, { error: r.error });
}
