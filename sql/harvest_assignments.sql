-- Enhanced Planned Day (Sr-only) — a manager splits the region's IQ + No-sit pins
-- into balanced geographic clusters, one per Sr rep (incl. themselves). Each rep's
-- Start-my-day loads their published cluster. This table holds those assignments.
-- Run in the CCG Supabase SQL editor. Safe to re-run.

create table if not exists public.harvest_assignments (
  id            uuid primary key default gen_random_uuid(),
  rep_token     text,                       -- sales_reps.harvest_token (whose day this is)
  rep_name      text,
  zone          text,
  plan_date     date not null,              -- the day this plan is for (ET)
  pin_ids       jsonb not null default '[]',-- ordered canvass_prospects ids for this rep's cluster
  cluster_index int,                         -- which auto-split cluster (before any manual reassignment)
  published     boolean not null default false,
  created_by    text,                        -- manager token that planned it
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists ha_rep_date  on public.harvest_assignments (rep_token, plan_date);
create index if not exists ha_zone_date on public.harvest_assignments (zone, plan_date);
-- one row per rep per day (upsert target)
create unique index if not exists ha_rep_day_uq on public.harvest_assignments (rep_token, plan_date);

alter table public.harvest_assignments enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='harvest_assignments' and policyname='ha_all') then
    create policy ha_all on public.harvest_assignments for all using (true) with check (true);
  end if;
end $$;
