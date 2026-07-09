-- 1-hour PA appointment follow-up (cron-pa-appt-followup.js)
--
-- Adds the stamp column the cron uses to fire the "How did the appointment go?"
-- text/email exactly once per appointment, ~1 hour after its start time.
-- Run once in the Supabase SQL editor.

ALTER TABLE pa_appointments
  ADD COLUMN IF NOT EXISTS followup_sent_at timestamptz;

-- (optional) speed up the cron's due-query on large tables
CREATE INDEX IF NOT EXISTS pa_appointments_followup_due_idx
  ON pa_appointments (start_at)
  WHERE status = 'scheduled' AND followup_sent_at IS NULL;
