-- Visit-flow redesign: rep gate → Damage / No-Damage / Retail visit tools.
-- Run in the CCG Supabase SQL editor (NOT via deploy).

-- Retail re-visit appointments (source of truth is the JN Appointment task;
-- this is for idempotency + a future "retail appts" report).
create table if not exists retail_appointments (
  id           uuid primary key default gen_random_uuid(),
  inspection_id uuid references inspections(id),
  jn_job_id    text,
  jn_task_id   text,
  start_at     timestamptz not null,
  end_at       timestamptz,
  booked_by    text,
  created_at   timestamptz default now()
);
create index if not exists retail_appointments_insp on retail_appointments (inspection_id);
grant select, insert, update on retail_appointments to anon;

-- Referrals captured on a No-Damage visit.
create table if not exists referrals (
  id              uuid primary key default gen_random_uuid(),
  inspection_id   uuid references inspections(id),
  referred_by_name text,           -- the homeowner giving the referral
  referral_name   text,
  referral_phone  text,
  captured_by_rep text,
  created_at      timestamptz default now()
);
grant select, insert on referrals to anon;

-- Settings: a light token gate for the public visit hub + the Google review link
-- the No-Damage send includes. Change the review URL to the real one.
insert into app_settings (key, value) values ('visit_token', 'roofvisit2026')
  on conflict (key) do nothing;
insert into app_settings (key, value) values ('google_review_url', 'https://g.page/r/REPLACE_ME/review')
  on conflict (key) do nothing;
