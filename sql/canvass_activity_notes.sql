-- Harvesting Map — free-text note on an activity row.
-- Lets a pinless CONTEXT event carry a little detail, so the rep-activity report
-- can EXPLAIN a gap in door-knocking instead of it looking like the rep vanished:
--   * appt_done  → note holds the appointment address + scheduled time, so the
--                  stop-by-stop shows "🗓️ At appointment — 123 Main St" then
--                  "✅ Appointment finished", bracketing the quiet hour.
--   * app_open / app_close → the rep opened or closed the map (phone in pocket),
--                  which explains a stretch with no activity logged.
--
-- Stored as a small JSON string for appt rows ({"a":address,"s":scheduledISO});
-- plain text for anything else. Nullable — old rows and non-context rows leave it
-- empty. Run once in the Supabase SQL editor. Safe to re-run.

alter table public.canvass_activity add column if not exists note text;
