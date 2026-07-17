-- PostGIS spatial index + server-side clustering for the Harvesting Map.
-- Same architecture as SalesRabbit/RepCard: a real geographic point column with
-- a GiST index, and a function that aggregates the doors in view into a coarse
-- grid so a zoomed-out map ships a few hundred cluster counts instead of pulling
-- hundreds of thousands of pins.
--
-- Run once, in the Supabase SQL editor, during a quiet moment: step 2 rewrites
-- the whole canvass_prospects table (~227k rows) to backfill the point column —
-- it takes up to a minute and briefly locks writes. It's idempotent (safe to
-- re-run if it times out).

-- 1. PostGIS.
create extension if not exists postgis;

-- 2. A generated geographic point (lon/lat, WGS84). "generated stored" means it
--    backfills every existing row now AND auto-fills on every future insert/update
--    from the JN sync / uploads — no trigger to maintain.
alter table canvass_prospects
  add column if not exists geom geometry(Point, 4326)
  generated always as (
    case when latitude is not null and longitude is not null
      then ST_SetSRID(ST_MakePoint(longitude, latitude), 4326) end
  ) stored;

-- 3. The spatial index — this is what makes "what's in this rectangle" instant.
create index if not exists idx_canvass_geom on canvass_prospects using gist (geom);

-- 4. Clustering: grid-aggregate the doors inside the current view using the GiST
--    index (geom && envelope). Returns one row per non-empty cell: its center,
--    the count, and the dominant status (for the bubble color).
create or replace function canvass_clusters(
  min_lat double precision,
  min_lng double precision,
  max_lat double precision,
  max_lng double precision,
  cells   integer default 48,
  statuses text[] default null
)
returns table(cy double precision, cx double precision, n bigint, top_status text)
language sql
stable
set statement_timeout to '25s'
as $$
  with g as (
    select
      floor((ST_Y(geom) - min_lat) / greatest((max_lat - min_lat) / cells, 1e-9))::int as gy,
      floor((ST_X(geom) - min_lng) / greatest((max_lng - min_lng) / cells, 1e-9))::int as gx,
      status
    from canvass_prospects
    where geom && ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326)
      and (statuses is null or status = any(statuses))
  )
  select
    min_lat + (gy + 0.5) * ((max_lat - min_lat) / cells) as cy,
    min_lng + (gx + 0.5) * ((max_lng - min_lng) / cells) as cx,
    count(*)::bigint                                      as n,
    mode() within group (order by status)                as top_status
  from g
  group by gy, gx;
$$;

grant execute on function canvass_clusters(double precision, double precision, double precision, double precision, integer, text[]) to anon, authenticated;
