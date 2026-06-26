-- Install Finder dedup: add a jnid so the nightly JobNimbus sync
-- (cron-sync-installs) can tell which rows already came from JN.
-- ⚠️ Run this in the INSTALL FINDER Supabase project (qkhljgegxcburqldposx),
--    NOT the CCG one.
ALTER TABLE installs ADD COLUMN IF NOT EXISTS jnid text;
CREATE INDEX IF NOT EXISTS installs_jnid_idx ON installs (jnid);
