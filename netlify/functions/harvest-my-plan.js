// netlify/functions/harvest-my-plan.js
//
// A rep's published Enhanced Planned Day assignment for today — the pin ids their
// manager assigned them. The rep map calls this; if the rep has a plan, Start-my-day
// routes exactly those doors. Returns empty (never errors) when Enhanced mode is off,
// there's no plan, or anything fails — so the map always falls back to normal.
//
//   GET ?rt=<harvest_token> → { ok, plan_date, pin_ids, count }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");
  const rt = String((event.queryStringParameters || {}).rt || "").trim();
  const today = etToday();
  const empty = { ok: true, plan_date: today, pin_ids: [], count: 0 };
  if (!rt || !SB_URL || !SB_KEY) return json(200, empty);
  try {
    // Enhanced mode must be ON for a plan to apply (a stale plan shouldn't route reps).
    const flag = (await sbGet(`app_settings?key=eq.harvest_enhanced_planned_day_enabled&select=value&limit=1`))[0];
    if (!flag || String(flag.value) !== "true") return json(200, empty);

    const rows = await sbGet(`harvest_assignments?rep_token=eq.${encodeURIComponent(rt)}&plan_date=eq.${today}&published=eq.true&select=pin_ids,cluster_index,rep_name&limit=1`);
    const pin_ids = rows[0] && Array.isArray(rows[0].pin_ids) ? rows[0].pin_ids : [];
    return json(200, { ok: true, plan_date: today, pin_ids, count: pin_ids.length });
  } catch { return json(200, empty); }
};

function etToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }
function json(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: typeof body === "string" ? body : JSON.stringify(body) }; }
