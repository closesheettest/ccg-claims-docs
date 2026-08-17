-- sql/harvest_cross_list_dupes.sql
--
-- CROSS-LIST duplicate pins — the step sql/harvest_dupe_fix.sql left out.
--
-- That file collapsed duplicates WITHIN a list. This one handles the same house
-- arriving from TWO DIFFERENT uploads, which is what a rep sees as a doubled pin
-- on a house nobody uploaded twice. Found on 80 Springdale Rd, Greenacres:
--
--   RC Contacts Jul-16-2026  created Jul 16  jn_job_id mppy0zot70wh3la6valtp5x
--   David Qualified          created Aug 14  jn_job_id (none)
--
-- Both said "Inspection Sold", ~20 ft apart.
--
-- WHICH ONE WINS: the RC Contacts pin. It's the one carrying the JobNimbus job
-- and the real signing history — the 3,235 rows Neal kept deliberately. David
-- Qualified (1.28M rows) is the bulk map data; its twin is the throwaway.
--
-- Run the steps IN ORDER, one at a time, and read the output of each before
-- running the next. Steps 1 and 2 change nothing.
--
-- ─────────────────────────────────────────────────────────────────────────────

-- 0) The address key. Same corrected version as harvest_dupe_fix.sql — it
--    CANONICALISES street types and directionals and must never DROP them
--    (dropping them merges different houses in grid-addressed cities). Safe to
--    re-run; this is a no-op if it's already there.
create or replace function harvest_addr_key(addr text, z text)
returns text language sql immutable as $$
  with t as (
    select tok, ord from unnest(string_to_array(
      btrim(regexp_replace(
        regexp_replace(regexp_replace(lower(split_part(coalesce(addr,''), ',', 1)), '[.''`]', '', 'g'),
                       '[^a-z0-9]', ' ', 'g'),
        '\s+', ' ', 'g')), ' ')) with ordinality as u(tok, ord)
  ), m as (
    select t.ord, coalesce(x.canon, t.tok) as tok
    from t left join (values
      ('street','st'),('avenue','ave'),('av','ave'),('road','rd'),('drive','dr'),
      ('lane','ln'),('court','ct'),('place','pl'),('boulevard','blvd'),('circle','cir'),
      ('terrace','ter'),('terr','ter'),('highway','hwy'),('parkway','pkwy'),('trail','trl'),
      ('cove','cv'),('point','pt'),('square','sq'),('north','n'),('south','s'),
      ('east','e'),('west','w'),('northeast','ne'),('northwest','nw'),
      ('southeast','se'),('southwest','sw'),('junior','jr'),('doctor','dr')
    ) as x(raw, canon) on x.raw = t.tok
  ), j as (select string_agg(tok, ' ' order by ord) as k from m)
  select case when k ~ '^[0-9]' then k || '|' || coalesce(substring(coalesce(z,'') from '([0-9]{5})'), '') end
  from j
$$;

-- Self-test — rows 1 and 2 must DIFFER, rows 3 and 4 must MATCH.
-- If they don't, STOP: the function didn't replace and the rest of this file
-- would merge houses that aren't the same house.
select address, harvest_addr_key(address, zip) as key from (values
  ('3225 NE 40TH CT','33308'), ('3225 NE 40TH ST','33308'),
  ('12735 Newton Place','34293'), ('12735 NEWTON PL','34293')) v(address, zip);


-- ─────────────────────────────────────────────────────────────────────────────
-- 1) PREVIEW — how many RC Contacts houses have a David Qualified twin.
--    Driven off the 3,235 RC rows and narrowed by zip (indexed) so it never
--    scans the 1.28M-row list. Nothing is changed.
--
--    The 200m guard is deliberately loose: the address key already requires the
--    same street AND the same zip, so this only exists to catch a wildly bad
--    geocode that landed the twin in the next town.

create temporary table _rc_twins as
with rc as (
  select id, zip, latitude, longitude, status, jn_job_id,
         harvest_addr_key(address, zip) as k
  from canvass_prospects
  where list_name = 'RC Contacts Jul-16-2026'
    and address is not null and harvest_addr_key(address, zip) is not null
), zips as (
  select distinct zip from rc where zip is not null
), dq as (
  select p.id, p.zip, p.latitude, p.longitude, p.status, p.jn_job_id,
         p.status_updated_at, p.status_by, p.status_log,
         harvest_addr_key(p.address, p.zip) as k
  from canvass_prospects p
  join zips z on z.zip = p.zip
  where p.list_name = 'David Qualified'
    and p.address is not null
)
select rc.id  as keep_id,
       dq.id  as drop_id,
       rc.status   as keep_status,   dq.status   as drop_status,
       rc.jn_job_id as keep_job,     dq.jn_job_id as drop_job,
       dq.status_updated_at as drop_status_at,
       dq.status_by         as drop_status_by,
       dq.status_log        as drop_status_log
from rc
join dq on dq.k = rc.k
where rc.latitude is null or dq.latitude is null
   or (abs(rc.latitude - dq.latitude) < 0.0018 and abs(rc.longitude - dq.longitude) < 0.0020);

-- How many houses, how many pins to drop, and how many of those drops are
-- carrying something the keeper doesn't have (those get promoted in step 2).
select count(distinct keep_id) as rc_houses_with_a_twin,
       count(*)                as twin_pins_to_delete,
       count(*) filter (where drop_job is not null and keep_job is null)      as twins_with_a_job_the_keeper_lacks,
       count(*) filter (where drop_status is not null and drop_status <> 'new'
                          and (keep_status is null or keep_status = 'new'))   as twins_with_work_the_keeper_lacks
from _rc_twins;

-- Eyeball a few before deleting anything.
select * from _rc_twins limit 25;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2) PROMOTE — before dropping a twin, move anything the keeper is missing onto
--    the keeper, so no real work is lost. In practice the RC rows are already
--    the worked ones, so this usually updates 0 rows. Run it anyway.

update canvass_prospects p
set jn_job_id = t.drop_job
from _rc_twins t
where p.id = t.keep_id
  and p.jn_job_id is null
  and t.drop_job is not null;

update canvass_prospects p
set status            = t.drop_status,
    status_updated_at = t.drop_status_at,
    status_by         = t.drop_status_by,
    status_log        = coalesce(t.drop_status_log, p.status_log)
from _rc_twins t
where p.id = t.keep_id
  and (p.status is null or p.status = 'new')
  and t.drop_status is not null and t.drop_status <> 'new';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3) DELETE the David Qualified twins. Only ids collected in step 1 — this
--    cannot touch an RC Contacts row or any house without a twin.

delete from canvass_prospects p
using _rc_twins t
where p.id = t.drop_id
  and p.list_name = 'David Qualified';   -- belt and braces: never delete a keeper


-- ─────────────────────────────────────────────────────────────────────────────
-- 4) VERIFY — 80 Springdale Rd should now be ONE pin, the RC Contacts one,
--    still Inspection Sold and still carrying its JobNimbus job.

select id, list_name, address, city, zip, status, jn_job_id, status_updated_at
from canvass_prospects
where latitude between 26.6150 and 26.6182
  and longitude between -80.1707 and -80.1674
  and address ilike '80 springdale%';

-- And nothing should be left over.
select count(*) as twins_remaining
from canvass_prospects p join _rc_twins t on p.id = t.drop_id;

drop table if exists _rc_twins;
