-- ============================================================
-- Auto SMS registry
-- ------------------------------------------------------------
-- Drives the "Auto SMS" manager tile and gates every automated
-- text the app sends. Each row = one automated message:
--   enabled       on/off switch (false silences that text)
--   recipients    jsonb array of EXTRA copy-recipients:
--                 [{ "name": "Neal", "phone": "+15085551234" }]
--                 (these are added ON TOP of the message's normal
--                  audience — e.g. the whole field, or ADMIN_ALERT_PHONE)
--   last_sent_at  stamped by the cron each time it fires
--   last_status   short status string from the last run
--
-- RLS stays DISABLED (same posture as the rest of the app — the
-- anon key reads/writes it client-side and in functions).
-- ============================================================

create table if not exists public.auto_sms (
  key            text primary key,
  name           text not null,
  description    text,
  schedule_label text,
  audience_note  text,
  enabled        boolean not null default true,
  recipients     jsonb   not null default '[]'::jsonb,
  last_sent_at   timestamptz,
  last_status    text,
  updated_at     timestamptz not null default now()
);

alter table public.auto_sms disable row level security;

-- Seed the five automated texts. ON CONFLICT keeps existing
-- enabled/recipients if you re-run this (only refreshes the
-- descriptive copy).
insert into public.auto_sms (key, name, description, schedule_label, audience_note, enabled) values
  ('daily_leaderboard',
   'Daily Leaderboard Snapshot',
   'Morning standings text: which team starts the day in the lead and who is chasing.',
   'Every day at 9:00 AM ET',
   'Whole field (all active reps + regional managers)',
   true),
  ('leaderboard_hype',
   'Lead-Change Hype Text',
   'Fires only when a NEW team takes 1st place during the week.',
   'Checked every 5 minutes',
   'Whole field (all active reps + regional managers)',
   true),
  ('cert_retry_alert',
   'Cert Re-fire Alert',
   'Warns admin when a certificate PDF that should have reached JN had to be re-fired (or failed).',
   'Hourly at :20',
   'ADMIN_ALERT_PHONE + extras below',
   true),
  ('daily_orphan_alert',
   'JN Sync Orphan Alert',
   'Daily list of signings from the last 24h that never reached JobNimbus.',
   'Every day at 12:00 PM UTC',
   'ADMIN_ALERT_PHONE + extras below',
   true),
  ('pending_results_alert',
   'Pending Result Push Failures',
   'Alerts admin when one or more inspector results failed to push to JN.',
   'Hourly at :05',
   'ADMIN_ALERT_PHONE + extras below',
   true)
on conflict (key) do update set
  name           = excluded.name,
  description    = excluded.description,
  schedule_label = excluded.schedule_label,
  audience_note  = excluded.audience_note,
  updated_at     = now();
