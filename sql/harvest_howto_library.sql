-- DoorDispatcher HOW-TO LIBRARY — office-editable reference of EVERY rep tool: what it is,
-- WHEN to use it, HOW to use it, and a link to that spot in the one instructional video.
-- Reps open it from the ❓ button on their map; the office edits it at ?mode=harvesthowtoadmin.
-- Run once in the CCG Supabase SQL editor. Safe to re-run.

create table if not exists public.harvest_howto_tools (
  id          uuid primary key default gen_random_uuid(),
  role        text not null default 'all',   -- 'all' | 'sr' | 'jr' (who sees it)
  sort        int  not null default 0,
  icon        text not null default '🛠️',
  title       text not null default '',       -- the tool name
  when_text   text not null default '',       -- WHEN to use it
  how_text    text not null default '',       -- HOW to use it (short steps)
  video_start int,                            -- seconds into the video (null = no clip yet)
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);
create index if not exists hht_role_sort on public.harvest_howto_tools (role, sort);

-- One shared instructional video (screen recording w/ mouse). Timestamps above index into it.
create table if not exists public.harvest_howto_config (
  id         text primary key default 'main',
  video_url  text,
  updated_at timestamptz not null default now()
);
insert into public.harvest_howto_config (id) values ('main') on conflict (id) do nothing;

-- Permissive RLS (anon-key app, same posture as the other harvest tables).
alter table public.harvest_howto_tools  enable row level security;
alter table public.harvest_howto_config enable row level security;
drop policy if exists hht_all on public.harvest_howto_tools;
create policy hht_all on public.harvest_howto_tools  for all to anon, authenticated using (true) with check (true);
drop policy if exists hhc_all on public.harvest_howto_config;
create policy hhc_all on public.harvest_howto_config for all to anon, authenticated using (true) with check (true);

-- ── Starter set — every rep tool. Only seeds when the table is empty, so office edits
--    are never clobbered. video_start left null — set each once the video is recorded. ──
insert into public.harvest_howto_tools (role, sort, icon, title, when_text, how_text)
select * from (values
  ('all', 10, '🗺️', 'Reading your map & pins',
    'Every time you open the map — before you start your day.',
    'Each dot is a door; its color is the type. The legend on the right lists every type with a count. Gold stars are roofs we already installed (reference only). Tap a pin to see the homeowner, what''s happened there, and exactly which lead type it is — the card tells you.'),
  -- The ONE real difference between a Junior and a Senior: the leads (pins) they work.
  ('jr', 15, '🚪', 'Your leads — Inspection Leads & IQ Not Interested',
    'This is your map. As a Junior rep you work two pin types.',
    '🖊️ Inspection Lead — a door that needs a free roof inspection; you knock and get the homeowner signed up for one.\n↩️ IQ – Not Interested — homeowners who got an Instant Quote online but said no; you go win them back in person.\nYour map is locked to these two, and each pin''s card tells you exactly which one it is.'),
  ('sr', 15, '🏅', 'Your leads — Instant Quote, No-Sits (+ Inspection Needed)',
    'This is your map. As a Senior rep you work two main pin types — plus inspections when your area is thin.',
    '💬 Instant Quote leads — homeowners who asked for a price online; warm, ready to talk.\n🔄 No-Sit / Need-to-Reschedule — appointments that didn''t sit; you re-book them, even same-day.\n🖊️ Inspection Needed — if your area is light on the two above, you can also work doors that need a free roof inspection.\nTap any pin and its card tells you exactly which lead type it is.'),
  ('all', 20, '▢', 'Route an area',
    'When you want to work one specific neighborhood right now.',
    'Tap ▢ Route an area, drag a box around the doors you want. It routes exactly those in the tightest order — works even zoomed way out.'),
  ('all', 30, '▶', 'Start my day (required stops)',
    'When you have go-backs or come-backs due — they become required stops.',
    'Tap ▶ Start my day. It builds one tight loop with your required stops (oldest first) and fills fresh doors around them. On a day with go-backs you won''t see Route-an-area — that''s on purpose.'),
  ('all', 40, '📅', 'Plan your day (around appointments)',
    'When you have one or more appointments today.',
    'Tap ▶ Start my day (it opens Plan-your-day) and enter your start time. It drops each appointment in at its time and fills the gaps with doors, keeping you close so you''re never late — to 8 PM. Any go-backs due today are pulled in as required stops, so appointments, go-backs, and fresh doors are one route. Tap ✅ Appointment done to re-plan the rest off the real clock.'),
  ('all', 45, '🧭', 'When your manager plans your day',
    'Some mornings your manager has already carved out your section.',
    'You''ll see a purple "Your day is planned by your manager" banner. Tap ▶ Start my day and it routes your assigned doors. Got an appointment too? It tells you to Plan your day so the two never collide.'),
  ('all', 50, '✅', 'Status a door (How''d it go?)',
    'At every door, once you''re actually there (GPS confirms it).',
    'Tap what happened — Not interested, booked an appointment, signed, and so on. It logs it and moves you to the next stop. Never log a door you''re not standing at.'),
  ('all', 60, '🏠', 'Not home',
    'When nobody answers the door.',
    'Tap 🏠 Not home. It logs the knock without changing the door''s status, so the door stays workable and shows in the visit history. If they come out later, re-open the pin and re-status it.'),
  ('all', 70, '🖊️', 'Sign an inspection',
    'When the homeowner says yes to a free roof inspection.',
    'Tap 🖊️ Sign Inspection. The claim form opens pre-filled with their address — confirm the details and submit. The door turns Sold, it''s in JobNimbus credited to you, no paperwork tonight.'),
  ('all', 80, '🍀', 'Clover Leaf',
    'The moment our crew starts a roof — the easiest doors on the map.',
    'Green clover pins drop on the neighbors around the pulsing 🚧 install marker. Tap one — the homeowner we''re installing is on your card, so pitch it by name. Route the cluster and it LOCKS to you (until you go inactive ~30 min).'),
  ('all', 90, '⏳', 'Go-backs & come-backs',
    'After an inspection (Retail / Damage / No-Damage) when the homeowner wants you to come back.',
    'A go-back is an inspection go-back — a roof that came back Retail, Damage, or No-Damage and the homeowner gave you the best time to return.\n\nHow to set one: at the door, open the pin and tap ⏳ Pending (come back). Pick the day (defaults about a week out) and a time — only your open times show, so you never double-book. Add a note, then Schedule come-back.\n\nA go-back is NOT a locked appointment — it''s their best time. Set a time and the map routes you to be in that area around then; leave it blank and it weaves into your day. On that day it''s a required stop on Start my day — you never keep a list.\n\nAn appointment is different: a firm set time, like a back-to-retail "come back tomorrow at noon." Appointments always come first; go-backs route around them.'),
  ('all', 100, '⭐', 'Referral',
    'When a happy homeowner sends you to a neighbor / friend.',
    'Tap ⭐ Referral, enter name, phone, address and who sent you. It drops a gold pin (overrides any pin there) and lands in your Calls-to-make bar. Call them; if no answer reschedule the call; when they''re ready, book or sign.'),
  ('all', 110, '📍', 'Drop your own pin (self-gen)',
    'When you spot a damaged roof that isn''t on the map.',
    'Tap the 🏠 Add-a-house button, then tap the house. The map checks county records for owner-occupied, then lets you Sign, set Retail, or mark Pending. It goes into JobNimbus as Self-Generated so you get the credit.'),
  ('all', 120, '🔁', 'Rounds — 3 routes a day',
    'Every day — after you finish a route.',
    'When you finish a route, DoorDispatcher rebuilds the not-homes and come-backs into a brand-new, shorter route — automatically. Work that, and it builds a third. Three routes a day, no redraw. The top earners run all three.'),
  ('sr', 130, '🔄', 'Reschedule a no-sit',
    'When a no-sit homeowner is ready to re-book — even same-day.',
    'Open the no-sit pin and tap Schedule appointment. Same-day slots are open on no-sits only (they''re warm and you''re there). It resets the appointment in JobNimbus under your name.'),
  ('all', 140, '📲', 'Sign over the phone (remote e-sign)',
    'On a call when the homeowner is ready but you''re not at the door.',
    'Choose Sign now — it texts them the agreement plus a code; they open it, enter the code, and sign on their own phone. If our texts aren''t reaching them, use Copy Link and send it from your phone.')
) as v(role, sort, icon, title, when_text, how_text)
where not exists (select 1 from public.harvest_howto_tools);
