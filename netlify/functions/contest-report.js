// Contest AUDIT report — the checks-and-balance behind zone-contest-leaderboard.
// Same scan + scoring, but instead of just team averages it exposes every rep's
// per-DAY, per-ATTRIBUTE COUNTS (how many, not points) so you can see exactly where
// the points come from and confirm the board is recording correctly.
//
//   GET /.netlify/functions/contest-report[?days=N][?week=1..4]
//     • default          → the active contest week (Wed+Thu)
//     • ?days=7          → trailing N days (real data before the contest starts)
//     • ?week=2          → a specific contest week
//   → { ok, window:{label,range,startDay,endDay,start,end,tz}, weeks:[{no,label,range,started}],
//       attributes:[{key,label}],
//       teams:[{ zone, team, points, avg, activeReps,
//                reps:[{ name, points, sales, totals:{booked,went,signed,goback,review},
//                        days:[{ day, counts:{…}, sold, attrCount, dayPoints }] }] }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";
// Reps excluded from the CONTEST only (kept in sync with zone-contest-leaderboard).
// Dropped from the roster so they don't count for or against their team.
const CONTEST_EXCLUDE = new Set(["vic sandre", "zach smith"]);

const WEEKS = [
  { label: "Week 1", start: "2026-08-12", end: "2026-08-13" },
  { label: "Week 2", start: "2026-08-19", end: "2026-08-20" },
  { label: "Week 3", start: "2026-08-26", end: "2026-08-27" },
  { label: "Week 4", start: "2026-09-02", end: "2026-09-03" },
];
const RAMP = { freeCount: 2, freePts: 1, thenPts: 2 };
const SALE_POINTS = 6;
const ATTRIBUTES = [
  { key: "booked", label: "Appt booked" },
  { key: "went", label: "Appt ran" },
  { key: "signed", label: "Insp signed" },
  { key: "goback", label: "Go-back" },
  { key: "review", label: "Review sent" },
];
const ZONE_TEAMS = { "Zone 1": "SQUAD", "Zone 2": "SitSold", "Zone 3": "SHARKS", "Zone 4": "HURRICANE" };
const ZONE_ORDER = ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];
const SOLD_STATUS_NAMES = ["Sit - Sold", "Signed Contract", "Production Review", "Job Prep", "In Funding", "Waiting on PACE", "Upcoming Installs", "Install Set", "Roof Started", "New Roof", "Paid & Closed", "Upcoming Commissions", "Holds", "Extras"];
const SOLD_STATUSES = new Set(["sit sold", "signed contract", "production review", "job prep", "in funding", "waiting on pace", "upcoming installs", "install set", "roof started", "new roof", "install complete collect payment", "paid closed", "upcoming commissions", "commission", "holds", "extras"]);

function scoreDay(n) { let p = 0; for (let i = 1; i <= n; i++) p += i <= RAMP.freeCount ? RAMP.freePts : RAMP.thenPts; return p; }

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "GET") return cors(405, JSON.stringify({ ok: false, error: "GET only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));
  const qp = event.queryStringParameters || {};

  try {
    // A closed week is FINAL. Points never move (they're timestamped activity) but
    // the divisor used to: active reps was read live from the TMS roster on every
    // request, so deactivating a rep re-scored finished weeks and even flipped a
    // winner. Serve the snapshot instead. ?fresh=1 recomputes (that's how the
    // freeze itself is taken).
    if (qp.week && !qp.fresh && !qp.days) {
      const frozen = await sbGet(`contest_week_results?week_no=eq.${encodeURIComponent(Number(qp.week))}&select=payload,reps_note,frozen_at&limit=1`);
      if (frozen && frozen[0] && frozen[0].payload) {
        return cors(200, JSON.stringify({
          ...frozen[0].payload,
          frozen: true, frozen_at: frozen[0].frozen_at, reps_note: frozen[0].reps_note || undefined,
        }));
      }
    }

    // Pick the window.
    const now = new Date();
    // ?reps=Zone 1:8,Zone 2:10,... overrides the active-rep DIVISOR. Needed only
    // to freeze a week that closed before the freeze table existed, where the
    // roster at the time is no longer readable from TMS. Recorded as reps_note on
    // the frozen row so an overridden divisor is never silently passed off as the
    // live one.
    const repsOverride = {};
    for (const part of String(qp.reps || "").split(",")) {
      const m = part.match(/^\s*(Zone\s*\d)\s*:\s*(\d+)\s*$/i);
      if (m) repsOverride[m[1].replace(/\s+/, " ")] = Number(m[2]);
    }

    let start, end, label, range = null;
    if (qp.days && Number(qp.days) > 0) {
      end = now; start = new Date(now.getTime() - Number(qp.days) * 86400000); label = `Last ${Number(qp.days)} days`;
      range = `${etDayKey(start.toISOString())} \u2192 today`;
    } else if (qp.week && WEEKS[Number(qp.week) - 1]) {
      const w = WEEKS[Number(qp.week) - 1]; start = etDayStart(w.start); end = etDayEnd(w.end); label = w.label;
      range = etRangeLabel(w.start, w.end);
    } else {
      // Active week = latest whose Wed has started; if none started, trailing 7 days.
      const wb = WEEKS.map((w) => ({ ...w, s: etDayStart(w.start), e: etDayEnd(w.end) }));
      let active = null;
      for (const w of wb) if (w.s <= now && (!active || w.s > active.s)) active = w;
      if (active) { start = active.s; end = active.e; label = active.label; range = etRangeLabel(active.start, active.end); }
      else { end = now; start = new Date(now.getTime() - 7 * 86400000); label = "Last 7 days"; range = `${etDayKey(start.toISOString())} \u2192 today`; }
    }

    const rows = await sbGetAll(
      `canvass_activity?select=rep_name,kind,to_status,pin_id,note,created_at` +
      `&created_at=gte.${encodeURIComponent(start.toISOString())}&created_at=lte.${encodeURIComponent(end.toISOString())}&order=created_at.asc`
    );

    // Per rep → per day → per attribute → Set of distinct keys (dedup matches the board).
    const byRep = new Map(); // norm → Map(day → {booked:Set, went:Set, signed:Set, goback:Set, review:Set})
    for (const r of rows) {
      const rep = (r.rep_name || "").trim(); if (!rep) continue;
      const nk = normalizeName(rep), day = etDayKey(r.created_at);
      const s = r.to_status, k = r.kind, pin = r.pin_id;
      let attr = null, key = null;
      if (s === "appt") { attr = "booked"; key = `${pin || r.created_at}`; }
      else if (k === "appt_done") { attr = "went"; key = r.created_at; }
      else if (s === "insp_sold") { attr = "signed"; key = `${pin || r.created_at}`; }
      else if (k === "goback") { attr = "goback"; key = r.note || r.created_at; }
      // Reviews now come from review_verifications (manager-verified) — folded in below.
      if (!attr) continue;
      let days = byRep.get(nk); if (!days) byRep.set(nk, (days = new Map()));
      let d = days.get(day); if (!d) days.set(day, (d = { booked: new Set(), went: new Set(), signed: new Set(), goback: new Set(), review: new Set() }));
      d[attr].add(key);
    }

    // Google reviews — manager-verified (same rule as the leaderboard). NO point until a
    // manager CONFIRMS it: pending reviews score nothing. A review counts once APPROVED
    // and confirmed the SAME DAY it was sent. One-time 08-12 → 08-13 transition grace.
    // Folded into the per-rep/day "review" attribute so the column + points match the board.
    try {
      const revRows = await sbGetAll(
        `review_verifications?select=rep_name,status,sent_at,verified_at,id&status=eq.approved` +
        `&sent_at=gte.${encodeURIComponent(start.toISOString())}&sent_at=lte.${encodeURIComponent(end.toISOString())}`
      );
      const GRACE_DAY = "2026-08-13", GRACE_SENT = "2026-08-12";
      for (const rv of revRows) {
        const rep = (rv.rep_name || "").trim(); if (!rep) continue;
        const sentDay = etDayKey(rv.sent_at);
        const apprDay = rv.verified_at ? etDayKey(rv.verified_at) : null;
        const counts = apprDay === sentDay || (sentDay === GRACE_SENT && apprDay === GRACE_DAY);
        if (!counts) continue;
        const nk = normalizeName(rep);
        let days = byRep.get(nk); if (!days) byRep.set(nk, (days = new Map()));
        let d = days.get(sentDay); if (!d) days.set(sentDay, (d = { booked: new Set(), went: new Set(), signed: new Set(), goback: new Set(), review: new Set() }));
        d.review.add(rv.id);
      }
    } catch { /* reviews best-effort */ }

    // Sales per rep per day (Sold Date in window), best-effort.
    const salesByRepDay = new Map(); // norm → Map(day → count)
    try {
      if (JN_KEY) {
        const sold = await fetchSoldJobs(Math.floor(start.getTime() / 1000) - 2 * 86400);
        for (const j of sold) {
          const st = String(j.status_name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          if (!SOLD_STATUSES.has(st)) continue;
          const ms = soldDateMs(j);
          if (ms == null || ms < start.getTime() || ms > end.getTime()) continue;
          const nk = normalizeName(j.sales_rep_name || ""); if (!nk) continue;
          const day = etDayKey(new Date(ms).toISOString());
          let m = salesByRepDay.get(nk); if (!m) salesByRepDay.set(nk, (m = new Map()));
          m.set(day, (m.get(day) || 0) + 1);
        }
      }
    } catch { /* best-effort */ }

    const { rosterByZone } = await fetchZoneResolver();
    const teams = ZONE_ORDER.map((zone) => {
      const roster = rosterByZone[zone] || [];
      if (!roster.length) return null;
      const reps = roster.map((m) => {
        const days = byRep.get(m.norm) || new Map();
        const salesDays = salesByRepDay.get(m.norm) || new Map();
        const allDayKeys = new Set([...days.keys(), ...salesDays.keys()]);
        const totals = { booked: 0, went: 0, signed: 0, goback: 0, review: 0 };
        const dayList = [];
        let points = 0, sales = 0;
        for (const day of [...allDayKeys].sort()) {
          const d = days.get(day);
          const counts = { booked: d ? d.booked.size : 0, went: d ? d.went.size : 0, signed: d ? d.signed.size : 0, goback: d ? d.goback.size : 0, review: d ? d.review.size : 0 };
          for (const a of ["booked", "went", "signed", "goback", "review"]) totals[a] += counts[a];
          const attrCount = counts.booked + counts.went + counts.signed + counts.goback + counts.review;
          const sold = salesDays.get(day) || 0;
          // Ramp runs PER attribute type (1st & 2nd of a type = 1 pt, 3rd+ = 2 pts).
          const dayPoints = scoreDay(counts.booked) + scoreDay(counts.went) + scoreDay(counts.signed)
            + scoreDay(counts.goback) + scoreDay(counts.review) + sold * SALE_POINTS;
          points += dayPoints; sales += sold;
          dayList.push({ day, counts, sold, attrCount, dayPoints });
        }
        return { name: m.name, points, sales, totals, days: dayList, isManager: !!m.isManager };
      }).sort((a, b) => b.points - a.points);
      const points = reps.reduce((s, r) => s + r.points, 0);
      const activeReps = repsOverride[zone] != null ? repsOverride[zone] : roster.length;
      return { zone, team: ZONE_TEAMS[zone] || zone, points, avg: Math.round((points / activeReps) * 10) / 10, activeReps, reps };
    }).filter(Boolean).sort((a, b) => b.avg - a.avg);

    return cors(200, JSON.stringify({
      ok: true,
      window: {
        label, range,
        // ET calendar days — what "Wed + Thu" actually means. start/end stay as
        // the exact UTC instants used for the scan.
        startDay: etDayKey(start.toISOString()), endDay: etDayKey(end.toISOString()),
        start: start.toISOString(), end: end.toISOString(),
        tz: "America/New_York",
      },
      weeks: WEEKS.map((w, i) => ({ no: i + 1, label: w.label, range: etRangeLabel(w.start, w.end), started: etDayStart(w.start) <= now })),
      attributes: ATTRIBUTES, teams,
      repsOverridden: Object.keys(repsOverride).length ? repsOverride : undefined,
    }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// Single-page read. Used for the frozen-week lookup, which is one row and must
// not fail the whole request if the table hasn't been created yet.
async function sbGet(path) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}

async function sbGetAll(path) {
  const out = [];
  for (let from = 0; from < 200000; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { ...sb, "Range-Unit": "items", Range: `${from}-${from + 999}` } });
    if (!r.ok) break;
    const rows = await r.json().catch(() => []);
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function fetchSoldJobs(since) {
  const byId = new Map();
  for (const name of SOLD_STATUS_NAMES) {
    const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: name } }] }));
    for (let page = 0; page < 20; page++) {
      const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${since}&filter=${filter}`,
        { headers: { Authorization: `Bearer ${JN_KEY}`, "Content-Type": "application/json" } });
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const list = d.results || d.jobs || [];
      for (const j of list) byId.set(j.jnid || j.id, j);
      if (list.length < 100) break;
    }
  }
  return [...byId.values()];
}
function soldDateMs(job) { const v = job["Sold Date"] != null ? job["Sold Date"] : job.cf_date_5; const n = Number(v); return Number.isFinite(n) && n > 0 ? n * 1000 : null; }
async function fetchZoneResolver() {
  let reps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) reps = (await res.json()).reps || []; } catch { /* best-effort */ }
  const rosterByZone = {}; const seen = new Set();
  for (const r of reps) {
    // Still in FIELD TRAINING → not in the contest, for or against the team.
    // They haven't graduated, so they shouldn't lift a team's average or drag it
    // down as a non-scoring head in the divisor. Checked on the raw flag rather
    // than `pregrad`, because a record can carry is_field_trainee AND
    // is_active_sales_rep at once and then reads as an ordinary rep — which is
    // how Danny Pasicolan ended up scoring for SQUAD (Neal, 2026-08-18).
    if (!r.name || !r.zone || r.active === false || r.in_training === true || r.pregrad === true) continue;
    const norm = normalizeName(r.name);
    if (CONTEST_EXCLUDE.has(norm)) continue; // excluded from the contest — not in the divisor
    if (seen.has(norm)) continue; seen.add(norm);
    // managed_region set = this person is the zone's MANAGER. Their points count
    // toward the team average, but they're NOT eligible for the prize split.
    (rosterByZone[r.zone] || (rosterByZone[r.zone] = [])).push({ name: String(r.name).trim(), norm, isManager: !!r.managed_region });
  }
  return { rosterByZone };
}
function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
const TZ = "America/New_York";
function tzParts(date) { const dtf = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); const p = {}; for (const part of dtf.formatToParts(date)) p[part.type] = part.value; return p; }
function offsetMs(date) { const p = tzParts(date); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime(); }
function etWallToUTC(y, mo, d, h, mi, s) { const guess = Date.UTC(y, mo - 1, d, h, mi, s); return new Date(guess - offsetMs(new Date(guess))); }
function etDayStart(dateStr) { const [y, m, d] = dateStr.split("-").map(Number); return etWallToUTC(y, m, d, 0, 0, 0); }
function etDayEnd(dateStr) { const [y, m, d] = dateStr.split("-").map(Number); return etWallToUTC(y, m, d, 23, 59, 59); }
function etDayKey(iso) { const p = tzParts(new Date(iso)); return `${p.year}-${p.month}-${p.day}`; }
// "Aug 12–13" from two ET dates. The window's start/end are UTC instants, so a
// Wed–Thu ET week reports an end of "…-14T03:59:59Z" — correct to the second
// (11:59:59 PM Thursday ET) but it READS like a third day. Everything the report
// shows is ET, so it says ET (Neal, 2026-08-18).
function etRangeLabel(startIso, endIso) {
  const f = (iso, withMonth) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US",
    withMonth ? { month: "short", day: "numeric", timeZone: "UTC" } : { day: "numeric", timeZone: "UTC" });
  if (startIso === endIso) return f(startIso, true);
  const sameMonth = startIso.slice(0, 7) === endIso.slice(0, 7);
  return `${f(startIso, true)}\u2013${f(endIso, !sameMonth)}`;
}

function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
