// netlify/functions/inspection-visit-report.js
//
// The INSPECTOR ACTIVITY report from the real visit log (inspection_visits) — the
// pin-by-pin, timestamped truth the estimate-based report couldn't give: per
// inspector, per day, each roof with when they ARRIVED and COMPLETED it, the GPS
// distance from the roof (anti-fake-work), and the miles driven between stops in
// the actual order they worked them.
//
//   GET /.netlify/functions/inspection-visit-report[?days=30]
//   → { ok, generated_at, inspectors:[{ inspector, roofs, days, miles, day_list:[...] }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

async function sbGetAll(pathQuery, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const r = await fetch(`${SB_URL}/rest/v1/${pathQuery}`, { headers: { ...sbH, "Range-Unit": "items", Range: `${from}-${from + pageSize - 1}` } });
    if (!r.ok) break; const b = await r.json().catch(() => []);
    if (!Array.isArray(b) || !b.length) break; out.push(...b); if (b.length < pageSize) break;
  }
  return out;
}
const milesBetween = (a, b) => { if (!a || !b || a.lat == null || b.lat == null) return 0; const R = 3958.8, tr = (d) => (d * Math.PI) / 180; const dLat = tr(b.lat - a.lat), dLng = tr(b.lng - a.lng); const h = Math.sin(dLat / 2) ** 2 + Math.cos(tr(a.lat)) * Math.cos(tr(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))); };
const r1 = (x) => Math.round(x * 10) / 10;
const etDay = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing Supabase env" }));
  try {
    const days = Math.min(Math.max(parseInt((event.queryStringParameters || {}).days, 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
    const visits = await sbGetAll(`inspection_visits?at=gte.${encodeURIComponent(since)}&select=inspection_id,inspector_id,inspector_name,event,latitude,longitude,dist_ft,at&order=at.asc`);
    if (!visits.length) return cors(200, JSON.stringify({ ok: true, generated_at: new Date().toISOString(), inspectors: [] }));

    // Resolve roof address/city/coords for the visited inspections.
    const ids = [...new Set(visits.map((v) => v.inspection_id).filter(Boolean))];
    const insp = {};
    for (let i = 0; i < ids.length; i += 100) { const rows = await sbGetAll(`inspections?id=in.(${ids.slice(i, i + 100).join(",")})&select=id,client_name,address,city,latitude,longitude`); for (const r of rows) insp[r.id] = r; }

    // inspector → day → inspection_id → { arrived, completed, dist }
    const byInsp = {};
    for (const v of visits) {
      const name = v.inspector_name || "(unknown)";
      const day = etDay(v.at);
      const I = byInsp[name] || (byInsp[name] = {});
      const D = I[day] || (I[day] = { roofs: {} });
      const key = v.inspection_id || `~${v.at}`;
      const roof = D.roofs[key] || (D.roofs[key] = { id: v.inspection_id, first: v.at, last: v.at, arrived: null, completed: null, dist: v.dist_ft });
      roof.last = v.at; if (v.at < roof.first) roof.first = v.at;
      if (v.event === "arrived") roof.arrived = v.at;
      if (v.event === "completed") roof.completed = v.at;
      if (v.dist_ft != null && roof.dist == null) roof.dist = v.dist_ft;
    }

    const inspectors = [];
    for (const [name, days2] of Object.entries(byInsp)) {
      const day_list = []; let totRoofs = 0, totMiles = 0;
      for (const [day, D] of Object.entries(days2)) {
        // stops in the ACTUAL order worked (by first-touch time)
        const stops = Object.values(D.roofs).sort((a, b) => (a.first || "").localeCompare(b.first || "")).map((s) => {
          const r = insp[s.id] || {};
          return { address: r.address || null, city: r.city || null, name: r.client_name || null, lat: r.latitude, lng: r.longitude, arrived: s.arrived || s.first, completed: s.completed || null, dist_ft: s.dist != null ? Math.round(s.dist) : null };
        });
        let miles = 0; const legs = [];
        for (let k = 1; k < stops.length; k++) { const m = milesBetween({ lat: stops[k - 1].lat, lng: stops[k - 1].lng }, { lat: stops[k].lat, lng: stops[k].lng }) * 1.3; miles += m; legs.push(r1(m)); }
        totRoofs += stops.length; totMiles += miles;
        day_list.push({ date: day, roofs: stops.length, miles: r1(miles), first: stops[0]?.arrived || null, last: stops[stops.length - 1]?.completed || stops[stops.length - 1]?.arrived || null, stops: stops.map((s, i) => ({ ...s, leg_from_prev: i > 0 ? legs[i - 1] : null })) });
      }
      day_list.sort((a, b) => b.date.localeCompare(a.date));
      inspectors.push({ inspector: name, roofs: totRoofs, days: day_list.length, miles: r1(totMiles), day_list });
    }
    inspectors.sort((a, b) => b.roofs - a.roofs);
    return cors(200, JSON.stringify({ ok: true, generated_at: new Date().toISOString(), inspectors }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
