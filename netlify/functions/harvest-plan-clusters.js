// netlify/functions/harvest-plan-clusters.js
//
// Enhanced Planned Day — split a ZONE's IQ + No-sit pins EVENLY across its Sr reps.
// Pins are bounded to the zone by COUNTY (ZONE_COUNTIES, mirrors TMS src/lib/zones.js)
// so a rep never gets out-of-zone doors. Each pin's county is looked up once via the
// free FCC geo API and cached in app_settings, so repeat plans are fast. The manager
// can EXCLUDE reps (body.exclude) → their share redisperses across the rest.
//
//   POST { zone, k?, exclude?:[tokens/jnids], points? }
//   → { ok, zone, total, srReps:[…], excluded:[…], clusters:[{ index,count,centroid,pin_ids,rep }],
//        indexing?:bool, remaining?:n }   (indexing = still county-stamping; call again)
//
// CORS. Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";
const PLAN_STATUSES = ["iq", "fb", "ai", "no_sit_reschedule"];
const COUNTY_CACHE_KEY = "harvest_pin_county";
const MAX_LOOKUPS = 220;      // county lookups per call — keeps us under the function timeout
const SPLIT_LAT = 28.55;      // Rt-50 proxy: split counties (Orange/Brevard) N→Zone 1, S→Zone 2

// Zone → counties (from TMS src/lib/zones.js; ** split counties handled by SPLIT_LAT).
const ZONE_COUNTIES = {
  "Zone 1": ["nassau", "duval", "baker", "union", "bradford", "clay", "st. johns", "putnam", "flagler", "alachua", "levy", "marion", "sumter", "lake", "seminole", "volusia", "brevard", "orange"],
  "Zone 2": ["orange", "brevard", "pasco", "hillsborough", "polk", "osceola", "indian river", "highlands", "citrus", "hernando"],
  "Zone 3": ["pinellas", "manatee", "sarasota", "charlotte", "lee", "collier", "monroe", "hardee", "desoto", "glades", "hendry", "st. lucie", "okeechobee"],
  "Zone 4": ["martin", "palm beach", "broward", "miami-dade"],
};
const SPLIT_COUNTIES = new Set(["orange", "brevard"]);
const normCounty = (c) => String(c || "").toLowerCase().replace(/\s+county$/, "").replace(/\bsaint\b/g, "st.").trim();

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, { ok: false, error: "POST only" });
  if (!SB_URL || !SB_KEY) return cors(500, { ok: false, error: "env missing" });
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, { ok: false, error: "bad JSON" }); }
  const zone = String(body.zone || "").trim();
  if (!ZONE_COUNTIES[zone]) return cors(400, { ok: false, error: "unknown zone" });
  const excludeSet = new Set((Array.isArray(body.exclude) ? body.exclude : []).map(String));

  const srReps = await srRepsInZone(zone);
  const included = srReps.filter((r) => !excludeSet.has(r.harvest_token || "") && !excludeSet.has(r.jobnimbus_id || ""));
  const k = Math.max(1, Number(body.k) || included.length || 1);

  // All candidate pins statewide (the workable set is small, ~a few hundred).
  const pins = (await sbGet(`canvass_prospects?status=in.(${PLAN_STATUSES.join(",")})&latitude=not.is.null&select=id,latitude,longitude&limit=5000`).catch(() => [])) || [];
  const pts = pins.map((p) => ({ id: p.id, lat: Number(p.latitude), lng: Number(p.longitude) })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

  // County per pin — cached; look up a bounded batch of the uncached ones per call.
  const cache = (await readSetting(COUNTY_CACHE_KEY)) || {};
  const uncached = pts.filter((p) => !(p.id in cache));
  const toLookup = uncached.slice(0, MAX_LOOKUPS);
  if (toLookup.length) {
    for (let i = 0; i < toLookup.length; i += 20) {
      const chunk = toLookup.slice(i, i + 20);
      const res = await Promise.all(chunk.map((p) => countyFor(p.lat, p.lng)));
      chunk.forEach((p, idx) => { cache[p.id] = res[idx] || ""; }); // "" = looked up, no county (won't match any zone)
    }
    await writeSetting(COUNTY_CACHE_KEY, cache).catch(() => {});
  }
  const indexing = uncached.length > toLookup.length;
  const remaining = uncached.length - toLookup.length;

  // Keep only pins whose county falls in this zone (split counties by Rt-50 latitude).
  const zonePts = pts.filter((p) => inZone(zone, cache[p.id], p.lat));

  const clusters = balancedCluster(zonePts, k);
  // Match each compact section to the rep whose HOME is nearest → least travel (so a
  // Jacksonville rep gets the Jacksonville section, an Ocala rep the Leesburg one, etc.).
  const perm = matchSectionsToReps(clusters, included);
  clusters.forEach((c, i) => { c.rep = included[perm[i]] || null; });
  if (body.points) {
    const coord = {}; for (const p of zonePts) coord[p.id] = [Number(p.lat.toFixed(5)), Number(p.lng.toFixed(5))];
    for (const c of clusters) c.pts = c.pin_ids.map((id) => coord[id]).filter(Boolean);
  }
  return cors(200, { ok: true, zone, total: zonePts.length, k: clusters.length, srReps, excluded: [...excludeSet], clusters, indexing, remaining });
};

function inZone(zone, county, lat) {
  const c = normCounty(county);
  if (!c) return false;
  if (!ZONE_COUNTIES[zone].includes(c)) return false;
  if (SPLIT_COUNTIES.has(c)) { // Orange/Brevard split N/S at Rt 50
    if (zone === "Zone 1") return lat >= SPLIT_LAT;
    if (zone === "Zone 2") return lat < SPLIT_LAT;
  }
  return true;
}
async function countyFor(lat, lng) {
  try {
    const r = await fetch(`https://geo.fcc.gov/api/census/area?lat=${lat}&lon=${lng}&format=json`);
    if (!r.ok) return null;
    const j = await r.json();
    return (j.results && j.results[0] && j.results[0].county_name) || null;
  } catch { return null; }
}

// ── compact, near-even split (recursive spatial median split) ────────────────
// Carve the zone into k COMPACT, NON-OVERLAPPING territories of near-equal size by
// repeatedly cutting the point set in half along its wider axis at the median. Unlike
// forced-balance k-means, territories never stretch across each other → no criss-cross.
function balancedCluster(points, k) {
  const groups = medianSplit(points, Math.max(1, k));
  return groups.map((g, i) => ({ index: i, count: g.length, centroid: centroidOf(g), pin_ids: g.map((p) => p.id) }));
}
function medianSplit(points, k) {
  if (k <= 1) return [points];
  if (!points.length) return Array.from({ length: k }, () => []);
  const kL = Math.floor(k / 2), kR = k - kL;
  const nL = Math.round(points.length * kL / k);
  const lats = points.map((p) => p.lat), lngs = points.map((p) => p.lng);
  const avgLat = lats.reduce((a, b) => a + b, 0) / lats.length;
  const latSpread = Math.max(...lats) - Math.min(...lats);
  const lngSpread = (Math.max(...lngs) - Math.min(...lngs)) * Math.cos(avgLat * Math.PI / 180); // lng→miles scale at this lat
  const byLat = latSpread >= lngSpread;
  const sorted = points.slice().sort((a, b) => (byLat ? a.lat - b.lat : a.lng - b.lng));
  return [...medianSplit(sorted.slice(0, nL), kL), ...medianSplit(sorted.slice(nL), kR)];
}
function centroidOf(pts) { if (!pts.length) return null; return { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length }; }

// Assign sections to reps to MINIMIZE total home-to-section distance. cost[i][j] =
// (section i centroid → rep j home)². Returns perm[i] = rep index for section i.
// Optimal via pruned brute force for small teams (k ≤ 9); greedy fallback above that.
function matchSectionsToReps(clusters, reps) {
  const BIG = 1e9;
  const d2 = (a, b) => { const dx = a.lat - b.lat, dy = a.lng - b.lng; return dx * dx + dy * dy; };
  const cost = clusters.map((c) => reps.map((r) => {
    const lat = Number(r.lat), lng = Number(r.lng);
    if (!c.centroid || !Number.isFinite(lat) || !Number.isFinite(lng)) return BIG;
    return d2(c.centroid, { lat, lng });
  }));
  return minCostPerm(cost);
}
// Greedy "closest pair wins": repeatedly lock in the (section, rep) pair with the
// smallest home-to-section distance, then remove both. Gives each rep their own nearest
// section (the rep closest to a section claims it) rather than sacrificing one rep to
// shave the group total — which is what a manager expects.
function minCostPerm(cost) {
  const k = cost.length;
  if (k === 0) return [];
  const perm = new Array(k).fill(-1); const usedR = new Set(), usedS = new Set();
  const pairs = [];
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) pairs.push([cost[i][j], i, j]);
  pairs.sort((a, b) => a[0] - b[0]);
  for (const [, i, j] of pairs) { if (usedS.has(i) || usedR.has(j)) continue; perm[i] = j; usedS.add(i); usedR.add(j); }
  return perm;
}

// ── Sr reps in zone (name + home coords + CCG harvest_token) ──────────────────
async function srRepsInZone(zone) {
  let tms = [];
  try { const r = await fetch(TMS_REP_ZONES_URL); if (r.ok) tms = (await r.json()).reps || []; } catch { /* ignore */ }
  const sr = tms.filter((r) => r.zone === zone && r.rep_level === "senior" && r.active !== false);
  const salesReps = (await sbGet("sales_reps?select=name,jobnimbus_id,harvest_token&limit=1000").catch(() => [])) || [];
  const byJn = {}, byName = {};
  for (const s of salesReps) { if (s.jobnimbus_id) byJn[s.jobnimbus_id] = s; if (s.name) byName[norm(s.name)] = s; }
  return sr.map((r) => {
    const s = (r.jobnimbus_id && byJn[r.jobnimbus_id]) || byName[norm(r.name)] || {};
    return { name: r.name, jobnimbus_id: r.jobnimbus_id || null, harvest_token: s.harvest_token || null, lat: Number(r.latitude), lng: Number(r.longitude) };
  });
}
function norm(s) { return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim(); }
async function readSetting(key) {
  const r = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`).catch(() => []);
  if (!r[0]) return null; try { return typeof r[0].value === "string" ? JSON.parse(r[0].value) : r[0].value; } catch { return null; }
}
async function writeSetting(key, value) {
  return fetch(`${SB_URL}/rest/v1/app_settings`, { method: "POST", headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, value: JSON.stringify(value) }) });
}
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) throw new Error(await r.text().catch(() => "err")); return r.json(); }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: typeof body === "string" ? body : JSON.stringify(body) }; }
