// netlify/functions/admin-sales-metrics.js
//
// Weekly time-series for the admin dashboard bar graph (Regional Manager
// section). Three series, bucketed by week (Mon–Sun, ET):
//
//   • total_sales — JN sold deals, by Sold Date (cf_date_5)
//   • btr         — CCG inspections whose result is "retail" (back-to-retail),
//                   by result date
//   • irb         — sold deals that include Insulation and/or Radiant Barrier
//
//   GET /.netlify/functions/admin-sales-metrics?range=year   (default)
//   GET /.netlify/functions/admin-sales-metrics?range=all
//   → { ok, range, weeks:[{key,label}], series:{ total_sales:[], btr:[], irb:[] }, truncated }
//
// Open-CORS (called from the PIN-gated admin hub). Env: JOBNIMBUS_API_KEY,
// VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

const SOLD_STATUS_NAMES = [
  "Sit - Sold", "Signed Contract", "Production Review", "Job Prep",
  "Upcoming Installs", "Install Set",
];
const PAGE_CAP = 25; // per status (25*100 = 2,500 deals/status ceiling)

const yes = (v) => v === true || v === "true" || v === "Yes" || v === "yes" || v === 1;

// Monday (Mon–Sun week) of the ET date for an epoch-seconds timestamp → "YYYY-MM-DD".
function etMonday(sec) {
  const et = new Date(new Date(sec * 1000).toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();               // 0=Sun … 6=Sat
  et.setDate(et.getDate() + (day === 0 ? -6 : 1 - day));
  et.setHours(0, 0, 0, 0);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}
const weekLabel = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!JN_KEY || !SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing env" }));
  const range = (event.queryStringParameters || {}).range === "all" ? "all" : "year";

  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const floorKey = range === "year" ? etMonday(Math.floor(yearStart.getTime() / 1000)) : "0000";
  // For range=year, only pull JN deals updated since Jan 1 (bounds the pull);
  // all-time drops the filter but keeps the page cap.
  const updatedAfter = range === "year" ? Math.floor(yearStart.getTime() / 1000) : 0;

  const total = {}, irb = {}, btr = {};
  let truncated = false;

  try {
    // ---- JN sold deals → total_sales + irb ----
    const perStatus = await Promise.all(SOLD_STATUS_NAMES.map(async (name) => {
      const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: name } }] }));
      const jobs = [];
      for (let page = 0; page < PAGE_CAP; page++) {
        const after = updatedAfter ? `&date_updated_after=${updatedAfter}` : "";
        const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated${after}&filter=${filter}`, { headers: jnH });
        if (!r.ok) break;
        const d = await r.json().catch(() => ({}));
        const rows = d.results || d.jobs || [];
        jobs.push(...rows);
        if (rows.length < 100) break;
        if (page === PAGE_CAP - 1) truncated = true;
      }
      return jobs;
    }));

    const seen = new Set();
    for (const jobs of perStatus) {
      for (const j of jobs) {
        const id = j.jnid || j.id;
        if (id && seen.has(id)) continue; // a deal can match only one status, but guard anyway
        if (id) seen.add(id);
        const soldSec = Number(j.cf_date_5) || Number(j["Sold Date"]) || 0;
        if (!soldSec) continue;
        const wk = etMonday(soldSec);
        if (range === "year" && wk < floorKey) continue;
        total[wk] = (total[wk] || 0) + 1;
        if (yes(j["Insulation"]) || yes(j["Radiant Barrier"])) irb[wk] = (irb[wk] || 0) + 1;
      }
    }

    // ---- CCG inspections → btr (result=retail) ----
    const sinceIso = range === "year" ? yearStart.toISOString() : "2000-01-01";
    const insp = await sbGet(
      `inspections?result=eq.retail&cancelled_at=is.null&result_at=gte.${encodeURIComponent(sinceIso)}&select=result_at&limit=5000`
    );
    for (const r of insp) {
      const t = r.result_at ? Math.floor(Date.parse(r.result_at) / 1000) : 0;
      if (!t) continue;
      const wk = etMonday(t);
      if (range === "year" && wk < floorKey) continue;
      btr[wk] = (btr[wk] || 0) + 1;
    }

    // ---- assemble sorted week axis ----
    const keys = [...new Set([...Object.keys(total), ...Object.keys(btr), ...Object.keys(irb)])]
      .filter((k) => k !== "0000")
      .sort();
    const weeks = keys.map((k) => ({ key: k, label: weekLabel(k) }));
    const series = {
      total_sales: keys.map((k) => total[k] || 0),
      btr: keys.map((k) => btr[k] || 0),
      irb: keys.map((k) => irb[k] || 0),
    };

    return cors(200, JSON.stringify({ ok: true, range, weeks, series, truncated }));
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
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=600",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body,
  };
}
