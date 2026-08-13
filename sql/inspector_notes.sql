-- Anthony's request: let the rep add pertinent info AT SUBMISSION that rides
-- through to the inspector (e.g. "customer probably won't be home", "referred by
-- the neighbor at 123 Main"). One free-text field on the inspection record, shown
-- on the inspector's map pin + the inspection detail.
--
-- Run in the Supabase SQL editor (CCG project ddtajhfsnlzgsejtvoaz). Safe/idempotent.

alter table public.inspections
  add column if not exists inspector_notes text;

comment on column public.inspections.inspector_notes is
  'Free-text note entered by the rep at signing for the inspector (heads-up info: access, dog, best time, referral source). Shown on the inspector map pin.';
