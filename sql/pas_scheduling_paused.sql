-- Per-PA "pause new appointments" flag. A paused PA stays active (keeps working
-- their existing deals — can still set/reschedule their own homeowners) but is NOT
-- offered for NEW appointment bookings (pa-schedule-api) or new deal auto-assign
-- (cron-assign-pas). Mirrors pa_companies.scheduling_paused, but per PA.
alter table pas add column if not exists scheduling_paused boolean default false;

-- Pause Chad Warren specifically:
update pas set scheduling_paused = true where name = 'Chad Warren';
