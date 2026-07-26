-- "Come back [day]" callbacks: a rep sets a definitive return day on a door
-- (homeowner committed to a time). We store the date in a real column so the map
-- — which loads pins "lite" without the big extra jsonb — can hold the door out
-- of the route until that day, then pull it in as a MANDATORY, definitive-appt
-- stop (ranked above the softer review go-backs). Additive + safe.

alter table canvass_prospects add column if not exists callback_date date;

-- Backfill from any existing extra.callback.date so current come-backs work too.
update canvass_prospects
   set callback_date = (extra->'callback'->>'date')::date
 where callback_date is null
   and extra ? 'callback'
   and (extra->'callback'->>'date') ~ '^\d{4}-\d{2}-\d{2}$';
