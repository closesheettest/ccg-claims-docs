// netlify/functions/setter-book-appointment.js
//
// The appointment-setter portal's booking action. Creates the JobNimbus records
// for a RETAIL (US Shingle, not insurance) appointment from an inbound call:
//   1. CONTACT  (if a new homeowner — else use the matched contact_id)
//   2. JOB      record_type "Lead", status "Appointment Scheduled", location 1
//               (retail), source = lead source (Instant Quote / Facebook),
//               sales_rep + owner = the chosen qualified rep.
//   3. TASK     an "Appointment" on the job at the chosen time.
//   4. NOTE     "Appointment set by <setter>" so we know who booked it.
//
// If no rep was within range (rep_jobnimbus_id omitted), the job/task are owned
// by the SETTER (Viviana) for a manager to assign — out-of-radius handling.
//
//   POST { token, setter_name, appt_iso, source?, rep_jobnimbus_id?, rep_name?,
//          contact_id?, contact?:{first_name,last_name,email,mobile,address,city,state,zip},
//          test? }
//   → { ok, contact_id, job_id, task_id, assigned }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

const VIVIANA_ID = "m3n90ppl4smcf6nasr1jgje"; // Viviana De Toro — owns out-of-radius appts
const RETAIL_LOCATION = 1;
const APPT_STATUS = 531, APPT_STATUS_NAME = "Appointment Scheduled";
const LEAD_RT = 45, LEAD_RT_NAME = "Lead";
const APPT_TASK_RT = 17;
const SOURCES = new Set(["Instant Quote", "Facebook"]);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY || !JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const apptMs = Date.parse(body.appt_iso || "");
  if (!Number.isFinite(apptMs)) return cors(400, JSON.stringify({ ok: false, error: "appt_iso required" }));
  const source = SOURCES.has(body.source) ? body.source : "Instant Quote";
  const setter = String(body.setter_name || "Setter").trim();
  const repId = String(body.rep_jobnimbus_id || "").trim() || null;
  const repName = String(body.rep_name || "").trim();
  const owner = repId || VIVIANA_ID;
  const test = !!body.test;

  try {
    // 1. Contact — use the matched one, or create.
    let contactId = String(body.contact_id || "").trim();
    const c = body.contact || {};
    const fullName = `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Homeowner";
    if (!contactId) {
      const payload = {
        first_name: c.first_name || "", last_name: c.last_name || "",
        display_name: test ? `${fullName} [TEST-${apptMs}]` : fullName,
        email: c.email || "", mobile_phone: c.mobile || "",
        address_line1: c.address || "", city: (c.city || "").split(",")[0].trim(), state_text: c.state || "", zip: c.zip || "",
      };
      const cr = await jnPost("contacts", payload);
      contactId = cr.jnid || cr.id;
      if (!contactId) throw new Error("contact create failed");
    }

    // 2. Job — retail Lead, Appointment Scheduled.
    const job = await jnPost("jobs", {
      name: `${test ? "[TEST] " : ""}${fullName}${c.address ? ` - ${c.address}` : ""}`.trim(),
      record_type: LEAD_RT, record_type_name: LEAD_RT_NAME,
      status: APPT_STATUS, status_name: APPT_STATUS_NAME,
      primary: { id: contactId }, location: { id: RETAIL_LOCATION },
      source_name: source,
      address_line1: c.address || "", city: (c.city || "").split(",")[0].trim(), state_text: c.state || "", zip: c.zip || "",
      sales_rep: repId || undefined,
      owners: [{ id: owner }],
    });
    const jobId = job.jnid || job.id;
    if (!jobId) throw new Error("job create failed");

    // 3. Appointment task at the chosen time (2h).
    const startSec = Math.floor(apptMs / 1000);
    const task = await jnPost("tasks", {
      record_type: APPT_TASK_RT, record_type_name: "Appointment", type: "task",
      title: `Appointment — ${fullName}`,
      date_start: startSec, date_end: startSec + 7200,
      related: [{ id: jobId, type: "job" }], owners: [{ id: owner }],
    });

    // 4. Who-set-it note.
    await jnPost("activities", {
      record_type_name: "Note",
      note: `📞 Appointment set by ${setter} · source: ${source}${repId ? ` · rep: ${repName || repId}` : " · ⚠️ OUT OF RANGE — manager to assign a rep"}`,
      primary: { id: jobId, type: "job" }, related: [{ id: jobId, type: "job" }], is_status_change: false,
    }).catch(() => {});

    // 5. Out-of-range (no rep) — alert the admin so a manager assigns it in JN.
    if (!repId && !test && process.env.ADMIN_ALERT_PHONE) {
      const base = process.env.URL || "https://free-roof-inspections.netlify.app";
      const whenEt = new Date(apptMs).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
      await fetch(`${base}/.netlify/functions/ghl-sms`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: process.env.ADMIN_ALERT_PHONE, name: "Admin", message: `📞 Out-of-range retail appt set by ${setter} for ${fullName}${c.city ? ` (${c.city})` : ""} @ ${whenEt} — no rep within 50 mi. It's under Viviana in JN; assign a rep.` }),
      }).catch(() => {});
    }

    return cors(200, JSON.stringify({ ok: true, contact_id: contactId, job_id: jobId, task_id: task.jnid || task.id || null, assigned: repId ? (repName || "rep") : "Viviana (manager to assign)" }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function jnPost(path, payload) {
  const r = await fetch(`${JN_BASE}/${path}`, { method: "POST", headers: jnH, body: JSON.stringify(payload) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`JN ${path} ${r.status}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { return {}; }
}
async function okToken(token) { token = String(token || "").trim(); if (!token) return false; const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]); return (!!d && token === d) || (!!v && token === v); }
async function getSetting(key) { const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sb }); if (!r.ok) return null; const rows = await r.json().catch(() => []); return rows[0]?.value || null; }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
