// netlify/functions/pa-request-correction.js
//
// Fires when a Public Adjuster taps "Correction needed" on a deal they own:
// some key info is wrong (or the originating sales rep needs to follow up)
// and the PA can't proceed until it's fixed. We:
//   1. Verify the PA owns the deal (inspections.pa_id === paId).
//   2. Flag it: correction_needed=true + the PA's note + who/when, so the
//      PA portal shows "waiting on the rep" and the deal can't silently
//      look complete.
//   3. Post the request as a JobNimbus note (best-effort) so JN reflects it.
//   4. Text the originating sales rep AND that rep's regional manager
//      (resolved by bridging rep → zone via TMS rep-zones →
//      regional_managers — same path as pa-refused-to-sign.js). The text
//      says what's needed and links to /?correct=<inspectionId>, the
//      in-app correction screen.
//
// POST body: { inspectionId: "<uuid>", paId: "<pas.id>", note: "<what's wrong>" }
// Response:  { ok, notified: { rep, manager }, jn_note_added, link }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.
//   URL or PUBLIC_SITE_URL — base for internal function calls + the link.

const TMS_REP_ZONES_URL =
  "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";
const JN_BASE = "https://app.jobnimbus.com/api1";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }
  const missing = [];
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) return json(500, { ok: false, error: `Missing env: ${missing.join(", ")}` });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }
  const inspectionId = (body.inspectionId || "").trim();
  const paId = (body.paId || "").trim();
  const note = (body.note || "").trim();
  // kind: "correction" (info needs fixing) | "question" (a question/request).
  // Both use the same link + reply flow; only the wording differs.
  const kind = String(body.kind || "correction").trim() === "question" ? "question" : "correction";
  if (!inspectionId) return json(400, { ok: false, error: "inspectionId required" });
  if (!note) return json(400, { ok: false, error: kind === "question" ? "Please type your question or request" : "Please describe what needs to be corrected" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };
  const base = (process.env.URL || process.env.PUBLIC_SITE_URL || "").replace(/\/$/, "");

  // 1. Load the deal + verify ownership. Also grab the PA's name for the log.
  const lookup = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}` +
      `&select=id,jn_job_id,pa_id,client_name,address,city,state,zip,sales_rep_id,sales_rep_name,pa_notes_log&limit=1`,
    { headers: sbHeaders },
  );
  if (!lookup.ok) {
    return json(500, { ok: false, error: `Could not fetch inspection: ${await lookup.text()}` });
  }
  const insp = (await lookup.json())?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspection not found" });
  if (paId && insp.pa_id && insp.pa_id !== paId) {
    return json(403, { ok: false, error: "This deal belongs to a different PA" });
  }

  // Resolve the requesting PA's name (for the audit fields).
  let paName = "";
  if (paId) {
    const pr = await fetch(
      `${SB_URL}/rest/v1/pas?id=eq.${encodeURIComponent(paId)}&select=name&limit=1`,
      { headers: sbHeaders },
    );
    if (pr.ok) paName = ((await pr.json().catch(() => []))?.[0]?.name) || "";
  }

  // 2. Flag the deal + append the request to the running notes log.
  const nowIso = new Date().toISOString();
  const log = Array.isArray(insp.pa_notes_log) ? insp.pa_notes_log : [];
  log.push({ at: nowIso, text: `${kind === "question" ? "Question for rep" : "Correction requested"}: ${note}`, stage: null });
  const patch = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
    method: "PATCH",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({
      correction_needed: true,
      correction_note: note,
      correction_requested_at: nowIso,
      correction_requested_by: paName || paId || "PA",
      correction_resolved_at: null,
      correction_resolved_by: null,
      pa_notes_log: log,
    }),
  });
  if (!patch.ok) {
    return json(500, { ok: false, error: `Could not flag correction: ${(await patch.text()).slice(0, 200)}` });
  }

  // 3. Mirror the request into JobNimbus as a note (best-effort).
  let jnNoteAdded = false, jnError = null;
  if (insp.jn_job_id && JN_KEY) {
    try {
      const r = await fetch(`${JN_BASE}/activities`, {
        method: "POST",
        headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          record_type_name: "Note",
          note: `${kind === "question" ? "❓ Question from PA" : "✏️ Correction requested by PA"}${paName ? ` (${paName})` : ""}: ${note}`,
          primary: { id: insp.jn_job_id, type: "job" },
          related: [{ id: insp.jn_job_id, type: "job" }],
          is_status_change: false,
        }),
      });
      if (r.ok) jnNoteAdded = true;
      else jnError = `JN note POST ${r.status}: ${(await r.text()).slice(0, 160)}`;
    } catch (e) { jnError = e.message; }
  }

  // 4. Text the originating sales rep + that rep's regional manager.
  const homeowner = insp.client_name || "the homeowner";
  const addr = [insp.address, insp.city, insp.state, insp.zip].filter(Boolean).join(", ");
  const link = base ? `${base}/?correct=${encodeURIComponent(inspectionId)}` : "";
  const message =
    (kind === "question"
      ? `❓ Question from the public adjuster — ${homeowner}\n\n`
      : `✏️ Correction needed — ${homeowner}\n\n`) +
    `${note}\n\n` +
    (addr ? `${addr}\n\n` : "") +
    (link ? `Reply here: ${link}` : "Open the app to reply.");

  const rep = await resolveRep(SB_URL, sbHeaders, insp.sales_rep_id, insp.sales_rep_name);
  const zone = await resolveZone(SB_URL, sbHeaders, rep, insp.sales_rep_name);
  const manager = zone ? await fetchManager(SB_URL, sbHeaders, zone) : null;

  const notified = { rep: null, manager: null };
  if (base) {
    if (rep?.phone) {
      notified.rep = await sendSms(base, rep.phone, rep.name || insp.sales_rep_name || "Sales Rep", message);
    } else {
      notified.rep = { ok: false, error: "No rep phone on file" };
    }
    if (manager?.phone) {
      notified.manager = await sendSms(base, manager.phone, manager.name || "Manager", message);
    } else {
      notified.manager = { ok: false, error: zone ? `No manager phone for ${zone}` : "Could not resolve rep's zone" };
    }
  }

  return json(200, {
    ok: true,
    inspection_id: inspectionId,
    link,
    zone: zone || null,
    jn_note_added: jnNoteAdded,
    jn_error: jnError,
    notified,
  });
};

// ── Rep + zone + manager resolution (mirrors pa-refused-to-sign.js) ──────

async function resolveRep(SB_URL, headers, salesRepId, salesRepName) {
  const sel = "id,name,phone,jobnimbus_id";
  const get = async (q) => {
    const res = await fetch(`${SB_URL}/rest/v1/sales_reps?${q}&select=${sel}&limit=1`, { headers });
    if (!res.ok) return null;
    return (await res.json().catch(() => []))?.[0] || null;
  };
  let rep = null;
  if (salesRepId) {
    rep = await get(`jobnimbus_id=eq.${encodeURIComponent(salesRepId)}`);
    if (!rep) rep = await get(`id=eq.${encodeURIComponent(salesRepId)}`);
  }
  if (!rep && salesRepName) {
    rep = await get(`name=ilike.${encodeURIComponent(salesRepName)}`);
  }
  return rep;
}

async function resolveZone(SB_URL, headers, rep, fallbackName) {
  let tmsReps = [];
  try {
    const res = await fetch(TMS_REP_ZONES_URL);
    if (res.ok) tmsReps = (await res.json()).reps || [];
  } catch (e) {
    console.warn("TMS rep-zones fetch failed:", e.message || e);
  }
  const zoneByJnId = {};
  const zoneByNormName = {};
  for (const r of tmsReps) {
    if (r.jobnimbus_id) zoneByJnId[r.jobnimbus_id] = r.zone;
    if (r.name) zoneByNormName[normalizeName(r.name)] = r.zone;
  }
  const jnId = rep?.jobnimbus_id;
  const name = rep?.name || fallbackName;
  return (jnId && zoneByJnId[jnId]) || (name && zoneByNormName[normalizeName(name)]) || null;
}

async function fetchManager(SB_URL, headers, zone) {
  const res = await fetch(
    `${SB_URL}/rest/v1/regional_managers?zone=eq.${encodeURIComponent(zone)}&select=zone,name,phone&limit=1`,
    { headers },
  );
  if (!res.ok) return null;
  return (await res.json().catch(() => []))?.[0] || null;
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

function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, "")
    .replace(/'([^']*)'/g, "")
    .replace(/\(([^)]*)\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
