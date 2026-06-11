-- Max travel distance per PA (company admin sets it; the company screen then
-- filters the pool to deals within that radius of the PA's home when their
-- name is tapped under "Distance from").
alter table pas add column if not exists max_distance_miles integer;
