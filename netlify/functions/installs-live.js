// netlify/functions/installs-live.js
//
// Current roof installs for the Installs Map (?mode=installs). Pulls the JN jobs
// in the install phase — "Roof Started" (a crew is on it now) and "Upcoming
// Installs" (scheduled, foreman has pre-install tasks) — and returns each one's
// location + JOBSITE FOREMAN so the map can color a pin per foreman.
//
//   GET ?token=<visit or dialer token>
//   → { ok, installs:[{ jnid, name, address, city, foreman, status, lat, lng }], foremen:[names] }
//
// Foreman = cf_string_3 ("Jobsite Foreman"). Location = the job's geo, else the
// job address geocoded (cached in app_settings.appt_pin_geocache, shared with
// harvest-today-appts so we never pay Google twice for the same job).
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY, GOOGLE_MAPS_API_KEY

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;
const STATUSES = ["Roof Started", "Upcoming Installs"];
const GEOCACHE_KEY = "appt_pin_geocache";
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!JN_KEY || !SB_URL || !SB_KEY) return cors(500, { ok: false, error: "env missing" });
  const token = String((event.queryStringParameters || {}).token || "").trim();
  if (!token || !(await okToken(token))) return cors(401, { ok: false, error: "Invalid link" });

  try {
    const jobs = (await Promise.all(STATUSES.map(fetchJobsByStatus))).flat();
    const geocache = (await readSetting(GEOCACHE_KEY)) || {};
    let cacheDirty = false;

    const installs = [];
    for (const j of jobs) {
      const jnid = j.jnid || j.id;
      const foreman = String(j.cf_string_3 || "").trim() || "Unassigned";
      const address = [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", ");
      let geo = (Number(j.geo && j.geo.lat) && Number(j.geo && j.geo.lon))
        ? { lat: Number(j.geo.lat), lng: Number(j.geo.lon) }
        : geocache[jnid];
      if (!geo && address) { geo = await geocode(address); if (geo) { geocache[jnid] = geo; cacheDirty = true; } }
      if (!geo) continue; // can't place it → skip
      installs.push({
        jnid, name: j.name || address || "Install", address, city: j.city || null,
        foreman, status: j.status_name || null, lat: geo.lat, lng: geo.lng,
      });
    }
    if (cacheDirty) writeSetting(GEOCACHE_KEY, geocache).catch(() => {});

    const foremen = [...new Set(installs.map((i) => i.foreman))].sort();
    return cors(200, { ok: true, count: installs.length, foremen, installs });
  } catch (e) {
    return cors(500, { ok: false, error: e.message || "error" });
  }
};

async function fetchJobsByStatus(status) {
  const all = [];
  const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: status } }] }));
  for (let page = 0; page < 10; page++) {
    const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&filter=${filter}`, { headers: jnHeaders });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const rows = d.results || d.jobs || [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}
async function geocode(addr) {
  if (!GOOGLE_KEY || !addr) return null;
  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&region=us&key=${GOOGLE_KEY}`);
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    const loc = d.results?.[0]?.geometry?.location;
    return loc && typeof loc.lat === "number" ? { lat: loc.lat, lng: loc.lng } : null;
  } catch { return null; }
}
async function okToken(token) {
  const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]);
  return (!!d && token === d) || (!!v && token === v);
}
async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0]?.value || null;
}
async function readSetting(key) {
  const v = (await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`))[0]?.value;
  return v ? (typeof v === "string" ? JSON.parse(v) : v) : null;
}
async function writeSetting(key, obj) {
  try {
    await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
      method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }),
    });
  } catch { /* best-effort */ }
}
async function sbGet(path) {
  try { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders }); return r.ok ? r.json() : []; } catch { return []; }
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}
