-- 0041 — League: solo sign-ups and designated substitutes.
--
-- SOLO PLAYERS need no new column. Somebody without a team pays one golfer's share and lands in
-- league_members with team_id NULL: "in the league, waiting to be placed". The manager then puts
-- them on a team from the staff portal (api/leagues.js ?action=place-solo).
--
-- SUBSTITUTES are people a FULL team names to fill in when a teammate is away. They are on the
-- team's roster but they are not one of its players: they take no seat, pay no league fee, and get
-- none of a league member's perks (the longer booking window, booking the team's weekly round).
-- So a roster row now says which it is:
--
--   league_members.role       'player' (everybody until now) | 'sub'
--   league_team_invites.role  what the invite is for — a captain invites a substitute the same
--                             way they invite a teammate, by phone number
--
-- Up to three substitutes a team. That rule lives here, in the database, so the portal (which
-- writes league_members directly) and the invite link cannot disagree about it.
--
-- Safe to run more than once.

alter table public.league_members
  add column if not exists role text not null default 'player' check (role in ('player', 'sub'));

alter table public.league_team_invites
  add column if not exists role text not null default 'player' check (role in ('player', 'sub'));

create index if not exists league_members_team_role on public.league_members (team_id, role) where status = 'active';

create or replace function public.league_subs_limit() returns trigger
language plpgsql as $$
begin
  if new.role = 'sub' and new.status = 'active' and new.team_id is not null then
    -- Lock the team so two substitutes joining at the same moment are counted one after the other.
    perform 1 from public.league_teams t where t.id = new.team_id for update;
    if (select count(*) from public.league_members m
         where m.team_id = new.team_id and m.role = 'sub' and m.status = 'active' and m.id <> new.id) >= 3 then
      raise exception 'league_subs_limit: a team can have at most 3 substitutes' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists league_subs_limit on public.league_members;
create trigger league_subs_limit
  before insert or update of role, status, team_id on public.league_members
  for each row execute function public.league_subs_limit();
