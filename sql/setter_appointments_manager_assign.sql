-- Manager-assigned setter appointments.
-- New flow: the setter books → the JN job is owned by the ZONE's REGIONAL
-- MANAGER with NO sales rep. The manager then assigns each appointment to one
-- of his reps (an OWNER + a SALES REP) from his dashboard.
--
-- Run once in the CCG Supabase SQL editor.

ALTER TABLE setter_appointments
  ADD COLUMN IF NOT EXISTS zone                 text,        -- e.g. 'Zone 2'
  ADD COLUMN IF NOT EXISTS manager_jobnimbus_id text,        -- regional manager the appt was booked under (JN owner)
  ADD COLUMN IF NOT EXISTS manager_name         text,
  ADD COLUMN IF NOT EXISTS owner_jobnimbus_id   text,        -- the OWNER the manager assigns (JN owners[0])
  ADD COLUMN IF NOT EXISTS owner_name           text,
  ADD COLUMN IF NOT EXISTS assigned_at          timestamptz; -- when the manager assigned a rep

-- An appointment "needs assignment" when it's booked under a manager but no
-- sales rep has been chosen yet: manager_jobnimbus_id IS NOT NULL AND
-- rep_jobnimbus_id IS NULL. (rep_jobnimbus_id / rep_name remain the SALES REP.)
CREATE INDEX IF NOT EXISTS idx_setter_appts_needs_assign
  ON setter_appointments (zone)
  WHERE rep_jobnimbus_id IS NULL AND manager_jobnimbus_id IS NOT NULL;
