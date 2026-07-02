// netlify/functions/retail-outcome-set.js
//
// Rep records the outcome of a Retail visit (sit sold / sit no-sale / not
// interested). This sets inspections.retail_outcome (which drops the deal off
// the active Retail visit list — the row is KEPT for historical reports), and
// pushes the matching status to JobNimbus.
//
// POST { token, inspection_id, outcome: "sold"|"no_sale"|"ni", rep_name? }
//   → { ok }
//
// Gate: visit_token / dialer_token. Env: VITE_SUPABASE_*, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
import { jnFetch } from "./_jn.js";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

// outcome → JN status_name + a friendly label.
const OUT = {
  sold:    { status: "Sit Sold",      label: "Sit Sold" },
  no_sale: { status: "Sit - No Sale", label: "Sit - No Sale" },
  ni:      { status: "BTR - NI",      label: "Not Interested" },
};

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const inspectionId = String(body.inspection_id || "").trim();
  const outcome = String(body.outcome || "").trim();
  const repName = String(body.rep_name || "").trim() || "Rep";
  if (!inspectionId || !OUT[outcome]) return cors(400, JSON.stringify({ ok: false, error: "inspection_id + outcome (sold|no_sale|ni) required" }));

  try {
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,jn_job_id,pa_notes_log&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));
    const nowIso = new Date().toISOString();
    const log = Array.isArray(insp.pa_notes_log) ? insp.pa_notes_log : [];
    log.push({ at: nowIso, text: `🏠 Retail outcome by ${repName}: ${OUT[outcome].label}`, stage: null });

    const up = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify({ retail_outcome: outcome, retail_outcome_at: nowIso, retail_outcome_by: repName, pa_notes_log: log }),
    });
    if (!up.ok) return cors(500, JSON.stringify({ ok: false, error: `Save failed: ${(await up.text()).slice(0, 160)}` }));

    // Push the matching status to JobNimbus + a note (best-effort).
    if (insp.jn_job_id && JN_KEY) {
      jnFetch(JN_KEY, `jobs/${insp.jn_job_id}`, { method: "PUT", body: JSON.stringify({ status_name: OUT[outcome].status }) }).catch(() => {});
      jnFetch(JN_KEY, `activities`, {
        method: "POST",
        body: JSON.stringify({ record_type_name: "Note", note: `🏠 Retail outcome (${repName}): ${OUT[outcome].label}`, primary: { id: insp.jn_job_id, type: "job" }, related: [{ id: insp.jn_job_id, type: "job" }], is_status_change: false }),
      }).catch(() => {});
    }
    return cors(200, JSON.stringify({ ok: true }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function okToken(token) {
  token = String(token || "").trim();
  if (!token) return false;
  const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]);
  return (!!d && token === d) || (!!v && token === v);
}
async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0]?.value || null;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
