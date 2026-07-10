-- ============================================================================
-- Roofing crew (subcontractor) onboarding — schema + private storage
-- Run once in the CCG Supabase SQL editor.
--
-- Holds SENSITIVE data (W-9 SSN/EIN, bank account #). These tables are locked
-- with RLS and NO anon policies, so the public anon key cannot read them. All
-- access is server-side via the service-role key. One-time setup: add
-- SUPABASE_SERVICE_ROLE_KEY to Netlify env (Supabase → Project settings → API →
-- service_role secret). The crew functions use it; nothing else does.
-- ============================================================================

create extension if not exists pgcrypto;

-- ── crews ───────────────────────────────────────────────────────────────────
create table if not exists crews (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- invited → in_progress → submitted → approved (countersigned) | rejected
  status text not null default 'invited',
  token text unique not null,                 -- onboarding link token

  -- ① Office-filled (US Shingle) --------------------------------------------
  owner_first text,
  owner_last  text,
  owner_phone text,
  owner_email text,
  company_name text,
  -- Rates are DICTATED BY US SHINGLE on the intake (crew never edits them).
  -- Pre-loaded with these packet defaults; office can change per crew. Tile
  -- is intentionally blank (priced by experience).
  rates jsonb not null default '{
    "shingle": 110, "screw_down_metal": 180, "standing_seam_metal": 220,
    "permalock_aluminum_shingle": 180, "decra_stone_coated": 250, "tile": null,
    "tpo": 120, "base_and_cap": 110, "plywood_replacement": 15, "1xs": 1.50,
    "extra_story": 10, "extra_layer_shingles": 10, "additional_story": 10,
    "steep_7_12": 10, "trip_charge": 25
  }'::jsonb,

  -- ② Crew-filled contacts + work details -----------------------------------
  install_contact_name  text,
  install_contact_email text,
  install_contact_phone text,
  crew_lead_name  text,
  crew_lead_email text,
  crew_lead_phone text,
  preferred_area  text,
  crew_size       int,
  dump_trailers   int,
  roofing_types   text,

  -- ② Banking & business ----------------------------------------------------
  bank_name        text,
  bank_routing     text,
  bank_account     text,
  account_name     text,
  company_ein      text,
  account_address  text,
  additional_info  text,
  license_number   text,

  -- ② W-9 (filled in-app) ---------------------------------------------------
  w9_name               text,   -- name (as on income tax return)
  w9_business_name      text,   -- business/disregarded entity name, if different
  w9_tax_classification text,   -- individual | c_corp | s_corp | partnership | trust_estate | llc | other
  w9_llc_class          text,   -- C | S | P  (when classification = llc)
  w9_exempt_payee_code  text,
  w9_fatca_code         text,
  w9_address            text,
  w9_city_state_zip     text,
  w9_tin_type           text,   -- 'ssn' | 'ein'
  w9_tin                text,   -- SSN or EIN (sensitive)

  -- Signing / audit ---------------------------------------------------------
  submitted_at             timestamptz,
  subcontractor_signed_at  timestamptz,
  subcontractor_sign_name  text,
  subcontractor_sign_title text,
  subcontractor_sign_ip    text,
  agreement_pdf_path       text,   -- signed Subcontractor Agreement + onboarding (crew-docs bucket)
  w9_pdf_path              text,   -- generated W-9

  -- US Shingle countersignature (approval) ----------------------------------
  us_shingle_signed_at   timestamptz,
  us_shingle_sign_name   text,
  us_shingle_sign_title  text,
  approved_at            timestamptz
);

create index if not exists crews_status_idx on crews (status, created_at desc);

-- ── crew_documents (the uploads) ────────────────────────────────────────────
create table if not exists crew_documents (
  id uuid primary key default gen_random_uuid(),
  crew_id uuid not null references crews(id) on delete cascade,
  -- general_liability | workers_comp | roofing_license | exemption_cert | other
  doc_type text not null,
  file_path text not null,        -- path inside the private crew-docs bucket
  file_name text,
  content_type text,
  uploaded_at timestamptz not null default now()
);

create index if not exists crew_documents_crew_idx on crew_documents (crew_id, doc_type);

-- ── Lock it down: RLS on, NO anon policies (server-only via service role) ────
alter table crews          enable row level security;
alter table crew_documents enable row level security;
-- (Deliberately no policies for the anon/public role — the public anon key
--  cannot read or write these. Server functions use the service-role key,
--  which bypasses RLS. This keeps SSN/EIN/bank numbers off the client.)

-- Drawn signature images (data URLs) so the Agreement can be regenerated with
-- BOTH the subcontractor's and US Shingle's signatures at countersign time.
alter table crews add column if not exists subcontractor_signature text;
alter table crews add column if not exists us_shingle_signature text;

-- ── Private storage bucket for the uploaded certificates + generated PDFs ────
insert into storage.buckets (id, name, public)
values ('crew-docs', 'crew-docs', false)
on conflict (id) do nothing;
