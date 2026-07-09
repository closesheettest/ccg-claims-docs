-- PA scheduling changes for the PA companies (Five Star requests), 2026-07-09.
-- Run in the CCG / free-roof-inspections Supabase (the PA + inspection app DB).

-- 1) Per-company PAUSE switch. A paused company's PAs are offered NO appointment
--    slots and get NO auto-assigned deals until it's flipped back to false.
alter table pa_companies add column if not exists scheduling_paused boolean not null default false;

-- Pause Five Star now (verify the row below matches before/after).
update pa_companies set scheduling_paused = true where name ilike '%five star%';

-- 2) Google Calendar connection (per PA) — for the 2-way calendar sync build.
alter table pas add column if not exists google_refresh_token text;
alter table pas add column if not exists google_email text;
alter table pas add column if not exists google_connected_at timestamptz;

-- Verify:
--   select id, name, scheduling_paused from pa_companies order by name;
