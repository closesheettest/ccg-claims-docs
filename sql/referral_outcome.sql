-- No-Damage visit outcome catalog (for the referral funnel report). LOCAL ONLY —
-- never pushed to JobNimbus.
--   'given'    = rep collected referral(s); the `referrals` table holds the
--                names + count (how many referrals — the number we care about).
--   'sent'     = certificate sent, no referral captured (not an explicit decline).
--   'declined' = homeowner doesn't want to give a referral.
-- A non-null value also drops the deal off the rep's No-Damage visit list (handled).
alter table inspections add column if not exists referral_outcome text;
