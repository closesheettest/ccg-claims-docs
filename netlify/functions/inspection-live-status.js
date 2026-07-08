// netlify/functions/inspection-live-status.js
//
// Real-time gate for the inspector app. Called the moment an inspector OPENS a
// job (InspectorJobDetail.load) so a cancellation that happened in the last few
// minutes — before the 5-min reconcile cron runs — is caught on the spot and
// the inspector is blocked instead of driving out to a dead property.
//
// Given an inspection id it checks, live:
//   • already cancelled_at in our DB      → { active:false, reason:"cancelled" }
//   • linked JN job status === "Lost"     → self-heals (stamps cancelled_at) and
//                                            returns { active:false, reason:"lost" }
//   • otherwise                           → { active:true, status }
//
//   GET /.netlify/functions/inspection-live-status?id=<inspectionId>
//
// Open-CORS (browser-called). Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL,
// VITE_SUPABASE_ANON_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const CANCEL_STATUSES = new Set(["lost"]); // what the office sets on a cancellation

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!JN_KEY || !SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing env" }));
  const id = String((event.queryStringParameters || {}).id || "").trim();
  if (!id) return cors(400, JSON.stringify({ ok: false, error: "id required" }));

  try {
    const rows = await sbGet(`inspections?id=eq.${encodeURIComponent(id)}&select=id,jn_job_id,cancelled_at,result,jn_status,client_name&limit=1`);
    const rec = rows[0];
    if (!rec) return cors(200, JSON.stringify({ ok: true, active: false, reason: "not_found" }));
    if (rec.cancelled_at) return cors(200, JSON.stringify({ ok: true, active: false, reason: "cancelled", status: rec.jn_status || null }));
    if (!rec.jn_job_id) return cors(200, JSON.stringify({ ok: true, active: true, status: null })); // no JN link to check

    const jn = await jnGet(`jobs/${encodeURIComponent(rec.jn_job_id)}`);
    const status = jn ? String(jn.status_name || "").trim() : null;
    if (status && CANCEL_STATUSES.has(status.toLowerCase())) {
      // Self-heal so it also drops off the pool immediately for everyone.
      await patchCancel(rec.id, status);
      return cors(200, JSON.stringify({ ok: true, active: false, reason: "lost", status }));
    }
    return cors(200, JSON.stringify({ ok: true, active: true, status }));
  } catch (e) {
    // Fail OPEN: a JN/Supabase blip must not block a legit inspection.
    return cors(200, JSON.stringify({ ok: true, active: true, status: null, soft_error: e.message || "error" }));
  }
};

async function patchCancel(id, status) {
  try {
    await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...sb, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        cancelled_at: new Date().toISOString(),
        cancel_reason: `JN status changed to ${status} (opened by inspector)`,
        jn_status: status,
      }),
    });
  } catch { /* best effort */ }
}
async function jnGet(path) {
  for (let a = 0; a < 2; a++) {
    try {
      const r = await fetch(`${JN_BASE}/${path}`, { headers: jnH });
      if (r.ok) return await r.json().catch(() => null);
      if (r.status < 500) return null;
    } catch { /* retry */ }
    await new Promise((res) => setTimeout(res, 250));
  }
  return null;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
    body,
  };
}
