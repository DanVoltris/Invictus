-- Invictus Golf — league teams paid seat by seat (migration 0036)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- WHAT WAS WRONG
-- Since 0031 a captain paid the whole team price and collected from their friends privately. The
-- venue had no idea who had paid whom.
--
-- WHAT THIS ADDS
--   · A league has a MINIMUM and a MAXIMUM team size (team_min / team_size). The captain picks the
--     team's size in that range when they buy it — that is the team's number of SEATS.
--   · The team price is shared across the seats: share = team price ÷ seats, rounded UP to the
--     cent. The captain pays one share; each friend pays one share when they accept the invite;
--     the captain may also pay for extra seats. A friend joining a seat that is already paid for
--     pays nothing.
--   · Seats nobody pays for are owed by the CAPTAIN. From the day the season starts, the portal
--     lists them under Holds to Charge and flags the captain on the tee sheet's At a glance box on
--     any day they have a booking, until staff mark the money collected.
--
-- Columns, one new table and a backfill — nothing is dropped, and no existing team is flagged: a
-- team that already paid the full price is recorded as having every seat paid.

-- 1) The league: the smallest team a captain may pick. ---------------------------------------
alter table public.leagues add column if not exists team_min integer;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leagues_team_min_valid') then
    alter table public.leagues add constraint leagues_team_min_valid
      check (team_min is null or (team_min > 0 and (team_size is null or team_min <= team_size)));
  end if;
end $$;
comment on column public.leagues.team_min  is 'Smallest team a captain may pick (0036). Null = same as team_size.';
comment on column public.leagues.team_size is 'Largest team a captain may pick (0036; was the fixed team size). Null = no limit, and the captain pays the whole price.';

-- 2) The team: how many seats it has, and what one seat costs. -------------------------------
-- share_cents is fixed when the team is bought, so a later price change never re-prices a team.
alter table public.league_teams add column if not exists seats       integer;
alter table public.league_teams add column if not exists share_cents integer;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'league_teams_seats_valid') then
    alter table public.league_teams add constraint league_teams_seats_valid
      check ((seats is null or seats > 0) and (share_cents is null or share_cents >= 0));
  end if;
end $$;
comment on column public.league_teams.seats       is 'How many players the captain bought the team for (0036). Null = the old whole-team price.';
comment on column public.league_teams.share_cents is 'One seat''s price: the team price ÷ seats, rounded up to the cent, fixed when the team was bought.';

-- 3) Who paid for which seats. -----------------------------------------------------------------
--   method  stripe   paid online (the captain's own share, a friend joining, the captain covering)
--           counter  collected by staff at the till — recorded_by says who pressed the button
--           legacy   a team bought whole before this migration (backfill below)
create table if not exists public.league_seat_payments (
  id                 uuid primary key default gen_random_uuid(),
  team_id            uuid not null references public.league_teams(id) on delete cascade,
  league_id          uuid not null references public.leagues(id) on delete cascade,
  seats              integer not null check (seats > 0),
  amount_cents       integer not null check (amount_cents >= 0),
  method             text not null check (method in ('stripe', 'counter', 'legacy')),
  payer_customer_id  uuid references public.customers(id) on delete set null,
  for_customer_id    uuid references public.customers(id) on delete set null,
  stripe_session_id  text,
  recorded_by        text,
  note               text,
  created_at         timestamptz not null default now()
);
-- One payment row per Checkout Session: the success page and the webhook both settle it.
create unique index if not exists league_seat_payments_session
  on public.league_seat_payments (stripe_session_id) where stripe_session_id is not null;
create index if not exists league_seat_payments_team on public.league_seat_payments (team_id);

-- Same rule as the other league tables: any staff role reads; changing money needs Money.
alter table public.league_seat_payments enable row level security;
drop policy if exists league_seat_payments_read  on public.league_seat_payments;
drop policy if exists league_seat_payments_write on public.league_seat_payments;
create policy league_seat_payments_read on public.league_seat_payments
  for select to authenticated using ((select public.staff_role()) is not null);
create policy league_seat_payments_write on public.league_seat_payments
  for all to authenticated
  using ((select public.staff_can('money.write')))
  with check ((select public.staff_can('money.write')));

-- 4) Backfill: teams that already exist. ------------------------------------------------------
-- Their size is the league's size, and whatever they paid covers that many seats.
update public.league_teams t
   set seats = l.team_size,
       share_cents = ceil(l.fee_cents::numeric / l.team_size)::integer
  from public.leagues l
 where t.league_id = l.id and t.seats is null
   and l.team_size is not null and l.team_size > 0 and l.fee_cents > 0;

insert into public.league_seat_payments (team_id, league_id, seats, amount_cents, method, payer_customer_id, note)
select t.id, t.league_id,
       least(t.seats, floor(t.paid_cents::numeric / t.share_cents)::integer),
       t.paid_cents, 'legacy', t.captain_customer_id,
       'Paid before seat-by-seat payments (migration 0036)'
  from public.league_teams t
 where t.seats is not null and t.share_cents > 0 and t.paid_cents >= t.share_cents
   and not exists (select 1 from public.league_seat_payments p where p.team_id = t.id);
