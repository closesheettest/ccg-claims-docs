-- pa_zones: which company Zone(s) a Public Adjuster covers.
--
-- A PA is offered for an appointment only if the appointment's zone is one they
-- cover (AND still within their distance limit). Zones reuse the company's
-- existing 4 county-based Florida zones (Zone 1–4), the same ones the sales /
-- no-sit reports use.
--
-- Stored as a text[] of zone names, e.g. '{"Zone 1","Zone 3"}'. An EMPTY array
-- means "covers all zones" — backward compatible, so every existing PA keeps
-- showing up until they pick their zones.
--
-- Run once in the Supabase SQL editor.

alter table public.pas
  add column if not exists zones text[] not null default '{}';
