-- sql/canvass_prospects_indexes.sql
--
-- Stop the map sorting a million rows on every load.
--
-- canvass_prospects is ~1.12M rows. Latitude/longitude are indexed, so the map's
-- bounding-box read is fast (~0.2s). But harvest-pins.js — the feed behind every
-- map load, for every rep, all day — also does `order by created_at desc`, and
-- created_at has no index. Postgres therefore sorts the whole table to answer it:
-- a bare `order by created_at desc limit 1` measured at 3.15 SECONDS.
--
-- That is what has had DISK IO pinned at 100% since the 1.2M records landed
-- (Neal, 2026-08-19). The syncs filter on updated_at and pay the same cost.
--
-- CONCURRENTLY so the live map keeps working while these build. Run them ONE AT A
-- TIME — CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so
-- pasting all of them together will fail. Expect a few seconds each.

create index concurrently if not exists canvass_prospects_created_at_idx
  on canvass_prospects (created_at desc);

-- The column is status_updated_at, NOT updated_at — there is no updated_at on this
-- table, and `updated_at` only ever matched as a substring of it. Measured at
-- 3.19s before this index, ~0.14s after.
create index concurrently if not exists canvass_prospects_status_updated_at_idx
  on canvass_prospects (status_updated_at desc);

-- Verify the sort is gone (should drop from seconds to milliseconds, and the plan
-- should say Index Scan rather than Seq Scan + Sort):
--   explain analyze select id from canvass_prospects order by created_at desc limit 1;
