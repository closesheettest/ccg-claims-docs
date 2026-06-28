// netlify/functions/reinstate-inspection.js
//
// "Put back on the inspection list" — un-cancels an inspection a rep believes
// was cancelled by mistake. Clears cancelled_at / cancel_reason / lost_reason
// (and a 'lost' result), and REQUIRES a note explaining why, appended to
// pa_notes_log (and mirrored to JobNimbus as a note, best-effort).
//
// POST { token, inspection_id, note, rep_name? }  → { ok }
//
// Gate: token must equal app_settings.dialer_token OR visit_token.
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

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
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const inspectionId = String(body.inspection_id || "").trim();
  const note = String(body.note || "").trim();
  const repName = String(body.rep_name || "").trim() || "Rep";
  if (!inspectionId) return cors(400, JSON.stringify({ ok: false, error: "inspection_id required" }));
  if (!note) return cors(400, JSON.stringify({ ok: false, error: "A note is required to put it back on the inspection list." }));

  try {
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,jn_job_id,client_name,pa_notes_log,result,cancelled_at&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));

    const nowIso = new Date().toISOString();
    const log = Array.isArray(insp.pa_notes_log) ? insp.pa_notes_log : [];
    log.push({ at: nowIso, text: `↩️ Put back on inspection list by ${repName}: ${note}`, stage: null });

    const patch = {
      cancelled_at: null,
      cancel_reason: null,
      lost_reason: null,
      pa_notes_log: log,
    };
    if (String(insp.result || "").toLowerCase() === "lost") patch.result = null;  // back to "needs inspection"

    const up = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch),
    });
    if (!up.ok) return cors(500, JSON.stringify({ ok: false, error: `Save failed: ${(await up.text()).slice(0, 160)}` }));

    // Mirror to JobNimbus as a note (best-effort).
    if (insp.jn_job_id && JN_KEY) {
      fetch(`${JN_BASE}/activities`, {
        method: "POST", headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ record_type_name: "Note", note: `↩️ Put back on inspection list by ${repName}: ${note}`, primary: { id: insp.jn_job_id, type: "job" }, related: [{ id: insp.jn_job_id, type: "job" }], is_status_change: false }),
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
