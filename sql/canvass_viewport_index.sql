-- Composite index for the Harvesting Map's viewport query.
--
-- The map loads pins with:
--   WHERE status IN (...) AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?
-- With 227k+ door pins and only a (latitude, longitude) index, Postgres still
-- had to heap-check `status` on every in-bounds row — a lot of work on every
-- pan/zoom, which is what's exhausting the project's compute.
--
-- This index leads with `status` (equality) then latitude/longitude (range), so
-- each map move is an index range scan over just the matching rows instead of a
-- broad scan. Keep the plain (latitude, longitude) index too — it still serves
-- the installs layer and any status-less lookups.
--
-- On a 227k-row table this build takes a few seconds and briefly locks writes;
-- run it during a quiet moment.
create index if not exists idx_canvass_status_lat_lng
  on canvass_prospects (status, latitude, longitude)
  where latitude is not null and longitude is not null;
