-- Invictus Golf — gift cards: "Gift card" or "Social" (migration 0037)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- The shop hands out value for two different reasons, and wants to tell them apart:
--   gift_card  somebody paid for it — every card bought online, and cards sold at the counter
--   social     given away by staff: a social-media contest, a promotion, a goodwill gesture
--
-- Online purchases never set this column, so the default makes every one of them a gift card.
-- Staff choose one of the two when they issue a card in the portal, and can change it later.
-- Existing cards all become gift cards; staff can re-mark any that were really giveaways.

alter table public.gift_cards add column if not exists category text not null default 'gift_card';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gift_cards_category_valid') then
    alter table public.gift_cards add constraint gift_cards_category_valid
      check (category in ('gift_card', 'social'));
  end if;
end $$;

comment on column public.gift_cards.category is
  'gift_card (paid for — every online purchase) or social (given away by staff). Staff pick it when issuing.';
