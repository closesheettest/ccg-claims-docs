// Public, read-only HARVEST leaderboard — the third team-standings strip
// (alongside zone-leaderboard = inspections signed, zone-sales-leaderboard =
// sales sold). Counts TWO sources of harvested appointments:
//   1. MAP bookings — a rep books (or reschedules) an appointment off a pin;
//      harvest-book-appt.js / harvest-book-btr-appt.js log a canvass_activity
//      row { to_status:'appt' } with a harvest origin (iq/fb/ai/no-sit/self_gen).
//   2. JOBNIMBUS bookings (reverse direction, per Neal) — an appointment booked
//      in the window on a FIELD-GENERATED job: source "Harvesting" (a door knocked
//      off the map) or "Self Generated" (a drop pin), credited to the job's sales
//      rep. Inbound COMPANY call-ins passed out (Instant Quote / Facebook / AI) and
//      Referral are NOT counted here — the rep didn't generate them in the field.
//      Deduped against map bookings by jn_job_id; one credit per job.
// THE RULE: if the rep generated it in the field / worked the pin on the map, it
// counts — junior or senior (the Jr/Sr badge flags who). A lead that called in and
// was scheduled in JN (reverse-synced) is not the rep's field work, so it's out.
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
// A harvested appointment is credited to the period in which it was SET (booked) —
// NOT when the appointment itself is scheduled. So a deal booked this month whose
// appointment is next month still counts THIS month. We use the job's date_created
// (when the harvest job was created = when the appt was set); date_start (the appt
// date) is intentionally NOT used for period bucketing — it would drop a set-this-
// month / appt-next-month deal out of this month (e.g. 1007 Grant, set in July,
// appt 8/3). date_created is durable — it never moves as the deal advances.
function harvestInWindow(job, startSec, endSec) {
  const n = Number(job.date_created);
  return Number.isFinite(n) && n >= startSec && n <= endSec;
}
function harvestWhen(job) {
  const n = Number(job.date_created) || 0;
  return n ? new Date(n * 1000).toISOString() : null;
}
// The door a harvested job represents. JN job names embed the street address
// with a " - <recid>" suffix ("1831 Natchez Trace Boulevard - 13326"); strip it.
// Fall back to street fields, then the primary contact name.
function jobAddress(job) {
  const nm = String(job.name || "").replace(/\s*-\s*\d+\s*$/, "").trim();
  if (nm) return nm;
  const line = [job.address_line1, job.city].filter(Boolean).join(", ").trim();
  if (line) return line;
  return (job.primary && job.primary.name) || "Harvested lead";
}
// Prettify an ALL-CAPS address ("1071 LILLIAN ST") to Title Case for display,
// leaving short directionals/suffixes uppercase. Leaves mixed-case input alone.
function titleAddr(s) {
  const str = String(s || "").trim();
  if (!str || str !== str.toUpperCase()) return str;
  return str.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(N|S|E|W|Ne|Nw|Se|Sw)\b/g, (m) => m.toUpperCase());
}

// The actual MAP PIN TYPE behind a credit, shown next to each address in the
// drill-down — read from the pin's own status (the from_status it had when the rep
// booked it), NOT the coarse JobNimbus source. So it lists exactly WHAT IT WAS ON
// THE MAP: "IQ Pin", "Facebook Pin", "No-Sit Rebook", "Inspection Lead", "Drop Pin",
// etc. — never a generic "Knock pin".
const PIN_LABEL = {
  iq: "IQ Pin", iq_ni: "IQ Pin", fb: "Facebook Pin", ai: "AI Pin",
  self_gen: "Drop Pin", no_sit_reschedule: "No-Sit Rebook", insp: "Inspection Lead",
  referral: "Referral", clover: "Clover Pin", damage_observed: "Damage Pin",
};
function pinLabel(fromStatus) {
  const f = String(fromStatus || "").toLowerCase();
  // A drop pin (self_gen) worked ON the map → "Drop Pin". A credit we can't find on
  // the map at all (no pin / no status log) → the rep entered that appointment
  // himself → "Self Generated". (Per Neal.)
  return PIN_LABEL[f] || "Self Generated";
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

    // HARVEST = an inbound lead (IQ / Facebook / AI), a No-sit reschedule pin, a
    // rep's own SELF-GENERATED door, or a "Pending – come back" (insp_callback) door
    // the rep set aside and later booked — all turned into an appointment. NOT a
    // retail/BTR appt booked off an existing inspection pin (from_status=insp) —
    // that's post-inspection, excluded. Filter by the pin's ORIGIN (from_status).
    // We don't filter on `kind`: a booking logs both a server row (kind=status) and
    // a client row (kind=visit), so we dedupe by pin_id below to count each house once.
    const acts = await sbGet(
      `canvass_activity?to_status=eq.appt&from_status=in.(iq,fb,ai,no_sit_reschedule,self_gen,insp_callback)` +
      `&created_at=gte.${encodeURIComponent(start.toISOString())}&created_at=lte.${encodeURIComponent(end.toISOString())}` +
      `&select=rep_name,pin_id,from_status,created_at&order=created_at.asc&limit=20000`
    );
    const { zoneOf, isJunior } = await fetchZoneResolver();

    // zone → { count, byRep:{ name → count } }. Dedupe by pin so the server+client
    // rows for one booking (and a same-period re-book of the same house) count once.
    // agg[zone] = { count, byRep:{name→count}, deals:[{rep,label}] } — `deals`
    // is the per-house drill-down (which appointments account for the count),
    // so a manager can tap a rep and see every door behind their number.
    const agg = {};
    let unattributed = 0;
    const seenPins = new Set();
    const mapDealRefs = []; // { zone, rep, pin_id } — labels (addresses) filled in below
    // Audit trail (debug=2): EVERY candidate deal with origin + who + counted/excluded,
    // so the office can see exactly what a manager mis-flag pulled onto the board.
    const auditOn = qp.debug === "2";
    const auditRows = [];
    for (const a of acts) {
      if (a.pin_id) { if (seenPins.has(a.pin_id)) continue; seenPins.add(a.pin_id); }
      const jr = isJunior(a.rep_name);
      const zone = zoneOf(a.rep_name);
      // Credit is by the PIN's harvest origin (from_status), NOT the rep's level —
      // juniors self-generate and work IQ pins too (per Neal); the Jr/Sr badge on
      // the board shows who's a junior. BTR/inspection pins never reach here — the
      // query already restricts from_status to iq/fb/ai/no-sit/self-gen.
      if (auditOn) auditRows.push({ origin: "map", rep: (a.rep_name || "—").trim() || "—", level: jr ? "junior" : (zone ? "senior" : "unknown"), zone: zone || null, kind: a.from_status, when: a.created_at, pin_id: a.pin_id, counted: !!zone, excluded: !zone ? "no-zone" : null });
      if (!zone) { unattributed++; continue; }
      const z = agg[zone] || (agg[zone] = { count: 0, byRep: {}, deals: [] });
      z.count += 1;
      const rep = (a.rep_name || "—").trim() || "—";
      z.byRep[rep] = (z.byRep[rep] || 0) + 1;
      mapDealRefs.push({ zone, rep, pin_id: a.pin_id, from: a.from_status });
    }
    // Resolve pin → street address (and jn_job_id for JN-side dedup) once.
    const pinAddr = {};
    const mapJobIds = new Set();
    {
      const pinIds = [...seenPins];
      for (let i = 0; i < pinIds.length; i += 100) {
        const rows = await sbGet(`canvass_prospects?id=in.(${pinIds.slice(i, i + 100).join(",")})&select=id,address,city,jn_job_id`);
        for (const p of rows) { if (p.address) pinAddr[p.id] = titleAddr(`${p.address}${p.city ? ", " + p.city : ""}`); if (p.jn_job_id) mapJobIds.add(p.jn_job_id); }
      }
    }
    for (const d of mapDealRefs) { const z = agg[d.zone]; if (z) z.deals.push({ rep: d.rep, label: pinAddr[d.pin_id] || "Map lead", source: pinLabel(d.from) }); }
    if (auditOn) for (const r of auditRows) if (r.origin === "map" && r.pin_id) r.label = pinAddr[r.pin_id] || "Map lead";

    // ── JN-SIDE HARVESTED APPOINTMENTS (reverse direction, per Neal) ─────────
    // Appointments made directly IN JobNimbus count too, but ONLY when the job is
    // FIELD-GENERATED — source "Harvesting" (knocked off the map) or "Self Generated"
    // (drop pin) — credited to the job's sales rep, junior or senior. An inbound
    // company lead that called in and got scheduled (Instant Quote / Facebook / AI /
    // Referral reverse-synced) is NOT the rep's field work and does not count here.
    // Booking time = the appt TASK's created date in the window (matches how map
    // bookings count). Deduped against map bookings via the booked pins' jn_job_id,
    // and one credit per JOB. Best-effort: a JN hiccup never breaks the board.
    let jnCounted = 0;
    try {
      if (JN_KEY) {
        // (mapJobIds — jobs already credited from a map booking — built above.)

        // ── DURABLE harvest credit (was: transient appointment tasks) ──────────
        // Credit reads the JOB's PERMANENT state, never an open appt task. The
        // old approach counted jobs via appointment TASKS created in the window;
        // when a rep SITS the appointment the office completes that task, and a
        // completed task drops out of the /tasks search — so the harvested deal
        // silently vanished from the board the moment the rep did the work (and
        // again when it advanced to Sit/Sold). Now: a harvest-flagged job counts
        // once as long as its appointment (date_start) or its creation
        // (date_created) falls in the window — both persist through completion
        // and every later status change, so credit only ever grows.
        const startSec = Math.floor(start.getTime() / 1000), endSec = Math.floor(end.getTime() / 1000);
        const sinceSec = startSec - 8 * 86400; // any deal active this window was updated since ~a week prior

        // Candidate jobs, deduped by id. (a) source = "Harvesting" is a small,
        // server-filtered set (no 1,500-job cap). (b) jobs behind appointment
        // tasks created this window catch any harvest job whose source isn't
        // "Harvesting" — belt + suspenders, so we never count fewer than before.
        const candidates = new Map();
        // JN-side credits count only FIELD-GENERATED sources — work the rep did out in
        // the field: "Harvesting" (a door knocked off the map) and "Self Generated" (a
        // drop pin). Instant Quote / Facebook / AI are inbound COMPANY leads that called
        // in and were passed out — NOT harvested — so they are NOT pulled here. (A rep
        // who actually knocks an IQ/FB pin on the MAP is caught on the map side via
        // canvass_activity and still counts.) Referral is excluded for now — can't yet
        // tell a rep-generated field referral from a call-in.
        const srcFilter = encodeURIComponent(JSON.stringify({ must: [{ bool: { minimum_should_match: 1, should: [
          { match_phrase: { source_name: "Harvesting" } },
          { match_phrase: { source_name: "Self Generated" } },
        ] } }] }));
        for (let page = 0; page < 40; page++) {
          const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${sinceSec}&filter=${srcFilter}`, { headers: jnHeaders });
          if (!r.ok) break;
          const d = await r.json().catch(() => ({}));
          const rows = d.results || d.jobs || [];
          for (const j of rows) candidates.set(j.jnid || j.id, j);
          if (rows.length < 100) break;
        }
        // Filter the scan to APPOINTMENT task types server-side. Without this, a MONTH
        // window buries appt tasks under thousands of other tasks (notes/reminders), so a
        // fixed page budget only samples a fraction of appt tasks — and the leaderboard
        // undercounts the month (month < week). record_type [4,12,17] = Initial / Reset /
        // Appointment. 60 pages (6,000 appt tasks) covers any real window.
        const APPT_RTS = [4, 12, 17];
        const taskFilter = encodeURIComponent(JSON.stringify({ must: [
          { range: { date_created: { gte: startSec, lte: endSec } } },
          { terms: { record_type: APPT_RTS } },
        ] }));
        // job id → earliest appt-task date_created IN this window = the true BOOKED date
        // (when the appointment was SET, not when it's scheduled for).
        const taskJobIds = new Map();
        for (let page = 0; page < 60; page++) {
          const r = await fetch(`${JN_BASE}/tasks?size=100&from=${page * 100}&filter=${taskFilter}`, { headers: jnHeaders });
          if (!r.ok) break;
          const d = await r.json().catch(() => ({}));
          const rows = d.results || d.tasks || [];
          for (const t of rows) {
            // Belt + suspenders: if JN ignores the server-side type filter, still keep only appt tasks.
            if (!APPT_TASK_TYPES.has(t.record_type_name) && !APPT_RTS.includes(Number(t.record_type))) continue;
            const dc = Number(t.date_created) || 0;
            for (const rel of (t.related || [])) if (rel.type === "job" && rel.id) {
              const prev = taskJobIds.get(rel.id);
              if (prev == null || (dc && dc < prev)) taskJobIds.set(rel.id, dc);
            }
          }
          if (rows.length < 100) break;
        }
        // Jobs whose appt task was set in-window but that AREN'T in the Harvesting-source
        // pull (e.g. an IQ/RepCard-origin job booked in JN) — fetch them individually so
        // they can be credited. Bounded by a time budget so we never trip the function
        // timeout, but far more generous than the old flat 60 (which under-counted a month).
        let individual = 0; const t0 = Date.now();
        for (const id of taskJobIds.keys()) {
          if (candidates.has(id)) continue;
          if (individual >= 250 || Date.now() - t0 > 6000) break;
          individual++;
          try { const r = await fetch(`${JN_BASE}/jobs/${id}`, { headers: jnHeaders }); if (r.ok) { const job = await r.json().catch(() => null); if (job) candidates.set(id, job); } } catch { /* skip */ }
        }

        // Count each harvest job once, off durable dates — survives task
        // completion and Sit/Sold advancement.
        //
        // JN-side HARVEST = FIELD-GENERATED work only, for junior AND senior alike
        // (the Jr/Sr badge flags who): "Harvesting" (a door knocked off the map) and
        // "Self Generated" (a drop pin). Instant Quote / Facebook / AI are inbound
        // COMPANY call-ins passed out — NOT the rep's field work — so they're excluded
        // here; a rep who actually KNOCKS an IQ/FB pin on the map is credited via the
        // map side instead. Referral is excluded FOR NOW — we can't yet tell a rep-
        // generated field referral from a call-in (coming: a "referral?" flag in the
        // rep dashboard's retail-appt flow). Inspection/BTR follow-ups never count.
        const isHarvestSource = (s) => /self.?gen|harvest/i.test(String(s || ""));
        // Booking signal for the period. An appt TASK created in the window is a
        // booking. A rep's OWN field job (self-gen / harvesting) is created when they
        // set the appt, so its creation date counts as the booking too.
        const creationIsBooking = (s) => /self.?gen|harvest/i.test(String(s || ""));
        const jnDealsToLabel = []; // { obj, jobid, src } → labeled by the real map pin type after the loop
        for (const [id, job] of candidates) {
          if (!job || mapJobIds.has(id)) continue;
          const src = job.source_name || "";
          const rep = (job.sales_rep_name || "").trim();
          const jr = isJunior(rep);
          const zone = zoneOf(rep);
          const harvestSrc = isHarvestSource(src);
          // date_start (the appt date) is never used for period bucketing.
          const bookedInWindow = taskJobIds.has(id) || (creationIsBooking(src) && harvestInWindow(job, startSec, endSec));
          const bookedSec = taskJobIds.get(id) || Number(job.date_created) || 0;
          const bookedISO = bookedSec ? new Date(bookedSec * 1000).toISOString() : null;
          const excluded = !harvestSrc ? "not-harvest-source" : !bookedInWindow ? "no-booking-in-window" : !zone ? "no-zone" : null;
          if (auditOn) auditRows.push({ origin: "jn", label: titleAddr(jobAddress(job)), rep: rep || null, level: jr ? "junior" : (zone ? "senior" : "unknown"), zone: zone || null, source: src || null, status: job.status_name || null, booked: bookedISO, by_task: taskJobIds.has(id), job_created: harvestWhen(job), counted: !excluded, excluded });
          if (excluded) { if (excluded === "no-zone") unattributed++; continue; }
          const z = agg[zone] || (agg[zone] = { count: 0, byRep: {}, deals: [] });
          z.count += 1;
          z.byRep[rep || "—"] = (z.byRep[rep || "—"] || 0) + 1;
          const dealObj = { rep: rep || "—", label: titleAddr(jobAddress(job)), source: null };
          z.deals.push(dealObj);
          jnDealsToLabel.push({ obj: dealObj, jobid: id, src });
          jnCounted += 1;
        }
        // Label each JN-side credit with the ACTUAL map pin type it was — read from
        // the pin's status_log (the status it had when the rep booked it), so the
        // drill-down lists "IQ Pin / Inspection Lead / No-Sit Rebook / Drop Pin",
        // never the coarse JN source. Falls back to the source only if no pin/log.
        if (jnDealsToLabel.length) {
          const ids = [...new Set(jnDealsToLabel.map((x) => x.jobid))];
          const pinFromByJob = {};
          for (let i = 0; i < ids.length; i += 100) {
            const inList = ids.slice(i, i + 100).map((x) => `"${x}"`).join(",");
            const pins = await sbGet(`canvass_prospects?jn_job_id=in.(${encodeURIComponent(inList)})&select=jn_job_id,status_log`);
            for (const p of pins) {
              const log = Array.isArray(p.status_log) ? p.status_log : [];
              const appt = log.find((e) => e && e.to === "appt");
              const from = (appt && appt.from) || (log[0] && log[0].from) || null;
              if (p.jn_job_id) pinFromByJob[p.jn_job_id] = from;
            }
          }
          for (const x of jnDealsToLabel) x.obj.source = pinLabel(pinFromByJob[x.jobid]);
        }
      }
    } catch { /* board still renders from map bookings alone */ }

    const zones = ZONE_ORDER.map((zone) => {
      const z = agg[zone] || { count: 0, byRep: {}, deals: [] };
      const reps = Object.entries(z.byRep).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
      return { zone, team: ZONE_TEAMS[zone] || zone, count: z.count, reps, deals: z.deals || [] };
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
    if (qp.debug === "2") payload.audit = auditRows;
    return cors(200, JSON.stringify(payload));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "Unknown error" }));
  }
};

async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }

// Zone resolver — TMS rep-zones keyed by normalized name (harvest activity has
// only the name). Same normalization as zone-sales-leaderboard.js.
// Returns { zoneOf, isJunior }: JR reps only work inspection-needed + IQ-not-
// interested pins (Back-to-Retail), which are NEVER harvest — so they're
// excluded from this board entirely, even if a manager mis-flags one of their
// inspection deals "Sales Rep Harvested = Yes" in JobNimbus.
async function fetchZoneResolver() {
  let reps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) reps = (await res.json()).reps || []; } catch { /* best-effort */ }
  const byName = {};
  for (const r of reps) if (r.name) byName[normalizeName(r.name)] = { zone: r.zone, level: String(r.rep_level || "").toLowerCase() };
  const zoneOf = (name) => byName[normalizeName(name)]?.zone || null;
  const isJunior = (name) => byName[normalizeName(name)]?.level === "junior";
  return { zoneOf, isJunior };
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
