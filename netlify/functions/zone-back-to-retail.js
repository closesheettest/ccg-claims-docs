// netlify/functions/zone-back-to-retail.js
//
// "Back to retail" report for a regional manager. Pulls CCG inspections
// whose result is "retail" (the insurance angle is dead, so the
// homeowner becomes a retail roof sale), scoped to ONE zone, grouped by
// the deal's sales rep — sorted like the leaderboard. Shows when it was
// inspected.
//
// Any deal whose sales rep is NO LONGER ACTIVE is split into a separate
// `inactive_reps` group so the manager can pass those leads back out to
// an active rep (e.g. a dedicated inspector ran it and the owning rep has
// since left).
//
// CORS-open: called from the TMS regional-manager dashboard.
//
// GET /.netlify/functions/zone-back-to-retail?zone=Zone%204[&days=120]
// → { ok, zone, total, reps:[...], inactive_reps:[...] }
//   each rep: { rep, count, inactive, deals:[{ customer, address, appt, appt_label, status }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const RESULT = "retail";
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
// A retail lead stays in the OPEN list while its JN job is STILL at "Sit Sold
// Insp" — nobody's gone back out yet. Once a rep works it and the homeowner
// declines an appointment, the rep sets the JN status to "BTR - NI" (Back To
// Retail – Not Interested): we surface those in a separate "Not Interested"
// section (the rep gets credit for working it). Any other status (sold, lost,
// appointment booked, …) drops the lead off this report entirely.
const STILL_OPEN_STATUS = "Sit Sold Insp";
const NOT_INTERESTED_STATUS = "BTR - NI";
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
// Zone is decided by the PROPERTY's county (same territory map used to assign
// reps to zones), not the rep — so departed reps / trainers land correctly.
// Inlined (no local require) to keep this a self-contained CommonJS function.
const ZONE_COUNTIES = {
  "Zone 1": ["Nassau", "Duval", "Baker", "Union", "Bradford", "Clay", "St. Johns", "Putnam", "Flagler", "Alachua", "Levy", "Marion", "Sumter", "Lake", "Seminole", "Volusia"],
  "Zone 2": ["Pasco", "Hillsborough", "Polk", "Osceola", "Indian River", "Highlands", "Citrus", "Hernando"],
  "Zone 3": ["Pinellas", "Manatee", "Sarasota", "Charlotte", "Lee", "Collier", "Monroe", "Hardee", "DeSoto", "Glades", "Hendry", "St. Lucie", "Okeechobee"],
  "Zone 4": ["Martin", "Palm Beach", "Broward", "Miami-Dade"],
};
const SPLIT_LAT = 28.55; // Brevard & Orange: north→Zone 1, south→Zone 2
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
  if (event.httpMethod !== "GET") return cors(405, JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Server misconfigured (missing Supabase env)" }));

  const qp = event.queryStringParameters || {};
  const zone = (qp.zone || "").trim();
  if (!zone) return cors(400, JSON.stringify({ ok: false, error: "zone required" }));
  const days = Math.min(Math.max(parseInt(qp.days, 10) || 120, 7), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    return await buildReport({ zone, days, since, resultValue: RESULT });
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "Unknown error" }));
  }
};

async function buildReport({ zone, days, since, resultValue }) {
  // Inspections with this result, not cancelled, in the window.
  const rows = await fetchTable("inspections", {
    select: "id,jn_job_id,sales_rep_id,sales_rep_name,inspector_name,signed_at,result,result_at,client_name,address,city,zip,county,latitude,cancelled_at",
    filter:
      `result=eq.${encodeURIComponent(resultValue)}` +
      `&cancelled_at=is.null` +
      `&result_at=gte.${encodeURIComponent(since.toISOString())}`,
    limit: 3000,
  });

  const deduped = dedupByHome(rows);
  const resolve = await buildZoneResolver();

  // JN jobs still at "Sit Sold Insp" (nobody's worked them yet). A retail lead
  // whose JN status has moved to anything else has been handled → drop it.
  // Fail-open: if JN is unreachable, we don't filter (show everything).
  const sinceSec = Math.floor(since.getTime() / 1000) - 30 * 24 * 60 * 60;
  // Fail-open: if JN is unreachable both sets are null and we show everything
  // as open (never filter on a bad read).
  const stillOpen = JN_KEY ? await fetchJnidsByStatus(STILL_OPEN_STATUS, sinceSec) : null;
  const notInterested = JN_KEY ? await fetchJnidsByStatus(NOT_INTERESTED_STATUS, sinceSec) : null;

  const active = {}, inactive = {}, ni = {};
  let total = 0, niTotal = 0;
  for (const r of deduped) {
    const rec = resolve(r.sales_rep_id, r.sales_rep_name);
    // Zone by PROPERTY county (same territory map used to assign reps to
    // zones); fall back to the rep's zone only when the address can't be
    // placed. So departed reps / trainers (e.g. William) land in the right zone.
    const byCounty = countyToZone(r.county, r.latitude);
    const dealZone = byCounty !== "Unassigned" ? byCounty : (rec?.zone || "Unassigned");
    if (dealZone !== zone) continue;

    const rep = (r.sales_rep_name || "").trim() || "(no rep)";
    const when = r.result_at || r.signed_at || null;
    const deal = {
      customer: (r.client_name || "—").replace(/\s+/g, " ").trim(),
      address: [r.address, r.city].filter(Boolean).join(", "),
      appt: when ? new Date(when).getTime() : null,
      appt_label: when ? dateLabel(new Date(when)) : "—",
      status: r.inspector_name ? `Inspected by ${r.inspector_name}` : "",
      jnid: r.jn_job_id || null,
    };

    // OPEN: still "Sit Sold Insp" (or no JN link / JN unreachable → can't tell).
    const isOpen = !stillOpen || !r.jn_job_id || stillOpen.has(r.jn_job_id);
    if (isOpen) {
      total++;
      const bucket = (rec && rec.active !== false) ? active : inactive;
      (bucket[rep] = bucket[rep] || []).push(deal);
    } else if (notInterested && r.jn_job_id && notInterested.has(r.jn_job_id)) {
      // Worked, homeowner declined an appointment (BTR - NI).
      niTotal++;
      (ni[rep] = ni[rep] || []).push(deal);
    }
    // else: worked & moved on (sold / lost / appointment booked) → drop.
  }

  const shape = (obj, isInactive) => Object.entries(obj)
    .map(([rep, deals]) => ({ rep, count: deals.length, inactive: isInactive, deals: deals.sort((a, b) => (b.appt || 0) - (a.appt || 0)) }))
    .sort((a, b) => b.count - a.count || a.rep.localeCompare(b.rep));

  return cors(200, JSON.stringify({
    ok: true, zone, days, total,
    reps: shape(active, false), inactive_reps: shape(inactive, true),
    not_interested: shape(ni, false), not_interested_total: niTotal,
  }));
}

// Set of JN job ids currently at a given status (status-filtered fetch, so we
// never hit the date-scan cap). Returns null on any JN error → caller fails
// open (no status filtering, shows everything).
async function fetchJnidsByStatus(statusName, sinceSec) {
  try {
    const set = new Set();
    const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: statusName } }] }));
    for (let page = 0; page < 40; page++) {
      const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${sinceSec}&filter=${filter}`, { headers: jnHeaders });
      if (!r.ok) return page === 0 ? null : set;
      const d = await r.json().catch(() => ({}));
      const rows = d.results || d.jobs || [];
      for (const j of rows) { const id = j.jnid || j.id; if (id) set.add(id); }
      if (rows.length < 100) break;
    }
    return set;
  } catch { return null; }
}

// One row per homeowner: keep the most recent by result_at/signed_at.
function dedupByHome(rows) {
  const key = (r) => {
    const n = (r.client_name || "").trim().toLowerCase().replace(/\s+/g, " ");
    const z = (r.zip || "").trim();
    return z ? `${n}|zip:${z}` : `${n}|st:${(r.address || "").split(",")[0].trim().toLowerCase()}`;
  };
  const m = new Map();
  for (const r of rows || []) {
    const k = key(r);
    const ex = m.get(k);
    if (!ex) { m.set(k, r); continue; }
    const t = (x) => (x.result_at ? Date.parse(x.result_at) : x.signed_at ? Date.parse(x.signed_at) : 0);
    if (t(r) > t(ex)) m.set(k, r);
  }
  return [...m.values()];
}

// "Mon, Jun 9, 2:45 PM" in Eastern. Imported date-only records sit at
// midnight — for those we drop the time (no real clock time was captured).
function dateLabel(date) {
  const d = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(date);
  const hm = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  if (hm === "00:00" || hm === "24:00") return d;
  const t = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(date);
  return `${d}, ${t}`;
}

// rep (CCG sales_rep_id or name) → { zone, active }. Bridges CCG
// sales_reps → TMS rep-zones (include_inactive), and also matches the
// inspection's rep name directly against TMS reps as a fallback.
async function buildZoneResolver() {
  let tmsReps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) tmsReps = (await res.json()).reps || []; }
  catch (e) { console.warn("rep-zones fetch failed:", e.message || e); }
  const byJnId = {}, byNorm = {};
  for (const r of tmsReps) {
    const entry = { zone: r.zone || null, active: r.active !== false };
    if (r.jobnimbus_id) byJnId[r.jobnimbus_id] = entry;
    if (r.name) byNorm[normalizeName(r.name)] = entry;
  }

  const salesReps = await fetchTable("sales_reps", { select: "id,name,jobnimbus_id", limit: 2000 });
  const byId = {}, byName = {};
  for (const sr of salesReps || []) {
    const entry = (sr.jobnimbus_id && byJnId[sr.jobnimbus_id]) || byNorm[normalizeName(sr.name)] || null;
    if (!entry) continue;
    if (sr.id != null) byId[String(sr.id)] = entry;
    if (sr.name) byName[normalizeName(sr.name)] = entry;
  }

  return (repId, repName) =>
    (repId != null && byId[String(repId)]) ||
    byName[normalizeName(repName)] ||
    byNorm[normalizeName(repName)] ||
    null;
}

function normalizeName(s) {
  return String(s || "").toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

async function fetchTable(table, { select, filter, limit }) {
  let url = `${SB_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`;
  if (filter) url += `&${filter}`;
  if (limit) url += `&limit=${limit}`;
  const res = await fetch(url, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!res.ok) { console.warn(`Supabase ${table} failed: ${res.status}`); return []; }
  return await res.json().catch(() => []);
}

function cors(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=120",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body,
  };
}
