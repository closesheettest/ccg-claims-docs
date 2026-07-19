-- Harvesting Map — location audit on every rep action.
-- Adds the rep's GPS (where they physically were) + how far that was from the door
-- + how trustworthy the fix was, to every canvass_activity row. This is what makes
-- "couch canvassing" (statusing a whole route from one spot without leaving home)
-- visible in the office report: the flag + distance + a cluster of identical coords.
--
-- loc_flag:
--   'verified' — rep was within range of the door (a real, credited GPS fix)
--   'gps_off'  — phone had no real satellite lock (no fix, or accuracy worse than
--                150 m — a cell-tower/wifi guess). We can't confirm OR deny, so the
--                rep gets the benefit of the doubt but the action is still recorded.
--   'far'      — phone was CONFIDENT the rep was well away from the door. Either a
--                mis-geocoded pin (one-off, harmless) or fake work (shows up as many
--                'far' rows from the same coordinates). This is the one to watch.
--
-- Run this once in the Supabase SQL editor. Safe to re-run.

alter table public.canvass_activity add column if not exists lat      double precision;
alter table public.canvass_activity add column if not exists lng      double precision;
alter table public.canvass_activity add column if not exists acc_m    integer;   -- GPS accuracy radius the phone reported, in metres
alter table public.canvass_activity add column if not exists dist_ft  integer;   -- straight-line feet from the rep to the door at action time
alter table public.canvass_activity add column if not exists loc_flag text;      -- 'verified' | 'gps_off' | 'far'

-- Quickly pull the flagged (non-verified) actions for the office report.
create index if not exists canvass_activity_flag_idx
  on public.canvass_activity (rep_name, loc_flag, created_at desc);
