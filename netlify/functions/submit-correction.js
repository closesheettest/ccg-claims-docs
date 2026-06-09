// netlify/functions/submit-correction.js
//
// Completes the "Correction needed" loop. The originating sales rep (or
// regional manager) opened /?correct=<inspectionId>, fixed the key info,
// and hit Save. We:
//   1. Load the inspection (must currently be flagged correction_needed).
//   2. Save the corrected key info to Supabase (name/phone/email/address)
//      and clear the flag: correction_needed=false + resolved_at/by.
//   3. Best-effort update JobNimbus: find the job's primary contact and
//      PUT the corrected fields onto it; PUT the address onto the job; and
//      post a documenting Note summarizing exactly what changed. (Per the
//      "Update JN + add a note" decision — the note is the reliable
//      backstop if the structured contact update hiccups.)
//   4. Text the assigned PA (pas row via inspections.pa_id): "corrected."
//
// POST body: { inspectionId, client_name, mobile, email, address, city, state, zip, resolvedBy? }
// Response:  { ok, changes, jn: {...}, pa_notified }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
    if (!process.env[k]) return json(500, { ok: false, error: `Missing env: ${k}` });
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }
  const inspectionId = (body.inspectionId || "").trim();
  if (!inspectionId) return json(400, { ok: false, error: "inspectionId required" });

  const next = {
    client_name: (body.client_name || "").trim(),
    mobile: (body.mobile || "").trim(),
    email: (body.email || "").trim(),
    address: (body.address || "").trim(),
    city: (body.city || "").trim(),
    state: (body.state || "").trim(),
    zip: (body.zip || "").trim(),
  };
  const resolvedBy = (body.resolvedBy || "Sales rep / manager (via link)").trim();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

  // 1. Load current values (for the diff) + ownership/link info.
  const rows = await (await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}` +
      `&select=id,jn_job_id,pa_id,correction_needed,client_name,mobile,email,address,city,state,zip&limit=1`,
    { headers: sb },
  )).json().catch(() => []);
  const insp = rows?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspection not found" });

  // Compute what actually changed (only fields the caller sent a value for).
  const fields = ["client_name", "mobile", "email", "address", "city", "state", "zip"];
  const changes = [];
  const patch = {};
  for (const f of fields) {
    const newVal = next[f];
    if (!newVal) continue; // don't blank-out existing data on empty submit
    const oldVal = (insp[f] || "").trim();
    if (newVal !== oldVal) changes.push({ field: f, from: oldVal, to: newVal });
    patch[f] = newVal;
  }

  const nowIso = new Date().toISOString();
  patch.correction_needed = false;
  patch.correction_resolved_at = nowIso;
  patch.correction_resolved_by = resolvedBy;

  // 2. Save to Supabase.
  const up = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
    method: "PATCH",
    headers: { ...sb, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!up.ok) {
    return json(500, { ok: false, error: `Save failed: ${(await up.text()).slice(0, 200)}` });
  }

  const changeSummary = changes.length
    ? changes.map((c) => `• ${labelFor(c.field)}: "${c.from || "(blank)"}" → "${c.to}"`).join("\n")
    : "No field values changed.";

  // 3. JobNimbus — best-effort contact + job update + a documenting note.
  const jn = { contact_updated: false, job_updated: false, note_added: false, errors: [] };
  if (insp.jn_job_id && JN_KEY) {
    const jh = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

    // Find the job's primary contact id.
    let contactId = null;
    try {
      const jr = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(insp.jn_job_id)}`, { headers: jh });
      if (jr.ok) {
        const job = await jr.json().catch(() => ({}));
        contactId = resolveContactId(job);
      } else {
        jn.errors.push(`GET job ${jr.status}`);
      }
    } catch (e) { jn.errors.push(`GET job: ${e.message}`); }

    // Update the contact (homeowner identity/phone/email/address lives here).
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
        const cr = await fetch(`${JN_BASE}/contacts/${encodeURIComponent(contactId)}`, {
          method: "PUT", headers: jh, body: JSON.stringify(cPatch),
        });
        if (cr.ok) jn.contact_updated = true;
        else jn.errors.push(`PUT contact ${cr.status}: ${(await cr.text()).slice(0, 120)}`);
      } catch (e) { jn.errors.push(`PUT contact: ${e.message}`); }
    } else {
      jn.errors.push("Could not resolve primary contact on the job");
    }

    // Update the job's own address fields too (JN reports read these).
    const jPatch = {};
    if (next.address) jPatch.address_line1 = next.address;
    if (next.city) jPatch.city = next.city.split(",")[0].trim();
    if (next.state) jPatch.state_text = next.state;
    if (next.zip) jPatch.zip = next.zip;
    if (Object.keys(jPatch).length) {
      try {
        const jr2 = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(insp.jn_job_id)}`, {
          method: "PUT", headers: jh, body: JSON.stringify(jPatch),
        });
        if (jr2.ok) jn.job_updated = true;
        else jn.errors.push(`PUT job ${jr2.status}`);
      } catch (e) { jn.errors.push(`PUT job: ${e.message}`); }
    }

    // Documenting note (always, as the reliable record of what changed).
    try {
      const nr = await fetch(`${JN_BASE}/activities`, {
        method: "POST", headers: jh,
        body: JSON.stringify({
          record_type_name: "Note",
          note: `✅ Correction completed${resolvedBy ? ` by ${resolvedBy}` : ""}:\n${changeSummary}`,
          primary: { id: insp.jn_job_id, type: "job" },
          related: [{ id: insp.jn_job_id, type: "job" }],
          is_status_change: false,
        }),
      });
      if (nr.ok) jn.note_added = true;
      else jn.errors.push(`POST note ${nr.status}`);
    } catch (e) { jn.errors.push(`POST note: ${e.message}`); }
  }

  // 4. Text the assigned PA that it's corrected.
  let paNotified = null;
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");
  if (insp.pa_id && base) {
    const pr = await fetch(
      `${SB_URL}/rest/v1/pas?id=eq.${encodeURIComponent(insp.pa_id)}&select=name,phone&limit=1`,
      { headers: sb },
    );
    const pa = pr.ok ? (await pr.json().catch(() => []))?.[0] : null;
    if (pa?.phone) {
      const homeowner = next.client_name || insp.client_name || "the homeowner";
      const msg =
        `✅ Correction complete — ${homeowner}\n\n` +
        `${changeSummary}\n\n` +
        `You're good to continue the claim.`;
      paNotified = await sendSms(base, pa.phone, pa.name || "PA", msg);
    } else {
      paNotified = { ok: false, error: "No PA phone on file" };
    }
  }

  return json(200, {
    ok: true,
    inspection_id: inspectionId,
    changes,
    change_summary: changeSummary,
    jn,
    pa_notified: paNotified,
  });
};

// JN job → primary contact id. Defensive across shapes JN has returned.
function resolveContactId(job) {
  if (!job || typeof job !== "object") return null;
  if (job.primary && typeof job.primary === "object") {
    if (job.primary.id) return job.primary.id;
    if (Array.isArray(job.primary) && job.primary[0]?.id) return job.primary[0].id;
  }
  if (Array.isArray(job.related)) {
    const c = job.related.find((r) => (r.type || "").toLowerCase() === "contact" && r.id);
    if (c) return c.id;
  }
  return null;
}

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] || "", last: "" };
  const last = parts.pop();
  return { first: parts.join(" "), last };
}

function labelFor(field) {
  return {
    client_name: "Name",
    mobile: "Phone",
    email: "Email",
    address: "Address",
    city: "City",
    state: "State",
    zip: "Zip",
  }[field] || field;
}

async function sendSms(base, to, name, message) {
  try {
    const r = await fetch(`${base}/.netlify/functions/ghl-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, name, message }),
    });
    const rb = await r.json().catch(() => ({}));
    return { ok: r.ok, to, status: r.status, error: r.ok ? undefined : (rb.error || `status ${r.status}`) };
  } catch (e) {
    return { ok: false, to, error: e.message };
  }
}

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
