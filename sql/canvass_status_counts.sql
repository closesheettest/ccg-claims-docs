-- True per-status pin counts for the Harvesting Map filter chips.
--
-- The chips used to count the LOADED pins, but the map caps its load (e.g.
-- 40,000) and the load is un-ordered — so once the table filled with a big
-- upload of one status (RC-Contacts inspection leads), smaller buckets like IQ
-- fell outside the cap and showed "(0)" even though 900+ exist. This aggregate
-- returns the real count per status so the chips are always accurate.
--
-- IMPORTANT: over a 200k+ row table a plain GROUP BY seq-scans and blows the
-- anon role's short statement timeout (~3s). Two things fix that:
--   1) a PARTIAL index on status (matching the WHERE) → index-only scan, fast;
--   2) a longer statement_timeout scoped to just this function, as a backstop.

-- 1. Partial index so the grouped count is an index-only scan.
create index if not exists idx_canvass_status_geo
  on canvass_prospects (status)
  where latitude is not null and longitude is not null;

-- 2. The aggregate (backstopped with its own timeout).
create or replace function canvass_status_counts()
returns table(status text, n bigint)
language sql
stable
set statement_timeout to '20s'
as $$
  select status, count(*)::bigint
  from canvass_prospects
  where latitude is not null and longitude is not null
  group by status;
$$;

grant execute on function canvass_status_counts() to anon, authenticated;
