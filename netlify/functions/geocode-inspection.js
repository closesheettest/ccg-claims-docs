// netlify/functions/geocode-inspection.js
//
// Geocode ONE inspection's address (address + city + state + zip) into
// lat/lng via Google Maps Geocoding API, then write the coords back to
// the inspection row. Used both:
//
//   • Auto-fired from App.jsx's submitInspection (after a successful
//     insert) as a fire-and-forget — so every new free-roof signing
//     gets lat/lng saved within ~500ms of the rep submitting. The
//     Inspector mobile app's "Available near me" then has distance
//     data immediately.
//
//   • Called per-row by bulk-geocode-inspections.js for backfilling
//     older rows that pre-date this feature.
//
// Skips re-geocoding if the inspection already has lat/lng (idempotent).
// Force-refresh path: pass { force: true } to re-geocode even when
// coords are already present.
//
// POST body: { inspectionId, force? }
// Response:  { ok: true, lat, lng, address } on success
//        or  { ok: true, skipped: true, reason: 'no_address' | 'already_geocoded' }
//        or  { ok: false, error: '...' }
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//               GOOGLE_MAPS_API_KEY.

const GOOGLE_BASE = "https://maps.googleapis.com/maps/api/geocode/json";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method Not Allowed" });
  }
  const missing = [];
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "GOOGLE_MAPS_API_KEY"]) {
    if (!process.env[k]) missing.push(k);
  }
  if (missing.length) return json(500, { error: `Missing env vars: ${missing.join(", ")}` });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const inspectionId = (body.inspectionId || "").trim();
  const force = !!body.force;
  if (!inspectionId) return json(400, { error: "inspectionId required" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };

  // 1. Fetch the inspection.
  const inspRes = await fetch(
    `${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}&select=id,address,city,state,zip,latitude,longitude&limit=1`,
    { headers: sbHeaders },
  );
  if (!inspRes.ok) {
    return json(500, { error: `Could not fetch inspection: ${await inspRes.text()}` });
  }
  const rows = await inspRes.json();
  const t = rows?.[0];
  if (!t) return json(404, { error: "Inspection not found" });

  // 2. Skip if already geocoded (unless forced).
  if (!force && typeof t.latitude === "number" && typeof t.longitude === "number") {
    return json(200, { ok: true, skipped: true, reason: "already_geocoded" });
  }

  // 3. Build the single-line address string Google geocoder accepts.
  const addr = buildAddress(t);
  if (!addr) {
    return json(200, { ok: true, skipped: true, reason: "no_address" });
  }

  // 4. Call Google.
  try {
    const url = new URL(GOOGLE_BASE);
    url.searchParams.set("address", addr);
    url.searchParams.set("region", "us");
    url.searchParams.set("key", process.env.GOOGLE_MAPS_API_KEY);
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
    const loc = data.results[0].geometry?.location;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
      return json(200, { ok: false, error: "No coords in Google response" });
    }

    // 5. Save coords back.
    const updRes = await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${inspectionId}`, {
      method: "PATCH",
      headers: sbHeaders,
      body: JSON.stringify({
        latitude: loc.lat,
        longitude: loc.lng,
      }),
    });
    if (!updRes.ok) {
      return json(500, { error: `Could not save lat/lng: ${await updRes.text()}` });
    }
    return json(200, { ok: true, lat: loc.lat, lng: loc.lng, address: addr });
  } catch (err) {
    return json(200, { ok: false, error: err.message || "Unknown" });
  }
};

function buildAddress(t) {
  const parts = [t.address, t.city, t.state, t.zip]
    .map((s) => (s ? String(s).trim() : ""))
    .filter(Boolean);
  if (parts.length < 2) return null;
  return parts.join(", ");
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
