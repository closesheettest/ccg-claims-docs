// Public, read-only CONTEST leaderboard — a togglable team-standings strip on the
// rep dashboard alongside zone-leaderboard (inspections), zone-sales-leaderboard,
// and zone-harvest-leaderboard. Unlike those (which count ONE thing), this runs the
// "positive-effort" contest and ranks teams by AVERAGE points per rep.
//
// THE CONTEST (rules the field managers approved — see Sales-Contest-Ruleset):
//   • POSITIVE ATTRIBUTES, each worth points on a daily ramp (all via the map):
//       - book an appointment            (to_status "appt")
//       - go to an appointment           (kind "appt_done")
//       - get a free roof inspection SIGNED (to_status "insp_sold")
//       - CONVERT a go-back              (kind "goback" — retail→appt, damage→PA appt,
//                                         no-damage→referral; a plain go-back scores nothing)
//       - a manager-VERIFIED Google review (review_verifications: approved, or still
//                                         pending but sent TODAY = a provisional point)
//     NOTHING for knocking a door / arriving at a pin.
//   • DAILY RAMP, per rep, PER ATTRIBUTE TYPE: for each type, the first 2 that day
//     are worth 1 pt each; the 3rd and every one after (of that same type) are worth
//     2 pts each. Each type ramps on its own. Resets each day.
//   • A ROOF SOLD in JobNimbus = a flat 6 pts, added ON TOP (not part of the ramp).
//     Membership = the job's "Sold Date" (cf_date_5) falls in the contest window and
//     its status is a live sold stage; attributed to the rep by name.
//   • Team score = total points ÷ the team's ACTIVE-REP ROSTER (from TMS rep-zones),
//     NOT activity — every active rep divides the team total whether or not they
//     logged anything, so dead weight drags the average down. Reps + managers both
//     count (managers lift the average but aren't prize-eligible — a payout rule).
//   • Points come only from the contest DAYS (Wed + Thu). Each week is scored on its
//     own and the board RESETS — it shows the active week only.
//
// OFF SWITCH: app_settings.contest_enabled (bool). false → { ok:true, enabled:false,
// zones:[] }, and the dashboard hides any board whose feed has no zones. Flip it true
// to go live. `?preview=1` computes anyway (a private dry-run while it's off) — and
// if the contest hasn't started yet, preview scores a TRAILING 7-day window so there's
// something real to look at. `?debug=1` adds scan diagnostics.
//
//   GET /.netlify/functions/zone-contest-leaderboard[?week=1..4][?preview=1][?debug=1]
//     • default   → the contest week in progress, else the most recent one
//     • ?week=2   → that specific contest week (same param as contest-report)
//   → { ok, enabled, contest, week, range:{start,end}, zones:[{ zone, team, count,
//       avg, points, activeReps, sales, reps:[{ name, count }] }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY (for the sale bonus)

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";

// ── THE CONTEST ───────────────────────────────────────────────────────────
const CONTEST = {
  name: "Positive-Effort Team Contest",
  // Each contest week is scored on its own (the board resets between them). A week
  // is its Wed + Thu; points are only earned on these ET days.
  weeks: [
    { label: "Week 1", start: "2026-08-12", end: "2026-08-13" }, // Wed–Thu
    { label: "Week 2", start: "2026-08-19", end: "2026-08-20" },
    { label: "Week 3", start: "2026-08-26", end: "2026-08-27" },
    { label: "Week 4", start: "2026-09-02", end: "2026-09-03" },
  ],
  // Daily ramp: the first `freeCount` attributes each day are worth `freePts`,
  // every one after is worth `thenPts`.
  ramp: { freeCount: 2, freePts: 1, thenPts: 2 },
  salePoints: 6, // flat, per roof sold in JN, on top of the ramp
};

// "Aug 12–13" from the contest week's two ET dates (same month collapses the
// second month name). Noon UTC keeps the date off a timezone boundary.
function etRangeLabel(startIso, endIso) {
  const f = (iso, withMonth) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US",
    withMonth ? { month: "short", day: "numeric", timeZone: "UTC" } : { day: "numeric", timeZone: "UTC" });
  const sameMonth = startIso.slice(0, 7) === endIso.slice(0, 7);
  return `${f(startIso, true)}\u2013${f(endIso, !sameMonth)}`;
}

const ZONE_TEAMS = { "Zone 1": "SQUAD", "Zone 2": "SitSold", "Zone 3": "SHARKS", "Zone 4": "HURRICANE" };
// Reps excluded from the CONTEST only (still active everywhere else). They don't count
// for OR against their team — dropped from the roster so they never dilute the average.
// Normalized names (see normalizeName).
const CONTEST_EXCLUDE = new Set(["vic sandre", "zach smith"]);
const ZONE_ORDER = ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];

// Sold-stage status names (exact JN spellings, to pull only sold jobs) + a normalized
// set for the authoritative membership check. Mirrors zone-sales-leaderboard.
const SOLD_STATUS_NAMES = [
  "Sit - Sold", "Signed Contract", "Production Review", "Job Prep", "In Funding",
  "Waiting on PACE", "Upcoming Installs", "Install Set", "Roof Started", "New Roof",
  "Paid & Closed", "Upcoming Commissions", "Holds", "Extras",
];
const SOLD_STATUSES = new Set([
  "sit sold", "signed contract", "production review", "job prep", "in funding",
  "waiting on pace", "upcoming installs", "install set", "roof started", "new roof",
  "install complete collect payment", "paid closed", "upcoming commissions",
  "commission", "holds", "extras",
]);

// Points for N attributes in one day (1-1-2 ramp). Order within the day doesn't
// matter to the total, so we only need the count.
function scoreDay(n) {
  const { freeCount, freePts, thenPts } = CONTEST.ramp;
  let pts = 0;
  for (let i = 1; i <= n; i++) pts += i <= freeCount ? freePts : thenPts;
  return pts;
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "GET") return cors(405, JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "Server misconfigured (missing Supabase env)" }));

  const qp = event.queryStringParameters || {};
  const preview = qp.preview === "1";
  const enabled = await getContestEnabled();
  // OFF until the toggle flips (preview overrides so we can dry-run while it's off).
  if (!enabled && !preview) return cors(200, JSON.stringify({ ok: true, enabled: false, zones: [] }));

  try {
    // Pick the ACTIVE contest week = the latest week whose Wed has already started.
    const now = new Date();
    const weeksWithBounds = CONTEST.weeks.map((w) => ({ ...w, startUTC: etDayStart(w.start), endUTC: etDayEnd(w.end) }));
    let active = null;
    for (const w of weeksWithBounds) if (w.startUTC <= now && (!active || w.startUTC > active.startUTC)) active = w;
    if (!active) active = weeksWithBounds[0];
    let contestStart = active.startUTC, contestEnd = active.endUTC, weekLabel = active.label;

    // WED + THU ONLY, always. There used to be a "preview = trailing 7 days"
    // window here so there'd be activity to look at while the contest was off.
    // That silently scored Mon/Tue/Fri work that can never earn a contest point,
    // so every number it produced was wrong — and it was wrong on the regional
    // managers' dashboards, which is reporting (Neal, 2026-08-18). `preview` now
    // means one thing only: compute even though the rep-facing toggle is off. It
    // never changes the window.
    //
    // So the board always shows a REAL contest week: the one in progress while
    // it's Wed/Thu, and the most recent completed one the rest of the time.
    // ?week=1..4 scores one specific contest week, same param the admin audit
    // report takes — so a manager can flip between the weeks instead of only
    // seeing whichever one is current.
    const wantWeek = Number(qp.week);
    if (wantWeek >= 1 && wantWeek <= weeksWithBounds.length) active = weeksWithBounds[wantWeek - 1];
    contestStart = active.startUTC; contestEnd = active.endUTC;

    const live = now >= active.startUTC && now <= active.endUTC;
    const started = now >= active.startUTC;
    weekLabel = `${active.label} · ${etRangeLabel(active.start, active.end)}`;

    // Attributes come from the map activity in the window (paged — 1000 cap).
    const rows = await sbGetAll(
      `canvass_activity?select=rep_name,kind,to_status,pin_id,round,note,created_at` +
      `&created_at=gte.${encodeURIComponent(contestStart.toISOString())}&created_at=lte.${encodeURIComponent(contestEnd.toISOString())}` +
      `&order=created_at.asc`
    );

    // Distinct attributes per rep/day, kept PER TYPE — the ramp runs separately for
    // each attribute type (1st & 2nd of a type = 1 pt, 3rd+ of that type = 2 pts).
    const attrByRepDay = new Map(); // normName → Map(dayKey → {booked:Set, went:Set, signed:Set, goback:Set, review:Set})
    for (const r of rows) {
      const rep = (r.rep_name || "").trim();
      if (!rep) continue;
      const nk = normalizeName(rep), day = etDayKey(r.created_at);
      const s = r.to_status, k = r.kind, pin = r.pin_id;
      let type = null, key = null;
      if (s === "appt") { type = "booked"; key = `${pin || r.created_at}`; }            // booked an appointment
      else if (k === "appt_done") { type = "went"; key = r.created_at; }                // went to an appointment
      else if (s === "insp_sold") { type = "signed"; key = `${pin || r.created_at}`; }  // free roof inspection signed
      else if (k === "goback") { type = "goback"; key = r.note || r.created_at; }        // did a converting go-back
      // NOTE: Google reviews are NOT scored from map activity anymore — they go
      // through manager verification (review_verifications), folded in below.
      if (!type) continue;
      let byDay = attrByRepDay.get(nk);
      if (!byDay) attrByRepDay.set(nk, (byDay = new Map()));
      let dd = byDay.get(day);
      if (!dd) byDay.set(day, (dd = { booked: new Set(), went: new Set(), signed: new Set(), goback: new Set(), review: new Set() }));
      dd[type].add(key);
    }

    // Google reviews — manager-verified. NO point until a manager CONFIRMS it: pending
    // reviews score nothing (they don't ride the board provisionally). A review counts
    // once it's APPROVED and confirmed the SAME DAY it was sent. Credited to the day it
    // was SENT. Keyed by review id → the per-type "review" ramp. Best-effort: if the
    // table isn't there yet, reviews = 0.
    //   One-time TRANSITION: manager verification went live 2026-08-13 mid-contest, so a
    //   review sent 08-12 (before it existed) confirmed on 08-13 still counts. That grace
    //   line never fires after 08-13.
    try {
      const revRows = await sbGetAll(
        `review_verifications?select=rep_name,status,sent_at,verified_at,id` +
        `&status=eq.approved` +
        `&sent_at=gte.${encodeURIComponent(contestStart.toISOString())}&sent_at=lte.${encodeURIComponent(contestEnd.toISOString())}`
      );
      const GRACE_DAY = "2026-08-13", GRACE_SENT = "2026-08-12";
      for (const rv of revRows) {
        const rep = (rv.rep_name || "").trim();
        if (!rep) continue;
        const sentDay = etDayKey(rv.sent_at);
        const apprDay = rv.verified_at ? etDayKey(rv.verified_at) : null;
        const counts = apprDay === sentDay || (sentDay === GRACE_SENT && apprDay === GRACE_DAY);
        if (!counts) continue;
        const nk = normalizeName(rep);
        let byDay = attrByRepDay.get(nk);
        if (!byDay) attrByRepDay.set(nk, (byDay = new Map()));
        let dd = byDay.get(sentDay);
        if (!dd) byDay.set(sentDay, (dd = { booked: new Set(), went: new Set(), signed: new Set(), goback: new Set(), review: new Set() }));
        dd.review.add(rv.id);
      }
    } catch { /* reviews best-effort — keep the other attribute points */ }
    // Ramp points = sum over days of the per-TYPE ramp (each type ramps on its own).
    const rampByNorm = new Map();
    for (const [nk, byDay] of attrByRepDay) {
      let pts = 0;
      for (const dd of byDay.values()) {
        pts += scoreDay(dd.booked.size) + scoreDay(dd.went.size) + scoreDay(dd.signed.size) + scoreDay(dd.goback.size) + scoreDay(dd.review.size);
      }
      rampByNorm.set(nk, pts);
    }

    // Sale bonus: +6 flat per roof sold in JN whose Sold Date is in the window.
    // Best-effort — if JN is unavailable, the board still shows the attribute points.
    const salesByNorm = new Map();
    let saleTotal = 0;
    try {
      if (JN_KEY) {
        const sold = await fetchSoldJobs(Math.floor(contestStart.getTime() / 1000) - 2 * 24 * 60 * 60);
        for (const j of sold) {
          const status = String(j.status_name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          if (!SOLD_STATUSES.has(status)) continue;
          const ms = soldDateMs(j);
          if (ms == null || ms < contestStart.getTime() || ms > contestEnd.getTime()) continue;
          const nk = normalizeName(j.sales_rep_name || "");
          if (!nk) continue;
          salesByNorm.set(nk, (salesByNorm.get(nk) || 0) + 1);
          saleTotal++;
        }
      }
    } catch { /* JN best-effort — keep the attribute points */ }

    // DIVISOR = active sales-rep ROSTER (not activity). Points from anyone off-roster
    // are dropped.
    const { rosterByZone } = await fetchZoneResolver();
    let matchedReps = 0;

    const zones = ZONE_ORDER
      .map((zone) => {
        const roster = rosterByZone[zone] || [];
        if (!roster.length) return null;
        let saleCount = 0;
        const reps = roster.map((m) => {
          const sales = salesByNorm.get(m.norm) || 0;
          saleCount += sales;
          const pts = (rampByNorm.get(m.norm) || 0) + sales * CONTEST.salePoints;
          if (pts) matchedReps++;
          return { name: m.name, count: pts, sales };
        }).sort((a, b) => b.count - a.count);
        const points = reps.reduce((s, r) => s + r.count, 0);
        const activeReps = roster.length;
        const avg = Math.round((points / activeReps) * 10) / 10;
        return { zone, team: ZONE_TEAMS[zone] || zone, count: avg, avg, points, activeReps, sales: saleCount, reps };
      })
      .filter(Boolean)
      .sort((a, b) => b.avg - a.avg);
    zones.forEach((z, i) => { z.rank = i + 1; });

    const payload = {
      ok: true, enabled, live, started, contest: CONTEST.name, week: weekLabel,
      weekNo: weeksWithBounds.indexOf(active) + 1,
      weeks: weeksWithBounds.map((w, i) => ({
        no: i + 1, label: w.label, range: etRangeLabel(w.start, w.end), started: now >= w.startUTC,
      })),
      range: { start: contestStart.toISOString(), end: contestEnd.toISOString() }, zones,
    };
    if (qp.debug === "1") {
      const rosterTotal = ZONE_ORDER.reduce((s, z) => s + ((rosterByZone[z] || []).length), 0);
      payload.scannedRows = rows.length; payload.rosterReps = rosterTotal;
      payload.repsWithPoints = rampByNorm.size; payload.pointsMatchedToRoster = matchedReps;
      payload.soldInWindow = saleTotal;
    }
    return cors(200, JSON.stringify(payload));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "Unknown error" }));
  }
};

// Contest on/off — app_settings.contest_enabled (so it flips without a deploy).
async function getContestEnabled() {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.contest_enabled&select=value&limit=1`, { headers: sb });
    if (!r.ok) return false;
    const rows = await r.json().catch(() => []);
    const v = rows[0]?.value;
    return v === true || v === "true" || v === 1 || v === "1";
  } catch { return false; }
}

// Paged REST fetch — PostgREST caps a single response at 1000 rows.
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

// Sold JN jobs touched since `since` (unix sec) — pulled by sold-stage status_name.
async function fetchSoldJobs(since) {
  const byId = new Map();
  for (const name of SOLD_STATUS_NAMES) {
    const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: name } }] }));
    for (let page = 0; page < 20; page++) {
      const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${since}&filter=${filter}`,
        { headers: { Authorization: `Bearer ${JN_KEY}`, "Content-Type": "application/json" } });
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const rows = d.results || d.jobs || [];
      for (const j of rows) byId.set(j.jnid || j.id, j);
      if (rows.length < 100) break;
    }
  }
  return [...byId.values()];
}
function soldDateMs(job) {
  const v = job["Sold Date"] != null ? job["Sold Date"] : job.cf_date_5;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

// Active-rep ROSTER from TMS rep-zones — the contest divisor.
async function fetchZoneResolver() {
  let reps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) reps = (await res.json()).reps || []; } catch { /* best-effort */ }
  const rosterByZone = {};
  const seen = new Set();
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
    if (seen.has(norm)) continue;
    seen.add(norm);
    (rosterByZone[r.zone] || (rosterByZone[r.zone] = [])).push({ name: String(r.name).trim(), norm });
  }
  return { rosterByZone };
}
function normalizeName(s) {
  return String(s || "").toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

// ── ET day windows ──
const TZ = "America/New_York";
function tzParts(date) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = {}; for (const part of dtf.formatToParts(date)) p[part.type] = part.value; return p;
}
function offsetMs(date) { const p = tzParts(date); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime(); }
function etWallToUTC(y, mo, d, h, mi, s) { const guess = Date.UTC(y, mo - 1, d, h, mi, s); return new Date(guess - offsetMs(new Date(guess))); }
function etDayStart(dateStr) { const [y, m, d] = dateStr.split("-").map(Number); return etWallToUTC(y, m, d, 0, 0, 0); }
function etDayEnd(dateStr) { const [y, m, d] = dateStr.split("-").map(Number); return etWallToUTC(y, m, d, 23, 59, 59); }
function etDayKey(iso) { const p = tzParts(new Date(iso)); return `${p.year}-${p.month}-${p.day}`; }

function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=20", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
