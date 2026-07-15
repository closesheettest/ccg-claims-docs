-- Harvesting Map — configurable PIN TYPES (Phase 1 foundation).
-- Replaces the hardcoded status list with an admin-editable config, so the
-- office can create new pin types, set their color, decide WHICH REP LEVELS can
-- see them, and define each one's allowed OUTCOMES (the "behavior flow"). Every
-- other feature (secure per-level pin loading, appt-from-pin, Start Day,
-- reports) reads this config.
create table if not exists harvest_pin_types (
  key            text primary key,              -- machine key stored on the pin, e.g. 'iq'
  label          text not null,                 -- what reps/admins see, e.g. 'IQ'
  color          text not null default '#2563eb',
  sort           int  not null default 0,
  visible_levels text[] not null default '{}',  -- rep levels allowed to SEE these pins ('senior','junior',…); empty = everyone
  outcomes       text[] not null default '{}',  -- pin-type keys a rep may switch this pin TO (allowed transitions)
  is_terminal    boolean not null default false,-- true = a finished outcome (appt, insp_sold)
  active         boolean not null default true,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);

-- Seed with the flow described: Sr harvest IQ → (Not Interested | Appt); the
-- Not-Interested ones become IQ-NI which Jr reps work alongside Insp pins →
-- (Insp Sold | dead). Admin can edit all of this later.
insert into harvest_pin_types (key, label, color, sort, visible_levels, outcomes, is_terminal) values
  ('iq',         'IQ',                '#2563eb', 10, '{senior}',          '{iq_ni,appt}',        false),
  ('appt',       'Appointment',       '#16a34a', 20, '{senior,junior}',  '{}',                  true),
  ('iq_ni',      'IQ – Not Interested','#f59e0b',30, '{junior}',          '{insp_sold,dead}',    false),
  ('insp',       'Inspection Lead',   '#0ea5e9', 40, '{junior}',          '{insp_sold,dead}',    false),
  ('insp_sold',  'Inspection Sold',   '#7c3aed', 50, '{senior,junior}',  '{}',                  true),
  ('dead',       'Dead / DNK',        '#111827', 60, '{senior,junior}',  '{}',                  true)
on conflict (key) do nothing;

alter table harvest_pin_types enable row level security;
drop policy if exists harvest_pin_types_all on harvest_pin_types;
create policy harvest_pin_types_all on harvest_pin_types for all using (true) with check (true);
grant all on harvest_pin_types to anon, authenticated;
