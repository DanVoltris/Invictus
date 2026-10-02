// A league chooses the day its week starts (migration 0040) — the SQL itself, on a real Postgres.
//
// PGlite is Postgres compiled to WebAssembly, running in memory: the installer and the migration
// below are the exact files pasted into Supabase. What is checked is the rule the venue cares
// about — one round per team per WEEK — when a league's week runs Sunday to Saturday, as the
// 2026-27 Winter League brochure's does, instead of the Monday to Sunday the database always used.
//
//   node --test tests/league-week-db.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SETUP = read('supabase/setup.sql');
const M40 = read('supabase/migrations/0040_league_week_start.sql');
await import(new URL('../demo/assets/leagues.js', import.meta.url).href);
const L = globalThis.InvictusLeagues;

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
  await db.exec(SETUP);
  await db.exec(M40);
  return db;
}
// A league with one team; returns helpers that book that team's rounds, each in its own bay so the
// no-overlap rule never gets in the way of the one being tested.
async function league(db, weekStart = null) {
  const lg = (await db.query(`insert into public.leagues (name, season_start, season_end${weekStart == null ? '' : ', week_start'})
    values ('Winter League', '2026-11-01', '2027-01-23'${weekStart == null ? '' : `, ${weekStart}`}) returning id`)).rows[0].id;
  const team = (await db.query(`insert into public.league_teams (league_id, name) values ($1, 'Aces') returning id`, [lg])).rows[0].id;
  let n = 0;
  const round = (date, status = 'confirmed') => db.query(
    `insert into public.bookings (bay_id, booking_date, start_min, end_min, status, league_team_id) values ($1,$2,600,780,$3,$4) returning id, league_week::text`,
    [`B${++n}`, date, status, team]);
  return { lg, team, round };
}
const refused = async (p) => { try { await p; return false; } catch { return true; } };

test('migration 0040 is safe to run twice', { timeout: 180e3 }, async () => {
  const db = await boot();
  await db.exec(M40);
  await db.close();
});

test('a league left alone still runs Monday to Sunday, exactly as before', { timeout: 180e3 }, async () => {
  const db = await boot();
  const { round } = await league(db);
  const tue = await round('2026-11-03');
  assert.equal(tue.rows[0].league_week, '2026-11-02', 'Tuesday files under its Monday');
  assert.equal(await refused(round('2026-11-08')), true, 'Sunday Nov 8 is the same Monday–Sunday week: refused');
  assert.equal(await refused(round('2026-11-09')), false, 'Monday Nov 9 is the next week');
  await db.close();
});

test('a Sunday-start league: the brochure\'s weeks are the weeks the database enforces', { timeout: 180e3 }, async () => {
  const db = await boot();
  const { round } = await league(db, 0);
  const sun = await round('2026-11-01');
  assert.equal(sun.rows[0].league_week, '2026-11-01', 'Sunday Nov 1 starts week 1 (Nov 1–7)');
  assert.equal(await refused(round('2026-11-07')), true, 'Saturday Nov 7 is still week 1: refused');
  assert.equal(await refused(round('2026-11-03')), true, 'so is Tuesday Nov 3');
  const next = await round('2026-11-08');
  assert.equal(next.rows[0].league_week, '2026-11-08', 'Sunday Nov 8 starts week 2 — the case Monday weeks got wrong');
  const cancelled = await round('2026-11-10', 'cancelled');
  assert.equal(cancelled.rows.length, 1, 'a cancelled round never blocks the week');
  // Across the year end: Dec 27 – Jan 2 is one week.
  await round('2026-12-27');
  assert.equal(await refused(round('2027-01-02')), true);
  assert.equal(await refused(round('2027-01-03')), false);
  await db.close();
});

test('the database and the page agree on every day of the season, for every start day', { timeout: 180e3 }, async () => {
  const db = await boot();
  for (const ws of [0, 1, 3, 6]) {
    const { rows } = await db.query(
      `select d::date::text as day, public.league_week_of(d::date, $1::smallint)::text as wk
         from generate_series('2026-10-25'::date, '2027-01-31'::date, interval '1 day') d`, [ws]);
    for (const r of rows) assert.equal(r.wk, L.weekOf(r.day, ws), `${r.day} with week start ${ws}`);
  }
  await db.close();
});

test('nobody can supply league_week: the trigger overwrites it on insert and on update', { timeout: 180e3 }, async () => {
  const db = await boot();
  const { team } = await league(db, 0);
  const ins = await db.query(
    `insert into public.bookings (bay_id, booking_date, start_min, end_min, status, league_team_id, league_week)
     values ('B1','2026-11-03',600,780,'confirmed',$1,'1999-01-01') returning id, league_week::text`, [team]);
  assert.equal(ins.rows[0].league_week, '2026-11-01');
  const upd = await db.query(`update public.bookings set league_week = '1999-01-01' where id = $1 returning league_week::text`, [ins.rows[0].id]);
  assert.equal(upd.rows[0].league_week, '2026-11-01', 'a second round cannot be slipped into the week by lying about it');
  const moved = await db.query(`update public.bookings set booking_date = '2026-11-12' where id = $1 returning league_week::text`, [ins.rows[0].id]);
  assert.equal(moved.rows[0].league_week, '2026-11-08', 'moving the round re-files it');
  // A booking that is not a league round keeps the Monday it always had.
  const plain = await db.query(`insert into public.bookings (bay_id, booking_date, start_min, end_min, status) values ('B2','2026-11-08',600,660,'confirmed') returning league_week::text`);
  assert.equal(plain.rows[0].league_week, '2026-11-02');
  await db.close();
});

test('changing a league\'s start day re-files its rounds, and is refused if two would collide', { timeout: 180e3 }, async () => {
  const db = await boot();
  const { lg, round } = await league(db);            // Monday weeks
  await round('2026-11-03');                          // Tue, week of Mon Nov 2
  await round('2026-11-12');                          // Thu, week of Mon Nov 9
  await db.query(`update public.leagues set week_start = 0 where id = $1`, [lg]);
  const { rows } = await db.query(`select booking_date::text d, league_week::text w from public.bookings where league_team_id is not null order by booking_date`);
  assert.deepEqual(rows, [{ d: '2026-11-03', w: '2026-11-01' }, { d: '2026-11-12', w: '2026-11-08' }]);

  // A real collision: on Monday weeks, Sun Nov 22 (week of Nov 16) and Mon Nov 23 (week of Nov 23)
  // are in different weeks; on Sunday weeks both fall in Nov 22–28.
  await db.query(`update public.leagues set week_start = 1 where id = $1`, [lg]);
  await round('2026-11-22'); await round('2026-11-23');
  let msg = '';
  try { await db.query(`update public.leagues set week_start = 0 where id = $1`, [lg]); } catch (e) { msg = e.message; }
  assert.match(msg, /two rounds that would fall in the same week/);
  const still = await db.query(`select week_start from public.leagues where id = $1`, [lg]);
  assert.equal(still.rows[0].week_start, 1, 'the change did not half-happen');
  assert.equal(await refused(db.query(`update public.leagues set week_start = 7 where id = $1`, [lg])), true, 'only 0–6');
  await db.close();
});
