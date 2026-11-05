// Migration 0053 in a real Postgres (PGlite): the every-minute waiting-list job posts to the website
// only when the sweep has something to do, and the job already scheduled is changed in place.
// pg_cron and pg_net are stood in for by a cron.job table and a net.http_post that logs each call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const M53 = read('supabase/migrations/0053_waitlist_sweep_when_due.sql');

async function boot() {
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
  await db.exec(read('supabase/setup.sql'));
  await db.exec(read('supabase/migrations/0038_bookings_past_midnight.sql'));
  // Stand-ins for pg_cron and pg_net.
  await db.exec(`
    create schema cron;
    create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
    create function cron.schedule(n text, s text, c text) returns bigint language sql as
      $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
    create function cron.unschedule(id bigint) returns boolean language sql as
      $$ delete from cron.job where jobid = id returning true $$;
    create function cron.alter_job(job_id bigint, schedule text default null, command text default null,
        database text default null, username text default null, active boolean default null)
      returns void language sql as
      $$ update cron.job set command = coalesce(alter_job.command, job.command) where jobid = job_id $$;
    create schema net;
    create table net.calls (id bigserial, url text, headers jsonb);
    create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int) returns bigint
      language sql as $$ insert into net.calls (url, headers) values (url, headers) returning id $$;
  `);
  // Quiet hours off unless a test turns them on.
  await db.exec(`update public.settings set waitlist = '{"quietStartMin":0,"quietEndMin":0}'::jsonb where id = 1`);
  return db;
}

const URL_ = 'https://example.test/api/waitlist?action=sweep';
const command = async (db) => (await db.query(`select command from cron.job where jobname = 'waitlist-sweep'`)).rows[0].command;
const tick = async (db) => { await db.exec(await command(db)); };
const calls = async (db) => (await db.query(`select count(*)::int n from net.calls`)).rows[0].n;
const due = async (db) => (await db.query(`select public.waitlist_sweep_due() d`)).rows[0].d;

async function entry(db, { date = `(now() at time zone 'America/Winnipeg')::date + 1`, endMin = 1440 } = {}) {
  return (await db.query(`insert into public.waitlist_entries (customer_key, booking_date, window_start_min, window_end_min)
    values ('k', ${date}, 0, $1) returning id`, [endMin])).rows[0].id;
}

test('0053: the job already running gets the condition, keeps its URL and secret, and posts only when due', { timeout: 180e3 }, async () => {
  const db = await boot();
  await db.query(`select public.waitlist_schedule_sweep($1, 's3cret')`, [URL_]);   // as set up before 0053
  const before = await command(db);
  assert.ok(!before.includes('waitlist_sweep_due'));

  await db.exec(M53);
  await db.exec(M53);                                                               // safe to run twice
  const after = await command(db);
  assert.ok(after.includes(URL_) && after.includes('s3cret'), 'same URL and secret');
  assert.equal(after.split('waitlist_sweep_due').length - 1, 1, 'the condition added once');

  // Nothing waiting: a minute passes without a call.
  assert.equal(await due(db), false);
  await tick(db);
  assert.equal(await calls(db), 0);

  // An entry for tomorrow, nothing freed: still nothing to do.
  const e = await entry(db);
  await tick(db);
  assert.equal(await calls(db), 0);

  // A slot is freed: the next minute calls the website.
  await db.exec(`insert into public.waitlist_wakeups (booking_date, bay_id, start_min, end_min)
    values ((now() at time zone 'America/Winnipeg')::date + 1, 'bay1', 600, 660)`);
  await tick(db);
  assert.equal(await calls(db), 1);
  const h = (await db.query(`select headers from net.calls`)).rows[0].headers;
  assert.equal(h['x-waitlist-secret'], 's3cret');

  // In quiet hours a queued slot waits (the sweep would not touch it either).
  await db.exec(`update public.settings set waitlist = '{"quietStartMin":0,"quietEndMin":1440}'::jsonb where id = 1`);
  assert.equal(await due(db), false);
  await db.exec(`update public.settings set waitlist = '{"quietStartMin":0,"quietEndMin":0}'::jsonb where id = 1`);
  await db.exec(`update public.waitlist_wakeups set processed_at = now()`);
  assert.equal(await due(db), false);

  // An offer nobody has been told about → due; once told, not due until its window lapses.
  const o = (await db.query(`insert into public.waitlist_offers (entry_id, booking_date, bay_id, start_min, end_min, expires_at)
    values ($1, (now() at time zone 'America/Winnipeg')::date + 1, 'bay1', 600, 660, now() + interval '15 minutes') returning id`, [e])).rows[0].id;
  assert.equal(await due(db), true, 'announce it');
  await db.query(`update public.waitlist_offers set notified_at = now() where id = $1`, [o]);
  assert.equal(await due(db), false);
  await db.query(`update public.waitlist_offers set expires_at = now() - interval '1 second' where id = $1`, [o]);
  assert.equal(await due(db), true, 'expire it and offer the next person');
  await db.query(`update public.waitlist_offers set status = 'expired' where id = $1`, [o]);
  assert.equal(await due(db), false);

  // An entry whose window has ended → due (close it).
  await entry(db, { date: `(now() at time zone 'America/Winnipeg')::date - 1`, endMin: 600 });
  assert.equal(await due(db), true);
  await db.exec(`update public.waitlist_entries set status = 'expired' where booking_date < (now() at time zone 'America/Winnipeg')::date`);
  assert.equal(await due(db), false);

  // A queued message that is due → due; one scheduled for later is not.
  await db.exec(`insert into public.notifications (channel, recipient, template, dedupe_key, send_after)
    values ('email', 'a@x.test', 'x', 'later', now() + interval '1 hour')`);
  assert.equal(await due(db), false);
  await db.exec(`insert into public.notifications (channel, recipient, template, dedupe_key)
    values ('email', 'a@x.test', 'x', 'now')`);
  assert.equal(await due(db), true);
  await db.close();
});

test('0053: scheduling afresh adds the condition too', { timeout: 120e3 }, async () => {
  const db = await boot();
  await db.exec(M53);
  await db.query(`select public.waitlist_schedule_sweep($1, 'k')`, [URL_]);
  assert.ok((await command(db)).includes('where public.waitlist_sweep_due()'));
  await tick(db);
  assert.equal(await calls(db), 0);
  await db.close();
});
