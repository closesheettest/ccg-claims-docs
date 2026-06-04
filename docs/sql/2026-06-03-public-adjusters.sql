-- Public Adjuster (PA) portal — schema.
--
-- Mirrors the inspector model: a PA is a JobNimbus user we sync into our
-- own `pas` table. The manager activates them, which texts/emails a
-- private link to ?mode=pa. In the portal a PA sees the pool of DAMAGE
-- deals, claims the ones they want, and fills in the 11 "Insurance"
-- section milestone fields as they happen — each save pushes straight
-- to the JobNimbus job (via the pa-save-field function).
--
-- Unlike inspectors, PAs need NO home base / geocoding (there's no
-- distance routing — every PA sees every unclaimed damage deal), so the
-- `pas` table is the inspector table minus the lat/lng/mileage bits.
--
-- Claiming lives on the existing `inspections` row (the damage records
-- already live there with client_name, address, jn_job_id, photos):
--   pa_id         uuid  -- null = unclaimed (in the pool); set = owned by a PA
--   pa_claimed_at timestamptz
--   pa_fields     jsonb -- local cache of the 11 field values we last pushed to JN
--
-- Safe to re-run (idempotent).

-- ─────────────────────────────────────────────────────────────────────
-- 1. The PA roster.
-- ─────────────────────────────────────────────────────────────────────
create table if not exists pas (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  jn_user_id text unique,                 -- JobNimbus user id; sync upsert key
  email text,
  phone text,
  active boolean not null default false,  -- manager flips this; gates the portal
  registration_token uuid not null default gen_random_uuid(),
  info_updated_at timestamptz,            -- set when the PA confirms via setup link (optional for PAs)
  app_link_sent_at timestamptz,           -- last time we texted/emailed the ?mode=pa link
  notes text,
  created_at timestamptz not null default now()
);

-- RLS: open, same posture as inspectors/regional_managers. The private
-- ?mode=pa link is the only "auth"; the anon key is already public and
-- the server-side functions (sync, save-field) hold the JN key.
alter table pas enable row level security;
drop policy if exists "pas_public_select" on pas;
create policy "pas_public_select" on pas for select using (true);
drop policy if exists "pas_public_insert" on pas;
create policy "pas_public_insert" on pas for insert with check (true);
drop policy if exists "pas_public_update" on pas;
create policy "pas_public_update" on pas for update using (true) with check (true);
drop policy if exists "pas_public_delete" on pas;
create policy "pas_public_delete" on pas for delete using (true);

-- ─────────────────────────────────────────────────────────────────────
-- 2. Claim columns on the existing inspections table.
-- ─────────────────────────────────────────────────────────────────────
alter table inspections add column if not exists pa_id uuid references pas(id) on delete set null;
alter table inspections add column if not exists pa_claimed_at timestamptz;
alter table inspections add column if not exists pa_fields jsonb;

-- Index so the "claimable damage pool" query (result='damage' and pa_id
-- is null) and a PA's "my claims" query (pa_id = me) stay fast.
create index if not exists inspections_pa_id_idx on inspections (pa_id);
create index if not exists inspections_pa_pool_idx on inspections (result, pa_id);

-- ─────────────────────────────────────────────────────────────────────
-- 3. Show the PA portal base URL (Neal can confirm after seeding PAs).
-- ─────────────────────────────────────────────────────────────────────
select 'https://free-roof-inspections.netlify.app/?mode=pa' as pa_portal_url;
