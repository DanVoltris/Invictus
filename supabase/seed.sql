-- Invictus Golf — the venue's real settings seed.
-- This is the single source of truth for the live configuration. "npm run build:schema"
-- substitutes it for the generic demo seed in schema.sql when it generates setup.sql, so
-- change bays, opening hours and rates HERE — editing schema.sql will not reach the installer.

-- Seed the manager's single settings row with Invictus Golf's real configuration:
-- the six bays from their GolfBook sheet, open 24/7, CA$20/hr Mon-Thu and CA$25/hr Fri-Sun.
-- "on conflict do nothing" means re-running this file never overwrites live settings.
insert into public.settings (id, bays, hours, rates, min_mins, max_party, slot_step)
values (
  1,
  '[{"id":"B1","name":"Assiniboine Credit Union Bay #1","sim":"Golfzon TwoVision","description":"Right hand only","max_players":4,"sort":1},
    {"id":"B2","name":"Birchwood Bay #2","sim":"Golfzon TwoVision","max_players":4,"sort":2},
    {"id":"B3","name":"Manitopia Realty Bay #3","sim":"Golfzon TwoVision","max_players":4,"sort":3},
    {"id":"B4","name":"Public Bay #4","sim":"Golfzon TwoVision","description":"Flat base","max_players":4,"sort":4},
    {"id":"B5","name":"McNaught Private Room #1","sim":"Golfzon TwoVision","description":"Private room","max_players":4,"sort":5},
    {"id":"B6","name":"Private Room #2","sim":"Golfzon TwoVision","description":"Private room","max_players":4,"sort":6}]'::jsonb,
  '{"0":[0,24],"1":[0,24],"2":[0,24],"3":[0,24],"4":[0,24],"5":[0,24],"6":[0,24]}'::jsonb,
  '{"weekdayOffPeak":20,"weekdayPeak":20,"weekendOffPeak":25,"weekendPeak":25,"peakStartHour":17}'::jsonb,
  60, 4, 30
)
on conflict (id) do nothing;
