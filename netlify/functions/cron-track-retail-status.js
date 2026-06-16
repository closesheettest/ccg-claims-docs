// netlify/functions/cron-track-retail-status.js
//
// Tracks back-to-retail CONVERSIONS. A retail inspection sits in JobNimbus at
// "Sit Sold Insp" — that's the back-to-retail pool (nobody's re-engaged it).
// When the rep gets it back on the calendar the JN status moves to
// "Appointment Scheduled" (or onward: Sit Sold / Install Set / Sold / Lost),
// and the live back-to-retail report just DROPS it — so the rep's win was never
// recorded. You can only catch the change by snapshotting the state over time
// ("freezing time") and diffing.
//
// Each run:
//   1. Pull the retail universe (inspections result=retail w/ a JN job).
//   2. Ask JN which jobs are CURRENTLY at "Sit Sold Insp".
//   3. Diff against our snapshot table:
//      • new deal at Sit Sold Insp           → start tracking it
//      • was at Sit Sold Insp, now NOT        → CONVERSION: fetch the new JN
//        status, stamp converted_at / converted_to (+ appointment flag)
//      • moved back to Sit Sold Insp          → reopen (clear conversion)
//
// Only deals that LEFT "Sit Sold Insp" after we'd seen them there get a
// conversion stamped — so the credit is real (we watched it happen).
//
// Schedule: hourly. Manual GET works for an immediate run; ?dry=1 = no writes.
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const SIT_SOLD = "Sit Sold Insp";
const APPT_STATUS = "Appointment Scheduled";
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

// Property county → zone (same territory map the back-to-retail report uses).
const ZONE_COUNTIES = {
  "Zone 1": ["Nassau", "Duval", "Baker", "Union", "Bradford", "Clay", "St. Johns", "Putnam", "Flagler", "Alachua", "Levy", "Marion", "Sumter", "Lake", "Seminole", "Volusia"],
  "Zone 2": ["Pasco", "Hillsborough", "Polk", "Osceola", "Indian River", "Highlands", "Citrus", "Hernando"],
  "Zone 3": ["Pinellas", "Manatee", "Sarasota", "Charlotte", "Lee", "Collier", "Monroe", "Hardee", "DeSoto", "Glades", "Hendry", "St. Lucie", "Okeechobee"],
  "Zone 4": ["Martin", "Palm Beach", "Broward", "Miami-Dade"],
};
const SPLIT_LAT = 28.55;
function normCounty(s) { return String(s || "").toLowerCase().replace(/\bcounty\b/g, "").replace(/[^a-z0-9]+/g, " ").trim(); }
const COUNTY_ZONE = (() => { const m = {}; for (const [z, cs] of Object.entries(ZONE_COUNTIES)) for (const c of cs) m[normCounty(c)] = z; return m; })();
function countyToZone(county, lat) {
  const n = normCounty(county);
  if (!n) return "Unassigned";
  if (n === "brevard" || n === "orange") return (lat != null && lat >= SPLIT_LAT) ? "Zone 1" : "Zone 2";
  return COUNTY_ZONE[n] || "Unassigned";
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Supabase env missing" }));
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "JOBNIMBUS_API_KEY not set" }));
  const qp = event.queryStringParameters || {};
  const dry = ["1", "true", "yes"].includes(String(qp.dry || "").toLowerCase());

  try {
    // 1. Retail universe (last 180 days, has a JN job).
    const since = new Date(Date.now() - 180 * 864e5).toISOString();
    const rows = await sbGet(
      `inspections?result=eq.retail&cancelled_at=is.null&jn_job_id=not.is.null&result_at=gte.${encodeURIComponent(since)}` +
      `&select=id,jn_job_id,client_name,address,city,county,latitude,sales_rep_id,sales_rep_name,result_at&order=result_at.desc&limit=4000`
    );
    // One row per JN job (most recent wins).
    const byJob = new Map();
    for (const r of rows) if (r.jn_job_id && !byJob.has(r.jn_job_id)) byJob.set(r.jn_job_id, r);

    // 2. JN jobs currently at "Sit Sold Insp".
    const sitSet = await fetchStatusSet(SIT_SOLD);
    if (sitSet === null) return cors(502, JSON.stringify({ ok: false, error: "JN unreachable — skipped to avoid false conversions" }));

    // 3. Existing snapshot rows for these jobs.
    const existing = await loadTracking([...byJob.keys()]);

    const newRows = [], conversions = [], reopened = [];
    for (const [jnid, r] of byJob) {
      const atSit = sitSet.has(jnid);
      const ex = existing.get(jnid);
      const zone = countyToZone(r.county, r.latitude);

      if (!ex) {
        // Start tracking. Conversions are only credited from a Sit-Sold state
        // we actually observed, so a deal first seen already-converted just
        // records its state without a (fake) conversion stamp.
        newRows.push({
          jn_job_id: jnid, inspection_id: r.id,
          client_name: (r.client_name || "").trim(), address: [r.address, r.city].filter(Boolean).join(", "),
          zone, sales_rep_id: r.sales_rep_id || null, sales_rep_name: (r.sales_rep_name || "").trim() || null,
          at_sit_sold: atSit, current_status: atSit ? SIT_SOLD : null,
        });
        continue;
      }

      if (ex.at_sit_sold && !atSit && !ex.converted_at) {
        // Left Sit Sold Insp after we saw it there → conversion. Fetch the
        // status it moved to so we can tell appointment vs lost.
        const newStatus = (await getJobStatus(jnid)) || "(changed)";
        conversions.push({
          jn_job_id: jnid, at_sit_sold: false, current_status: newStatus,
          converted_at: new Date().toISOString(), converted_to: newStatus,
          appointment: newStatus === APPT_STATUS,
          // carry rep/zone forward in case it was backfilled since
          sales_rep_name: (r.sales_rep_name || "").trim() || ex.sales_rep_name || null,
          sales_rep_id: r.sales_rep_id || ex.sales_rep_id || null,
          zone,
        });
      } else if (!ex.at_sit_sold && atSit) {
        // Came back to the pool (rare) — reopen so a later appt re-counts.
        reopened.push({ jn_job_id: jnid, at_sit_sold: true, current_status: SIT_SOLD, converted_at: null, converted_to: null, appointment: false });
      }
    }

    if (!dry) {
      if (newRows.length) await sbUpsert(newRows);
      for (const c of conversions) await sbPatch(c.jn_job_id, c);
      for (const r of reopened) await sbPatch(r.jn_job_id, r);
    }

    return cors(200, JSON.stringify({
      ok: true, dry_run: dry,
      retail_deals: byJob.size, at_sit_sold_now: sitSet.size, tracked_before: existing.size,
      started_tracking: newRows.length, conversions: conversions.length, reopened: reopened.length,
      converted: conversions.map((c) => ({ jnid: c.jn_job_id, rep: c.sales_rep_name, zone: c.zone, to: c.converted_to, appointment: c.appointment })),
    }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// All JN job ids currently at a given status (ES filter — avoids the date cap).
// null on any JN error so the caller skips this run (never logs false moves).
async function fetchStatusSet(statusName) {
  try {
    const set = new Set();
    const sinceSec = Math.floor(Date.now() / 1000) - 365 * 24 * 60 * 60;
    const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: statusName } }] }));
    for (let page = 0; page < 60; page++) {
      const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${sinceSec}&filter=${filter}`, { headers: jnHeaders });
      if (!r.ok) return page === 0 ? null : set;
      const d = await r.json().catch(() => ({}));
      const list = d.results || d.jobs || [];
      for (const j of list) { const id = j.jnid || j.id; if (id) set.add(id); }
      if (list.length < 100) break;
    }
    return set;
  } catch { return null; }
}

async function getJobStatus(jnid) {
  try {
    const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(jnid)}`, { headers: jnHeaders });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j ? (j.status_name || null) : null;
  } catch { return null; }
}

async function loadTracking(jnids) {
  const map = new Map();
  if (!jnids.length) return map;
  // Chunk the IN() list so the URL doesn't blow up.
  for (let i = 0; i < jnids.length; i += 100) {
    const chunk = jnids.slice(i, i + 100);
    const inList = chunk.map((x) => `"${x}"`).join(",");
    const rows = await sbGet(`retail_status_tracking?jn_job_id=in.(${encodeURIComponent(inList)})&select=jn_job_id,at_sit_sold,current_status,converted_at,sales_rep_id,sales_rep_name`);
    for (const r of rows) map.set(r.jn_job_id, r);
  }
  return map;
}

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function sbUpsert(rows) {
  await fetch(`${SB_URL}/rest/v1/retail_status_tracking?on_conflict=jn_job_id`, {
    method: "POST", headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows),
  });
}
async function sbPatch(jnid, fields) {
  const body = { ...fields, updated_at: new Date().toISOString() };
  delete body.jn_job_id;
  await fetch(`${SB_URL}/rest/v1/retail_status_tracking?jn_job_id=eq.${encodeURIComponent(jnid)}`, {
    method: "PATCH", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(body),
  });
}

function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body };
}

exports.config = { schedule: "0 * * * *" };
