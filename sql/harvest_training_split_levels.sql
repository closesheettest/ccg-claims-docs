-- Split the single 'rep' training track into 'senior' and 'junior' — JR and SR reps
-- get DIFFERENT training videos, lessons, and tests. Copies the existing 'rep' content
-- into BOTH new tracks (with question→section links preserved) so each starts fully
-- populated; the office then edits each track (and sets each video) separately.
--
-- Idempotent: only seeds a level track that has no sections yet, so re-running never
-- clobbers edits. The old 'rep' rows are left in place (harmless, just unused).
-- Run in the CCG Supabase SQL editor (after sql/harvest_training.sql + its content).

do $do$
declare tgt text;
declare s record;
declare q record;
declare newsec uuid;
begin
  foreach tgt in array array['senior','junior'] loop
    -- skip if this level was already seeded
    if exists (select 1 from public.harvest_training_sections where track = tgt) then
      continue;
    end if;
    -- copy each section, then its linked questions (remapped to the new section id)
    for s in select * from public.harvest_training_sections where track = 'rep' order by sort loop
      newsec := gen_random_uuid();
      insert into public.harvest_training_sections (id, track, sort, title, body, screenshot_url, active, updated_at)
        values (newsec, tgt, s.sort, s.title, s.body, s.screenshot_url, s.active, now());
      for q in select * from public.harvest_training_questions where track = 'rep' and section_id = s.id loop
        insert into public.harvest_training_questions (id, track, section_id, sort, prompt, choices, correct_index, active, updated_at)
          values (gen_random_uuid(), tgt, newsec, q.sort, q.prompt, q.choices, q.correct_index, q.active, now());
      end loop;
    end loop;
    -- copy any questions that weren't linked to a section
    for q in select * from public.harvest_training_questions where track = 'rep' and section_id is null loop
      insert into public.harvest_training_questions (id, track, section_id, sort, prompt, choices, correct_index, active, updated_at)
        values (gen_random_uuid(), tgt, null, q.sort, q.prompt, q.choices, q.correct_index, q.active, now());
    end loop;
  end loop;
end $do$;

-- Each level track gets its own editable training video row.
insert into public.harvest_training_config (track) values ('senior'), ('junior')
  on conflict (track) do nothing;
