// netlify/functions/harvest-plan-clusters.js
//
// Enhanced Planned Day (Sr-only), Slice 1 — the clustering engine. Given a manager's
// zone, split the region's IQ + No-sit pins into N balanced, geographically-grouped
// clusters (N = # Sr reps on the team, incl. the manager, or an explicit k). The
// manager UI previews these, reassigns clusters to reps, then publishes.
//
//   POST { zone, k?, bbox?:{north,south,east,west} }
//   → { ok, zone, k, total, srReps:[{name,jobnimbus_id,harvest_token,lat,lng}],
//        clusters:[{ index, count, centroid:{lat,lng}, pin_ids:[...] }] }
//
// bbox defaults to the extent of the team's Sr rep locations (padded). CORS (TMS calls it).
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";
const PLAN_STATUSES = ["iq", "fb", "ai", "no_sit_reschedule"];

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, { ok: false, error: "POST only" });
  if (!SB_URL || !SB_KEY) return cors(500, { ok: false, error: "env missing" });
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, { ok: false, error: "bad JSON" }); }
  const zone = String(body.zone || "").trim();
  if (!zone) return cors(400, { ok: false, error: "zone required" });

  // Sr reps on this team (rep-zones carries zone + rep_level + home lat/lng).
  const srReps = await srRepsInZone(zone);
  const k = Math.max(1, Number(body.k) || srReps.length || 1);

  // Region box: explicit, else the extent of the team's rep homes (padded ~0.35°).
  let box = normalizeBox(body.bbox);
  if (!box) {
    const pts = srReps.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
    if (!pts.length) return cors(400, { ok: false, error: "no rep locations to infer a region; pass a bbox" });
    const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng), PAD = 0.35;
    box = { north: Math.max(...lats) + PAD, south: Math.min(...lats) - PAD, east: Math.max(...lngs) + PAD, west: Math.min(...lngs) - PAD };
  }

  const inStatus = PLAN_STATUSES.join(",");
  const path = `canvass_prospects?status=in.(${inStatus})&latitude=gte.${box.south}&latitude=lte.${box.north}` +
    `&longitude=gte.${box.west}&longitude=lte.${box.east}&latitude=not.is.null&select=id,latitude,longitude,status,address&limit=5000`;
  const pins = (await sbGet(path).catch(() => [])) || [];
  const pts = pins.map((p) => ({ id: p.id, lat: Number(p.latitude), lng: Number(p.longitude) })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

  // Rep-anchored assignment: give each door to the NEAREST Sr rep (capacity-balanced),
  // so every rep works the doors near THEM — Jacksonville reps get Jacksonville doors,
  // etc. Falls back to plain geo k-means only if we don't have usable rep locations.
  const repsHaveCoords = srReps.filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng)).length;
  const clusters = repsHaveCoords >= 2 ? assignToReps(pts, srReps) : balancedCluster(pts, k);
  // For the map overview, optionally hand back each cluster's point coords.
  if (body.points) {
    const coord = {}; for (const p of pts) coord[p.id] = [Number(p.lat.toFixed(5)), Number(p.lng.toFixed(5))];
    for (const c of clusters) c.pts = c.pin_ids.map((id) => coord[id]).filter(Boolean);
  }
  return cors(200, { ok: true, zone, k: clusters.length, total: pts.length, bbox: box, srReps, clusters });
};

// ── rep-anchored assignment ──────────────────────────────────────────────────
// Assign each door to the NEAREST Sr rep, capacity-balanced so no rep gets far more
// than n/k. Returns clusters ALIGNED to the srReps order (cluster i ↔ srReps[i]), so a
// rep's section is the doors closest to where they actually are. Reps without a
// location get an empty section. Closest pins claim their rep first; overflow spills to
// the next-nearest rep with room.
function assignToReps(points, srReps) {
  const centers = srReps.map((r, i) => ({ i, lat: Number(r.lat), lng: Number(r.lng) })).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
  const buckets = srReps.map(() => []); // aligned to srReps
  if (!centers.length || !points.length) return buildClusters(srReps, buckets, points);
  const d2 = (a, b) => { const dx = a.lat - b.lat, dy = a.lng - b.lng; return dx * dx + dy * dy; };
  const cap = Math.ceil(points.length / centers.length);
  // Each pin: its reps ranked nearest-first, plus its nearest distance (for ordering).
  const prefs = points.map((p, pi) => {
    const order = centers.map((c) => ({ i: c.i, d: d2(p, c) })).sort((a, b) => a.d - b.d);
    return { pi, order, nearest: order[0].d };
  }).sort((a, b) => a.nearest - b.nearest); // pins closest to a rep place first
  for (const pr of prefs) {
    let placed = false;
    for (const o of pr.order) { if (buckets[o.i].length < cap) { buckets[o.i].push(pr.pi); placed = true; break; } }
    if (!placed) buckets[pr.order[0].i].push(pr.pi); // safety (shouldn't happen: cap*k >= n)
  }
  return buildClusters(srReps, buckets, points);
}
function buildClusters(srReps, buckets, points) {
  return srReps.map((r, i) => {
    const pinPts = (buckets[i] || []).map((pi) => points[pi]);
    return { index: i, count: pinPts.length, centroid: centroidOf(pinPts), pin_ids: pinPts.map((p) => p.id) };
  });
}

// ── balanced geographic clustering (fallback when reps have no locations) ─────
// Farthest-point seeding → Lloyd's k-means for compactness → capacity rebalance so
// each cluster is within ±1 of n/k (even workload). Squared lat/lng distance is fine
// at metro scale. Deterministic (no RNG) so the same pins always split the same way.
function balancedCluster(points, k) {
  const n = points.length;
  if (k <= 1 || n === 0) return [{ index: 0, count: n, centroid: centroidOf(points), pin_ids: points.map((p) => p.id) }];
  if (n <= k) return points.map((p, i) => ({ index: i, count: 1, centroid: { lat: p.lat, lng: p.lng }, pin_ids: [p.id] }));

  const d2 = (a, b) => { const dx = a.lat - b.lat, dy = a.lng - b.lng; return dx * dx + dy * dy; };
  // Seed: westmost point, then repeatedly the point farthest from all chosen seeds.
  const start = points.reduce((m, p) => (p.lng < m.lng ? p : m), points[0]);
  const seeds = [{ lat: start.lat, lng: start.lng }];
  while (seeds.length < k) {
    let best = null, bestD = -1;
    for (const p of points) { let m = Infinity; for (const s of seeds) m = Math.min(m, d2(p, s)); if (m > bestD) { bestD = m; best = p; } }
    seeds.push({ lat: best.lat, lng: best.lng });
  }
  let cent = seeds, assign = new Array(n).fill(0);
  for (let iter = 0; iter < 14; iter++) {
    for (let i = 0; i < n; i++) { let bi = 0, bd = Infinity; for (let c = 0; c < k; c++) { const d = d2(points[i], cent[c]); if (d < bd) { bd = d; bi = c; } } assign[i] = bi; }
    const sum = Array.from({ length: k }, () => ({ lat: 0, lng: 0, n: 0 }));
    for (let i = 0; i < n; i++) { const c = assign[i]; sum[c].lat += points[i].lat; sum[c].lng += points[i].lng; sum[c].n++; }
    cent = cent.map((c, i) => (sum[i].n ? { lat: sum[i].lat / sum[i].n, lng: sum[i].lng / sum[i].n } : c));
  }

  // Rebalance to cap = ceil(n/k): from each over-full cluster, move the point farthest
  // from its centroid to the nearest cluster that still has room.
  const cap = Math.ceil(n / k);
  const groups = Array.from({ length: k }, () => []);
  points.forEach((p, i) => groups[assign[i]].push(i));
  for (let guard = 0; guard < n * 2; guard++) {
    const over = groups.findIndex((g) => g.length > cap);
    if (over < 0) break;
    groups[over].sort((a, b) => d2(points[b], cent[over]) - d2(points[a], cent[over]));
    const moveIdx = groups[over][0];
    let target = -1, td = Infinity;
    for (let c = 0; c < k; c++) { if (c === over || groups[c].length >= cap) continue; const d = d2(points[moveIdx], cent[c]); if (d < td) { td = d; target = c; } }
    if (target < 0) break;
    groups[over].shift(); groups[target].push(moveIdx);
  }
  return groups.map((idxs, c) => {
    const pinPts = idxs.map((i) => points[i]);
    return { index: c, count: idxs.length, centroid: centroidOf(pinPts), pin_ids: pinPts.map((p) => p.id) };
  });
}
function centroidOf(pts) {
  if (!pts.length) return null;
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
  return { lat, lng };
}
function normalizeBox(b) {
  if (!b) return null;
  const n = Number(b.north), s = Number(b.south), e = Number(b.east), w = Number(b.west);
  if (![n, s, e, w].every(Number.isFinite)) return null;
  return { north: Math.max(n, s), south: Math.min(n, s), east: Math.max(e, w), west: Math.min(e, w) };
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
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) throw new Error(await r.text().catch(() => "err")); return r.json(); }
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}
