// netlify/functions/map-data.js
//
// Backend bridge to David Macella's "Map Data" Supabase (public.map_properties,
// ~8.6M FL homes, weekly-refreshed roof data). That DB is RLS-locked PII, so the
// service_role key lives ONLY in Netlify env (MAP_DATA_KEY) and is used ONLY here,
// server-side — never the browser, never git. Gated behind our harvest_admin_token.
//
//   GET ?admin=<harvest_admin_token>&mode=probe
//        → connection check + row counts + a small redacted sample (no owner PII)
//   GET ?admin=...&mode=schema
//        → the column list on a sample row (to design matching)
//
// Env: MAP_DATA_KEY (David's key, Netlify only), VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const OUR_URL = process.env.VITE_SUPABASE_URL;
const OUR_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const DAVID_URL = "https://pbwyoziztkiyifgmxbcr.supabase.co";
const DAVID_KEY = process.env.MAP_DATA_KEY;

const PII = new Set(["owner_name", "owner_name_2", "mailing_address", "mailing_addr", "owner_mailing", "phone", "email"]);

export const handler = async (event) => {
  const p = event.queryStringParameters || {};
  if (!OUR_URL || !OUR_KEY) return json(500, { ok: false, error: "Our Supabase env missing" });
  if (!DAVID_KEY) return json(500, { ok: false, error: "MAP_DATA_KEY is not set in Netlify env — add David's key there first." });

  // Gate: must present our harvest_admin_token.
  const admin = String(p.admin || "").trim();
  let allowed = false;
  try {
    const rows = await ourGet(`app_settings?key=eq.harvest_admin_token&select=value&limit=1`);
    allowed = !!admin && rows[0] && rows[0].value === admin;
  } catch { /* fall through to 401 */ }
  if (!allowed) return json(401, { ok: false, error: "unauthorized" });

  const dH = { apikey: DAVID_KEY, Authorization: `Bearer ${DAVID_KEY}`, "Content-Type": "application/json" };
  const mode = String(p.mode || "probe").trim();

  try {
    if (mode === "schema") {
      const r = await fetch(`${DAVID_URL}/rest/v1/map_properties?select=*&limit=1`, { headers: dH });
      if (!r.ok) return json(200, { ok: false, connected: false, http: r.status, body: (await r.text()).slice(0, 400) });
      const rows = await r.json();
      const row = rows[0] || {};
      // redact PII values, keep the column NAMES + a couple safe sample values
      const cols = Object.keys(row).sort();
      const safe = {};
      for (const k of cols) safe[k] = PII.has(k) ? "‹redacted›" : row[k];
      return json(200, { ok: true, connected: true, columns: cols, sample_redacted: safe });
    }

    // probe — connection + the two headline counts + a redacted sample
    const total = await countOf(`${DAVID_URL}/rest/v1/map_properties?select=akey`, dH);
    const qualifies = await countOf(`${DAVID_URL}/rest/v1/map_properties?qualifies=eq.true&select=akey`, dH);
    const sampRes = await fetch(`${DAVID_URL}/rest/v1/map_properties?select=akey,address,city,zip5,county,roof_age,last_roof_year,roof_cover,owner_occupied,qualifies&limit=4`, { headers: dH });
    const connected = sampRes.ok;
    const sample = sampRes.ok ? await sampRes.json() : (await sampRes.text()).slice(0, 400);
    return json(200, { ok: true, connected, http: sampRes.status, counts: { total, qualifies }, sample });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "map-data error" });
  }
};

async function ourGet(path) {
  const r = await fetch(`${OUR_URL}/rest/v1/${path}`, { headers: { apikey: OUR_KEY, Authorization: `Bearer ${OUR_KEY}` } });
  return r.ok ? r.json() : [];
}
async function countOf(url, headers) {
  const r = await fetch(url + "&limit=1", { headers: { ...headers, Prefer: "count=exact" } });
  const cr = r.headers.get("content-range") || "";
  const n = cr.includes("/") ? parseInt(cr.split("/")[1], 10) : NaN;
  return Number.isFinite(n) ? n : null;
}
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) };
}
