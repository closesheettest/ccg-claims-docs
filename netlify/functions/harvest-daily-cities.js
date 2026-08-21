// netlify/functions/harvest-daily-cities.js
//
// Break a single sync day down BY CITY — what the Daily report can't do by team.
//
// A freshly synced IQ lead belongs to nobody: 20 of the 24 pins that landed on
// 20 Aug had no rep on them at all, because an unworked door hasn't been
// assigned yet. So there is no team to group by, and inferring one from
// geography would be a guess dressed up as a fact. City is the thing we actually
// know (Neal, 2026-08-21).
//
//   GET ?day=YYYY-MM-DD   (Eastern day)
//   → { ok, day, total, cities:[{ city, count, statuses:{} }], statuses:{} }
//
// COUNTS ARE OF PINS THAT STILL EXIST. The Daily report's "added" is a running
// tally stamped at insert time, and the dedupe pass later collapses twin pins —
// so this total is normally LOWER than the added figure, and the difference is
// pins that were merged away. Both numbers are true about different moments;
// the report shows both rather than quietly picking one.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

export const handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  const day = String((event.queryStringParameters || {}).day || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(400, { ok: false, error: "day=YYYY-MM-DD required" });

  // Eastern day → UTC window. ET is UTC-4 in season; the sync report is all ET.
  const start = `${day}T04:00:00Z`;
  const next = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const end = `${next}T04:00:00Z`;

  try {
    // Pins that LANDED that day = rows created that day, PLUS pins that already
    // existed as an inspection lead and were taken over by an IQ lead. A takeover
    // keeps its original created_at, so without the converted_at stamp it would
    // be invisible here even though it's a new IQ pin.
    const [fresh, converted] = await Promise.all([
      sbGetAll(
        `canvass_prospects?created_at=gte.${encodeURIComponent(start)}&created_at=lt.${encodeURIComponent(end)}` +
        `&select=city,state,status,list_name`,
      ),
      sbGetAll(
        `canvass_prospects?extra->>converted_at=gte.${encodeURIComponent(start)}&extra->>converted_at=lt.${encodeURIComponent(end)}` +
        `&created_at=lt.${encodeURIComponent(start)}&select=city,state,status,list_name`,
      ).catch(() => []),
    ]);
    const rows = [...fresh, ...converted];
    const byCity = new Map();
    const statuses = {};
    for (const r of rows) {
      const city = (r.city || "").trim() || "(no city)";
      const keyc = city.toUpperCase();
      let e = byCity.get(keyc);
      // Cities arrive in mixed case from JN ("DUNEDIN", "Dunedin") — group on the
      // upper-case key, show the tidiest spelling we saw.
      if (!e) byCity.set(keyc, (e = { city: title(city), count: 0, statuses: {} }));
      e.count += 1;
      e.statuses[r.status] = (e.statuses[r.status] || 0) + 1;
      statuses[r.status] = (statuses[r.status] || 0) + 1;
    }
    const cities = [...byCity.values()].sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));
    return json(200, { ok: true, day, total: rows.length, converted: converted.length, cities, statuses });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

function title(s) {
  return String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
async function sbGetAll(pathQuery, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const r = await fetch(`${SB_URL}/rest/v1/${pathQuery}`, { headers: { ...sbH, "Range-Unit": "items", Range: `${from}-${from + pageSize - 1}` } });
    if (!r.ok) break;
    const b = await r.json().catch(() => []);
    if (!Array.isArray(b) || !b.length) break;
    out.push(...b);
    if (b.length < pageSize) break;
  }
  return out;
}
function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}
