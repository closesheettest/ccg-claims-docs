// netlify/functions/inspection-action.js
//
// Actions a manager/admin can take right from the "Look up an inspection" card,
// so a stuck deal gets fixed in one spot instead of hunting across tools.
//
// POST { action, inspection_id, ... }
//   action:"update_contact" { client_name?, mobile?, email?, address?, city?,
//        state?, zip?, by? }
//        → fixes the homeowner's info in Supabase AND JobNimbus (contact + job)
//          and logs a note. Manager override — no correction flag required.
//          (PA scheduling reuses pa-schedule-api slots/book directly.)
//   → { ok, changes:[{field,from,to}], jn:{contact_updated,job_updated,note_added} }
//
// Open-CORS (called from the CCG admin hub + the TMS regional dashboard).
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const action = String(body.action || "").trim();
  const id = String(body.inspection_id || "").trim();
  if (!id) return cors(400, JSON.stringify({ ok: false, error: "inspection_id required" }));

  if (action === "update_contact") return await updateContact(id, body);
  if (action === "pa_slots" || action === "pa_book") return await paProxy(action, id, body);
  if (action === "change_result") return await changeResult(id, body);
  return cors(400, JSON.stringify({ ok: false, error: `unknown action: ${action}` }));
};

// Change which PIPELINE a deal is in by flipping inspections.result — the field
// everything downstream keys off — and reflecting it into JobNimbus. Used for
// mis-inspected deals and the "tried retail, fell through, go PA" fallback.
//   retail → damage : the reverse of the retail swap — moves the JN job back to
//     the PA record type + INSURANCE location (id 3) + status "Sit Sold Insp",
//     restores the sold date, relabels cf_string_34 "Damage", clears the retail
//     outcome, and nulls pa_id so it re-enters the PA assignment queue (which
//     filters result=damage & pa_id IS NULL) → the "Schedule a PA" option lights up.
//   damage → retail : fires the vetted retail swap (process-retail-result).
//   → no_damage : flips the result + relabels cf_string_34.
// Supabase is written first (source of truth); JobNimbus is reflected best-effort
// and any JN errors are returned so the manager sees them. Re-running with the
// same target skips the Supabase write but re-syncs JobNimbus (PUTs are idempotent).
const RESULT_LABEL = { damage: "Damage", retail: "Retail", no_damage: "No Damage" };
async function changeResult(id, body) {
  const target = String(body.result || "").trim().toLowerCase();
  const by = (String(body.by || "").trim()) || "Manager (lookup)";
  if (!RESULT_LABEL[target]) return cors(400, JSON.stringify({ ok: false, error: "result must be damage, retail, or no_damage" }));

  const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(id)}&select=id,result,jn_job_id,pa_notes_log,client_name,address,cancelled_at&limit=1`))[0];
  if (!insp) return cors(404, JSON.stringify({ ok: false, error: "Inspection not found" }));
  if (insp.cancelled_at) return cors(409, JSON.stringify({ ok: false, error: "This deal is cancelled — reinstate it before changing its result." }));

  const from = String(insp.result || "").toLowerCase();
  const isChange = from !== target;
  const nowIso = new Date().toISOString();

  // 1) Supabase — the source of truth for which pipeline the deal is in.
  if (isChange) {
    const log = Array.isArray(insp.pa_notes_log) ? insp.pa_notes_log : [];
    log.push({ at: nowIso, text: `Result changed ${RESULT_LABEL[from] || from || "—"} → ${RESULT_LABEL[target]} by ${by}`, stage: null });
    const patch = { result: target, result_at: nowIso, pa_notes_log: log };
    if (target !== "retail") { patch.retail_outcome = null; patch.retail_outcome_at = null; patch.retail_outcome_by = null; }
    if (target === "damage") { patch.pa_id = null; patch.pa_stage = null; patch.pending_confirmation = false; patch.jn_status = "Sit Sold Insp"; }
    const up = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch),
    });
    if (!up.ok) return cors(500, JSON.stringify({ ok: false, error: `Save failed: ${(await up.text()).slice(0, 200)}` }));
  }

  // 2) JobNimbus — reflect the new result (best-effort; errors surfaced).
  const jn = { swap: null, note_added: false, errors: [] };
  if (insp.jn_job_id && JN_KEY) {
    const jh = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
    if (target === "damage") {
      jn.swap = await swapJobToDamage(insp.jn_job_id, jh, jn);
    } else if (target === "retail") {
      const base = process.env.URL || process.env.DEPLOY_URL || "https://free-roof-inspections.netlify.app";
      try {
        const r = await fetch(`${base}/.netlify/functions/process-retail-result`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inspectionId: id }) });
        jn.swap = r.ok ? "retail swap fired (Lead record type, retail location)" : `retail swap HTTP ${r.status}`;
        if (!r.ok) jn.errors.push(`retail swap ${r.status}`);
      } catch (e) { jn.errors.push(`retail swap: ${e.message}`); }
    } else if (target === "no_damage") {
      try {
        const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(insp.jn_job_id)}`, { method: "PUT", headers: jh, body: JSON.stringify({ cf_string_34: "No Damage" }) });
        jn.swap = r.ok ? "result label set to No Damage" : `label PUT ${r.status}`;
        if (!r.ok) jn.errors.push(`label ${r.status}`);
      } catch (e) { jn.errors.push(`label: ${e.message}`); }
    }
    if (isChange) {
      try {
        const nr = await fetch(`${JN_BASE}/notes`, { method: "POST", headers: jh, body: JSON.stringify({ note: `🔄 Inspection result changed ${RESULT_LABEL[from] || from || "—"} → ${RESULT_LABEL[target]} by ${by}`, related: [{ id: insp.jn_job_id, type: "job" }] }) });
        jn.note_added = nr.ok;
      } catch (e) { jn.errors.push(`note: ${e.message}`); }
    }
  }

  const note = isChange
    ? `Changed ${RESULT_LABEL[from] || "—"} → ${RESULT_LABEL[target]}.${target === "damage" ? " Re-queued for a Public Adjuster." : ""}`
    : `Already ${RESULT_LABEL[target]} — re-synced JobNimbus.`;
  return cors(200, JSON.stringify({ ok: true, changed: isChange, from, to: target, jn, note }));
}

// Reverse the retail swap: move a JN job back into the insurance/PA workflow —
// PA record type, insurance location (id 3), status 597 "Sit Sold Insp", restore
// the sold date from cf_date_5, and relabel cf_string_34 "Damage". Mirrors
// reverseRetailSwap in confirm-inspection-result.js, plus the result label.
async function swapJobToDamage(jnJobId, jh, jn) {
  const locId = Number(process.env.JN_LOCATION_ID_INSURANCE) || 3;
  let dateStart = null;
  try {
    const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnJobId)}`, { headers: jh });
    if (r.ok) { const j = await r.json().catch(() => ({})); const raw = j.cf_date_5 || j.date_start || null; if (raw && Number(raw) > 0) dateStart = Number(raw); }
  } catch { /* restore without date_start */ }
  const put = { jnid: jnJobId, record_type_name: "PA", status: 597, status_name: "Sit Sold Insp", location: { id: locId }, cf_string_34: "Damage" };
  if (dateStart) put.date_start = dateStart;
  try {
    const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnJobId)}`, { method: "PUT", headers: jh, body: JSON.stringify(put) });
    if (!r.ok) { jn.errors.push(`swap PUT ${r.status}: ${(await r.text()).slice(0, 140)}`); return `swap FAILED (HTTP ${r.status})`; }
    return `→ PA record type, insurance location, status Sit Sold Insp${dateStart ? ", sold date restored" : ""}, label Damage`;
  } catch (e) { jn.errors.push(`swap: ${e.message}`); return `swap exception: ${e.message}`; }
}

// PA scheduling is token-gated (pa-schedule-api wants the dialer/visit token).
// The manager lookup tool has no token, so we read it server-side and proxy.
async function paProxy(action, id, body) {
  const token = (await getSetting("dialer_token")) || (await getSetting("visit_token"));
  if (!token) return cors(500, JSON.stringify({ ok: false, error: "No scheduling token configured (app_settings dialer_token)." }));
  const base = process.env.URL || process.env.DEPLOY_URL || "https://free-roof-inspections.netlify.app";
  const payload = action === "pa_slots"
    ? { action: "slots", token, inspection_id: id }
    : { action: "book", token, inspection_id: id, pa_id: body.pa_id, start_at: body.start_at, homeowner_name: body.homeowner_name, homeowner_phone: body.homeowner_phone, address: body.address, booked_by: body.booked_by || "Manager (lookup)", force: !!body.force, reschedule: !!body.reschedule };
  try {
    const r = await fetch(`${base}/.netlify/functions/pa-schedule-api`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return cors(r.status, await r.text());
  } catch (e) { return cors(502, JSON.stringify({ ok: false, error: e.message || "PA scheduler unreachable" })); }
}
async function getSetting(key) { const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`); return rows[0]?.value || null; }

async function updateContact(id, body) {
  const next = {
    client_name: (body.client_name || "").trim(),
    mobile: (body.mobile || "").trim(),
    email: (body.email || "").trim(),
    address: (body.address || "").trim(),
    city: (body.city || "").trim(),
    state: (body.state || "").trim(),
    zip: (body.zip || "").trim(),
  };
  const by = (body.by || "Manager (via lookup)").trim();

  const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(id)}&select=id,jn_job_id,pa_notes_log,client_name,mobile,email,address,city,state,zip&limit=1`))[0];
  if (!insp) return cors(404, JSON.stringify({ ok: false, error: "Inspection not found" }));

  const fields = ["client_name", "mobile", "email", "address", "city", "state", "zip"];
  const changes = [];
  const patch = {};
  for (const f of fields) {
    const nv = next[f];
    if (!nv) continue; // never blank out existing data on an empty field
    const ov = String(insp[f] || "").trim();
    if (nv !== ov) { changes.push({ field: f, from: ov, to: nv }); patch[f] = nv; }
  }
  if (!changes.length) return cors(200, JSON.stringify({ ok: true, changes: [], note: "Nothing changed." }));

  const nowIso = new Date().toISOString();
  const log = Array.isArray(insp.pa_notes_log) ? insp.pa_notes_log : [];
  log.push({ at: nowIso, text: `Fixed by ${by}: ${changes.map((c) => `${labelFor(c.field)} → "${c.to}"`).join(", ")}`, stage: null });
  patch.pa_notes_log = log;

  const up = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(patch),
  });
  if (!up.ok) return cors(500, JSON.stringify({ ok: false, error: `Save failed: ${(await up.text()).slice(0, 200)}` }));

  // JobNimbus — update the primary contact + the job's address, and drop a note.
  const jn = { contact_updated: false, job_updated: false, note_added: false, errors: [] };
  if (insp.jn_job_id && JN_KEY) {
    const jh = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
    let contactId = null;
    try {
      const jr = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(insp.jn_job_id)}`, { headers: jh });
      if (jr.ok) contactId = resolveContactId(await jr.json().catch(() => ({})));
    } catch (e) { jn.errors.push(`GET job: ${e.message}`); }

    if (contactId) {
      const { first, last } = splitName(next.client_name);
      const cPatch = {};
      if (next.client_name) { cPatch.first_name = first; cPatch.last_name = last; }
      if (next.mobile) cPatch.mobile_phone = next.mobile;
      if (next.email) cPatch.email = next.email;
      if (next.address) cPatch.address_line1 = next.address;
      if (next.city) cPatch.city = next.city.split(",")[0].trim();
      if (next.state) cPatch.state_text = next.state;
      if (next.zip) cPatch.zip = next.zip;
      try {
        const cr = await fetch(`${JN_BASE}/contacts/${encodeURIComponent(contactId)}`, { method: "PUT", headers: jh, body: JSON.stringify(cPatch) });
        if (cr.ok) jn.contact_updated = true; else jn.errors.push(`PUT contact ${cr.status}`);
      } catch (e) { jn.errors.push(`PUT contact: ${e.message}`); }
    } else jn.errors.push("no primary contact on the job");

    const jPatch = {};
    if (next.address) jPatch.address_line1 = next.address;
    if (next.city) jPatch.city = next.city.split(",")[0].trim();
    if (next.state) jPatch.state_text = next.state;
    if (next.zip) jPatch.zip = next.zip;
    if (Object.keys(jPatch).length) {
      try {
        const jr2 = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(insp.jn_job_id)}`, { method: "PUT", headers: jh, body: JSON.stringify(jPatch) });
        if (jr2.ok) jn.job_updated = true; else jn.errors.push(`PUT job ${jr2.status}`);
      } catch (e) { jn.errors.push(`PUT job: ${e.message}`); }
    }
    try {
      const noteBody = `✏️ Homeowner info fixed by ${by}\n${changes.map((c) => `• ${labelFor(c.field)}: "${c.from || "(blank)"}" → "${c.to}"`).join("\n")}`;
      const nr = await fetch(`${JN_BASE}/notes`, { method: "POST", headers: jh, body: JSON.stringify({ note: noteBody, related: [{ id: insp.jn_job_id, type: "job" }] }) });
      if (nr.ok) jn.note_added = true;
    } catch (e) { jn.errors.push(`note: ${e.message}`); }
  }

  return cors(200, JSON.stringify({ ok: true, changes, jn }));
}

// ── helpers ──
function labelFor(f) { return ({ client_name: "Name", mobile: "Phone", email: "Email", address: "Address", city: "City", state: "State", zip: "Zip" }[f] || f); }
function splitName(full) { const p = String(full || "").trim().split(/\s+/); return { first: p[0] || "", last: p.slice(1).join(" ") || "" }; }
function resolveContactId(job) {
  if (job && Array.isArray(job.primary) && job.primary[0]?.id) return job.primary[0].id;
  if (job && job.primary && job.primary.id) return job.primary.id;
  const rel = (job?.related || []).find((r) => r.type === "contact");
  return rel ? rel.id : null;
}
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
