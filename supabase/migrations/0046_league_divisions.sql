-- 0046 — League divisions and top-three tie-breakers (the 2026-27 Winter League format).
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- After the qualifiers (weeks 1–8, catch-up 9–10) the managers put each team in a division, and from
-- week 11 each division is a league of its own (demo/assets/leagues.js stagedStandings). Teams that
-- finish level for a top-three place play it off; staff record that round's strokes here.
-- Both columns are written from the staff portal under the existing league_teams policies.

alter table public.league_teams add column if not exists division smallint;
alter table public.league_teams add column if not exists tiebreak_strokes numeric(8,2);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'league_teams_division_valid') then
    alter table public.league_teams add constraint league_teams_division_valid
      check (division is null or division between 1 and 9);
  end if;
end $$;

comment on column public.league_teams.division is 'Division the managers placed the team in after the qualifiers (0046). Null = not placed yet.';
comment on column public.league_teams.tiebreak_strokes is 'Strokes in the play-off round for a top-three tie in the division (0046). Lowest wins.';

do $$ begin
  raise notice '0046 applied: league teams can be placed in divisions and tie-breakers recorded.';
end $$;
