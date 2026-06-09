-- ============================================================
-- PA portal "Working" bucket — pa_opened_at
-- ------------------------------------------------------------
-- Splits the PA's pre-signature queue into two tabs:
--   🆕 New files  = assigned but never opened, no notes
--   🛠 Working    = the PA has OPENED the pipeline (pa_opened_at set)
--                   OR left a note (pa_notes_log non-empty)
-- "Working" sits between New files and Signed. pa_opened_at is stamped
-- (once) by pa-load-claim when the PA opens a deal's pipeline detail.
-- Run once in the CCG (claims) Supabase project.
-- ============================================================
alter table inspections
  add column if not exists pa_opened_at timestamptz;
