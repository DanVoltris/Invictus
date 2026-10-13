// Phone and email are how the rest of the system decides who a customer IS: bookings_self_read
// shows an account the bookings that match them, and prepaid hours are credited by phone. Until
// migration 0043 an account holder could rewrite both on their own row. The guard itself runs in
// Postgres; these tests pin that the rule is in the migration and in the one-file installer, and
// that it exempts the two callers who must keep working — staff and the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../supabase/' + p, import.meta.url), 'utf8');
const migration = read('migrations/0043_customer_identity_guard.sql');
const lastGuard = (sql) => sql.slice(sql.lastIndexOf('create or replace function public.customer_guard_self_columns()'));

test('the guard refuses a change to phone or email', () => {
  const fn = lastGuard(migration);
  assert.match(fn, /new\.phone is distinct from old\.phone/);
  assert.match(fn, /new\.email is distinct from old\.email/);
});

test('staff of any role and the server are exempt; the shop-owned columns stay guarded', () => {
  const fn = lastGuard(migration);
  assert.match(fn, /not public\.rbac_is_service\(\) and public\.staff_role\(\) is null/);
  for (const col of ['points_balance', 'hours_balance_min', 'membership_id', 'user_id', 'stripe_customer_id']) {
    assert.match(fn, new RegExp(`new\\.${col}\\s+is distinct from old\\.${col}`), col);
  }
});

test('the installer ends on the same guard, so a fresh database is not left open', () => {
  assert.match(lastGuard(read('setup.sql')), /new\.phone is distinct from old\.phone or new\.email is distinct from old\.email/);
});

test('the migration checks itself and fails loudly', () => {
  assert.match(migration, /raise exception '0043: customer_guard_self is not active/);
});
