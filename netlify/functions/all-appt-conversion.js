// netlify/functions/all-appt-conversion.js
//
// Company-wide "Appointments → Sales" conversion — the all-zones version of
// zone-appt-conversion.js, for the Regional Managers admin hub. Grouped
// zone → rep, with per-zone and company totals.
//
//   • Appointments = JN jobs whose APPOINTMENT date (date_start) is in the
//     period (every scheduled appointment, any status).
//   • Sales        = those now in a sold status. Sales % = sales ÷ appts.
//   • RB / Insulation = how many of the rep's SALES included each (+ attach %).
//
// Period: ?period=week|lastweek|month OR ?start=ISO&end=ISO (default this week).
//
// GET /.netlify/functions/all-appt-conversion[?period=month]
// → { ok, period, range, totals, zones:[{ zone, totals, reps:[...] }] }
//
// Env: JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const ZONE_ORDER = ["Zone 1", "Zone 2", "Zone 3", "Zone 4", "Unassigned"];

const SOLD_STATUSES = new Set([
  "sit sold", "signed contract", "production review", "job prep",
  "in funding", "waiting on pace", "upcoming installs", "install set",
  "roof started", "new roof", "paid closed", "upcoming commissions",
]);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "GET") return cors(405, JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing JOBNIMBUS_API_KEY" }));

  try {
    const { start, end, period } = pickWindow(event.queryStringParameters || {});
    const jobs = await fetchApptJobs(Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000));
    const zoneOf = await fetchZoneResolver();

    const byZone = {}; // zone -> { rep -> {appts,sales,rb,ins} }
    for (const j of jobs) {
      const zone = zoneOf(j.sales_rep, j.sales_rep_name) || "Unassigned";
      const rep = (j.sales_rep_name || "").trim() || "(no rep)";
      const reps = (byZone[zone] = byZone[zone] || {});
      const r = (reps[rep] = reps[rep] || { rep, appts: 0, sales: 0, rb: 0, ins: 0 });
      r.appts++;
      const status = String(j.status_name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (SOLD_STATUSES.has(status)) {
        r.sales++;
        const F = fieldMap(j);
        if (isYes(F["Radiant Barrier"])) r.rb++;
        if (isYes(F["Insulation"])) r.ins++;
      }
    }

    const zones = Object.entries(byZone).map(([zone, repsMap]) => {
      const reps = Object.values(repsMap).map(shapeRep)
        .sort((a, b) => b.sales - a.sales || b.appts - a.appts || a.rep.localeCompare(b.rep));
      return { zone, totals: sumTotals(reps), reps };
    }).sort((a, b) => {
      const ia = ZONE_ORDER.indexOf(a.zone), ib = ZONE_ORDER.indexOf(b.zone);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.zone.localeCompare(b.zone);
    });

    const totals = sumTotals(zones.flatMap((z) => z.reps));
    return cors(200, JSON.stringify({ ok: true, period, range: { start: start.toISOString(), end: end.toISOString() }, totals, zones }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "Unknown error" }));
  }
};

function shapeRep(r) {
  return { rep: r.rep, appts: r.appts, sales: r.sales, pct: pct(r.sales, r.appts), rb: r.rb, rb_pct: pct(r.rb, r.sales), ins: r.ins, ins_pct: pct(r.ins, r.sales) };
}
function sumTotals(reps) {
  const t = reps.reduce((s, r) => ({ appts: s.appts + r.appts, sales: s.sales + r.sales, rb: s.rb + r.rb, ins: s.ins + r.ins }), { appts: 0, sales: 0, rb: 0, ins: 0 });
  return { ...t, pct: pct(t.sales, t.appts), rb_pct: pct(t.rb, t.sales), ins_pct: pct(t.ins, t.sales) };
}
function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : 0; }
function isYes(v) { return v === true || v === "true" || v === "Yes" || v === "yes" || v === 1; }
function fieldMap(job) {
  const m = {};
  for (const [k, v] of Object.entries(job)) { m[k.trim()] = v; const bare = k.trim().replace(/^\*|\*$/g, "").trim(); if (!(bare in m)) m[bare] = v; }
  return m;
}

async function fetchApptJobs(startSec, endSec) {
  const byId = new Map();
  const filter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_start: { gte: startSec, lte: endSec } } }] }));
  for (let page = 0; page < 25; page++) {
    const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&filter=${filter}`, { headers: jnHeaders });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const rows = d.results || d.jobs || [];
    for (const j of rows) byId.set(j.jnid || j.id, j);
    if (rows.length < 100) break;
  }
  return [...byId.values()];
}

async function fetchZoneResolver() {
  let reps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) reps = (await res.json()).reps || []; }
  catch (e) { console.warn("rep-zones fetch failed:", e.message || e); }
  const byJnId = {}, byName = {};
  for (const r of reps) { if (r.jobnimbus_id) byJnId[r.jobnimbus_id] = r.zone; if (r.name) byName[normalizeName(r.name)] = r.zone; }
  return (jnId, name) => (jnId && byJnId[jnId]) || byName[normalizeName(name)] || null;
}
function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

// ── Period window (America/New_York) — mirrors zone-appt-conversion.js ──
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
