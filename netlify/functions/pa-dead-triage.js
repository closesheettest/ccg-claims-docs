// netlify/functions/pa-dead-triage.js
//
// U.S. Shingle admin triages a DEAD PA deal (pa_stage='dead') one of three ways:
//   release_to_rep — clear the PA off it (KEEP pa_notes_log) so it reappears in
//                    the sales rep's Damage visit list, with the PA's notes intact.
//   lost           — cancel the deal (out of every flow).
//   btr_ni         — set JN status "BTR - NI" + clear the PA (back to retail,
//                    not interested).
//
// POST { token, inspection_id, action } → { ok, action }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const NI_STATUS = "BTR - NI";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const id = String(body.inspection_id || "").trim();
  const action = String(body.action || "").trim();
  if (!id) return cors(400, JSON.stringify({ ok: false, error: "inspection_id required" }));
  const now = new Date().toISOString();

  try {
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(id)}&select=id,jn_job_id,pa_notes_log&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));

    if (action === "release_to_rep") {
      const log = Array.isArray(insp.pa_notes_log) ? insp.pa_notes_log : [];
      log.push({ at: now, text: "Released back to the sales rep by U.S. Shingle (was a dead PA deal).", stage: "released" });
      // Keep pa_notes_log so the rep sees the PA's history; clear the PA so the
      // deal reappears in that rep's Damage visit list.
      await patch(id, { pa_id: null, pa_company_id: null, pa_claimed_at: null, pa_stage: null, pa_stage_at: now, pa_decision_needed: false, pa_notes_log: log });
      return cors(200, JSON.stringify({ ok: true, action }));
    }
    if (action === "lost") {
      await patch(id, { cancelled_at: now, cancel_reason: "Lost — dead PA deal (admin)" });
      return cors(200, JSON.stringify({ ok: true, action }));
    }
    if (action === "btr_ni") {
      let jnSet = false;
      if (insp.jn_job_id && JN_KEY) {
        const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(insp.jn_job_id)}`, {
          method: "PUT", headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ status_name: NI_STATUS }),
        });
        jnSet = r.ok;
      }
      await patch(id, { jn_status: NI_STATUS, pa_id: null, pa_company_id: null, pa_claimed_at: null, pa_stage: null, pa_stage_at: now });
      return cors(200, JSON.stringify({ ok: true, action, jn_set: jnSet }));
    }
    return cors(400, JSON.stringify({ ok: false, error: "unknown action" }));
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
