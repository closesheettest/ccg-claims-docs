// netlify/functions/harvest-team-history.js
//
// Office route-history: every rep's GPS trail for a chosen day (ET), so admin can
// replay where each rep drove. Same shape as harvest-team so the map can render
// the road-snapped trails with the existing team-view code, plus a per-rep summary
// (first/last ping, rough miles, active window).
//
//   GET/POST { admin, date:"YYYY-MM-DD", rep_id? }
//     → { ok, date, reps:[{ rep_id, name, pings:[{lat,lng,at}],
//          summary:{ count, first_at, last_at, miles, active_min } }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;

exports.handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  const p = event.httpMethod === "POST" ? safe(event.body) : (event.queryStringParameters || {});
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const sbGet = (path) => fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }).then((r) => (r.ok ? r.json() : [])).catch(() => []);

  const admin = String(p.admin || "").trim();
  const want = (await sbGet(`app_settings?key=eq.harvest_admin_token&select=value&limit=1`))[0]?.value;
  if (!admin || !want || admin !== want) return json(401, { ok: false, error: "admin only" });

  const date = String(p.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { ok: false, error: "date (YYYY-MM-DD) required" });
  // Florida is ET; -04:00 (EDT) covers the season reps are in the field. A winter
  // date is off by an hour at the day edges — acceptable for a route replay.
  const from = `${date}T00:00:00-04:00`;
  const [y, m, d] = date.split("-").map(Number);
  const nd = new Date(Date.UTC(y, m - 1, d + 1));
  const to = `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, "0")}-${String(nd.getUTCDate()).padStart(2, "0")}T00:00:00-04:00`;

  // High cap: at a 10s ping rate a full 8h day is ~2880 pings/rep, so a busy day
  // across many reps can be large. order=at.asc + too small a cap would drop the
  // END of the day, not the start.
  let q = `harvest_rep_pings?at=gte.${encodeURIComponent(from)}&at=lt.${encodeURIComponent(to)}&select=rep_id,rep_name,lat,lng,at&order=at.asc&limit=150000`;
  if (p.rep_id) q += `&rep_id=eq.${encodeURIComponent(String(p.rep_id))}`;
  const pings = await sbGet(q);

  const byRep = new Map();
  for (const pg of pings) {
    if (!Number.isFinite(pg.lat) || !Number.isFinite(pg.lng)) continue;
    const key = pg.rep_id || pg.rep_name;
    if (!byRep.has(key)) byRep.set(key, { rep_id: pg.rep_id, name: pg.rep_name || "Rep", pings: [] });
    byRep.get(key).pings.push({ lat: pg.lat, lng: pg.lng, at: pg.at });
  }

  const mi = (a, b) => {
    const R = 3958.8, toR = (x) => (x * Math.PI) / 180;
    const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };
  const reps = [...byRep.values()].map((r) => {
    const ps = r.pings;
    let miles = 0;
    for (let i = 1; i < ps.length; i++) {
      const seg = mi(ps[i - 1], ps[i]);
      const dtH = Math.max((Date.parse(ps[i].at) - Date.parse(ps[i - 1].at)) / 3.6e6, 1 / 3600);
      if (seg / dtH <= 85) miles += seg;   // skip impossible jumps (same rule as the trail)
    }
    const first = ps[0]?.at || null, last = ps[ps.length - 1]?.at || null;
    const active_min = first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 60000) : 0;
    return { ...r, summary: { count: ps.length, first_at: first, last_at: last, miles: Math.round(miles * 10) / 10, active_min } };
  }).sort((a, b) => (b.summary.miles - a.summary.miles));

  return json(200, { ok: true, date, reps });
};

function safe(b) { try { return JSON.parse(b || "{}"); } catch { return {}; } }
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) };
}
