// Diagnostic: is Google's Photorealistic 3D Tiles API (Map Tiles API) enabled on
// our Maps project / key? GET /.netlify/functions/probe-3dtiles
// Returns which key (if any) can pull the 3D tileset root — the gate for building
// an oblique-view takeoff tool on top of it.
const KEYS = {
  GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
  VITE_GOOGLE_PLACES_API_KEY: process.env.VITE_GOOGLE_PLACES_API_KEY,
};
export const handler = async () => {
  const out = {};
  for (const [name, key] of Object.entries(KEYS)) {
    if (!key) { out[name] = "not set"; continue; }
    try {
      const r = await fetch(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${key}`);
      const body = await r.text();
      let j = null; try { j = JSON.parse(body); } catch { /* */ }
      out[name] = {
        http: r.status,
        enabled: r.ok && !!(j && (j.root || j.asset)),
        // if enabled, child tile URIs carry a session token — proof it's live
        has_session: !!(j && JSON.stringify(j).includes("session")),
        reason: (j && j.error && (j.error.status || j.error.message)) || (r.ok ? "OK" : body.slice(0, 160)),
      };
    } catch (e) { out[name] = { error: String(e && e.message || e) }; }
  }
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(out, null, 1) };
};
