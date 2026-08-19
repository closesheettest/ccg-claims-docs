-- sql/harvest_revoke.sql
--
-- Somewhere to put a harvest link that has been expired.
--
-- Dropping a trainee's access means clearing sales_reps.harvest_token, because
-- the token IS the credential — every harvest endpoint resolves the rep by it,
-- so clearing it expires access everywhere at once. But a trainee who comes back
-- shouldn't need a brand-new link: their tool-training results are keyed to the
-- old token, so it's parked here instead of destroyed.
alter table sales_reps
  add column if not exists harvest_token_revoked text,
  add column if not exists harvest_revoked_at timestamptz;

-- Verify — expect 0 rows before the first revoke:
--   select name, harvest_revoked_at from sales_reps where harvest_revoked_at is not null;
