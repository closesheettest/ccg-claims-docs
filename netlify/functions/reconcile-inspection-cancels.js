// netlify/functions/reconcile-inspection-cancels.js
//
// Safety net for the "office marked the deal Lost in JN but the inspector app
// still shows it" gap. inspection-checker.js already brings JN "Lost" → our
// cancelled_at, but it does so by sweeping JN's ~500 most-recently-updated jobs
// and filtering by record_type — so a Lost job can slip through (outside the
// window, or a record_type the filter drops).
//
// This works the RELIABLE direction: it starts from OUR OWN active inspection
// list (the exact rows an inspector can still act on) and checks each one's
// CURRENT JN status. Any whose JN job is now "Lost" is stale — it should be off
// the list. Immune to the sweep-window / record_type gaps.
//
//   active inspection = cancelled_at IS NULL AND result IS NULL AND jn_job_id present
//
//   GET  /.netlify/functions/reconcile-inspection-cancels            → DRY RUN
//   GET  /.netlify/functions/reconcile-inspection-cancels?apply=1    → cancel the Lost ones
//   Scheduled runs (POST from Netlify) apply automatically.
//   optional ?statuses=Lost,Sit%20-%20No%20Sale   (extra JN statuses to treat as cancel)
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const CONC = 10;
const DEFAULT_CANCEL_STATUSES = ["Lost"]; // exactly what the office sets on a cancellation

// Runs every 5 minutes. Lightweight (only reads our active inspections + their
// JN status), so a fast cadence is cheap — a homeowner cancellation marked
// "Lost" in JN drops off the inspector list within 5 minutes, reliably (this
// checks from our side, so it can't miss on inspection-checker's sweep gaps).
exports.config = { schedule: "*/5 * * * *" };

exports.handler = async (event) => {
  if (!JN_KEY || !SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing env" });
  const qp = (event && event.queryStringParameters) || {};
  const isManual = event && event.httpMethod === "GET";
  const apply = isManual ? ["1", "true", "yes"].includes(String(qp.apply || "").toLowerCase()) : true;
  const cancelStatuses = new Set(
    (qp.statuses ? String(qp.statuses).split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_CANCEL_STATUSES)
      .map((s) => s.toLowerCase())
  );

  try {
    // 1. Our active inspection list — what an inspector could still be sent to.
    const active = await sbGet(
      `inspections?cancelled_at=is.null&result=is.null&jn_job_id=not.is.null` +
      `&select=id,client_name,address,city,jn_job_id,signed_at,pa_id,pa_decision_resolved_at` +
      `&order=signed_at.desc.nullslast&limit=3000`
    );

    // 2. Check each one's CURRENT JN status.
    const nowMs = Date.now();
    const leaks = [];            // JN status is a cancel status → should be off the list
    const skippedReinstated = [];
    const missingJob = [];       // jn_job_id points to a JN job we can't read (deleted?)
    let checked = 0;

    for (let i = 0; i < active.length; i += CONC) {
      const batch = active.slice(i, i + CONC);
      await Promise.all(batch.map(async (r) => {
        const jn = await jnGet(`jobs/${encodeURIComponent(r.jn_job_id)}`);
        checked++;
        if (!jn || !(jn.jnid || jn.id)) { missingJob.push(brief(r, null)); return; }
        const status = String(jn.status_name || "").trim();
        if (!cancelStatuses.has(status.toLowerCase())) return; // still a valid inspection
        if (r.pa_decision_resolved_at) { skippedReinstated.push(brief(r, status)); return; } // manager override
        leaks.push({ ...brief(r, status), ageDays: ageDays(r.signed_at, nowMs) });
      }));
    }

    // 3. Cancel the leaks (mirrors inspection-checker's Lost patch).
    let cancelled = 0; const errors = [];
    if (apply) {
      for (let i = 0; i < leaks.length; i += CONC) {
        const batch = leaks.slice(i, i + CONC);
        const res = await Promise.all(batch.map((l) => patchCancel(l.id, l.jn_status)));
        res.forEach((ok, k) => { ok ? cancelled++ : errors.push(batch[k].client); });
      }
    }

    leaks.sort((a, b) => (a.ageDays - b.ageDays)); // freshest first — those are the ones an inspector may still visit
    return json(200, {
      ok: true,
      mode: apply ? "APPLIED" : "DRY RUN — nothing written",
      active_inspections: active.length,
      checked,
      leaks_found: leaks.length,
      cancelled,
      errors,
      skipped_reinstated: skippedReinstated.length,
      missing_jn_job: missingJob.length,
      leaks,
      missing_jn_job_list: missingJob.slice(0, 25),
    });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

function brief(r, status) {
  return {
    id: r.id,
    client: r.client_name || "—",
    address: [r.address, r.city].filter(Boolean).join(", "),
    jn_status: status,
    signed_at: r.signed_at || null,
    jn_url: `https://app.jobnimbus.com/job/${r.jn_job_id}`,
  };
}
function ageDays(iso, nowMs) {
  if (!iso) return 9999;
  return Math.round((nowMs - new Date(iso).getTime()) / 86400000);
}
async function patchCancel(id, status) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...sb, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        cancelled_at: new Date().toISOString(),
        cancel_reason: `JN status changed to ${status} (reconcile)`,
        jn_status: status,
      }),
    });
    return r.ok;
  } catch { return false; }
}
async function jnGet(path) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${JN_BASE}/${path}`, { headers: jnH });
      if (r.ok) return await r.json().catch(() => null);
      if (r.status < 500) return null;
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 300 * (a + 1)));
  }
  return null;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) };
}
