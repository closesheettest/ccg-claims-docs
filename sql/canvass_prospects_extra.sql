-- Fields captured from an uploaded CSV via the column-mapping step. phone/email
-- are first-class (used to prefill the appointment + push to JobNimbus); every
-- other column the office maps or leaves lands in `extra` (shown on the pin), so
-- nothing from the file is lost.
alter table canvass_prospects add column if not exists phone text;
alter table canvass_prospects add column if not exists email text;
alter table canvass_prospects add column if not exists extra jsonb;
