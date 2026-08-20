-- "How did the come-back go?" follow-up (cron-goback-followup → goback-followup).
--
-- One stamp column so a rep is asked exactly once per booked review, whatever
-- happens afterwards. Without it the cron has no memory and would re-text every
-- 15 minutes forever.
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS review_followup_sent_at timestamptz;

-- The cron scans on (review_followup_sent_at IS NULL, review_appt_at) every 15
-- minutes. Partial index: the un-asked rows are a tiny slice of the table, and
-- this keeps the scan off the full inspection history.
CREATE INDEX IF NOT EXISTS inspections_review_followup_due_idx
  ON inspections (review_appt_at)
  WHERE review_followup_sent_at IS NULL AND review_appt_at IS NOT NULL;
