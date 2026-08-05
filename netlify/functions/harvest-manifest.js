// netlify/functions/harvest-manifest.js
//
// Per-rep DoorDispatcher PWA manifest. The static manifest's start_url can't carry a
// rep's personal token, so a home-screen icon installed from a rep's link would launch
// tokenless — and because a home-screen app has ISOLATED storage (it can't read the
// token Safari saved in localStorage), the token can't be recovered on launch, so it
// falls through to whatever "home" is saved (for one manager, an inspection).
//
// This returns a manifest whose start_url BAKES IN the rep's identity, so the installed
// icon always opens THAT rep's map — no storage recovery needed. The harvest page points
// its <link rel="manifest"> here (with the rep's query string) before the phone reads it.
//
//   GET /.netlify/functions/harvest-manifest?rt=<token>   → manifest with
//       start_url "/?mode=harvest&rt=<token>&app=1"

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  // Only the harvest identity params get baked into start_url — keeps it clean & safe.
  const parts = [];
  for (const k of ["rt", "admin", "manager", "test"]) {
    const v = qs[k];
    if (v && /^[A-Za-z0-9_-]{1,80}$/.test(String(v))) parts.push(`${k}=${encodeURIComponent(v)}`);
  }
  const startUrl = `/?mode=harvest${parts.length ? "&" + parts.join("&") : ""}&app=1`;
  const manifest = {
    name: "DoorDispatcher",
    short_name: "DoorDispatcher",
    description: "DoorDispatcher — we send you where the money is.",
    start_url: startUrl,
    scope: "/",
    display: "standalone",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    icons: [
      { src: "/doordispatcher-tile.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/doordispatcher-tile.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(manifest),
  };
};
