// netlify/functions/admin-sales-metrics.js
//
// Weekly/monthly sales time-series for the Regional-Managers line graph. Reads
// sold JN deals, buckets by Sold Date (cf_date_5). Returns a count AND a dollar
// total per series (so the chart can switch # deals ↔ $ revenue):
//
//   • all        — every sold deal
//   • iq         — lead source "Instant Quote"
//   • harvested  — "Sales Rep Harvested" = Yes
//   • btr        — back to retail: has an inspection result (damage/no_damage/
//                   retail) OR lead source "Inspection" — SAME rule as the
//                   Appointments→Sales report (categoryOf in _appt-conversion).
//   • irb        — deal includes Insulation and/or Radiant Barrier
//
//   GET ?range=year|all  &bucket=week|month  [&by=zone]
//   → { ok, range, bucket, weeks:[{key,label}], count:{…}, dollars:{…},
//        zones?:{ "Zone 1":{count,dollars}, … }, truncated }
//
// Open-CORS. Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";

const SOLD_STATUS_NAMES = [
  "Sit - Sold", "Signed Contract", "Production Review", "Job Prep",
  "Upcoming Installs", "Install Set",
  "Roof Install", "Roof Complete", "Installed", "Paid & Closed", "Check complete",
];
const PAGE_CAP_YEAR = 25, PAGE_CAP_ALL = 90;
const KEYS = ["all", "iq", "harvested", "btr", "irb"];

const isYes = (v) => v === true || v === "true" || v === "Yes" || v === "yes" || v === 1;
function fieldByLabel(job, label) {
  if (label in job) return job[label];
  for (const [k, v] of Object.entries(job)) if (k.trim().replace(/^\*|\*$/g, "").trim() === label) return v;
  return undefined;
}
const saleAmount = (j) =>
  Math.max(Number(j.approved_estimate_total) || 0, Number(j.approved_invoice_total) || 0, Number(j.last_budget_revenue) || 0);

function etDate(sec) { return new Date(new Date(sec * 1000).toLocaleString("en-US", { timeZone: "America/New_York" })); }
function etMonday(sec) {
  const et = etDate(sec);
  et.setDate(et.getDate() + (et.getDay() === 0 ? -6 : 1 - et.getDay())); et.setHours(0, 0, 0, 0);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}
function etMonthFirst(sec) { const et = etDate(sec); return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-01`; }
const bucketKey = (sec, bucket) => (bucket === "month" ? etMonthFirst(sec) : etMonday(sec));
function fillKeys(minKey, maxKey, bucket) {
  const [y0, m0, d0] = minKey.split("-").map(Number), [y1, m1, d1] = maxKey.split("-").map(Number);
  const cur = new Date(y0, m0 - 1, d0), end = new Date(y1, m1 - 1, d1), out = [];
  while (cur <= end && out.length < 1000) {
    out.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`);
    if (bucket === "month") cur.setMonth(cur.getMonth() + 1); else cur.setDate(cur.getDate() + 7);
  }
  return out;
}
const bucketLabel = (key, bucket) => {
  const [y, m, d] = key.split("-").map(Number), dt = new Date(y, m - 1, d);
  return bucket === "month"
    ? dt.toLocaleDateString("en-US", { month: "short", year: "2-digit" })
    : dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing JOBNIMBUS_API_KEY" }));
  const qp = event.queryStringParameters || {};
  const range = qp.range === "all" ? "all" : "year";
  const bucket = qp.bucket === "month" ? "month" : "week";
  const by = qp.by === "zone" ? "zone" : "";

  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const etYear = etDate(Date.now() / 1000).getFullYear();
  const floorKey = range !== "year" ? "0000"
    : bucket === "month" ? `${etYear}-01-01`
    : etMonday(Math.floor(yearStart.getTime() / 1000));
  const updatedAfter = range === "year" ? Math.floor(yearStart.getTime() / 1000) : 0;
  const pageCap = range === "year" ? PAGE_CAP_YEAR : PAGE_CAP_ALL;

  try {
    // BTR set: JN jobs that have an inspection result (the back-to-retail funnel).
    const inspSet = new Set();
    if (SB_URL && SB_KEY) {
      const rows = await sbGet("inspections?result=not.is.null&cancelled_at=is.null&jn_job_id=not.is.null&select=jn_job_id&limit=20000");
      for (const r of rows) if (r.jn_job_id) inspSet.add(r.jn_job_id);
    }
    // rep jnid → zone (only when splitting by zone).
    const repZone = {};
    if (by === "zone") {
      try { const r = await fetch(REP_ZONES_URL); if (r.ok) for (const rep of (await r.json()).reps || []) if (rep.jobnimbus_id && rep.zone) repZone[rep.jobnimbus_id] = rep.zone; } catch { /* */ }
    }

    const cnt = {}, dol = {}, zc = {}, zd = {};
    const bump = (wk, key, amt, zone) => {
      (cnt[wk] = cnt[wk] || {})[key] = (cnt[wk][key] || 0) + 1;
      (dol[wk] = dol[wk] || {})[key] = (dol[wk][key] || 0) + amt;
      if (zone) {
        ((zc[zone] = zc[zone] || {})[wk] = zc[zone][wk] || {})[key] = (zc[zone][wk][key] || 0) + 1;
        ((zd[zone] = zd[zone] || {})[wk] = zd[zone][wk] || {})[key] = (zd[zone][wk][key] || 0) + amt;
      }
    };
    let truncated = false;

    const perStatus = await Promise.all(SOLD_STATUS_NAMES.map(async (name) => {
      const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: name } }] }));
      const out = [];
      for (let page = 0; page < pageCap; page++) {
        const after = updatedAfter ? `&date_updated_after=${updatedAfter}` : "";
        const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated${after}&filter=${filter}`, { headers: jnH });
        if (!r.ok) break;
        const d = await r.json().catch(() => ({}));
        const rows = d.results || d.jobs || [];
        out.push(...rows);
        if (rows.length < 100) break;
        if (page === pageCap - 1) truncated = true;
      }
      return out;
    }));

    const seen = new Set();
    for (const jobs of perStatus) {
      for (const j of jobs) {
        const id = j.jnid || j.id;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const soldSec = Number(j.cf_date_5) || Number(j["Sold Date"]) || 0;
        if (!soldSec) continue;
        const wk = bucketKey(soldSec, bucket);
        if (range === "year" && wk < floorKey) continue;
        const amt = saleAmount(j);
        const src = String(j.source_name || "");
        const zone = by === "zone" ? (repZone[j.sales_rep] || "Unassigned") : null;
        bump(wk, "all", amt, zone);
        if (src === "Instant Quote") bump(wk, "iq", amt, zone);
        if (src === "Inspection" || inspSet.has(id)) bump(wk, "btr", amt, zone);
        if (isYes(fieldByLabel(j, "Sales Rep Harvested"))) bump(wk, "harvested", amt, zone);
        if (isYes(fieldByLabel(j, "Insulation")) || isYes(fieldByLabel(j, "Radiant Barrier"))) bump(wk, "irb", amt, zone);
      }
    }

    const present = Object.keys(cnt).filter((k) => k !== "0000").sort();
    const keys = present.length ? fillKeys(present[0], present[present.length - 1], bucket) : [];
    const weeks = keys.map((k) => ({ key: k, label: bucketLabel(k, bucket) }));
    const pick = (map) => Object.fromEntries(KEYS.map((k) => [k, keys.map((wk) => Math.round(map[wk]?.[k] || 0))]));
    const resp = { ok: true, range, bucket, weeks, count: pick(cnt), dollars: pick(dol), truncated };
    if (by === "zone") {
      resp.zones = Object.fromEntries(Object.keys(zc).sort().map((z) => [z, { count: pick(zc[z]), dollars: pick(zd[z]) }]));
    }
    return cors(200, JSON.stringify(resp));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json", "Cache-Control": "public, max-age=600",
      "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
    },
    body,
  };
}
