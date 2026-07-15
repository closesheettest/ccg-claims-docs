// netlify/functions/harvest-book-appt.js
//
// Book a RETAIL appointment from a Harvesting-Map pin and push it to JobNimbus:
//   1. CONTACT (find by phone/name, else create) with the phone/email the rep
//      entered on the pin.
//   2. JOB  record_type "Lead", status "Appointment Scheduled", retail location,
//      source "Harvesting", start date = appointment date, owner = the rep who
//      booked it (sales rep + assigned-to).
//   3. TASK an "Initial Appointment" on the job at the chosen time, owned by rep.
// Then flips the pin to 'appt' and stamps jn_job_id. Reps only — the rep is
// resolved from their personal token (rt).
//
//   POST { rt, pin_id, appt_iso, phone, email }
//   → { ok, job_id, contact_id }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY

import { jnFetch } from "./_jn.js";

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const RETAIL_LOCATION = 1;
const APPT_STATUS = 531, APPT_STATUS_NAME = "Appointment Scheduled";
const LEAD_RT = 45, LEAD_RT_NAME = "Lead";
const APPT_TASK_RT = 4; // "Initial Appointment"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!SB_URL || !SB_KEY || !JN_KEY) return json(500, { ok: false, error: "env missing" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }

  const rt = String(body.rt || "").trim();
  const pinId = String(body.pin_id || "").trim();
  const apptIso = String(body.appt_iso || "").trim();
  const phone = String(body.phone || "").trim();
  const email = String(body.email || "").trim();
  if (!UUID.test(rt)) return json(401, { ok: false, error: "Invalid link" });
  if (!pinId || !apptIso) return json(400, { ok: false, error: "pin_id and appt_iso required" });
  const apptMs = Date.parse(apptIso);
  if (!apptMs) return json(400, { ok: false, error: "bad appt time" });
  const apptSec = Math.floor(apptMs / 1000);

  // Resolve the booking rep + the pin.
  const rep = (await sbGet(`sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=name,jobnimbus_id&limit=1`))[0];
  if (!rep) return json(401, { ok: false, error: "Invalid link" });
  const pin = (await sbGet(`canvass_prospects?id=eq.${encodeURIComponent(pinId)}&select=name,address,city,state,zip,status&limit=1`))[0];
  if (!pin) return json(404, { ok: false, error: "pin not found" });

  const nm = (pin.name || "").trim() || "Homeowner";
  const parts = nm.split(/\s+/).filter(Boolean);
  const first = parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] || "");
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  const street = (pin.address || "").split(",")[0].trim();
  const owner = rep.jobnimbus_id || undefined;

  try {
    let contactId = await findExistingContact(phone, nm);
    if (!contactId) {
      const c = { first_name: first, last_name: last, display_name: nm, mobile_phone: phone || "", email: email || "", address_line1: street, city: pin.city || "", state_text: pin.state || "", zip: pin.zip || "" };
      try {
        const cr = await jnPost("contacts", c);
        contactId = cr.jnid || cr.id;
      } catch (e) {
        if (!/duplicate/i.test(e.message || "")) throw e;
        const suffix = phone.replace(/\D/g, "").slice(-4) || String(apptSec).slice(-4);
        const cr2 = await jnPost("contacts", { ...c, display_name: `${nm} (${suffix})` });
        contactId = cr2.jnid || cr2.id;
      }
    }
    if (!contactId) throw new Error("contact create failed");

    const job = await jnPost("jobs", {
      name: `${nm}${street ? ` - ${street}` : ""}`.trim(),
      record_type: LEAD_RT, record_type_name: LEAD_RT_NAME,
      status: APPT_STATUS, status_name: APPT_STATUS_NAME,
      primary: { id: contactId }, location: { id: RETAIL_LOCATION },
      source_name: "Harvesting",
      date_start: apptSec, // Start Date = appointment date
      address_line1: street, city: pin.city || "", state_text: pin.state || "", zip: pin.zip || "",
      ...(owner ? { owners: [{ id: owner }] } : {}),
    });
    const jobId = job.jnid || job.id;
    if (!jobId) throw new Error("job create failed");

    const task = await jnPost("tasks", {
      record_type: APPT_TASK_RT, record_type_name: "Initial Appointment", type: "task",
      title: `Initial Appointment — ${nm}`, date_start: apptSec, date_end: 0,
      related: [{ id: jobId, type: "job" }], ...(owner ? { owners: [{ id: owner }] } : {}),
    });
    const taskId = task.jnid || task.id || null;

    await jnPost("activities", {
      record_type_name: "Note",
      note: `📍 Harvesting appointment booked by ${rep.name || "rep"} for ${new Date(apptMs).toLocaleString("en-US", { timeZone: "America/New_York" })}${phone ? ` · ${phone}` : ""}${email ? ` · ${email}` : ""}`,
      primary: { id: jobId, type: "job" }, related: [{ id: jobId, type: "job" }], is_status_change: false,
    }).catch(() => {});

    // Flip the pin to Appt.
    const nowIso = new Date().toISOString();
    const log = Array.isArray(pin.status_log) ? [...pin.status_log] : [];
    log.push({ at: nowIso, from: pin.status, to: "appt", by: rep.name || "rep", appt_at: apptIso, jn_job_id: jobId });
    await fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${encodeURIComponent(pinId)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify({ status: "appt", status_updated_at: nowIso, status_by: rep.name || null, jn_job_id: jobId, status_log: log }),
    }).catch(() => {});

    return json(200, { ok: true, job_id: jobId, contact_id: contactId, task_id: taskId });
  } catch (e) {
    return json(502, { ok: false, error: `JobNimbus: ${e.message || "failed"}` });
  }
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function jnPost(path, payload) {
  const r = await jnFetch(JN_KEY, path, { method: "POST", body: JSON.stringify(payload) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`JN ${path} ${r.status}: ${txt.slice(0, 160)}`);
  try { return JSON.parse(txt); } catch { return {}; }
}
async function jnGet(path) {
  const r = await jnFetch(JN_KEY, path);
  if (!r.ok) return {};
  return r.json().catch(() => ({}));
}
async function findExistingContact(phone, fullName) {
  const digits = String(phone || "").replace(/\D/g, "");
  const filters = [];
  if (digits.length >= 10) filters.push({ must: [{ match: { mobile_phone: digits } }] });
  if (fullName) filters.push({ must: [{ match_phrase: { display_name: fullName } }] });
  for (const f of filters) {
    try {
      const r = await jnGet(`contacts?size=10&filter=${encodeURIComponent(JSON.stringify(f))}`);
      const results = r.results || r.contacts || r.data || [];
      if (digits.length >= 10) {
        const byPhone = results.find((c) => String(c.mobile_phone || c.home_phone || c.work_phone || "").replace(/\D/g, "").slice(-10) === digits.slice(-10));
        if (byPhone) return byPhone.jnid || byPhone.id;
      }
      const byName = results.find((c) => String(c.display_name || "").trim().toLowerCase() === String(fullName || "").trim().toLowerCase());
      if (byName) return byName.jnid || byName.id;
    } catch { /* next */ }
  }
  return null;
}
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
