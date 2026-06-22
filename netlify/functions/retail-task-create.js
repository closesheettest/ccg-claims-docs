// netlify/functions/retail-task-create.js
//
// Retail visit flow: the rep picks a fixed slot for a retail re-visit; this
// creates a JobNimbus APPOINTMENT task (record_type 17 = "Appointment") on the
// inspection's job at that date/time, and records a retail_appointments row
// (idempotent per inspection + start time).
//
// POST { token, inspection_id, start_at_iso, rep_jobnimbus_id?, booked_by? }
//   → { ok, task_id }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const APPT_MIN = 60; // retail appointment length

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
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,client_name,jn_job_id&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));
    if (!insp.jn_job_id) return cors(409, JSON.stringify({ ok: false, error: "This deal has no JobNimbus job yet." }));

    // Idempotency: same inspection + same start already booked?
    const dup = await sbGet(`retail_appointments?inspection_id=eq.${encodeURIComponent(inspectionId)}&start_at=eq.${encodeURIComponent(new Date(startMs).toISOString())}&select=jn_task_id&limit=1`);
    if (dup.length) return cors(200, JSON.stringify({ ok: true, task_id: dup[0].jn_task_id, already: true }));

    const endMs = startMs + APPT_MIN * 60000;
    const taskBody = {
      record_type: 17,
      record_type_name: "Appointment",
      type: "task",
      title: `Retail Appointment — ${insp.client_name || "homeowner"}`,
      date_start: Math.floor(startMs / 1000),
      date_end: Math.floor(endMs / 1000),
      related: [{ id: insp.jn_job_id, type: "job" }],
    };
    if (repJnId) taskBody.owners = [{ id: repJnId }];

    const r = await fetch(`${JN_BASE}/tasks`, { method: "POST", headers: jnH, body: JSON.stringify(taskBody) });
    const txt = await r.text();
    if (!r.ok) return cors(502, JSON.stringify({ ok: false, error: `JN task ${r.status}: ${txt.slice(0, 200)}` }));
    let task = {}; try { task = JSON.parse(txt); } catch { /* */ }
    const taskId = task.jnid || task.id || null;

    // Record it (best-effort).
    await fetch(`${SB_URL}/rest/v1/retail_appointments`, {
      method: "POST", headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify({
        inspection_id: inspectionId, jn_job_id: insp.jn_job_id, jn_task_id: taskId,
        start_at: new Date(startMs).toISOString(), end_at: new Date(endMs).toISOString(), booked_by: bookedBy,
      }),
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
  return token === d || token === v;
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
