// Public, read-only CONTEST leaderboard — a togglable team-standings strip on the
// rep dashboard alongside zone-leaderboard (inspections), zone-sales-leaderboard,
// and zone-harvest-leaderboard. Unlike those (which count ONE thing), this runs a
// configurable "positive-effort" contest and ranks teams by AVERAGE points per rep.
//
// THE CONTEST (see CONTEST below — swap the config for the next one):
//   • Positive efforts, each worth points: appointment SET, appointment RUN, free
//     roof inspection signed, go-back worked, Google-review request sent.
//   • Daily doubling, per rep: the first two efforts each day are worth 1 pt; the
//     3rd and every one after are worth 2. Resets each day.
//   • Team score = total points ÷ reps ACTIVE that week (active = any map activity
//     on a contest day — a barely-active rep still divides, so dead weight hurts).
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
// rules change) adjust `scoring` / the qualifying efforts in effortOf().
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

// Classify a canvass_activity row into a scoring EFFORT, or null if it isn't one.
// `key` dedupes repeats within a rep (the server+client rows for one booking, a
// re-fire, etc.) so one action = one effort. See the per-attribute notes.
function effortOf(row) {
  const s = row.to_status, k = row.kind;
  // Google review: the SEND counts (anti-gaming — own-number block + one-credit-
  // per-phone — is enforced at send time, so here we just count the logged sends).
  if (k === "review_request") return { type: "review", key: `review|${row.pin_id || ""}|${row.created_at}` };
  // Appointment RUN: the rep tapped "Appt done" after sitting one.
  if (k === "appt_done") return { type: "appt_run", key: `run|${row.created_at}` };
  // Appointment SET: a booking (logs both a status + a visit row — dedupe per door).
  if (s === "appt") return { type: "appt_set", key: `set|${row.pin_id || row.created_at}` };
  // Free roof inspection signed on the map.
  if (s === "insp_sold") return { type: "inspection", key: `insp|${row.pin_id || row.created_at}` };
  // Go-back: BOTH a worked go-back pin OR any return knock — proxied as a round≥2
  // visit/status with a real contact outcome (not just "not home"). ⚠️ may overlap
  // with a same-door conversion above (allowed — rewards the harder work).
  if (Number(row.round) >= 2 && (k === "visit" || k === "status") && s && s !== "not_home")
    return { type: "goback", key: `gb|${row.pin_id || row.created_at}|${row.round}` };
  return null;
}

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
    const start = active.startUTC, end = active.endUTC;

    // Pull every activity row in the contest-week window (paged — a single request
    // is capped at 1000, which would drop reps). We need ALL rows: efforts to score
    // AND every rep who was active (the divisor), including 0-point reps.
    const rows = await sbGetAll(
      `canvass_activity?select=rep_name,kind,to_status,from_status,pin_id,round,created_at` +
      `&created_at=gte.${encodeURIComponent(start.toISOString())}&created_at=lte.${encodeURIComponent(end.toISOString())}` +
      `&order=created_at.asc`
    );

    // rep → day → Set(effortKeys); rep → Set(active days). Active = any row at all.
    const effortsByRepDay = new Map(); // rep → Map(dayKey → Set(effortKey))
    const activeReps = new Set();
    for (const r of rows) {
      const rep = (r.rep_name || "").trim();
      if (!rep) continue; // orphaned/nameless rows can't be attributed
      activeReps.add(rep);
      const e = effortOf(r);
      if (!e) continue;
      const day = etDayKey(r.created_at);
      let byDay = effortsByRepDay.get(rep);
      if (!byDay) effortsByRepDay.set(rep, (byDay = new Map()));
      let set = byDay.get(day);
      if (!set) byDay.set(day, (set = new Set()));
      set.add(e.key);
    }

    // Rep points = sum over days of scoreDay(distinct efforts that day).
    const pointsByRep = new Map();
    for (const [rep, byDay] of effortsByRepDay) {
      let pts = 0;
      for (const set of byDay.values()) pts += scoreDay(set.size);
      pointsByRep.set(rep, pts);
    }

    // Zone resolver (reps + managers both count — whoever resolves to a zone).
    const { zoneOf } = await fetchZoneResolver();

    // Aggregate into zones: every ACTIVE rep divides (0-point reps included), so
    // dead weight pulls the team average down.
    const agg = {}; // zone → { points, reps:[{name,count}], activeReps }
    let unattributed = 0;
    for (const rep of activeReps) {
      const zone = zoneOf(rep);
      if (!zone) { unattributed++; continue; }
      const z = agg[zone] || (agg[zone] = { points: 0, reps: [], activeReps: 0 });
      const pts = pointsByRep.get(rep) || 0;
      z.points += pts;
      z.activeReps += 1;
      z.reps.push({ name: rep, count: pts });
    }

    const zones = ZONE_ORDER
      .map((zone) => {
        const z = agg[zone];
        if (!z || z.activeReps === 0) return null; // team with nobody active yet — omit
        const avg = Math.round((z.points / z.activeReps) * 10) / 10;
        const reps = z.reps.sort((a, b) => b.count - a.count);
        return { zone, team: ZONE_TEAMS[zone] || zone, count: avg, avg, points: z.points, activeReps: z.activeReps, reps };
      })
      .filter(Boolean)
      .sort((a, b) => b.avg - a.avg);
    zones.forEach((z, i) => { z.rank = i + 1; });

    const payload = {
      ok: true, enabled: CONTEST.enabled, contest: CONTEST.name, week: active.label,
      range: { start: start.toISOString(), end: end.toISOString() }, zones,
    };
    if (qp.debug === "1") { payload.scannedRows = rows.length; payload.activeReps = activeReps.size; payload.unattributed = unattributed; }
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

// Zone resolver — TMS rep-zones keyed by normalized name (activity carries only the
// name). Same normalization as the sibling boards. Reps + managers both resolve if
// they're in the feed with a zone.
async function fetchZoneResolver() {
  let reps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) reps = (await res.json()).reps || []; } catch { /* best-effort */ }
  const byName = {};
  for (const r of reps) if (r.name) byName[normalizeName(r.name)] = r.zone;
  const zoneOf = (name) => byName[normalizeName(name)] || null;
  return { zoneOf };
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
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
