// netlify/functions/referral-resolve.js
//
// Drop a referral off the rep's Referrals list once it's handled — either the
// rep SIGNED them up (they're in the normal flow now) or they're NOT INTERESTED.
// No JobNimbus push: a referral is just a name a homeowner gave us, never a JN
// record until/unless they actually sign (which runs the normal intake).
//
//   POST { token, referral_id, outcome, rep_name? }   outcome = 'signed' | 'not_interested'
//   → { ok }
//
// Token: app_settings dialer_token OR visit_token.
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const OUTCOMES = new Set(["signed", "not_interested"]);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const id = String(body.referral_id || "").trim();
  const outcome = String(body.outcome || "").trim();
  if (!id || !OUTCOMES.has(outcome)) return cors(400, JSON.stringify({ ok: false, error: "referral_id + valid outcome required" }));

  const r = await fetch(`${SB_URL}/rest/v1/referrals?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
    body: JSON.stringify({ outcome, resolved_at: new Date().toISOString(), resolved_by: String(body.rep_name || "").trim() || null }),
  });
  if (!r.ok) return cors(500, JSON.stringify({ ok: false, error: `save failed (${r.status})` }));
  return cors(200, JSON.stringify({ ok: true }));
};

async function okToken(token) {
  token = String(token || "").trim();
  if (!token) return false;
  const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]);
  return (!!d && token === d) || (!!v && token === v);
}
async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0]?.value || null;
}
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
