-- pa_date_blocks: DATE-specific appointment-slot blocks for Public Adjusters.
--
-- Mirrors pa_slot_blocks, but keyed to a specific calendar DATE (ET) instead of
-- a weekday — so a PA can mark off individual 2-hour slots on individual dates
-- (e.g. "off June 2nd, 9–11") ON TOP OF their recurring weekly availability.
-- A row's PRESENCE means "blocked" (absence = available), same as pa_slot_blocks.
-- The scheduler (pa-schedule-api.js) hides a slot if it's blocked by EITHER the
-- weekly pattern OR a date-specific block.
--
-- Run once in the Supabase SQL editor.

create table if not exists public.pa_date_blocks (
  id         bigint generated always as identity primary key,
  pa_id      uuid    not null references public.pas(id) on delete cascade,
  date       date    not null,            -- calendar date, ET (YYYY-MM-DD)
  start_min  integer not null,            -- minutes from ET midnight (540 = 9 AM)
  created_at timestamptz not null default now(),
  unique (pa_id, date, start_min)
);

create index if not exists pa_date_blocks_pa_date_idx on public.pa_date_blocks (pa_id, date);

-- Match pa_slot_blocks access (this internal tool reaches Supabase with the anon
-- key via PostgREST).
alter table public.pa_date_blocks disable row level security;
grant all on table public.pa_date_blocks to anon, authenticated;
