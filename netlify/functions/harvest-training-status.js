// netlify/functions/harvest-training-status.js
//
// Has this user passed a Harvest training track? Lets the TMS manager dashboard
// (separate app) gate its harvest tools on the manager's certification.
//
//   GET ?user_type=manager&user_key=<token>   → { ok, passed }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, { ok: false, error: "env missing" });
  const p = event.queryStringParameters || {};
  const userType = String(p.user_type || "").trim();
  const userKey = String(p.user_key || "").trim();
  if (!userType || !userKey) return cors(400, { ok: false, error: "user_type + user_key required" });
  try {
    const rows = await fetch(
      `${SB_URL}/rest/v1/harvest_training_results?user_type=eq.${encodeURIComponent(userType)}&user_key=eq.${encodeURIComponent(userKey)}&passed=eq.true&select=id&limit=1`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } },
    ).then((r) => (r.ok ? r.json() : null));
    // On any error (e.g. training table not set up) → don't lock people out.
    return cors(200, { ok: true, passed: rows == null ? true : rows.length > 0 });
  } catch { return cors(200, { ok: true, passed: true }); }
};

function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}
