// netlify/functions/harvest-today-appts.js
//
// TODAY's appointments for a rep (all sources — setter-booked AND map-booked), so
// the Harvesting Map can "plan the day around your appts". Returns each appt's TIME
// and LOCATION. Location comes from the map's own appt pin when there is one
// (canvass_prospects by jn_job_id — free, already geocoded), else the JN job's
// address geocoded via Google (cached by jnid so we never pay twice).
//
//   GET ?rt=<rep token>
//   → { ok, appts:[{ jn_job_id, name, address, lat, lng, at_ms }] }   // sorted by time
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY, GOOGLE_MAPS_API_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const GOOGLE_GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";
const APPT_TASK_TYPES = new Set(["Initial Appointment", "Reset Appointment", "Appointment"]);
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
        if (!APPT_TASK_TYPES.has(t.record_type_name)) continue;
        if (!(t.owners || []).some((o) => String(o.id) === String(jn))) continue;
        const sec = Number(t.date_start) || 0; if (!sec) continue;
        const rel = (t.related || []).find((x) => x.type === "job") || (t.primary && t.primary.type === "job" ? t.primary : null);
        const jobId = rel?.id || null;
        rows.push({ jobId, at_ms: sec * 1000, title: t.title || "" });
      }
      if (results.length < 100) break;
    }
  } catch { /* fall through with whatever we have */ }
  if (!rows.length) return cors(200, { ok: true, appts: [] });

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
      if (!geo && address && GOOGLE_KEY) { geo = await geocode(address); if (geo) { geocache[id] = geo; cacheDirty = true; } }
      jobInfo[id] = { name, address, geo };
    } catch { /* skip this one */ }
  }));
  if (cacheDirty) writeSetting(GEOCACHE_KEY, geocache).catch(() => {});

  // 4) Assemble — only appts we could place on the map.
  const appts = [];
  for (const row of rows) {
    const pin = row.jobId ? pinByJob[row.jobId] : null;
    if (pin && typeof pin.latitude === "number") {
      appts.push({ jn_job_id: row.jobId, name: pin.name || nameFromTitle(row.title), address: [pin.address, pin.city, pin.state, pin.zip].filter(Boolean).join(", "), lat: pin.latitude, lng: pin.longitude, at_ms: row.at_ms });
      continue;
    }
    const ji = row.jobId ? jobInfo[row.jobId] : null;
    if (ji && ji.geo) {
      appts.push({ jn_job_id: row.jobId, name: ji.name || nameFromTitle(row.title), address: ji.address, lat: ji.geo.lat, lng: ji.geo.lng, at_ms: row.at_ms });
    }
    // else: no location we can trust → leave it out (rep still sees it in JN).
  }
  appts.sort((a, b) => a.at_ms - b.at_ms);
  return cors(200, { ok: true, appts });
};

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
