// Every league invite since Oct 5 2026 failed to add the player: lib/db.js wrote
// league_members.source = 'invite', and the database only allows 'staff' or 'online'
// (migration 0028). The tests' fake database never enforced that, so nothing caught it — 31 people
// accepted (15 of them paid) and none were put on their team. This compares what the code writes
// with what the installer's check constraint allows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const setup = read('supabase/setup.sql');
const code = ['lib/db.js', 'api/leagues.js', 'api/staff.js', 'api/booking-series.js'].map(read).join('\n');

test('league_members.source: everything the code writes, the database accepts', () => {
  const m = /source\s+text not null default '\w+' check \(source in \(([^)]*)\)\)/.exec(setup.slice(setup.indexOf('create table if not exists public.league_members')));
  assert.ok(m, 'found the check constraint on league_members.source');
  const allowed = new Set([...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]));
  // Every putOnTeam(...) call and the source parameter's default.
  const written = new Set([...code.matchAll(/putOnTeam\([^)]*?source:\s*'(\w+)'/g)].map((x) => x[1]));
  const dflt = /async function putOnTeam\([^)]*source = '(\w+)'/.exec(read('lib/db.js'));
  if (dflt) written.add(dflt[1]);
  assert.ok(written.size, 'found the values written');
  for (const v of written) assert.ok(allowed.has(v), `league_members.source '${v}' is refused by the database (allowed: ${[...allowed].join(', ')})`);
});
