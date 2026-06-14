// netlify/functions/zone-deals-to-fix.js
//
// On-demand "Deals need to be fixed" for a regional manager. Scans JobNimbus
// SALES from a fixed floor (default 2026-06-01, when regional managers came
// on) — NO rolling upper cutoff, so a deal stays listed until it's clean —
// against the shared sales-audit checklist (_sales-audit.js, same rules as the
// morning audit), filters to ONE zone, and groups the flagged deals by rep so
// the manager taps a rep to see exactly what's missing/wrong.
//
// CORS-open: called cross-origin from the TMS regional-manager dashboard.
//
// GET /.netlify/functions/zone-deals-to-fix?zone=Zone%204[&since=YYYY-MM-DD]
// → { ok, zone, since, total_flagged, reps:[{ rep, count,
//      deals:[{ name, customer, address, sold, missing[], errors[] }] }] }
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
// Exact JN status_name spellings — pull jobs BY these statuses so older sold
// deals aren't lost to the 1,500-job scan cap. SOLD_STATUSES stays the filter.
const SOLD_STATUS_NAMES = [
  "Sit - Sold", "Signed Contract", "Production Review", "Job Prep",
  "Upcoming Installs", "Install Set",
];

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "GET") return cors(405, JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing JOBNIMBUS_API_KEY" }));

  const qp = event.queryStringParameters || {};
  const zone = (qp.zone || "").trim();
  if (!zone) return cors(400, JSON.stringify({ ok: false, error: "zone required" }));
  // Fixed floor: regional managers came on ~June 1, 2026. There is NO rolling
  // upper cutoff — a deal stays on the list until it's actually clean, and the
  // live re-audit drops it the moment the rep fixes it in JN. Override the
  // floor with ?since=YYYY-MM-DD.
  const since = /^\d{4}-\d{2}-\d{2}$/.test(qp.since || "") ? qp.since : "2026-06-01";

  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const cutoffMs = new Date(`${since}T04:00:00Z`).getTime(); // ~ET midnight (EDT)
  const sinceSec = Math.floor(cutoffMs / 1000) - 2 * 24 * 60 * 60; // pad the fetch window

  // 1. Pull recent jobs, keep sales sold within the window.
  const jobs = await fetchSoldJobs(jnHeaders, sinceSec);
  const sold = jobs.filter((j) => {
    const sd = soldDateSec(j);
    if (sd == null || sd * 1000 < cutoffMs) return false;
    const status = String(j.status_name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return SOLD_STATUSES.has(status);
  });

  // 2. Zone resolver (rep → zone via TMS rep-zones).
  const dir = await fetchRepDirectory();

  // 3. Audit + filter to THIS zone + group by rep.
  const byRep = {};
  let totalFlagged = 0;
  for (const j of sold) {
    const z = dir(j.sales_rep, j.sales_rep_name)?.zone || null;
    if (z !== zone) continue;
    const { missing, errors } = auditJob(j);
    if (!missing.length && !errors.length) continue;
    totalFlagged++;
    const rep = (j.sales_rep_name || "").trim() || "(no rep)";
    const customer = (j.primary && j.primary.name ? String(j.primary.name).replace(/\s+/g, " ").trim() : "—");
    const address = [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", ");
    const sd = soldDateSec(j);
    (byRep[rep] = byRep[rep] || []).push({
      name: j.name || "(no name)",
      customer,
      address,
      sold: sd ? etYMD(new Date(sd * 1000)) : null,
      missing,
      errors,
    });
  }

  const reps = Object.entries(byRep)
    .map(([rep, deals]) => ({ rep, count: deals.length, deals: deals.sort((a, b) => (b.sold || "").localeCompare(a.sold || "")) }))
    .sort((a, b) => b.count - a.count || a.rep.localeCompare(b.rep));

  return cors(200, JSON.stringify({ ok: true, zone, since, total_flagged: totalFlagged, reps }));
};

// ── infra (stable; checklist is shared in _sales-audit.js) ──────────────
// Pull jobs by each sold status_name (server-side filter), updated since the
// window opened — capped-proof; deduped by jnid.
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
