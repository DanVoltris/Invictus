-- 0047 — Hole-by-hole league scores, entered by a team member and confirmed by staff.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run. Needs 0028.
--
-- A team's result for a week (league_results) can carry its 18 hole scores. The total (score) is
-- then always their sum — set here, so it can never disagree with the holes. A team member enters
-- them in My Account (api/leagues.js submit-holes, through the server): the row is 'pending' and
-- counts for nothing until staff check it against the scorecard and confirm it in the portal. Rows
-- staff enter themselves are confirmed straight away, and every row from before this is confirmed.
-- Par for each hole lives on the league's schedule (leagues.details.schedule[].pars).

alter table public.league_results add column if not exists holes        smallint[];
alter table public.league_results add column if not exists status       text not null default 'confirmed';
alter table public.league_results add column if not exists submitted_by uuid references public.customers(id) on delete set null;
alter table public.league_results add column if not exists submitted_at timestamptz;
alter table public.league_results add column if not exists confirmed_by text;
alter table public.league_results add column if not exists confirmed_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'league_results_status_valid') then
    alter table public.league_results add constraint league_results_status_valid check (status in ('pending', 'confirmed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'league_results_holes_valid') then
    alter table public.league_results add constraint league_results_holes_valid
      check (holes is null or (array_length(holes, 1) = 18 and 1 <= all (holes) and 20 >= all (holes)));
  end if;
end $$;

-- The total is the holes added up whenever there are holes.
create or replace function public.league_results_hole_total() returns trigger
language plpgsql as $fn$
begin
  if new.holes is not null then
    new.score := (select sum(x) from unnest(new.holes) as x);
  end if;
  return new;
end $fn$;
drop trigger if exists league_results_hole_total on public.league_results;
create trigger league_results_hole_total before insert or update on public.league_results
  for each row execute function public.league_results_hole_total();

comment on column public.league_results.holes  is 'The 18 hole scores (0047). score is their sum.';
comment on column public.league_results.status is '''pending'' = entered by a team member, waiting for staff; ''confirmed'' = counts (0047).';

do $$ begin
  raise notice '0047 applied: league results can carry 18 hole scores, entered by players and confirmed by staff.';
end $$;
