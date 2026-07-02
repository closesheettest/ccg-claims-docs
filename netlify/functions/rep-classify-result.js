// netlify/functions/rep-classify-result.js
//
// "Obvious damage at the door" — the rep finds clear damage/tarp during the
// free-inspection visit and classifies it on the spot (NO separate inspector
// visit, NO photos). This sets inspections.result and fires the SAME JobNimbus
// fan-out the inspector app does, minus the photo requirement:
//
//   result "damage"  (homeowner HAS insurance)
//       → cf_string_34 = "Damage" (+ Inspected Date/By) on the JN job
//       → generate + upload the inspection certificate
//       → send-to-pa-ops-hub  (the PA contacts them and shoots photos at the
//         PA appointment the rep books next)
//
//   result "retail"  (homeowner has NO insurance)
//       → process-retail-result  (cf_string_34 = "Retail" + record_type PA→Lead
//         + location Insurance→Retail + cert) — no photos needed, the rep sells
//         them a roof at the retail appointment they book next.
//
// POST { token, inspectionId, result: "damage"|"retail", inspectorName? }
//   → { ok, result, jn:{ cf, cert, paOps, retail } }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
import { jnFetch } from "./_jn.js";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const id = String(body.inspectionId || "").trim();
  const result = String(body.result || "").trim();
  const inspectorName = String(body.inspectorName || "").trim();
  if (!id || !["damage", "retail"].includes(result)) {
    return cors(400, JSON.stringify({ ok: false, error: "inspectionId + result (damage|retail) required" }));
  }
  const now = new Date().toISOString();

  try {
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(id)}&select=id,jn_job_id&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));

    // 1) Stamp the result in our DB (idempotent — the signing insert already set
    //    it; this guarantees result_at is stamped even if the insert didn't).
    await patch(id, { result, result_at: now });

    const base = process.env.URL || process.env.PUBLIC_SITE_URL || "";
    const jn = { cf: false, cert: false, paOps: false, retail: false };

    if (insp.jn_job_id && JN_KEY) {
      if (result === "damage") {
        // cf_string_34 = "Damage" (+ Inspected Date cf_date_22, Inspected By
        // cf_string_43) — same PUT the inspector app makes, so the PA portal
        // that reads the JN job shows the classification.
        const cfBody = { jnid: insp.jn_job_id, cf_string_34: "Damage", cf_date_22: Math.floor(Date.now() / 1000) };
        if (inspectorName) cfBody.cf_string_43 = inspectorName;
        try {
          const r = await jnFetch(JN_KEY, `jobs/${encodeURIComponent(insp.jn_job_id)}`, {
            method: "PUT",
            body: JSON.stringify(cfBody),
          });
          jn.cf = r.ok;
        } catch (e) { /* non-fatal */ }
        if (base) {
          // cert + PA Ops Hub PDN — fire-and-forget background jobs.
          fetch(`${base}/.netlify/functions/generate-and-upload-insp-report-background`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jnid: insp.jn_job_id }),
          }).catch(() => {});
          jn.cert = true;
          fetch(`${base}/.netlify/functions/send-to-pa-ops-hub`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inspectionId: id }),
          }).catch(() => {});
          jn.paOps = true;
        }
      } else {
        // retail → process-retail-result owns cf_string_34 = "Retail" + the
        // record_type/location swap + cert upload in one place.
        if (base) {
          fetch(`${base}/.netlify/functions/process-retail-result`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inspectionId: id }),
          }).catch(() => {});
          jn.retail = true;
        }
      }
    }

    return cors(200, JSON.stringify({ ok: true, result, jn }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function patch(id, fields) {
  const r = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(fields) });
  if (!r.ok) throw new Error(`save ${r.status}: ${(await r.text()).slice(0, 160)}`);
}
async function getSetting(key) { const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`); return rows[0] ? rows[0].value : null; }
async function okToken(token) { token = String(token || "").trim(); if (!token) return false; const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]); return token === d || token === v; }
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
