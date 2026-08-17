// netlify/functions/damage-to-retail.js
//
// Rep is on a Damage visit and decides to go RETAIL at the door.
//
// TWO CASES, and they are not the same thing:
//
//   A) NO PA engaged yet — they're not going the insurance route at all. As
//      before: flip the inspection to result="retail", leave the PA pool, fire
//      process-retail-result (JN cf_string_34="Retail", status + retail location
//      swap + cert), and book the retail appointment on the existing job.
//
//   B) A PA IS engaged and working the claim ("Sit Sold PA" / waiting on docs).
//      Selling the roof retail does NOT fire the PA — the homeowner still wants
//      the adjuster to go. So the homeowner ends up with TWO jobs on purpose:
//        • the existing INSURANCE job (location 3) — untouched, still the PA's
//        • a new RETAIL job (location 1) — the sale, carrying the appointment
//      Both get the same JN note explaining it isn't a duplicate. The inspection
//      row stays result="damage" so the claim keeps showing on the PA's board
//      (that view reads result=eq.damage), tagged retail_outcome.
//
// POST { token, inspection_id, start_at_iso, rep_jobnimbus_id?, booked_by? }
//   → { ok, task_id, pa_stays, retail_job_id }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const APPT_MIN = 60;
// For the second (retail) job when a PA is staying on the insurance claim.
const RETAIL_LOCATION = 1;
const APPT_STATUS = 531, APPT_STATUS_NAME = "Appointment Scheduled";
const LEAD_RT = 45, LEAD_RT_NAME = "Lead";

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
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspectionId)}&select=id,client_name,address,city,state,zip,jn_job_id,pa_notes_log,pa_id,pa_stage&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));
    if (!insp.jn_job_id) return cors(409, JSON.stringify({ ok: false, error: "This deal has no JobNimbus job yet." }));
    const nowIso = new Date().toISOString();

    // 1. Flip to retail + note.
    //
    // EXCEPT when a PA is already engaged and working the claim ("Sit Sold PA" /
    // waiting on docs). Selling the roof retail does NOT fire the PA — the
    // homeowner still wants the adjuster to go, and the PA keeps going forward.
    // The old code nulled pa_id/pa_stage AND flipped result to "retail", which
    // both detached the PA and — because the PA portal reads result=eq.damage —
    // wiped the claim off their board mid-claim. So here the deal STAYS a damage
    // claim; the retail sale is recorded as an appointment + a note on top of it.
    // (No PA engaged = the original meaning: they're not going insurance at all,
    // so it converts to retail and leaves the pool.)
    const paEngaged = !!insp.pa_id || ["active", "waiting_docs", "signed"].includes(insp.pa_stage || "");
    const log = Array.isArray(insp.pa_notes_log) ? insp.pa_notes_log : [];
    log.push({
      at: nowIso, stage: paEngaged ? (insp.pa_stage || null) : null,
      text: paEngaged
        ? `🏠 ${bookedBy} sold this RETAIL at the door. The PA stays on it — the homeowner still wants the adjuster to go.`
        : `🏠 ${bookedBy} converted Damage → Retail at the door.`,
    });
    const patch = paEngaged
      ? { pa_notes_log: log, retail_outcome: "sold_retail_pa_continues", retail_outcome_at: nowIso, retail_outcome_by: bookedBy }
      : { result: "retail", result_at: nowIso, pa_id: null, pa_stage: null, pa_notes_log: log };
    const up = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    });
    if (!up.ok) return cors(500, JSON.stringify({ ok: false, error: `Save failed: ${(await up.text()).slice(0, 160)}` }));

    // 2. JN retail processing (cf_string_34=Retail, status, location, cert) — best-effort.
    //    Skipped when the PA is staying on it: that swaps the job to the retail
    //    location and off its PA status, which would strand the live claim.
    if (!paEngaged) {
      const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
      try {
        await fetch(`${base}/.netlify/functions/process-retail-result`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inspectionId }),
        });
      } catch { /* best-effort */ }
    }

    // 3. Book the retail appointment (idempotent on inspection + start).
    const startAtIso = new Date(startMs).toISOString();
    const dup = await sbGet(`retail_appointments?inspection_id=eq.${encodeURIComponent(inspectionId)}&start_at=eq.${encodeURIComponent(startAtIso)}&select=jn_task_id&limit=1`);
    if (dup.length) return cors(200, JSON.stringify({ ok: true, task_id: dup[0].jn_task_id, already: true, pa_stays: paEngaged }));

    // TWO JOBS, one homeowner. When the PA is staying on the claim, the retail
    // sale gets its OWN job (location 1, Retail) on the same contact — the
    // insurance job (location 3) stays exactly as it is, still the PA's. Putting
    // a retail status on an insurance-workflow job is what JN rejects, and it's
    // what used to strand the claim. Same rule the map's BTR booking follows.
    let apptJobId = insp.jn_job_id;
    if (paEngaged) {
      const retailJobId = await createRetailJob(insp, repJnId, startMs).catch((e) => {
        console.warn("BTRPA retail job create failed:", e.message);
        return null;
      });
      // No retail job = don't touch the insurance job. Better to fail loudly than
      // to hang a retail appointment on the PA's claim.
      if (!retailJobId) return cors(502, JSON.stringify({ ok: false, error: "Couldn't create the retail job in JobNimbus — nothing was changed on the PA's claim. Try again." }));
      apptJobId = retailJobId;

      // The SAME note on BOTH jobs. Two jobs on one homeowner looks like a
      // mistake to anyone who lands on either one — this says out loud that it
      // isn't: the PA is working the claim, we sold the roof retail.
      const whenStr = new Date(startMs).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      const note =
        `🤝 NOT A DUPLICATE — this homeowner has two jobs on purpose. ${bookedBy} sold the roof RETAIL ` +
        `(retail appointment ${whenStr} ET) and the public adjuster is STILL WORKING the insurance claim; ` +
        `the homeowner wants the adjuster to go. Retail job = the sale. Insurance job = the PA's claim. ` +
        `Leave both open.`;
      for (const id of [retailJobId, insp.jn_job_id]) {
        await fetch(`${JN_BASE}/activities`, {
          method: "POST", headers: jnH,
          body: JSON.stringify({ record_type_name: "Note", note, primary: { id, type: "job" }, related: [{ id, type: "job" }], is_status_change: false }),
        }).catch(() => { /* best-effort — the note is context, not the booking */ });
      }
    }

    const endMs = startMs + APPT_MIN * 60000;
    const taskBody = {
      record_type: 17, record_type_name: "Appointment", type: "task",
      title: `Retail Appointment — ${insp.client_name || "homeowner"}`,
      date_start: Math.floor(startMs / 1000), date_end: Math.floor(endMs / 1000),
      related: [{ id: apptJobId, type: "job" }],
      ...(repJnId ? { owners: [{ id: repJnId }] } : {}),
    };
    const r = await fetch(`${JN_BASE}/tasks`, { method: "POST", headers: jnH, body: JSON.stringify(taskBody) });
    const txt = await r.text();
    if (!r.ok) return cors(502, JSON.stringify({ ok: false, error: `JN task ${r.status}: ${txt.slice(0, 160)}`, retail_set: true }));
    let task = {}; try { task = JSON.parse(txt); } catch { /* */ }
    const taskId = task.jnid || task.id || null;

    await fetch(`${SB_URL}/rest/v1/retail_appointments`, {
      method: "POST", headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify({ inspection_id: inspectionId, jn_job_id: apptJobId, jn_task_id: taskId, start_at: startAtIso, end_at: new Date(endMs).toISOString(), booked_by: bookedBy }),
    }).catch(() => {});

    return cors(200, JSON.stringify({ ok: true, task_id: taskId, pa_stays: paEngaged, retail_job_id: paEngaged ? apptJobId : null }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// A SEPARATE retail job (location 1) on the same homeowner contact as the
// insurance job. Used when a PA is mid-claim: they keep the insurance job, we
// sell the roof on this one. Returns the new job's id, or null.
async function createRetailJob(insp, repJnId, startMs) {
  // Contact comes off the existing insurance job — same homeowner, two jobs.
  const jr = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(insp.jn_job_id)}`, { headers: jnH });
  if (!jr.ok) throw new Error(`JN job read ${jr.status}`);
  const job = await jr.json().catch(() => ({}));
  const contactId = job?.primary?.id || null;
  if (!contactId) throw new Error("no contact on the insurance job");

  const street = insp.address || job.address_line1 || "";
  const payload = {
    name: `${insp.client_name || "Homeowner"}${street ? ` - ${street}` : ""} (Retail)`.trim(),
    record_type: LEAD_RT, record_type_name: LEAD_RT_NAME,
    status: APPT_STATUS, status_name: APPT_STATUS_NAME,
    primary: { id: contactId }, location: { id: RETAIL_LOCATION },
    source_name: "Inspection",
    date_start: Math.floor(startMs / 1000),
    address_line1: street, city: insp.city || job.city || "", state_text: insp.state || job.state_text || "", zip: insp.zip || job.zip || "",
    ...(repJnId ? { owners: [{ id: repJnId }], sales_rep: repJnId } : {}),
  };
  const r = await fetch(`${JN_BASE}/jobs`, { method: "POST", headers: jnH, body: JSON.stringify(payload) });
  const txt = await r.text();
  if (!r.ok) {
    // JN rejects duplicate job NAMES — retry once with a unique suffix rather
    // than falling back to the insurance job.
    if (!/duplicate/i.test(txt)) throw new Error(`JN job ${r.status}: ${txt.slice(0, 160)}`);
    const r2 = await fetch(`${JN_BASE}/jobs`, {
      method: "POST", headers: jnH,
      body: JSON.stringify({ ...payload, name: `${payload.name} ${String(Math.floor(startMs / 1000)).slice(-4)}` }),
    });
    const t2 = await r2.text();
    if (!r2.ok) throw new Error(`JN job ${r2.status}: ${t2.slice(0, 160)}`);
    const j2 = JSON.parse(t2 || "{}");
    return j2.jnid || j2.id || null;
  }
  const j = JSON.parse(txt || "{}");
  return j.jnid || j.id || null;
}

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
