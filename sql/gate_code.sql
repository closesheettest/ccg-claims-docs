-- sql/gate_code.sql
--
-- The gate code for a pin.
--
-- Two inspections were lost to a gate in one week: Brey Lewis ("couldn't get in
-- the gate or reach H/O") and Larry Grimes ("the lady at the front gate will not
-- let me get through"). Both were booked jobs — the drive was made, the homeowner
-- had signed up, and the roof never got looked at because nobody had four digits
-- (Neal, 2026-08-19).
--
-- So the code rides with the pin. Captured wherever it's learned — the rep at
-- signing, the office, or the inspector who finally gets in — and shown on the
-- map to whoever goes next.
alter table inspections
  add column if not exists gate_code text,
  -- who last touched it + when, so a stale code can be judged rather than trusted
  add column if not exists gate_code_at timestamptz,
  add column if not exists gate_code_by text;

-- The map asks "does this pin have a code?" constantly; this keeps that cheap.
create index if not exists inspections_gate_code_idx
  on inspections (id) where gate_code is not null;

-- Verify — expect 0 rows and no error until the first one is saved:
--   select client_name, address, gate_code, gate_code_by, gate_code_at
--     from inspections where gate_code is not null order by gate_code_at desc;
