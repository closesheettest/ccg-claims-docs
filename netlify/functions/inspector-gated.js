// netlify/functions/inspector-gated.js
//
// Inspector "Gated — need gate code" disposition. The roof can't be inspected
// right now because the property is behind a gate. The inspector logs the gate
// code (if they have it) or just flags that a code is needed. We KEEP the lead
// active (no result, not lost, not cancelled) so it can be inspected once the
// office/manager gets the code — we just:
//   • append a note to the inspection record (pa_notes_log, stage "gated"), and
//   • push a note to the JobNimbus job so the office sees it and can chase the code.
// No schema change — everything lives in pa_notes_log + JobNimbus.
//
// POST { inspectionId, note?, inspector_name? }  → { ok, jn_note_added }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const id = String(body.inspectionId || "").trim();
  const rawNote = String(body.note || "").trim();
  const who = String(body.inspector_name || "Inspector").trim();
  if (!id) return cors(400, JSON.stringify({ ok: false, error: "inspectionId required" }));
  const note = rawNote || "need gate code (not provided)";

  const rows = await sbGet(`inspections?id=eq.${encodeURIComponent(id)}&select=id,jn_job_id,pa_notes_log,client_name&limit=1`);
  const insp = rows[0];
  if (!insp) return cors(404, JSON.stringify({ ok: false, error: "Inspection not found" }));

  const nowIso = new Date().toISOString();
  const log = Array.isArray(insp.pa_notes_log) ? insp.pa_notes_log : [];
  log.push({ at: nowIso, text: `🔒 Gated — ${note} (logged by ${who})`, stage: "gated" });
  const up = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ pa_notes_log: log }),
  });
  if (!up.ok) return cors(500, JSON.stringify({ ok: false, error: `Save failed: ${(await up.text()).slice(0, 200)}` }));

  let jn_note_added = false;
  if (insp.jn_job_id && JN_KEY) {
    try {
      const nr = await fetch(`${JN_BASE}/notes`, {
        method: "POST",
        headers: { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ note: `🔒 GATED — inspector couldn't get in.\nGate code / access: ${note}\nLogged by ${who}. Get the code and re-dispatch.`, related: [{ id: insp.jn_job_id, type: "job" }] }),
      });
      jn_note_added = nr.ok;
    } catch { /* best-effort */ }
  }
  return cors(200, JSON.stringify({ ok: true, jn_note_added }));
};

async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
