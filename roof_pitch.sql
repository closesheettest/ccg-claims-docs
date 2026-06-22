-- Roof pitch cache for the Appointments → Sales report.
-- The pitch ratio (e.g. "4/12") lives only inside each job's Roofr PDF, so a
-- nightly cron (cron-extract-pitch) downloads the report, parses the
-- "Predominant pitch" line, and upserts it here keyed by JobNimbus job id.
-- all-appt-conversion / zone-appt-conversion then read this and show the pitch
-- on each sold deal. Run this in the CCG Supabase SQL editor.

create table if not exists roof_pitch (
  jnid          text primary key,      -- JobNimbus job id
  pitch         text,                  -- "4/12" (null if not found yet)
  squares_pitch numeric,               -- # of Squares (Pitch) from the job
  squares_flat  numeric,               -- # of Squares (Flat)
  stories       text,                  -- # of Stories
  roofr_file    text,                  -- filename the pitch was parsed from
  status        text,                  -- ok | no_pdf | no_pitch | dl_fail | error
  checked_at    timestamptz default now()
);

grant select, insert, update on roof_pitch to anon;
