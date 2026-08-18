// netlify/functions/inspection-visit-report.js
//
// The INSPECTOR ACTIVITY report: per inspector, per day, every roof they
// completed — with when they ARRIVED and COMPLETED it, the GPS distance from the
// roof (anti-fake-work), and the miles driven between stops in the order worked.
//
// ROOF COUNT COMES FROM `inspections`, NOT FROM THE VISIT LOG.
//
// It used to be built entirely from inspection_visits, which only gets rows when
// an inspector works a pin through the inspection MAP (arrive → complete). So it
// was really measuring map usage while being read as productivity. James Harris
// completed 51 roofs in two weeks — 27 in one week — and the report credited him
// 13, because he had 15 visit rows on two days. Meanwhile 143 of the table's 160
// rows belonged to one inspector, who therefore looked like the only one working
// (reported by James via Neal, 2026-08-18).
//
// So: the work is the inspections he submitted. The visit log is an OVERLAY that
// adds arrival time, GPS distance and driving order where it exists. A roof with
// no visit row still counts — it just shows no GPS, which is a visible prompt to
// use the map rather than a silent erasure of a day's work.
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

    // THE WORK: every inspection completed in the window that has an inspector on
    // it. result_at is when the result was recorded; inspection_date is the
    // fallback for older rows that predate it.
    const done = await sbGetAll(
      `inspections?result_at=gte.${encodeURIComponent(since)}&inspector_name=not.is.null&cancelled_at=is.null` +
      `&select=id,client_name,address,city,latitude,longitude,inspector_name,result,result_at,inspection_date&order=result_at.asc`
    );

    // Roof detail for anything the visit log references but the window above
    // missed (e.g. a visit today on a roof completed last month).
    const insp = {};
    for (const r of done) insp[r.id] = r;
    const missing = [...new Set(visits.map((v) => v.inspection_id).filter((id) => id && !insp[id]))];
    for (let i = 0; i < missing.length; i += 100) {
      const rows = await sbGetAll(`inspections?id=in.(${missing.slice(i, i + 100).join(",")})&select=id,client_name,address,city,latitude,longitude,inspector_name,result,result_at,inspection_date`);
      for (const r of rows) insp[r.id] = r;
    }

    // The visit overlay, keyed by inspection: arrival, completion, GPS distance.
    const vis = {};
    for (const v of visits) {
      if (!v.inspection_id) continue;
      const o = vis[v.inspection_id] || (vis[v.inspection_id] = { first: v.at, last: v.at, arrived: null, completed: null, dist: null, name: v.inspector_name || null });
      o.last = v.at; if (v.at < o.first) o.first = v.at;
      if (v.event === "arrived") o.arrived = v.at;
      if (v.event === "completed") o.completed = v.at;
      if (v.dist_ft != null && o.dist == null) o.dist = v.dist_ft;
      if (!o.name && v.inspector_name) o.name = v.inspector_name;
    }

    // inspector → day → roofs. Driven by the inspections, so a roof counts whether
    // or not it was worked through the map.
    const byInsp = {};
    const seen = new Set();
    const addRoof = (name, day, id, at) => {
      if (!name || !day || seen.has(id)) return;
      seen.add(id);
      const I = byInsp[name] || (byInsp[name] = {});
      const D = I[day] || (I[day] = { roofs: [] });
      D.roofs.push({ id, at });
    };
    for (const r of done) {
      const when = r.result_at || r.inspection_date;
      if (!when) continue;
      // The visit log wins on WHEN it was worked — it's the real on-site time,
      // where result_at can be recorded later from the truck.
      const v = vis[r.id];
      const at = (v && (v.completed || v.arrived || v.first)) || when;
      addRoof(r.inspector_name, etDay(at), r.id, at);
    }
    // A roof worked through the map but completed outside the window still belongs
    // to the day it was worked.
    for (const [id, v] of Object.entries(vis)) {
      const r = insp[id];
      if (!r) continue;
      const at = v.completed || v.arrived || v.first;
      addRoof(r.inspector_name || v.name, etDay(at), id, at);
    }

    const inspectors = [];
    for (const [name, days2] of Object.entries(byInsp)) {
      const day_list = []; let totRoofs = 0, totMiles = 0, totGps = 0;
      for (const [day, D] of Object.entries(days2)) {
        const stops = D.roofs
          .sort((a, b) => (a.at || "").localeCompare(b.at || ""))
          .map((s) => {
            const r = insp[s.id] || {};
            const v = vis[s.id] || null;
            return {
              address: r.address || null, city: r.city || null, name: r.client_name || null,
              lat: r.latitude, lng: r.longitude,
              result: r.result || null,
              arrived: (v && (v.arrived || v.first)) || null,
              completed: (v && v.completed) || r.result_at || null,
              dist_ft: v && v.dist != null ? Math.round(v.dist) : null,
              // false = submitted without working the pin on the map. The roof
              // still counts; this is what tells a manager to nudge them.
              on_map: !!v,
            };
          });
        let miles = 0; const legs = [];
        for (let k = 1; k < stops.length; k++) {
          const m = milesBetween({ lat: stops[k - 1].lat, lng: stops[k - 1].lng }, { lat: stops[k].lat, lng: stops[k].lng }) * 1.3;
          miles += m; legs.push(r1(m));
        }
        const gps = stops.filter((s) => s.on_map).length;
        totRoofs += stops.length; totMiles += miles; totGps += gps;
        day_list.push({
          date: day, roofs: stops.length, on_map: gps, miles: r1(miles),
          first: stops[0]?.arrived || stops[0]?.completed || null,
          last: stops[stops.length - 1]?.completed || stops[stops.length - 1]?.arrived || null,
          stops: stops.map((s, i) => ({ ...s, leg_from_prev: i > 0 ? legs[i - 1] : null })),
        });
      }
      day_list.sort((a, b) => b.date.localeCompare(a.date));
      inspectors.push({ inspector: name, roofs: totRoofs, days: day_list.length, miles: r1(totMiles), on_map: totGps, day_list });
    }
    inspectors.sort((a, b) => b.roofs - a.roofs);
    return cors(200, JSON.stringify({ ok: true, generated_at: new Date().toISOString(), inspectors }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
