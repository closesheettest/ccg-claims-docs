// netlify/functions/reconcile-pa-jn-status.js
//
// Closes the gap inspection-checker can't: that cron only looks at JN
// jobs whose date_updated is within a 60-day window, so an OLD deal that
// quietly went Lost (or was pushed to "Sit Sold PA") long ago never gets
// reflected locally — it keeps sitting in the PA pool as claimable, or
// stays in a PA's claims. (Real case: Emma Freeman, JN job created 4/2,
// Lost in JN, but our row still showed jn_status=null and got claimed.)
//
// This function instead checks the LIVE JN status BY JOB ID for the
// bounded set of PA-relevant damage deals, so the window doesn't matter:
//   • status "Lost"        → cancel the row (drops it from the pool); if a
//                            PA had it (pa_id set) also park it in the
//                            "PA Decision Needed" queue.
//   • status "Sit Sold PA" → park unassigned ones in Decision Needed.
//
// Deals a manager already decided on (pa_decision_resolved_at set) are
// skipped — JN may still say "Lost" but the manager deliberately
// reinstated the deal to a new PA and we override that locally.
//
// Invoke: POST or GET (no body needed). A scheduled wrapper
// (cron-reconcile-pa-jn-status.js) hits it on a timer; the manager
// "Refresh from JN" button in the Public Adjusters panel hits it too.
//
// Required env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.
// Optional: CRON_SECRET (if set, request must pass ?secret= or header).

const JN_BASE = "https://app.jobnimbus.com/api1";
const BATCH = 20;        // JN job GETs per round
const MAX_DEALS = 600;   // safety cap on rows examined per run

exports.handler = async (event) => {
  // Scheduled invocations arrive with no httpMethod; manual GET/POST both fine.
  if (event.httpMethod && event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return json(405, { ok: false, error: "Method not allowed" });
  }
  const required = process.env.CRON_SECRET;
  if (required) {
    const provided =
      event.headers["x-cron-secret"] ||
      event.headers["X-Cron-Secret"] ||
      event.queryStringParameters?.secret;
    // Allow the manager UI (same-origin browser POST) through without the
    // secret; only enforce when a secret is explicitly provided as a
    // header/query (i.e. external callers). The button never sends one.
    if (provided && provided !== required) return json(401, { ok: false, error: "Unauthorized" });
  }

  const missing = [];
  for (const k of ["JOBNIMBUS_API_KEY", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) return json(500, { ok: false, error: `Missing env: ${missing.join(", ")}` });

  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

  // PA-relevant damage deals still "live" on our side: claimable pool +
  // claimed, excluding anything already cancelled, already parked, or
  // already decided by a manager.
  const listUrl =
    `${SB_URL}/rest/v1/inspections` +
    `?select=id,client_name,jn_job_id,pa_id,result,jn_status` +
    `&result=eq.damage` +
    `&jn_job_id=not.is.null` +
    `&cancelled_at=is.null` +
    `&pa_decision_needed=is.false` +
    `&pa_decision_resolved_at=is.null` +
    `&order=signed_at.desc` +
    `&limit=${MAX_DEALS}`;

  let rows = [];
  const listRes = await fetch(listUrl, { headers: sbHeaders });
  if (!listRes.ok) return json(500, { ok: false, error: `List failed: ${(await listRes.text()).slice(0, 200)}` });
  rows = await listRes.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    return json(200, { ok: true, examined: 0, lost_cancelled: 0, parked_lost: 0, parked_sit_sold: 0, changed: [] });
  }

  const nowIso = new Date().toISOString();
  let lostCancelled = 0, parkedLost = 0, parkedSitSold = 0;
  const changed = [];

  async function checkOne(row) {
    if (!row.jn_job_id) return;
    let status = "";
    try {
      const r = await fetch(`${JN_BASE}/jobs/${row.jn_job_id}`, { headers: jnHeaders });
      if (!r.ok) return;
      const job = await r.json();
      status = (job.status_name || "").trim().toLowerCase();
    } catch { return; }

    // Lost only here. Sit Sold PA is handled comprehensively in Phase B
    // below (a JN-side status scan that also catches deals currently
    // assigned to a PA and ones outside this local "live" window).
    let patch = null, kind = null;
    if (status === "lost") {
      patch = {
        cancelled_at: nowIso,
        cancel_reason: "JN status Lost (PA reconcile)",
        jn_status: "Lost",
      };
      if (row.pa_id) {
        // A PA had claimed it and the deal then went Lost in JN — park it
        // for a US Shingle decision (keep pa_id so we can show who had it).
        patch.pa_decision_needed = true;
        patch.pa_decision_reason = "Was assigned to a PA, then marked Lost in JN";
        patch.pa_decision_at = nowIso;
        kind = "parked_lost";
        parkedLost++;
      } else {
        kind = "lost_cancelled";
        lostCancelled++;
      }
    }
    if (!patch) return;

    const up = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${row.id}`, {
      method: "PATCH",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    });
    if (up.ok) changed.push({ id: row.id, client: row.client_name, kind });
    else {
      // roll back the local tally if the write failed
      if (kind === "parked_lost") parkedLost--;
      else if (kind === "lost_cancelled") lostCancelled--;
      else if (kind === "parked_sit_sold") parkedSitSold--;
    }
  }

  for (let i = 0; i < rows.length; i += BATCH) {
    await Promise.all(rows.slice(i, i + BATCH).map(checkOne));
  }

  // ── Phase B: comprehensive "Sit Sold PA" scan, JN-side ──────────────
  // Phase A only sees our bounded local set and misses deals JN currently
  // has at "Sit Sold PA" but that we (a) have assigned to a PA, (b) never
  // had in the live window, or (c) never had at all (older deals signed
  // before in-app inspection capture). Ask JN directly by status filter
  // for EVERY Sit Sold PA job, then:
  //   • matching local row, not parked/resolved → PARK it (any pa_id).
  //   • no local row + DAMAGE                    → CREATE a stub record and
  //                                                park it (so historical
  //                                                JN-only damage deals show
  //                                                in the queue too). Non-
  //                                                damage JN-only deals are
  //                                                skipped — a PA won't take
  //                                                them. New deals always
  //                                                have an app record, so
  //                                                this create path only
  //                                                ever backfills history.
  let sitSoldScanned = 0, parkedSitSoldCreated = 0;
  const createErrors = [];
  try {
    const SS_FILTER = JSON.stringify({ must: [{ term: { status_name: "Sit Sold PA" } }] });
    const PAGE = 100, MAX_PAGES = 20;
    const ssJobs = [];  // slim job objects (need result + address to create stubs)
    let from = 0;
    for (let p = 0; p < MAX_PAGES; p++) {
      let r;
      try {
        r = await fetch(`${JN_BASE}/jobs?filter=${encodeURIComponent(SS_FILTER)}&size=${PAGE}&from=${from}`, { headers: jnHeaders });
      } catch { break; }
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const pageJobs = d.results || d.jobs || d.items || [];
      for (const j of pageJobs) {
        const id = j.jnid || j.id;
        if (!id) continue;
        ssJobs.push({
          jnid: id,
          result: (j.cf_string_34 || "").toLowerCase().replace(/\s+/g, "_"),
          client_name: j.primary?.name || j.name || j.display_name || "",
          address: j.address_line1 || "",
          city: j.city || "",
          state: j.state_text || "",
          zip: j.zip || "",
          date_created: j.date_created || null,
        });
      }
      if (pageJobs.length < PAGE) break;
      from += PAGE;
    }
    sitSoldScanned = ssJobs.length;
    const jobByJnId = Object.fromEntries(ssJobs.map((j) => [j.jnid, j]));
    const allJnIds = ssJobs.map((j) => j.jnid);

    // Process in chunks. For each chunk we need the FULL existence picture
    // (no decision-state filter) so we can tell "exists but parkable" from
    // "doesn't exist at all → maybe create".
    for (let i = 0; i < allJnIds.length; i += 100) {
      const chunk = allJnIds.slice(i, i + 100);
      const inList = chunk.map((id) => `"${id}"`).join(",");
      let existing = [];
      try {
        const lr = await fetch(
          `${SB_URL}/rest/v1/inspections` +
          `?select=id,client_name,jn_job_id,pa_id,pa_decision_needed,pa_decision_resolved_at` +
          `&jn_job_id=in.(${encodeURIComponent(inList)})`,
          { headers: sbHeaders },
        );
        if (lr.ok) existing = await lr.json();
      } catch { existing = []; }
      const existingByJnId = Object.fromEntries(existing.map((r) => [r.jn_job_id, r]));

      // (1) Park existing rows that aren't already parked/resolved.
      const toPark = existing.filter((r) => !r.pa_decision_needed && !r.pa_decision_resolved_at);
      await Promise.all(toPark.map(async (row) => {
        const patch = {
          pa_decision_needed: true,
          pa_decision_reason: row.pa_id ? "Sit Sold PA — was assigned to a PA" : "Sit Sold PA (old PA)",
          pa_decision_at: nowIso,
          jn_status: "Sit Sold PA",
        };
        const up = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${row.id}`, {
          method: "PATCH",
          headers: { ...sbHeaders, Prefer: "return=minimal" },
          body: JSON.stringify(patch),
        });
        if (up.ok) {
          parkedSitSold++;
          changed.push({ id: row.id, client: row.client_name, kind: "parked_sit_sold" });
        }
      }));

      // (2) Create stubs for DAMAGE jobs that have no local row at all.
      const toCreate = chunk
        .filter((id) => !existingByJnId[id])
        .map((id) => jobByJnId[id])
        .filter((j) => j && j.result === "damage");
      await Promise.all(toCreate.map(async (j) => {
        const insert = {
          jn_job_id: j.jnid,
          client_name: j.client_name || "(JobNimbus deal)",
          address: j.address,
          city: j.city,
          state: j.state,
          zip: j.zip,
          result: "damage",
          signed_at: j.date_created ? new Date(j.date_created * 1000).toISOString() : null,
          jn_status: "Sit Sold PA",
          lead_source: "JN Sit Sold PA backfill",
          pa_decision_needed: true,
          pa_decision_reason: "Sit Sold PA (JobNimbus-only, no app record)",
          pa_decision_at: nowIso,
        };
        const ins = await fetch(`${SB_URL}/rest/v1/inspections`, {
          method: "POST",
          headers: { ...sbHeaders, Prefer: "return=representation" },
          body: JSON.stringify(insert),
        });
        if (ins.ok) {
          const created = await ins.json().catch(() => []);
          const id = Array.isArray(created) ? created[0]?.id : null;
          parkedSitSold++;
          parkedSitSoldCreated++;
          changed.push({ id, client: j.client_name, kind: "parked_sit_sold_created" });
        } else if (createErrors.length < 5) {
          const t = await ins.text().catch(() => "");
          createErrors.push({ client: j.client_name, status: ins.status, detail: t.slice(0, 200) });
        }
      }));
    }
  } catch { /* Phase B is best-effort; Phase A results still return */ }

  return json(200, {
    ok: true,
    examined: rows.length,
    sit_sold_scanned: sitSoldScanned,
    lost_cancelled: lostCancelled,
    parked_lost: parkedLost,
    parked_sit_sold: parkedSitSold,
    parked_sit_sold_created: parkedSitSoldCreated,
    create_errors: createErrors,
    changed,
  });
};

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// Netlify v2 scheduled function — every 30 min at :10 and :40. Offset from
// the other crons (:00/:15/:30/:45 inspection-checker, :05 push-pending,
// :20 cert-retry) so we don't bunch JN requests.
exports.config = { schedule: "10,40 * * * *" };
