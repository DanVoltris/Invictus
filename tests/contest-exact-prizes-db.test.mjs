// Spin the Wheel (migration 0051) — every group of spins hands out exactly the prizes set for it.
// The SQL itself, on a real Postgres (PGlite): 0044 + 0045 + 0051 on top of setup.sql.
//
//   node --test tests/contest-exact-prizes-db.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const M = ['0044_contest', '0045_contest_address_and_age', '0051_contest_exact_prizes'].map((m) => read(`supabase/migrations/${m}.sql`));

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
  for (const m of M) await db.exec(m);
  await db.exec(M[2]);                                   // safe to run twice
  return db;
}

// n customers who may spin: every detail filled in, a verified Manitoba address.
let made = 0;
async function people(db, n, { minor = false } = {}) {
  const dob = minor ? '2015-06-01' : '1990-06-01';
  const ids = [];
  for (let i = 0; i < n; i++) {
    const k = ++made;
    const u = (await db.query(`insert into auth.users (email) values ($1) returning id`, [`p${k}@x.test`])).rows[0].id;
    ids.push((await db.query(`insert into public.customers (name, first_name, last_name, email, phone, address, address_verified_at,
        address_province, career, date_of_birth, user_id) values ($1,'P',$2,$3,$4,'1 Main St, Winnipeg', now(), 'MB', 'Tester', $5, $6) returning id`,
      [`P ${k}`, `${k}`, `p${k}@x.test`, `+1204555${String(k).padStart(4, '0')}`, dob, u])).rows[0].id);
  }
  return ids;
}
const spin = async (db, id) => (await db.query(`select public.contest_spin($1, null, null) as r`, [id])).rows[0].r;
const prize = async (db, name, weight, adults = false) =>
  (await db.query(`insert into public.contest_prizes (name, kind, weight, adults_only) values ($1, 'credit', $2, $3) returning id`, [name, weight, adults])).rows[0].id;
const period = async (db, x, y, mode = 'return') => (await db.query(`insert into public.contest_periods (name, starts_at, ends_at, wins_per_block, block_size, forfeit_mode)
    values ('Test draw', now() - interval '1 hour', now() + interval '1 day', $1, $2, $3) returning id`, [x, y, mode])).rows[0].id;
const counts = async (db, block) => Object.fromEntries((await db.query(
  `select prize_name, count(*)::int n from public.contest_claims where block_id = $1 group by 1`, [block])).rows.map((r) => [r.prize_name, r.n]));

test('0051: 15 winners in every 353 spins, set to 5 + 10 — every group hands out exactly 5 and 10', { timeout: 600e3 }, async () => {
  const db = await boot();
  await prize(db, 'Food and Beverages', 5);
  await prize(db, 'Free round', 10);
  await period(db, 15, 353);
  for (const id of await people(db, 706)) {
    const r = await spin(db, id);
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  const blocks = (await db.query(`select id, seq, spins_taken, closed_at is not null as closed, prize_bag from public.contest_blocks order by seq`)).rows;
  assert.equal(blocks.length, 2);
  for (const b of blocks) {
    assert.ok(b.closed, `group ${b.seq} closed`);
    assert.deepEqual(await counts(db, b.id), { 'Food and Beverages': 5, 'Free round': 10 }, `group ${b.seq}`);
    assert.deepEqual(b.prize_bag, [], `group ${b.seq} handed out every slip`);
  }
});

test('0051: an under-18 winner’s 18+ slip waits for an adult; a forfeited prize puts its slip back', { timeout: 180e3 }, async () => {
  const db = await boot();
  const adultsOnly = await prize(db, 'Beer tasting', 2, true);
  const per = await period(db, 2, 4);
  // Open the group with an adult's spin, then fix its winning spins at positions 2 and 3.
  const [a1, a2, a3] = await people(db, 3);
  const [kid] = await people(db, 1, { minor: true });
  await spin(db, a1);
  const blk = (await db.query(`select id from public.contest_blocks where period_id = $1`, [per])).rows[0].id;
  await db.query(`update public.contest_blocks set winning_positions = '{2,3}', prize_bag = array[$2::uuid, $2::uuid] where id = $1`, [blk, adultsOnly]);

  const k = await spin(db, kid);                         // position 2: a win, but only 18+ slips are left
  assert.equal(k.won, false, 'nothing for a winner under 18');
  let b = (await db.query(`select winning_positions, prize_bag from public.contest_blocks where id = $1`, [blk])).rows[0];
  assert.deepEqual(b.prize_bag, [adultsOnly, adultsOnly], 'the slip waits in the group');
  assert.deepEqual(b.winning_positions, [2, 3, 4], 'and its win moved to a later spin');

  assert.equal((await spin(db, a2)).won, true);          // position 3
  assert.equal((await spin(db, a3)).won, true);          // position 4: the kid's win, with its slip
  b = (await db.query(`select prize_bag, closed_at is not null as closed from public.contest_blocks where id = $1`, [blk])).rows[0];
  assert.deepEqual(b.prize_bag, [], 'both slips handed out');
  assert.deepEqual(await counts(db, blk), { 'Beer tasting': 2 });

  // A forfeit with the group closed: the win and its slip are owed to the next group.
  const claim = (await db.query(`select id from public.contest_claims where block_id = $1 limit 1`, [blk])).rows[0].id;
  await db.query(`select public.contest_return_win($1)`, [claim]);
  const p = (await db.query(`select carry_wins, carry_prizes from public.contest_periods where id = $1`, [per])).rows[0];
  assert.deepEqual([p.carry_wins, p.carry_prizes], [1, [adultsOnly]]);
});

test('0051: a group opened before the migration (no bag) still picks a prize', { timeout: 180e3 }, async () => {
  const db = await boot();
  await prize(db, 'Food and Beverages', 1);
  const per = await period(db, 1, 2);
  const [a, b] = await people(db, 2);
  await db.query(`insert into public.contest_blocks (period_id, seq, size, winning_positions, prize_bag) values ($1, 1, 2, '{1}', null)`, [per]);
  const r = await spin(db, a);
  assert.equal(r.won, true);
  assert.equal(r.prize.name, 'Food and Beverages');
  assert.equal((await spin(db, b)).won, false);
});
