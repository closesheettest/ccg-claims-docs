-- 2026-06-04  Add county to inspections.
--
-- County is pulled from the SAME Google geocode response we already use
-- for lat/lng (the administrative_area_level_2 address component). New
-- signings get it automatically; existing rows are backfilled by the
-- "Geocode all inspections" button (bulk-geocode-inspections), which now
-- also re-runs rows that have lat/lng but no county yet.
--
-- Used to sort the PA portal's "Available" damage pool alphabetically by
-- county.

alter table inspections add column if not exists county text;

-- Speeds up the county sort on the Available pool.
create index if not exists inspections_county_idx on inspections (county);
