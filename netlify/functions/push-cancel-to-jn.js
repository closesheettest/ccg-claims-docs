// netlify/functions/push-cancel-to-jn.js
//
// Mirrors the inspector "Lost" JN sync (inspector-submit-result.js) for
// the ADMIN "Cancel Record" path. When an admin cancels/marks a record
// Lost in the app with a reason, the browser can't call JobNimbus
// directly (no API key client-side), so it POSTs here and we:
//   1. PUT cf_string_34 = "Lost" on the linked JN job
//   2. POST a Note on the job with the cancellation reason
// Best-effort: the local cancel already succeeded before this is called,
// so a JN hiccup never blocks the admin action — we just report what
// landed.
//
// POST body: { inspectionId } (preferred) or { jnJobId } + { reason, by }.
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }
  const missing = [];
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "JOBNIMBUS_API_KEY"]) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) return json(500, { ok: false, error: `Missing env: ${missing.join(", ")}` });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }
  const inspectionId = (body.inspectionId || "").trim();
  let jnJobId = (body.jnJobId || "").trim();
  let reason = (body.reason || "").trim();
  const by = (body.by || "").trim();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

  // Resolve jn_job_id (and a reason fallback) from the inspection row.
  if (inspectionId && (!jnJobId || !reason)) {
    try {
      const r = await fetch(
        `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}&select=jn_job_id,cancel_reason,lost_reason&limit=1`,
        { headers: sbHeaders },
      );
      if (r.ok) {
        const row = (await r.json())?.[0];
        if (!jnJobId) jnJobId = (row?.jn_job_id || "").trim();
        if (!reason) reason = (row?.cancel_reason || row?.lost_reason || "").trim();
      }
    } catch { /* fall through to validation below */ }
  }

  if (!jnJobId) return json(400, { ok: false, error: "No jn_job_id — record isn't linked to a JN job, nothing to push" });
  if (!reason) reason = "Cancelled by admin";

  let jnResultUpdated = false;
  let jnNoteAdded = false;
  let jnError = null;

  try {
    const r = await fetch(`${JN_BASE}/jobs/${jnJobId}`, {
      method: "PUT",
      headers: jnHeaders,
      body: JSON.stringify({ jnid: jnJobId, cf_string_34: "Lost" }),
    });
    if (r.ok) jnResultUpdated = true;
    else jnError = `cf_string_34 PUT failed (${r.status}): ${(await r.text()).slice(0, 200)}`;
  } catch (e) {
    jnError = `cf_string_34 PUT exception: ${e.message}`;
  }

  const noteText = `🚫 Record marked LOST in app${by ? ` (by: ${by})` : ""}: ${reason}`;
  try {
    const r = await fetch(`${JN_BASE}/activities`, {
      method: "POST",
      headers: jnHeaders,
      body: JSON.stringify({
        record_type_name: "Note",
        note: noteText,
        primary: { id: jnJobId, type: "job" },
        related: [{ id: jnJobId, type: "job" }],
        is_status_change: false,
      }),
    });
    if (r.ok) jnNoteAdded = true;
    else jnError = (jnError ? jnError + "; " : "") + `note POST failed (${r.status}): ${(await r.text()).slice(0, 200)}`;
  } catch (e) {
    jnError = (jnError ? jnError + "; " : "") + `note POST exception: ${e.message}`;
  }

  return json(200, {
    ok: jnResultUpdated || jnNoteAdded,
    jn_job_id: jnJobId,
    jn_result_updated: jnResultUpdated,
    jn_note_added: jnNoteAdded,
    jn_error: jnError,
  });
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
