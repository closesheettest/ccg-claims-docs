-- Records that NO physical inspection happened, and why — set when the inspector
-- takes the app's "can't inspect" path (tarp on roof / obvious damage → Damage, or
-- Back to Retail). Non-null = it was a NO-INSPECTION, and the text is the reason.
--
-- Before this, that note was pushed to JobNimbus only, so nothing in our data could
-- tell a no-inspection apart from a real inspection that happened to have 2 photos.
-- The manager's "Inspections to confirm" tile keys off this: a no-inspection isn't
-- held for confirmation (there's no inspection to QA), it fires straight through.
alter table inspections add column if not exists no_inspection_note text;
