-- ============================================================
-- PA scorecard metrics
-- ------------------------------------------------------------
-- pa_signed_at: stamped on the inspection when the PA marks the
--   homeowner "Signed" (pa-save-field). Powers "avg days to signed"
--   (pa_signed_at - pa_claimed_at).
-- pa_takeaways: per-PA counter, bumped when the admin reassigns/
--   unassigns a deal AWAY from a PA. Powers "% taken away".
-- Both accrue going forward. Run once in the CCG (claims) project.
-- ============================================================
alter table inspections
  add column if not exists pa_signed_at timestamptz;

alter table pas
  add column if not exists pa_takeaways integer not null default 0;
