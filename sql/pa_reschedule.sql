-- Missed-PA-appointment self-reschedule. When a homeowner no-shows a PA appointment,
-- we text/email them a private link to pick a new date/time themselves.
-- Run once in the CCG Supabase SQL editor. Safe to re-run.

alter table public.pa_appointments add column if not exists reschedule_token   text;
alter table public.pa_appointments add column if not exists reschedule_sent_at timestamptz;
alter table public.pa_appointments add column if not exists reschedule_count    int not null default 0;
create index if not exists pa_appts_reschedule_token on public.pa_appointments (reschedule_token);
