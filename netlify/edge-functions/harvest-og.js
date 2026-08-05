// Per-mode link preview. free-roof-inspections.netlify.app serves BOTH the
// homeowner "Free Roof Inspection" links (must stay U.S. Shingle & Metal in the
// preview) AND the rep-facing DoorDispatcher map (?mode=harvest…). A shared link
// preview is read by the messaging crawler from the STATIC HTML (no JS), so we
// rewrite the og/twitter/title tags at the edge — DoorDispatcher branding for
// the harvest/rep modes only, U.S. Shingle untouched for everyone else.

const DD_MODES = new Set([
  "harvest", "canvass", "harvesttraining", "harvesttrainingadmin",
  "harvestreport", "installs", "foremanlinks", "scheduleadmin",
]);
// The map modes reps actually INSTALL to their home screen. Only these get the
// map's manifest (see the manifest rewrite below).
const MAP_MODES = new Set(["harvest", "canvass"]);
const OG = "https://free-roof-inspections.netlify.app/doordispatcher-og.png";
const TITLE = "DoorDispatcher — We send you where the money is";
const DESC = "Your effort, pointed at the right doors — the door-knocking map that sends reps where the money is.";

export default async (request, context) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") || "";
  const res = await context.next();
  const ct = res.headers.get("content-type") || "";
  if (!DD_MODES.has(mode) || !ct.includes("text/html")) return res; // homeowner + non-HTML: untouched

  let html = await res.text();
  html = html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${TITLE}</title>`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${DESC}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${TITLE}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${DESC}$2`)
    .replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${OG}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1DoorDispatcher$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1We send you where the money is.$2`)
    .replace(/(<meta name="twitter:image" content=")[^"]*(")/, `$1${OG}$2`);

  // PWA manifest fix (the real "icon opens the inspection, not the map" bug):
  // iOS only honors the manifest declared in the INITIAL HTML — a manifest link
  // swapped by JS after load is IGNORED at "Add to Home Screen" time. So the
  // default manifest's start_url (/?app=1 → the Field Visit "Who are you?" hub)
  // hijacked EVERY iOS install of the map. Rewrite the manifest link at the edge
  // for the map modes so iOS reads the map's start_url from the initial HTML and
  // the installed icon opens the MAP. Bake the rep's token into start_url (via
  // harvest-manifest) when present — a home-screen app has isolated storage and
  // can't recover the token from localStorage on launch.
  if (MAP_MODES.has(mode)) {
    const idp = url.searchParams.get("rt") || url.searchParams.get("admin") || url.searchParams.get("manager");
    const manifestHref = idp
      ? `/.netlify/functions/harvest-manifest?${url.search.slice(1)}`
      : "/manifest-harvest.webmanifest";
    html = html.replace(
      '<link rel="manifest" href="/manifest.webmanifest" />',
      `<link rel="manifest" href="${manifestHref}" />`,
    );
  }

  const headers = new Headers(res.headers);
  headers.delete("content-length"); // body length changed after the rewrite
  return new Response(html, { status: res.status, headers });
};

export const config = { path: "/" };
