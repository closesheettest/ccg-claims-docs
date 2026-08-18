-- sql/contest_week_freeze.sql
--
-- Freeze a contest week's result the moment the week closes.
--
-- The bug this fixes: points are earned on timestamped activity, so they never
-- move — but the SCORE is points ÷ active reps, and the rep count was read LIVE
-- from the TMS roster on every request. Deactivate a rep, set someone
-- 'non_field', move a zone, and every FINISHED week silently re-scores itself.
--
-- It changed a winner. Week 1 (Aug 12-13) ended with HURRICANE on top: 26 pts
-- over 5 reps = 5.2, against SHARKS' 32 over 7 = 4.6. Zone 3 later dropped to 6
-- active reps, so the same 32 points became 5.3 and SHARKS retroactively "won" a
-- week they lost (Neal caught it, 2026-08-18).
--
-- So a closed week gets snapshotted here — the whole computed standing, teams and
-- reps and per-day counts — and the report serves this row instead of recomputing.
-- After Thursday, nothing about a past week can change.
create table if not exists contest_week_results (
  week_no    int primary key,
  label      text not null,
  -- "range" is a keyword-ish name in Postgres, so spell it out
  week_range text,
  -- the full { window, attributes, teams } the report would have returned
  payload    jsonb not null,
  -- set when the rep counts came from an operator rather than the live roster
  -- (only the Week 1 backfill, which pre-dates this table)
  reps_note  text,
  frozen_at  timestamptz not null default now()
);

alter table contest_week_results enable row level security;

-- Anyone may READ a frozen week; anyone may INSERT one; NOBODY may update or
-- delete one. That combination is deliberate — it's what makes "frozen" mean
-- frozen. The primary key on week_no means a second freeze of the same week
-- fails loudly instead of quietly overwriting the result, so a past week's
-- standing cannot be changed by anything short of a deliberate SQL statement.
drop policy if exists contest_week_results_read on contest_week_results;
create policy contest_week_results_read on contest_week_results for select using (true);
drop policy if exists contest_week_results_insert on contest_week_results;
create policy contest_week_results_insert on contest_week_results for insert with check (true);

-- Verify — after the first freeze, one row per closed week:
--   select week_no, label, week_range, reps_note, frozen_at from contest_week_results order by week_no;
