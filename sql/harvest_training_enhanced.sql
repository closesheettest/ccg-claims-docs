-- Harvest Tool Training — add ENHANCED PLANNED DAY to the manager track.
-- Adds one lesson section + test questions about the "Plan the Day" section-assignment
-- tool. Idempotent + independent of the other content SQL: only inserts if missing, so
-- edits/screenshots are never clobbered. Run in the CCG Supabase SQL editor.

-- ── Lesson section (after Practice mode) ────────────────────────────────────
insert into public.harvest_training_sections (track, sort, title, body)
select 'manager', 105, 'Enhanced Planned Day — planning your team''s map',
  $q$When the company turns on Enhanced Planned Day, a "🧭 Plan the Day" panel appears on your dashboard. It takes your zone's IQ and No-sit-reschedule leads — your team's most reliable path to sales — and automatically splits them into balanced sections, one per Sr rep on your team (including you), each grouped into a tight area so nobody crisscrosses. You assign each section to a rep with the dropdown (or keep the auto-assignment), then tap Publish. From then on, every Sr rep's "Start my day" loads their assigned section, already sorted around their appointments. You can re-split or re-publish any time. This is how you make sure the high-value IQ and No-sit leads get worked fast — and it shows you at a glance who's working their assignment and who's dropping the ball. (Jr reps aren't part of this — they just use their normal daily pin count.)$q$
where not exists (
  select 1 from public.harvest_training_sections
  where track='manager' and title='Enhanced Planned Day — planning your team''s map'
);

-- ── Questions (link to that section for remediation) ────────────────────────
do $do$
declare sid uuid;
begin
  select id into sid from public.harvest_training_sections
    where track='manager' and title='Enhanced Planned Day — planning your team''s map' limit 1;

  if not exists (select 1 from public.harvest_training_questions where track='manager' and prompt=$q$Which leads does Enhanced Planned Day split across your Sr reps?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('manager', sid, 200, $q$Which leads does Enhanced Planned Day split across your Sr reps?$q$,
      jsonb_build_array($q$Every inspection lead in the state$q$, $q$The zone's IQ + No-sit-reschedule leads$q$, $q$Random doors$q$, $q$Nothing — it's automatic$q$), 1);
  end if;

  if not exists (select 1 from public.harvest_training_questions where track='manager' and prompt=$q$How many sections does the plan create?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('manager', sid, 210, $q$How many sections does the plan create?$q$,
      jsonb_build_array($q$One for the whole team$q$, $q$One per Sr rep on the team, including you$q$, $q$One per Jr rep$q$, $q$Always exactly five$q$), 1);
  end if;

  if not exists (select 1 from public.harvest_training_questions where track='manager' and prompt=$q$After you assign the sections, what do you tap so your reps get their plan?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('manager', sid, 220, $q$After you assign the sections, what do you tap so your reps get their plan?$q$,
      jsonb_build_array($q$Re-split$q$, $q$Publish$q$, $q$Nothing — it saves itself$q$, $q$Delete$q$), 1);
  end if;

  if not exists (select 1 from public.harvest_training_questions where track='manager' and prompt=$q$Where does a rep find the section you assigned them?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('manager', sid, 230, $q$Where does a rep find the section you assigned them?$q$,
      jsonb_build_array($q$You text it to them$q$, $q$It loads when they tap "Start my day"$q$, $q$On the leaderboard$q$, $q$They can't see it$q$), 1);
  end if;
end $do$;
