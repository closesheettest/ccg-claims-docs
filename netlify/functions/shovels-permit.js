// netlify/functions/shovels-permit.js
//
// Secure server-side proxy to the Shovels.ai permit API. The API key lives in
// the SHOVELS_API_KEY env var on Netlify — it NEVER reaches the browser. The
// permit-lookup page calls this with a shared password (app_settings.permit_token).
//
// Two Shovels calls per address (this is what burns the free 250 / paid credits):
//   1. GET /v2/addresses/search?q=<full address>   → resolve to a geo_id
//   2. GET /v2/permits/search?geo_id=…&permit_tags=roofing&…  → roofing permits
// Then we surface the most recent roofing-permit date.
//
// POST { token, address, city?, state?, zip?, since_year?, debug? }
//   → { ok, found, status, geo_id, jurisdiction, last_roof_permit_date,
//       permit_count, credits_left, error?, debug? }
//
// Env: SHOVELS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const SHOVELS_KEY = process.env.SHOVELS_API_KEY;
const BASE = "https://api.shovels.ai/v2";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SHOVELS_KEY) return cors(500, JSON.stringify({ ok: false, error: "SHOVELS_API_KEY not configured on the server" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Wrong password" }));

  const full = [body.address, body.city, body.state, body.zip].map((x) => String(x || "").trim()).filter(Boolean).join(", ");
  if (!full) return cors(400, JSON.stringify({ ok: false, error: "address required" }));
  const sinceYear = Number(body.since_year) || 2000;
  const debug = !!body.debug;

  const H = { "X-API-Key": SHOVELS_KEY, Accept: "application/json" };
  let creditsLeft = null;

  try {
    // ── Step 1: resolve the address → geo_id ───────────────────────────────
    const aRes = await fetch(`${BASE}/addresses/search?q=${encodeURIComponent(full)}&size=1`, { headers: H });
    creditsLeft = readCredits(aRes) ?? creditsLeft;
    const aJson = await aRes.json().catch(() => ({}));
    if (!aRes.ok) return cors(200, JSON.stringify({ ok: true, found: false, status: "ERROR", error: `address lookup ${aRes.status}`, credits_left: creditsLeft, ...(debug ? { debug: aJson } : {}) }));

    const addr = firstItem(aJson);
    const geoId = addr && (addr.geo_id || addr.id || addr.geoId);
    if (!geoId) return cors(200, JSON.stringify({ ok: true, found: false, status: "NOT FOUND", credits_left: creditsLeft, ...(debug ? { debug: aJson } : {}) }));
    const jurisdiction = addr.jurisdiction_name || addr.jurisdiction || addr.city || null;

    // ── Step 2: roofing permits for that geo_id ────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const pUrl = `${BASE}/permits/search?geo_id=${encodeURIComponent(geoId)}&permit_tags=roofing&permit_from=${sinceYear}-01-01&permit_to=${today}&size=50`;
    const pRes = await fetch(pUrl, { headers: H });
    creditsLeft = readCredits(pRes) ?? creditsLeft;
    const pJson = await pRes.json().catch(() => ({}));
    if (!pRes.ok) return cors(200, JSON.stringify({ ok: true, found: true, status: "ERROR", geo_id: geoId, jurisdiction, error: `permit lookup ${pRes.status}`, credits_left: creditsLeft, ...(debug ? { debug: pJson } : {}) }));

    const permits = listItems(pJson);
    const dates = permits.map(permitDate).filter(Boolean).sort();   // ascending ISO strings
    const last = dates.length ? dates[dates.length - 1] : null;

    return cors(200, JSON.stringify({
      ok: true,
      found: true,
      status: last ? "OK" : "NO PERMIT",
      geo_id: geoId,
      jurisdiction,
      last_roof_permit_date: last,
      permit_count: permits.length,
      credits_left: creditsLeft,
      ...(debug ? { debug: { samplePermit: permits[0] || null } } : {}),
    }));
  } catch (e) {
    return cors(200, JSON.stringify({ ok: true, found: false, status: "ERROR", error: e.message || "error", credits_left: creditsLeft }));
  }
};

// Shovels responses vary; pull the array out of whatever container it uses.
function listItems(j) {
  if (Array.isArray(j)) return j;
  for (const k of ["items", "results", "data", "permits", "addresses"]) if (Array.isArray(j?.[k])) return j[k];
  return [];
}
function firstItem(j) { return listItems(j)[0] || (j && typeof j === "object" && j.geo_id ? j : null); }

// Most-recent meaningful date on a permit record, across the field names the
// lean search response might use.
function permitDate(p) {
  if (!p || typeof p !== "object") return null;
  const cands = [p.final_date, p.issue_date, p.file_date, p.permit_from, p.start_date, p.approval_date, p.status_date, p.permit_to, p.end_date]
    .map((x) => (x ? String(x).slice(0, 10) : null))
    .filter((x) => x && /^\d{4}-\d{2}-\d{2}$/.test(x) && x <= new Date().toISOString().slice(0, 10));
  cands.sort();
  return cands.length ? cands[cands.length - 1] : null;
}
function readCredits(res) {
  for (const h of ["x-credits-remaining", "x-ratelimit-remaining", "ratelimit-remaining", "x-quota-remaining"]) {
    const v = res.headers.get(h);
    if (v != null && v !== "") { const n = Number(v); if (!Number.isNaN(n)) return n; }
  }
  return null;
}
async function okToken(token) {
  token = String(token || "").trim();
  if (!token) return false;
  const want = await getSetting("permit_token");
  return !!want && token === want;
}
async function getSetting(key) {
  if (!SB_URL || !SB_KEY) return null;
  const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sb });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return rows[0]?.value || null;
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
