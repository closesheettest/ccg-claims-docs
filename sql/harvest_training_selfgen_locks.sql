-- Harvest Tool Training — add (1) the "drop your own pin" instruction incl. the
-- non-owner-occupied X, and (2) the "work BOTH your pin types" rule (Sr: IQ + No-sit,
-- Jr: Inspection + IQ-NI). Idempotent + independent — insert-if-missing only. Run in CCG.

-- ── REP: "Work them both" (the locked pin types) ────────────────────────────
insert into public.harvest_training_sections (track, sort, title, body)
select 'rep', 15, 'Your two pin types — work them BOTH',
  $q$Your map is locked to the TWO lead types you work — they stay on together so you never drop half your job. If you're a SENIOR rep, that's IQ leads AND "No-sit – need to reschedule" — both matter, both get worked. If you're a JUNIOR rep, that's Inspection Leads AND "IQ – Not Interested" (back-to-retail). You can tap other pin types to ADD them to your map, but your two core types always stay on. These are your most reliable path to sales — don't skip one for the other.$q$
where not exists (select 1 from public.harvest_training_sections where track='rep' and title='Your two pin types — work them BOTH');

-- ── REP: "Drop your own pin" incl. the non-owner X (insert if missing) ───────
insert into public.harvest_training_sections (track, sort, title, body)
select 'rep', 95, 'Drop your own pin (self-generated lead)',
  $q$See a damaged roof that isn't on your map? Drop your own pin on it — tap the ➕ button, then tap the house. The map instantly checks the county records. If it's the OWNER'S home (homestead on file), you get Sign Inspection / Retail Appointment / Pending — work it like any lead, and it goes into JobNimbus as a Self-Generated lead you get credit for. If it's NOT owner-occupied — a rental, where the owner's mail goes to a different address — tap "✕ Mark non owner-occupied": that drops an X on the house so you and every other rep know not to waste a trip there, and it quietly saves the owner's info for the office. Never leave a non-owner house blank — mark the X.$q$
where not exists (select 1 from public.harvest_training_sections where track='rep' and title='Drop your own pin (self-generated lead)');
-- if it already exists but the body is blank, fill it
update public.harvest_training_sections set body =
  $q$See a damaged roof that isn't on your map? Drop your own pin on it — tap the ➕ button, then tap the house. The map instantly checks the county records. If it's the OWNER'S home (homestead on file), you get Sign Inspection / Retail Appointment / Pending — work it like any lead, and it goes into JobNimbus as a Self-Generated lead you get credit for. If it's NOT owner-occupied — a rental, where the owner's mail goes to a different address — tap "✕ Mark non owner-occupied": that drops an X on the house so you and every other rep know not to waste a trip there, and it quietly saves the owner's info for the office. Never leave a non-owner house blank — mark the X.$q$
where track='rep' and title='Drop your own pin (self-generated lead)' and coalesce(body,'')='';

-- ── Questions ───────────────────────────────────────────────────────────────
do $do$
declare rid_both uuid; rid_pin uuid; mid uuid;
begin
  select id into rid_both from public.harvest_training_sections where track='rep' and title='Your two pin types — work them BOTH' limit 1;
  select id into rid_pin  from public.harvest_training_sections where track='rep' and title='Drop your own pin (self-generated lead)' limit 1;
  select id into mid from public.harvest_training_sections where track='manager' and title='The Harvesting Map — the big picture' limit 1;

  if not exists (select 1 from public.harvest_training_questions where track='rep' and prompt=$q$If you're a SENIOR rep, which two lead types must you work?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('rep', rid_both, 12, $q$If you're a SENIOR rep, which two lead types must you work?$q$, jsonb_build_array($q$Just IQ$q$, $q$IQ AND No-sit – need to reschedule$q$, $q$Inspection leads only$q$, $q$Whatever you feel like$q$), 1);
  end if;
  if not exists (select 1 from public.harvest_training_questions where track='rep' and prompt=$q$If you're a JUNIOR rep, which two lead types must you work?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('rep', rid_both, 13, $q$If you're a JUNIOR rep, which two lead types must you work?$q$, jsonb_build_array($q$Inspection Leads AND IQ – Not Interested$q$, $q$Just inspection leads$q$, $q$IQ + No-sit$q$, $q$None$q$), 0);
  end if;
  if not exists (select 1 from public.harvest_training_questions where track='rep' and prompt=$q$You drop a pin and the house is NOT owner-occupied (a rental). What do you do?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('rep', rid_pin, 96, $q$You drop a pin and the house is NOT owner-occupied (a rental). What do you do?$q$, jsonb_build_array($q$Leave it blank$q$, $q$Tap "✕ Mark non owner-occupied" so it drops an X$q$, $q$Sign it anyway$q$, $q$Delete the map$q$), 1);
  end if;
  if not exists (select 1 from public.harvest_training_questions where track='rep' and prompt=$q$Dropping your own pin on a damaged roof creates what?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('rep', rid_pin, 97, $q$Dropping your own pin on a damaged roof creates what?$q$, jsonb_build_array($q$Nothing$q$, $q$A Self-Generated lead you get credit for$q$, $q$A complaint$q$, $q$An install$q$), 1);
  end if;
  if mid is not null and not exists (select 1 from public.harvest_training_questions where track='manager' and prompt=$q$What two lead types must every SENIOR rep work on their map?$q$) then
    insert into public.harvest_training_questions (track, section_id, sort, prompt, choices, correct_index) values
    ('manager', mid, 15, $q$What two lead types must every SENIOR rep work on their map?$q$, jsonb_build_array($q$Only IQ$q$, $q$IQ AND No-sit – need to reschedule$q$, $q$Inspection leads$q$, $q$Whatever's closest$q$), 1);
  end if;
end $do$;
