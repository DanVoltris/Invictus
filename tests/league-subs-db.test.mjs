// Designated substitutes (migration 0041) — the SQL itself, on a real Postgres (PGlite).
//
// The rule the venue asked for is "up to 3 subs a team". The staff portal writes league_members
// straight to the database, so the database is where that rule has to hold. This runs the exact
// installer that is pasted into Supabase and checks the trigger, not a JavaScript copy of it.
//
//   node --test tests/league-subs-db.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SETUP = read('supabase/setup.sql');
const M41 = read('supabase/migrations/0041_league_solo_and_subs.sql');

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

test('0041: up to three substitutes a team, players unaffected, and it is safe to run twice', { timeout: 180e3 }, async () => {
  const db = await boot();
  await db.exec(M41);   // setup.sql already contains it — this is the second run
  const lg = (await db.query(`insert into public.leagues (name, season_start, season_end) values ('Winter League', '2026-11-01', '2027-03-06') returning id`)).rows[0].id;
  const team = (await db.query(`insert into public.league_teams (league_id, name) values ($1, 'Aces') returning id`, [lg])).rows[0].id;
  const rival = (await db.query(`insert into public.league_teams (league_id, name) values ($1, 'Birdies') returning id`, [lg])).rows[0].id;
  let n = 0;
  const add = async (teamId, role) => {
    const c = (await db.query(`insert into public.customers (name, phone) values ($1, $2) returning id`, [`P${++n}`, `+1204555${String(1000 + n)}`])).rows[0].id;
    return (await db.query(`insert into public.league_members (league_id, customer_id, team_id${role ? ', role' : ''}) values ($1,$2,$3${role ? ', $4' : ''}) returning id, role`,
      role ? [lg, c, teamId, role] : [lg, c, teamId])).rows[0];
  };

  // Everybody added the old way is a player; any number of players is the seat rules' business, not this one's.
  for (let i = 0; i < 5; i++) assert.equal((await add(team)).role, 'player');

  const subs = [];
  for (let i = 0; i < 3; i++) subs.push(await add(team, 'sub'));
  assert.match(await refusal(add(team, 'sub')), /league_subs_limit/, 'a fourth substitute is refused');
  assert.equal(await refusal(add(rival, 'sub')), null, 'the limit is per team');

  // A player cannot be turned into a fourth substitute either (the portal edits rows in place).
  const player = await add(team);
  assert.match(await refusal(db.query(`update public.league_members set role = 'sub' where id = $1`, [player.id])), /league_subs_limit/);

  // One leaves, and there is room again; bringing the leaver back when it is full is refused.
  await db.query(`update public.league_members set status = 'left' where id = $1`, [subs[0].id]);
  assert.equal(await refusal(add(team, 'sub')), null);
  assert.match(await refusal(db.query(`update public.league_members set status = 'active' where id = $1`, [subs[0].id])), /league_subs_limit/);

  assert.match(await refusal(db.query(`update public.league_members set role = 'coach' where id = $1`, [player.id])), /check/i, 'only player or sub');
  const inv = await db.query(`insert into public.league_team_invites (team_id, phone, token) values ($1, '+12045550000', gen_random_uuid()) returning role`, [team]);
  assert.equal(inv.rows[0].role, 'player', 'an invite is for a player unless it says otherwise');
  await db.close();
});
