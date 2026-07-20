// netlify/functions/harvest-publish-plan.js
//
// Enhanced Planned Day — a manager publishes their zone's assignments: each Sr rep
// gets a cluster (ordered pin ids) for a given day. The rep's Start-my-day then loads
// it. Replaces any existing plan for that zone+date, so re-publishing is clean.
//
//   POST { zone, plan_date?, created_by, assignments:[{ rep_token, rep_name, cluster_index, pin_ids }] }
//   → { ok, published }
//
// CORS (TMS regional-manager dashboard calls it). Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, { ok: false, error: "POST only" });
  if (!SB_URL || !SB_KEY) return cors(500, { ok: false, error: "env missing" });
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, { ok: false, error: "bad JSON" }); }

  const zone = String(body.zone || "").trim();
  if (!zone) return cors(400, { ok: false, error: "zone required" });
  const planDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.plan_date || "")) ? body.plan_date : etToday();
  const createdBy = String(body.created_by || "").trim() || null;
  const assignments = Array.isArray(body.assignments) ? body.assignments : [];

  // Replace this zone+day's plan wholesale (clean re-publish / reassignment).
  const delRes = await fetch(`${SB_URL}/rest/v1/harvest_assignments?zone=eq.${encodeURIComponent(zone)}&plan_date=eq.${planDate}`, { method: "DELETE", headers: { ...sb, Prefer: "return=minimal" } });
  if (!delRes.ok) {
    const txt = (await delRes.text()).slice(0, 300);
    const hint = /harvest_assignments/.test(txt) && /(does not exist|schema cache|PGRST205)/i.test(txt) ? "Run sql/harvest_assignments.sql in the CCG Supabase SQL editor first." : undefined;
    return cors(502, { ok: false, error: `clear ${delRes.status}: ${txt}`, hint });
  }

  const rows = assignments
    .filter((a) => a && a.rep_token && Array.isArray(a.pin_ids) && a.pin_ids.length)
    .map((a) => ({ rep_token: String(a.rep_token), rep_name: a.rep_name || null, zone, plan_date: planDate, pin_ids: a.pin_ids, cluster_index: Number.isFinite(a.cluster_index) ? a.cluster_index : null, published: true, created_by: createdBy, updated_at: new Date().toISOString() }));

  if (!rows.length) return cors(200, { ok: true, published: 0, plan_date: planDate, note: "plan cleared (no rep clusters to publish)" });

  const insRes = await fetch(`${SB_URL}/rest/v1/harvest_assignments`, { method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(rows) });
  if (!insRes.ok) {
    const txt = (await insRes.text()).slice(0, 300);
    const hint = /relation .*harvest_assignments.* does not exist/i.test(txt) ? "Run sql/harvest_assignments.sql in Supabase first." : undefined;
    return cors(502, { ok: false, error: `publish ${insRes.status}: ${txt}`, hint });
  }
  return cors(200, { ok: true, published: rows.length, plan_date: planDate });
};

function etToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}
