// Make-up rounds and scorecards (migration 0042) — the SQL itself, on a real Postgres (PGlite).
//
// A booking may now say which league week it COUNTS for (bookings.league_for_week). What must still
// hold is the rule the whole league rests on: a team has one round per week it counts for.
//
//   node --test tests/league-makeups-db.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SETUP = read('supabase/setup.sql');
const M42 = read('supabase/migrations/0042_league_makeups_and_scorecards.sql');

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
  return db;
}
const refusal = async (p) => { try { await p; return null; } catch (e) { return String(e.message); } };

test('0042: a make-up counts for the week it names, one round per counted week, and it is safe to run twice', { timeout: 180e3 }, async () => {
  const db = await boot();
  await db.exec(M42);   // setup.sql already contains it — this is the second run
  // A Sunday-week league, as the Winter League is: week 5 is Nov 29 – Dec 5, week 6 is Dec 6 – 12.
  const lg = (await db.query(`insert into public.leagues (name, season_start, season_end, week_start) values ('Winter League', '2026-11-01', '2027-03-06', 0) returning id`)).rows[0].id;
  const team = (await db.query(`insert into public.league_teams (league_id, name) values ($1, 'Aces') returning id`, [lg])).rows[0].id;
  let n = 0;
  const round = (date, forWeek = null) => db.query(
    `insert into public.bookings (bay_id, booking_date, start_min, end_min, status, league_team_id, league_for_week) values ($1,$2,600,780,'confirmed',$3,$4) returning id, league_week::text`,
    [`B${++n}`, date, team, forWeek]);

  // Played in week 6, standing in for the missed week 5 — then week 6's own round, the same week.
  const makeup = (await round('2026-12-08', '2026-11-29')).rows[0];
  assert.equal(makeup.league_week, '2026-11-29');
  const own = (await round('2026-12-09')).rows[0];
  assert.equal(own.league_week, '2026-12-06', 'no week named: the week it is played in, as before');
  // A day in the middle of the week it stands in for is filed under that week's first day.
  assert.match(await refusal(round('2026-12-10', '2026-12-02')), /bookings_league_round_once/, 'week 5 already has its round');
  assert.match(await refusal(round('2026-12-11')), /bookings_league_round_once/, 'and so does week 6');

  // No longer a league round: it forgets the week it stood in for, and that week is free again.
  await db.query(`update public.bookings set league_team_id = null where id = $1`, [makeup.id]);
  assert.equal((await db.query(`select league_week::text from public.bookings where id = $1`, [makeup.id])).rows[0].league_week, '2026-12-07', 'an ordinary booking: its own Monday week');
  assert.equal(await refusal(round('2026-12-10', '2026-11-29')), null);

  // Moving the league's week start re-files every round by the week it counts for.
  await db.query(`update public.leagues set week_start = 1 where id = $1`, [lg]);
  const rows = (await db.query(`select booking_date::text, league_week::text from public.bookings where league_team_id = $1 order by booking_date`, [team])).rows;
  assert.deepEqual(rows, [{ booking_date: '2026-12-09', league_week: '2026-12-07' }, { booking_date: '2026-12-10', league_week: '2026-11-23' }]);

  // The scorecard list: one row per photo, tied to the team and the week.
  const c = (await db.query(`insert into public.league_scorecards (league_id, team_id, league_week, path) values ($1,$2,'2026-11-29','x/y.jpg') returning content_type, bytes`, [lg, team])).rows[0];
  assert.deepEqual(c, { content_type: 'image/jpeg', bytes: 0 });
  await db.close();
});
