-- Clover Leaf route-lock: when a rep routes a clover grid, those doors are
-- soft-locked to them while their route is ACTIVE (a heartbeat refreshes the
-- timestamp). Another rep can't route a door claimed in the last 30 minutes;
-- once the heartbeat stops (route no longer active) or the day rolls over, the
-- claim goes stale and the door is back in play. Three cheap scalar columns so
-- the map can load them "lite" (the big `extra` jsonb is intentionally not
-- loaded for pins). Nothing here is destructive — safe to run repeatedly.

alter table canvass_prospects add column if not exists route_claim_by     text;
alter table canvass_prospects add column if not exists route_claim_by_jn  text;
alter table canvass_prospects add column if not exists route_claim_at      timestamptz;

-- Fast "who's locked right now" scans over the freshly-claimed doors only.
create index if not exists idx_canvass_route_claim_at
  on canvass_prospects (route_claim_at)
  where route_claim_at is not null;
