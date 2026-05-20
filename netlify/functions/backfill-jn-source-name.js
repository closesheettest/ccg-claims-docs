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

  // reconcile=1 mode: instead of "fix NEED → Inspection", iterate every
  // linked inspection (jn_job_id set) and PUT source_name = whatever
  // lead_source the DB currently holds. Fixes pre-existing DB-vs-JN
  // drift (e.g. row 'df52eac3...' had INS in DB but NEED in JN).
  const reconcile = body.reconcile === true ||
    event.queryStringParameters?.reconcile === "1" ||
    event.queryStringParameters?.reconcile === "true";

  const results = {
    dry_run: dryRun,
    sync_orphans: syncOrphans,
    reconcile,
    inspections: {
      matched: 0,
      db_updated: 0,
      jn_updated: 0,
      jn_skipped_no_id: 0,
      jn_already_matched: 0,
      orphans_synced: 0,
      orphan_sync_errors: [],
      jn_errors: [],
      mismatches: [], // populated in reconcile dry-run
    },
  };

  for (const table of ["inspections"]) {
    // Pull rows. Default scope = rows with lead_source='NEED' (the
    // original NEED → Inspection backfill). reconcile=1 scope = every
    // linked row (jn_job_id set), so we can push the DB's current
    // lead_source to JN and fix any pre-existing drift.
    const params = {
      select:
        "id,jn_job_id,lead_source,client_name,address,city,state,zip,sales_rep_name,sales_rep_id,signed_at",
      limit: "1000",
    };
    if (reconcile) {
      params["jn_job_id"] = "not.is.null";
      params["lead_source"] = "not.is.null";
    } else {
      params["lead_source"] = "eq.NEED";
    }
    const qs = new URLSearchParams(params).toString();
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

    // In reconcile mode, also rebuild the JN user index so we can fill
    // in the sales_rep field on any job that was created without one
    // (e.g. orphan rows that had sales_rep_name but no sales_rep_id).
    // Map keys are lowercased trimmed full names.
    let repByName = null;
    if (reconcile) {
      try {
        const usersRes = await fetch(`${JN_BASE}/users?size=200`, { headers: jnHeaders });
        if (usersRes.ok) {
          const usersJson = await usersRes.json();
          const users = usersJson.results || usersJson.users || usersJson || [];
          repByName = new Map();
          for (const u of users) {
            const name =
              (u.display_name || `${u.first_name || ""} ${u.last_name || ""}`).trim().toLowerCase();
            const id = u.jnid || u.id;
            if (name && id) repByName.set(name, id);
          }
        }
      } catch (e) {
        // non-fatal — reconcile still pushes source_name even if rep
        // lookup fails. Surface the issue in the response.
        results.rep_lookup_error = e.message || "Unknown";
      }
    }

    // Per-row work — runs in parallel inside Promise.all batches below.
    async function processRow(row) {
      // The target value for JN's source_name:
      //   • reconcile mode: whatever the DB currently has (push DB → JN)
      //   • default mode:   force 'Inspection' (rename NEED → Inspection)
      const targetSource = reconcile ? row.lead_source : "Inspection";

      // 1. Update the DB row FIRST (default mode only — reconcile leaves
      //    lead_source alone since the DB is the source of truth there).
      //    Reconcile mode separately backfills sales_rep_id below when
      //    we resolve it from the name.
      if (!reconcile && !dryRun) {
        const updRes = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${row.id}`, {
          method: "PATCH",
          headers: sbHeaders,
          body: JSON.stringify({ lead_source: "Inspection" }),
        });
        if (updRes.ok) results[table].db_updated++;
      }

      // 2. Already-linked row: PUT source_name to its JN job. In
      //    reconcile mode also push sales_rep when we have the rep's
      //    JN id (from row.sales_rep_id, or looked up by name in the
      //    JN user index we built above).
      if (row.jn_job_id) {
        const putBody = { source_name: targetSource };
        let repIdForJn = null;
        if (reconcile) {
          repIdForJn =
            row.sales_rep_id ||
            (repByName && row.sales_rep_name
              ? repByName.get(String(row.sales_rep_name).trim().toLowerCase()) || null
              : null);
          if (repIdForJn) {
            putBody.sales_rep = repIdForJn;
            putBody.owners = [{ id: repIdForJn }];
          }
        }
        if (!dryRun) {
          try {
            const jnRes = await fetch(`${JN_BASE}/jobs/${row.jn_job_id}`, {
              method: "PUT",
              headers: jnHeaders,
              body: JSON.stringify(putBody),
            });
            if (jnRes.ok) {
              results[table].jn_updated++;
              // If we filled in sales_rep_id via name lookup, save it
              // back to Supabase so the next sync doesn't have to
              // re-resolve. Best-effort — non-fatal if it fails.
              if (reconcile && repIdForJn && !row.sales_rep_id) {
                fetch(`${SB_URL}/rest/v1/${table}?id=eq.${row.id}`, {
                  method: "PATCH",
                  headers: sbHeaders,
                  body: JSON.stringify({ sales_rep_id: repIdForJn }),
                }).catch(() => {});
              }
            } else {
              results[table].jn_errors.push({
                row_id: row.id,
                jn_job_id: row.jn_job_id,
                target_source: targetSource,
                status: jnRes.status,
                detail: await jnRes.text().then((t) => t.slice(0, 200)),
              });
            }
          } catch (e) {
            results[table].jn_errors.push({
              row_id: row.id,
              jn_job_id: row.jn_job_id,
              target_source: targetSource,
              error: e.message || "Unknown",
            });
          }
        } else if (reconcile) {
          // Dry-run reconcile: record what would be pushed.
          results[table].mismatches.push({
            row_id: row.id,
            client_name: row.client_name,
            address: row.address,
            jn_job_id: row.jn_job_id,
            db_lead_source: row.lead_source,
            would_push_to_jn: targetSource,
          });
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
