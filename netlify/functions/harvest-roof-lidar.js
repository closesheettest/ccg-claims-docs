// netlify/functions/harvest-roof-lidar.js
//
// Thin proxy to the Cloud Run LiDAR cross-check (the 3rd teammate). Keeps the service
// URL server-side, adds CORS, and — crucially — is SAFE before the service exists: if
// LIDAR_SERVICE_URL isn't set (or the call fails/times out), it returns a graceful
// {ok:false} miss so the Team Read simply stays a 2-vote duo. The moment you deploy the
// container and set LIDAR_SERVICE_URL in Netlify, LiDAR starts voting automatically.
//
//   POST { lat, lng, pitch } -> { ok, status, squares, ... }  (ESM — package type:module)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (code, obj) => ({ statusCode: code, headers: { ...CORS, "Content-Type": "application/json" }, body: JSON.stringify(obj) });

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });

  const url = process.env.LIDAR_SERVICE_URL;
  if (!url) return json(200, { ok: false, status: "not_configured" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }
  if (body.lat == null || body.lng == null) return json(400, { ok: false, error: "lat/lng required" });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 70000);   // cold EPT read can be slow
  try {
    const r = await fetch(url.replace(/\/+$/, "") + "/measure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: body.lat, lng: body.lng, pitch: body.pitch }),
      signal: ctrl.signal,
    });
    const d = await r.json().catch(() => ({ ok: false, status: "bad_response" }));
    return json(200, d);
  } catch (e) {
    return json(200, { ok: false, status: "error", error: e.name === "AbortError" ? "timeout" : (e.message || "fetch failed") });
  } finally {
    clearTimeout(timer);
  }
};
