// netlify/functions/damage-to-retail.js
//
// Rep is on a Damage visit and decides to go RETAIL at the door. This:
//   1. Flips the inspection to result = "retail" (and pulls it out of the PA
//      pool), with a note.
//   2. Fires process-retail-result → JobNimbus cf_string_34 = "Retail",
//      status + retail location swap + cert (best-effort).
//   3. Books the retail appointment — JN Appointment task (record_type 17) on
//      the job + a retail_appointments row.
//
// POST { token, inspection_id, start_at_iso, rep_jobnimbus_id?, booked_by? }
//   → { ok, task_id }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const APPT_MIN = 60;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY || !JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const inspectionId = String(body.inspection_id || "").trim();
  const startIso = String(body.start_at_iso || "").trim();
  const repJnId = String(body.rep_jobnimbus_id || "").trim();
  const bookedBy = String(body.booked_by || "").trim() || "Rep";
  const startMs = Date.parse(startIso);
  if (!inspectionId || !startMs) return cors(400, JSON.stringify({ ok: false, error: "inspection_id and start_at_iso required" }));

  try {
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,client_name,jn_job_id,pa_notes_log&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));
    if (!insp.jn_job_id) return cors(409, JSON.stringify({ ok: false, error: "This deal has no JobNimbus job yet." }));
    const nowIso = new Date().toISOString();

    // 1. Flip to retail + leave the PA pool + note.
    const log = Array.isArray(insp.pa_notes_log) ? insp.pa_notes_log : [];
    log.push({ at: nowIso, text: `🏠 ${bookedBy} converted Damage → Retail at the door.`, stage: null });
    const up = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify({ result: "retail", result_at: nowIso, pa_id: null, pa_stage: null, pa_notes_log: log }),
    });
    if (!up.ok) return cors(500, JSON.stringify({ ok: false, error: `Save failed: ${(await up.text()).slice(0, 160)}` }));

    // 2. JN retail processing (cf_string_34=Retail, status, location, cert) — best-effort.
    const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
    try {
      await fetch(`${base}/.netlify/functions/process-retail-result`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inspectionId }),
      });
    } catch { /* best-effort */ }

    // 3. Book the retail appointment (idempotent on inspection + start).
    const startAtIso = new Date(startMs).toISOString();
    const dup = await sbGet(`retail_appointments?inspection_id=eq.${encodeURIComponent(inspectionId)}&start_at=eq.${encodeURIComponent(startAtIso)}&select=jn_task_id&limit=1`);
    if (dup.length) return cors(200, JSON.stringify({ ok: true, task_id: dup[0].jn_task_id, already: true }));

    const endMs = startMs + APPT_MIN * 60000;
    const taskBody = {
      record_type: 17, record_type_name: "Appointment", type: "task",
      title: `Retail Appointment — ${insp.client_name || "homeowner"}`,
      date_start: Math.floor(startMs / 1000), date_end: Math.floor(endMs / 1000),
      related: [{ id: insp.jn_job_id, type: "job" }],
      ...(repJnId ? { owners: [{ id: repJnId }] } : {}),
    };
    const r = await fetch(`${JN_BASE}/tasks`, { method: "POST", headers: jnH, body: JSON.stringify(taskBody) });
    const txt = await r.text();
    if (!r.ok) return cors(502, JSON.stringify({ ok: false, error: `JN task ${r.status}: ${txt.slice(0, 160)}`, retail_set: true }));
    let task = {}; try { task = JSON.parse(txt); } catch { /* */ }
    const taskId = task.jnid || task.id || null;

    await fetch(`${SB_URL}/rest/v1/retail_appointments`, {
      method: "POST", headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify({ inspection_id: inspectionId, jn_job_id: insp.jn_job_id, jn_task_id: taskId, start_at: startAtIso, end_at: new Date(endMs).toISOString(), booked_by: bookedBy }),
    }).catch(() => {});

    return cors(200, JSON.stringify({ ok: true, task_id: taskId }));
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
