// netlify/functions/cron-reconcile-jn-photos.js
//
// Safety net for the inspector-app photo gap: photos upload one-by-one from
// the inspector's phone as a result is submitted, so if the app closes early
// some (or all) never reach JN's Photos tab — even though the originals are
// safe in Supabase Storage / the inspection_photos array.
//
// This cron walks RECENT inspections, compares the app's photo count to the
// JN job's Photos tab (type=2), and re-pushes any that are missing — deduped
// by filename so it never creates a duplicate. It drives the same per-photo
// uploader the browser uses (upload-photo-to-jn), one Lambda per photo, so
// the heavy lifting is parallel and this function stays light.
//
// Bounded per run (recent window + caps) to stay within the function time
// limit; runs daily, so the small daily trickle of gaps is always caught.
// (The original ~1,700-photo backlog was cleared by a one-time backfill.)
//
// GET /.netlify/functions/cron-reconcile-jn-photos  (also runs on schedule)
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

const WINDOW_DAYS = 5;      // only look back this far — recent gaps; backlog was backfilled
const MAX_INSPECTIONS = 80; // cap jobs scanned per run (JN list calls)
const MAX_PUSH = 80;        // cap photos pushed per run (stay within time limit)
const CONCURRENCY = 5;      // parallel upload-photo-to-jn dispatches

exports.handler = async () => {
  if (!SB_URL || !SB_KEY || !JN_KEY) {
    return json(500, { ok: false, error: "Missing env (Supabase / JOBNIMBUS_API_KEY)" });
  }
  const base = (process.env.URL || process.env.DEPLOY_PRIME_URL || "").replace(/\/$/, "");
  if (!base) return json(500, { ok: false, error: "No site URL for self-dispatch" });

  const since = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString();
  try {
    // 1. Recent, non-cancelled inspections that have a JN job + app photos.
    const url = `${SB_URL}/rest/v1/inspections?cancelled_at=is.null&jn_job_id=not.is.null&result_at=gte.${encodeURIComponent(since)}&select=id,client_name,jn_job_id,inspection_photos&order=result_at.desc&limit=${MAX_INSPECTIONS}`;
    const res = await fetch(url, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
    if (!res.ok) return json(500, { ok: false, error: `Supabase ${res.status}` });
    const rows = (await res.json().catch(() => [])).filter(
      (r) => Array.isArray(r.inspection_photos) && r.inspection_photos.length > 0,
    );

    // 2. Per job: compare app photos vs JN Photos tab (by filename), queue missing.
    const queue = []; // { jn_job_id, path, bucket, label }
    let shortJobs = 0;
    for (const r of rows) {
      if (queue.length >= MAX_PUSH) break;
      const have = await jnPhotoFilenames(r.jn_job_id);
      if (have === null) continue; // JN error — skip this job this run (fail-soft)
      const missing = r.inspection_photos.filter((p) => {
        const fn = String(p.path || "").split("/").pop();
        return fn && !have.has(fn);
      });
      if (!missing.length) continue;
      shortJobs++;
      for (const p of missing) {
        if (queue.length >= MAX_PUSH) break;
        queue.push({ jn_job_id: r.jn_job_id, path: p.path, bucket: p.bucket || "signed-documents", label: p.label || "Inspector photo" });
      }
    }

    // 3. Push missing photos via the per-photo uploader (parallel, bounded).
    let pushed = 0, failed = 0;
    for (let i = 0; i < queue.length; i += CONCURRENCY) {
      const batch = queue.slice(i, i + CONCURRENCY);
      const out = await Promise.all(batch.map((q) => dispatchUpload(base, q)));
      for (const ok of out) ok ? pushed++ : failed++;
    }

    const result = { ok: true, scanned: rows.length, short_jobs: shortJobs, queued: queue.length, pushed, failed, capped: queue.length >= MAX_PUSH };
    console.log("reconcile-jn-photos:", JSON.stringify(result));
    return json(200, result);
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

// Set of photo filenames already on the JN job (type=2). null on JN error.
async function jnPhotoFilenames(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/files?related=${encodeURIComponent(jnid)}&type=2&size=300`, { headers: jnHeaders });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    const files = d.results || d.files || d.data || [];
    return new Set(files.map((f) => f.filename || f.name || "").filter(Boolean));
  } catch { return null; }
}

async function dispatchUpload(base, body) {
  try {
    const r = await fetch(`${base}/.netlify/functions/upload-photo-to-jn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    return !!d.ok;
  } catch { return false; }
}

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// Daily at 08:10 UTC (~4 AM ET) — quiet hours, after the day's inspections.
exports.config = { schedule: "10 8 * * *" };
