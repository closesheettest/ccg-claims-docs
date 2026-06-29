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
const APPT_TASK_RT = 4; // 4 = "Initial Appointment" (matches the rest of the JN calendar)
// Retail lead sources accepted from the setter (insurance sources NEED / INS /
// Raw Insurance are intentionally not offered). Default → "Instant Quote".
const SOURCES = new Set(["Instant Quote", "Facebook", "AI Bot", "Harvesting", "Self Generated", "IHFB", "Referral", "Yard Sign", "Web Search"]);

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
  const test = !!body.test;
  const lat = Number(body.lat), lng = Number(body.lng);

  // Pick the rep server-side — the least-loaded qualified rep free at this exact
  // slot (round-robin). The setter never chooses one. Out of range / no free rep
  // → owned by Viviana for a manager to assign.
  let repId = null, repName = "";
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const pick = await pickRep(body.token, lat, lng, body.county, body.appt_iso);
    repId = pick.id; repName = pick.name;
  } else if (body.rep_jobnimbus_id) { // legacy: explicit rep
    repId = String(body.rep_jobnimbus_id).trim(); repName = String(body.rep_name || "").trim();
  }
  const owner = repId || VIVIANA_ID;

  let c = body.contact || {};
  let contactId = String(body.contact_id || "").trim();
  let jnOk = true, jnErr = "", jobId = null, taskId = null;

  // ── JobNimbus writes (best-effort) ──────────────────────────────────────
  // If any JN step fails we DON'T lose the booking — we still log it locally
  // below so the setter keeps a reference and a manager can repair JN.
  try {
    // 1. Contact — existing (pull its name/address so the job is named/findable) or create.
    if (contactId) {
      try {
        const got = await jnGet(`contacts/${contactId}`);
        if (got && (got.jnid || got.id)) c = { first_name: got.first_name || "", last_name: got.last_name || "", mobile: got.mobile_phone || c.mobile, address: got.address_line1 || "", city: got.city || "", state: got.state_text || got.state || "", zip: got.zip || "" };
      } catch { /* fall back to whatever was passed */ }
    }
    const fullName = nameOf(c, body);
    if (!contactId) {
      const cr = await jnPost("contacts", {
        first_name: c.first_name || "", last_name: c.last_name || "",
        display_name: test ? `${fullName} [TEST-${apptMs}]` : fullName,
        email: c.email || "", mobile_phone: c.mobile || "",
        address_line1: c.address || "", city: (c.city || "").split(",")[0].trim(), state_text: c.state || "", zip: c.zip || "",
      });
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
    jobId = job.jnid || job.id;
    if (!jobId) throw new Error("job create failed");
    // 3. Appointment task (start only — no end date).
    const task = await jnPost("tasks", {
      record_type: APPT_TASK_RT, record_type_name: "Initial Appointment", type: "task",
      title: `Initial Appointment — ${fullName}`,
      date_start: Math.floor(apptMs / 1000), date_end: 0,
      related: [{ id: jobId, type: "job" }], owners: [{ id: owner }],
    });
    taskId = task.jnid || task.id || null;
    // 4. Who-set-it note.
    await jnPost("activities", {
      record_type_name: "Note",
      note: `📞 Appointment set by ${setter} · source: ${source}${repId ? ` · rep: ${repName || repId}` : " · ⚠️ OUT OF RANGE — manager to assign a rep"}`,
      primary: { id: jobId, type: "job" }, related: [{ id: jobId, type: "job" }], is_status_change: false,
    }).catch(() => {});
  } catch (e) {
    jnOk = false; jnErr = e.message || "JobNimbus error";
  }

  // ── Always log the booking locally — the setter's reference point ────────
  const homeowner = nameOf(c, body);
  const address = body.address || [c.address, c.city, c.state, c.zip].filter(Boolean).join(", ") || null;
  if (!test) {
    await sbInsert("setter_appointments", {
      setter_name: setter, homeowner_name: homeowner, phone: c.mobile || body.phone || null, address,
      appt_at: new Date(apptMs).toISOString(), source, rep_name: repName || null, rep_jobnimbus_id: repId || null,
      jn_contact_id: contactId || null, jn_job_id: jobId, jn_task_id: taskId, out_of_range: !repId, jn_synced: jnOk,
    }).catch(() => {});
  }

  // Out-of-range (no rep) — alert the admin so a manager assigns it in JN.
  if (!repId && !test && jnOk && process.env.ADMIN_ALERT_PHONE) {
    const base = process.env.URL || "https://free-roof-inspections.netlify.app";
    const whenEt = new Date(apptMs).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
    await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: process.env.ADMIN_ALERT_PHONE, name: "Admin", message: `📞 Out-of-range retail appt set by ${setter} for ${homeowner}${c.city ? ` (${c.city})` : ""} @ ${whenEt} — no rep within 50 mi. It's under Viviana in JN; assign a rep.` }),
    }).catch(() => {});
  }

  return cors(200, JSON.stringify({ ok: true, jn_ok: jnOk, jn_error: jnOk ? undefined : jnErr, out_of_range: !repId, contact_id: contactId || null, job_id: jobId, task_id: taskId, assigned: repId ? (repName || "rep") : "Viviana (manager to assign)" }));
};

function nameOf(c, body) { return (`${c.first_name || ""} ${c.last_name || ""}`).trim() || String(body.homeowner_name || "").trim() || "Homeowner"; }

// Round-robin rep pick: ask setter-availability for the slot's free reps, take
// the least-loaded. Returns {id:null} when out of range / slot no longer free.
async function pickRep(token, lat, lng, county, iso) {
  try {
    const base = process.env.URL || "https://free-roof-inspections.netlify.app";
    const r = await fetch(`${base}/.netlify/functions/setter-availability`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, lat, lng, county, days: 21 }) });
    const av = await r.json();
    if (av && av.ok && !av.out_of_radius) {
      for (const d of (av.days || [])) for (const s of (d.slots || [])) {
        if (s.iso === iso && (s.reps || []).length) {
          const free = s.reps.slice().sort((a, b) => a.load - b.load);
          return { id: free[0].id, name: free[0].name };
        }
      }
    }
  } catch { /* fall through to setter-owned */ }
  return { id: null, name: "" };
}

async function sbInsert(table, row) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, { method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`SB insert ${table} ${r.status}: ${(await r.text()).slice(0, 150)}`);
}
async function jnGet(path) {
  const r = await fetch(`${JN_BASE}/${path}`, { headers: jnH });
  if (!r.ok) throw new Error(`JN GET ${path} ${r.status}`);
  return r.json();
}
async function jnPost(path, payload) {
  const r = await fetch(`${JN_BASE}/${path}`, { method: "POST", headers: jnH, body: JSON.stringify(payload) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`JN ${path} ${r.status}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { return {}; }
}
async function okToken(token) { token = String(token || "").trim(); if (!token) return false; const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]); return (!!d && token === d) || (!!v && token === v); }
async function getSetting(key) { const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sb }); if (!r.ok) return null; const rows = await r.json().catch(() => []); return rows[0]?.value || null; }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
