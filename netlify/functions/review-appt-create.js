// netlify/functions/review-appt-create.js
//
// New-inspection "results review" appointment: at sign-up the rep books a time
// (~4 days out) to come back and go over the inspection findings. This creates
// a JobNimbus "Appointment" task (record_type 17) on the job AND stamps
// inspections.review_appt_at so the later Damage/No-Damage/Retail visit can
// surface "homeowner available: …".
//
// Open (no token) — it's part of the public signing flow, like jobnimbus-sync.
//
// POST { inspection_id, start_at_iso, rep_jobnimbus_id?, booked_by? }
//   → { ok, task_id }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

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
  const inspectionId = String(body.inspection_id || "").trim();
  const startIso = String(body.start_at_iso || "").trim();
  const repJnId = String(body.rep_jobnimbus_id || "").trim();
  const bookedBy = String(body.booked_by || "").trim() || "Rep";
  const startMs = Date.parse(startIso);
  if (!inspectionId || !startMs) return cors(400, JSON.stringify({ ok: false, error: "inspection_id and start_at_iso required" }));

  try {
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,client_name,jn_job_id&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));

    // Stamp the review time on the inspection regardless (so later visits can show it).
    await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify({ review_appt_at: new Date(startMs).toISOString() }),
    }).catch(() => {});

    let taskId = null;
    if (insp.jn_job_id) {
      const endMs = startMs + APPT_MIN * 60000;
      const r = await fetch(`${JN_BASE}/tasks`, {
        method: "POST", headers: jnH,
        body: JSON.stringify({
          record_type: 17, record_type_name: "Appointment", type: "task",
          title: `Results Review — ${insp.client_name || "homeowner"}`,
          date_start: Math.floor(startMs / 1000), date_end: Math.floor(endMs / 1000),
          related: [{ id: insp.jn_job_id, type: "job" }],
          ...(repJnId ? { owners: [{ id: repJnId }] } : {}),
        }),
      });
      const txt = await r.text();
      if (r.ok) { try { taskId = (JSON.parse(txt).jnid) || null; } catch { /* */ } }
      else return cors(200, JSON.stringify({ ok: true, task_id: null, warn: `review saved; JN task ${r.status}` }));
    }
    return cors(200, JSON.stringify({ ok: true, task_id: taskId }));
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
