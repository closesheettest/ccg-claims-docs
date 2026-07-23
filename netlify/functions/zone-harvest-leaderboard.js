// Public, read-only HARVEST leaderboard — the third team-standings strip
// (alongside zone-leaderboard = inspections signed, zone-sales-leaderboard =
// sales sold). Counts TWO sources of harvested appointments:
//   1. MAP bookings — a rep books (or reschedules) an appointment off a pin;
//      harvest-book-appt.js / harvest-book-btr-appt.js log a canvass_activity
//      row { to_status:'appt' } with a harvest origin (iq/fb/ai/no-sit/self_gen).
//   2. JOBNIMBUS bookings (reverse direction, per Neal) — an appointment TASK
//      created in the window whose job carries "Sales Rep Harvested" = Yes,
//      credited to the job's sales rep. Deduped against map bookings by
//      jn_job_id; one credit per job.
// Tallied per period, ranked by zone with a per-rep drill-down.
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
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";

// JN-side harvested appointments (see below): the appointment TASK types that
// mean "an appointment got made", and the job flag that marks it harvest work.
const APPT_TASK_TYPES = new Set(["Initial Appointment", "Reset Appointment", "Appointment"]);
const isYes = (v) => v === true || v === "true" || v === "Yes" || v === "yes" || v === 1;
function fieldByLabel(job, label) {
  if (label in job) return job[label];
  for (const [k, v] of Object.entries(job)) if (k.trim().replace(/^\*|\*$/g, "").trim() === label) return v;
  return undefined;
}

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

    // HARVEST = an inbound lead (IQ / Facebook / AI), a No-sit reschedule pin, or a
    // rep's own SELF-GENERATED door (self_gen) turned into an appointment. NOT a
    // retail/BTR appt booked off an existing inspection pin (from_status=insp) —
    // that's post-inspection, excluded. Filter by the pin's ORIGIN (from_status).
    // We don't filter on `kind`: a booking logs both a server row (kind=status) and
    // a client row (kind=visit), so we dedupe by pin_id below to count each house once.
    const acts = await sbGet(
      `canvass_activity?to_status=eq.appt&from_status=in.(iq,fb,ai,no_sit_reschedule,self_gen)` +
      `&created_at=gte.${encodeURIComponent(start.toISOString())}&created_at=lte.${encodeURIComponent(end.toISOString())}` +
      `&select=rep_name,pin_id,from_status,created_at&order=created_at.asc&limit=20000`
    );
    const zoneOf = await fetchZoneResolver();

    // zone → { count, byRep:{ name → count } }. Dedupe by pin so the server+client
    // rows for one booking (and a same-period re-book of the same house) count once.
    const agg = {};
    let unattributed = 0;
    const seenPins = new Set();
    for (const a of acts) {
      if (a.pin_id) { if (seenPins.has(a.pin_id)) continue; seenPins.add(a.pin_id); }
      const zone = zoneOf(a.rep_name);
      if (!zone) { unattributed++; continue; }
      const z = agg[zone] || (agg[zone] = { count: 0, byRep: {} });
      z.count += 1;
      const rep = (a.rep_name || "—").trim() || "—";
      z.byRep[rep] = (z.byRep[rep] || 0) + 1;
    }

    // ── JN-SIDE HARVESTED APPOINTMENTS (reverse direction, per Neal) ─────────
    // Appointments made directly IN JobNimbus count too, when the job's
    // "Sales Rep Harvested" field = Yes — credited to the job's sales rep. Same
    // philosophy as the pin reverse-sync: work done in JN still lands on the
    // board. Booking time = the appt TASK's created date in the window (matches
    // how map bookings count). Deduped against map bookings via the booked
    // pins' jn_job_id, and one credit per JOB. Best-effort: a JN hiccup never
    // breaks the board.
    let jnCounted = 0;
    const payloadDebugJobs = [];
    try {
      if (JN_KEY) {
        // Jobs already credited from a map booking → skip on the JN side.
        const mapJobIds = new Set();
        const pinIds = [...seenPins];
        for (let i = 0; i < pinIds.length; i += 100) {
          const rows = await sbGet(`canvass_prospects?id=in.(${pinIds.slice(i, i + 100).join(",")})&jn_job_id=not.is.null&select=jn_job_id`);
          for (const p of rows) if (p.jn_job_id) mapJobIds.add(p.jn_job_id);
        }
        // Appointment tasks CREATED in the window → the jobs they hang on.
        const startSec = Math.floor(start.getTime() / 1000), endSec = Math.floor(end.getTime() / 1000);
        const taskFilter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_created: { gte: startSec, lte: endSec } } }] }));
        const taskJobs = new Set();
        for (let page = 0; page < 30; page++) {
          const r = await fetch(`${JN_BASE}/tasks?size=100&from=${page * 100}&filter=${taskFilter}`, { headers: jnHeaders });
          if (!r.ok) break;
          const d = await r.json().catch(() => ({}));
          const rows = d.results || d.tasks || [];
          for (const t of rows) {
            if (!APPT_TASK_TYPES.has(t.record_type_name)) continue;
            for (const rel of (t.related || [])) if (rel.type === "job" && rel.id && !mapJobIds.has(rel.id)) taskJobs.add(rel.id);
          }
          if (rows.length < 100) break;
        }
        if (taskJobs.size) {
          // Job details: one recently-updated sweep (making an appt touches the
          // job), individual fetch as a small fallback.
          const byId = new Map();
          const sinceSec = startSec - 7 * 86400;
          for (let page = 0; page < 15; page++) {
            const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${sinceSec}`, { headers: jnHeaders });
            if (!r.ok) break;
            const d = await r.json().catch(() => ({}));
            const rows = d.results || d.jobs || [];
            for (const j of rows) byId.set(j.jnid || j.id, j);
            if (rows.length < 100) break;
          }
          let individual = 0;
          for (const id of taskJobs) {
            let job = byId.get(id);
            if (!job && individual < 25) {
              individual++;
              try { const r = await fetch(`${JN_BASE}/jobs/${id}`, { headers: jnHeaders }); if (r.ok) job = await r.json().catch(() => null); } catch { /* skip */ }
            }
            if (!job) continue;
            if (!isYes(fieldByLabel(job, "Sales Rep Harvested"))) continue;   // office didn't flag it harvested
            // debug=2 — surface HOW the flag is keyed on real flagged jobs (label vs
            // cf_*), so writers (setter-book-appointment auto-flag) use the right key.
            if (qp.debug === "2") {
              payloadDebugJobs.push({ name: job.name, keys: Object.entries(job).filter(([k, v]) => /arvest/i.test(k) || (typeof v === "string" && v === "Yes")).map(([k, v]) => `${k}=${v}`) });
            }
            const rep = (job.sales_rep_name || "").trim();
            const zone = zoneOf(rep);
            if (!zone) { unattributed++; continue; }
            const z = agg[zone] || (agg[zone] = { count: 0, byRep: {} });
            z.count += 1;
            z.byRep[rep || "—"] = (z.byRep[rep || "—"] || 0) + 1;
            jnCounted += 1;
          }
        }
      }
    } catch { /* board still renders from map bookings alone */ }

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
    if (qp.debug === "1" || qp.debug === "2") { payload.scanned = acts.length; payload.unattributed = unattributed; payload.jn_harvested = jnCounted; }
    if (qp.debug === "2") payload.harvested_jobs = payloadDebugJobs;
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
