// Public, read-only HARVEST leaderboard — the third team-standings strip
// (alongside zone-leaderboard = inspections signed, zone-sales-leaderboard =
// sales sold). This one counts APPOINTMENTS BOOKED FROM THE HARVESTING MAP:
// every time a rep books (or reschedules) an appointment off a pin, both
// harvest-book-appt.js and harvest-book-btr-appt.js log a canvass_activity
// row { kind:'status', to_status:'appt' }. We tally those in the period,
// ranked by zone with a per-rep drill-down.
//
//   GET /.netlify/functions/zone-harvest-leaderboard[?period=week|month|...]
//   → { ok, period, range:{start,end}, week:{start,end}, total,
//       zones:[{ zone, team, count, rank, reps:[{ name, count }] }] }
//
// Zone resolution: harvest activity carries only rep_name, so we map name →
// zone through the TMS rep-zones feed (same normalization as the siblings).
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";

const ZONE_TEAMS = { "Zone 1": "SQUAD", "Zone 2": "SitSold", "Zone 3": "SHARKS", "Zone 4": "HURRICANE" };
const ZONE_ORDER = ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "GET") return cors(405, JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Server misconfigured (missing Supabase env)" }));

  try {
    const qp = event.queryStringParameters || {};
    let start, end, period;
    if (qp.start && qp.end) {
      const s = new Date(qp.start), e = new Date(qp.end);
      if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())) { start = s; end = e; period = "custom"; }
    }
    if (!start) {
      period = qp.period === "month" ? "month" : qp.period === "lastmonth" ? "lastmonth" : qp.period === "lastweek" ? "lastweek" : qp.period === "last30" ? "last30" : "week";
      ({ start, end } = period === "month" ? monthRange() : period === "lastmonth" ? lastMonthRange() : period === "lastweek" ? lastWeekRange() : period === "last30" ? last30Range() : weekRange());
    }

    // Appointment bookings from the harvest map in the window.
    const acts = await sbGet(
      `canvass_activity?kind=eq.status&to_status=eq.appt` +
      `&created_at=gte.${encodeURIComponent(start.toISOString())}&created_at=lte.${encodeURIComponent(end.toISOString())}` +
      `&select=rep_name,created_at&limit=20000`
    );
    const zoneOf = await fetchZoneResolver();

    // zone → { count, byRep:{ name → count } }
    const agg = {};
    let unattributed = 0;
    for (const a of acts) {
      const zone = zoneOf(a.rep_name);
      if (!zone) { unattributed++; continue; }
      const z = agg[zone] || (agg[zone] = { count: 0, byRep: {} });
      z.count += 1;
      const rep = (a.rep_name || "—").trim() || "—";
      z.byRep[rep] = (z.byRep[rep] || 0) + 1;
    }

    const zones = ZONE_ORDER.map((zone) => {
      const z = agg[zone] || { count: 0, byRep: {} };
      const reps = Object.entries(z.byRep).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
      return { zone, team: ZONE_TEAMS[zone] || zone, count: z.count, reps };
    });
    zones.sort((a, b) => b.count - a.count);
    zones.forEach((z, i) => { z.rank = i + 1; });

    const total = zones.reduce((s, z) => s + z.count, 0);
    const payload = {
      ok: true, period,
      range: { start: start.toISOString(), end: end.toISOString() },
      week: { start: start.toISOString(), end: end.toISOString() }, // back-compat
      total, zones,
    };
    if (qp.debug === "1") { payload.scanned = acts.length; payload.unattributed = unattributed; }
    return cors(200, JSON.stringify(payload));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "Unknown error" }));
  }
};

async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }

// Zone resolver — TMS rep-zones keyed by normalized name (harvest activity has
// only the name). Same normalization as zone-sales-leaderboard.js.
async function fetchZoneResolver() {
  let reps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) reps = (await res.json()).reps || []; } catch { /* best-effort */ }
  const byName = {};
  for (const r of reps) if (r.name) byName[normalizeName(r.name)] = r.zone;
  return (name) => byName[normalizeName(name)] || null;
}
function normalizeName(s) {
  return String(s || "").toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

// ── ET windows (copied from zone-sales-leaderboard.js so all three bars share one week) ──
const TZ = "America/New_York";
function tzParts(date) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = {}; for (const part of dtf.formatToParts(date)) p[part.type] = part.value; return p;
}
function offsetMs(date) { const p = tzParts(date); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime(); }
function etWallToUTC(y, mo, d, h, mi, s) { const guess = Date.UTC(y, mo - 1, d, h, mi, s); return new Date(guess - offsetMs(new Date(guess))); }
function monthRange(now = new Date()) { const p = tzParts(now); return { start: etWallToUTC(+p.year, +p.month, 1, 0, 0, 0), end: now }; }
function weekRange(now = new Date()) {
  const p = tzParts(now);
  const DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const dow = DOW[p.weekday] ?? 0;
  const base = new Date(Date.UTC(+p.year, +p.month - 1, +p.day)); base.setUTCDate(base.getUTCDate() - dow);
  const start = etWallToUTC(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 0, 0, 0);
  const endBase = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate())); endBase.setUTCDate(endBase.getUTCDate() + 6);
  const end = etWallToUTC(endBase.getUTCFullYear(), endBase.getUTCMonth() + 1, endBase.getUTCDate(), 23, 59, 59);
  return { start, end };
}
function last30Range(now = new Date()) { return { start: new Date(now.getTime() - 30 * 864e5), end: now }; }
function lastWeekRange(now = new Date()) { const { start, end } = weekRange(now); return { start: new Date(start.getTime() - 7 * 864e5), end: new Date(end.getTime() - 7 * 864e5) }; }
function lastMonthRange(now = new Date()) {
  const p = tzParts(now); let y = +p.year, m = +p.month - 1; if (m < 1) { m = 12; y -= 1; }
  const start = etWallToUTC(y, m, 1, 0, 0, 0);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: etWallToUTC(y, m, lastDay, 23, 59, 59) };
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
