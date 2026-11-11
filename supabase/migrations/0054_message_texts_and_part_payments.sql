-- 0054 — Text messages staff can reword, and league part payments.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run. Needs 0036.
--
-- 1) settings.message_texts: the admin's own wording for each text the site sends, keyed by which
--    text it is ("booking.paid", "waitlist.offer", …). A text with no entry here is sent exactly as
--    before. Written from the portal's Venue tab (Setup permission, like the rest of settings).
--
-- 2) league_seat_payments: a row may now hold money with no seat yet. Staff record that a player
--    paid part of their share at the counter ("$100 of $285") as seats = 0 with the amount; it comes
--    off what they owe, and the payment that finishes their share pays the seat (lib/db.js
--    recordPartPayment). Every row still carries either a seat or some money.

alter table public.settings add column if not exists message_texts jsonb not null default '{}'::jsonb;
comment on column public.settings.message_texts is
  'Custom wording for outgoing texts, keyed by text (0054). Missing key = the built-in wording.';

do $$
declare c record;
begin
  -- The old rule (seats > 0) is the column check from 0036; its name is Postgres's default.
  for c in select conname from pg_constraint
            where conrelid = 'public.league_seat_payments'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ~ '\(seats > 0\)' and conname <> 'league_seat_payments_seat_or_money'
  loop
    execute format('alter table public.league_seat_payments drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'league_seat_payments_seat_or_money') then
    alter table public.league_seat_payments add constraint league_seat_payments_seat_or_money
      check (seats >= 0 and (seats > 0 or amount_cents > 0));
  end if;
end $$;
comment on column public.league_seat_payments.seats is
  'Seats this payment covers. 0 = a part payment toward for_customer_id''s seat (0054).';

do $$ begin
  raise notice '0054 applied: custom text wording, and league part payments.';
end $$;
