// netlify/functions/harvest-appt-status.js
//
// The DoorDispatcher "what happened with this appointment?" accountability gate.
// When a rep opens the map with a PAST appointment still sitting as "Appointment
// Scheduled" in JobNimbus, they must close it out before starting a new day. This
// endpoint either:
//   • WRITES the chosen status to the appt's JN job (verbatim office status name)
//     + logs an activity note + reflects it on the map pin, or
//   • RECHECK — just re-reads JN's current status (the "I already statused it in
//     JobNimbus" button), so an appt the rep closed in JN itself unlocks the map
//     with no second write. The reverse-sync then keeps the pin in step.
//
//   POST { rt, jn_job_id, status }        → write status, update pin
//   POST { rt, jn_job_id, recheck:true }  → read current JN status only
//   → { ok, status_name, resolved }        (resolved = not "Appointment Scheduled")
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

import { jnFetch } from "./_jn.js";

const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The office's appointment-outcome statuses the gate may set — VERBATIM from the
// JobNimbus status dropdown so JN accepts them (an unknown name is rejected).
const ALLOWED = new Set([
  "Sit - Pending", "Sit - No Sale", "No Sit - Rescheduled", "No Show- H/O",
  "Refused Appointment", "Credit Denial", "No Sit- Need to Reschedule", "Sit - Sold",
]);

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, { ok: false, error: "POST only" });
  if (!JN_KEY || !SB_URL || !SB_KEY) return cors(500, { ok: false, error: "env missing" });

  let body; try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, { ok: false, error: "bad JSON" }); }
  const rt = String(body.rt || "").trim();
  const jobId = String(body.jn_job_id || "").trim();
  if (!UUID.test(rt)) return cors(401, { ok: false, error: "Invalid link" });
  if (!jobId) return cors(400, { ok: false, error: "jn_job_id required" });

  const rep = (await sbGet(`sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=name,jobnimbus_id&limit=1`))[0];
  if (!rep) return cors(401, { ok: false, error: "Invalid link" });

  // RECHECK — read JN's current status only (no write). Powers "Already statused in JN".
  if (body.recheck) {
    const r = await jnFetch(JN_KEY, `jobs/${encodeURIComponent(jobId)}`);
    const j = r.ok ? await r.json().catch(() => ({})) : {};
    const status_name = j.status_name || null;
    if (status_name) await updatePin(jobId, status_name).catch(() => {});
    return cors(200, { ok: true, status_name, resolved: isResolved(status_name) });
  }

  const status = String(body.status || "").trim();
  if (!ALLOWED.has(status)) return cors(400, { ok: false, error: "status not allowed" });

  const r = await jnFetch(JN_KEY, `jobs/${encodeURIComponent(jobId)}`, { method: "PUT", body: JSON.stringify({ status_name: status }) });
  if (!r.ok) { const t = await r.text().catch(() => ""); return cors(502, { ok: false, error: `JobNimbus rejected the status (${r.status})`, detail: t.slice(0, 200) }); }
  // Best-effort audit note (don't fail the write if the note fails).
  jnFetch(JN_KEY, `activities`, { method: "POST", body: JSON.stringify({ record_type_name: "Note", note: `📋 Appt outcome (${rep.name}): ${status} — via DoorDispatcher`, primary: { id: jobId, type: "job" }, related: [{ id: jobId, type: "job" }], is_status_change: false }) }).catch(() => {});
  await updatePin(jobId, status).catch(() => {});
  return cors(200, { ok: true, status_name: status, resolved: isResolved(status) });
};

function isResolved(name) { return !!name && !/appointment scheduled/i.test(name); }

// JN status_name → map pin status (mirrors harvest-sync-iq-background's jobPinStatus),
// then PATCH the map pin at this job so the board updates immediately (not only at the
// next reverse-sync). No pin at this job → nothing to do.
function pinStatusFor(name) {
  const s = String(name || "").toLowerCase();
  if (s.includes("sold") || s.includes("signed")) return (s.includes("insp") || /\bpa\b/.test(s)) ? "insp_sold" : "appt";
  if (s.includes("new roof")) return "new_roof";
  if (s.includes("refused")) return "iq_ni";
  if (s.includes("no sit") || s.includes("no show") || s.includes("reschedul")) return "no_sit_reschedule";
  if (s.includes("appointment") || s.includes("pending")) return "appt";
  if (s.includes("lost") || s.includes("no sale") || s === "dq" || s.includes("disqualif")) return "lost";
  if (s.includes("btr") || s.includes("credit denial") || s.includes("stale") || s.includes("no info") || s.includes("no response")) return "iq_ni";
  return null;
}
async function updatePin(jobId, statusName) {
  const pinStatus = pinStatusFor(statusName);
  if (!pinStatus) return;
  await fetch(`${SB_URL}/rest/v1/canvass_prospects?jn_job_id=eq.${encodeURIComponent(jobId)}`, {
    method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({ status: pinStatus, status_by: "JN job status", status_updated_at: new Date().toISOString() }),
  });
}

const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
async function sbGet(path) { try { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders }); return r.ok ? r.json() : []; } catch { return []; } }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }, body: typeof body === "string" ? body : JSON.stringify(body) }; }
