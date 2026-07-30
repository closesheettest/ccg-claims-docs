-- Door Dispatcher "go-backs only" manager override. When on for a rep, their map
-- shows ONLY their post-inspection go-backs (no IQ / inspection-lead / harvest work).
-- Run once in the CCG Supabase SQL editor. Safe to re-run.

alter table public.sales_reps add column if not exists harvest_gobacks_only boolean not null default false;
