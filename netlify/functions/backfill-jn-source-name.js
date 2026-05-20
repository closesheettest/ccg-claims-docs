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

  // Only inspections has lead_source + jn_job_id. The claims table
  // (LoR + PA Authorization signings) doesn't ship to JN and doesn't
  // store a lead source — handled here as a single-table backfill.
  //
  // syncOrphans=true also creates JN jobs for rows missing jn_job_id
  // by calling the existing /retry-jn-sync function per row. The DB
  // is updated to lead_source='Inspection' BEFORE the call so the JN
  // job gets the new source_name from the get-go.
  const syncOrphans = body.sync_orphans === true ||
    event.queryStringParameters?.sync_orphans === "1" ||
    event.queryStringParameters?.sync_orphans === "true";

  const results = {
    dry_run: dryRun,
    sync_orphans: syncOrphans,
    inspections: {
      matched: 0,
      db_updated: 0,
      jn_updated: 0,
      jn_skipped_no_id: 0,
      orphans_synced: 0,
      orphan_sync_errors: [],
      jn_errors: [],
    },
  };

  for (const table of ["inspections"]) {
    // Pull every row with the old source. Includes enough identifying
    // fields that the dry-run output lists orphan rows (no jn_job_id)
    // by name + address + date — so admin can decide whether to sync,
    // delete (test rows), or just let the DB backfill them.
    const qs = new URLSearchParams({
      select:
        "id,jn_job_id,lead_source,client_name,address,city,state,zip,sales_rep_name,signed_at",
      lead_source: "eq.NEED",
      limit: "1000",
    }).toString();
    const rowsRes = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, { headers: sbHeaders });
    if (!rowsRes.ok) {
      return json(500, { error: `Could not fetch ${table}: ${await rowsRes.text()}` });
    }
    const rows = await rowsRes.json();
    results[table].matched = rows.length;
    // On dry runs, ship the orphan rows back so the caller can scan
    // for test data without round-tripping to SQL.
    if (dryRun) {
      results[table].orphans = rows
        .filter((r) => !r.jn_job_id)
        .map((r) => ({
          id: r.id,
          client_name: r.client_name,
          address: r.address,
          city: r.city,
          zip: r.zip,
          sales_rep_name: r.sales_rep_name,
          signed_at: r.signed_at,
        }));
    }

    // Resolve the base URL once for orphan retry-sync calls.
    const base = process.env.URL || process.env.PUBLIC_SITE_URL || process.env.DEPLOY_URL || "";

    // Per-row work — runs in parallel inside Promise.all batches below.
    async function processRow(row) {
      // 1. Update the DB row FIRST. This way any retry-jn-sync call
      //    that follows reads lead_source='Inspection' from the row
      //    and ships that to JN as the new source_name.
      if (!dryRun) {
        const updRes = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${row.id}`, {
          method: "PATCH",
          headers: sbHeaders,
          body: JSON.stringify({ lead_source: "Inspection" }),
        });
        if (updRes.ok) results[table].db_updated++;
      }

      // 2. Already-linked row: PUT source_name to its JN job.
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
        return;
      }

      // 3. Orphan row: optionally create a JN job via retry-jn-sync.
      results[table].jn_skipped_no_id++;
      if (syncOrphans && !dryRun && base) {
        try {
          const syncRes = await fetch(`${base}/.netlify/functions/retry-jn-sync`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ inspectionId: row.id }),
          });
          const syncBody = await syncRes.json().catch(() => ({}));
          if (syncRes.ok && syncBody.ok) {
            results[table].orphans_synced++;
          } else {
            results[table].orphan_sync_errors.push({
              row_id: row.id,
              client_name: row.client_name,
              status: syncRes.status,
              detail: syncBody.error || syncBody.detail || "Unknown",
            });
          }
        } catch (e) {
          results[table].orphan_sync_errors.push({
            row_id: row.id,
            client_name: row.client_name,
            error: e.message || "Unknown",
          });
        }
      }
    }

    // Process in concurrent batches of 8. Big enough to stay under the
    // 30s function timeout with 68 rows + cascading retry-jn-sync calls;
    // small enough not to slam JN's rate limits. Each batch awaits
    // before the next starts so errors stay contained.
    const BATCH_SIZE = 8;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(processRow));
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
