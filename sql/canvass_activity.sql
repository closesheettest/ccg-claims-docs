-- Harvesting Map — rep activity log for reporting.
-- Every VISIT (a "Next" tap while on a route, gated to within 100 ft of the pin)
-- and every STATUS change is logged here with the rep + round + time, so the
-- office can report: pins visited, rounds run, last-visit time, and outcome
-- counts (appointments, not-interested, dead, sold …).
--
-- Run this once in the Supabase SQL editor.

create table if not exists public.canvass_activity (
  id          uuid primary key default gen_random_uuid(),
  pin_id      uuid,
  rep_name    text,
  rep_token   text,
  kind        text not null default 'visit',   -- 'visit' | 'status'
  from_status text,
  to_status   text,
  round       int,
  created_at  timestamptz not null default now()
);

create index if not exists canvass_activity_rep_idx  on public.canvass_activity (rep_name, created_at desc);
create index if not exists canvass_activity_time_idx on public.canvass_activity (created_at desc);
create index if not exists canvass_activity_pin_idx  on public.canvass_activity (pin_id);

-- Same permissive access the other harvest tables use (the map reads/writes with
-- the anon key). Allow anon + authenticated to insert and read.
alter table public.canvass_activity enable row level security;

drop policy if exists canvass_activity_all on public.canvass_activity;
create policy canvass_activity_all
  on public.canvass_activity
  for all
  to anon, authenticated
  using (true)
  with check (true);
