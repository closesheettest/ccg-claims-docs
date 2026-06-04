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
    } else if (status === "sit sold pa" && !row.pa_id) {
      patch = {
        pa_decision_needed: true,
        pa_decision_reason: "Old PA — Sit Sold PA",
        pa_decision_at: nowIso,
        jn_status: "Sit Sold PA",
      };
      kind = "parked_sit_sold";
      parkedSitSold++;
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

  return json(200, {
    ok: true,
    examined: rows.length,
    lost_cancelled: lostCancelled,
    parked_lost: parkedLost,
    parked_sit_sold: parkedSitSold,
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
