-- Notification CC for PA companies: extra email(s) CC'd on the "New PA
-- appointment" notification (alongside the company email). Comma-separated.
-- e.g. Five Star wants weather.report@fivestaradj.com on every new assignment.
alter table pa_companies add column if not exists notify_cc text;
