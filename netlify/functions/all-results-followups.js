// netlify/functions/all-results-followups.js
//
// "Inspection done — go back to review results" report for the admin Regional
// Managers page. When a rep signs a free inspection they ask the homeowner the
// best day/time to come back and go over the results (stored as
// review_availability, e.g. "Wed · 5 PM"). Once the inspection is DONE (a result
// is recorded), the rep needs to go back at that day/time. This lists every such
// deal — inspected, with a review day/time, that the rep hasn't gone back on yet
// — grouped by zone → rep.
//
// A deal drops off once the rep has gone back and handled it: PA appointment
// booked / PA working it (damage), retail appointment scheduled (retail),
// certificate sent or referral logged (no-damage), or marked Not Interested
// ("BTR - NI", any type).
//
// GET → { ok, total, zones:[{ zone, count, reps:[{ rep, jobnimbus_id, deals:[
//   { id, homeowner, address, result, inspected_at, review_availability, mobile } ] }] }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
const ZONE_ORDER = ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];
const DAY_ORDER = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));
  try {
    const sel = "id,client_name,address,city,mobile,sales_rep_name,sales_rep_id,original_sales_rep_name,original_sales_rep_id,result,result_at,review_availability,jn_status,referral_outcome,pa_stage,pa_signed_at";
    const rows = await sbGet(`inspections?result=in.(damage,no_damage,retail)&result_at=not.is.null&review_availability=not.is.null&cancelled_at=is.null&select=${sel}&order=result_at.desc&limit=2000`);

    // Retail deals already scheduled (a retail_appointments row) → handled.
    const retailIds = rows.filter((r) => r.result === "retail").map((r) => r.id);
    const scheduledRetail = new Set();
    if (retailIds.length) {
      const inList = retailIds.map((id) => `"${id}"`).join(",");
      for (const a of await sbGet(`retail_appointments?inspection_id=in.(${encodeURIComponent(inList)})&select=inspection_id`)) {
        if (a.inspection_id) scheduledRetail.add(a.inspection_id);
      }
    }
    const isHandled = (r) => {
      if (String(r.jn_status || "").trim().toLowerCase() === "btr - ni") return true;       // Not Interested
      if (r.result === "no_damage") return !!r.referral_outcome;                              // cert sent / referral logged
      if (r.result === "retail") return scheduledRetail.has(r.id);                            // retail appt scheduled
      if (r.result === "damage") return !!r.pa_signed_at || ["active", "waiting_docs", "dead"].includes(r.pa_stage); // PA engaged
      return false;
    };
    const pending = rows.filter((r) => !isHandled(r));

    const zoneOf = await fetchZoneResolver();
    const byZone = {}; // zone -> { rep -> {rep, jobnimbus_id, deals:[]} }
    for (const r of pending) {
      const repName = (r.sales_rep_name || r.original_sales_rep_name || "").trim();
      const repId = r.sales_rep_id || r.original_sales_rep_id || null;
      const e = zoneOf(repId, repName);
      const zone = (e && e.zone) || "Unassigned";
      const rep = (e && e.name) || repName || "(no rep)";
      const z = (byZone[zone] = byZone[zone] || {});
      const g = (z[rep] = z[rep] || { rep, jobnimbus_id: repId, deals: [] });
      g.deals.push({
        id: r.id,
        homeowner: r.client_name || "(no name)",
        address: [r.address, r.city].filter(Boolean).join(", "),
        result: r.result,
        inspected_at: r.result_at,
        review_availability: r.review_availability,
        mobile: r.mobile || null,
      });
    }

    const dayKey = (s) => { const m = String(s || "").toLowerCase().match(/sun|mon|tue|wed|thu|fri|sat/); return m ? DAY_ORDER[m[0]] : 9; };
    const zones = Object.keys(byZone)
      .sort((a, b) => { const ia = ZONE_ORDER.indexOf(a), ib = ZONE_ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); })
      .map((zone) => {
        const reps = Object.values(byZone[zone])
          .map((g) => { g.deals.sort((a, b) => dayKey(a.review_availability) - dayKey(b.review_availability) || a.homeowner.localeCompare(b.homeowner)); return g; })
          .sort((a, b) => b.deals.length - a.deals.length || a.rep.localeCompare(b.rep));
        return { zone, count: reps.reduce((s, r) => s + r.deals.length, 0), reps };
      });

    return cors(200, JSON.stringify({ ok: true, total: pending.length, zones }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function fetchZoneResolver() {
  let reps = [];
  try { const r = await fetch(TMS_REP_ZONES_URL); if (r.ok) reps = (await r.json()).reps || []; } catch { /* no zones → all Unassigned */ }
  const byId = {}, byName = {};
  for (const r of reps) { const e = { zone: r.zone, name: r.name }; if (r.jobnimbus_id) byId[r.jobnimbus_id] = e; if (r.name) byName[normName(r.name)] = e; }
  return (id, name) => (id && byId[id]) || byName[normName(name)] || null;
}
function normName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(); }
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
