-- Editable list of "send back to retail" reasons a PA picks from when they
-- move a deal out of insurance. Seeded with the four defaults; PAs (and the
-- company) can add more right from the app. RLS left disabled to match the
-- other app tables (inspections, etc.) — the anon key reaches it via the
-- pa-retail-reasons function.
create table if not exists pa_retail_reasons (
  id         bigserial primary key,
  label      text not null unique,
  sort       integer not null default 100,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

insert into pa_retail_reasons (label, sort) values
  ('Don''t have insurance',                 10),
  ('Not enough damage',                     20),
  ('Already working with someone',          30),
  ('Doesn''t want to go through insurance', 40)
on conflict (label) do nothing;
