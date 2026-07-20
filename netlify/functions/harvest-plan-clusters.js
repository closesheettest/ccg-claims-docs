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

// ── even, compact split (balanced k-means) ───────────────────────────────────
function balancedCluster(points, k) {
  const n = points.length;
  if (k <= 1 || n === 0) return [{ index: 0, count: n, centroid: centroidOf(points), pin_ids: points.map((p) => p.id) }];
  if (n <= k) return Array.from({ length: k }, (_, i) => ({ index: i, count: points[i] ? 1 : 0, centroid: points[i] ? { lat: points[i].lat, lng: points[i].lng } : null, pin_ids: points[i] ? [points[i].id] : [] }));
  const d2 = (a, b) => { const dx = a.lat - b.lat, dy = a.lng - b.lng; return dx * dx + dy * dy; };
  const start = points.reduce((m, p) => (p.lng < m.lng ? p : m), points[0]);
  const seeds = [{ lat: start.lat, lng: start.lng }];
  while (seeds.length < k) { let best = null, bd = -1; for (const p of points) { let m = Infinity; for (const s of seeds) m = Math.min(m, d2(p, s)); if (m > bd) { bd = m; best = p; } } seeds.push({ lat: best.lat, lng: best.lng }); }
  let cent = seeds, assign = new Array(n).fill(0);
  for (let it = 0; it < 14; it++) {
    for (let i = 0; i < n; i++) { let bi = 0, bd = Infinity; for (let c = 0; c < k; c++) { const d = d2(points[i], cent[c]); if (d < bd) { bd = d; bi = c; } } assign[i] = bi; }
    const s = Array.from({ length: k }, () => ({ lat: 0, lng: 0, n: 0 }));
    for (let i = 0; i < n; i++) { const c = assign[i]; s[c].lat += points[i].lat; s[c].lng += points[i].lng; s[c].n++; }
    cent = cent.map((c, i) => (s[i].n ? { lat: s[i].lat / s[i].n, lng: s[i].lng / s[i].n } : c));
  }
  const cap = Math.ceil(n / k);
  const groups = Array.from({ length: k }, () => []);
  points.forEach((p, i) => groups[assign[i]].push(i));
  for (let g = 0; g < n * 2; g++) {
    const over = groups.findIndex((x) => x.length > cap); if (over < 0) break;
    groups[over].sort((a, b) => d2(points[b], cent[over]) - d2(points[a], cent[over]));
    const mv = groups[over][0]; let t = -1, td = Infinity;
    for (let c = 0; c < k; c++) { if (c === over || groups[c].length >= cap) continue; const d = d2(points[mv], cent[c]); if (d < td) { td = d; t = c; } }
    if (t < 0) break; groups[over].shift(); groups[t].push(mv);
  }
  return groups.map((idxs, c) => { const pp = idxs.map((i) => points[i]); return { index: c, count: pp.length, centroid: centroidOf(pp), pin_ids: pp.map((p) => p.id) }; });
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
function minCostPerm(cost) {
  const k = cost.length;
  if (k === 0) return [];
  if (k > 9) { // greedy: repeatedly take the globally-cheapest unused (section, rep) pair
    const perm = new Array(k).fill(-1); const usedR = new Set(), usedS = new Set();
    const pairs = [];
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) pairs.push([cost[i][j], i, j]);
    pairs.sort((a, b) => a[0] - b[0]);
    for (const [, i, j] of pairs) { if (usedS.has(i) || usedR.has(j)) continue; perm[i] = j; usedS.add(i); usedR.add(j); }
    return perm;
  }
  let best = null, bestC = Infinity; const perm = new Array(k), used = new Array(k).fill(false);
  const rec = (i, acc) => {
    if (acc >= bestC) return;
    if (i === k) { bestC = acc; best = perm.slice(); return; }
    for (let j = 0; j < k; j++) { if (used[j]) continue; used[j] = true; perm[i] = j; rec(i + 1, acc + cost[i][j]); used[j] = false; }
  };
  rec(0, 0);
  return best || cost.map((_, i) => i);
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
