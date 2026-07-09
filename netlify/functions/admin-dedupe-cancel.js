// netlify/functions/admin-dedupe-cancel.js
//
// Cleanly cancel ONE redundant inspection record during de-duplication —
// Supabase-ONLY. It sets cancelled_at + cancel_reason and touches NOTHING in
// JobNimbus, because a duplicate often shares its JN job with the copy we KEEP
// (e.g. a re-submit minutes later that jobnimbus-sync linked to the same job).
// The normal cancel flow pushes the JN job to "Lost" — which would wrongly kill
// the kept deal. This one never does that.
//
// Reversible via reinstate-inspection.js (clears cancelled_at).
//
//   POST { inspection_id, reason? }   → { ok, client_name, jn_job_id, cancelled_at }
//   GET  ?inspection_id=<id>          → DRY: shows the record, writes nothing
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing env" }));

  const isGet = event.httpMethod === "GET";
  let inspectionId, reason;
  if (isGet) {
    inspectionId = String((event.queryStringParameters || {}).inspection_id || "").trim();
    reason = String((event.queryStringParameters || {}).reason || "").trim();
  } else {
    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
    inspectionId = String(body.inspection_id || "").trim();
    reason = String(body.reason || "").trim();
  }
  if (!inspectionId) return cors(400, JSON.stringify({ ok: false, error: "inspection_id required" }));

  try {
    const rec = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,client_name,address,zip,jn_job_id,result,cancelled_at&limit=1`))[0];
    if (!rec) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));
    if (rec.cancelled_at) return cors(200, JSON.stringify({ ok: true, already_cancelled: true, client_name: rec.client_name, cancelled_at: rec.cancelled_at }));

    if (isGet) {
      return cors(200, JSON.stringify({ ok: true, dry_run: true, record: rec, would_set: { cancel_reason: reason || "Duplicate record — deduped" } }));
    }

    const nowIso = new Date().toISOString();
    const r = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
      method: "PATCH",
      headers: { ...sb, Prefer: "return=representation" },
      body: JSON.stringify({ cancelled_at: nowIso, cancel_reason: reason || "Duplicate record — deduped" }),
    });
    if (!r.ok) return cors(500, JSON.stringify({ ok: false, error: `patch ${r.status}: ${(await r.text()).slice(0, 200)}` }));
    const saved = (await r.json().catch(() => []))[0] || {};
    return cors(200, JSON.stringify({ ok: true, client_name: rec.client_name, jn_job_id: rec.jn_job_id, cancelled_at: saved.cancelled_at || nowIso, note: "Supabase record cancelled; JobNimbus untouched." }));
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
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
