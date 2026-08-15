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
