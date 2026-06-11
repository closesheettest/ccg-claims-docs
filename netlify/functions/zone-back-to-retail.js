// netlify/functions/zone-back-to-retail.js
//
// "Back to retail" report for a regional manager. Pulls JobNimbus jobs
// whose status is any "Back to Retail…" (the insurance angle is dead, so
// the homeowner becomes a retail roof sale), scoped to ONE zone, grouped
// by rep — sorted like the leaderboard. Shows WHEN the appointment was
// for (the JN job's date_start).
//
// Any deal whose sales rep is NO LONGER ACTIVE is split into a separate
// `inactive_reps` group so the manager can pass those leads back out to
// an active rep.
//
// CORS-open: called from the TMS regional-manager dashboard.
//
// GET /.netlify/functions/zone-back-to-retail?zone=Zone%204[&days=90]
// → { ok, zone, total, reps:[...], inactive_reps:[...] }
//   each rep: { rep, count, inactive, deals:[{ name, customer, address, appt, appt_label, status }] }
//
// Env: JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

// A status is "back to retail" if, once stripped to letters/numbers/
// spaces, it starts with "back to retail" — catches "Back to Retail",
// "Back To Retail - Needs Rep", "Back-to-Retail", etc.
function matchesStatus(statusName) {
  const s = String(statusName || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return s.startsWith("back to retail");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "GET") return cors(405, JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing JOBNIMBUS_API_KEY" }));

  const qp = event.queryStringParameters || {};
  const zone = (qp.zone || "").trim();
  if (!zone) return cors(400, JSON.stringify({ ok: false, error: "zone required" }));
  const days = Math.min(Math.max(parseInt(qp.days, 10) || 90, 7), 365);

  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const sinceSec = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;

  const jobs = await fetchRecentJobs(jnHeaders, sinceSec);
  const matched = jobs.filter((j) => matchesStatus(j.status_name));
  const dir = await fetchRepDirectory();

  const result = groupByZone(matched, dir, zone);
  return cors(200, JSON.stringify({ ok: true, zone, days, ...result }));
};

// Shared grouping: scope to one zone, split active vs. non-active reps.
function groupByZone(matched, dir, zone) {
  const active = {}, inactive = {};
  let total = 0;
  for (const j of matched) {
    const rec = dir(j.sales_rep, j.sales_rep_name);
    if (!rec || rec.zone !== zone) continue;
    total++;
    const rep = (j.sales_rep_name || "").trim() || "(no rep)";
    const customer = j.primary && j.primary.name ? String(j.primary.name).replace(/\s+/g, " ").trim() : "—";
    const address = [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", ");
    const apptSec = Number(j.date_start);
    const appt = Number.isFinite(apptSec) && apptSec > 0 ? apptSec : null;
    const bucket = rec.active ? active : inactive;
    (bucket[rep] = bucket[rep] || []).push({
      name: j.name || "(no name)",
      customer,
      address,
      appt,
      appt_label: appt ? apptLabel(new Date(appt * 1000)) : "No appt date set",
      status: j.status_name || "",
    });
  }
  const shape = (obj, isInactive) => Object.entries(obj)
    .map(([rep, deals]) => ({ rep, count: deals.length, inactive: isInactive, deals: deals.sort((a, b) => (b.appt || 0) - (a.appt || 0)) }))
    .sort((a, b) => b.count - a.count || a.rep.localeCompare(b.rep));
  return { total, reps: shape(active, false), inactive_reps: shape(inactive, true) };
}

// "Mon, Jun 9 · 5:30 PM" in Eastern — but if the appt has no real time
// (stored at midnight = date only), show just the date.
function apptLabel(date) {
  const datePart = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(date);
  const hm = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  if (hm === "00:00" || hm === "24:00") return datePart;
  const timePart = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(date);
  return `${datePart} · ${timePart}`;
}

async function fetchRecentJobs(jnHeaders, sinceSec) {
  const all = [];
  for (let page = 0; page < 15; page++) {
    const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${sinceSec}`, { headers: jnHeaders });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const rows = d.results || d.jobs || [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}
async function fetchRepDirectory() {
  let reps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) reps = (await res.json()).reps || []; }
  catch (e) { console.warn("rep-zones fetch failed:", e.message || e); }
  const byJnId = {}, byName = {};
  for (const r of reps) {
    const entry = { zone: r.zone || null, active: r.active !== false };
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
