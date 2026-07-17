-- Billing ledger: one row per PERSON per MONTH they had Harvesting-Map access.
-- Stamped the moment access is given (trainee grant) or the map is opened — so a
-- trainee who gets access on day 2 and drops out day 3 is STILL billed for that
-- month, even after they're removed from the live roster. Row persists forever.
create table if not exists harvest_access_months (
  rep_id   uuid not null,
  rep_name text,
  month    text not null,          -- 'YYYY-MM' (Eastern)
  primary key (rep_id, month)
);
create index if not exists idx_harvest_access_month on harvest_access_months (month);
grant select, insert, update on harvest_access_months to anon, authenticated;
