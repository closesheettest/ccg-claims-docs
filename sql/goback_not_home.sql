-- Go-back "not home": when a rep arrives at a scheduled review visit and nobody's
-- home, we re-date the go-back to the homeowner's next preferred day and bump an
-- attempt counter (so a never-home door eventually flags itself). Additive + safe.

alter table inspections add column if not exists goback_not_home_count  int default 0;
alter table inspections add column if not exists goback_last_attempt_at  timestamptz;
