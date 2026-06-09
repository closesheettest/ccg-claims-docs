-- ============================================================
-- PA home address + coords (for distance-based assignment)
-- ------------------------------------------------------------
-- Mirrors inspectors' home base. The master admin enters a PA's home
-- address; it's geocoded (geocode-place) to lat/lng. The company admin
-- screen can then sort a company's homeowners by distance from a chosen
-- PA's home (or the admin's current location) to assign the nearest.
-- Run once in the CCG (claims) Supabase project.
-- ============================================================
alter table pas
  add column if not exists home_address text,
  add column if not exists latitude  double precision,
  add column if not exists longitude double precision;
