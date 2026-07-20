// netlify/functions/harvest-plan-progress.js
//
// Enhanced Planned Day — how each rep is doing on TODAY's published assignment.
// For every rep with a plan in this zone, count assigned vs worked (a pin is "worked"
// once it leaves the raw workable set — iq/fb/ai/no_sit — because statusing it moves it
// to iq_ni/dead/appt/insp_sold/etc.). Shows the manager who's on it and who's stalled.
//
//   GET ?zone=<zone>[&plan_date=YYYY-MM-DD]
//   → { ok, zone, plan_date, reps:[{ rep_name, rep_token, assigned, worked, remaining }] }
//
// CORS (TMS dashboard). Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const RAW = new Set(["iq", "fb", "ai", "no_sit_reschedule"]); // not-yet-worked statuses

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, { ok: false, error: "env missing" });
  const p = event.queryStringParameters || {};
  const zone = String(p.zone || "").trim();
  if (!zone) return cors(400, { ok: false, error: "zone required" });
  const planDate = /^\d{4}-\d{2}-\d{2}$/.test(String(p.plan_date || "")) ? p.plan_date : etToday();

  try {
    const plans = await sbGet(`harvest_assignments?zone=eq.${encodeURIComponent(zone)}&plan_date=eq.${planDate}&published=eq.true&select=rep_token,rep_name,pin_ids`);
    if (!plans.length) return cors(200, { ok: true, zone, plan_date: planDate, reps: [] });

    // One status lookup for every assigned pin across the zone.
    const allIds = [...new Set(plans.flatMap((r) => (Array.isArray(r.pin_ids) ? r.pin_ids : [])))];
    const statusById = {};
    for (let i = 0; i < allIds.length; i += 200) {
      const chunk = allIds.slice(i, i + 200).map(encodeURIComponent).join(",");
      const rows = await sbGet(`canvass_prospects?id=in.(${chunk})&select=id,status`).catch(() => []);
      for (const r of rows) statusById[r.id] = r.status;
    }

    const reps = plans.map((pl) => {
      const ids = Array.isArray(pl.pin_ids) ? pl.pin_ids : [];
      let worked = 0;
      for (const id of ids) { const st = statusById[id]; if (st && !RAW.has(st)) worked += 1; }
      return { rep_name: pl.rep_name || "(rep)", rep_token: pl.rep_token, assigned: ids.length, worked, remaining: ids.length - worked };
    }).sort((a, b) => (a.worked / (a.assigned || 1)) - (b.worked / (b.assigned || 1))); // stalled first
    return cors(200, { ok: true, zone, plan_date: planDate, reps });
  } catch (e) { return cors(200, { ok: true, zone, plan_date: planDate, reps: [], error: String(e && e.message || e) }); }
};

function etToday() { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) throw new Error(String(r.status)); return r.json(); }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: typeof body === "string" ? body : JSON.stringify(body) }; }
