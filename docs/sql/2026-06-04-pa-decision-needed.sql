-- 2026-06-04-pa-decision-needed.sql
--
-- "PA Decision Needed" funnel. When a PA relationship on a damage deal
-- ends or stalls — the deal went Lost in JN while assigned, it's an old
-- "Sit Sold PA" record, the PA Ops Hub refused it, or the assigned PA was
-- deactivated — the deal is pulled OFF the PA portal and parked here for a
-- US Shingle manager to reassign to an active PA.
--
-- Columns:
--   pa_decision_needed     true  = parked in the manager Decision Needed
--                          queue; kept OUT of the claimable pool and out
--                          of any PA's "My claims".
--   pa_decision_reason     human text: why it landed here.
--   pa_decision_at         when it was parked.
--   pa_decision_resolved_at when a manager assigned/dismissed it. Acts as
--                          a guard so the JN-status reconcile + the Lost
--                          cron don't immediately re-pull a deal the
--                          manager deliberately reinstated (JN may still
--                          say "Lost" — we override locally).
--   pa_assignment_note     free-text note the manager writes when assigning;
--                          shown to the PA in their portal on that claim.

alter table inspections
  add column if not exists pa_decision_needed      boolean not null default false,
  add column if not exists pa_decision_reason      text,
  add column if not exists pa_decision_at          timestamptz,
  add column if not exists pa_decision_resolved_at timestamptz,
  add column if not exists pa_assignment_note       text;

-- Partial index — the queue only ever reads the parked rows.
create index if not exists inspections_pa_decision_needed_idx
  on inspections (pa_decision_needed)
  where pa_decision_needed;
