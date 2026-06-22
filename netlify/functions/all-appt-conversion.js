// netlify/functions/all-appt-conversion.js
//
// Company-wide "Appointments → Sales" — the all-zones version of
// zone-appt-conversion.js, for the Regional Managers admin hub. Grouped
// zone → rep, with per-zone and company totals. An appointment = a JN job that
// had an APPOINTMENT TASK in the period (see _appt-conversion.js).
//
// Period: ?period=week|lastweek|month OR ?start=ISO&end=ISO (default this week).
//
// GET /.netlify/functions/all-appt-conversion[?period=month]
// → { ok, period, range, totals, zones:[{ zone, totals, reps:[...] }] }
//
// Env: JOBNIMBUS_API_KEY.

import { fetchApptJobs, fetchSoldJobs, newRep, tallyAppt, tallySold, shapeRep, sumTotals, levelLabel } from "./_appt-conversion.js";

const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
const ZONE_ORDER = ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Unassigned"];

// In-memory cache (per warm instance) so a refresh returns instantly instead of
// re-pulling everything from JobNimbus (~5-6s) and risking a timeout.
const CACHE = new Map();
const TTL_MS = 90 * 1000;

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "GET") return cors(405, JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing JOBNIMBUS_API_KEY" }));

  try {
    const qp = event.queryStringParameters || {};
    const { start, end, period } = pickWindow(qp);
    const cacheKey = `all|${period}|${qp.start || ""}|${qp.end || ""}`;
    const hit = CACHE.get(cacheKey);
    if (hit && Date.now() - hit.ts < TTL_MS) return cors(200, hit.body);
    const startSec = Math.floor(start.getTime() / 1000), endSec = Math.floor(end.getTime() / 1000);
    const [apptJobs, soldJobs] = await Promise.all([
      fetchApptJobs(JN_KEY, startSec, endSec),
      fetchSoldJobs(JN_KEY, startSec, endSec),
    ]);
    const zoneOf = await fetchZoneResolver();

    const byZone = {}; // zone -> { rep -> accumulator }
    const recFor = (j) => {
      let name = (j.sales_rep_name || "").trim();
      let e = zoneOf(j.sales_rep, j.sales_rep_name);
      let fromAssigned = false;
      if (!name) {
        // No Sales Rep set — fall back to the Assigned (owners) field so the deal
        // lands under the right rep/zone instead of Unassigned; flag for fixing.
        const ownerId = j.owners && j.owners[0] && j.owners[0].id;
        const oe = ownerId ? zoneOf(ownerId, "") : null;
        if (oe) { e = oe; name = oe.name || ""; fromAssigned = true; }
      }
      j.__repFromAssigned = fromAssigned;
      const zone = (e && e.zone) || "Unassigned";
      const rep = name || "(no rep)";
      const reps = (byZone[zone] = byZone[zone] || {});
      const r = (reps[rep] = reps[rep] || newRep(rep));
      r.level = levelLabel(e && e.level);
      return r;
    };
    // A SOLD deal = 1 appointment + 1 sale (counted in its Sold-Date week — its
    // own appt task is unreliable/post-sale). UNSOLD jobs count as appointments
    // by their appt-task date (skip any in the sold set to avoid double-count).
    const soldIds = new Set(soldJobs.map((j) => j.jnid || j.id));
    for (const j of soldJobs) { const r = recFor(j); tallyAppt(r, j); tallySold(r, j); }
    for (const j of apptJobs) { if (soldIds.has(j.jnid || j.id)) continue; tallyAppt(recFor(j), j); }

    const zones = Object.entries(byZone).map(([zone, repsMap]) => {
      const reps = Object.values(repsMap).map(shapeRep).sort((a, b) => b.sales - a.sales || b.appts - a.appts || a.rep.localeCompare(b.rep));
      return { zone, totals: sumTotals(Object.values(repsMap)), reps };
    }).sort((a, b) => {
      const ia = ZONE_ORDER.indexOf(a.zone), ib = ZONE_ORDER.indexOf(b.zone);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.zone.localeCompare(b.zone);
    });

    const allReps = zones.flatMap((z) => Object.values(byZone[z.zone]));
    const body = JSON.stringify({ ok: true, period, range: { start: start.toISOString(), end: end.toISOString() }, totals: sumTotals(allReps), zones });
    CACHE.set(cacheKey, { ts: Date.now(), body });
    return cors(200, body);
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "Unknown error" }));
  }
};

async function fetchZoneResolver() {
  let reps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) reps = (await res.json()).reps || []; }
  catch (e) { console.warn("rep-zones fetch failed:", e.message || e); }
  const byJnId = {}, byName = {};
  for (const r of reps) { const e = { zone: r.zone, level: r.rep_level, name: r.name }; if (r.jobnimbus_id) byJnId[r.jobnimbus_id] = e; if (r.name) byName[normalizeName(r.name)] = e; }
  return (jnId, name) => (jnId && byJnId[jnId]) || byName[normalizeName(name)] || null;
}
function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

// ── Period window (America/New_York) ──
const TZ = "America/New_York";
function tzParts(date) { const dtf = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); const p = {}; for (const part of dtf.formatToParts(date)) p[part.type] = part.value; return p; }
function offsetMs(date) { const p = tzParts(date); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime(); }
function etWallToUTC(y, mo, d, h, mi, s) { const guess = Date.UTC(y, mo - 1, d, h, mi, s); return new Date(guess - offsetMs(new Date(guess))); }
function monthRange(now = new Date()) { const p = tzParts(now); return { start: etWallToUTC(+p.year, +p.month, 1, 0, 0, 0), end: now }; }
function weekRange(now = new Date()) {
  const p = tzParts(now); const DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }; const dow = DOW[p.weekday] ?? 0;
  const base = new Date(Date.UTC(+p.year, +p.month - 1, +p.day)); base.setUTCDate(base.getUTCDate() - dow);
  const start = etWallToUTC(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 0, 0, 0);
  const endBase = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate())); endBase.setUTCDate(endBase.getUTCDate() + 6);
  const end = etWallToUTC(endBase.getUTCFullYear(), endBase.getUTCMonth() + 1, endBase.getUTCDate(), 23, 59, 59);
  return { start, end };
}
function lastWeekRange(now = new Date()) { const { start, end } = weekRange(now); return { start: new Date(start.getTime() - 7 * 864e5), end: new Date(end.getTime() - 7 * 864e5) }; }
function pickWindow(qp) {
  if (qp.start && qp.end) { const s = new Date(qp.start), e = new Date(qp.end); if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())) return { start: s, end: e, period: "custom" }; }
  const period = qp.period === "month" ? "month" : qp.period === "lastweek" ? "lastweek" : "week";
  const { start, end } = period === "month" ? monthRange() : period === "lastweek" ? lastWeekRange() : weekRange();
  return { start, end, period };
}

function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
