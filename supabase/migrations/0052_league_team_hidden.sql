-- 0052 — A league team staff can hide from players (a test team, say).
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run. Needs 0031.
--
-- A hidden team is still a team: it books rounds, enters scores and shows in full in the staff
-- portal, and its own players see it in My Account as usual. No other player sees it — not in the
-- standings, team stats, hole-stat leaders or the team count on the Leagues page — and its scores
-- are left out of everyone else's placings (lib/db.js visibleTeams).

alter table public.league_teams add column if not exists hidden boolean not null default false;
comment on column public.league_teams.hidden is 'Hidden from players (a test team): staff and its own players see it, nobody else does (0052).';

do $$ begin
  raise notice '0052 applied: staff can hide a league team from players.';
end $$;
