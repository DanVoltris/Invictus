// Staff logins: invite an employee from the portal instead of creating them in Supabase by hand.
//
//   POST ?action=invite  { name, phone, role, note } -> creates the login + staff row, TEXTS a set-up link
//   POST ?action=resend  { userId }                  -> texts a new link: set-up if unfinished, else new password
//   POST ?action=status  {}                          -> { [userId]: { pending, lastSignIn, phone } } for the Staff tab
//   POST ?action=claim   { token, email?, password } -> the texted link's own screen: they type their email
//                                                       (first time) and a password; no login needed
//   POST ?action=forgot  { phone }                   -> the login page's "Forgot password?": texts a reset
//                                                       link to that mobile if it is an active staff login's
//   POST ?action=needs-setup {}                      -> { setup: true } while nobody is an admin
//   POST ?action=setup   { name, email, password }   -> creates the first admin; refused once one exists
//
// invite / resend / status need the caller's Supabase JWT (Authorization: Bearer …) and the
// staff.manage capability, checked by staffContext — the same rule the database applies to the
// staff table. needs-setup, setup and claim need no login: setup closes for good the moment an
// active admin exists, and claim needs the secret from the text.
//
// TEXT, NOT EMAIL (for now, by the owner's choice). The admin gives a name and a mobile number —
// never an email. The login is created at once under a placeholder address (PENDING_DOMAIN) so the
// staff row has a user to point at; the texted link opens /admin?staff-invite=<userId>.<secret>,
// (or ?staff-reset= for a new password later), where the person types THEIR email and a password, and that replaces the placeholder. Supabase
// sends nothing. Only a SHA-256 of the secret is kept (user_metadata.staff_invite), with an expiry;
// using it clears it, so a link works once. "Send reset link" makes a fresh one the same way.
import crypto from 'node:crypto';
import { admin, staffContext, staffByUserId, upsertStaff } from '../lib/db.js';
import { notifyStaffInvite } from '../lib/notify.js';

const ROLES = ['admin', 'employee', 'readonly'];
const ROLE_LABEL = { admin: 'an admin', employee: 'an employee', readonly: 'read-only staff' };
const json = (res, code, body) => res.status(code).json(body);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LINK_DAYS = 7;
export const PENDING_DOMAIN = 'staff-invite.invalid';   // .invalid can never be a real address
const isPending = (email) => String(email || '').toLowerCase().endsWith('@' + PENDING_DOMAIN);
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

// "204-555-0123" / "(204) 555 0123" / "+1 204…" → "+12045550123". null when there is nothing usable.
export function mobileE164(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (s.startsWith('+') && d.length >= 8 && d.length <= 15) return `+${d}`;
  return null;
}

// Same order as api/waitlist.js: PUBLIC_BASE_URL, then the request's own origin.
function portalUrl(req) {
  const env = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '';
  const origin = env || (() => {
    const h = req.headers || {};
    const host = h['x-forwarded-host'] || h.host;
    if (!host) return '';
    const proto = h['x-forwarded-proto'] || (/^(localhost|127\.0\.0\.1)/.test(String(host)) ? 'http' : 'https');
    return `${proto}://${host}`;
  })();
  return origin ? `${origin.replace(/\/+$/, '')}/admin` : undefined;
}

const exists = (err) => err && (err.code === 'email_exists' || /already (been )?registered|already exists/i.test(err.message || ''));

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
  const db = admin();
  if (!db) return json(res, 503, { error: 'The database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' });

  const action = String(req.query?.action || '');
  try {
    if (action === 'needs-setup') return await needsSetup(res, db);
    if (action === 'setup') return await setup(req, res, db);
    if (action === 'claim') return await claim(req, res, db);
    if (action === 'forgot') return await forgot(req, res, db);

    const ctx = await staffContext(req.headers.authorization, 'staff.manage');
    if (ctx.error === 'unauthorized') return json(res, 401, { error: 'Your session has ended. Sign in again.' });
    if (ctx.error) return json(res, 403, { error: 'You do not have permission to manage staff. Ask an admin.' });

    if (action === 'invite') return await invite(req, res, db, ctx);
    if (action === 'resend') return await resend(req, res, db);
    if (action === 'status') return await status(res, db);
    return json(res, 400, { error: 'Unknown action.' });
  } catch (err) {
    console.error(`staff?action=${action}:`, err.message);
    return json(res, 500, { error: 'Something went wrong on the server. Check the server log and try again.' });
  }
}

// ---- first run ------------------------------------------------------------------------------
async function activeAdminExists(db) {
  const { data, error } = await db.from('staff').select('user_id').eq('role', 'admin').eq('is_active', true).limit(1);
  return error ? { error } : { exists: !!(data && data.length) };
}

async function needsSetup(res, db) {
  const a = await activeAdminExists(db);
  // No staff table (migration 0024 missing) is not a first run this screen can fix: say no.
  return json(res, 200, { ok: true, setup: !a.error && !a.exists });
}

async function setup(req, res, db) {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const name = String(b.name || '').trim().slice(0, 120) || null;
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Enter a valid email address.' });
  if (password.length < 8) return json(res, 400, { error: 'Use a password of at least 8 characters.' });

  const a = await activeAdminExists(db);
  if (a.error) return json(res, 503, { error: 'Staff roles are not set up in this database. Run supabase/setup.sql first.' });
  if (a.exists) return json(res, 403, { error: 'This portal already has an admin. Sign in, or ask an admin to invite you.' });

  const made = await db.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { ...(name ? { name } : {}), source: 'staff_setup' },
  });
  if (made.error) {
    return exists(made.error)
      ? json(res, 409, { error: 'That email already has a login. Sign in with it, or use Forgot password.' })
      : json(res, 400, { error: `Could not create the login: ${made.error.message}` });
  }
  const userId = made.data.user.id;
  const saved = await upsertStaff({ userId, email, name, role: 'admin', note: 'first admin — created from the sign-in screen', by: userId });
  if (saved.error || saved.unsupported) {
    await db.auth.admin.deleteUser(userId);
    return json(res, 500, { error: `The login was not kept because the staff record failed: ${saved.error || 'staff roles missing'}` });
  }
  return json(res, 200, { ok: true });
}

// ---- the texted link --------------------------------------------------------------------------
// A new secret for this login, stored only as a hash with its expiry, and the link that carries it.
async function newLink(req, db, user, kind) {
  const secret = crypto.randomBytes(24).toString('base64url');
  const meta = { ...(user.user_metadata || {}), staff_invite: { hash: sha(secret), expires: new Date(Date.now() + LINK_DAYS * 864e5).toISOString(), sentAt: new Date().toISOString() } };
  const upd = await db.auth.admin.updateUserById(user.id, { user_metadata: meta });
  if (upd.error) return { error: upd.error.message };
  const base = portalUrl(req);
  // ?staff-invite= asks for their email too (first time); ?staff-reset= only for a new password.
  return { link: `${base || '/admin'}?staff-${kind === 'reset' ? 'reset' : 'invite'}=${encodeURIComponent(`${user.id}.${secret}`)}` };
}

async function textLink({ req, db, user, role, kind, invitedBy }) {
  const phone = mobileE164(user.user_metadata && user.user_metadata.phone);
  const made = await newLink(req, db, user, kind);
  if (made.error) return { error: made.error };
  if (!phone) return { texted: false, link: made.link, textError: 'There is no mobile number on file for them.' };
  const outcome = await notifyStaffInvite({ userId: user.id, phone, link: made.link, kind, invitedBy, roleLabel: ROLE_LABEL[role] });
  if (outcome === 'sent') return { texted: true, phone };
  return { texted: false, phone, link: made.link,
    textError: outcome === 'skipped' ? 'Texting is not set up (Twilio) or the venue details are incomplete.' : 'The text did not go through.' };
}

// ---- invite ---------------------------------------------------------------------------------
async function invite(req, res, db, ctx) {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 120) || null;
  const note = String(b.note || '').trim().slice(0, 200) || null;
  const role = String(b.role || 'employee');
  const phone = mobileE164(b.phone);
  if (!name) return json(res, 400, { error: 'Enter their name.' });
  if (!phone) return json(res, 400, { error: 'Enter their mobile number with the area code, e.g. 204-555-0123 — the invite is texted to it.' });
  if (!ROLES.includes(role)) return json(res, 400, { error: 'Choose a role: admin, employee or read-only.' });
  if (role === 'admin' && ctx.role !== 'admin') return json(res, 403, { error: 'Only an admin can add another admin.' });

  // First person to add staff on a fresh database: record them as the admin they already are, so
  // the bootstrap closes now rather than also making this new employee an admin.
  if (ctx.bootstrap) {
    const me = await upsertStaff({ userId: ctx.user.id, email: ctx.user.email, role: 'admin', note: 'first admin — set up staff', by: ctx.user.id });
    if (me.error) return json(res, 500, { error: `Could not record you as the admin first: ${me.error}` });
  }

  // The login exists from now on, under a placeholder address the person replaces with their own.
  const placeholder = `invite-${crypto.randomBytes(8).toString('hex')}@${PENDING_DOMAIN}`;
  const made = await db.auth.admin.createUser({
    email: placeholder, password: crypto.randomBytes(32).toString('base64url'), email_confirm: true,
    user_metadata: { name, phone, source: 'staff_invite' },
  });
  if (made.error) return json(res, 400, { error: `Could not create the login: ${made.error.message}` });
  const user = made.data.user;

  const saved = await upsertStaff({ userId: user.id, email: null, name, role, note, by: ctx.user.id });
  if (saved.error || saved.unsupported) {
    await db.auth.admin.deleteUser(user.id);   // no orphan login without a role
    return json(res, 500, { error: saved.unsupported
      ? 'Staff roles are not set up in this database. Run supabase/setup.sql, then try again.'
      : `The login was not kept because the staff record failed: ${saved.error}` });
  }
  const invitedBy = (ctx.user.user_metadata && ctx.user.user_metadata.name) || null;
  const sent = await textLink({ req, db, user, role, kind: 'invite', invitedBy });
  if (sent.error) return json(res, 500, { error: `They were added, but the link could not be made: ${sent.error}. Use "Send link" on the staff list.` });
  return json(res, 200, { ok: true, userId: user.id, ...sent });
}

// ---- resend ---------------------------------------------------------------------------------
// Unfinished set-up → a new set-up link. Finished → a link to choose a new password. Always a text.
async function resend(req, res, db) {
  const userId = String((req.body || {}).userId || '');
  const row = await staffByUserId(userId);
  if (!row || row.unsupported) return json(res, 404, { error: 'That person is not on the staff list.' });
  const got = await db.auth.admin.getUserById(userId);
  if (got.error || !got.data?.user) return json(res, 404, { error: 'That login no longer exists in Supabase. Remove them and invite them again.' });
  const u = got.data.user;
  const kind = isPending(u.email) ? 'invite' : 'reset';
  const sent = await textLink({ req, db, user: u, role: row.role, kind });
  if (sent.error) return json(res, 400, { error: `Could not make a new link: ${sent.error}` });
  return json(res, 200, { ok: true, kind, ...sent });
}

// ---- forgot: "Forgot password?" on the staff login ---------------------------------------------
// No login needed — that is the point. The same answer whatever the number, so the page cannot be
// used to find out who works here, and at most one text a minute per login, so it cannot be used
// to flood someone's phone. The link is the one "Send reset link" makes: it works once, for 7 days.
const FORGOT_GAP_MS = 60 * 1000;
async function forgot(req, res, db) {
  const phone = mobileE164((req.body || {}).phone);
  if (!phone) return json(res, 400, { error: 'Enter your mobile number with the area code, e.g. 204-555-0123.' });
  const same = { ok: true, message: 'If that number belongs to a staff login, a text with a link to choose a new password is on its way. The link works once, for 7 days.' };
  const { data: rows, error } = await db.from('staff').select('user_id,role,is_active');
  if (error) { console.error('staff forgot:', error.message); return json(res, 200, same); }
  for (const row of rows || []) {
    if (row.is_active === false) continue;
    const got = await db.auth.admin.getUserById(row.user_id);
    const u = got && got.data && got.data.user;
    if (!u || mobileE164(u.user_metadata && u.user_metadata.phone) !== phone) continue;
    const last = u.user_metadata.staff_invite && Date.parse(u.user_metadata.staff_invite.sentAt);
    if (last && Date.now() - last < FORGOT_GAP_MS) break;
    const sent = await textLink({ req, db, user: u, role: row.role, kind: isPending(u.email) ? 'invite' : 'reset' });
    if (!sent.texted) console.warn(`staff forgot: no text for ${u.id} — ${sent.error || sent.textError}`);
    break;
  }
  return json(res, 200, same);
}

// ---- claim: the screen the texted link opens ---------------------------------------------------
async function claim(req, res, db) {
  const b = req.body || {};
  const [userId, secret] = String(b.token || '').split('.');
  const password = String(b.password || '');
  if (!userId || !secret) return json(res, 400, { error: 'That link is not complete. Ask whoever added you to send it again.' });
  if (password.length < 8) return json(res, 400, { error: 'Use a password of at least 8 characters.' });

  const got = await db.auth.admin.getUserById(userId);
  const u = got && got.data && got.data.user;
  const inv = u && u.user_metadata && u.user_metadata.staff_invite;
  const dead = { error: 'That link has expired or has already been used. Ask whoever added you to send a new one.' };
  if (!u || !inv || !inv.hash) return json(res, 400, dead);
  const want = Buffer.from(inv.hash, 'hex'), gotHash = Buffer.from(sha(secret), 'hex');
  if (want.length !== gotHash.length || !crypto.timingSafeEqual(want, gotHash)) return json(res, 400, dead);
  if (Date.parse(inv.expires) < Date.now()) return json(res, 400, dead);
  const row = await staffByUserId(userId);
  if (!row || row.unsupported || row.is_active === false) return json(res, 403, { error: 'This login no longer has staff access. Ask an admin.' });

  // First time: they choose the email they sign in with. Afterwards it is already theirs.
  const first = isPending(u.email);
  const email = first ? String(b.email || '').trim().toLowerCase() : u.email;
  if (first && !EMAIL_RE.test(email)) return json(res, 400, { error: 'Enter the email address you want to sign in with.' });
  if (first && email.endsWith('@' + PENDING_DOMAIN)) return json(res, 400, { error: 'Enter your own email address.' });

  const { staff_invite: _used, ...meta } = u.user_metadata || {};
  const upd = await db.auth.admin.updateUserById(userId, { ...(first ? { email, email_confirm: true } : {}), password, user_metadata: meta });
  if (upd.error) {
    if (exists(upd.error)) {
      // Staff and customer logins stay separate (My Account refuses staff logins), so a customer's
      // own email cannot become their staff login too.
      const { data: cust } = await db.from('customers').select('id').ilike('email', email).not('user_id', 'is', null).limit(1);
      return json(res, 409, { error: cust && cust.length
        ? 'That email is already your My Account login. Use a different email for your staff login — the two stay separate.'
        : 'That email already has a login here. Use a different one, or ask an admin.' });
    }
    return json(res, 400, { error: `Could not finish setting up: ${upd.error.message}` });
  }
  if (first) await upsertStaff({ userId, email, name: row.name, role: row.role, isActive: row.is_active !== false, note: row.note });
  return json(res, 200, { ok: true, email, first });
}

// ---- status ---------------------------------------------------------------------------------
async function status(res, db) {
  const { data: rows, error } = await db.from('staff').select('user_id');
  if (error) return json(res, 500, { error: `Could not read staff: ${error.message}` });
  const out = {};
  await Promise.all((rows || []).map(async ({ user_id }) => {
    const { data } = await db.auth.admin.getUserById(user_id);
    const u = data && data.user;
    out[user_id] = u
      ? { pending: isPending(u.email) || !u.email_confirmed_at, lastSignIn: u.last_sign_in_at || null, phone: (u.user_metadata && u.user_metadata.phone) || null }
      : { missing: true };
  }));
  return json(res, 200, { ok: true, staff: out });
}
