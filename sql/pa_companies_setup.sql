-- ============================================================
-- PA Companies (multi-tenant public-adjuster orgs)
-- ------------------------------------------------------------
-- A PA company has many PAs. Damage deals round-robin per-PA as
-- before, but a company PA's share lands in the COMPANY POOL
-- (inspections.pa_company_id, pa_id null) for that company's admin
-- to assign to one of their active PAs via /?pa_company=<token>.
-- Independent PAs (pa_company_id null) still get deals directly.
-- Run once in the CCG (claims) Supabase project.
-- ============================================================

create table if not exists pa_companies (
  id          uuid primary key default gen_random_uuid(),
  name        text unique not null,
  admin_name  text,
  admin_phone text,
  token       text unique,                 -- personal admin link …/?pa_company=<token>
  active      boolean default true,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Which company a PA belongs to (null = independent / company-of-one).
alter table pas
  add column if not exists pa_company_id uuid references pa_companies(id);

-- The pool a deal is routed into + when it landed (drives the 48h alert).
-- pa_id stays null until the company admin assigns it (independents: pa_id
-- is set directly and pa_company_id stays null).
alter table inspections
  add column if not exists pa_company_id uuid references pa_companies(id),
  add column if not exists pa_company_at timestamptz;
