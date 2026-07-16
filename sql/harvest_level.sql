-- Per-person Harvesting-Map access level, chosen by the office (overrides the
-- rep-zones senior/junior default).
--   'admin'  → view-all (every pin type, like the office link) on their OWN link
--   'senior' → senior pins (IQ / FB / AI + everything a junior sees)
--   'junior' → junior pins only (insp + iq_ni — what a trainee works)
--   NULL     → fall back to rep-zones level, else junior
--
-- Lets the office promote a trainer/manager to a personal view-all link without
-- deactivating anyone, while keeping trainees (e.g. William Hernandez) as juniors.
alter table sales_reps add column if not exists harvest_level text;
