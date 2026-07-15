-- Phase 1b — secure rep sign-in for the Harvesting Map.
-- Each rep gets a personal token; their link is /?mode=harvest&rt=<token>. The
-- harvest-pins function resolves the token → rep → level (senior/junior, from
-- the TMS rep-zones feed) and returns ONLY the pins that level is allowed to see.
alter table sales_reps add column if not exists harvest_token uuid default gen_random_uuid();
update sales_reps set harvest_token = gen_random_uuid() where harvest_token is null;

-- Office "view-all" token for the map (the admin's own link shows every pin).
insert into app_settings (key, value)
  values ('harvest_admin_token', gen_random_uuid()::text)
  on conflict (key) do nothing;
