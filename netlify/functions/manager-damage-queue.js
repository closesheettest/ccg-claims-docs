// netlify/functions/manager-damage-queue.js
//
// Regional-manager queue of DAMAGE deals that need a rep assigned — the ones
// whose rep is NON-active (e.g. the inspector) or missing. Active reps' damage
// deals already show in that rep's Damage visit list; these orphans show for
// nobody until a manager assigns them to an active rep in their zone.
//
//   POST { action:'load', zone }
//     → { ok, deals:[{ inspection_id, client_name, address, city, county, zip,
//          mobile, current_rep }], reps:[{ jobnimbus_id, name }] }  (active reps in zone)
//   POST { action:'assign', inspection_id, rep_jobnimbus_id, rep_name }
//     → { ok }  — sets the inspection's sales rep (so it lands in that rep's
//        Damage visit list) AND the JobNimbus owner/sales_rep (manager-reassign-deal).
//
// Open-CORS like the sibling zone-* manager feeds; assign validates the target
// is a real active rep. Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
// A damage deal disappears from the rep's Damage-visit list the moment its JN
// status is "BTR - NI" (Back-to-Retail Not Interested) — a RETAIL status, so on
// a damage deal it's almost always a mis-click. Restoring = set the JN status
// back to "Sit Sold Insp" (the normal post-inspection damage state).
const BTR_NI_NAME = "BTR - NI";
const SIT_SOLD_INSP = 597, SIT_SOLD_INSP_NAME = "Sit Sold Insp";

// county → zone(s), from the owner's territory map (split counties live in two).
const ZONE_COUNTIES = {
  "Zone 1": ["Nassau", "Duval", "Baker", "Union", "Bradford", "Clay", "St. Johns", "Putnam", "Flagler", "Alachua", "Levy", "Marion", "Sumter", "Lake", "Seminole", "Volusia", "Brevard", "Orange"],
  "Zone 2": ["Orange", "Brevard", "Pasco", "Hillsborough", "Polk", "Osceola", "Indian River", "Highlands", "Citrus", "Hernando"],
  "Zone 3": ["Pinellas", "Manatee", "Sarasota", "Charlotte", "Lee", "Collier", "Monroe", "Hardee", "DeSoto", "Glades", "Hendry", "St. Lucie", "Okeechobee"],
  "Zone 4": ["Martin", "Palm Beach", "Broward", "Miami-Dade"],
};
const normCounty = (c) => String(c || "").toLowerCase().replace(/county/g, "").replace(/[^a-z]+/g, " ").trim();
const COUNTY_ZONES = (() => {
  const m = {};
  for (const [z, list] of Object.entries(ZONE_COUNTIES)) for (const c of list) (m[normCounty(c)] = m[normCounty(c)] || []).push(z);
  return m;
})();

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }

  try {
    const reps = await fetchReps();
    const activeById = new Map(), activeByName = new Map();
    for (const r of reps) if (r.active && r.jobnimbus_id) activeById.set(r.jobnimbus_id, r);
    for (const r of reps) if (r.active && r.name) activeByName.set(norm(r.name), r);

    if (body.action === "assign") {
      const inspId = String(body.inspection_id || "").trim();
      const repId = String(body.rep_jobnimbus_id || "").trim();
      const repName = String(body.rep_name || "").trim();
      if (!inspId || !repId) return cors(400, JSON.stringify({ ok: false, error: "inspection_id + rep_jobnimbus_id required" }));
      if (!activeById.has(repId)) return cors(400, JSON.stringify({ ok: false, error: "not an active rep" }));
      const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspId)}&select=jn_job_id&limit=1`))[0];
      // Land it in the new rep's Damage visit list (visit-deal-list matches sales_rep_*).
      // manager_assigned_to_rep_at is an explicit override so the deal shows even
      // if a PA merely OPENED it (pa_opened_at) — and survives the nightly PA
      // auto-assign. Sent separately so a missing column (pre-migration) can't
      // drop the sales-rep write that actually reassigns the deal.
      await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspId)}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
        body: JSON.stringify({ sales_rep_id: repId, sales_rep_name: repName || activeById.get(repId).name }),
      });
      await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspId)}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
        body: JSON.stringify({ manager_assigned_to_rep_at: new Date().toISOString() }),
      }).catch(() => {});
      // Mirror to JobNimbus (owner + sales rep) via the existing reassign function.
      if (insp && insp.jn_job_id) {
        const base = process.env.URL || process.env.DEPLOY_URL || "https://free-roof-inspections.netlify.app";
        await fetch(`${base}/.netlify/functions/manager-reassign-deal`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jnid: insp.jn_job_id, assigneeId: repId, salesRepId: repId }),
        }).catch(() => {});
      }
      return cors(200, JSON.stringify({ ok: true }));
    }

    // action: btr_load — damage deals wrongly marked "BTR - NI" in this zone,
    // i.e. ones that fell off the rep's Damage-visit list and can be restored.
    if (body.action === "btr_load") {
      const z = String(body.zone || "").trim();
      if (!z) return cors(400, JSON.stringify({ ok: false, error: "zone required" }));
      const sel = "id,client_name,address,city,county,zip,mobile,original_sales_rep_name,sales_rep_name,result_at";
      const rows = await sbGet(`inspections?result=eq.damage&cancelled_at=is.null&jn_status=eq.${encodeURIComponent(BTR_NI_NAME)}&select=${sel}&order=result_at.desc&limit=1000`);
      const deals = rows
        .filter((r) => (COUNTY_ZONES[normCounty(r.county)] || []).includes(z))
        .map((r) => ({ inspection_id: r.id, client_name: r.client_name, address: r.address, city: r.city, county: r.county, zip: r.zip, mobile: r.mobile, rep: r.original_sales_rep_name || r.sales_rep_name || null }));
      return cors(200, JSON.stringify({ ok: true, deals }));
    }

    // action: btr_restore — put the JN status back to "Sit Sold Insp" and clear
    // the stale BTR-NI copy, so the deal returns to the rep's Damage-visit list now.
    if (body.action === "btr_restore") {
      const inspId = String(body.inspection_id || "").trim();
      if (!inspId) return cors(400, JSON.stringify({ ok: false, error: "inspection_id required" }));
      const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(inspId)}&select=jn_job_id&limit=1`))[0];
      if (insp && insp.jn_job_id && JN_KEY) {
        const r = await fetch(`${JN_BASE}/jobs/${insp.jn_job_id}`, { method: "PUT", headers: jnH, body: JSON.stringify({ status: SIT_SOLD_INSP, status_name: SIT_SOLD_INSP_NAME }) });
        if (!r.ok) return cors(502, JSON.stringify({ ok: false, error: `JobNimbus update failed (${r.status})` }));
      }
      await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(inspId)}`, {
        method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify({ jn_status: null }),
      });
      return cors(200, JSON.stringify({ ok: true }));
    }

    // action: load
    const zone = String(body.zone || "").trim();
    if (!zone) return cors(400, JSON.stringify({ ok: false, error: "zone required" }));
    const sel = "id,client_name,address,city,county,zip,mobile,original_sales_rep_id,original_sales_rep_name,sales_rep_id,sales_rep_name,pa_stage";
    const rows = await sbGet(`inspections?result=eq.damage&cancelled_at=is.null&pa_signed_at=is.null&jn_job_id=not.is.null&select=${sel}&order=result_at.desc&limit=3000`);
    const isActive = (id, name) => (id && activeById.has(id)) || (name && activeByName.has(norm(name)));
    const deals = rows.filter((r) => {
      if (r.pa_stage === "active" || r.pa_stage === "waiting_docs") return false;       // a PA is on it
      if (isActive(r.original_sales_rep_id, r.original_sales_rep_name) || isActive(r.sales_rep_id, r.sales_rep_name)) return false; // already an active rep's
      const zones = COUNTY_ZONES[normCounty(r.county)] || [];
      return zones.includes(zone);
    }).map((r) => ({
      inspection_id: r.id, client_name: r.client_name, address: r.address, city: r.city, county: r.county, zip: r.zip,
      mobile: r.mobile, current_rep: r.original_sales_rep_name || r.sales_rep_name || null,
    }));
    const zoneReps = reps.filter((r) => r.active && r.zone === zone && r.jobnimbus_id).map((r) => ({ jobnimbus_id: r.jobnimbus_id, name: r.name }));
    return cors(200, JSON.stringify({ ok: true, deals, reps: zoneReps }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function fetchReps() {
  try { const r = await fetch(REP_ZONES_URL); if (r.ok) return (await r.json()).reps || []; } catch { /* ignore */ }
  return [];
}
const norm = (n) => String(n || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
