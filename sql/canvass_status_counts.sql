-- True per-status pin counts for the Harvesting Map filter chips.
--
-- The chips used to count the LOADED pins, but the map caps its load (e.g.
-- 40,000) and the load is un-ordered — so once the table filled with a big
-- upload of one status (RC-Contacts inspection leads), smaller buckets like IQ
-- fell outside the cap and showed "(0)" even though 900+ exist. This aggregate
-- returns the real count per status in one fast GROUP BY, so the chips are
-- always accurate regardless of what's rendered.
create or replace function canvass_status_counts()
returns table(status text, n bigint)
language sql
stable
as $$
  select status, count(*)::bigint
  from canvass_prospects
  where latitude is not null and longitude is not null
  group by status;
$$;

grant execute on function canvass_status_counts() to anon, authenticated;
