// netlify/functions/harvest-zone-appts.js
//
// Every Sr rep's upcoming JobNimbus appointments for a zone (next ~14 days), so the
// manager's "Plan the Day" map can MIRROR what's in JN — including appointments that
// fall OUTSIDE a rep's section, so the manager sees where each rep already has to be.
//
//   GET ?zone=Zone%204[&days=14]
//   → { ok, zone, appts:[{ rep_name, rep_token, jn_job_id, name, address, lat, lng, at_ms }] }
//
// CORS (TMS dashboard). Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY, GOOGLE_MAPS_API_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_PLACES_API_KEY;
const JN_BASE = "https://app.jobnimbus.com/api1";
const GOOGLE_GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";
const APPT_TASK_TYPES = new Set(["Initial Appointment", "Reset Appointment", "Appointment"]);
const APPT_TASK_RTS = new Set([4, 12, 17]); // match by number too (12 = Reset Appointment) in case JN's name differs
const GEOCACHE_KEY = "appt_pin_geocache";
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY || !JN_KEY) return cors(500, { ok: false, error: "env missing" });
  const zone = String((event.queryStringParameters || {}).zone || "").trim();
  if (!zone) return cors(400, { ok: false, error: "zone required" });
  const days = Math.min(60, Math.max(1, Number((event.queryStringParameters || {}).days) || 14));

  // Zone's Sr reps (jobnimbus_id → name/token). Appts are owned by these ids.
  const reps = await srRepsInZone(zone);
  const byJn = {}; for (const r of reps) if (r.jobnimbus_id) byJn[String(r.jobnimbus_id)] = r;
  if (!Object.keys(byJn).length) return cors(200, { ok: true, zone, appts: [] });

  const nowSec = Math.floor(Date.now() / 1000) - 2 * 3600;
  const toSec = nowSec + days * 24 * 3600;
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const filter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_start: { gte: nowSec, lte: toSec } } }] }));

  // 1) Appt tasks in the window owned by one of this zone's Sr reps.
  const rows = [];
  try {
    for (let page = 0; page < 6; page++) {
      const r = await fetch(`${JN_BASE}/tasks?size=100&from=${page * 100}&filter=${filter}`, { headers: H });
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const results = d.results || d.tasks || d.data || [];
      for (const t of results) {
        if (!APPT_TASK_TYPES.has(t.record_type_name) && !APPT_TASK_RTS.has(Number(t.record_type))) continue;
        const owner = (t.owners || []).map((o) => String(o.id)).find((id) => byJn[id]);
        if (!owner) continue;
        const sec = Number(t.date_start) || 0; if (!sec) continue;
        const rel = (t.related || []).find((x) => x.type === "job") || (t.primary && t.primary.type === "job" ? t.primary : null);
        rows.push({ jobId: rel?.id || null, at_ms: sec * 1000, title: t.title || "", rep: byJn[owner] });
      }
      if (results.length < 100) break;
    }
  } catch { /* use what we have */ }
  if (!rows.length) return cors(200, { ok: true, zone, appts: [] });

  // 2) Location: prefer the map's own appt pins (already geocoded), else geocode the job.
  const jobIds = [...new Set(rows.map((r) => r.jobId).filter(Boolean))];
  const pinByJob = {};
  if (jobIds.length) {
    for (let i = 0; i < jobIds.length; i += 100) {
      const inList = jobIds.slice(i, i + 100).map((id) => `"${id}"`).join(",");
      const pins = await sbGet(`canvass_prospects?jn_job_id=in.(${encodeURIComponent(inList)})&select=jn_job_id,name,address,city,state,zip,latitude,longitude`).catch(() => []);
      for (const p of pins) if (p.jn_job_id) pinByJob[p.jn_job_id] = p;
    }
  }
  const geocache = (await readSetting(GEOCACHE_KEY)) || {};
  let dirty = false;
  const needJobs = jobIds.filter((id) => !pinByJob[id]);
  const jobInfo = {};
  await Promise.all(needJobs.map(async (id) => {
    try {
      const r = await fetch(`${JN_BASE}/jobs/${encodeURIComponent(id)}`, { headers: H });
      if (!r.ok) return;
      const j = await r.json().catch(() => ({}));
      const address = [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", ");
      let geo = geocache[id];
      if (!geo && address && GOOGLE_KEY) { geo = await geocode(address); if (geo) { geocache[id] = geo; dirty = true; } }
      jobInfo[id] = { name: j.display_name || j.name || "", address, geo };
    } catch { /* skip */ }
  }));
  if (dirty) writeSetting(GEOCACHE_KEY, geocache).catch(() => {});

  const appts = [];
  for (const row of rows) {
    const pin = row.jobId ? pinByJob[row.jobId] : null;
    let loc = null, name = nameFromTitle(row.title), address = "";
    if (pin && typeof pin.latitude === "number") { loc = { lat: pin.latitude, lng: pin.longitude }; name = pin.name || name; address = [pin.address, pin.city, pin.state, pin.zip].filter(Boolean).join(", "); }
    else { const ji = row.jobId ? jobInfo[row.jobId] : null; if (ji && ji.geo) { loc = ji.geo; name = ji.name || name; address = ji.address; } }
    if (!loc) continue;
    appts.push({ rep_name: row.rep.name, rep_token: row.rep.harvest_token || null, jn_job_id: row.jobId, name, address, lat: loc.lat, lng: loc.lng, at_ms: row.at_ms });
  }
  appts.sort((a, b) => a.at_ms - b.at_ms);
  return cors(200, { ok: true, zone, appts });
};

async function srRepsInZone(zone) {
  let tms = [];
  try { const r = await fetch(TMS_REP_ZONES_URL); if (r.ok) tms = (await r.json()).reps || []; } catch { /* ignore */ }
  const sr = tms.filter((r) => r.zone === zone && r.rep_level === "senior" && r.active !== false);
  const salesReps = (await sbGet("sales_reps?select=name,jobnimbus_id,harvest_token&limit=1000").catch(() => [])) || [];
  const byName = {}; for (const s of salesReps) if (s.name) byName[norm(s.name)] = s;
  return sr.map((r) => { const s = byName[norm(r.name)] || {}; return { name: r.name, jobnimbus_id: r.jobnimbus_id || s.jobnimbus_id || null, harvest_token: s.harvest_token || null }; });
}
function nameFromTitle(t) { const m = String(t || "").split("—"); return (m[1] || m[0] || "").trim() || "Appointment"; }
function norm(s) { return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim(); }
async function geocode(addr) {
  if (!GOOGLE_KEY || !addr) return null;
  try { const r = await fetch(`${GOOGLE_GEOCODE}?address=${encodeURIComponent(addr)}&region=us&key=${GOOGLE_KEY}`); if (!r.ok) return null; const d = await r.json().catch(() => ({})); const loc = d.results?.[0]?.geometry?.location; return loc && typeof loc.lat === "number" ? { lat: loc.lat, lng: loc.lng } : null; } catch { return null; }
}
async function readSetting(key) { const r = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`).catch(() => []); if (!r[0]) return null; try { return typeof r[0].value === "string" ? JSON.parse(r[0].value) : r[0].value; } catch { return null; } }
async function writeSetting(key, value) { return fetch(`${SB_URL}/rest/v1/app_settings`, { method: "POST", headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, value: JSON.stringify(value) }) }); }
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) throw new Error(await r.text().catch(() => "err")); return r.json(); }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: typeof body === "string" ? body : JSON.stringify(body) }; }
