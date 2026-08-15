-- sql/harvest_dupe_fix.sql
--
-- THE DOUBLE-PIN BUG (Aug 14-15 2026). Reps saw every door twice on the
-- DoorDispatcher, and routes listed the same house 2-4 times.
--
-- Root cause: the JN syncs (harvest-sync-iq-background, harvest-sync-nosits)
-- read "which pins already exist?" from Supabase, then insert whatever is
-- missing. Both readers FAILED OPEN:
--   • harvest-sync-nosits sbGet()      → `if (!r.ok) return []`  (one page, no limit)
--   • harvest-sync-iq     sbGetAll()   → `if (!r.ok) break`      (partial page set)
-- so ANY error on that read (a statement timeout) came back as "nothing exists"
-- and the sync re-inserted the entire list as new pins. The IQ sync runs every
-- 30 minutes, the no-sit sync twice a day.
--
-- What made those reads start failing: canvass_prospects went from ~small to
-- 1.56M rows on Aug 14 (the "David Qualified" upload). The dedupe queries filter
-- on list_name / jn_job_id / status / extra->>'jn_contact_id' — none of which had
-- an index — so each one became a seq scan over 1.56M rows and began tripping the
-- statement timeout. That is why this started "since the upload".
--
-- This file does three things:
--   1) deletes the duplicate rows already on the map (keeps the best row per house)
--   2) adds the indexes that stop those dedupe queries from timing out
--   3) adds UNIQUE indexes so a repeat of this bug is physically impossible
--
-- Run it in the Supabase SQL editor (CCG project) top to bottom.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0) LOOK FIRST — how bad is it right now?
-- ─────────────────────────────────────────────────────────────────────────────
select 'JN lead lists' as scope,
       count(*) filter (where n > 1)          as houses_with_dupes,
       coalesce(sum(n - 1) filter (where n > 1), 0) as surplus_rows
from (
  select extra->>'jn_contact_id' as k, count(*) n
  from canvass_prospects
  where extra->>'jn_contact_id' is not null
    and list_name in ('JN Instant Quote', 'JN Facebook', 'JN AI Bot')
  group by 1
) t
union all
select 'JN No-Sits',
       count(*) filter (where n > 1),
       coalesce(sum(n - 1) filter (where n > 1), 0)
from (
  select jn_job_id as k, count(*) n
  from canvass_prospects
  where jn_job_id is not null and list_name = 'JN No-Sits'
  group by 1
) t;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) DELETE THE DUPLICATES
--
-- NOTE (Aug 15 2026): these 491 rows were ALREADY removed over the API, so on the
-- first run these two statements will report 0. They are kept here so the file is
-- a complete, re-runnable fix. Steps 2 and 3 are the ones that still need running.
--
-- Which twin survives, in order:
--   a) a WORKED pin beats a raw lead pin — never throw away a rep's field call
--      (raw = iq / fb / ai / insp / no_sit_reschedule; anything else is worked)
--   b) then the most recently statused row
--   c) then the oldest row (the one reps have had on their map the longest)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1a) JN lead lists — one pin per JobNimbus contact.
with ranked as (
  select id,
         row_number() over (
           partition by extra->>'jn_contact_id'
           order by (status in ('iq','fb','ai','insp','no_sit_reschedule')) asc,  -- worked first
                    status_updated_at desc nulls last,
                    created_at asc
         ) as rn
  from canvass_prospects
  where extra->>'jn_contact_id' is not null
    and list_name in ('JN Instant Quote', 'JN Facebook', 'JN AI Bot')
)
delete from canvass_prospects p
using ranked r
where p.id = r.id and r.rn > 1;

-- 1b) JN No-Sits — one pin per JobNimbus job.
with ranked as (
  select id,
         row_number() over (
           partition by jn_job_id
           order by (status in ('iq','fb','ai','insp','no_sit_reschedule')) asc,
                    status_updated_at desc nulls last,
                    created_at asc
         ) as rn
  from canvass_prospects
  where jn_job_id is not null
    and list_name = 'JN No-Sits'
)
delete from canvass_prospects p
using ranked r
where p.id = r.id and r.rn > 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) INDEXES — so the dedupe reads stop seq-scanning 1.5M rows and timing out.
--    (This is the actual trigger. Without these the syncs stay one slow query
--    away from failing open again.)
-- ─────────────────────────────────────────────────────────────────────────────
create index if not exists canvass_prospects_list_name_idx
  on canvass_prospects (list_name);

create index if not exists canvass_prospects_jn_contact_idx
  on canvass_prospects ((extra->>'jn_contact_id'))
  where extra->>'jn_contact_id' is not null;

create index if not exists canvass_prospects_jn_job_id_idx
  on canvass_prospects (jn_job_id)
  where jn_job_id is not null;

create index if not exists canvass_prospects_status_idx
  on canvass_prospects (status);

-- The no-sit sync's "existing pins" query, exactly.
create index if not exists canvass_prospects_nosit_lookup_idx
  on canvass_prospects (jn_job_id)
  where jn_job_id is not null and status = 'no_sit_reschedule';

-- The IQ sync's address-dedupe index loads pins by ZIP (see the code fix).
create index if not exists canvass_prospects_zip_idx
  on canvass_prospects (zip)
  where latitude is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) THE BACKSTOP — make a duplicate impossible, not just unlikely.
--    Scoped to the sync-managed lists only, so nothing else on the map (rep
--    self-gen pins, uploads, referrals, clovers) is constrained.
--    If step 1 left anything behind these will error — re-run step 0 to see it.
-- ─────────────────────────────────────────────────────────────────────────────
create unique index if not exists canvass_prospects_jn_contact_uniq
  on canvass_prospects ((extra->>'jn_contact_id'))
  where extra->>'jn_contact_id' is not null
    and list_name in ('JN Instant Quote', 'JN Facebook', 'JN AI Bot');

create unique index if not exists canvass_prospects_nosit_job_uniq
  on canvass_prospects (jn_job_id)
  where jn_job_id is not null and list_name = 'JN No-Sits';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) OPTIONAL — THE SECOND DUPLICATE POPULATION (cross-list, from the upload).
--
-- Steps 1-3 fix the SYNC duplicates (same JN contact / same JN job). There is a
-- separate, smaller set: the SAME HOUSE pinned twice under DIFFERENT lists —
-- e.g. a "David Qualified" insp pin landing on a house that already had an IQ pin.
-- Cause: canvass-upload's dedupe read `limit=50000` of a 1.57M-row table during
-- the Aug-14 upload, so it only checked ~3% of the map before inserting.
--
-- Sampling six rep areas on Aug 15: ~2.2% of rep-visible pins (Venice ~5%,
-- Sarasota ~3.5%, Tampa ~2.9%, Port Charlotte 0%). Real, but nothing like the
-- every-pin-is-double the sync bug caused.
--
-- This is DELETE-heavy and matches on address text, so it is deliberately NOT
-- automatic. Run 5a, look at the output, and only then decide on 5b.
-- ─────────────────────────────────────────────────────────────────────────────

-- Normalized street key. It CANONICALISES street types and directionals — it must
-- never DROP them.
--
-- The first version of this function copied _harvest-dupe.js normAddr(), which
-- strips both. That is safe in the JS because it is always paired with a ~20m
-- coordinate check; here there was no such check, and in grid-addressed cities it
-- merged genuinely different houses:
--     '3225 40th|33308'  <-  3225 NE 40TH CT  +  3225 NE 40TH ST   (200m apart)
--     '3300 125th|33323' <-  3300 NW 125TH AVE + ...LN + ...WAY    (3 houses)
-- It reported ~14.5k "duplicates" statewide, ~21% of them false, concentrated in
-- Fort Lauderdale / Pompano / Miami / Hialeah / Hollywood. Keeping the tokens drops
-- Fort Lauderdale from 1,787 doubled houses to 354 and leaves the real ones intact.
--
-- Self-test (run it — rows 1/2 must DIFFER, rows 3/4 must MATCH):
--   select address, harvest_addr_key(address, zip) from (values
--     ('3225 NE 40TH CT','33308'), ('3225 NE 40TH ST','33308'),
--     ('12735 Newton Place','34293'), ('12735 NEWTON PL','34293'),
--     ('9591 N.W. 24th St.','33172')) v(address, zip);
create or replace function harvest_addr_key(addr text, z text)
returns text language sql immutable as $$
  with t as (
    select tok, ord from unnest(string_to_array(
      btrim(regexp_replace(
        -- strip periods/apostrophes FIRST so "N.W." collapses to "nw" rather than "n w"
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

-- 5a) PREVIEW — how many rep-visible houses carry more than one pin, and where.
--     (Only pin types reps actually see; admin-only types can't cause a "double".)
with vis as (
  select id, address, zip, city, status, list_name, status_by, status_updated_at, created_at,
         harvest_addr_key(address, zip) as k
  from canvass_prospects
  where latitude is not null
    and status in ('damage_observed','install_home','roof_fine','clover','iq','fb','ai',
                   'no_sit_reschedule','iq_ni','insp','insp_pending','insp_callback')
), d as (
  select k, count(*) n from vis where k is not null group by k having count(*) > 1
)
select coalesce(v.city,'(no city)') as city,
       count(distinct v.k)                as doubled_houses,
       sum(1) - count(distinct v.k)       as surplus_pins
from vis v join d on d.k = v.k
group by 1
order by surplus_pins desc
limit 40;

-- 5b) THE CLEANUP — one pin per house. Keeps, in order:
--       a) the WORKED pin over a raw lead pin (never discard a rep's field call)
--       b) then the most recently statused
--       c) then the oldest (what reps have had on their map longest)
--     Plus a DISTANCE GUARD: a twin must sit within ~65m of the pin we're keeping.
--     Spot-checking Jacksonville / Orlando / West Palm found every match to be the
--     same rooftop (40 of 40 within 65m), so this rejects nothing legitimate — it's
--     insurance against another normalisation mistake ever reaching a DELETE.
--     UNCOMMENT to run. Take a Supabase backup first.
--
--     What these actually are: two passes of David's data ("David Qualified" vs
--     "David Mailed") pinning the same houses, because canvass-upload's dedupe was
--     reading 50,000 of 1.57M rows. That read is fixed; this is the leftover data.
--
-- with vis as (
--   select id, harvest_addr_key(address, zip) as k, status, status_updated_at, created_at,
--          latitude, longitude
--   from canvass_prospects
--   where latitude is not null
--     and status in ('damage_observed','install_home','roof_fine','clover','iq','fb','ai',
--                    'no_sit_reschedule','iq_ni','insp','insp_pending','insp_callback')
-- ), ranked as (
--   select id, latitude, longitude,
--          row_number() over w as rn,
--          first_value(latitude)  over w as klat,
--          first_value(longitude) over w as klng
--   from vis where k is not null
--   window w as (partition by k
--                order by (status in ('iq','fb','ai','insp','no_sit_reschedule')) asc,
--                         status_updated_at desc nulls last,
--                         created_at asc)
-- )
-- delete from canvass_prospects p using ranked r
-- where p.id = r.id and r.rn > 1
--   and abs(r.latitude  - r.klat) < 0.0006     -- ~65m N/S
--   and abs(r.longitude - r.klng) < 0.0007;    -- ~65m E/W at FL latitudes

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) CONFIRM — both rows should read 0 / 0.
-- ─────────────────────────────────────────────────────────────────────────────
select 'JN lead lists' as scope,
       count(*) filter (where n > 1) as houses_with_dupes,
       coalesce(sum(n - 1) filter (where n > 1), 0) as surplus_rows
from (
  select extra->>'jn_contact_id' as k, count(*) n
  from canvass_prospects
  where extra->>'jn_contact_id' is not null
    and list_name in ('JN Instant Quote', 'JN Facebook', 'JN AI Bot')
  group by 1
) t
union all
select 'JN No-Sits',
       count(*) filter (where n > 1),
       coalesce(sum(n - 1) filter (where n > 1), 0)
from (
  select jn_job_id as k, count(*) n
  from canvass_prospects
  where jn_job_id is not null and list_name = 'JN No-Sits'
  group by 1
) t;
