// netlify/functions/referral-list.js
//
// The referrals a rep has captured (on No-Damage visits) — powers the
// "Referrals" screen of the visit hub: who to go sign up + who referred them.
// View-only.
//
// POST { token, rep_name? }
//   → { ok, referrals: [{ id, referral_name, referral_phone, referral_address,
//        referred_by_name, captured_by_rep, created_at }] }
//   (rep_name filters to that rep's captures; omit/blank → all, newest first)
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const repName = String(body.rep_name || "").trim();
  try {
    const sel = "id,referral_name,referral_phone,referral_address,referred_by_name,captured_by_rep,created_at";
    let path = `referrals?select=${sel}&order=created_at.desc&limit=500`;
    if (repName) path += `&captured_by_rep=eq.${q(repName)}`;
    const rows = await sbGet(path);
    return cors(200, JSON.stringify({ ok: true, referrals: rows }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

const q = (s) => encodeURIComponent(`"${String(s).replace(/"/g, '\\"')}"`);
async function okToken(token) {
  token = String(token || "").trim();
  if (!token) return false;
  const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]);
  return token === d || token === v;
}
async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0]?.value || null;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
