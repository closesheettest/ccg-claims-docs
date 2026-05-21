// Geocode a free-text place name or address into lat/lng via Google
// Maps Geocoding API. Used by the Inspectors admin page to autofill
// an inspector's home-base coords from their address — admin doesn't
// have to look up coordinates by hand.
//
// POST body: { query: "123 Main St, Tampa, FL 33606" }
// Response:  { ok: true, lat, lng, formatted_address }
//        or  { ok: false, error: "..." }
//
// Required env: GOOGLE_MAPS_API_KEY (server-side key — must allow the
// Geocoding API; if you've restricted to HTTP referrers it'll fail
// when called from a serverless function).

const GOOGLE_BASE = "https://maps.googleapis.com/maps/api/geocode/json";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method Not Allowed" });
  }
  const googleKey = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_PLACES_API_KEY;
  if (!googleKey) {
    return json(500, { error: "Missing GOOGLE_MAPS_API_KEY (or VITE_GOOGLE_PLACES_API_KEY)" });
  }
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const query = (body.query || "").toString().trim();
  if (!query) return json(400, { error: "query required" });

  try {
    const url = new URL(GOOGLE_BASE);
    url.searchParams.set("address", query);
    url.searchParams.set("region", "us");
    url.searchParams.set("key", googleKey);
    const res = await fetch(url.toString());
    if (!res.ok) {
      return json(200, { ok: false, error: `Google ${res.status}` });
    }
    const data = await res.json().catch(() => ({}));
    if (data.status !== "OK" || !Array.isArray(data.results) || data.results.length === 0) {
      return json(200, {
        ok: false,
        error: `Google status: ${data.status || "unknown"}${data.error_message ? ` — ${data.error_message}` : ""}`,
      });
    }
    const top = data.results[0];
    const loc = top.geometry?.location;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
      return json(200, { ok: false, error: "No coords in Google response" });
    }
    return json(200, {
      ok: true,
      lat: loc.lat,
      lng: loc.lng,
      formatted_address: top.formatted_address || null,
    });
  } catch (err) {
    return json(200, { ok: false, error: err.message || "Unknown" });
  }
};

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
