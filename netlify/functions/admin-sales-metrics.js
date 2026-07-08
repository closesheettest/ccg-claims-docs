// netlify/functions/admin-sales-metrics.js
//
// Weekly time-series of SALES by type, for the Regional-Managers line graph.
// Each series is a count of sold JN deals bucketed by Sold Date (cf_date_5),
// week = Mon–Sun (ET). Four toggleable series:
//
//   • iq         — lead source "Instant Quote" (IQ)
//   • harvested  — "Sales Rep Harvested" = Yes
//   • btr        — back to retail: lead source "Inspection" (stamped on signing)
//   • irb        — deal includes Insulation and/or Radiant Barrier
//
// (A deal can appear in more than one series — e.g. an IQ sale that also has a
// radiant barrier — because they're different questions, not a partition.)
//
//   GET /.netlify/functions/admin-sales-metrics?range=year   (default) | all
//   → { ok, range, weeks:[{key,label}], series:{ iq:[], harvested:[], btr:[], irb:[] }, truncated }
//
// Open-CORS (called cross-origin from the TMS Regional Managers page).
// Env: JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

const SOLD_STATUS_NAMES = [
  "Sit - Sold", "Signed Contract", "Production Review", "Job Prep",
  "Upcoming Installs", "Install Set",
];
const PAGE_CAP = 25;

const isYes = (v) => v === true || v === "true" || v === "Yes" || v === "yes" || v === 1;
// Read a JN custom field by its display label (JN returns them as top-level
// keys; tolerate trailing spaces and *…* wrappers, like _sales-audit does).
function fieldByLabel(job, label) {
  if (label in job) return job[label];
  for (const [k, v] of Object.entries(job)) {
    const bare = k.trim().replace(/^\*|\*$/g, "").trim();
    if (bare === label) return v;
  }
  return undefined;
}

function etMonday(sec) {
  const et = new Date(new Date(sec * 1000).toLocaleString("en-US", { timeZone: "America/New_York" }));
  et.setDate(et.getDate() + (et.getDay() === 0 ? -6 : 1 - et.getDay()));
  et.setHours(0, 0, 0, 0);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, "0")}-${String(et.getDate()).padStart(2, "0")}`;
}
const weekLabel = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing JOBNIMBUS_API_KEY" }));
  const range = (event.queryStringParameters || {}).range === "all" ? "all" : "year";

  const yearStart = new Date(new Date().getFullYear(), 0, 1);
  const floorKey = range === "year" ? etMonday(Math.floor(yearStart.getTime() / 1000)) : "0000";
  const updatedAfter = range === "year" ? Math.floor(yearStart.getTime() / 1000) : 0;

  const iq = {}, harvested = {}, btr = {}, irb = {};
  let truncated = false;

  try {
    const perStatus = await Promise.all(SOLD_STATUS_NAMES.map(async (name) => {
      const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: name } }] }));
      const out = [];
      for (let page = 0; page < PAGE_CAP; page++) {
        const after = updatedAfter ? `&date_updated_after=${updatedAfter}` : "";
        const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated${after}&filter=${filter}`, { headers: jnH });
        if (!r.ok) break;
        const d = await r.json().catch(() => ({}));
        const rows = d.results || d.jobs || [];
        out.push(...rows);
        if (rows.length < 100) break;
        if (page === PAGE_CAP - 1) truncated = true;
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
        const wk = etMonday(soldSec);
        if (range === "year" && wk < floorKey) continue;

        const src = String(j.source_name || "");
        if (src === "Instant Quote") iq[wk] = (iq[wk] || 0) + 1;
        if (src === "Inspection") btr[wk] = (btr[wk] || 0) + 1;
        if (isYes(fieldByLabel(j, "Sales Rep Harvested"))) harvested[wk] = (harvested[wk] || 0) + 1;
        if (isYes(fieldByLabel(j, "Insulation")) || isYes(fieldByLabel(j, "Radiant Barrier"))) irb[wk] = (irb[wk] || 0) + 1;
      }
    }

    const keys = [...new Set([...Object.keys(iq), ...Object.keys(harvested), ...Object.keys(btr), ...Object.keys(irb)])]
      .filter((k) => k !== "0000").sort();
    const weeks = keys.map((k) => ({ key: k, label: weekLabel(k) }));
    const series = {
      iq: keys.map((k) => iq[k] || 0),
      harvested: keys.map((k) => harvested[k] || 0),
      btr: keys.map((k) => btr[k] || 0),
      irb: keys.map((k) => irb[k] || 0),
    };
    return cors(200, JSON.stringify({ ok: true, range, weeks, series, truncated }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

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
