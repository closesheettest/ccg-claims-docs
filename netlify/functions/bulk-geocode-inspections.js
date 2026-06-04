// netlify/functions/bulk-geocode-inspections.js
//
// One-shot backfill: every inspection row where latitude IS NULL but
// address is set gets geocoded via /.netlify/functions/geocode-inspection
// (which calls Google Maps Geocoding API and writes coords back). Runs
// in parallel batches of 8 so it fits under the 30s function timeout
// for typical free-roof-inspection volumes.
//
// Usage:
//   POST /.netlify/functions/bulk-geocode-inspections
//   Body (optional): { dry_run: true, limit: 100 }
//
// Auth: ?secret=<BACKFILL_SECRET or CRON_SECRET>. Falls through if
// no env secret is set (consistent with the other backfill function).
//
// Required env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//               GOOGLE_MAPS_API_KEY.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return json(405, { error: "Method not allowed" });
  }
  const required = process.env.BACKFILL_SECRET || process.env.CRON_SECRET;
  if (required) {
    const provided =
      event.headers["x-backfill-secret"] ||
      event.headers["X-Backfill-Secret"] ||
      event.queryStringParameters?.secret;
    if (provided !== required) return json(401, { error: "Unauthorized" });
  }

  const missing = [];
  for (const k of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]) {
    if (!process.env[k]) missing.push(k);
  }
  // Google key: prefer the server-side var, fall back to the client
  // var (the existing VITE_GOOGLE_PLACES_API_KEY in this project).
  if (!process.env.GOOGLE_MAPS_API_KEY && !process.env.VITE_GOOGLE_PLACES_API_KEY) {
    missing.push("GOOGLE_MAPS_API_KEY (or VITE_GOOGLE_PLACES_API_KEY)");
  }
  if (missing.length) return json(500, { error: `Missing env vars: ${missing.join(", ")}` });

  const body = event.httpMethod === "POST" ? safeJson(event.body) : {};
  const dryRun = !!body.dry_run || event.queryStringParameters?.dry_run === "1";
  const limit = Number.isFinite(body.limit) ? Math.min(body.limit, 1000) : 500;

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const sbHeaders = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    "Content-Type": "application/json",
  };

  // Find inspections needing geocode: address present, and EITHER lat is
  // still NULL (never geocoded) OR county is NULL (geocoded before county
  // capture shipped — re-run to fill it). Built as a raw query string so
  // the PostgREST `or=(...)` filter isn't mangled by URLSearchParams.
  const qs =
    "select=id,client_name,address,city,state,zip,latitude,county" +
    "&or=(latitude.is.null,county.is.null)" +
    "&address=not.is.null" +
    `&limit=${limit}`;
  const listRes = await fetch(`${SB_URL}/rest/v1/inspections?${qs}`, { headers: sbHeaders });
  if (!listRes.ok) {
    return json(500, { error: `Could not list inspections: ${await listRes.text()}` });
  }
  const rows = await listRes.json();

  const out = {
    dry_run: dryRun,
    matched: rows.length,
    geocoded: 0,
    skipped: 0,
    errors: [],
    rows_preview: dryRun ? rows.slice(0, 20).map((r) => ({
      id: r.id,
      client_name: r.client_name,
      address: [r.address, r.city, r.state, r.zip].filter(Boolean).join(", "),
    })) : undefined,
  };

  if (dryRun) {
    return json(200, out);
  }

  const base = process.env.URL || process.env.PUBLIC_SITE_URL || "";
  if (!base) {
    return json(500, { error: "No base URL — cannot call geocode-inspection internally" });
  }

  // Process in parallel batches of 8 to keep us under the 30s timeout.
  // Google's geocoding API can comfortably handle ~50 QPS.
  const BATCH_SIZE = 8;
  async function processRow(row) {
    try {
      const res = await fetch(`${base}/.netlify/functions/geocode-inspection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inspectionId: row.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (j.ok && j.skipped) {
        out.skipped++;
      } else if (j.ok) {
        out.geocoded++;
      } else {
        out.errors.push({ id: row.id, client_name: row.client_name, error: j.error || `status ${res.status}` });
      }
    } catch (e) {
      out.errors.push({ id: row.id, error: e.message || "Unknown" });
    }
  }
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(processRow));
  }

  return json(200, out);
};

function safeJson(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}
function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
