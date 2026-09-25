#!/usr/bin/env node
// Live verification for staff accounts and roles (migration 0024).
//
// Runs against the REAL project in SUPABASE_URL. It signs real users in with the ANON key —
// the same key and the same code path demo/admin.html uses — and asserts what each of them can
// and cannot do through PostgREST, which is the only honest way to test a policy.
//
// SAFETY, because this touches a production project:
//   · It NEVER touches john@gmail.com (or whatever settings.staff->>'owner_email' says). It
//     reads that row to confirm the owner is still an active admin, and that is all.
//   · Every user, booking, customer and audit row it makes is prefixed ZZTEST and deleted in a
//     finally block. The last thing it prints is proof that nothing of its own is left — which
//     matters more than usual here, because migration 0024 seeds EVERY auth user as an admin,
//     so a leaked test login would become an admin the next time that file is run.
//   · Before migration 0024 is applied it does not fail: it runs the same probes and reports
//     the pre-migration state, which is the exposure the migration exists to close.
//
//   node scripts/verify-staff-roles.mjs
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { admin, staffContext, listStaff, auditLog, recordAudit, rolePermissions } from '../lib/db.js';

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const db = admin();
if (!db || !ANON) {
  console.error('SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

const rnd = Math.random().toString(36).slice(2, 8);
const PASSWORD = `ZZtest-${rnd}-${Math.random().toString(36).slice(2, 10)}`;
const users = [];            // { role, email, id, client }
let bookingId = null, customerId = null;

let fails = 0, checks = 0;
const chk = (name, ok, detail = '') => {
  checks++; if (!ok) fails++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  →  ${detail}` : ''}`);
};
const code = (e) => (e ? (e.code || '') : '');
const short = (e) => (e ? String(e.message || '').replace(/\s+/g, ' ').slice(0, 80) : 'no error');

// ---------------------------------------------------------------- schema probe
const probe = async (t) => { const { error } = await db.from(t).select('*').limit(1); return !error; };
const HAVE_0024 = (await probe('staff')) && (await probe('role_permissions')) && (await probe('audit_log'));
console.log(`\nmigration 0024: ${HAVE_0024 ? 'APPLIED' : 'NOT APPLIED'} to ${URL}`);
if (!HAVE_0024) {
  console.log('  → running the PRE-migration baseline instead. Every "expected" below describes');
  console.log('    what happens TODAY; the same script re-run after applying 0024 asserts the fix.');
}

const anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const BAY = await db.from('settings').select('bays').eq('id', 1).single()
  .then((r) => (r.data?.bays?.[0]?.id) || 'B1');
const DATE = '2031-12-30';                       // far past anything real, so no exclusion clash

try {
  // ------------------------------------------------------------- 1) anonymous
  console.log('\n1) ANONYMOUS client (the key /api/config hands every visitor)');
  {
    // "0 rows" is not proof of a policy — an empty table returns 0 rows too. Compare what the
    // anon key sees against what the service-role key sees, and only judge tables with content.
    const NARROWED = ['settings', 'memberships', 'price_templates', 'point_transactions',
                      'bay_categories', 'schedule_overrides', 'schedule_templates',
                      'booking_statuses', 'tags', 'hour_cards', 'hour_transactions'];
    const exposed = [];
    for (const t of NARROWED) {
      const seen = (await anon.from(t).select('*', { count: 'exact', head: true })).count ?? 0;
      const real = (await db.from(t).select('*', { count: 'exact', head: true })).count ?? 0;
      if (real > 0 && seen > 0) exposed.push(`${t}(${seen})`);
    }
    chk('anon cannot read the manager tables', exposed.length === 0,
        exposed.length ? `READABLE: ${exposed.join(', ')} — migration 0018 is not applied here` : 'none readable');
    const b = await anon.from('bookings')
      .insert({ bay_id: BAY, booking_date: DATE, start_min: 600, end_min: 660, customer_name: 'ZZTEST anon' })
      .select('id');
    chk('anon cannot write bookings', !!b.error && code(b.error) === '42501', `${code(b.error)} ${short(b.error)}`);
    const st = await anon.from('staff').select('*').limit(1);
    if (HAVE_0024) chk('anon cannot read staff', !st.error ? (st.data || []).length === 0 : true,
                       st.error ? short(st.error) : `${(st.data || []).length} rows`);
  }

  // --------------------------------------------- 2) sign in as the live manager
  console.log('\n2) THE LIVE MANAGER (read-only inspection — this account is never modified)');
  {
    const owner = await db.from('settings').select('staff').eq('id', 1).single()
      .then((r) => (r.data?.staff?.owner_email) || 'john@gmail.com').catch(() => 'john@gmail.com');
    const list = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
    const ownerUser = (list.data?.users || []).find((u) => (u.email || '').toLowerCase() === owner.toLowerCase());
    chk(`auth user ${owner} exists`, !!ownerUser, ownerUser ? ownerUser.id : 'not found');
    if (HAVE_0024 && ownerUser) {
      const row = await db.from('staff').select('*').eq('user_id', ownerUser.id).maybeSingle();
      chk(`${owner} is an ACTIVE ADMIN in public.staff`,
          !!row.data && row.data.role === 'admin' && row.data.is_active === true,
          row.data ? `role=${row.data.role} active=${row.data.is_active}` : 'no staff row');
    }
    const all = await db.from('staff').select('user_id').eq('role', 'admin').eq('is_active', true);
    if (HAVE_0024) chk('at least one active admin exists', (all.data || []).length > 0, `${(all.data || []).length} admin(s)`);
  }

  // ------------------------------------------- 3) make three signed-in identities
  console.log('\n3) SIGNED-IN identities (created here, signed in with the anon key, deleted at the end)');
  for (const role of ['admin', 'employee', 'readonly', 'nostaff']) {
    const email = `zztest-${role}-${rnd}@invictus.test`;
    const made = await db.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (made.error) { chk(`create ${role} login`, false, short(made.error)); continue; }
    if (HAVE_0024 && role !== 'nostaff') {
      const up = await db.from('staff').insert({
        user_id: made.data.user.id, email, name: `ZZTEST ${role}`, role,
        note: 'created by scripts/verify-staff-roles.mjs',
      });
      if (up.error) chk(`staff row for ${role}`, false, short(up.error));
    }
    const client = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: sess, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    chk(`sign in as ${role} with the anon key`, !error, error ? short(error) : email);
    users.push({ role, email, id: made.data.user.id, client, token: sess?.session?.access_token || null });
  }
  const as = (r) => (users.find((u) => u.role === r) || {}).client;

  // a real booking + customer for the write tests to aim at
  const seed = await db.from('bookings').insert({
    bay_id: BAY, booking_date: DATE, start_min: 480, end_min: 540,
    customer_name: 'ZZTEST seed', amount_cents: 2500, source: 'manager', status: 'blocked',
  }).select('id').single();
  bookingId = seed.data?.id || null;
  const cust = await db.from('customers').insert({ name: 'ZZTEST roles', email: `zztest-cust-${rnd}@invictus.test` })
    .select('id').single();
  customerId = cust.data?.id || null;
  chk('test fixtures created', !!bookingId && !!customerId, `booking=${bookingId ? 'ok' : seed.error?.message} customer=${customerId ? 'ok' : cust.error?.message}`);

  // --------------------------------------------------------------- 4) the matrix
  const expectDenied = HAVE_0024;    // before 0024, "to authenticated using (true)" allows all of it

  console.log('\n4) READS');
  for (const r of ['admin', 'employee', 'readonly', 'nostaff']) {
    const c = as(r); if (!c) continue;
    const s = await c.from('bookings').select('id').limit(1);
    const rows = (s.data || []).length;
    const allowed = r !== 'nostaff' || !expectDenied;
    chk(`${r.padEnd(8)} read bookings ${allowed ? 'ALLOWED' : 'denied'}`,
        allowed ? rows > 0 : rows === 0, s.error ? short(s.error) : `${rows} row(s)`);
  }

  console.log('\n5) WRITES — bookings (employee work)');
  for (const r of ['admin', 'employee', 'readonly', 'nostaff']) {
    const c = as(r); if (!c) continue;
    const allowed = !expectDenied || r === 'admin' || r === 'employee';
    const ins = await c.from('bookings')
      .insert({ bay_id: BAY, booking_date: DATE, start_min: 700 + users.findIndex((u) => u.role === r) * 30,
                end_min: 720 + users.findIndex((u) => u.role === r) * 30, customer_name: `ZZTEST ${r}`, status: 'blocked' })
      .select('id');
    const ok = allowed ? !ins.error : (!!ins.error && code(ins.error) === '42501');
    chk(`${r.padEnd(8)} insert booking ${allowed ? 'ALLOWED' : 'denied'}`, ok, `${code(ins.error)} ${short(ins.error)}`);
  }

  console.log('\n6) WRITES — the price on an existing booking (money)');
  for (const r of ['admin', 'employee', 'readonly']) {
    const c = as(r); if (!c || !bookingId) continue;
    const allowed = !expectDenied || r === 'admin';
    const up = await c.from('bookings').update({ amount_cents: 999 }).eq('id', bookingId).select('id');
    // employee CAN see the row (booking.write) so the guard trigger raises 42501;
    // readonly cannot see it at all, so RLS just filters it and 0 rows come back.
    const ok = allowed ? (!up.error && (up.data || []).length === 1)
                       : (!!up.error && code(up.error) === '42501') || (up.data || []).length === 0;
    chk(`${r.padEnd(8)} change amount_cents ${allowed ? 'ALLOWED' : 'denied'}`, ok,
        up.error ? `${code(up.error)} ${short(up.error)}` : `${(up.data || []).length} row(s)`);
  }

  console.log('\n7) WRITES — the rate card (setup)');
  for (const r of ['admin', 'employee', 'readonly']) {
    const c = as(r); if (!c) continue;
    const allowed = !expectDenied || r === 'admin';
    const cur = await db.from('settings').select('min_mins').eq('id', 1).single();
    const up = await c.from('settings').update({ min_mins: cur.data.min_mins }).eq('id', 1).select('id');
    const ok = allowed ? (!up.error && (up.data || []).length === 1)
                       : (!!up.error && code(up.error) === '42501') || (up.data || []).length === 0;
    chk(`${r.padEnd(8)} update settings ${allowed ? 'ALLOWED' : 'denied'}`, ok,
        up.error ? `${code(up.error)} ${short(up.error)}` : `${(up.data || []).length} row(s)`);
  }

  console.log('\n8) WRITES — adjust_points() (SECURITY DEFINER: RLS does not apply, the guard trigger does)');
  for (const r of ['admin', 'employee', 'readonly']) {
    const c = as(r); if (!c || !customerId) continue;
    const allowed = !expectDenied || r === 'admin';
    const rpc = await c.rpc('adjust_points', {
      p_customer: customerId, p_delta: allowed ? 10 : 10, p_kind: 'adjust',
      p_note: 'ZZTEST roles', p_booking: null, p_ref: `zztest-${r}-${rnd}`,
    });
    const ok = allowed ? !rpc.error : (!!rpc.error && /permission denied|42501/i.test(`${code(rpc.error)} ${rpc.error?.message}`));
    chk(`${r.padEnd(8)} adjust_points ${allowed ? 'ALLOWED' : 'denied'}`, ok,
        rpc.error ? `${code(rpc.error)} ${short(rpc.error)}` : `balance=${rpc.data}`);
  }

  // ------------------------------------------------------------ 9) whoami + audit
  if (HAVE_0024) {
    console.log('\n9) staff_whoami() and the audit log');
    for (const r of ['admin', 'employee', 'readonly', 'nostaff']) {
      const c = as(r); if (!c) continue;
      const w = await c.rpc('staff_whoami');
      const got = w.data || {};
      chk(`${r.padEnd(8)} staff_whoami role`, got.role === (r === 'nostaff' ? null : r),
          w.error ? short(w.error) : `role=${got.role} caps=${JSON.stringify(got.capabilities)}`);
    }
    const emp = users.find((u) => u.role === 'employee');
    if (emp) {
      const log = await db.from('audit_log').select('*').eq('actor_id', emp.id).order('at', { ascending: false });
      chk('employee booking insert produced an audit row', (log.data || []).length > 0,
          (log.data || []).map((l) => `${l.action} ${l.table_name} by ${l.actor_role}`).join('; ') || short(log.error));
    }
    const ro = users.find((u) => u.role === 'readonly');
    if (ro) {
      const seen = await ro.client.from('audit_log').select('id').limit(1);
      chk('readonly cannot read the audit log', (seen.data || []).length === 0,
          seen.error ? short(seen.error) : `${(seen.data || []).length} rows`);
    }
    const adm = users.find((u) => u.role === 'admin');
    if (adm) {
      const seen = await adm.client.from('audit_log').select('id').limit(1);
      chk('admin can read the audit log', !seen.error && (seen.data || []).length > 0,
          seen.error ? short(seen.error) : `${(seen.data || []).length} row(s)`);
    }
  }

  // ------------------------------------------------- 11) the server-side gate
  console.log('\n11) lib/db.js — the same question asked with the SERVICE-ROLE key (RLS is bypassed there)');
  {
    const bad = await staffContext('not-a-token', 'money.write');
    chk('staffContext rejects a bad token', bad.error === 'unauthorized', JSON.stringify(bad));
    for (const r of ['admin', 'employee', 'nostaff']) {
      const u = users.find((x) => x.role === r); if (!u || !u.token) continue;
      const ctx = await staffContext(u.token, 'money.write');
      const ok = HAVE_0024
        ? (r === 'admin' ? ctx.can === true : ctx.error === 'forbidden')
        : ctx.unsupported === true;   // before 0024 it says so instead of pretending to have checked
      chk(`staffContext(${r}, money.write)`, ok,
          JSON.stringify({ role: ctx.role, can: ctx.can, error: ctx.error, unsupported: ctx.unsupported }));
    }
    const rows = await listStaff();
    chk('listStaff does not throw', Array.isArray(rows), `${rows.length} row(s)`);
    const log = await auditLog({ limit: 5 });
    chk('auditLog does not throw', Array.isArray(log), `${log.length} row(s)`);
    const perms = await rolePermissions();
    chk('rolePermissions does not throw', Array.isArray(perms.capabilities), `${perms.capabilities.length} capabilit(ies)`);
    const rec = await recordAudit({ action: 'verify', table: 'server', note: 'ZZTEST roles', actor: { role: 'service' } });
    chk('recordAudit does not throw', !!rec && !rec.error, JSON.stringify(rec));
  }
} catch (e) {
  fails++;
  console.error('\nUNEXPECTED ERROR:', e && e.message ? e.message : e);
} finally {
  // ------------------------------------------------------------------ cleanup
  console.log('\n12) CLEANUP');
  await db.from('bookings').delete().eq('booking_date', DATE);
  if (customerId) {
    await db.from('point_transactions').delete().eq('customer_id', customerId);
    await db.from('customers').delete().eq('id', customerId);
  }
  for (const u of users) {
    if (HAVE_0024) await db.from('staff').delete().eq('user_id', u.id);
    const del = await db.auth.admin.deleteUser(u.id);
    if (del.error) console.log(`  WARN  could not delete ${u.email}: ${del.error.message}`);
  }
  if (HAVE_0024) {
    await db.from('audit_log').delete().like('actor_email', 'zztest-%');
    await db.from('audit_log').delete().eq('note', 'ZZTEST roles');
  }
  const left = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const strays = (left.data?.users || []).filter((u) => (u.email || '').startsWith('zztest-'));
  chk('no ZZTEST logins left behind', strays.length === 0, strays.map((u) => u.email).join(', ') || 'none');
  const rows = await db.from('bookings').select('id').eq('booking_date', DATE);
  chk('no ZZTEST bookings left behind', (rows.data || []).length === 0, `${(rows.data || []).length} row(s)`);

  console.log(`\n${fails === 0 ? 'ALL PASS' : `${fails} FAILED`} — ${checks - fails}/${checks} checks`);
  process.exit(fails === 0 ? 0 : 1);
}
