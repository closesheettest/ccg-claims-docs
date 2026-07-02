// netlify/functions/pa-add-note.js
//
// A Public Adjuster adds a note to a customer (and optionally changes the
// deal's stage). The note is:
//   1. appended to inspections.pa_notes_log (jsonb running log), and
//   2. posted to the linked JobNimbus job's notes (POST /activities) so it
//      shows up in JN too — same activity shape used by push-cancel-to-jn.js.
//
// Also powers the "Can't get ahold of them" and "Dead Deal" actions: pass
// stage='no_contact' or stage='dead' and the deal's pa_stage flips (it then
// moves to the can't-reach bucket / drops off the PA's active list). Those
// notes are prefixed so they read clearly in JobNimbus.
//
// POST body: { inspectionId, paId, text, stage? }
//   stage ∈ 'active' | 'no_contact' | 'waiting_docs' | 'dead' (optional)
// Response: { ok, jn_note_added, stage, note_count }.
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
import { jnFetch } from "./_jn.js";
// waiting_docs = PA is blocked until the homeowner sends their insurance
// declaration page (can't have them sign anything without it). Same model
// as no_contact: deal stays assigned, just moves to its own bucket.
const STAGES = ["active", "no_contact", "waiting_docs", "dead"];

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "JOBNIMBUS_API_KEY"]) {
    if (!process.env[k]) return json(500, { ok: false, error: `Missing env: ${k}` });
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON" }); }
  const inspectionId = (body.inspectionId || "").trim();
  const paId = (body.paId || "").trim();
  const text = (body.text || "").trim();
  const stage = body.stage ? String(body.stage).trim() : null;

  if (!inspectionId) return json(400, { ok: false, error: "inspectionId required" });
  if (stage && !STAGES.includes(stage)) return json(400, { ok: false, error: `stage must be one of ${STAGES.join(", ")}` });
  if (!text && !stage) return json(400, { ok: false, error: "Nothing to do — provide text and/or stage" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const JN_KEY = process.env.JOBNIMBUS_API_KEY;
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

  // 1. Load + verify ownership.
  const rows = await (await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}&select=id,jn_job_id,pa_id,pa_notes_log,client_name&limit=1`,
    { headers: sb },
  )).json().catch(() => []);
  const insp = rows?.[0];
  if (!insp) return json(404, { ok: false, error: "Inspection not found" });
  if (paId && insp.pa_id && insp.pa_id !== paId) return json(403, { ok: false, error: "This deal belongs to a different PA" });

  // 2. Build the patch: append to the running log + optional stage change.
  const nowIso = new Date().toISOString();
  const patch = {};
  if (text) {
    const log = Array.isArray(insp.pa_notes_log) ? insp.pa_notes_log : [];
    log.push({ at: nowIso, text, stage: stage || null });
    patch.pa_notes_log = log;
  }
  if (stage) { patch.pa_stage = stage; patch.pa_stage_at = nowIso; }

  const upRes = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}`, {
    method: "PATCH",
    headers: { ...sb, Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  if (!upRes.ok) return json(500, { ok: false, error: `Save failed: ${(await upRes.text()).slice(0, 200)}` });
  const saved = (await upRes.json().catch(() => []))[0] || {};

  // 3. Mirror the note into JobNimbus (best-effort — local save already done).
  let jnNoteAdded = false, jnError = null;
  if (insp.jn_job_id && (text || stage)) {
    const prefix = stage === "dead" ? "💀 Dead deal (PA)" : stage === "no_contact" ? "📵 Can't reach (PA)" : stage === "waiting_docs" ? "📄 Waiting on docs (PA)" : "📝 PA note";
    const noteText = `${prefix}${text ? `: ${text}` : ""}`;
    try {
      const r = await jnFetch(JN_KEY, `activities`, {
        method: "POST",
        body: JSON.stringify({
          record_type_name: "Note",
          note: noteText,
          primary: { id: insp.jn_job_id, type: "job" },
          related: [{ id: insp.jn_job_id, type: "job" }],
          is_status_change: false,
        }),
      });
      if (r.ok) jnNoteAdded = true;
      else jnError = `JN note POST ${r.status}: ${(await r.text()).slice(0, 160)}`;
    } catch (e) { jnError = e.message; }
  }

  return json(200, {
    ok: true,
    stage: saved.pa_stage ?? null,
    note_count: Array.isArray(saved.pa_notes_log) ? saved.pa_notes_log.length : 0,
    jn_note_added: jnNoteAdded,
    jn_error: jnError,
  });
};

function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
