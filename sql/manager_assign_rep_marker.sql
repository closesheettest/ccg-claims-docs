-- sql/manager_assign_rep_marker.sql
--
-- When a regional manager assigns a DAMAGE deal to a sales rep from the
-- manager damage queue, we stamp this timestamp. The rep's Damage-visit list
-- normally hides any deal a PA has merely *opened* (pa_opened_at set) — but a
-- manager handing the deal to a rep is an explicit override that must resurface
-- it, and must survive the nightly PA auto-assign. This column records that
-- intent so visit-deal-list can honor it.
--
-- Safe to run repeatedly.

alter table public.inspections
  add column if not exists manager_assigned_to_rep_at timestamptz;
