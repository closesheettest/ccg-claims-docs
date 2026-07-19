-- Harvest Tool Training — add PRACTICE MODE to the manager track.
-- The manager dashboard has a "🧪 Practice the Harvesting tools" sandbox (real pins,
-- nothing saves) so managers can play with the map before coaching reps on it. This adds
-- a lesson section about it + one test question. Runs independently of the main content
-- SQL and is safe to re-run: it only inserts the section/question if they don't exist yet,
-- so your edits and any uploaded screenshot are never clobbered.

-- ── New manager lesson section (capstone, after "Reading the reports") ───────
insert into public.harvest_training_sections (track, sort, title, body)
select 'manager', 100, 'Practice mode — try it yourself (sandbox)',
  $q$Before you coach your team, get hands-on. On your dashboard, open "🧪 Practice the Harvesting tools." It opens the real map in a safe sandbox — you see real pins, but NOTHING you do is saved: no status sticks, nothing goes to JobNimbus, no rep is affected. Use it to try the exact buttons your reps use — Start my day, Route an area, Plan your day, statusing a door — so you can walk them through it and answer their questions. You'll know you're in the sandbox by the purple "PRACTICE MODE" banner across the top. Spend a few minutes here and the rest of this training will click.$q$
where not exists (
  select 1 from public.harvest_training_sections
  where track='manager' and title='Practice mode — try it yourself (sandbox)'
);

-- ── One question, linked to that section (for remediation) ───────────────────
insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index)
select 'manager',
  (select id from public.harvest_training_sections where track='manager' and title='Practice mode — try it yourself (sandbox)' limit 1),
  160,
  $q$What happens to anything you do in Practice mode (the 🧪 sandbox)?$q$,
  jsonb_build_array(
    $q$It saves and affects your reps$q$,
    $q$Nothing is saved — it's a safe sandbox on real pins$q$,
    $q$It creates real appointments in JobNimbus$q$,
    $q$It deletes the pins$q$
  ),
  1
where not exists (
  select 1 from public.harvest_training_questions
  where track='manager' and prompt=$q$What happens to anything you do in Practice mode (the 🧪 sandbox)?$q$
);
