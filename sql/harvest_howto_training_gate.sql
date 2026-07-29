-- DoorDispatcher training gate — the "watch everything, then the test unlocks" flow.
-- Landing (?mode=harvesttraining): "Why you want to use DoorDispatcher" video → the How-To
-- tool list (each tool marks watched when opened) → progress → at 100% the 80% test unlocks.
-- Run once in the CCG Supabase SQL editor. Safe to re-run.

-- 1) A "Why" video URL on the shared How-To config (the "How" video is already video_url).
alter table public.harvest_howto_config add column if not exists why_video_url text;

-- 2) Per-rep record of which How-To tools they've OPENED (watched). One row per (rep, tool).
create table if not exists public.harvest_howto_watched (
  user_key   text not null,          -- the rep's harvest token (or manager token)
  tool_id    uuid not null references public.harvest_howto_tools(id) on delete cascade,
  watched_at timestamptz not null default now(),
  primary key (user_key, tool_id)
);
create index if not exists hhw_user on public.harvest_howto_watched (user_key);

alter table public.harvest_howto_watched enable row level security;
drop policy if exists hhw_all on public.harvest_howto_watched;
create policy hhw_all on public.harvest_howto_watched for all to anon, authenticated using (true) with check (true);
