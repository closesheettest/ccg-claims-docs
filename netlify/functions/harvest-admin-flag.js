// netlify/functions/harvest-admin-flag.js
//
// Get/set a harvest feature flag stored in CCG app_settings, so the TMS admin
// (separate app/DB) can control it. Allowlisted keys only.
//
//   GET  ?key=harvest_manager_map_enabled            → { ok, key, enabled }
//   POST { key, enabled: true|false }                → { ok, key, enabled }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
// key → default-when-unset (some flags default ON, some OFF).
const DEFAULT_ON = { harvest_manager_map_enabled: true, harvest_smart_scheduling_enabled: false, harvest_enhanced_planned_day_enabled: false };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, { ok: false, error: "env missing" });
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

  let key, setTo = null;
  if (event.httpMethod === "POST") {
    let body; try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, { ok: false, error: "bad JSON" }); }
    key = String(body.key || "").trim();
    setTo = body.enabled === true || body.enabled === "true";
  } else {
    key = String((event.queryStringParameters || {}).key || "").trim();
  }
  if (!(key in DEFAULT_ON)) return cors(400, { ok: false, error: "unknown flag" });

  if (setTo !== null) {
    const r = await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
      method: "POST", headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key, value: setTo ? "true" : "false", updated_at: new Date().toISOString() }),
    });
    if (!r.ok) return cors(500, { ok: false, error: await r.text().catch(() => "write failed") });
    return cors(200, { ok: true, key, enabled: setTo });
  }

  // Read
  const rows = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sb })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const v = rows[0]?.value;
  const enabled = v == null ? DEFAULT_ON[key] : String(v) !== "false";
  return cors(200, { ok: true, key, enabled });
};

function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}
