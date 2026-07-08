// netlify/functions/admin-sales-metrics.js
//
// Weekly sales time-series for the Regional-Managers line graph. Reads sold
// JN deals, buckets by Sold Date (cf_date_5), week = Mon–Sun (ET). Returns
// BOTH a count and a dollar total for each series, so the chart can switch
// between "# deals" and "$ revenue":
//
//   • all        — every sold deal (overall progress)
//   • iq         — lead source "Instant Quote"
//   • harvested  — "Sales Rep Harvested" = Yes
//   • btr        — back to retail: lead source "Inspection"
//   • irb        — deal includes Insulation and/or Radiant Barrier
//
// $ value of a deal = max(approved estimate, approved invoice, last budget
// revenue) — same as the Appointments→Sales report.
//
//   GET ?range=year (default) | all      [&metric ignored — both returned]
//   → { ok, range, weeks:[{key,label}], count:{all,iq,harvested,btr,irb},
//        dollars:{all,iq,harvested,btr,irb}, truncated }
//
// Open-CORS. Env: JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

const SOLD_STATUS_NAMES = [
  "Sit - Sold", "Signed Contract", "Production Review", "Job Prep",
  "Upcoming Installs", "Install Set",
];
// All-time paginates far deeper (old sales sit deep in the -date_updated list).
const PAGE_CAP_YEAR = 25;   // 2,500 / status
const PAGE_CAP_ALL = 90;    // 9,000 / status (JN from+size cap is 10k)
const KEYS = ["all", "iq", "harvested", "btr", "irb"];

const isYes = (v) => v === true || v === "true" || v === "Yes" || v === "yes" || v === 1;
function fieldByLabel(job, label) {
  if (label in job) return job[label];
  for (const [k, v] of Object.entries(job)) {
    if (k.trim().replace(/^\*|\*$/g, "").trim() === label) return v;
  }
  return undefined;
}
const saleAmount = (j) =>
  Math.max(Number(j.approved_estimate_total) || 0, Number(j.approved_invoice_total) || 0, Number(j.last_budget_revenue) || 0);

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
  const pageCap = range === "year" ? PAGE_CAP_YEAR : PAGE_CAP_ALL;

  // week -> { count:{k:n}, dollars:{k:$} }
  const cnt = {}, dol = {};
  const bump = (wk, key, amt) => {
    (cnt[wk] = cnt[wk] || {})[key] = (cnt[wk][key] || 0) + 1;
    (dol[wk] = dol[wk] || {})[key] = (dol[wk][key] || 0) + amt;
  };
  let truncated = false;

  try {
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
        const wk = etMonday(soldSec);
        if (range === "year" && wk < floorKey) continue;
        const amt = saleAmount(j);
        const src = String(j.source_name || "");
        bump(wk, "all", amt);
        if (src === "Instant Quote") bump(wk, "iq", amt);
        if (src === "Inspection") bump(wk, "btr", amt);
        if (isYes(fieldByLabel(j, "Sales Rep Harvested"))) bump(wk, "harvested", amt);
        if (isYes(fieldByLabel(j, "Insulation")) || isYes(fieldByLabel(j, "Radiant Barrier"))) bump(wk, "irb", amt);
      }
    }

    const keys = Object.keys(cnt).filter((k) => k !== "0000").sort();
    const weeks = keys.map((k) => ({ key: k, label: weekLabel(k) }));
    const pick = (src) => Object.fromEntries(KEYS.map((k) => [k, keys.map((wk) => Math.round(src[wk]?.[k] || 0))]));
    return cors(200, JSON.stringify({ ok: true, range, weeks, count: pick(cnt), dollars: pick(dol), truncated }));
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
