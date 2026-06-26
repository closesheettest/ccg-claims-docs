-- Install Finder data, now in CCG Supabase (always-on). Populated nightly from
-- JobNimbus by cron-sync-installs (upsert on jnid), read by the Install Finder
-- map. jnid is a nullable UNIQUE key so hand-imports (no jnid) still work.
-- Run this in the CCG Supabase project (the one you know).
CREATE TABLE IF NOT EXISTS installs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  jnid          text UNIQUE,
  address_line  text,
  city          text,
  product_type  text,
  color         text,
  latitude      double precision,
  longitude     double precision,
  updated_at    timestamptz DEFAULT now()
);
