-- Per-signup code-delivery choice for remote signing.
-- Lets the rep pick, per signup, HOW the homeowner proves it's them:
--   'rep_code' = "Sign now" — homeowner opens on their own phone, the 6-digit
--                code appears on the REP's screen to read to them (in person).
--   'sms'      = "Send for signing" — the code is texted + emailed straight to
--                the homeowner so they sign remotely on their own.
-- Null on old rows → get-pending-signing falls back to the global
-- `remote_signing_autosend` app_setting (backward compatible).
alter table pending_signings add column if not exists delivery_mode text;
