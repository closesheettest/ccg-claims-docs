-- Door Dispatcher — INSPECTION MODULE. An inspector-facing map of every inspection
-- that still needs inspecting, with per-inspector links, route-my-day, a route-lock
-- (a boxed route hides those inspections from other inspectors for 30 min), and a
-- pin-by-pin visit audit (on-roof timestamps + GPS) that powers the inspector report.
-- Run once in the CCG Supabase SQL editor. Safe to re-run.

-- 1) Persistent per-inspector map link token (mirrors sales_reps.harvest_token).
--    Link: /?mode=inspectmap&it=<map_token>
alter table public.inspectors add column if not exists map_token uuid default gen_random_uuid();
update public.inspectors set map_token = gen_random_uuid() where map_token is null;
create unique index if not exists inspectors_map_token on public.inspectors (map_token);

-- 2) Route-lock on inspections (mirrors canvass_prospects route_claims). When an
--    inspector boxes a route, these stamp their claim; a claim older than 30 min is
--    stale and reopens. Other inspectors don't see claimed inspections.
alter table public.inspections add column if not exists route_claim_by    text;
alter table public.inspections add column if not exists route_claim_by_jn text;
alter table public.inspections add column if not exists route_claim_at     timestamptz;
create index if not exists inspections_route_claim_at on public.inspections (route_claim_at) where route_claim_at is not null;

-- 3) Pin-by-pin visit audit — the real on-roof timestamps + GPS (what the current
--    inspector report is missing). One row per event as the inspector works a pin.
create table if not exists public.inspection_visits (
  id            bigint generated always as identity primary key,
  inspection_id uuid references public.inspections(id) on delete set null,
  inspector_id  uuid,
  inspector_name text,
  event         text not null,          -- 'arrived' | 'started' | 'completed'
  latitude      double precision,       -- inspector's GPS when the event fired
  longitude     double precision,
  dist_ft       numeric,                -- distance from the inspection's geocoded point (anti-fake-work)
  at            timestamptz not null default now()
);
create index if not exists inspection_visits_inspector_at on public.inspection_visits (inspector_id, at);
create index if not exists inspection_visits_inspection   on public.inspection_visits (inspection_id);

alter table public.inspection_visits enable row level security;
drop policy if exists inspection_visits_all on public.inspection_visits;
create policy inspection_visits_all on public.inspection_visits for all to anon, authenticated using (true) with check (true);
