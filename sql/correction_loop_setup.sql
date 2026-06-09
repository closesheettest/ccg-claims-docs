-- ============================================================
-- "Correction needed" loop — inspections columns
-- ------------------------------------------------------------
-- A Public Adjuster taps "Correction needed" on a deal whose key
-- info is wrong / missing (e.g. no phone number). The originating
-- sales rep + their regional manager get a text with a link
-- (/?correct=<inspectionId>) to fix the homeowner's name/phone/
-- email/address. Saving updates Supabase + JobNimbus (contact +
-- note) and texts the PA that it's corrected.
--
-- Functions: pa-request-correction.js, submit-correction.js
-- UI: PAPipelineDetail (button + banner) + CorrectionPage (App.jsx)
-- Run once in the CCG (claims) Supabase project.
-- ============================================================
alter table inspections
  add column if not exists correction_needed boolean default false,
  add column if not exists correction_note text,
  add column if not exists correction_requested_at timestamptz,
  add column if not exists correction_requested_by text,
  add column if not exists correction_resolved_at timestamptz,
  add column if not exists correction_resolved_by text;
