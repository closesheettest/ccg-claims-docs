// netlify/functions/harvest-today-appts.js
//
// TODAY's appointments for a rep (all sources — setter-booked AND map-booked), so
// the DoorDispatcher can "plan the day around your appts". Returns each appt's TIME
// and LOCATION. Location comes from the map's own appt pin when there is one
// (canvass_prospects by jn_job_id — free, already geocoded), else the JN job's
// address geocoded via Google (cached by jnid so we never pay twice).
//
//   GET ?rt=<rep token>
//   → { ok, appts:[{ jn_job_id, name, address, lat, lng, at_ms, status }] }  // sorted by time
//     (lat/lng may be null when we couldn't place it — kept for the accountability gate;
//      status is the JN job's current status_name)
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY, GOOGLE_MAPS_API_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const GOOGLE_GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";
const APPT_TASK_TYPES = new Set(["Initial Appointment", "Reset Appointment", "Appointment"]);
// Match by record_type NUMBER too, in case JN returns a slightly different name for
// the type — 4 = Initial Appointment, 12 = Reset Appointment (a no-sit reschedule),
// 17 = Appointment. This is what makes a rep's rescheduled no-sits show on their map.
const APPT_TASK_RTS = new Set([4, 12, 17]);
const GEOCACHE_KEY = "appt_pin_geocache"; // jnid -> { lat, lng }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY || !JN_KEY) return cors(500, { ok: false, error: "env missing" });
  const rt = String((event.queryStringParameters || {}).rt || "").trim();
  if (!UUID.test(rt)) return cors(200, { ok: true, appts: [] });

  const rep = (await sbGet(`sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=jobnimbus_id,name&limit=1`))[0];
  const jn = rep?.jobnimbus_id;
  if (!jn) return cors(200, { ok: true, appts: [] });

  // Today's window in ET (FL), from ~2h ago (covers an appt already in progress) to
  // end of day, so we only plan around what's still ahead.
  const now = new Date();
  const off = etOffsetHours(now); // -4 (EDT) / -5 (EST)
  const etDay = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const sign = off < 0 ? "-" : "+"; const oh = String(Math.abs(off)).padStart(2, "0");
  const dayStartSec = Math.floor(new Date(`${etDay}T00:00:00${sign}${oh}:00`).getTime() / 1000);
  const fromSec = Math.min(Math.floor(Date.now() / 1000) - 2 * 3600, dayStartSec + 6 * 3600);
  const toSec = dayStartSec + 24 * 3600;
  // First of THIS month in ET — the accountability gate's look-back floor.
  const monthStartSec = Math.floor(new Date(`${etDay.slice(0, 7)}-01T00:00:00${sign}${oh}:00`).getTime() / 1000);

  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  // Filter by DATE ONLY — JobNimbus's task search does NOT honor a nested
  // { term: { "owners.id" } } filter (it silently returns nothing), which is why
  // reps' real appts weren't detected. We fetch the day's appts and match the
  // owner in code below (same approach as harvest-zone-appts, which works).
  const filter = encodeURIComponent(JSON.stringify({ must: [
    { range: { date_start: { gte: fromSec, lte: toSec } } },
  ] }));

  // 1) Today's appt tasks → { jobId, at_ms, title }.
  const rows = [];
  try {
    for (let page = 0; page < 8; page++) {
      const r = await fetch(`${JN_BASE}/tasks?size=100&from=${page * 100}&filter=${filter}`, { headers: jnHeaders });
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const results = d.results || d.tasks || d.data || [];
      for (const t of results) {
        if (!APPT_TASK_TYPES.has(t.record_type_name) && !APPT_TASK_RTS.has(Number(t.record_type))) continue;
        if (!(t.owners || []).some((o) => String(o.id) === String(jn))) continue;
        const sec = Number(t.date_start) || 0; if (!sec) continue;
        const rel = (t.related || []).find((x) => x.type === "job") || (t.primary && t.primary.type === "job" ? t.primary : null);
        const jobId = rel?.id || null;
        rows.push({ jobId, at_ms: sec * 1000, title: t.title || "" });
      }
      if (results.length < 100) break;
    }
  } catch { /* fall through with whatever we have */ }
  if (!rows.length) return cors(200, { ok: true, appts: [], overdue: await fetchOverdue(jnHeaders, jn, dayStartSec, monthStartSec, new Set()) });

  // 2) Location shortcut: the map's own appt pins (already geocoded) by jn_job_id.
  const jobIds = [...new Set(rows.map((r) => r.jobId).filter(Boolean))];
  const pinByJob = {};
  if (jobIds.length) {
    const inList = jobIds.map((id) => `"${id}"`).join(",");
    const pins = await sbGet(`canvass_prospects?jn_job_id=in.(${encodeURIComponent(inList)})&select=jn_job_id,name,address,city,state,zip,latitude,longitude`);
    for (const p of pins) if (p.jn_job_id) pinByJob[p.jn_job_id] = p;
  }

  // 3) For jobs WITHOUT a pin, fetch the JN job → address → geocode (cached).
  const geocache = (await readSetting(GEOCACHE_KEY)) || {};
  let cacheDirty = false;
  const needJobs = jobIds.filter((id) => !pinByJob[id]);
  const jobInfo = {};
  await Promise.all(needJobs.map(async (id) => {
    try {
      const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(id)}`, { headers: jnHeaders });
      if (!r.ok) return;
      const j = await r.json().catch(() => ({}));
      const address = [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", ");
      const name = j.display_name || j.name || "";
      let geo = geocache[id];
      // JobNimbus already stores the job's coordinates — use them (free, no geocode).
      // JN uses { lat, lon }; our shape is { lat, lng }. This is what makes a COMPANY /
      // office-booked appointment (which has no map pin, and whose address geocode was
      // silently failing) actually place on the rep's route.
      if (!geo && j.geo && Number(j.geo.lat) && Number(j.geo.lon)) geo = { lat: Number(j.geo.lat), lng: Number(j.geo.lon) };
      if (!geo && address && GOOGLE_KEY) { geo = await geocode(address); if (geo) { geocache[id] = geo; cacheDirty = true; } }
      jobInfo[id] = { name, address, geo, status: j.status_name || null, addr1: j.address_line1 || "", zip: j.zip || "" };
    } catch { /* skip this one */ }
  }));
  if (cacheDirty) writeSetting(GEOCACHE_KEY, geocache).catch(() => {});

  // 3.5) Address fallback — the robust one. For any appt we STILL can't place (no pin
  // matched by jn_job_id, and the JN job had no usable coordinates: geo 0,0 + geocode
  // miss), borrow coordinates from an already-geocoded map pin at the SAME street+zip.
  // This rescues company/Instant-Quote-booked appts whose JN job carries no geo and
  // whose map pin was never linked to the job id (e.g. an IQ-synced pin). Uses our own
  // pins, so it doesn't depend on the JN geo or Google.
  const unplaced = jobIds.filter((id) => !pinByJob[id] && !(jobInfo[id] && jobInfo[id].geo));
  for (const id of unplaced) {
    const ji = jobInfo[id];
    const addr1 = (ji && ji.addr1 || "").trim();
    const zip = (ji && ji.zip || "").trim();
    if (!addr1) continue;
    // Anchor the LIKE at the house number so "200 Park Place%" can't match "1200 …";
    // narrow by zip when we have it. First already-geocoded hit wins.
    let path = `canvass_prospects?address=ilike.${encodeURIComponent(addr1 + "%")}&latitude=not.is.null&select=name,address,city,state,zip,latitude,longitude&limit=1`;
    if (zip) path += `&zip=eq.${encodeURIComponent(zip)}`;
    try {
      const hits = await sbGet(path);
      if (hits && hits[0] && typeof hits[0].latitude === "number") pinByJob[id] = hits[0]; // reuse the pin assembly branch
    } catch { /* best-effort */ }
  }

  // Every appt job's current JN status — the "what happened with this appointment?"
  // accountability gate needs it to tell a still-open "Appointment Scheduled" (must be
  // closed out) from one already resolved. Reuse the job we already fetched above; only
  // pin-matched jobs (which skipped the fetch) need a lightweight status read.
  const statusByJob = {};
  await Promise.all(jobIds.map(async (id) => {
    if (jobInfo[id] && "status" in jobInfo[id]) { statusByJob[id] = jobInfo[id].status; return; }
    try {
      const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(id)}`, { headers: jnHeaders });
      if (r.ok) { const j = await r.json().catch(() => ({})); statusByJob[id] = j.status_name || null; }
    } catch { /* leave undefined — gate simply won't prompt for it */ }
  }));

  // 4) Assemble. Each appt carries its JN status for the accountability gate. Appts WITH
  // a trustworthy location can be routed (planner/banner use them); ones WITHOUT still
  // come back (lat/lng null) so the "what happened?" gate can prompt on a past appt —
  // the planner + banner filter by coords, so null-location appts never affect routing.
  const appts = [];
  for (const row of rows) {
    const pin = row.jobId ? pinByJob[row.jobId] : null;
    const status = row.jobId ? (statusByJob[row.jobId] || null) : null;
    if (pin && typeof pin.latitude === "number") {
      appts.push({ jn_job_id: row.jobId, name: pin.name || nameFromTitle(row.title), address: [pin.address, pin.city, pin.state, pin.zip].filter(Boolean).join(", "), lat: pin.latitude, lng: pin.longitude, at_ms: row.at_ms, status });
      continue;
    }
    const ji = row.jobId ? jobInfo[row.jobId] : null;
    if (ji && ji.geo) {
      appts.push({ jn_job_id: row.jobId, name: ji.name || nameFromTitle(row.title), address: ji.address, lat: ji.geo.lat, lng: ji.geo.lng, at_ms: row.at_ms, status });
      continue;
    }
    appts.push({ jn_job_id: row.jobId, name: (ji && ji.name) || (pin && pin.name) || nameFromTitle(row.title), address: (ji && ji.address) || (pin ? [pin.address, pin.city, pin.state, pin.zip].filter(Boolean).join(", ") : ""), lat: null, lng: null, at_ms: row.at_ms, status });
  }
  appts.sort((a, b) => a.at_ms - b.at_ms);

  // 5) OVERDUE — appointments from EARLIER DAYS that are still sitting at
  //    "Appointment Scheduled". Nobody ever recorded what happened.
  //
  //    The accountability gate used to read only today's list, so it could ask
  //    exactly once — on the day, after the appt time, and only from the start
  //    screen. Miss that window and the appointment aged out overnight and was
  //    never asked about again. (Aug 10-16: six appointments across four reps who
  //    were ON the map all week — 88, 85, 66 actions — and were never prompted.)
  //
  //    Asked the cheap way: JN jobs BY STATUS (a few hundred company-wide), not by
  //    re-scanning weeks of tasks. A job still at "Appointment Scheduled" IS the
  //    unstatused set by definition, so no status cross-check is needed.
  const overdue = await fetchOverdue(jnHeaders, jn, dayStartSec, monthStartSec, new Set(appts.map((a) => a.jn_job_id).filter(Boolean)));

  return cors(200, { ok: true, appts, overdue });
};

// Appointments from EARLIER DAYS (back to the 1st of this month) still sitting at
// "Appointment Scheduled" — nobody ever recorded what happened. Feeds the
// accountability gate only; never routed or planned around, that day is over.
//
// Asked the cheap way: JN jobs BY STATUS (a few hundred company-wide) rather than
// re-scanning weeks of tasks. A job still at "Appointment Scheduled" IS the
// unstatused set by definition, so no status cross-check is needed.
async function fetchOverdue(jnHeaders, jn, dayStartSec, monthStartSec, seen) {
  const out = [];
  try {
    const jf = encodeURIComponent(JSON.stringify({ must: [{ term: { status_name: "Appointment Scheduled" } }] }));
    for (let page = 0; page < 6; page++) {
      const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&filter=${jf}`, { headers: jnHeaders });
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const list = d.results || d.jobs || d.data || [];
      for (const j of list) {
        const id = j.jnid || j.id;
        if (!id || seen.has(id)) continue;
        // Theirs? sales_rep, or an owner. (Owner matched in code — JN's nested
        // owners filter silently returns nothing.)
        const mine = String(j.sales_rep || "") === String(jn) || (j.owners || []).some((o) => String(o.id) === String(jn));
        if (!mine) continue;
        const sec = Number(j.date_start) || 0;
        if (!sec || sec >= dayStartSec) continue;   // today/future → today's list owns it
        // Back to the 1st of this month only (Neal, 2026-08-17). Older is a backlog
        // nobody was ever asked about — 100+ records, some from April. Making a rep
        // reconstruct a spring door just to get their map back produces guessed
        // statuses, which is worse than none. The office bulk-cleans those in JN.
        if (sec < monthStartSec) continue;
        seen.add(id);
        out.push({
          jn_job_id: id,
          name: j.display_name || j.name || "Appointment",
          address: [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", "),
          lat: (j.geo && Number(j.geo.lat)) || null,
          lng: (j.geo && Number(j.geo.lon)) || null,
          at_ms: sec * 1000,
          status: j.status_name || null,
          overdue: true,
        });
      }
      if (list.length < 100) break;
    }
  } catch { /* best-effort — today's gate still works without it */ }
  out.sort((a, b) => a.at_ms - b.at_ms);
  return out;
}

function nameFromTitle(t) { const m = String(t || "").split("—"); return (m[1] || m[0] || "").trim() || "Appointment"; }
function etOffsetHours(d) {
  const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((et - utc) / 3600000);
}
async function geocode(addr) {
  if (!GOOGLE_KEY || !addr) return null;
  try {
    const r = await fetch(`${GOOGLE_GEOCODE}?address=${encodeURIComponent(addr)}&region=us&key=${GOOGLE_KEY}`);
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    const loc = d.results?.[0]?.geometry?.location;
    return loc && typeof loc.lat === "number" ? { lat: loc.lat, lng: loc.lng } : null;
  } catch { return null; }
}
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
async function sbGet(path) {
  try { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders }); return r.ok ? r.json() : []; } catch { return []; }
}
async function readSetting(key) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sbHeaders });
    if (!r.ok) return null;
    const v = (await r.json().catch(() => []))?.[0]?.value;
    return v ? (typeof v === "string" ? JSON.parse(v) : v) : null;
  } catch { return null; }
}
async function writeSetting(key, obj) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
      method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }),
    });
    return r.ok;
  } catch { return false; }
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}
