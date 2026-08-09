// Public, read-only CONTEST leaderboard — a togglable team-standings strip on the
// rep dashboard alongside zone-leaderboard (inspections), zone-sales-leaderboard,
// and zone-harvest-leaderboard. Unlike those (which count ONE thing), this runs a
// configurable "positive-effort" contest and ranks teams by AVERAGE points per rep.
//
// THE CONTEST (see CONTEST below — swap the config for the next one):
//   • Points STACK, one per thing done: ARRIVAL at a door (presence — an arrival /
//     verified reading; incl. a not-home walked up to and a return-visit go-back),
//     a SIGNED INSPECTION, a BOOKED APPOINTMENT, a SAT appointment, a review send.
//     So an in-person inspection = 2 (the knock's arrival + the sign), while a remote
//     e-sign = 1 (no knock, no arrival). A pin statused from afar with no arrival
//     (boxed remotely) earns nothing.
//   • Daily doubling, per rep: the first two points each day are single; the 3rd and
//     every one after are worth 2. Resets each day.
//   • Team score = total points ÷ the team's ACTIVE-REP ROSTER (from TMS rep-zones),
//     NOT activity — every active sales rep divides the team total whether or not they
//     logged anything that week, so a rep who does nothing still drags the average to
//     0. That's what pressures managers to cut dead weight. POINTS are still earned
//     only on the contest days (Wed + Thu).
//   • Runs only on the contest DAYS (Wed + Thu). Each contest WEEK is scored on its
//     own and the board RESETS — it shows the active week only (latest week started).
//
// OFF SWITCH: CONTEST.enabled=false → returns { ok:true, zones:[] }, and the
// dashboard's mount() hides any board whose feed has no zones. Flip enabled=true
// (and deploy) Wednesday morning to go live. `?preview=1` computes anyway (for a
// dry run while it's still off); `?debug=1` adds scan diagnostics.
//
//   GET /.netlify/functions/zone-contest-leaderboard[?preview=1][?debug=1]
//   → { ok, enabled, contest, week, range:{start,end}, zones:[{ zone, team, count,
//       avg, points, activeReps, reps:[{ name, count }] }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";

// ── THE CONTEST ───────────────────────────────────────────────────────────
// To run a different contest later: flip enabled, set the weeks, and (if the
// rules change) adjust `scoring` / the qualifying efforts in the scan loop.
const CONTEST = {
  enabled: false, // ← flip true Wednesday morning (Aug 12) to go live
  name: "Positive-Effort Team Contest",
  // Each contest week is scored on its own (the board resets between them). A week
  // is its Wed + Thu; points are only earned on these ET days.
  weeks: [
    { label: "Week 1", start: "2026-08-12", end: "2026-08-13" }, // Wed–Thu
    { label: "Week 2", start: "2026-08-19", end: "2026-08-20" }, // Wed–Thu
    { label: "Week 3", start: "2026-08-26", end: "2026-08-27" }, // Wed–Thu
    { label: "Week 4", start: "2026-09-02", end: "2026-09-03" }, // Wed–Thu
  ],
  // Daily doubling: the first `freeCount` efforts each day are worth `freePts`,
  // every one after is worth `thenPts`.
  scoring: { freeCount: 2, freePts: 1, thenPts: 2 },
};

const ZONE_TEAMS = { "Zone 1": "SQUAD", "Zone 2": "SitSold", "Zone 3": "SHARKS", "Zone 4": "HURRICANE" };
const ZONE_ORDER = ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];

// Points for N efforts in one day (1-1-2 doubling). Order within the day doesn't
// matter to the total, so we only need the count.
function scoreDay(n) {
  const { freeCount, freePts, thenPts } = CONTEST.scoring;
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
  // OFF until the toggle flips (preview overrides so we can dry-run while it's off).
  if (!CONTEST.enabled && !preview) return cors(200, JSON.stringify({ ok: true, enabled: false, zones: [] }));

  try {
    // Pick the ACTIVE contest week = the latest week whose Wed has already started
    // (so Week 1 shows through the weekend, then flips to Week 2 on its Wednesday).
    const now = new Date();
    const weeksWithBounds = CONTEST.weeks.map((w) => ({
      ...w, startUTC: etDayStart(w.start), endUTC: etDayEnd(w.end),
    }));
    let active = null;
    for (const w of weeksWithBounds) if (w.startUTC <= now && (!active || w.startUTC > active.startUTC)) active = w;
    if (!active) active = weeksWithBounds[0]; // before the contest starts — no data yet, so the board stays empty
    const contestStart = active.startUTC, contestEnd = active.endUTC; // Wed–Thu: where POINTS come from

    // Pull activity for the CONTEST DAYS only (paged — a single request caps at 1000).
    // Points come only from these days; the divisor is the active-rep ROSTER below.
    const rows = await sbGetAll(
      `canvass_activity?select=rep_name,kind,to_status,from_status,pin_id,round,loc_flag,created_at` +
      `&created_at=gte.${encodeURIComponent(contestStart.toISOString())}&created_at=lte.${encodeURIComponent(contestEnd.toISOString())}` +
      `&order=created_at.asc`
    );

    // Points STACK — one per distinct thing a rep did:
    //   • ARRIVAL ("worked the pin") — presence at a door: an arrival event or a
    //     verified-at-door reading. Includes a not-home they walked up to; a return
    //     visit (go-back) is a fresh point (keyed per round). This is the point that
    //     makes an IN-PERSON inspection worth 2 — the knock that precedes it logs the
    //     arrival. A REMOTE e-sign has no knock, so no arrival → the inspection alone.
    //   • SIGNED INSPECTION — its own point, on top of the arrival if there was one.
    //   • BOOKED APPOINTMENT — its own point.
    //   • plus two PINLESS points: a sat appointment ("Appt done") and a review send.
    // A pin statused from afar with no arrival and no real outcome (boxed remotely)
    // earns nothing. Keyed by NORMALIZED name to line up with the roster below.
    const effortsByRepDay = new Map(); // normName → Map(dayKey → Set(effortKey))
    for (const r of rows) {
      const rep = (r.rep_name || "").trim();
      if (!rep) continue; // orphaned/nameless rows can't be attributed
      const nk = normalizeName(rep), day = etDayKey(r.created_at);
      const s = r.to_status, k = r.kind, pin = r.pin_id, round = r.round ?? 0;
      const add = (key) => {
        let byDay = effortsByRepDay.get(nk);
        if (!byDay) effortsByRepDay.set(nk, (byDay = new Map()));
        let set = byDay.get(day);
        if (!set) byDay.set(day, (set = new Set()));
        set.add(key);
      };
      if (pin && (k === "arrival" || r.loc_flag === "verified")) add(`arrive|${pin}|${round}`); // worked the door
      if (s === "insp_sold") add(`insp|${pin || r.created_at}`);   // signed inspection (stacks)
      if (s === "appt") add(`set|${pin || r.created_at}`);         // booked appointment (stacks)
      if (k === "appt_done") add(`run|${r.created_at}`);           // sat an appointment (pinless)
      if (k === "review_request") add(`review|${pin || ""}|${r.created_at}`); // review send (pinless)
    }
    // Rep points = sum over days of scoreDay(distinct efforts that day).
    const pointsByNorm = new Map();
    for (const [nk, byDay] of effortsByRepDay) {
      let pts = 0;
      for (const set of byDay.values()) pts += scoreDay(set.size);
      pointsByNorm.set(nk, pts);
    }

    // The DIVISOR is the ACTIVE SALES-REP ROSTER, not activity: every active rep on a
    // team divides that team's total whether or not they logged anything this week —
    // so a rep who does nothing still drags the average to 0. Reps + managers both
    // count (managers lift the average but aren't prize-eligible — a payout rule, not
    // computed here). Points from anyone NOT on the active roster are dropped.
    const { rosterByZone } = await fetchZoneResolver();
    let matchedReps = 0;

    const zones = ZONE_ORDER
      .map((zone) => {
        const roster = rosterByZone[zone] || [];
        if (!roster.length) return null; // no active reps on this team → omit
        const reps = roster.map((m) => {
          const pts = pointsByNorm.get(m.norm) || 0;
          if (pts) matchedReps++;
          return { name: m.name, count: pts };
        }).sort((a, b) => b.count - a.count);
        const points = reps.reduce((s, r) => s + r.count, 0);
        const activeReps = roster.length;
        const avg = Math.round((points / activeReps) * 10) / 10;
        return { zone, team: ZONE_TEAMS[zone] || zone, count: avg, avg, points, activeReps, reps };
      })
      .filter(Boolean)
      .sort((a, b) => b.avg - a.avg);
    zones.forEach((z, i) => { z.rank = i + 1; });

    const payload = {
      ok: true, enabled: CONTEST.enabled, contest: CONTEST.name, week: active.label,
      range: { start: contestStart.toISOString(), end: contestEnd.toISOString() }, zones,
    };
    if (qp.debug === "1") {
      const rosterTotal = ZONE_ORDER.reduce((s, z) => s + ((rosterByZone[z] || []).length), 0);
      payload.scannedRows = rows.length; payload.rosterReps = rosterTotal;
      payload.repsWithPoints = pointsByNorm.size; payload.pointsMatchedToRoster = matchedReps;
    }
    return cors(200, JSON.stringify(payload));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "Unknown error" }));
  }
};

// Paged REST fetch — PostgREST caps a single response at 1000 rows, so page with
// the Range header until a short page comes back.
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

// Active-rep ROSTER from TMS rep-zones — the contest divisor. Grouped by zone,
// deduped by normalized name (which is how points are matched back). The default
// feed is the active set; we still drop anyone explicitly flagged inactive. Reps +
// managers both count if they carry a zone.
async function fetchZoneResolver() {
  let reps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) reps = (await res.json()).reps || []; } catch { /* best-effort */ }
  const rosterByZone = {};
  const seen = new Set();
  for (const r of reps) {
    if (!r.name || !r.zone || r.active === false) continue;
    const norm = normalizeName(r.name);
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

// ── ET day windows (shares the tz math with the sibling boards) ──
const TZ = "America/New_York";
function tzParts(date) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = {}; for (const part of dtf.formatToParts(date)) p[part.type] = part.value; return p;
}
function offsetMs(date) { const p = tzParts(date); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime(); }
function etWallToUTC(y, mo, d, h, mi, s) { const guess = Date.UTC(y, mo - 1, d, h, mi, s); return new Date(guess - offsetMs(new Date(guess))); }
function etDayStart(dateStr) { const [y, m, d] = dateStr.split("-").map(Number); return etWallToUTC(y, m, d, 0, 0, 0); }
function etDayEnd(dateStr) { const [y, m, d] = dateStr.split("-").map(Number); return etWallToUTC(y, m, d, 23, 59, 59); }
// The ET calendar day (YYYY-MM-DD) a timestamp falls on — for grouping efforts by day.
function etDayKey(iso) { const p = tzParts(new Date(iso)); return `${p.year}-${p.month}-${p.day}`; }

function cors(status, body) {
  // Short cache — each contest week is only two days, so standings must move fast.
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=20", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
