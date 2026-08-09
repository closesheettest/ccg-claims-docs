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
  // `gate: true` efforts are BARE door statuses that could be faked by boxing pins
  // and statusing without walking up, so they only score if the rep actually arrived
  // (see the loc_flag gate in the loop). Efforts with their OWN proof are exempt: a
  // signed inspection (the signature proves presence), a booked appointment, a sat
  // appointment, a review send. Arriving is never a point by itself.
  //
  // Google review: the SEND counts (anti-gaming — own-number block + one-credit-
  // per-phone — is enforced at send time, so here we just count the logged sends).
  if (k === "review_request") return { type: "review", key: `review|${row.pin_id || ""}|${row.created_at}`, gate: false };
  // Appointment RUN: the rep tapped "Appt done" after sitting one.
  if (k === "appt_done") return { type: "appt_run", key: `run|${row.created_at}`, gate: false };
  // Appointment SET: a booking (logs both a status + a visit row — dedupe per door).
  if (s === "appt") return { type: "appt_set", key: `set|${row.pin_id || row.created_at}`, gate: false };
  // Free roof inspection signed on the map — the SIGNATURE is proof of presence, so
  // it always counts even with no GPS/pin. Never gated.
  if (s === "insp_sold") return { type: "inspection", key: `insp|${row.pin_id || row.created_at}`, gate: false };
  // Go-back: BOTH a worked go-back pin OR any return knock — proxied as a round≥2
  // visit/status with a real contact outcome (not just "not home"). This is a bare
  // status, so it's GATED on arrival. ⚠️ may overlap with a same-door conversion
  // above (allowed — rewards the harder work).
  if (Number(row.round) >= 2 && (k === "visit" || k === "status") && s && s !== "not_home")
    return { type: "goback", key: `gb|${row.pin_id || row.created_at}|${row.round}`, gate: true };
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
    const contestStart = active.startUTC, contestEnd = active.endUTC; // Wed–Thu: where POINTS come from

    // Pull activity for the CONTEST DAYS only (paged — a single request caps at 1000).
    // Points come only from these days; the divisor is the active-rep ROSTER below.
    const rows = await sbGetAll(
      `canvass_activity?select=rep_name,kind,to_status,from_status,pin_id,round,loc_flag,created_at` +
      `&created_at=gte.${encodeURIComponent(contestStart.toISOString())}&created_at=lte.${encodeURIComponent(contestEnd.toISOString())}` +
      `&order=created_at.asc`
    );

    // Which pins did each rep actually ARRIVE at? An arrival event, or any row logged
    // verified-at-the-door, proves presence. The go-back gate checks THIS — not the
    // status row's own GPS — so a rep who arrived and then statused late / from down
    // the street still counts (we know they were there); a pin they never arrived at
    // (boxed and statused remotely) does not.
    const arrivedKeys = new Set(); // `${normName}|${pin_id}`
    for (const r of rows) {
      const rep = (r.rep_name || "").trim();
      if (!rep || !r.pin_id) continue;
      if (r.kind === "arrival" || r.loc_flag === "verified") arrivedKeys.add(`${normalizeName(rep)}|${r.pin_id}`);
    }

    // Per rep, per day: distinct qualifying efforts. Keyed by NORMALIZED name so it
    // lines up with the roster below (activity's rep_name vs the roster's name).
    const effortsByRepDay = new Map(); // normName → Map(dayKey → Set(effortKey))
    let skippedNoArrival = 0;
    for (const r of rows) {
      const rep = (r.rep_name || "").trim();
      if (!rep) continue; // orphaned/nameless rows can't be attributed
      const e = effortOf(r);
      if (!e) continue;
      const nk = normalizeName(rep);
      // Gated efforts (bare door statuses = go-backs) only score if the rep ARRIVED at
      // that pin. Late or far-away statusing is fine as long as they arrived at some
      // point; a pin never arrived at (boxed remotely) doesn't count.
      if (e.gate && !(r.pin_id && arrivedKeys.has(`${nk}|${r.pin_id}`))) { skippedNoArrival++; continue; }
      const day = etDayKey(r.created_at);
      let byDay = effortsByRepDay.get(nk);
      if (!byDay) effortsByRepDay.set(nk, (byDay = new Map()));
      let set = byDay.get(day);
      if (!set) byDay.set(day, (set = new Set()));
      set.add(e.key);
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
      payload.rejectedNoArrival = skippedNoArrival;
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
