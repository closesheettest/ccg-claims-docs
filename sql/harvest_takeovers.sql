-- Every door an IQ scan takes over, held to one side so it can be put back.
--
-- The IQ-always-wins rule will flip several hundred pins on its first pass. If
-- the reps come back saying the map has gone mad, we need to reverse exactly
-- those pins and nothing else — not guess, and not roll the whole table back
-- (Neal, 2026-08-21).
--
-- One row per takeover, written by harvest-sync-iq-background. The pin also
-- carries extra.prev_status, but a door taken over twice would overwrite that;
-- this table keeps every hop in order.

CREATE TABLE IF NOT EXISTS harvest_takeovers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pin_id          uuid NOT NULL,
  run_at          timestamptz NOT NULL DEFAULT now(),
  source          text,                 -- which sync did it (iq / fb / ai)
  prev_status     text,                 -- what the door was
  prev_status_by  text,
  prev_status_at  timestamptz,
  new_status      text,                 -- what it became
  address         text,
  city            text,
  reverted_at     timestamptz           -- set when it's put back
);

CREATE INDEX IF NOT EXISTS harvest_takeovers_run_idx ON harvest_takeovers (run_at DESC);
CREATE INDEX IF NOT EXISTS harvest_takeovers_open_idx ON harvest_takeovers (run_at DESC) WHERE reverted_at IS NULL;
CREATE INDEX IF NOT EXISTS harvest_takeovers_pin_idx ON harvest_takeovers (pin_id);

ALTER TABLE harvest_takeovers ENABLE ROW LEVEL SECURITY;

-- Read + write from the app. UPDATE is allowed here (unlike the contest freeze)
-- because marking a row reverted IS the intended operation.
DROP POLICY IF EXISTS harvest_takeovers_read  ON harvest_takeovers;
DROP POLICY IF EXISTS harvest_takeovers_write ON harvest_takeovers;
DROP POLICY IF EXISTS harvest_takeovers_mark  ON harvest_takeovers;
CREATE POLICY harvest_takeovers_read  ON harvest_takeovers FOR SELECT USING (true);
CREATE POLICY harvest_takeovers_write ON harvest_takeovers FOR INSERT WITH CHECK (true);
CREATE POLICY harvest_takeovers_mark  ON harvest_takeovers FOR UPDATE USING (true) WITH CHECK (true);
