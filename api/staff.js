// Staff logins: invite an employee from the portal instead of creating them in Supabase by hand.
//
//   POST ?action=invite  { name, email, role, note }  -> creates the login + staff row, emails an invite
//   POST ?action=resend  { userId }                   -> invite again, or a password reset once accepted
//   POST ?action=status  {}                           -> { [userId]: { pending, lastSignIn } } for the Staff tab
//   POST ?action=needs-setup {}                       -> { setup: true } while nobody is an admin
//   POST ?action=setup   { name, email, password }    -> creates the first admin; refused once one exists
//
// invite / resend / status need the caller's Supabase JWT (Authorization: Bearer …) and the
// staff.manage capability, checked by staffContext — the same rule the database applies to the
// staff table. needs-setup and setup are the first-run door on the sign-in screen: they need no
// login, and setup closes for good the moment an active admin exists.
//
// EMAIL. Supabase's built-in mailer only delivers to addresses on the project's team, two an hour.
// So each send is tried, and when Supabase cannot deliver, the response carries the link itself
// for the admin to pass on. Set up custom SMTP in Supabase (Authentication → Emails) and the
// fallback simply stops being needed. Links land on /admin, which must be listed under
// Authentication → URL Configuration → Redirect URLs.
import { admin, staffContext, staffByUserId, upsertStaff } from '../lib/db.js';

const ROLES = ['admin', 'employee', 'readonly'];
const json = (res, code, body) => res.status(code).json(body);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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

// ---- invite ---------------------------------------------------------------------------------
async function invite(req, res, db, ctx) {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const name = String(b.name || '').trim().slice(0, 120) || null;
  const note = String(b.note || '').trim().slice(0, 200) || null;
  const role = String(b.role || 'employee');
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'Enter a valid email address.' });
  if (!ROLES.includes(role)) return json(res, 400, { error: 'Choose a role: admin, employee or read-only.' });
  if (role === 'admin' && ctx.role !== 'admin') return json(res, 403, { error: 'Only an admin can add another admin.' });
  if (email === String(ctx.user.email || '').toLowerCase()) return json(res, 400, { error: 'That is your own login.' });

  // First person to add staff on a fresh database: record them as the admin they already are, so
  // the bootstrap closes now rather than also making this new employee an admin.
  if (ctx.bootstrap) {
    const me = await upsertStaff({ userId: ctx.user.id, email: ctx.user.email, role: 'admin', note: 'first admin — set up staff', by: ctx.user.id });
    if (me.error) return json(res, 500, { error: `Could not record you as the admin first: ${me.error}` });
  }

  const redirectTo = portalUrl(req);
  const data = name ? { name } : undefined;
  let userId = null, created = false, emailed = false, link = null, existing = false;

  const sent = await db.auth.admin.inviteUserByEmail(email, { redirectTo, data });
  if (!sent.error) {
    userId = sent.data.user.id; created = true; emailed = true;
  } else if (exists(sent.error)) {
    // Already has a login (a customer account, or someone who left and is coming back). Give that
    // login the role, and a link to choose a new password in case they never had one.
    const r = await db.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
    if (r.error) return json(res, 400, { error: `That email already has a login, but it could not be looked up: ${r.error.message}` });
    userId = r.data.user.id; link = r.data.properties?.action_link || null; existing = true;
    const already = await staffByUserId(userId);
    if (already && !already.unsupported) return json(res, 409, { error: 'That person is already on the staff list.' });
  } else {
    // Supabase could not send the email. Create the login anyway and hand the link back.
    console.warn('staff invite: email not sent —', sent.error.message);
    const r = await db.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo, data } });
    if (r.error) return json(res, 400, { error: `Could not create the login: ${r.error.message}` });
    userId = r.data.user.id; created = true; link = r.data.properties?.action_link || null;
  }

  const saved = await upsertStaff({ userId, email, name, role, note, by: ctx.user.id });
  if (saved.error || saved.unsupported) {
    if (created) await db.auth.admin.deleteUser(userId);   // no orphan login without a role
    return json(res, 500, { error: saved.unsupported
      ? 'Staff roles are not set up in this database. Run supabase/setup.sql, then try again.'
      : `The login was not kept because the staff record failed: ${saved.error}` });
  }
  return json(res, 200, { ok: true, userId, emailed, link, existing, redirectTo });
}

// ---- resend ---------------------------------------------------------------------------------
async function resend(req, res, db) {
  const userId = String((req.body || {}).userId || '');
  const row = await staffByUserId(userId);
  if (!row || row.unsupported) return json(res, 404, { error: 'That person is not on the staff list.' });
  const got = await db.auth.admin.getUserById(userId);
  if (got.error || !got.data?.user) return json(res, 404, { error: 'That login no longer exists in Supabase. Remove them and invite them again.' });
  const u = got.data.user;
  const redirectTo = portalUrl(req);
  const pending = !u.email_confirmed_at;

  const sent = pending
    ? await db.auth.admin.inviteUserByEmail(u.email, { redirectTo })
    : await db.auth.resetPasswordForEmail(u.email, { redirectTo });
  if (!sent.error) return json(res, 200, { ok: true, emailed: true, kind: pending ? 'invite' : 'reset' });

  console.warn('staff resend: email not sent —', sent.error.message);
  const r = await db.auth.admin.generateLink({ type: pending ? 'invite' : 'recovery', email: u.email, options: { redirectTo } });
  if (r.error) return json(res, 400, { error: `Could not make a new link: ${r.error.message}` });
  return json(res, 200, { ok: true, emailed: false, kind: pending ? 'invite' : 'reset', link: r.data.properties?.action_link || null });
}

// ---- status ---------------------------------------------------------------------------------
async function status(res, db) {
  const { data: rows, error } = await db.from('staff').select('user_id');
  if (error) return json(res, 500, { error: `Could not read staff: ${error.message}` });
  const out = {};
  await Promise.all((rows || []).map(async ({ user_id }) => {
    const { data } = await db.auth.admin.getUserById(user_id);
    const u = data && data.user;
    out[user_id] = u ? { pending: !u.email_confirmed_at, lastSignIn: u.last_sign_in_at || null } : { missing: true };
  }));
  return json(res, 200, { ok: true, staff: out });
}
