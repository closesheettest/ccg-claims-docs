// netlify/functions/zone-no-sits.js
//
// "No-sits to re-book" for a regional manager. Pulls JobNimbus jobs whose
// status is any "No Sit…" (the homeowner didn't sit / no-showed the
// appointment), scoped to ONE zone, grouped by rep — so the manager can
// chase them back onto the calendar. Shows WHEN the appointment was for
// (the JN job's date_start).
//
// A job keeps its No-Sit status until it's re-booked, so it stays on the
// list until the rep changes it in JN (live re-pull drops it once fixed).
//
// CORS-open: called from the TMS regional-manager dashboard.
//
// GET /.netlify/functions/zone-no-sits?zone=Zone%204[&days=90]
// → { ok, zone, total, reps:[{ rep, count,
//      deals:[{ name, customer, address, appt, appt_label, status }] }] }
//
// Env: JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
// include_inactive=1 so a no-sit from a departed rep still resolves to that
// rep's zone and shows on the right region's dashboard.
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

// A status is a "no sit" if, once stripped to letters/numbers/spaces, it
// starts with "no sit" — catches "No Sit", "No Sit - No Show",
// "No Sit- Need to Reschedule", etc. BUT we exclude "No Sit - Rescheduled":
// those are already back on the calendar, so there's nothing to re-book.
// (Note: "need to reschedule" normalizes to "...reschedule" without the
// trailing "d", so it is NOT caught by the "rescheduled" exclusion.)
function isNoSit(statusName) {
  const s = String(statusName || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!s.startsWith("no sit")) return false;
  if (s.includes("rescheduled")) return false;
  return true;
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

  // 1. Recent jobs, keep the No-Sit ones.
  const jobs = await fetchRecentJobs(jnHeaders, sinceSec);
  const noSits = jobs.filter((j) => isNoSit(j.status_name));

  // 2. Rep → zone resolver (TMS rep-zones).
  const dir = await fetchRepDirectory();

  // 3. Filter to THIS zone + group by rep.
  const byRep = {};
  let total = 0;
  for (const j of noSits) {
    const z = dir(j.sales_rep, j.sales_rep_name)?.zone || null;
    if (z !== zone) continue;
    total++;
    const rep = (j.sales_rep_name || "").trim() || "(no rep)";
    const customer = j.primary && j.primary.name ? String(j.primary.name).replace(/\s+/g, " ").trim() : "—";
    const address = [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", ");
    const apptSec = Number(j.date_start);
    const appt = Number.isFinite(apptSec) && apptSec > 0 ? apptSec : null;
    // "Scheduled" = when the JN record was created (when they booked it).
    const createdSec = Number(j.date_created);
    const created = Number.isFinite(createdSec) && createdSec > 0 ? createdSec : null;
    (byRep[rep] = byRep[rep] || []).push({
      name: j.name || "(no name)",
      customer,
      address,
      appt,
      appt_label: appt ? apptLabel(new Date(appt * 1000)) : "No appt date set",
      scheduled: created,
      scheduled_label: created ? dtLabel(new Date(created * 1000)) : null,
      status: j.status_name || "No Sit",
    });
  }

  const reps = Object.entries(byRep)
    .map(([rep, deals]) => ({ rep, count: deals.length, deals: deals.sort((a, b) => (b.appt || 0) - (a.appt || 0)) }))
    .sort((a, b) => b.count - a.count || a.rep.localeCompare(b.rep));

  return cors(200, JSON.stringify({ ok: true, zone, days, total, reps }));
};

// "Mon, Jun 9 · 5:30 PM" in Eastern — but if the appt has no real time
// (stored at midnight = date only), show just the date.
function apptLabel(date) {
  const datePart = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(date);
  const hm = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  if (hm === "00:00" || hm === "24:00") return datePart;
  const timePart = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(date);
  return `${datePart} · ${timePart}`;
}

// Date + time in Eastern — used for the "scheduled" (record-created) stamp.
function dtLabel(date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
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
