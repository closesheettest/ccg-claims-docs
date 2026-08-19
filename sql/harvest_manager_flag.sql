-- sql/harvest_manager_flag.sql
--
-- Mark the regional managers on the map.
--
-- Correcting a mis-statused door is a MANAGER'S job — a rep rewriting their own
-- doors off-route would undo the at-the-door gate that keeps couch-canvassing
-- out of the numbers. Until now the map could only tell "office/admin link" from
-- "rep", so Sam, Richard, Chad and Anthony — who use ordinary rep links in the
-- field — had no way to fix a bad status without the admin link (Neal, 2026-08-19).
--
-- A flag rather than harvest_level='admin' on purpose: admin also unlocks every
-- pin in every zone, and a regional manager should keep their own zone's view.
alter table sales_reps
  add column if not exists harvest_manager boolean not null default false;

update sales_reps
   set harvest_manager = true
 where name in ('Samuel Bissu', 'Richard Barnett', 'Chad Griffith', 'Anthony Alongi');

-- Verify — expect the four regional managers:
--   select name, harvest_manager from sales_reps where harvest_manager order by name;
