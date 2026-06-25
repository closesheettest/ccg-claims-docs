// netlify/functions/referral-decline.js
//
// No-Damage visit: the homeowner doesn't want to give a referral. Cataloged
// LOCALLY (inspections.referral_outcome = 'declined') for the referral funnel
// report — NOT pushed to JobNimbus. A non-null referral_outcome also drops the
// deal off the rep's No-Damage visit list. (referral COUNTS live in the
// `referrals` table, written by no-damage-send.)
//
// POST { token, inspection_id, rep_name? } → { ok, referral_outcome }
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

  const inspectionId = String(body.inspection_id || "").trim();
  if (!inspectionId) return cors(400, JSON.stringify({ ok: false, error: "inspection_id required" }));

  const r = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspectionId)}`, {
    method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
    body: JSON.stringify({ referral_outcome: "declined" }),
  });
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 200);
    const hint = /referral_outcome/.test(txt) ? " (run sql/referral_outcome.sql first)" : "";
    return cors(502, JSON.stringify({ ok: false, error: `save ${r.status}: ${txt}${hint}` }));
  }
  return cors(200, JSON.stringify({ ok: true, referral_outcome: "declined" }));
};

async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0] ? rows[0].value : null;
}
async function okToken(token) {
  token = String(token || "").trim();
  if (!token) return false;
  const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]);
  return token === d || token === v;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
