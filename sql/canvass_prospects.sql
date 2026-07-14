-- Canvassing map ("Sales Rabbit"-style): uploaded prospect addresses that reps
-- work door-to-door, updating each pin's status as they go.
--
-- Baseline flow: office uploads a list → each address is geocoded → dropped on
-- the map as status 'iq'. A rep taps a pin and changes the status (e.g. to
-- 'appt' after booking one). v1 just records the status on the pin; JobNimbus
-- integration comes later.
create extension if not exists "pgcrypto";

create table if not exists canvass_prospects (
  id                uuid primary key default gen_random_uuid(),
  list_name         text,                       -- which uploaded batch this came from
  name              text,                       -- optional homeowner name
  address           text not null,
  city              text,
  state             text,
  zip               text,
  latitude          double precision,
  longitude         double precision,
  geocode_status    text default 'pending',     -- pending | ok | failed
  status            text not null default 'iq', -- iq | appt | not_home | callback | not_interested | sold | dnk
  status_updated_at timestamptz,
  status_by         text,                        -- rep who last set the status
  assigned_rep_id   text,
  assigned_rep_name text,
  notes             text,
  status_log        jsonb default '[]'::jsonb,   -- [{at, from, to, by, note}]
  jn_job_id         text,                        -- set later if converted into a JN deal
  created_at        timestamptz default now()
);

create index if not exists canvass_prospects_status_idx on canvass_prospects (status);
create index if not exists canvass_prospects_list_idx   on canvass_prospects (list_name);
create index if not exists canvass_prospects_geo_idx     on canvass_prospects (latitude, longitude);

-- The app talks to Supabase with the anon/publishable key (same as inspections),
-- so allow that key to read + write this table.
alter table canvass_prospects enable row level security;
drop policy if exists canvass_prospects_all on canvass_prospects;
create policy canvass_prospects_all on canvass_prospects for all using (true) with check (true);
grant all on canvass_prospects to anon, authenticated;
