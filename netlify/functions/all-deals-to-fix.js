// netlify/functions/all-deals-to-fix.js
//
// Admin-wide "All deals that need to be fixed." Same scan + checklist as
// zone-deals-to-fix.js (the per-manager view) and the morning audit
// (_sales-audit.js), but with NO zone filter — it returns EVERY flagged
// sale across ALL zones, grouped by region, then by rep, in one call.
//
// Used by the regional-managers admin hub (TMS RegionalManagers.jsx) so an
// admin sees the whole company's data-hygiene backlog at a glance.
//
// Scans JN sales from a fixed floor (default 2026-06-01) with NO rolling
// upper cutoff — a deal stays listed until it's clean (live re-audit drops
// it the moment the rep fixes it).
//
// CORS-open: called cross-origin from the TMS dashboard.
//
// GET /.netlify/functions/all-deals-to-fix[?since=YYYY-MM-DD]
// → { ok, since, total_flagged, zones:[{ zone, count,
//      reps:[{ rep, count, deals:[{ name, customer, address, sold,
//      missing[], errors[] }] }] }] }
//
// Env: JOBNIMBUS_API_KEY.

import { auditJob } from "./_sales-audit.js";

const JN_BASE = "https://app.jobnimbus.com/api1";
const TMS_REP_ZONES_URL =
  "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

const SOLD_STATUSES = new Set([
  "sit sold", "signed contract", "production review", "job prep",
  "upcoming installs", "install set",
]);

// Exact JN status_name spellings — pull jobs BY these statuses (not the 1,500
// most-recently-updated of all statuses, which truncated and dropped older
// sold deals). The normalized SOLD_STATUSES set above stays the authority, so
// over-matches (e.g. "Sit Sold Insp" from a "Sit - Sold" phrase) are dropped.
const SOLD_STATUS_NAMES = [
  "Sit - Sold", "Signed Contract", "Production Review", "Job Prep",
  "Upcoming Installs", "Install Set",
];

// Stable display order for the four regions (everything else lands last).
const ZONE_ORDER = ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "GET") return cors(405, JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing JOBNIMBUS_API_KEY" }));

  const qp = event.queryStringParameters || {};
  const since = /^\d{4}-\d{2}-\d{2}$/.test(qp.since || "") ? qp.since : "2026-06-01";

  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const cutoffMs = new Date(`${since}T04:00:00Z`).getTime(); // ~ET midnight (EDT)
  const sinceSec = Math.floor(cutoffMs / 1000) - 2 * 24 * 60 * 60; // pad the fetch window

  // 1. Pull jobs BY sold status (server-side filter) so no sold deal is lost
  //    to a scan cap; then keep those actually sold within the window.
  const jobs = await fetchSoldJobs(jnHeaders, sinceSec);

  // Temp probe: ?probe=<term> → show why a specific job is/ isn't flagged.
  if (qp.probe) {
    const term = qp.probe.toLowerCase();
    const hits = jobs.filter((j) => `${j.name || ""} ${j.sales_rep_name || ""} ${j.number || ""}`.toLowerCase().includes(term));
    return cors(200, JSON.stringify({
      fetched: jobs.length, matches: hits.length,
      jobs: hits.slice(0, 5).map((j) => { const a = auditJob(j); return { name: j.name, status: j.status_name, rep: j.sales_rep_name, sold_date_field: j["Sold Date"] ?? null, cf_date_5: j.cf_date_5 ?? null, soldSec: soldDateSec(j), missing: a.missing, errors: a.errors }; }),
    }, null, 2));
  }
  const sold = jobs.filter((j) => {
    const sd = soldDateSec(j);
    if (sd == null || sd * 1000 < cutoffMs) return false;
    const status = String(j.status_name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return SOLD_STATUSES.has(status);
  });

  // 2. Zone resolver (rep → zone via TMS rep-zones).
  const dir = await fetchRepDirectory();

  // 3. Audit + group by zone → rep.
  const byZone = {}; // zone -> { rep -> deals[] }
  let totalFlagged = 0;
  for (const j of sold) {
    const { missing, errors } = auditJob(j);
    if (!missing.length && !errors.length) continue;
    const z = dir(j.sales_rep, j.sales_rep_name)?.zone || "Unassigned";
    totalFlagged++;
    const rep = (j.sales_rep_name || "").trim() || "(no rep)";
    const customer = (j.primary && j.primary.name ? String(j.primary.name).replace(/\s+/g, " ").trim() : "—");
    const address = [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", ");
    const sd = soldDateSec(j);
    const reps = (byZone[z] = byZone[z] || {});
    (reps[rep] = reps[rep] || []).push({
      name: j.name || "(no name)",
      customer,
      address,
      sold: sd ? etYMD(new Date(sd * 1000)) : null,
      missing,
      errors,
    });
  }

  // 4. Shape: zones (ordered) → reps (most flagged first).
  const zones = Object.entries(byZone)
    .map(([zone, repsMap]) => {
      const reps = Object.entries(repsMap)
        .map(([rep, deals]) => ({
          rep,
          count: deals.length,
          deals: deals.sort((a, b) => (b.sold || "").localeCompare(a.sold || "")),
        }))
        .sort((a, b) => b.count - a.count || a.rep.localeCompare(b.rep));
      return { zone, count: reps.reduce((s, r) => s + r.count, 0), reps };
    })
    .sort((a, b) => {
      const ia = ZONE_ORDER.indexOf(a.zone), ib = ZONE_ORDER.indexOf(b.zone);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.zone.localeCompare(b.zone);
    });

  return cors(200, JSON.stringify({ ok: true, since, total_flagged: totalFlagged, zones }));
};

// ── infra (mirrors zone-deals-to-fix.js; checklist shared in _sales-audit.js) ──
// Pull jobs by each sold status_name (server-side filter), updated since the
// window opened — small, capped-proof result set; deduped by jnid.
async function fetchSoldJobs(jnHeaders, sinceSec) {
  const byId = new Map();
  for (const name of SOLD_STATUS_NAMES) {
    const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: name } }] }));
    for (let page = 0; page < 20; page++) {
      const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${sinceSec}&filter=${filter}`, { headers: jnHeaders });
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const rows = d.results || d.jobs || [];
      for (const j of rows) byId.set(j.jnid || j.id, j);
      if (rows.length < 100) break;
    }
  }
  return [...byId.values()];
}
function soldDateSec(job) {
  const v = job["Sold Date"] != null ? job["Sold Date"] : job.cf_date_5;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function etYMD(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
async function fetchRepDirectory() {
  let reps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) reps = (await res.json()).reps || []; }
  catch (e) { console.warn("rep-zones fetch failed:", e.message || e); }
  const byJnId = {}, byName = {};
  for (const r of reps) {
    const entry = { zone: r.zone || null };
    if (r.jobnimbus_id) byJnId[r.jobnimbus_id] = entry;
    if (r.name) byName[normalizeName(r.name)] = entry;
  }
  return (jnId, name) => (jnId && byJnId[jnId]) || byName[normalizeName(name)] || null;
}
function normalizeName(s) {
  return String(s || "").toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
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
