-- Harvesting Map — upload batches. Every lead upload is logged here so the
-- office can see each file/list that was loaded and DELETE a bad one (which
-- removes the pins that upload ADDED). Each prospect is tagged with the upload
-- batch that created it via canvass_prospects.upload_id.
create table if not exists harvest_uploads (
  id           uuid primary key default gen_random_uuid(),
  list_name    text,
  default_type text,          -- what the office marked this upload as
  inserted     int default 0, -- new pins created
  updated      int default 0, -- existing pins whose type this upload changed
  skipped      int default 0, -- existing pins left as-is (protected / no change)
  uploaded_by  text,
  uploaded_at  timestamptz default now()
);
alter table harvest_uploads enable row level security;
drop policy if exists harvest_uploads_all on harvest_uploads;
create policy harvest_uploads_all on harvest_uploads for all using (true) with check (true);
grant all on harvest_uploads to anon, authenticated;

-- Tag each prospect with the upload that CREATED it. Deleting an upload removes
-- only the pins it added (pins it merely updated keep their original upload_id).
alter table canvass_prospects add column if not exists upload_id uuid;
create index if not exists canvass_prospects_upload_idx on canvass_prospects (upload_id);
