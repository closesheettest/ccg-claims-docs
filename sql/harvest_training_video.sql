-- Harvest Tool Training — per-track TRAINING VIDEO.
-- One editable video per track ('rep' | 'manager'). The office sets it on the Training
-- admin page (paste a YouTube/Vimeo/HeyGen share link, OR upload the .mp4). The training
-- page plays it first, then offers "Take my test" / "Read the study guide".
--
-- Run once in the CCG Supabase SQL editor. Safe to re-run.

create table if not exists public.harvest_training_config (
  track       text primary key,               -- 'rep' | 'manager'
  video_url   text,                            -- youtube/vimeo/heygen link OR uploaded .mp4 public URL
  video_title text not null default '',        -- optional heading shown above the player
  updated_at  timestamptz not null default now()
);

-- Seed empty rows so the admin always has something to edit.
insert into public.harvest_training_config (track) values ('rep'), ('manager')
  on conflict (track) do nothing;

-- Permissive RLS — same posture as the other harvest_training tables (anon key app).
alter table public.harvest_training_config enable row level security;
drop policy if exists htc_all on public.harvest_training_config;
create policy htc_all on public.harvest_training_config for all to anon, authenticated using (true) with check (true);

-- The 'harvest-training' public bucket (created by sql/harvest_training.sql) also holds the
-- uploaded .mp4. No extra policy needed — its read/write policies already cover the bucket.
