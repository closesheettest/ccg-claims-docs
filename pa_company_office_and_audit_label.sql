-- 1) PA company office: address + email + geocoded coords, so the company
--    admin can sort homeowners by distance from "🏢 My office".
alter table pa_companies add column if not exists address text;
alter table pa_companies add column if not exists email text;
alter table pa_companies add column if not exists latitude double precision;
alter table pa_companies add column if not exists longitude double precision;

-- 2) Make the noon "deals that need fixing" SMS recognizable in
--    Settings → Auto SMS (it's the auto_sms 'sales_audit' row). Rename +
--    describe it so it reads clearly as a subscription people can opt into.
update auto_sms set
  name = 'Deals that need fixing (noon SMS)',
  description = 'Every day at noon ET, scans yesterday''s JobNimbus sales and texts what''s missing or wrong. Detail goes to each zone''s regional manager; a summary goes to admin + anyone added below. Add your phone to get the daily summary; remove it to unsubscribe.',
  schedule_label = 'Daily · 12:00 PM ET',
  audience_note = 'Regional managers (detail) + admin/subscribers (summary)'
where key = 'sales_audit';
