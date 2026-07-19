-- Harvest Tool Training & Certification.
-- Office-editable lessons (sections: text + a screenshot) and a test per track
-- ('manager' | 'rep'). A rep/manager must score >= PASS% before the tool unlocks.
-- Results record who passed, their score, and which sections they missed (for
-- remediation — the fail path sends them back to re-read those sections).
--
-- Run once in the Supabase SQL editor. Safe to re-run.

create table if not exists public.harvest_training_sections (
  id             uuid primary key default gen_random_uuid(),
  track          text not null,                 -- 'manager' | 'rep'
  sort           int  not null default 0,
  title          text not null default '',
  body           text not null default '',      -- lesson text (plain / light markdown)
  screenshot_url text,                           -- public URL of the uploaded screenshot
  active         boolean not null default true,
  updated_at     timestamptz not null default now()
);
create index if not exists hts_track_idx on public.harvest_training_sections (track, sort);

create table if not exists public.harvest_training_questions (
  id            uuid primary key default gen_random_uuid(),
  track         text not null,
  section_id    uuid references public.harvest_training_sections(id) on delete set null, -- which section it tests (for remediation)
  sort          int  not null default 0,
  prompt        text not null default '',
  choices       jsonb not null default '[]',    -- array of choice strings
  correct_index int  not null default 0,
  active        boolean not null default true,
  updated_at    timestamptz not null default now()
);
create index if not exists htq_track_idx on public.harvest_training_questions (track, sort);

create table if not exists public.harvest_training_results (
  id                uuid primary key default gen_random_uuid(),
  user_type         text not null,              -- 'rep' | 'manager'
  user_key          text not null,              -- rep harvest_token OR manager token
  name              text,
  track             text not null,
  score             int,                        -- percent 0-100
  passed            boolean not null default false,
  wrong_section_ids jsonb not null default '[]',
  taken_at          timestamptz not null default now()
);
create index if not exists htr_user_idx on public.harvest_training_results (user_type, user_key, taken_at desc);

-- Permissive RLS — same posture as the other harvest tables (app uses the anon key).
alter table public.harvest_training_sections  enable row level security;
alter table public.harvest_training_questions enable row level security;
alter table public.harvest_training_results   enable row level security;
drop policy if exists hts_all on public.harvest_training_sections;
create policy hts_all on public.harvest_training_sections  for all to anon, authenticated using (true) with check (true);
drop policy if exists htq_all on public.harvest_training_questions;
create policy htq_all on public.harvest_training_questions for all to anon, authenticated using (true) with check (true);
drop policy if exists htr_all on public.harvest_training_results;
create policy htr_all on public.harvest_training_results   for all to anon, authenticated using (true) with check (true);

-- Screenshot storage: a public bucket the office admin uploads to (anon insert + read).
insert into storage.buckets (id, name, public) values ('harvest-training', 'harvest-training', true)
  on conflict (id) do nothing;
drop policy if exists htimg_read on storage.objects;
create policy htimg_read  on storage.objects for select to anon, authenticated using (bucket_id = 'harvest-training');
drop policy if exists htimg_write on storage.objects;
create policy htimg_write on storage.objects for insert to anon, authenticated with check (bucket_id = 'harvest-training');

-- ── Starter OUTLINE (titles only — fill in the body, screenshot, and questions on
--    the Training admin page). Only seeds when a track has no sections yet. ──
insert into public.harvest_training_sections (track, sort, title, body)
select * from (values
  ('manager', 10, 'Welcome — how this certification works', 'You''ll read each section, then take a short test. Score 80% or higher to unlock the tool. Miss too many and you''ll come back here to re-read the sections you missed.'),
  ('manager', 20, 'The Harvesting Map — the big picture', ''),
  ('manager', 30, 'Your Live Team Map (where your reps are)', ''),
  ('manager', 40, 'How your reps plan their day (Smart Scheduling)', ''),
  ('manager', 50, 'Start my day & Route an area', ''),
  ('manager', 60, 'Go-backs', ''),
  ('manager', 70, 'Signing an inspection', ''),
  ('manager', 80, 'Location audit — spotting fake work', ''),
  ('manager', 90, 'Reading the reports', '')
) as v(track, sort, title, body)
where not exists (select 1 from public.harvest_training_sections where track = 'manager');

insert into public.harvest_training_sections (track, sort, title, body)
select * from (values
  ('rep', 10, 'Welcome — how this works', 'Read each section, then pass the short test (80%) to unlock your map.'),
  ('rep', 20, 'Opening your map & reading the pins', ''),
  ('rep', 30, 'Start my day', ''),
  ('rep', 40, 'Route an area', ''),
  ('rep', 50, 'Plan your day around your appointments', ''),
  ('rep', 60, 'Statusing a door (how''d it go?)', ''),
  ('rep', 70, 'Go-backs', ''),
  ('rep', 80, 'Sign an inspection', ''),
  ('rep', 90, 'Drop your own pin (self-generated lead)', '')
) as v(track, sort, title, body)
where not exists (select 1 from public.harvest_training_sections where track = 'rep');
