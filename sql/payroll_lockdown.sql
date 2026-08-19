-- ============================================================
-- LOCK DOWN THE PAYROLL TABLES
-- ------------------------------------------------------------
-- Run this AFTER the site has been deployed with
-- SUPABASE_SERVICE_ROLE_KEY set in Netlify. Order matters: the
-- functions must already be using the service key, or enabling
-- RLS locks the app out of its own data.
--
-- Why: this app's anon key ships inside the public page bundle,
-- and these tables had RLS off. That meant anybody could read —
-- and write — the roster, the timecards, and worse:
--   • payroll_sessions holds live login tokens. A stolen token
--     IS the login, including a manager's.
--   • an insert into any of these tables was accepted.
--
-- Enabling RLS with NO policies denies the anon key everything.
-- The service_role key bypasses RLS by design, so the Netlify
-- functions keep working and remain the only way in.
-- ============================================================

alter table public.payroll_shifts         enable row level security;
alter table public.payroll_departments    enable row level security;
alter table public.payroll_employees      enable row level security;
alter table public.payroll_time_entries   enable row level security;
alter table public.payroll_time_off       enable row level security;
alter table public.payroll_holidays       enable row level security;
alter table public.payroll_week_approvals enable row level security;
alter table public.payroll_week_submits   enable row level security;
alter table public.payroll_sessions       enable row level security;

-- Deliberately NO policies. Nothing reaches these tables except the
-- service key, which the browser never sees.

-- Check it worked — every row should say rowsecurity = true:
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' and tablename like 'payroll_%'
--   order by tablename;
