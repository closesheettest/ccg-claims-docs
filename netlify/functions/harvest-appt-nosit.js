// netlify/functions/harvest-appt-nosit.js
//
// "No sit – needs to reschedule" outcome of an APPOINTMENT (IQ / FB / AI / BTR).
// The rep sat the appt but it didn't sit and needs re-booking later:
//   1. Sets the JobNimbus job status → "No Sit- Need to Reschedule" (the same status
//      harvest-sync-nosits pulls back onto the map as SR-rep reschedule pins).
//   2. Flips the map pin → 'no_sit_reschedule' so it lands on the reschedule list now.
//
// Modeled on harvest-book-appt's reschedule path: these no-sit jobs still belong to the
// ORIGINAL rep, and JobNimbus blocks edits to a file you don't own — so reassign owner +
// sales_rep FIRST, then set the status. Never touch date_start (it 500s on these jobs).
// The pin is always flipped, even if JN refuses, so a bad JN job never leaves the rep
// stuck (flagged for a manual fix).
//
//   POST { rt, pin_id }
//   → { ok, jn_synced }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY

import { jnFetch, assignContactOwner } from "./_jn.js";

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const NOSIT_STATUS_NAME = "No Sit- Need to Reschedule";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!SB_URL || !SB_KEY || !JN_KEY) return json(500, { ok: false, error: "env missing" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }

  const rt = String(body.rt || "").trim();
  const pinId = String(body.pin_id || "").trim();
  if (!UUID.test(rt)) return json(401, { ok: false, error: "Invalid link" });
  if (!pinId) return json(400, { ok: false, error: "pin_id required" });

  const rep = (await sbGet(`sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=name,jobnimbus_id&limit=1`))[0];
  if (!rep) return json(401, { ok: false, error: "Invalid link" });
  const pin = (await sbGet(`canvass_prospects?id=eq.${encodeURIComponent(pinId)}&select=name,status,jn_job_id,status_log&limit=1`))[0];
  if (!pin) return json(404, { ok: false, error: "pin not found" });
  const jobId = String(pin.jn_job_id || "").trim();
  const owner = rep.jobnimbus_id || undefined;

  // ── Push the no-sit status to JobNimbus (best-effort, resilient) ──────────
  let jnFailed = false, jnErr = null;
  if (jobId) {
    try {
      const jh = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
      const rawJobPut = async (payload, step) => {
        let last;
        for (let i = 0; i < 3; i++) {
          const r = await fetch(`https://app.jobnimbus.com/api1/jobs/${jobId}`, { method: "PUT", headers: jh, body: JSON.stringify(payload) });
          if (r.ok) return;
          const txt = await r.text();
          last = new Error(`${step} ${r.status}: ${txt.slice(0, 300)}`);
          if (![429, 502, 503, 504].includes(r.status)) break;
          await new Promise((res) => setTimeout(res, 350 * (i + 1)));
        }
        throw last;
      };
      // Own the job first (JN blocks edits to a file you don't own), then set status.
      if (owner) await rawJobPut({ owners: [{ id: owner }], sales_rep: owner }, "reassign");
      if (owner) {
        try {
          const jobObj = await jnGet(`jobs/${jobId}`);
          const cid = jobObj?.primary?.id || (Array.isArray(jobObj?.primary) ? jobObj.primary[0]?.id : null);
          if (cid) await assignContactOwner(JN_KEY, cid, owner);
        } catch { /* best-effort */ }
      }
      await rawJobPut({ status_name: NOSIT_STATUS_NAME }, "status");
      await jnPost("activities", {
        record_type_name: "Note",
        note: `🔴 Harvesting appointment marked NO SIT — needs to reschedule, by ${rep.name || "rep"}`,
        primary: { id: jobId, type: "job" }, related: [{ id: jobId, type: "job" }], is_status_change: false,
      }).catch(() => {});
    } catch (e) {
      jnFailed = true; jnErr = (e && e.message) || String(e);
      console.warn(`No-sit: JobNimbus refused status write on job ${jobId} — pin flipped anyway. ${jnErr}`);
    }
  }

  // ── Always flip the PIN so a bad JN job never leaves the rep stuck ────────
  const nowIso = new Date().toISOString();
  const log = Array.isArray(pin.status_log) ? [...pin.status_log] : [];
  log.push({ at: nowIso, from: pin.status, to: "no_sit_reschedule", by: rep.name || "rep", jn_job_id: jobId || undefined, ...(jnFailed ? { jn_sync_failed: true } : {}) });
  await fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${encodeURIComponent(pinId)}`, {
    method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
    body: JSON.stringify({ status: "no_sit_reschedule", status_updated_at: nowIso, status_by: rep.name || null, status_log: log }),
  }).catch(() => {});

  logActivity({ pin_id: pinId, rep_name: rep.name, rep_token: rt, kind: "status", from_status: pin.status, to_status: "no_sit_reschedule", ...(jnFailed ? { note: "JN sync failed — set no-sit in JobNimbus manually" } : {}) });
  return json(200, { ok: true, jn_synced: !jnFailed, ...(jnFailed ? { warning: "Set on your map — but JobNimbus wouldn't update this job. Set it to No Sit in JobNimbus manually.", jn_error: jnErr } : {}) });
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function logActivity(row) {
  fetch(`${SB_URL}/rest/v1/canvass_activity`, {
    method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(row),
  }).catch(() => {});
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
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
