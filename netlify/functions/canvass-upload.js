// netlify/functions/canvass-upload.js
//
// Bulk-add prospects to the canvassing map. The office pastes/uploads a list of
// addresses; we geocode each with Google and insert it as status 'iq'. Reads/
// status-updates happen client-side via the anon key — this function only
// handles the geocode-heavy ingest so it doesn't block the browser.
//
// POST { list_name?, rows: [{ address, name?, city?, state?, zip? }] }
//   (also accepts rows as plain strings, one full address each)
// → { ok, inserted, geocoded, failed, list_name }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, GOOGLE_MAPS_API_KEY
//      (or VITE_GOOGLE_PLACES_API_KEY)

const GOOGLE_BASE = "https://maps.googleapis.com/maps/api/geocode/json";
const MAX_ROWS = 400;       // cap per call to stay under the function timeout
const CONCURRENCY = 5;      // parallel geocode requests

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const googleKey = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_PLACES_API_KEY;
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });
  if (!googleKey) return json(500, { ok: false, error: "Missing GOOGLE_MAPS_API_KEY" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON body" }); }

  const listName = (body.list_name || "").toString().trim() || `List ${new Date().toISOString().slice(0, 10)}`;
  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  if (!rawRows.length) return json(400, { ok: false, error: "rows required" });

  // Normalize: a row can be a plain address string or an object.
  const rows = rawRows
    .map((r) => (typeof r === "string" ? { address: r } : r || {}))
    .map((r) => ({
      name: (r.name || "").toString().trim() || null,
      address: (r.address || "").toString().trim(),
      city: (r.city || "").toString().trim() || null,
      state: (r.state || "").toString().trim() || null,
      zip: (r.zip || "").toString().trim() || null,
    }))
    .filter((r) => r.address)
    .slice(0, MAX_ROWS);
  if (!rows.length) return json(400, { ok: false, error: "no usable addresses" });

  // Geocode with small concurrency so one big list doesn't hammer Google.
  let geocoded = 0, failed = 0;
  const out = new Array(rows.length);
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const i = cursor++;
      const r = rows[i];
      const query = [r.address, r.city, r.state, r.zip].filter(Boolean).join(", ");
      const g = await geocode(query, googleKey);
      if (g.ok) geocoded++; else failed++;
      out[i] = {
        list_name: listName,
        name: r.name,
        address: r.address, city: r.city, state: r.state, zip: r.zip,
        latitude: g.ok ? g.lat : null,
        longitude: g.ok ? g.lng : null,
        geocode_status: g.ok ? "ok" : "failed",
        status: "iq",
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  // One bulk insert.
  const ins = await fetch(`${SB_URL}/rest/v1/canvass_prospects`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(out),
  });
  if (!ins.ok) return json(500, { ok: false, error: `Insert failed: ${(await ins.text()).slice(0, 200)}` });

  return json(200, { ok: true, inserted: out.length, geocoded, failed, list_name: listName });
};

async function geocode(query, key) {
  try {
    const url = new URL(GOOGLE_BASE);
    url.searchParams.set("address", query);
    url.searchParams.set("region", "us");
    url.searchParams.set("key", key);
    const res = await fetch(url.toString());
    if (!res.ok) return { ok: false };
    const data = await res.json().catch(() => ({}));
    const loc = data.results?.[0]?.geometry?.location;
    if (data.status !== "OK" || !loc || typeof loc.lat !== "number") return { ok: false };
    return { ok: true, lat: loc.lat, lng: loc.lng };
  } catch { return { ok: false }; }
}

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
