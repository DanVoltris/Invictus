-- Invictus Golf — league info from the brochure (migration 0039)
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to re-run.
--
-- A league's printed brochure says far more than a name and a price: what the league is about, the
-- format and rules, the featured challenges, a week-by-week schedule of courses, the team awards
-- and the grand prize. This is where all of that lives, as one JSON document per league:
--
--   { "about": "…", "format": ["…"], "challenges": ["…"],
--     "schedule": [{ "from": "2026-11-01", "to": "2026-11-07", "phase": "Phase 1",
--                    "event": "Mini Tournament 1", "course": "…", "location": "…" }],
--     "awards": ["…"], "prize": "…" }
--
-- Staff fill it in on the league form (they already may write leagues — migration 0024's rule);
-- customers read it on the Leagues page through the server, which cleans it with the same code the
-- form uses (demo/assets/leagues.js normalizeDetails). Every part is optional: a league with an
-- empty document looks exactly as it did before.

alter table public.leagues add column if not exists details jsonb not null default '{}'::jsonb;
