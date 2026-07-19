-- Harvesting Map — mark a rep's LAST ping as "ended" when they close the map, so the
-- live team views (office + regional-manager) can drop them from "live" immediately
-- instead of waiting out the 15-min idle grace window.
--
-- The map fires a sendBeacon with { ended: true } on pagehide (tab/app close). The
-- team endpoints treat a rep whose newest ping is `ended` as NOT live.
--
-- Run once in the Supabase SQL editor. Safe to re-run.

alter table public.harvest_rep_pings add column if not exists ended boolean not null default false;
