-- Server-side clustering for the Harvesting Map.
--
-- At a zoomed-out view the map used to try to DOWNLOAD thousands of individual
-- pins (capped at 6,000 / 40,000). This aggregates the pins in the current
-- bounding box into a coarse GRID server-side and returns one row per non-empty
-- cell: its center, how many pins it holds, and the dominant status (for color).
-- So a statewide view ships a few hundred cluster bubbles instead of thousands
-- of rows — and it can represent ALL 227k pins, with no cap.
--
-- Needs the composite index (sql/canvass_viewport_index.sql) to stay fast.
--
--   select * from canvass_clusters(min_lat, min_lng, max_lat, max_lng, cells, statuses)
--     cells    = grid resolution (e.g. 48 → up to 48×48 cells)
--     statuses = optional whitelist of pin statuses (the rep's level), or null=all
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
      floor((latitude  - min_lat) / greatest((max_lat - min_lat) / cells, 1e-9))::int as gy,
      floor((longitude - min_lng) / greatest((max_lng - min_lng) / cells, 1e-9))::int as gx,
      status
    from canvass_prospects
    where latitude  between min_lat and max_lat
      and longitude between min_lng and max_lng
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
