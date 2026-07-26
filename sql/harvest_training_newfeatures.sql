-- Harvest Tool Training — NEW-FEATURE lessons + questions (DoorDispatcher update).
-- Adds sections/questions for everything shipped since the first content pass:
--   Clover Leaf route-lock + install name, Referral call-queue, remote e-sign,
--   go-backs never-same-day / not-home, callbacks as mandatory "definitive" stops,
--   and the manager-side Assign-Appointments queue for missed go-backs.
-- Idempotent: each block only inserts if that exact title/prompt is missing, so the
-- office's edits and uploaded screenshots are never clobbered. Run AFTER
-- sql/harvest_training.sql (and its content file) in the CCG Supabase SQL editor.

-- ════════════════════════════════════════════════════════════════════════════
--  REP track
-- ════════════════════════════════════════════════════════════════════════════

-- ── Clover Leaf ─────────────────────────────────────────────────────────────
insert into public.harvest_training_sections (track, sort, title, body)
select 'rep', 85, '🍀 Clover Leaf — the easiest doors on the map',
  $q$The second our crew starts a roof, DoorDispatcher drops green clover pins on the neighbors right around that pulsing 🚧 install marker — the house we're roofing RIGHT NOW. These are the easiest yeses you'll knock all day. Tap a clover pin and the homeowner we're installing shows right on your card, so you walk up and say it BY NAME: "We're putting a new roof on the Anderson's place today — want us to look at yours?" Then just status the door: roof looks fine, damage, book it, not interested, or sign it on the spot. Here's your edge: the moment you ROUTE a clover cluster, it LOCKS to you — no other rep can route it or even see it while you're working it. But it's tied to effort: go inactive in that cluster for about 30 minutes and it unlocks for someone else to grab. Get to a cluster first, and keep moving.$q$
where not exists (select 1 from public.harvest_training_sections where track='rep' and title='🍀 Clover Leaf — the easiest doors on the map');

-- ── Referral ────────────────────────────────────────────────────────────────
insert into public.harvest_training_sections (track, sort, title, body)
select 'rep', 92, '⭐ Referrals — your own lead, on your leaderboard',
  $q$Got a referral in the field? Tap the ⭐ Referral button and fill in the name, phone, address, and who referred them. It drops a gold ⭐ pin that OVERRIDES whatever pin was already there and creates the lead in JobNimbus as a "Referral" — so it counts toward YOUR harvest leaderboard. A referral you haven't reached yet shows up as a required CALL, not a route stop — you see a "referral calls to make" bar on your map. Tap it, call them. If they don't answer, reschedule the call for today, tomorrow, or a specific day and it stays off your route until you actually book something. If they're not interested, dismiss it. When they answer and want to move forward, book the appointment or sign them right there.$q$
where not exists (select 1 from public.harvest_training_sections where track='rep' and title='⭐ Referrals — your own lead, on your leaderboard');

-- ── Remote e-sign ───────────────────────────────────────────────────────────
insert into public.harvest_training_sections (track, sort, title, body)
select 'rep', 94, '🖊️ Sign over the phone — remote e-sign',
  $q$Some homeowners you can sign without driving out. On a referral or lead call, choose "Sign now" and DoorDispatcher texts them the agreement plus a verification code — they open it, enter the code, and sign on their own phone while you're still talking. If our texts aren't reaching them (it's happened before), use the Copy Link button and send the link from your own phone. Same result: once they sign, it lands in JobNimbus credited to you. No driving, no paperwork.$q$
where not exists (select 1 from public.harvest_training_sections where track='rep' and title='🖊️ Sign over the phone — remote e-sign');

-- ── Required follow-ups (go-backs + callbacks) ──────────────────────────────
insert into public.harvest_training_sections (track, sort, title, body)
select 'rep', 76, '📌 Follow-ups DoorDispatcher forces on you — go-backs & callbacks',
  $q$Salespeople are famously bad at follow-ups — so DoorDispatcher does it for you. Every go-back and every callback becomes a REQUIRED stop that shows on your map like any other pin, and the "required stops" bar won't clear until you work them all. Time kills all deals, so it also weighs OLDER follow-ups as more urgent when it orders your day. A "come back tomorrow" callback is treated as a near-definitive appointment — it's the top of your required list. Go-backs are never scheduled for the same day. Knock a follow-up and nobody's home? Tap "Nobody home — try again" and it re-dates itself to the next good day and counts the attempt, so it never just disappears.$q$
where not exists (select 1 from public.harvest_training_sections where track='rep' and title='📌 Follow-ups DoorDispatcher forces on you — go-backs & callbacks');

-- ── REP questions ───────────────────────────────────────────────────────────
do $do$
declare s_clover uuid; s_ref uuid; s_remote uuid; s_follow uuid;
begin
  select id into s_clover from public.harvest_training_sections where track='rep' and title='🍀 Clover Leaf — the easiest doors on the map' limit 1;
  select id into s_ref    from public.harvest_training_sections where track='rep' and title='⭐ Referrals — your own lead, on your leaderboard' limit 1;
  select id into s_remote from public.harvest_training_sections where track='rep' and title='🖊️ Sign over the phone — remote e-sign' limit 1;
  select id into s_follow from public.harvest_training_sections where track='rep' and title='📌 Follow-ups DoorDispatcher forces on you — go-backs & callbacks' limit 1;

  if not exists (select 1 from public.harvest_training_questions where track='rep' and prompt=$q$Why is a clover pin such an easy door to knock?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('rep', s_clover, 300, $q$Why is a clover pin such an easy door to knock?$q$,
      jsonb_build_array($q$We're roofing a neighbor right now, and their name is on your card so you can say it$q$, $q$The homeowner already signed$q$, $q$It pays double commission$q$, $q$It's a random door$q$), 0);
  end if;

  if not exists (select 1 from public.harvest_training_questions where track='rep' and prompt=$q$What happens to a clover cluster once you route it?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('rep', s_clover, 310, $q$What happens to a clover cluster once you route it?$q$,
      jsonb_build_array($q$Nothing changes$q$, $q$It locks to you — but unlocks if you go inactive ~30 min$q$, $q$It's locked to you forever$q$, $q$Everyone gets a copy$q$), 1);
  end if;

  if not exists (select 1 from public.harvest_training_questions where track='rep' and prompt=$q$You get a referral you haven't reached yet. How does it show up?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('rep', s_ref, 320, $q$You get a referral you haven't reached yet. How does it show up?$q$,
      jsonb_build_array($q$As a route stop you must drive to$q$, $q$As a required CALL in your "referral calls to make" bar$q$, $q$It doesn't show until tomorrow$q$, $q$Only your manager sees it$q$), 1);
  end if;

  if not exists (select 1 from public.harvest_training_questions where track='rep' and prompt=$q$A referral you call doesn't answer. What do you do?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('rep', s_ref, 330, $q$A referral you call doesn't answer. What do you do?$q$,
      jsonb_build_array($q$Delete the lead$q$, $q$Reschedule the call (today/tomorrow/a day) — it stays off your route until you book$q$, $q$Drive to the house anyway$q$, $q$Nothing, it's gone$q$), 1);
  end if;

  if not exists (select 1 from public.harvest_training_questions where track='rep' and prompt=$q$Your system texts to the homeowner aren't going through on a remote sign. What's the backup?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('rep', s_remote, 340, $q$Your system texts to the homeowner aren't going through on a remote sign. What's the backup?$q$,
      jsonb_build_array($q$Give up and drive out$q$, $q$Use Copy Link and text it from your own phone$q$, $q$Reset your phone$q$, $q$Have them come to the office$q$), 1);
  end if;

  if not exists (select 1 from public.harvest_training_questions where track='rep' and prompt=$q$You knock a required go-back and nobody's home. What happens?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('rep', s_follow, 350, $q$You knock a required go-back and nobody's home. What happens?$q$,
      jsonb_build_array($q$It disappears$q$, $q$Tap "Nobody home — try again" and it re-dates to the next good day and counts the attempt$q$, $q$It's marked not interested$q$, $q$It schedules for the same day$q$), 1);
  end if;

  if not exists (select 1 from public.harvest_training_questions where track='rep' and prompt=$q$How does DoorDispatcher order your required follow-ups?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('rep', s_follow, 360, $q$How does DoorDispatcher order your required follow-ups?$q$,
      jsonb_build_array($q$Alphabetically$q$, $q$Older follow-ups count as more urgent — time kills all deals$q$, $q$Newest first$q$, $q$Randomly$q$), 1);
  end if;
end $do$;

-- ════════════════════════════════════════════════════════════════════════════
--  MANAGER track
-- ════════════════════════════════════════════════════════════════════════════

insert into public.harvest_training_sections (track, sort, title, body)
select 'manager', 65, 'Clover Leaf route-lock — who owns a grid',
  $q$When our crew starts a roof, clover pins drop on the neighbors and reps work them for the easiest yeses. The instant a rep ROUTES a clover cluster, it locks to that rep — no one else can route it or even see it — so two reps never collide on the same block. It's tied to effort: if that rep goes inactive in the cluster for about 30 minutes, it releases and another rep can take it. Coach your team to get to a cluster first and keep moving.$q$
where not exists (select 1 from public.harvest_training_sections where track='manager' and title='Clover Leaf route-lock — who owns a grid');

insert into public.harvest_training_sections (track, sort, title, body)
select 'manager', 85, 'Assign Appointments — catching missed go-backs',
  $q$Some appointments and go-backs get set by William or by reps who are no longer active — and without an owner they'd fall through the cracks. Those land in your "Assign Appointments" queue with a note telling you what the visit is (e.g. a damage or retail go-back). Assign each one to a rep and DoorDispatcher moves it onto that rep's map so the appointment isn't missed. Check this queue daily — an unassigned go-back is a deal nobody is working.$q$
where not exists (select 1 from public.harvest_training_sections where track='manager' and title='Assign Appointments — catching missed go-backs');

insert into public.harvest_training_sections (track, sort, title, body)
select 'manager', 95, 'Referrals & self-gen — protecting your team''s credit',
  $q$Reps generate their own leads two ways: the ⭐ Referral button (a referral they were given) and dropping a self-gen pin on a damaged roof. Both create the lead in JobNimbus tagged to the rep — Referral or Self-Generated — so it counts on their harvest leaderboard. The leaderboard credit is durable: it reads the job's harvest flag and date, so a deal a rep worked doesn't drop off the board just because they later sat or sold it. If a rep says a harvested deal "isn't showing," it's almost always a name/ID mismatch — check that, not the count.$q$
where not exists (select 1 from public.harvest_training_sections where track='manager' and title='Referrals & self-gen — protecting your team''s credit');

do $do$
declare m_clover uuid; m_assign uuid; m_credit uuid;
begin
  select id into m_clover from public.harvest_training_sections where track='manager' and title='Clover Leaf route-lock — who owns a grid' limit 1;
  select id into m_assign from public.harvest_training_sections where track='manager' and title='Assign Appointments — catching missed go-backs' limit 1;
  select id into m_credit from public.harvest_training_sections where track='manager' and title='Referrals & self-gen — protecting your team''s credit' limit 1;

  if not exists (select 1 from public.harvest_training_questions where track='manager' and prompt=$q$A rep routes a clover cluster. Who can work it?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('manager', m_clover, 400, $q$A rep routes a clover cluster. Who can work it?$q$,
      jsonb_build_array($q$Anyone on the team$q$, $q$Only that rep — until they go inactive ~30 min, then it releases$q$, $q$Only senior reps$q$, $q$Nobody until you approve it$q$), 1);
  end if;

  if not exists (select 1 from public.harvest_training_questions where track='manager' and prompt=$q$William sets a go-back but there's no rep on it. Where do you handle it?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('manager', m_assign, 410, $q$William sets a go-back but there's no rep on it. Where do you handle it?$q$,
      jsonb_build_array($q$Nowhere — it's automatic$q$, $q$The Assign Appointments queue — assign it and it moves to that rep's map$q$, $q$JobNimbus only$q$, $q$You call the homeowner yourself$q$), 1);
  end if;

  if not exists (select 1 from public.harvest_training_questions where track='manager' and prompt=$q$A rep says a harvested deal dropped off the leaderboard after they sat it. What's the likely cause?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('manager', m_credit, 420, $q$A rep says a harvested deal dropped off the leaderboard after they sat it. What's the likely cause?$q$,
      jsonb_build_array($q$Credit is durable now — check for a name/ID mismatch, not the count$q$, $q$Sitting a deal removes the credit$q$, $q$The board resets daily$q$, $q$Referrals never count$q$), 0);
  end if;
end $do$;
