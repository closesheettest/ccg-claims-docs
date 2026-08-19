-- sql/signing_stall_alert.sql
--
-- Somewhere to record that we warned the rep about a stalled signing.
--
-- Six free-roof-inspection signings have been lost since July 2 the same way:
-- the homeowner opened the agreement, passed the phone code, and then the
-- signature never completed. The final PDF is generated on the HOMEOWNER'S
-- phone before it can be submitted, so an old handset, a weak signal or simply
-- walking away kills it — and the only sign of trouble was a line of text on
-- their screen. Nobody else was told, so nobody chased it (Neal, 2026-08-19).
--
-- Stamped when the rep is texted, so they're warned once and not nagged.
alter table pending_signings
  add column if not exists stall_alert_at timestamptz;

-- Verify — the six known stalls, and whether anyone has been told:
--   select client_name, address, sales_rep_name, phone_verified_at, stall_alert_at
--     from pending_signings
--    where status = 'phone_verified' and signed_at is null
--    order by phone_verified_at desc;
