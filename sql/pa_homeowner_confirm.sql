-- Company-authored homeowner appointment-confirmation message. When enabled,
-- the homeowner gets this SMS (and email, if we have their address) the moment a
-- PA appointment is booked. Sent via the system's number/Resend, but the company
-- writes the wording (put the company name in it so it reads as theirs).
-- Placeholders the sender fills in: {homeowner} {date} {address} {company}
alter table pa_companies
  add column if not exists homeowner_confirm_enabled       boolean not null default false,
  add column if not exists homeowner_confirm_sms           text,
  add column if not exists homeowner_confirm_email_subject text,
  add column if not exists homeowner_confirm_email_body    text;
