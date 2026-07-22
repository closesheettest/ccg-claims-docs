// netlify/functions/harvest-book-btr-appt.js
//
// Book a BACK-TO-RETAIL (BTR) appointment off an INSPECTION pin — the homeowner
// declined the free inspection and just wants a retail sales appointment.
//
// What it does:
//   1. Books a RETAIL appointment in JobNimbus (Lead / "Appointment Scheduled" /
//      retail location / source "Harvesting"), exactly like harvest-book-appt.
//   2. Assigns it to whoever RUNS it:
//        • normal rep  → the rep
//        • William (trainer) → the REGIONAL MANAGER of the home's zone (found
//          from the pin's lat/lng). William doesn't close retail himself.
//   3. Credits the BOOKING REP's pay like a sign-up: writes an `inspections`
//      row (result="retail", signed_at=now) attributed to the rep, so it shows
//      on their pay report at the same $150 a signup earns.
//   4. Flips the pin to 'appt'.
//
//   POST { rt, pin_id, appt_iso, phone, email }
//   → { ok, job_id, contact_id, assigned, credited_rep }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY

import { jnFetch, assignContactOwner } from "./_jn.js";
import { resolveManager } from "./_zone-manager.js";

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const RETAIL_LOCATION = 1;
const APPT_STATUS = 531, APPT_STATUS_NAME = "Appointment Scheduled";
const LEAD_RT = 45, LEAD_RT_NAME = "Lead";
const APPT_TASK_RT = 4; // "Initial Appointment"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isTrainer = (name) => String(name || "").trim().toLowerCase() === "william hernandez";

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

  const rep = (await sbGet(`sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=name,jobnimbus_id,email&limit=1`))[0];
  if (!rep) return json(401, { ok: false, error: "Invalid link" });
  const pin = (await sbGet(`canvass_prospects?id=eq.${encodeURIComponent(pinId)}&select=name,address,city,state,zip,phone,email,latitude,longitude,extra,status,status_log&limit=1`))[0];
  if (!pin) return json(404, { ok: false, error: "pin not found" });

  // A rep-generated door (dropped on the Harvesting Map) reports to JN as
  // "Self Generated" instead of the default "Harvesting" source.
  const selfGen = !!(pin.extra && typeof pin.extra === "object" && pin.extra.self_generated === true);
  const jnSource = selfGen ? "Self Generated" : "Harvesting";
  const payLeadSource = selfGen ? "Self Generated" : "Harvest BTR Appt";

  const nm = (pin.name || "").trim() || "Homeowner";
  const parts = nm.split(/\s+/).filter(Boolean);
  const first = parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] || "");
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  const street = (pin.address || "").split(",")[0].trim();
  const county = pin?.extra?.county || pin?.extra?.County || "";

  // Who RUNS the appointment (JN owner). William → the zone's regional manager;
  // everyone else → themselves. Pay always credits the booking rep, regardless.
  let ownerJn = rep.jobnimbus_id || undefined;
  let assigned = rep.name || "rep";
  if (isTrainer(rep.name)) {
    const mgr = await resolveManager(Number(pin.latitude), Number(pin.longitude), county);
    if (mgr.id) { ownerJn = mgr.id; assigned = `${mgr.name} (${mgr.zone} manager)`; }
    // No manager mapped → leave it on William so it isn't orphaned; office can reassign.
  }

  try {
    // 1. Contact (find by phone/name, else create).
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

    // 2. Retail Lead job at the appointment time, owned by whoever runs it.
    const jobPayload = {
      name: `${nm}${street ? ` - ${street}` : ""}`.trim(),
      record_type: LEAD_RT, record_type_name: LEAD_RT_NAME,
      status: APPT_STATUS, status_name: APPT_STATUS_NAME,
      primary: { id: contactId }, location: { id: RETAIL_LOCATION },
      source_name: jnSource,
      date_start: apptSec,
      address_line1: street, city: pin.city || "", state_text: pin.state || "", zip: pin.zip || "",
      ...(ownerJn ? { owners: [{ id: ownerJn }], sales_rep: ownerJn } : {}),
    };
    let jobId;
    try {
      const job = await jnPost("jobs", jobPayload);
      jobId = job.jnid || job.id;
    } catch (e) {
      // JN rejects a duplicate job NAME. Reuse the homeowner's existing job
      // instead of failing; else fall back to a unique name so it still syncs.
      if (!/duplicate/i.test(e.message || "")) throw e;
      const existing = await findRecentJobForContact(contactId);
      if (existing) {
        await jnPut(`jobs/${existing}`, { status: APPT_STATUS, status_name: APPT_STATUS_NAME, date_start: apptSec, ...(ownerJn ? { owners: [{ id: ownerJn }], sales_rep: ownerJn } : {}) });
        jobId = existing;
      } else {
        const suffix = phone.replace(/\D/g, "").slice(-4) || String(apptSec).slice(-4);
        const job2 = await jnPost("jobs", { ...jobPayload, name: `${jobPayload.name} (${suffix})` });
        jobId = job2.jnid || job2.id;
      }
    }
    if (!jobId) throw new Error("job create failed");
    // Assign the rep to the CONTACT too, not just the job — otherwise JobNimbus hides
    // the homeowner's phone/email and the rep can't call to confirm the appointment.
    if (ownerJn) await assignContactOwner(JN_KEY, contactId, ownerJn);

    // 3. Initial Appointment task on the runner's calendar.
    await jnPost("tasks", {
      record_type: APPT_TASK_RT, record_type_name: "Initial Appointment", type: "task",
      title: `Retail Appointment (BTR) — ${nm}`, date_start: apptSec, date_end: 0,
      related: [{ id: jobId, type: "job" }], ...(ownerJn ? { owners: [{ id: ownerJn }] } : {}),
    });

    await jnPost("activities", {
      record_type_name: "Note",
      note: `🏠 Back-to-Retail appointment booked by ${rep.name || "rep"} for ${new Date(apptMs).toLocaleString("en-US", { timeZone: "America/New_York" })} — homeowner declined the inspection, wants retail. Runs with ${assigned}.${phone ? ` · ${phone}` : ""}${email ? ` · ${email}` : ""}`,
      primary: { id: jobId, type: "job" }, related: [{ id: jobId, type: "job" }], is_status_change: false,
    }).catch(() => {});

    // 4. Pay credit — an inspections row attributed to the BOOKING rep so it
    //    lands on their pay report exactly like a signup ($150). result="retail"
    //    (it's a back-to-retail outcome) also locks the credit if it's later
    //    cancelled. Pay report matches by sales_rep_id = the rep's jobnimbus_id.
    const nowIso = new Date().toISOString();
    await sbInsert("inspections", {
      client_name: nm, address: street, city: pin.city || "", state: pin.state || "", zip: pin.zip || "", county: county || null,
      mobile: phone || null, email: email || null,
      latitude: Number.isFinite(Number(pin.latitude)) ? Number(pin.latitude) : null,
      longitude: Number.isFinite(Number(pin.longitude)) ? Number(pin.longitude) : null,
      sales_rep_id: rep.jobnimbus_id || null, sales_rep_name: rep.name || null, sales_rep_email: rep.email || null,
      original_sales_rep_id: rep.jobnimbus_id || null, original_sales_rep_name: rep.name || null,
      signed_at: nowIso, date: nowIso, docs_signed: false,
      result: "retail", result_at: nowIso,
      retail_outcome: "btr_appt", retail_outcome_at: nowIso, retail_outcome_by: rep.name || null,
      jn_job_id: jobId, jn_status: APPT_STATUS_NAME, jn_pushed_at: nowIso,
      lead_source: payLeadSource,
    }).catch((e) => { console.warn("BTR pay-credit insert failed:", e.message); });

    // 5. Flip the pin to Appt.
    const log = Array.isArray(pin.status_log) ? [...pin.status_log] : [];
    log.push({ at: nowIso, from: pin.status, to: "appt", by: rep.name || "rep", appt_at: apptIso, jn_job_id: jobId, btr: true, runs_with: assigned });
    await fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${encodeURIComponent(pinId)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify({ status: "appt", status_updated_at: nowIso, status_by: rep.name || null, jn_job_id: jobId, status_log: log }),
    }).catch(() => {});

    // Origin for the harvest leaderboard: a SELF-GENERATED retail appt is harvest
    // work (rep found the damaged roof) → tag it "self_gen" so the leaderboard counts
    // it. A real BTR (retail off an existing inspection pin) keeps pin.status (=insp)
    // and stays EXCLUDED — that's post-inspection, not lead-gen.
    logActivity({ pin_id: pinId, rep_name: rep.name, rep_token: rt, kind: "status", from_status: selfGen ? "self_gen" : pin.status, to_status: "appt" });
    return json(200, { ok: true, job_id: jobId, contact_id: contactId, assigned, credited_rep: rep.name || null });
  } catch (e) {
    return json(502, { ok: false, error: `JobNimbus: ${e.message || "failed"}` });
  }
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function sbInsert(table, row) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, { method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`SB insert ${table} ${r.status}: ${(await r.text().catch(() => "")).slice(0, 150)}`);
}
function logActivity(row) {
  fetch(`${SB_URL}/rest/v1/canvass_activity`, { method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(row) }).catch(() => {});
}
async function jnPost(path, payload) {
  const r = await jnFetch(JN_KEY, path, { method: "POST", body: JSON.stringify(payload) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`JN ${path} ${r.status}: ${txt.slice(0, 160)}`);
  try { return JSON.parse(txt); } catch { return {}; }
}
async function jnPut(path, payload) {
  const r = await jnFetch(JN_KEY, path, { method: "PUT", body: JSON.stringify(payload) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`JN PUT ${path} ${r.status}: ${txt.slice(0, 160)}`);
  try { return JSON.parse(txt); } catch { return {}; }
}
async function jnGet(path) {
  const r = await jnFetch(JN_KEY, path);
  if (!r.ok) return {};
  return r.json().catch(() => ({}));
}
// Most-recent JN job on a contact — to REUSE when JN rejects a duplicate name.
async function findRecentJobForContact(contactId) {
  const jf = encodeURIComponent(JSON.stringify({ must: [{ term: { "primary.id": contactId } }] }));
  const d = await jnGet(`jobs?size=5&sort=-date_created&filter=${jf}`).catch(() => ({}));
  const j = (d.results || d.jobs || d.data || [])[0];
  return j ? (j.jnid || j.id) : null;
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
