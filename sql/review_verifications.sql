-- review_verifications — the manual Google-review verification queue for the contest.
--
-- Flow: a rep taps 🌟 Review on the map, enters the homeowner's name + cell → we
-- text the review link AND drop a PENDING row here. That pending review shows a
-- PROVISIONAL contest point the same day it was sent. The rep's regional manager
-- checks Google and taps "✓ Review is there" (approve) or "✗ Not there" (reject).
--   • approved same-day  → the point becomes PERMANENT for that contest day.
--   • rejected           → the pending point disappears immediately.
--   • never actioned     → the pending point only ever counted because it was sent
--                          TODAY, so it falls off on its own when the day rolls over
--                          (the leaderboard recomputes live — no cleanup job needed).
--
-- Rep→zone is resolved at read time (rep_name → TMS rep-zones), same as the contest
-- roster, so we don't store a zone here.

create table if not exists public.review_verifications (
  id               uuid primary key default gen_random_uuid(),
  rep_name         text,
  rep_token        text,
  homeowner_name   text,
  homeowner_phone  text,
  status           text not null default 'pending',  -- pending | approved | rejected
  sent_at          timestamptz not null default now(),
  verified_by      text,
  verified_at      timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists review_verifications_sent_at_idx on public.review_verifications (sent_at desc);
create index if not exists review_verifications_status_idx  on public.review_verifications (status);

-- Same access posture as canvass_activity (the map writes with the public anon key,
-- the zone-scoped backend functions read/update with it).
grant select, insert, update on public.review_verifications to anon, authenticated;
alter table public.review_verifications enable row level security;
drop policy if exists rv_all on public.review_verifications;
create policy rv_all on public.review_verifications for all to anon, authenticated using (true) with check (true);
