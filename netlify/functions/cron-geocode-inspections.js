// netlify/functions/cron-geocode-inspections.js
//
// Safety-net geocoder. A new inspection is geocoded fire-and-forget from the
// browser at signing time — but if the rep's page closes/navigates the instant
// they submit, that request is cancelled and the row is left with no lat/lng
// (which drops it off the inspector map + mileage report). This cron sweeps up
// any inspection that still has an address but no coordinates and geocodes it
// via the existing geocode-inspection endpoint. Runs every 30 minutes.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL (Netlify site URL)

export const config = { schedule: "*/30 * * * *" };

export const handler = async () => {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const BASE = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });
  const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  try {
    // Ungeocoded inspections that have an address to work with. Cap per run so a
    // big backlog can't blow the Google quota / function timeout — the next run
    // takes the rest.
    const rows = await fetch(
      `${SB_URL}/rest/v1/inspections?latitude=is.null&address=not.is.null&select=id&order=signed_at.desc.nullslast&limit=60`,
      { headers: sbH },
    ).then((r) => (r.ok ? r.json() : [])).catch(() => []);

    let ok = 0, fail = 0;
    for (const r of rows) {
      try {
        const res = await fetch(`${BASE}/.netlify/functions/geocode-inspection`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inspectionId: r.id }),
        });
        const j = await res.json().catch(() => ({}));
        if (j && (j.lat != null || j.skipped)) ok++; else fail++;
      } catch { fail++; }
    }
    return json(200, { ok: true, found: rows.length, geocoded: ok, failed: fail });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
