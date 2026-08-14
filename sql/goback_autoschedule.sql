-- Auto-Schedule After Inspection: the sender's tracking + the homeowner booking token.
--
-- The sequence (app_settings.goback_autoschedule_config) fires texts to the homeowner
-- after their inspection completes (anchored on inspections.result_at), each message at
-- its own wait+time, and STOPS once they book (inspections.review_appt_at is set). This
-- adds: a per-inspection token for the private booking link, and a per-message send log
-- so a message can never go out twice.

-- 1) Private booking-link token on every inspection.
alter table public.inspections add column if not exists goback_token uuid;
update public.inspections set goback_token = gen_random_uuid() where goback_token is null;
alter table public.inspections alter column goback_token set default gen_random_uuid();
create index if not exists inspections_goback_token_idx on public.inspections (goback_token);

-- 2) One row per (inspection, message index) actually sent — the unique key makes the
--    sender idempotent (a re-run or overlapping cron can't double-text).
create table if not exists public.goback_text_log (
  id            uuid primary key default gen_random_uuid(),
  inspection_id uuid not null,
  msg_idx       int  not null,
  sent_at       timestamptz not null default now(),
  to_phone      text,
  ok            boolean default true,
  unique (inspection_id, msg_idx)
);
create index if not exists goback_text_log_insp_idx on public.goback_text_log (inspection_id);

grant select, insert, update on public.goback_text_log to anon, authenticated;
alter table public.goback_text_log enable row level security;
drop policy if exists gtl_all on public.goback_text_log;
create policy gtl_all on public.goback_text_log for all to anon, authenticated using (true) with check (true);
