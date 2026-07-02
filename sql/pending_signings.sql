-- pending_signings — the "sent but not yet signed" state for the Free Roof
-- Inspection remote e-signature flow. A row lives here from the moment the rep
-- taps "Send to homeowner" until the homeowner signs (at which point the real
-- inspections row + JobNimbus deal are created and this row flips to 'signed').
-- Kept OUT of the inspections table on purpose so unsigned links never pollute
-- inspector queues or reports. All reads/writes go through the netlify
-- functions (anon key), same as submit-correction.js — leave RLS closed.

create table if not exists public.pending_signings (
  id uuid primary key default gen_random_uuid(),
  token text unique not null,
  status text not null default 'sent',           -- sent | opened | phone_verified | signed | expired | canceled

  -- rep-entered inspection data (mirrors inspData at form-fill time)
  client_name text not null,
  mobile text not null,
  email text,
  address text, city text, state text, zip text, date text,
  roof_type text default 'Shingle',
  lead_source text,
  spanish_only boolean default false,
  sales_rep_name text, sales_rep_id text, sales_rep_email text,
  obvious_damage boolean default false,
  has_insurance text,
  review_availability text,
  document_version text,

  -- audit: preparation + send
  prepared_by_rep_name text,
  prepared_at timestamptz default now(),
  sent_channels text,
  sent_at timestamptz,
  resend_count int default 0,

  -- audit: link open
  opened_at timestamptz,
  opened_ip text,
  opened_user_agent text,

  -- phone one-time-code (OTP) identity verification
  otp_hash text,
  otp_expires_at timestamptz,
  otp_attempts int default 0,
  otp_last_sent_at timestamptz,
  otp_resend_count int default 0,
  phone_verified_at timestamptz,
  phone_verified_number text,                     -- masked, e.g. (xxx) xxx-1234

  -- ESIGN consent
  consent_text text,
  consent_at timestamptz,

  -- lifecycle / linkage
  expires_at timestamptz not null,
  signed_at timestamptz,
  inspection_id uuid references public.inspections(id),
  created_at timestamptz default now()
);

create index if not exists pending_signings_token_idx on public.pending_signings(token);
create index if not exists pending_signings_status_idx on public.pending_signings(status);
create index if not exists pending_signings_rep_idx on public.pending_signings(sales_rep_id);
