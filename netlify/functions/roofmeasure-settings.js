// netlify/functions/roofmeasure-settings.js
//
// The two switches that gate the rep-facing Roof Measurement tool:
//   • COMPANY master (admin)        → app_settings.roofmeasure_company_enabled  (bool)
//   • PER-REP (regional manager)    → app_settings.roofmeasure_reps  = { <rep jobnimbus_id>: true }
// A rep sees "Measure Roof" only when the company switch is ON *and* their own
// switch is ON. Both default OFF (a missing flag = off).
//
//   GET  ?scope=admin           → { ok, company_enabled, reps:[{jn_id,name,zone,enabled}] }  (every zone — admin)
//   GET  ?zone=Zone%202         → { ok, company_enabled, reps:[…that zone…] }               (a manager's dashboard)
//   GET  ?rep=<jobnimbus_id>    → { ok, company_enabled, enabled }                          (the rep map's gate check)
//   POST { action:'company', on:<bool>, admin:<token?> }   → flip the master switch
//   POST { action:'rep', rep_jn_id:<id>, on:<bool> }       → flip one rep's switch
//
// Open-CORS like the sibling zone-* / manager feeds. Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
const COMPANY_KEY = "roofmeasure_company_enabled";
const REPS_KEY = "roofmeasure_reps";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  try {
    if (event.httpMethod === "GET") {
      const qp = event.queryStringParameters || {};
      const company = await getBool(COMPANY_KEY);
      // Rep map gate: is THIS rep allowed? (company AND their own flag)
      if (qp.rep) {
        const map = await getMap(REPS_KEY);
        return cors(200, JSON.stringify({ ok: true, company_enabled: company, enabled: company && !!map[qp.rep] }));
      }
      // Dashboard list: reps + their per-rep flags, scoped to a zone (manager) or all (admin).
      const zone = String(qp.zone || "").trim();
      const scope = String(qp.scope || "").trim();
      const reps = await fetchReps();
      const map = await getMap(REPS_KEY);
      const list = reps
        .filter((r) => r.active && r.jobnimbus_id && (scope === "admin" ? true : zone && r.zone === zone))
        .map((r) => ({ jn_id: r.jobnimbus_id, name: r.name, zone: r.zone, enabled: !!map[r.jobnimbus_id] }))
        .sort((a, b) => String(a.zone || "").localeCompare(String(b.zone || "")) || String(a.name || "").localeCompare(String(b.name || "")));
      return cors(200, JSON.stringify({ ok: true, company_enabled: company, reps: list }));
    }

    if (event.httpMethod === "POST") {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }

      if (body.action === "company") {
        // Toggled from the PIN-gated admin dashboard (Manager Settings), so no extra
        // token here — consistent with the other anon-key harvest endpoints.
        await setSetting(COMPANY_KEY, !!body.on);
        return cors(200, JSON.stringify({ ok: true, company_enabled: !!body.on }));
      }
      if (body.action === "rep") {
        const jn = String(body.rep_jn_id || "").trim();
        if (!jn) return cors(400, JSON.stringify({ ok: false, error: "rep_jn_id required" }));
        const map = await getMap(REPS_KEY);
        if (body.on) map[jn] = true; else delete map[jn];
        await setSetting(REPS_KEY, map);
        return cors(200, JSON.stringify({ ok: true, rep_jn_id: jn, enabled: !!body.on }));
      }
      return cors(400, JSON.stringify({ ok: false, error: "unknown action" }));
    }

    return cors(405, JSON.stringify({ ok: false, error: "method" }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function fetchReps() { try { const r = await fetch(REP_ZONES_URL); if (r.ok) return (await r.json()).reps || []; } catch { /* best-effort */ } return []; }
async function getRaw(key) {
  try { const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sb }); if (!r.ok) return null; const rows = await r.json(); return rows[0]?.value ?? null; } catch { return null; }
}
async function getBool(key) { const v = await getRaw(key); try { return JSON.parse(v) === true; } catch { return v === "true"; } }
async function getMap(key) { const v = await getRaw(key); try { const o = JSON.parse(v); return o && typeof o === "object" ? o : {}; } catch { return {}; } }
async function setSetting(key, obj) {
  await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: "POST", headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }),
  });
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
