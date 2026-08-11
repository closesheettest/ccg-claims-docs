// On/off switch for the Positive-Effort Contest leaderboard. The dashboard board
// and zone-contest-leaderboard both gate on app_settings.contest_enabled (bool), so
// flipping it here takes the board live (or hides it) with no deploy.
//
//   GET                  → { ok, enabled }
//   POST { on:<bool> }   → sets it, returns { ok, enabled }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const KEY = "contest_enabled";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));
  try {
    if (event.httpMethod === "GET") {
      return cors(200, JSON.stringify({ ok: true, enabled: await getBool(KEY) }));
    }
    if (event.httpMethod === "POST") {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
      await setSetting(KEY, !!body.on);
      return cors(200, JSON.stringify({ ok: true, enabled: !!body.on }));
    }
    return cors(405, JSON.stringify({ ok: false, error: "method" }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function getRaw(key) {
  try { const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sb }); if (!r.ok) return null; const rows = await r.json(); return rows[0]?.value ?? null; } catch { return null; }
}
async function getBool(key) { const v = await getRaw(key); try { return JSON.parse(v) === true; } catch { return v === "true"; } }
async function setSetting(key, obj) {
  await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: "POST", headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }),
  });
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
