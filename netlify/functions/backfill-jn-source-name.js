// One-time backfill: rename lead_source='NEED' to 'Inspection' across
// the database AND push source_name='Inspection' to every matching JN
// job. Safe to re-run — only touches rows where lead_source is still
// 'NEED' (DB) or whose JN job still has source_name='NEED'.
//
// Trigger: POST /.netlify/functions/backfill-jn-source-name
//   Body (optional): { dry_run: true } to preview without writing.
//
// Auth: ?secret=<BACKFILL_SECRET> on the URL, OR X-Backfill-Secret
// header. Falls back to CRON_SECRET if BACKFILL_SECRET isn't set.
//
// Required env vars: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
// JOBNIMBUS_API_KEY. Optional: BACKFILL_SECRET, CRON_SECRET.

const JN_BASE = "https://app.jobnimbus.com/api1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return json(405, { error: "Method not allowed" });
  }

  // Auth — needs a shared secret since this mutates lots of rows.
  const required = process.env.BACKFILL_SECRET || process.env.CRON_SECRET;
  if (required) {
    const provided =
      event.headers["x-backfill-secret"] ||
      event.headers["X-Backfill-Secret"] ||
      event.queryStringParameters?.secret;
    if (provided !== required) return json(401, { error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  if (!SB_URL || !SB_KEY) return json(500, { error: "Supabase env not configured" });
  if (!JN_KEY) return json(500, { error: "JOBNIMBUS_API_KEY not set" });

  const body = event.httpMethod === "POST"
    ? safeJson(event.body)
    : {};
  const dryRun = !!body.dry_run || event.queryStringParameters?.dry_run === "1";

  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };
  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

  const results = {
    dry_run: dryRun,
    inspections: { matched: 0, db_updated: 0, jn_updated: 0, jn_skipped_no_id: 0, jn_errors: [] },
    claims:      { matched: 0, db_updated: 0, jn_updated: 0, jn_skipped_no_id: 0, jn_errors: [] },
  };

  for (const table of ["inspections", "claims"]) {
    // Pull every row with the old source.
    const qs = new URLSearchParams({
      select: "id,jn_job_id,lead_source",
      lead_source: "eq.NEED",
      limit: "1000",
    }).toString();
    const rowsRes = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, { headers: sbHeaders });
    if (!rowsRes.ok) {
      return json(500, { error: `Could not fetch ${table}: ${await rowsRes.text()}` });
    }
    const rows = await rowsRes.json();
    results[table].matched = rows.length;

    for (const row of rows) {
      // 1. Update the JN job (if linked) FIRST. If JN fails we still
      //    want to fix the DB so future syncs send the right value.
      if (row.jn_job_id) {
        if (!dryRun) {
          try {
            const jnRes = await fetch(`${JN_BASE}/jobs/${row.jn_job_id}`, {
              method: "PUT",
              headers: jnHeaders,
              body: JSON.stringify({ source_name: "Inspection" }),
            });
            if (jnRes.ok) {
              results[table].jn_updated++;
            } else {
              results[table].jn_errors.push({
                row_id: row.id,
                jn_job_id: row.jn_job_id,
                status: jnRes.status,
                detail: await jnRes.text().then((t) => t.slice(0, 200)),
              });
            }
          } catch (e) {
            results[table].jn_errors.push({
              row_id: row.id,
              jn_job_id: row.jn_job_id,
              error: e.message || "Unknown",
            });
          }
        }
      } else {
        results[table].jn_skipped_no_id++;
      }

      // 2. Update the DB row.
      if (!dryRun) {
        const updRes = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${row.id}`, {
          method: "PATCH",
          headers: sbHeaders,
          body: JSON.stringify({ lead_source: "Inspection" }),
        });
        if (updRes.ok) results[table].db_updated++;
      }
    }
  }

  return json(200, results);
};

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
