-- Regional Managers table (CCG side) for the zone-scoped Records page.
--
-- Each regional manager gets one row with a unique token. The token is
-- the only "auth" — they save a URL like
--   https://ccg-claims-docs.netlify.app/?manager=<token>
-- to their phone and tap to see their zone's records. Same pattern as
-- TMS /regional-manager/:token, just CCG-side because each Supabase
-- project owns its own data.
--
-- Zone string ('Zone 1' / 'Zone 2' / 'Zone 3' / 'Zone 4') matches the
-- TMS canonical zone naming so the rep-zone lookup (TMS /rep-zones)
-- returns matching values.
--
-- After this runs, capture each manager's URL — Neal SMSes them out.
-- Tokens are UUIDs (unguessable). To rotate a token, UPDATE the row
-- with gen_random_uuid() and re-text the new URL.

create table if not exists regional_managers (
  id uuid primary key default gen_random_uuid(),
  zone text not null unique,         -- 'Zone 1' / 'Zone 2' / 'Zone 3' / 'Zone 4'
  name text not null,                -- 'Tony', 'Richard', 'Chad', 'Sam'
  phone text,                        -- their help line (display only here)
  token uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS: open since the only "auth" is the token-in-URL. The Netlify
-- function that backs the page validates the token server-side before
-- returning any data, so even public SELECT here doesn't leak much
-- (just the zone/name/phone — already public info).
alter table regional_managers enable row level security;
drop policy if exists "regional_managers_public_select" on regional_managers;
create policy "regional_managers_public_select" on regional_managers for select using (true);

-- Seed the four current managers. If a row already exists for a zone
-- (re-run), the on-conflict clause keeps the existing token so we
-- don't break the URL Neal already texted out.
insert into regional_managers (zone, name, phone) values
  ('Zone 1', 'Tony',    '+19045608819'),
  ('Zone 2', 'Richard', '+18137974890'),
  ('Zone 3', 'Chad',    '+19418375657'),
  ('Zone 4', 'Sam',     '+17868077751')
on conflict (zone) do update
  set name = excluded.name,
      phone = excluded.phone,
      updated_at = now();

-- Return the URLs Neal needs to SMS each manager.
select
  zone,
  name,
  'https://free-roof-inspections.netlify.app/?manager=' || token::text as records_url
from regional_managers
order by zone;
