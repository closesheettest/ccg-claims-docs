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

  const headers = new Headers(res.headers);
  headers.delete("content-length"); // body length changed after the rewrite
  return new Response(html, { status: res.status, headers });
};

export const config = { path: "/" };
