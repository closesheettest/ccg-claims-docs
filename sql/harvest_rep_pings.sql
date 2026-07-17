-- Live rep location breadcrumbs for the office "team view" on the Harvesting Map.
-- Reps' map posts their GPS every ~60s (harvest-ping); the office/admin map polls
-- harvest-team to draw each rep's current dot + trailing line + last action.
create table if not exists harvest_rep_pings (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid,
  rep_name text,
  lat double precision not null,
  lng double precision not null,
  at timestamptz not null default now()
);
-- Fast "this rep's recent pings, newest first" + a time filter for the office view.
create index if not exists idx_harvest_pings_rep_at on harvest_rep_pings (rep_id, at desc);
create index if not exists idx_harvest_pings_at on harvest_rep_pings (at desc);

grant select, insert, delete on harvest_rep_pings to anon, authenticated;
