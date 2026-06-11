-- Roof type captured at intake (Free Roof Inspection Agreement).
-- Only "Shingle" or "Tile" are offered — we don't sign up metal roofs.
-- Drives the certificate's material + condition findings (a tile roof's
-- cert reads "Tile Condition" with tile-specific findings).
--
-- Run on the CCG Supabase project (ddtajhfsnlzgsejtvoaz).

alter table inspections
  add column if not exists roof_type text;

-- Backfill: existing rows are treated as shingle unless edited.
update inspections set roof_type = 'Shingle' where roof_type is null;
