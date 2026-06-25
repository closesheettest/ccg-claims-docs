// netlify/functions/retail-not-interested.js
//
// Rep marks a back-to-retail homeowner "Not Interested" from the Retail visit
// screen. Sets the JN job status to "BTR - NI" (Back To Retail – Not Interested),
// automating the manual step reps used to do in JN, and stamps
// inspections.jn_status so the rep's retail list drops it right away. These show
// in the back-to-retail report's "Not Interested" section, excluded from
// conversions (zone-back-to-retail / zone-retail-conversions).
//
// POST { token, inspection_id } → { ok, jn_status, jn_set }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const NI_STATUS = "BTR - NI";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY || !JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const inspectionId = String(body.inspection_id || "").trim();
  if (!inspectionId) return cors(400, JSON.stringify({ ok: false, error: "inspection_id required" }));

  try {
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,jn_job_id&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));

    // 1. Set the JN job status to "BTR - NI" (the source of truth the reports read).
    let jnSet = false;
    if (insp.jn_job_id) {
      const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(insp.jn_job_id)}`, {
        method: "PUT", headers: jnH, body: JSON.stringify({ status_name: NI_STATUS }),
      });
      if (!r.ok) return cors(502, JSON.stringify({ ok: false, error: `JN status ${r.status}: ${(await r.text()).slice(0, 180)}` }));
      jnSet = true;
    }

    // 2. Stamp it locally so the rep's retail list drops it immediately (even if
    //    the JN→app status sync lags).
    await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify({ jn_status: NI_STATUS }),
    }).catch(() => {});

    return cors(200, JSON.stringify({ ok: true, jn_status: NI_STATUS, jn_set: jnSet }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0] ? rows[0].value : null;
}
async function okToken(token) {
  token = String(token || "").trim();
  if (!token) return false;
  const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]);
  return token === d || token === v;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
