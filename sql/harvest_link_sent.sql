-- When the office last sent this rep their personal Harvesting-Map link (by SMS
-- + email, via harvest-send-link). Drives the "✓ Sent <date>" flag on the Rep
-- Links page so the office can see at a glance who's already had theirs.
alter table sales_reps add column if not exists harvest_link_sent_at timestamptz;
