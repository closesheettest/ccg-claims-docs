// netlify/functions/resolve-inspection-cancel.js
//
// The manager's decision from the cancel-review page (/?cancel_review=<id>):
//   decision: "cancel" → confirm the homeowner cancellation (cancel the deal)
//   decision: "retail" → it's actually a retail lead, not a cancel
// Either way clears cancel_review_pending and mirrors a Note to JobNimbus.
//
// POST { inspection_id, decision }  → { ok, decision }
//
// Open (manager reaches it via the texted link). Env: VITE_SUPABASE_*,
// JOBNIMBUS_API_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const inspectionId = String(body.inspection_id || "").trim();
  const decision = String(body.decision || "").trim();
  if (!inspectionId) return cors(400, JSON.stringify({ ok: false, error: "inspection_id required" }));
  if (!["cancel", "retail"].includes(decision)) return cors(400, JSON.stringify({ ok: false, error: "decision must be cancel | retail" }));

  try {
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,jn_job_id,client_name,cancel_review_note&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));
    const reviewNote = insp.cancel_review_note || "";
    const nowIso = new Date().toISOString();

    let patch, jnNote;
    if (decision === "cancel") {
      patch = {
        cancelled_at: nowIso,
        cancel_reason: `Homeowner cancelled (manager-confirmed): ${reviewNote}`,
        lost_reason: reviewNote,
        cancel_review_pending: false,
      };
      jnNote = `🚫 Homeowner cancellation CONFIRMED by manager. Reason: ${reviewNote}`;
    } else {
      patch = {
        result: "retail",
        result_at: nowIso,
        cancel_review_pending: false,
      };
      jnNote = `🏠 Manager review: not a cancel — sending to Retail. Inspector note: ${reviewNote}`;
    }

    const up = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch),
    });
    if (!up.ok) return cors(500, JSON.stringify({ ok: false, error: `Save failed: ${(await up.text()).slice(0, 160)}` }));

    if (insp.jn_job_id && JN_KEY) {
      fetch(`${JN_BASE}/activities`, {
        method: "POST", headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ record_type_name: "Note", note: jnNote, primary: { id: insp.jn_job_id, type: "job" }, related: [{ id: insp.jn_job_id, type: "job" }], is_status_change: false }),
      }).catch(() => {});
    }
    // Retail: run the normal retail processing (JN result + cert) best-effort.
    if (decision === "retail") {
      const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
      fetch(`${base}/.netlify/functions/process-retail-result`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inspectionId }),
      }).catch(() => {});
    }
    return cors(200, JSON.stringify({ ok: true, decision }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
