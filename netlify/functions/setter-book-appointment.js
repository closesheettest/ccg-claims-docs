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
const RESET_APPT_RT = 12; // 12 = "Reset Appointment" — used when rescheduling a No-Sit lead
const NO_SIT_STATUS = 534; // "No Sit- Need to Reschedule" — booking onto this = a reset, not a new appt
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

  // ── Re-push a booking whose JobNimbus sync failed ────────────────────────
  // The setter list shows "⚠ not synced to JN" when the original create hit a
  // JN error. This re-runs the contact + job + task create from the stored row
  // and stamps jn_* on success — so a setter can push it without re-booking.
  if (body.action === "resync") {
    const id = String(body.id || "").trim();
    if (!id) return cors(400, JSON.stringify({ ok: false, error: "id required" }));
    const r0 = await fetch(`${SB_URL}/rest/v1/setter_appointments?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, { headers: sb });
    const row = (r0.ok ? await r0.json().catch(() => []) : [])[0];
    if (!row) return cors(404, JSON.stringify({ ok: false, error: "Booking not found" }));
    if (row.jn_job_id) return cors(200, JSON.stringify({ ok: true, already: true, job_id: row.jn_job_id }));
    const owner = row.manager_jobnimbus_id || VIVIANA_ID;
    const nm = String(row.homeowner_name || "").trim();
    const parts = nm.split(/\s+/).filter(Boolean);
    const first = parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] || "");
    const last = parts.length > 1 ? parts[parts.length - 1] : "";
    const ap = String(row.address || "").split(",").map((s) => s.trim());
    const street = ap[0] || "";
    const rCity = ap[1] || "";
    const m = (ap[2] || "").match(/([A-Za-z]{2})?\s*(\d{5})?/) || [];
    const rState = m[1] || "";
    const rZip = m[2] || "";
    const rSetterShort = (() => { const p = String(row.setter_name || "").split(/\s+/).filter(Boolean); return p.length >= 2 ? `${p[0]} ${p[1][0]}.` : (row.setter_name || "Setter"); })();
    const apptSec = Math.floor(new Date(row.appt_at).getTime() / 1000);
    try {
      let contactId = await findExistingContact(row.phone, nm);
      if (!contactId) {
        try {
          const cr = await jnPost("contacts", { first_name: first, last_name: last, display_name: nm, mobile_phone: row.phone || "", address_line1: street, city: rCity, state_text: rState, zip: rZip });
          contactId = cr.jnid || cr.id;
        } catch (e) {
          if (!/duplicate/i.test(e.message || "")) throw e;
          // JN says duplicate but we couldn't find it — create with a unique name.
          const suffix = String(row.phone || "").replace(/\D/g, "").slice(-4) || String(apptSec).slice(-4);
          const cr2 = await jnPost("contacts", { first_name: first, last_name: last, display_name: `${nm} (${suffix})`, mobile_phone: row.phone || "", address_line1: street, city: rCity, state_text: rState, zip: rZip });
          contactId = cr2.jnid || cr2.id;
        }
      }
      if (!contactId) throw new Error("contact create failed");
      const job = await jnPost("jobs", {
        name: `${nm}${street ? ` - ${street}` : ""}`.trim(),
        record_type: LEAD_RT, record_type_name: LEAD_RT_NAME,
        status: APPT_STATUS, status_name: APPT_STATUS_NAME,
        primary: { id: contactId }, location: { id: RETAIL_LOCATION },
        source_name: SOURCES.has(row.source) ? row.source : "Instant Quote",
        address_line1: street, city: rCity, state_text: rState, zip: rZip,
        owners: [{ id: owner }], cf_string_8: rSetterShort,
      });
      const jobId = job.jnid || job.id;
      if (!jobId) throw new Error("job create failed");
      const task = await jnPost("tasks", {
        record_type: APPT_TASK_RT, record_type_name: "Initial Appointment", type: "task",
        title: `Initial Appointment — ${nm}`, date_start: apptSec, date_end: 0,
        related: [{ id: jobId, type: "job" }], owners: [{ id: owner }],
      });
      const taskId = task.jnid || task.id || null;
      await jnPost("activities", {
        record_type_name: "Note",
        note: `📞 Appointment set by ${row.setter_name || "setter"} · source: ${row.source || ""} · 👤 assigned to ${row.manager_name || "Viviana"}${row.zone ? ` (${row.zone})` : ""} — pushed to JN (resync)`,
        primary: { id: jobId, type: "job" }, related: [{ id: jobId, type: "job" }], is_status_change: false,
      }).catch(() => {});
      await fetch(`${SB_URL}/rest/v1/setter_appointments?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
        body: JSON.stringify({ jn_contact_id: contactId, jn_job_id: jobId, jn_task_id: taskId, jn_synced: true }),
      }).catch(() => {});
      return cors(200, JSON.stringify({ ok: true, job_id: jobId, contact_id: contactId, task_id: taskId }));
    } catch (e) {
      return cors(502, JSON.stringify({ ok: false, error: e.message || "JobNimbus error" }));
    }
  }

  const apptMs = Date.parse(body.appt_iso || "");
  if (!Number.isFinite(apptMs)) return cors(400, JSON.stringify({ ok: false, error: "appt_iso required" }));
  const source = SOURCES.has(body.source) ? body.source : "Instant Quote";
  const setter = String(body.setter_name || "Setter").trim();
  // "Appointment Set By" → JN custom field cf_string_8. Short "First L." form to
  // match the existing dialer convention (e.g. "Dustin H.").
  const setterShort = (() => { const p = setter.split(/\s+/).filter(Boolean); return p.length >= 2 ? `${p[0]} ${p[1][0]}.` : setter; })();
  const test = !!body.test;
  // A SALES REP booking (dashboard "Schedule a Retail Appt" tile / rep-hub handoff
  // sends rep_booked:true) → flag the JN job "Sales Rep Harvested" (cf_string_35)
  // = Yes, so it lands on the harvest leaderboard automatically. Setter bookings
  // (Viviana & co) stay unflagged — that's office-set only.
  const harvestFlag = body.rep_booked ? { cf_string_35: "Yes" } : {};
  const spanishTag = body.spanish_only ? " - SPANISH ONLY" : ""; // appended to the JN job name
  const lat = Number(body.lat), lng = Number(body.lng);

  // The setter never picks a rep. Every booking is assigned to the ZONE's
  // REGIONAL MANAGER (JN owner) with NO sales rep — the manager then assigns a
  // rep from his dashboard. Availability still drives which slots get offered.
  const mgr = await resolveManager(lat, lng, body.county);
  const owner = mgr.id || VIVIANA_ID;   // Viviana only if no manager maps to the zone
  const repId = null, repName = "";     // no sales rep at booking time

  let c = body.contact || {};
  let contactId = String(body.contact_id || "").trim();
  let jnOk = true, jnErr = "", jobId = null, taskId = null, isReset = false;

  // ── JobNimbus writes (best-effort) ──────────────────────────────────────
  // If any JN step fails we DON'T lose the booking — we still log it locally
  // below so the setter keeps a reference and a manager can repair JN.
  try {
    // 1. Contact — existing (pull its name/address so the job is named/findable) or create.
    //    Also detect a "No Sit- Need to Reschedule" job on this homeowner: that
    //    makes this a RESET (we re-set the existing deal, not open a new one).
    if (contactId) {
      try {
        const got = await jnGet(`contacts/${contactId}`);
        if (got && (got.jnid || got.id)) c = { first_name: got.first_name || "", last_name: got.last_name || "", mobile: got.mobile_phone || c.mobile, address: got.address_line1 || "", city: got.city || "", state: got.state_text || got.state || "", zip: got.zip || "" };
      } catch { /* fall back to whatever was passed */ }
      try {
        const jf = encodeURIComponent(JSON.stringify({ must: [{ term: { "primary.id": contactId } }] }));
        const jr = await fetch(`${JN_BASE}/jobs?size=20&sort=-date_created&filter=${jf}`, { headers: jnH });
        if (jr.ok) { const jd = await jr.json(); const j = (jd.results || []).find((x) => Number(x.status) === NO_SIT_STATUS); if (j) { jobId = j.jnid || j.id; isReset = true; } }
      } catch { /* couldn't check status → treat as a normal new appointment */ }
    }
    const fullName = nameOf(c, body);
    // Reuse an existing JN contact (by phone/name) so we don't hit JN's
    // "duplicate display name" 400 when the homeowner already exists.
    if (!contactId && !test) contactId = await findExistingContact(c.mobile, fullName);
    if (!contactId) {
      const dispName = test ? `${fullName} [TEST-${apptMs}]` : fullName;
      try {
        const cr = await jnPost("contacts", {
          first_name: c.first_name || "", last_name: c.last_name || "",
          display_name: dispName,
          email: c.email || "", mobile_phone: c.mobile || "",
          address_line1: c.address || "", city: (c.city || "").split(",")[0].trim(), state_text: c.state || "", zip: c.zip || "",
        });
        contactId = cr.jnid || cr.id;
      } catch (e) {
        if (!/duplicate/i.test(e.message || "")) throw e;
        const suffix = String(c.mobile || "").replace(/\D/g, "").slice(-4) || String(apptMs).slice(-4);
        const cr2 = await jnPost("contacts", {
          first_name: c.first_name || "", last_name: c.last_name || "",
          display_name: `${dispName} (${suffix})`,
          email: c.email || "", mobile_phone: c.mobile || "",
          address_line1: c.address || "", city: (c.city || "").split(",")[0].trim(), state_text: c.state || "", zip: c.zip || "",
        });
        contactId = cr2.jnid || cr2.id;
      }
      if (!contactId) throw new Error("contact create failed");
    }
    // ── Prompt before double-booking ─────────────────────────────────────────
    // If this homeowner already has an UPCOMING appointment, don't silently
    // change it — ask the setter. (No-Sit reschedules already ARE a reschedule,
    // so skip the prompt there.) The setter's choice comes back as `confirm`:
    //   'reschedule' → move it to the new time · 'keep' → leave it as-is.
    const confirm = String(body.confirm || "").toLowerCase();
    if (!isReset && confirm !== "reschedule") {
      const ex = await findExistingAppt(contactId);
      if (ex && ex.apptSec) {
        if (confirm === "keep") {
          return cors(200, JSON.stringify({ ok: true, kept: true, existing_iso: new Date(ex.apptSec * 1000).toISOString(), job_id: ex.jobId }));
        }
        return cors(200, JSON.stringify({ ok: false, needs_confirm: true, existing_iso: new Date(ex.apptSec * 1000).toISOString(), new_iso: body.appt_iso, job_id: ex.jobId }));
      }
    }
    // 2. Job — RESET the existing No-Sit deal in place, or create a new retail Lead.
    if (isReset && jobId) {
      await jnPut(`jobs/${jobId}`, { status: APPT_STATUS, status_name: APPT_STATUS_NAME, sales_rep: repId || undefined, owners: [{ id: owner }], cf_string_8: setterShort, ...harvestFlag });
    } else {
      const jobPayload = {
        name: `${test ? "[TEST] " : ""}${fullName}${c.address ? ` - ${c.address}` : ""}${spanishTag}`.trim(),
        record_type: LEAD_RT, record_type_name: LEAD_RT_NAME,
        status: APPT_STATUS, status_name: APPT_STATUS_NAME,
        primary: { id: contactId }, location: { id: RETAIL_LOCATION },
        source_name: source,
        address_line1: c.address || "", city: (c.city || "").split(",")[0].trim(), state_text: c.state || "", zip: c.zip || "",
        sales_rep: repId || undefined,
        owners: [{ id: owner }],
        cf_string_8: setterShort,
        ...harvestFlag,
      };
      try {
        const job = await jnPost("jobs", jobPayload);
        jobId = job.jnid || job.id;
      } catch (e) {
        // JN rejects a second job with the same name ("Duplicate job exists").
        // The homeowner already has a job — REUSE it (set it to the appointment)
        // rather than failing to sync or spawning a duplicate. If we can't find
        // it (name collision across contacts), fall back to a unique name.
        if (!/duplicate/i.test(e.message || "")) throw e;
        const existing = contactId ? await findRecentJobForContact(contactId) : null;
        if (existing) {
          await jnPut(`jobs/${existing}`, { status: APPT_STATUS, status_name: APPT_STATUS_NAME, sales_rep: repId || undefined, owners: [{ id: owner }], cf_string_8: setterShort, source_name: source, ...harvestFlag });
          jobId = existing;
        } else {
          const suffix = String(c.mobile || "").replace(/\D/g, "").slice(-4) || String(apptMs).slice(-4);
          const job2 = await jnPost("jobs", { ...jobPayload, name: `${jobPayload.name} (${suffix})` });
          jobId = job2.jnid || job2.id;
        }
      }
      if (!jobId) throw new Error("job create failed");
    }
    // 3. Appointment task (start only — no end date). Reset Appointment when
    //    rescheduling a No-Sit, otherwise Initial Appointment.
    const apptRtName = isReset ? "Reset Appointment" : "Initial Appointment";
    const task = await jnPost("tasks", {
      record_type: isReset ? RESET_APPT_RT : APPT_TASK_RT, record_type_name: apptRtName, type: "task",
      title: `${apptRtName} — ${fullName}`,
      date_start: Math.floor(apptMs / 1000), date_end: 0,
      related: [{ id: jobId, type: "job" }], owners: [{ id: owner }],
    });
    taskId = task.jnid || task.id || null;
    // 4. Who-set-it note.
    await jnPost("activities", {
      record_type_name: "Note",
      note: `📞 ${isReset ? "Reset appointment (No-Sit reschedule)" : "Appointment"} set by ${setter} · source: ${source} · 👤 assigned to ${mgr.name || "Viviana"}${mgr.zone ? ` (${mgr.zone})` : ""} — manager to assign a rep${mgr.repInRange ? "" : " · ⚠️ no rep within 50 mi"}`,
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
      appt_at: new Date(apptMs).toISOString(), source,
      rep_name: null, rep_jobnimbus_id: null,                    // no sales rep yet — manager assigns
      zone: mgr.zone || null,
      manager_jobnimbus_id: mgr.id || owner,
      manager_name: mgr.name || (mgr.id ? null : "Viviana"),
      jn_contact_id: contactId || null, jn_job_id: jobId, jn_task_id: taskId,
      out_of_range: !mgr.repInRange, jn_synced: jnOk,
    }).catch(() => {});
  }

  // JobNimbus sync failed even after the per-call retries — alert ops so it
  // never sits unsynced unnoticed. The booking is already saved locally above,
  // so a manager can enter it in JN by hand from the alert.
  if (!jnOk && !test && process.env.ADMIN_ALERT_PHONE) {
    const base = process.env.URL || "https://free-roof-inspections.netlify.app";
    await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: process.env.ADMIN_ALERT_PHONE, name: "Admin", message: `⚠️ Setter booking did NOT sync to JobNimbus: ${setter} → ${homeowner}${address ? ` (${address})` : ""}. It's saved locally — please add it in JN by hand. (${jnErr})` }),
    }).catch(() => {});
  }

  // No zone manager mapped → it fell to Viviana. Alert the admin so someone
  // re-owns it in JN. (Normal bookings now land on the regional manager, who
  // assigns a rep from his dashboard — no per-booking alert needed.)
  if (!mgr.id && !test && jnOk && process.env.ADMIN_ALERT_PHONE) {
    const base = process.env.URL || "https://free-roof-inspections.netlify.app";
    const whenEt = new Date(apptMs).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
    await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: process.env.ADMIN_ALERT_PHONE, name: "Admin", message: `📞 Retail appt set by ${setter} for ${homeowner}${c.city ? ` (${c.city})` : ""} @ ${whenEt} — no regional manager for this zone, so it's under Viviana in JN. Assign an owner.` }),
    }).catch(() => {});
  }

  return cors(200, JSON.stringify({ ok: true, jn_ok: jnOk, jn_error: jnOk ? undefined : jnErr, out_of_range: !mgr.repInRange, reset: isReset, contact_id: contactId || null, job_id: jobId, task_id: taskId, assigned: mgr.name || "Viviana (no zone manager)", zone: mgr.zone || null }));
};

function nameOf(c, body) { return (`${c.first_name || ""} ${c.last_name || ""}`).trim() || String(body.homeowner_name || "").trim() || "Homeowner"; }

// Resolve the ZONE's regional manager for this booking. Zone = the zone of the
// nearest active senior rep within 50 mi (the rep who'd have been auto-assigned
// under the old flow); if none, the county's primary zone. Returns the zone's
// regional manager (managed_region match) as the JN owner — or {id:null} when no
// manager maps to the zone, in which case the caller falls back to Viviana.
// Mirrors the zone/radius logic in setter-availability.js.
const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
const ZONE_COUNTIES = {
  "Zone 1": ["Nassau", "Duval", "Baker", "Union", "Bradford", "Clay", "St. Johns", "Putnam", "Flagler", "Alachua", "Levy", "Marion", "Sumter", "Lake", "Seminole", "Volusia", "Brevard", "Orange"],
  "Zone 2": ["Orange", "Brevard", "Pasco", "Hillsborough", "Polk", "Osceola", "Indian River", "Highlands", "Citrus", "Hernando"],
  "Zone 3": ["Pinellas", "Manatee", "Sarasota", "Charlotte", "Lee", "Collier", "Monroe", "Hardee", "DeSoto", "Glades", "Hendry", "St. Lucie", "Okeechobee"],
  "Zone 4": ["Martin", "Palm Beach", "Broward", "Miami-Dade"],
};
const normCounty = (c) => String(c || "").toLowerCase().replace(/county/g, "").replace(/[^a-z]+/g, " ").trim();
const COUNTY_ZONES = (() => { const m = {}; for (const [z, l] of Object.entries(ZONE_COUNTIES)) for (const c of l) (m[normCounty(c)] = m[normCounty(c)] || []).push(z); return m; })();
function haversineMi(la1, lo1, la2, lo2) { const R = 3958.8, t = (d) => d * Math.PI / 180; const dLa = t(la2 - la1), dLo = t(lo2 - lo1); const a = Math.sin(dLa / 2) ** 2 + Math.cos(t(la1)) * Math.cos(t(la2)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); }
function fetchReps() { return fetch(REP_ZONES_URL).then((r) => r.ok ? r.json().then((j) => j.reps || []) : []).catch(() => []); }

async function resolveManager(lat, lng, county) {
  const reps = await fetchReps();
  const zonesForCounty = COUNTY_ZONES[normCounty(county)] || ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];
  let zone = null, repInRange = false;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const near = reps
      .filter((r) => r.active && r.jobnimbus_id && String(r.rep_level || "").toLowerCase() === "senior" && zonesForCounty.includes(r.zone) && r.latitude != null && r.longitude != null)
      .map((r) => ({ zone: r.zone, d: haversineMi(lat, lng, r.latitude, r.longitude) }))
      .filter((r) => r.d <= 50)
      .sort((a, b) => a.d - b.d);
    if (near.length) { zone = near[0].zone; repInRange = true; }
  }
  if (!zone) zone = zonesForCounty[0];
  const m = reps.find((r) => r.managed_region === zone && r.jobnimbus_id);
  return { id: m ? m.jobnimbus_id : null, name: m ? m.name : "", zone, repInRange };
}

async function sbInsert(table, row) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, { method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`SB insert ${table} ${r.status}: ${(await r.text()).slice(0, 150)}`);
}
// Retry transient JobNimbus failures (network blips, gateway/timeout/rate-limit)
// so ONE hiccup doesn't surface a scary "didn't sync" to the setter — which is
// what makes them re-book by hand and create a duplicate. Only the classic
// transient statuses are retried; a 500 is NOT (a POST might have partially
// applied), so a retry can never duplicate a just-created record.
const JN_RETRY_STATUS = new Set([429, 502, 503, 504]);
async function jnFetch(path, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${JN_BASE}/${path}`, opts);
      if (r.ok || !JN_RETRY_STATUS.has(r.status)) return r; // success, or a non-transient error the caller will report
      lastErr = new Error(`JN ${path} ${r.status}`);
    } catch (e) {
      lastErr = e; // network error / timeout
    }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, 350 * (i + 1)));
  }
  throw lastErr;
}
async function jnGet(path) {
  const r = await jnFetch(path, { headers: jnH });
  if (!r.ok) throw new Error(`JN GET ${path} ${r.status}`);
  return r.json();
}
async function jnPut(path, payload) {
  const r = await jnFetch(path, { method: "PUT", headers: jnH, body: JSON.stringify(payload) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`JN PUT ${path} ${r.status}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { return {}; }
}
async function jnPost(path, payload) {
  const r = await jnFetch(path, { method: "POST", headers: jnH, body: JSON.stringify(payload) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`JN ${path} ${r.status}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { return {}; }
}
// Does this homeowner already have an UPCOMING appointment? Scans their most
// recent jobs for a non-completed Initial/Reset Appointment task dated now-or-
// later. Returns { jobId, apptSec } of the soonest one, or null.
async function findExistingAppt(contactId) {
  try {
    const jf = encodeURIComponent(JSON.stringify({ must: [{ term: { "primary.id": contactId } }] }));
    const jr = await fetch(`${JN_BASE}/jobs?size=5&sort=-date_created&filter=${jf}`, { headers: jnH });
    if (!jr.ok) return null;
    const jobs = ((await jr.json().catch(() => ({}))).results || []).slice(0, 3);
    const nowSec = Math.floor(Date.now() / 1000);
    let best = null;
    for (const j of jobs) {
      const jid = j.jnid || j.id;
      const tf = encodeURIComponent(JSON.stringify({ must: [{ term: { "related.id": jid } }] }));
      const tr = await fetch(`${JN_BASE}/tasks?size=20&filter=${tf}`, { headers: jnH });
      if (!tr.ok) continue;
      const appts = ((await tr.json().catch(() => ({}))).results || [])
        .filter((t) => /appointment/i.test(t.record_type_name || "") && !t.is_completed && Number(t.date_start) >= nowSec);
      for (const t of appts) {
        const sec = Number(t.date_start);
        if (!best || sec < best.apptSec) best = { jobId: jid, apptSec: sec };
      }
    }
    return best;
  } catch { return null; }
}
// Most-recent JN job attached to a contact — used to REUSE an existing job when
// JN rejects a new one as a duplicate name (the homeowner already has a job).
async function findRecentJobForContact(contactId) {
  try {
    const jf = encodeURIComponent(JSON.stringify({ must: [{ term: { "primary.id": contactId } }] }));
    const r = await fetch(`${JN_BASE}/jobs?size=5&sort=-date_created&filter=${jf}`, { headers: jnH });
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    const j = (d.results || d.jobs || d.data || [])[0];
    return j ? (j.jnid || j.id) : null;
  } catch { return null; }
}
// Find an existing JN contact by phone (last 10 digits) or exact display name,
// so we REUSE the homeowner instead of hitting JN's "duplicate display name"
// 400 when they already exist. Returns the contact id, or null.
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
    } catch { /* try next filter */ }
  }
  return null;
}

async function okToken(token) { token = String(token || "").trim(); if (!token) return false; const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]); return (!!d && token === d) || (!!v && token === v); }
async function getSetting(key) { const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sb }); if (!r.ok) return null; const rows = await r.json().catch(() => []); return rows[0]?.value || null; }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
