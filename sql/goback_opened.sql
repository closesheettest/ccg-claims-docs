-- sql/goback_opened.sql
--
-- "How about opened but didn't book?" — Neal, 2026-08-17.
--
-- The Auto-Schedule-After-Inspection funnel only knew two things: we contacted
-- them, and they booked. The interesting group sits between the two — a
-- homeowner who read the message, clicked, looked at the rep's times, and
-- stopped. That's a warm person sitting there, and a rep calling THAT list beats
-- a rep calling everyone.
--
-- goback-book.js stamps this the first time the homeowner's booking page loads,
-- and never overwrites it, so it stays the moment they first showed interest.
-- Nothing else writes it.

alter table inspections add column if not exists goback_opened_at timestamptz;

-- The report reads it for every inspection in the text log; no index needed at
-- this size, but this keeps the "warm list" query cheap as it grows.
create index if not exists inspections_goback_opened_idx
  on inspections (goback_opened_at)
  where goback_opened_at is not null;

-- Verify (all zeros until the first homeowner clicks a link):
--   select count(*) filter (where goback_opened_at is not null) as opened,
--          count(*) filter (where goback_opened_at is not null and review_appt_at is null) as warm
--   from inspections;
