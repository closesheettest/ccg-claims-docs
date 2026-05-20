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

  // undo_orphans mode: roll back the orphan sync we just did. For the
  // specific inspection IDs (defaults to the 14 from the 2026-05-20
  // backfill), DELETEs the JN job we created today and NULLs out
  // jn_job_id so the row becomes an orphan again. Doesn't touch
  // lead_source — those rows stay as 'Inspection'.
  const undoOrphans = body.undo_orphans === true ||
    event.queryStringParameters?.undo_orphans === "1" ||
    event.queryStringParameters?.undo_orphans === "true";

  // The 11 inspection IDs from the 2026-05-20 backfill THAT STILL POINT
  // AT NEWLY-CREATED JN JOBS. Stefano's 3 (Robert/Maria/Michael) were
  // manually re-pointed to their original JN jobs via SQL earlier, so
  // they are EXCLUDED here — running undo on those would delete the
  // originals.
  const DEFAULT_UNDO_IDS = [
    "2e473e6e-637f-41fb-9b2a-2cd4bc58ae6f", // Nora lambirght
    "1c865a85-9762-4f11-b7ef-59cdc07a4f18", // Emma freeman
    "83411498-15c5-498e-a2d5-9e71296b3baa", // Jaime escalante
    "b5a87f1a-6e19-454f-9032-9afbdbbcb204", // Cristin bullock
    "ec5f5937-e92a-4ab6-9e91-8b1f56dada69", // Danny perry
    "19485d78-83f5-4e9c-80e5-32c1df2c14da", // Johnny thomas
    "ef01dfac-5ea4-4b2a-b941-aacafc22cf1e", // betty perry
    "e6e0ae7e-da6b-4ffe-9f91-1c0fd20261d1", // Heidi mastroianni
    "1d6a9056-8dcf-4a56-886a-9230df84426c", // Vanessa ealy
    "e88e773d-6dab-4fa9-aa4f-51d2db77c8cd", // Carlos gomez
    "d48865e8-ba2b-4516-a575-d13a239e66d7", // Rhonda Reining
  ];
  // Stefano's 3 duplicate JN job IDs created by the 2026-05-20 backfill.
  // These aren't linked to any Supabase row (we re-pointed those rows
  // to the original JN jobs already), so we delete them directly.
  const DEFAULT_STRAY_JN_IDS = [
    "mpearva0sym2dc80c0pprw",  // Maria class duplicate
    "mpearunzwbmegujjq2gkl9d", // Michael Leone duplicate
    "mpeartv411728lxa9wkv9zp", // Robert abbatecola duplicate
  ];
  const undoIds = Array.isArray(body.inspection_ids) && body.inspection_ids.length > 0
    ? body.inspection_ids
    : DEFAULT_UNDO_IDS;
  const strayJnIds = Array.isArray(body.stray_jn_ids)
    ? body.stray_jn_ids
    : DEFAULT_STRAY_JN_IDS;

  if (undoOrphans) {
    return await runUndo({
      SB_URL,
      sbHeaders,
      jnHeaders,
      dryRun,
      undoIds,
      strayJnIds,
    });
  }

  // mark_duplicates=1 mode: JN won't let us DELETE via API. As a
  // workaround, rename each of the 14 leftover JN jobs from the
  // 2026-05-20 backfill (11 newly-created + 3 Stefano duplicates) to
  // prefix "[DELETE ME 2026-05-20] " so admin can find them in the
  // JN UI and bulk-delete with manual clicks. Idempotent (no-op if
  // already prefixed).
  const markDuplicates = body.mark_duplicates === true ||
    event.queryStringParameters?.mark_duplicates === "1" ||
    event.queryStringParameters?.mark_duplicates === "true";

  // jn_audit=1 mode: scan every JN job (paginated), find ones with
  // status="Sit Sold Insp" AND source_name="NEED", PUT source_name to
  // "Inspection". Catches legacy / unlinked / orphaned JN jobs that
  // the DB-driven reconcile can't see. Customize via body:
  //   target_status (default "Sit Sold Insp")
  //   target_source (default "NEED")
  //   replacement_source (default "Inspection")
  //   max_pages (default 30 — safety against runaway scans)
  const jnAudit = body.jn_audit === true ||
    event.queryStringParameters?.jn_audit === "1" ||
    event.queryStringParameters?.jn_audit === "true";

  if (jnAudit) {
    return await runJnAudit({
      jnHeaders,
      dryRun,
      targetStatus: body.target_status || "Sit Sold Insp",
      targetSource: body.target_source || "NEED",
      replacementSource: body.replacement_source || "Inspection",
      maxPages: Number.isFinite(body.max_pages) ? body.max_pages : 30,
    });
  }

  if (markDuplicates) {
    // Hardcoded set: the 11 jn_job_ids we just unlinked from Supabase
    // (from the undo dry-run output) + the 3 Stefano duplicates.
    const DEFAULT_MARK_IDS = [
      "mpeafhyrtdck37apwghn7ax", // Nora lambirght
      "mpeafk0ksy2r6sbao9bav7n", // Emma freeman
      "mpeaflf2gxvx60pyhlu0pkt", // Jaime escalante
      "mpeafmjaptw73abm50k4bv", // Cristin bullock
      "mpeafy1cgvx5c8sxbaxin3w", // Danny perry
      "mpeafzb5dzeo95797u7qrok", // Johnny thomas
      "mpeag0737ca6khnat2eigj8", // betty perry
      "mpearqsvxr8rmv6g212gyhc", // Heidi mastroianni
      "mpearrjhpjfo8984ake6o1i", // Vanessa ealy
      "mpearsg4m6uf8az2he0cubb", // Carlos gomez
      "mpeart494f698q17k3cjuxv", // Rhonda Reining
      "mpearva0sym2dc80c0pprw",  // Maria class duplicate
      "mpearunzwbmegujjq2gkl9d", // Michael Leone duplicate
      "mpeartv411728lxa9wkv9zp", // Robert abbatecola duplicate
    ];
    const markIds = Array.isArray(body.jn_ids) && body.jn_ids.length > 0
      ? body.jn_ids
      : DEFAULT_MARK_IDS;
    const prefix = body.prefix || "[DELETE ME 2026-05-20] ";
    return await runMarkDuplicates({
      jnHeaders,
      dryRun,
      markIds,
      prefix,
    });
  }

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

// Undo the 2026-05-20 orphan sync. Two pieces of cleanup:
//
//   A) For each inspection ID in undoIds (the 11 William+Dustin rows
//      that still point at newly-created JN jobs):
//      1. Read its current jn_job_id from Supabase.
//      2. DELETE that JN job (the one we created today).
//      3. NULL out the Supabase row's jn_job_id so it goes back to
//         being an orphan and admin can re-sync properly later.
//
//   B) For each jn_id in strayJnIds (Stefano's 3 duplicates that
//      aren't linked to any Supabase row anymore — we relinked
//      Stefano's rows to the originals via SQL earlier):
//      Just DELETE the stray JN job directly.
//
// Leaves lead_source alone — it stays 'Inspection' per the rename.
async function runUndo({ SB_URL, sbHeaders, jnHeaders, dryRun, undoIds, strayJnIds }) {
  const out = {
    dry_run: dryRun,
    undo_orphans: true,
    total: undoIds.length,
    jn_deleted: 0,
    jn_already_missing: 0,
    jn_delete_errors: [],
    db_unlinked: 0,
    db_errors: [],
    rows: [],
    stray_jn_total: (strayJnIds || []).length,
    stray_jn_deleted: 0,
    stray_jn_errors: [],
    stray_rows: [],
  };
  for (const id of undoIds) {
    // 1. Look up current state.
    const qs = new URLSearchParams({
      select: "id,client_name,jn_job_id",
      id: `eq.${id}`,
      limit: "1",
    }).toString();
    const lookup = await fetch(`${SB_URL}/rest/v1/inspections?${qs}`, { headers: sbHeaders });
    const rows = lookup.ok ? await lookup.json() : [];
    const row = rows[0];
    if (!row) {
      out.rows.push({ id, error: "not found in inspections" });
      continue;
    }
    const summary = { id, client_name: row.client_name, jn_job_id: row.jn_job_id };
    if (!row.jn_job_id) {
      out.jn_already_missing++;
      summary.action = "skipped — already orphan";
      out.rows.push(summary);
      continue;
    }
    // 2. DELETE the JN job.
    if (!dryRun) {
      try {
        const delRes = await fetch(`https://app.jobnimbus.com/api1/jobs/${row.jn_job_id}`, {
          method: "DELETE",
          headers: jnHeaders,
        });
        if (delRes.ok || delRes.status === 404) {
          out.jn_deleted++;
          summary.jn = `deleted (${delRes.status})`;
        } else {
          const detail = await delRes.text().then((t) => t.slice(0, 200));
          out.jn_delete_errors.push({ id, jn_job_id: row.jn_job_id, status: delRes.status, detail });
          summary.jn = `error ${delRes.status}`;
          // Still continue to NULL out the DB pointer so a re-sync works later.
        }
      } catch (e) {
        out.jn_delete_errors.push({ id, jn_job_id: row.jn_job_id, error: e.message || "Unknown" });
        summary.jn = `exception: ${e.message || "Unknown"}`;
      }
    } else {
      summary.jn = "(dry-run would DELETE)";
    }
    // 3. NULL out the Supabase pointer.
    if (!dryRun) {
      const upd = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${id}`, {
        method: "PATCH",
        headers: sbHeaders,
        body: JSON.stringify({ jn_job_id: null }),
      });
      if (upd.ok) {
        out.db_unlinked++;
        summary.db = "jn_job_id cleared";
      } else {
        const detail = await upd.text().then((t) => t.slice(0, 200));
        out.db_errors.push({ id, status: upd.status, detail });
        summary.db = `error ${upd.status}`;
      }
    } else {
      summary.db = "(dry-run would NULL jn_job_id)";
    }
    out.rows.push(summary);
  }
  // Part B: stray JN-only deletions (Stefano's 3 duplicates that
  // aren't tied to any Supabase inspection anymore).
  for (const jnId of (strayJnIds || [])) {
    const summary = { jn_job_id: jnId };
    if (dryRun) {
      summary.action = "(dry-run would DELETE)";
      out.stray_rows.push(summary);
      continue;
    }
    try {
      const delRes = await fetch(`https://app.jobnimbus.com/api1/jobs/${jnId}`, {
        method: "DELETE",
        headers: jnHeaders,
      });
      if (delRes.ok || delRes.status === 404) {
        out.stray_jn_deleted++;
        summary.action = `deleted (${delRes.status})`;
      } else {
        const detail = await delRes.text().then((t) => t.slice(0, 200));
        out.stray_jn_errors.push({ jn_job_id: jnId, status: delRes.status, detail });
        summary.action = `error ${delRes.status}`;
      }
    } catch (e) {
      out.stray_jn_errors.push({ jn_job_id: jnId, error: e.message || "Unknown" });
      summary.action = `exception: ${e.message || "Unknown"}`;
    }
    out.stray_rows.push(summary);
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(out),
  };
}

// JN doesn't allow DELETE on jobs via API. Workaround: rename each
// leftover job with a "[DELETE ME ...] " prefix so admin can spot
// them at a glance in the JN UI and bulk-delete via clicks.
//
// Idempotent — if a job's name already starts with the prefix we
// skip it. Returns per-job status so admin can see what changed.
async function runMarkDuplicates({ jnHeaders, dryRun, markIds, prefix }) {
  const out = {
    dry_run: dryRun,
    mark_duplicates: true,
    prefix,
    total: markIds.length,
    renamed: 0,
    already_prefixed: 0,
    errors: [],
    rows: [],
  };
  for (const jnId of markIds) {
    const summary = { jn_job_id: jnId };
    try {
      // 1. GET the current name.
      const getRes = await fetch(`https://app.jobnimbus.com/api1/jobs/${jnId}`, {
        headers: jnHeaders,
      });
      if (!getRes.ok) {
        const detail = await getRes.text().then((t) => t.slice(0, 200));
        out.errors.push({ jn_job_id: jnId, step: "get", status: getRes.status, detail });
        summary.action = `get error ${getRes.status}`;
        out.rows.push(summary);
        continue;
      }
      const job = await getRes.json().catch(() => ({}));
      const currentName = job.name || job.display_name || "";
      summary.current_name = currentName;
      if (currentName.startsWith(prefix)) {
        out.already_prefixed++;
        summary.action = "skipped — already prefixed";
        out.rows.push(summary);
        continue;
      }
      const newName = prefix + currentName;
      summary.new_name = newName;
      // 2. PUT the new name.
      if (!dryRun) {
        const putRes = await fetch(`https://app.jobnimbus.com/api1/jobs/${jnId}`, {
          method: "PUT",
          headers: jnHeaders,
          body: JSON.stringify({ name: newName }),
        });
        if (putRes.ok) {
          out.renamed++;
          summary.action = "renamed";
        } else {
          const detail = await putRes.text().then((t) => t.slice(0, 200));
          out.errors.push({ jn_job_id: jnId, step: "put", status: putRes.status, detail });
          summary.action = `put error ${putRes.status}`;
        }
      } else {
        summary.action = "(dry-run would rename)";
      }
    } catch (e) {
      out.errors.push({ jn_job_id: jnId, error: e.message || "Unknown" });
      summary.action = `exception: ${e.message || "Unknown"}`;
    }
    out.rows.push(summary);
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(out),
  };
}

// Scan every JN job and fix any that still have source_name="NEED"
// at status="Sit Sold Insp". Paginated through JN's /jobs endpoint.
// Page size 100 (JN's max we expect to be supported) — at most
// `maxPages` pages are scanned to keep us inside the function
// timeout. For typical free-roof-inspection volume (~75 jobs), one
// page is plenty.
async function runJnAudit({ jnHeaders, dryRun, targetStatus, targetSource, replacementSource, maxPages }) {
  const PAGE_SIZE = 100;
  const out = {
    dry_run: dryRun,
    jn_audit: true,
    target_status: targetStatus,
    target_source: targetSource,
    replacement_source: replacementSource,
    pages_scanned: 0,
    total_jobs_scanned: 0,
    matches_found: 0,
    matches_updated: 0,
    matches: [],
    errors: [],
    truncated: false,
  };
  for (let page = 0; page < maxPages; page++) {
    const from = page * PAGE_SIZE;
    const url = `https://app.jobnimbus.com/api1/jobs?size=${PAGE_SIZE}&from=${from}`;
    let listRes;
    try {
      listRes = await fetch(url, { headers: jnHeaders });
    } catch (e) {
      out.errors.push({ step: "list", page, error: e.message || "Unknown" });
      break;
    }
    if (!listRes.ok) {
      const detail = await listRes.text().then((t) => t.slice(0, 200));
      out.errors.push({ step: "list", page, status: listRes.status, detail });
      break;
    }
    const data = await listRes.json().catch(() => ({}));
    const jobs = data.results || data.jobs || data.items || [];
    if (jobs.length === 0) break;
    out.pages_scanned = page + 1;
    out.total_jobs_scanned += jobs.length;

    const matches = jobs.filter(
      (j) => j.status_name === targetStatus && j.source_name === targetSource,
    );
    // Update each match (or list for dry-run). Process in parallel
    // batches of 8 to stay under timeout.
    for (let i = 0; i < matches.length; i += 8) {
      const batch = matches.slice(i, i + 8);
      await Promise.all(batch.map(async (job) => {
        const jnId = job.jnid || job.id;
        const summary = { jn_job_id: jnId, name: job.name || job.display_name || "" };
        out.matches_found++;
        if (dryRun) {
          summary.action = `(dry-run would PUT source_name=${replacementSource})`;
          out.matches.push(summary);
          return;
        }
        try {
          const putRes = await fetch(`https://app.jobnimbus.com/api1/jobs/${jnId}`, {
            method: "PUT",
            headers: jnHeaders,
            body: JSON.stringify({ source_name: replacementSource }),
          });
          if (putRes.ok) {
            out.matches_updated++;
            summary.action = "updated";
          } else {
            const detail = await putRes.text().then((t) => t.slice(0, 200));
            out.errors.push({ step: "put", jn_job_id: jnId, status: putRes.status, detail });
            summary.action = `error ${putRes.status}`;
          }
        } catch (e) {
          out.errors.push({ step: "put", jn_job_id: jnId, error: e.message || "Unknown" });
          summary.action = `exception: ${e.message || "Unknown"}`;
        }
        out.matches.push(summary);
      }));
    }

    if (jobs.length < PAGE_SIZE) break;
    if (page === maxPages - 1) {
      // We hit the cap — there might be more jobs to scan.
      out.truncated = true;
    }
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(out),
  };
}

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
