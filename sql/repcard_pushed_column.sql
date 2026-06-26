-- One-time setup for the WEEKLY RepCard install-pin sync
-- (netlify/functions/cron-sync-repcard-pins.js).
--
-- Adds a column that records which installs have already been pushed into
-- RepCard, so the weekly sync only creates pins for NEW installs (RepCard's
-- API can't dedup on its own).
--
-- Run this ONCE in the CCG Supabase SQL editor. Then seed the ~1,539 pins that
-- are already in RepCard so they are NOT duplicated:
--   GET https://free-roof-inspections.netlify.app/.netlify/functions/cron-sync-repcard-pins?seed=1

ALTER TABLE installs ADD COLUMN IF NOT EXISTS repcard_pushed_at timestamptz;
