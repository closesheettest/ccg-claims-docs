-- Training / practice ("sandbox") mode for the Free Roof Inspection signing flow.
-- A practice run (reached via /?mode=training) creates a normal pending_signing
-- so the whole real flow works — real 6-digit code by text/email, real review &
-- sign — but flagged sandbox=true. On finalize it does NOT create an inspection
-- or a JobNimbus deal (same isolation the "test"-name short-circuit already uses),
-- and it's hidden from the admin pending-signatures list. The admin "Clear
-- sandbox" button deletes every sandbox=true row after class.
alter table pending_signings add column if not exists sandbox boolean not null default false;
create index if not exists pending_signings_sandbox_idx on pending_signings (sandbox);
