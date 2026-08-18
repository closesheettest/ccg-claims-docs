-- ============================================================
-- EMPLOYEE PAYROLL / TIMEKEEPING  (?mode=payroll office tool,
--                                  ?mode=timecard employee app)
-- ------------------------------------------------------------
-- W-2 side of the house only — hourly staff, salaried office,
-- foremen & inspectors. Subcontractor crew pay lives in the
-- separate crew portal and is NOT touched here.
--
-- What it holds
--   payroll_shifts         the named shifts (Day, Night) + their expected times
--   payroll_departments    a team + the employee who signs off its hours
--   payroll_employees      the roster, pay setup, PTO allotment, login passcode
--   payroll_time_entries   ONE row per employee per WORK DATE — their check-in,
--                          their end-of-shift recap, or a day off. A night shift
--                          that runs 6pm→6am belongs to the date it STARTED.
--   payroll_time_off       requests: vacation, sick, doctor, unpaid, comp day
--   payroll_holidays       the paid-holiday calendar everyone can see
--   payroll_week_approvals the Monday-morning manager sign-off, per department
--   payroll_week_submits   employee "my week is done" marker
--   payroll_sessions       employee login sessions (passcode → token)
--
-- RLS stays DISABLED to match the rest of this app (the anon key
-- reads/writes both client-side and in functions). Passcodes are
-- stored SALTED + HASHED, never in the clear, because that anon
-- key is public.
--
-- Safe to re-run: every statement is if-not-exists / on-conflict.
-- ============================================================

create extension if not exists pgcrypto;

-- ── Shifts ───────────────────────────────────────────────────
-- The office defines these once and assigns each employee to one.
-- A shift whose end time is <= its start time crosses midnight
-- (the night shift); everything it produces is filed under the
-- date the shift STARTED, so one night is one row, not two.
create table if not exists public.payroll_shifts (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  start_time     text not null,             -- "07:00" local (ET)
  end_time       text not null,             -- "15:30"; "06:00" on a night shift
  grace_minutes  integer not null default 15,   -- how late before it counts as late
  active         boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now()
);

insert into public.payroll_shifts (name, start_time, end_time, sort_order) values
  ('Day',   '07:00', '15:30', 1),
  ('Night', '18:00', '06:00', 2)
on conflict (name) do nothing;

-- ── Departments ──────────────────────────────────────────────
create table if not exists public.payroll_departments (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null unique,
  manager_employee_id  uuid,                 -- FK wired below (chicken/egg with employees)
  active               boolean not null default true,
  created_at           timestamptz not null default now()
);

-- ── Employees ────────────────────────────────────────────────
create table if not exists public.payroll_employees (
  id                  uuid primary key default gen_random_uuid(),
  first_name          text not null,
  last_name           text not null,
  email               text unique,           -- this is their login
  phone               text,
  department_id       uuid references public.payroll_departments(id) on delete set null,
  title               text,

  pay_type            text not null default 'hourly',   -- hourly | salary
  hourly_rate         numeric(10,2),
  annual_salary       numeric(12,2),
  standard_day_hours  numeric(4,2)  not null default 8,
  standard_week_hours numeric(5,2)  not null default 40,
  hire_date           date,

  pto_days_per_year   numeric(5,2) not null default 0,  -- vacation allotment
  pto_carryover_days  numeric(5,2) not null default 0,  -- rolled in from last year
  sick_days_per_year  numeric(5,2) not null default 0,
  paid_holidays       boolean not null default true,
  shift_id            uuid references public.payroll_shifts(id) on delete set null,

  is_manager          boolean not null default false,   -- signs off their department
  is_admin            boolean not null default false,   -- office/HR: sees everyone
  active              boolean not null default true,

  passcode_hash       text,                  -- sha256(salt + passcode)
  passcode_salt       text,
  passcode_set_at     timestamptz,

  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

do $$ begin
  alter table public.payroll_departments
    add constraint payroll_departments_manager_fk
    foreign key (manager_employee_id) references public.payroll_employees(id) on delete set null;
exception when duplicate_object then null; end $$;

create index if not exists payroll_employees_dept_idx on public.payroll_employees(department_id) where active;
create index if not exists payroll_employees_email_idx on public.payroll_employees(lower(email));

-- ── The timecard: one row per employee per WORK DATE ─────────
-- Built by the two taps an employee makes: they CHECK IN when their
-- shift starts, and at the end they file a RECAP of what they got
-- done, which closes the day out. Hours come from the two stamps.
-- A day can also be off, or both (worked 6 hrs, 2 hrs at the
-- doctor). day_type describes the character of the day; off_type
-- + off_hours carry the partial-day absence.
create table if not exists public.payroll_time_entries (
  id                 uuid primary key default gen_random_uuid(),
  employee_id        uuid not null references public.payroll_employees(id) on delete cascade,
  work_date          date not null,
  day_type           text not null default 'worked',
      -- worked | pto | sick | doctor | holiday | unpaid
      -- | bereavement | jury | no_show | other
  time_in            text,          -- "07:30" (local, ET)
  time_out           text,          -- "16:00"
  lunch_minutes      integer not null default 0,
  hours              numeric(5,2) not null default 0,   -- hours actually WORKED
  off_type           text,          -- partial-day absence on a worked day
  off_hours          numeric(5,2) not null default 0,
  late_minutes       integer not null default 0,        -- arrived late
  left_early_minutes integer not null default 0,         -- left early
  note               text,

  -- the check-in / recap pair
  shift_id           uuid references public.payroll_shifts(id) on delete set null,
  checked_in_at      timestamptz,
  checked_out_at     timestamptz,
  recap              text,            -- what they got done — the manager reads these
  recap_at           timestamptz,
  checkin_nudged_at  timestamptz,     -- set by the cron so it only texts once
  recap_nudged_at    timestamptz,

  source             text not null default 'employee',   -- employee | manager | office | auto
  locked             boolean not null default false,     -- true once the week is signed off
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (employee_id, work_date)
);

create index if not exists payroll_time_entries_date_idx on public.payroll_time_entries(work_date);

-- If an earlier version of this file was already run, bring those tables forward.
alter table public.payroll_employees    add column if not exists shift_id          uuid references public.payroll_shifts(id) on delete set null;
alter table public.payroll_time_entries add column if not exists shift_id          uuid references public.payroll_shifts(id) on delete set null;
alter table public.payroll_time_entries add column if not exists checked_in_at     timestamptz;
alter table public.payroll_time_entries add column if not exists checked_out_at    timestamptz;
alter table public.payroll_time_entries add column if not exists recap             text;
alter table public.payroll_time_entries add column if not exists recap_at          timestamptz;
alter table public.payroll_time_entries add column if not exists checkin_nudged_at timestamptz;
alter table public.payroll_time_entries add column if not exists recap_nudged_at   timestamptz;

-- ── Time-off requests ────────────────────────────────────────
create table if not exists public.payroll_time_off (
  id             uuid primary key default gen_random_uuid(),
  employee_id    uuid not null references public.payroll_employees(id) on delete cascade,
  request_type   text not null default 'pto',   -- pto | sick | doctor | unpaid | bereavement | jury | other
  start_date     date not null,
  end_date       date not null,
  partial        boolean not null default false,
  hours_per_day  numeric(5,2),                  -- only when partial
  total_days     numeric(6,2) not null default 0,
  total_hours    numeric(7,2) not null default 0,
  note           text,
  status         text not null default 'pending', -- pending | approved | denied | cancelled
  decided_by     uuid references public.payroll_employees(id) on delete set null,
  decided_by_name text,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz not null default now()
);

create index if not exists payroll_time_off_emp_idx on public.payroll_time_off(employee_id, start_date desc);
create index if not exists payroll_time_off_status_idx on public.payroll_time_off(status) where status = 'pending';

-- ── Paid-holiday calendar ────────────────────────────────────
create table if not exists public.payroll_holidays (
  id           uuid primary key default gen_random_uuid(),
  holiday_date date not null unique,
  name         text not null,
  paid         boolean not null default true,
  hours        numeric(4,2) not null default 8,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- The holidays U.S. Shingle observes, 2026–2027. Weekend holidays are
-- listed on the OBSERVED weekday. Edit/add any of these in the office tool.
insert into public.payroll_holidays (holiday_date, name) values
  ('2026-01-01','New Year''s Day'),
  ('2026-05-25','Memorial Day'),
  ('2026-07-03','Independence Day (observed)'),
  ('2026-09-07','Labor Day'),
  ('2026-11-26','Thanksgiving Day'),
  ('2026-11-27','Day after Thanksgiving'),
  ('2026-12-25','Christmas Day'),
  ('2027-01-01','New Year''s Day'),
  ('2027-05-31','Memorial Day'),
  ('2027-07-05','Independence Day (observed)'),
  ('2027-09-06','Labor Day'),
  ('2027-11-25','Thanksgiving Day'),
  ('2027-11-26','Day after Thanksgiving'),
  ('2027-12-24','Christmas Day (observed)')
on conflict (holiday_date) do nothing;

-- ── Monday-morning department sign-off ───────────────────────
create table if not exists public.payroll_week_approvals (
  id               uuid primary key default gen_random_uuid(),
  department_id    uuid not null references public.payroll_departments(id) on delete cascade,
  week_start       date not null,            -- the MONDAY of the week being signed off
  status           text not null default 'open',   -- open | approved
  approved_by      uuid references public.payroll_employees(id) on delete set null,
  approved_by_name text,
  approved_at      timestamptz,
  note             text,
  totals           jsonb not null default '{}'::jsonb,  -- snapshot at sign-off
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (department_id, week_start)
);

-- ── "My week is done" marker from the employee ───────────────
create table if not exists public.payroll_week_submits (
  employee_id  uuid not null references public.payroll_employees(id) on delete cascade,
  week_start   date not null,
  submitted_at timestamptz not null default now(),
  primary key (employee_id, week_start)
);

-- ── Login sessions (passcode → bearer token) ─────────────────
create table if not exists public.payroll_sessions (
  token       text primary key,
  employee_id uuid not null references public.payroll_employees(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  user_agent  text
);

create index if not exists payroll_sessions_emp_idx on public.payroll_sessions(employee_id);

-- ── Same posture as the rest of the app ──────────────────────
alter table public.payroll_shifts         disable row level security;
alter table public.payroll_departments    disable row level security;
alter table public.payroll_employees      disable row level security;
alter table public.payroll_time_entries   disable row level security;
alter table public.payroll_time_off       disable row level security;
alter table public.payroll_holidays       disable row level security;
alter table public.payroll_week_approvals disable row level security;
alter table public.payroll_week_submits   disable row level security;
alter table public.payroll_sessions       disable row level security;

-- ── Defaults the tools read from app_settings ────────────────
insert into public.app_settings (key, value) values
  ('payroll_config', '{"standard_day_hours":8,"standard_week_hours":40,"ot_after_hours":40,"signoff_deadline_hour":11,"checkin_nudge_after_minutes":20,"recap_nudge_after_minutes":15}')
on conflict (key) do nothing;
