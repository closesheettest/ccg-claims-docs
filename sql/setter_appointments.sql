-- Setter-booked appointments log. Every booking from the Appointment-Setter
-- Portal is recorded here (independent of JobNimbus) so the setter has a
-- reference list of what they booked today — even if the JN write fails.
create table if not exists public.setter_appointments (
  id uuid primary key default gen_random_uuid(),
  setter_name      text not null,
  homeowner_name   text,
  phone            text,
  address          text,
  appt_at          timestamptz not null,   -- the scheduled appointment time
  source           text,                   -- Instant Quote / Facebook
  rep_name         text,
  rep_jobnimbus_id text,
  jn_contact_id    text,
  jn_job_id        text,
  jn_task_id       text,
  out_of_range     boolean default false,  -- no rep in range → owned by setter
  jn_synced        boolean default true,   -- did the JobNimbus write succeed?
  booked_at        timestamptz not null default now()
);

alter table public.setter_appointments enable row level security;

-- Same open posture as the other portal tables (anon key, link-gated app).
drop policy if exists setter_appts_anon_read on public.setter_appointments;
create policy setter_appts_anon_read on public.setter_appointments
  for select to anon using (true);
drop policy if exists setter_appts_anon_insert on public.setter_appointments;
create policy setter_appts_anon_insert on public.setter_appointments
  for insert to anon with check (true);

create index if not exists setter_appts_booked_at_idx on public.setter_appointments (booked_at desc);
