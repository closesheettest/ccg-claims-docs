-- Keep ALL columns from an uploaded CSV on the pin (any column beyond the
-- standard address/city/state/zip/name/type lands here), so clicking a pin can
-- show everything the office loaded — phone, email, homeowner names, etc.
alter table canvass_prospects add column if not exists extra jsonb;
