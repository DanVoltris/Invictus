// Migration 0038 in a real Postgres: the database itself refuses two sessions in one bay at the same
// real time, even when one of them started the night before, and the waiting list can offer a slot
// that runs past midnight.
//
// PGlite is Postgres compiled to WebAssembly, running in memory — the same SQL the live Supabase
// runs (supabase/setup.sql, every migration in order), with a few stand-ins for Supabase's own
// auth schema and roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SETUP = read('supabase/setup.sql');
const M38 = read('supabase/migrations/0038_bookings_past_midnight.sql');

async function boot(sql = SETUP) {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create or replace function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
    create schema if not exists extensions;
  `);
  await db.exec(sql);
  return db;
}
const refused = async (p) => { try { await p; return false; } catch { return true; } };

test('the installer is safe to run twice', { timeout: 120e3 }, async () => {
  const db = await boot();
  await db.exec(SETUP);
  await db.close();
});

test('one bay, one session at a time — across midnight', { timeout: 120e3 }, async () => {
  const db = await boot();
  const put = (date, s, e, bay = 'B1', status = 'confirmed') =>
    db.query(`insert into public.bookings (bay_id, booking_date, start_min, end_min, status) values ($1,$2,$3,$4,$5)`, [bay, date, s, e, status]);
  const SAT = '2026-10-03', SUN = '2026-10-04';

  assert.equal(await refused(put(SAT, 1410, 1620)), false, 'Sat 11:30 PM → Sun 3:00 AM is stored under Saturday');
  assert.equal(await refused(put(SUN, 60, 120)), true, 'Sun 1–2 AM in the same bay clashes with it');
  assert.equal(await refused(put(SUN, 60, 120, 'B1', 'cancelled')), false, 'a cancelled booking never blocks');
  assert.equal(await refused(put(SUN, 180, 240)), false, 'Sun 3–4 AM starts as it ends');
  assert.equal(await refused(put(SUN, 60, 120, 'B2')), false, 'another bay is free');
  assert.equal(await refused(put(SAT, 1350, 1410)), false, 'Sat 10:30–11:30 PM ends as it starts');
  assert.equal(await refused(put(SAT, 1380, 1440)), true, 'Sat 11 PM–midnight overlaps its first half hour');
  assert.equal(await refused(put(SUN, 210, 270, 'B3')), false, 'Sun 3:30–4:30 AM is allowed');
  assert.equal(await refused(put(SUN, 240, 300, 'B3')), true, '…and 4:00–5:00 AM then clashes with it');

  const { rows } = await db.query(`select span::text from public.bookings where start_min = 1410`);
  assert.equal(rows[0].span, '["2026-10-03 23:30:00","2026-10-04 03:00:00")', 'the booking\'s real span');

  assert.equal(await refused(db.query(`insert into public.booking_series (freq, start_date, start_min, end_min, bay_ids)
    values ('once', $1, 1410, 1620, '{B4}')`, [SAT])), false, 'a staff group/series can run past midnight');
  assert.equal(await refused(db.query(`insert into public.waitlist_entries (customer_key, booking_date, window_start_min, window_end_min, duration_min, email, email_ok)
    values ('k', $1, 1320, 1620, 60, 'a@b.test', true)`, [SAT])), false, 'a waiting-list window can run past midnight');
  assert.equal(await refused(db.query(`insert into public.waitlist_entries (customer_key, booking_date, window_start_min, window_end_min, duration_min, email, email_ok)
    values ('k2', $1, 1440, 1560, 60, 'a@b.test', true)`, [SAT])), true, 'but a window starts on its own day');
  await db.close();
});

test('0038 goes onto a database that already holds bookings (the live situation)', { timeout: 120e3 }, async () => {
  const cut = SETUP.indexOf('-- MIGRATION 0038');
  assert.ok(cut > 0, 'setup.sql carries migration 0038 — run npm run build:schema');
  const db = await boot(SETUP.slice(0, SETUP.lastIndexOf('-- ====', cut)));
  for (let d = 1; d <= 10; d++) for (const [s, e, bay] of [[240, 300, 'B1'], [600, 720, 'B2'], [1320, 1440, 'B1'], [0, 60, 'B3']])
    await db.query(`insert into public.bookings (bay_id, booking_date, start_min, end_min) values ($1, date '2026-09-01' + $2::int, $3, $4)`, [bay, d, s, e]);
  await db.exec(M38); await db.exec(M38);
  const { rows } = await db.query(`select count(*)::int as n, count(span)::int as spans from public.bookings`);
  assert.equal(rows[0].n, 40);
  assert.equal(rows[0].spans, 40, 'every existing booking got its span');
  await db.close();
});

test('the waiting list offers a freed Sunday 1 AM slot to someone free "Saturday 10 PM – 3 AM"', { timeout: 120e3 }, async () => {
  const db = await boot();
  await db.exec(`update public.settings set waitlist = '{"quietStartMin":0,"quietEndMin":0}'::jsonb where id = 1`);
  const sat = (await db.query(`select (current_date + ((6 - extract(dow from current_date)::int + 7) % 7) + 7)::text as d`)).rows[0].d;
  await db.query(`insert into public.waitlist_entries (customer_key, booking_date, window_start_min, window_end_min, duration_min, email, email_ok, name)
    values ('late', $1, 1320, 1620, 60, 'late@x.test', true, 'Late Owl')`, [sat]);
  const b = await db.query(`insert into public.bookings (bay_id, booking_date, start_min, end_min) values ('B1', $1::date + 1, 60, 180) returning id`, [sat]);
  await db.query(`update public.bookings set status = 'cancelled' where id = $1`, [b.rows[0].id]);   // frees Sun 1–3 AM

  const r = (await db.query(`select public.waitlist_process() as r`)).rows[0].r;
  assert.equal(r.created, 1, JSON.stringify(r));
  const o = await db.query(`select e.name, o.booking_date::text as d, o.start_min, o.end_min from public.waitlist_offers o join public.waitlist_entries e on e.id = o.entry_id`);
  const sun = (await db.query(`select ($1::date + 1)::text as d`, [sat])).rows[0].d;
  assert.deepEqual(o.rows, [{ name: 'Late Owl', d: sun, start_min: 60, end_min: 120 }], 'offered Sunday 1–2 AM, stored under Sunday');
  const h = await db.query(`select booking_date::text as d, start_min, end_min from public.bookings where status = 'held'`);
  assert.deepEqual(h.rows, [{ d: sun, start_min: 60, end_min: 120 }], 'and the slot is held for them');
  await db.close();
});
