-- Homeowner ↔ adjuster language matching.
-- Run once in the CCG Supabase SQL editor BEFORE using the feature.
--
--   • pas.languages       — which languages each adjuster speaks (default English)
--   • inspections.language — the homeowner's language, captured at rep sign-up
--
-- When a PA appointment is booked, only adjusters who speak the homeowner's
-- language are offered.

alter table pas
  add column if not exists languages text[] default array['english']::text[];

alter table inspections
  add column if not exists language text default 'english';

-- Backfill: existing "Spanish only" homeowners → Spanish.
update inspections
  set language = 'spanish'
  where spanish_only = true and (language is null or language = 'english');
