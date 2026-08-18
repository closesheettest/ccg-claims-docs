// netlify/functions/manager-cancel-reviews.js
//
// The cancellation reviews a regional manager still needs to decide — for their
// zone. Surfaced on the manager dashboard so a MISSED review text can't hide one
// (request-inspection-cancel texts the zone manager, but if that SMS fails the
// review just sits with cancel_review_pending=true, invisible). Belt + suspenders.
//
//   GET ?manager=<regional_managers.token>
//   → { ok, zone, reviews:[{ id, client_name, address, city, note, by, at, link }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
const BASE = (process.env.URL || process.env.PUBLIC_SITE_URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");

// A REAL sales zone, not a training-class region. only real sales zones: a rep who also has an old TRAINEE record carries that record's TRAINING region ("St Pete") in the same field, and last-write-wins let it overwrite the live zone — Todd Saylor lost his team on the self-scheduler report (Neal, 2026-08-18)
const isSalesZone = (z) => /^Zone \d+$/.test(String(z || "").trim());

function normalizeName(s) { return String(s || "").toLowerCase().replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim(); }

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing Supabase env" }));
  const qp = event.queryStringParameters || {};
  const token = (qp.manager || "").trim();
  const zoneParam = (qp.zone || "").trim(); // TMS dashboard calls by zone (like zone-deals-to-fix)
  if (!token && !zoneParam) return cors(400, JSON.stringify({ ok: false, error: "manager token or zone required" }));
  const sbGet = async (path) => { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); };
  try {
    let myZone = zoneParam;
    if (!myZone) {
      const mgr = (await sbGet(`regional_managers?token=eq.${encodeURIComponent(token)}&select=zone,name&limit=1`))[0];
      if (!mgr) return cors(401, JSON.stringify({ ok: false, error: "invalid manager token" }));
      myZone = String(mgr.zone || "").trim();
    }

    const rows = await sbGet(`inspections?cancel_review_pending=is.true&cancelled_at=is.null&select=id,client_name,address,city,sales_rep_name,cancel_review_note,cancel_review_by,cancel_review_at&order=cancel_review_at.desc&limit=200`);
    if (!rows.length) return cors(200, JSON.stringify({ ok: true, zone: myZone, reviews: [] }));

    // rep name → zone (same source as the cancel-review text routing).
    const zoneByRep = {};
    try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) { const j = await res.json(); for (const r of (j.reps || [])) if (r.name && isSalesZone(r.zone)) zoneByRep[normalizeName(r.name)] = String(r.zone).trim(); } } catch { /* best-effort */ }

    // Show a review if it's in THIS manager's zone — or if its zone can't be
    // resolved (better to over-show than let one slip through unseen).
    const reviews = rows
      .map((r) => ({ ...r, _zone: zoneByRep[normalizeName(r.sales_rep_name)] || null }))
      .filter((r) => !r._zone || r._zone === myZone)
      .map((r) => ({ id: r.id, client_name: r.client_name, address: r.address, city: r.city, rep: r.sales_rep_name, note: r.cancel_review_note, by: r.cancel_review_by, at: r.cancel_review_at, link: `${BASE}/?cancel_review=${r.id}` }));

    return cors(200, JSON.stringify({ ok: true, zone: myZone, reviews }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
