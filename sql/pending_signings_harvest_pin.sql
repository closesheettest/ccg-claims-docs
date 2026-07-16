-- Link a remote signing back to the Harvesting-Map pin it came from.
-- When a rep taps "Sign Inspection" on the map and then chooses "Send for
-- signing" (remote), the pin is marked "Pending signature" (insp_pending).
-- finalize-remote-signing reads this column and flips the pin to Inspection
-- Sold once the homeowner actually signs and the JobNimbus deal is created.
alter table pending_signings add column if not exists harvest_pin uuid;
