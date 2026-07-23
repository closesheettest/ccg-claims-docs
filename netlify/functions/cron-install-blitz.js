// netlify/functions/cron-install-blitz.js
//
// 🍀 CLOVER LEAF — the classic knock-around-the-job play, automated: the moment
// a JobNimbus job hits "Roof Started", this pulls the OWNER-OCCUPIED neighbors
// around that address from the free FL statewide cadastral and drops them on the
// Harvesting Map as 🍀 clover pins — reps knock "we're doing your neighbor's
// roof RIGHT NOW" while the crew is visibly on it.
//
//   • Toggle: app_settings.harvest_blitz_enabled ("true"/"false", default OFF) —
//     the office flips it on the Pin Types admin page. OFF → this cron no-ops.
//   • Trigger: JN status_name "Roof Started" (exact match).
//   • Neighbors: cadastral parcels within RADIUS_M of the install, homesteaded
//     (JV_HMSTD/AV_HMSTD > 0 = owner-occupied), nearest first, capped MAX_DOORS.
//     The install's own parcel and any address that already has a pin are skipped.
//   • Pins: canvass_prospects status "clover" (pin type in harvest_pin_types; at
//     the door the rep picks: Roof looks fine · Damage observed · Not home ·
//     Book appt / Sign inspection · Not interested), list_name "Clover Leaf".
//   • Persistence (per Neal): ONLY the doors worth keeping survive the install —
//     "Damage observed" stays FOREVER (an old roof with damage = a lead), and
//     live deal states (appt / sold / pending / come-back) are left alone. All
//     the rest — unworked clover, roof-looks-fine, not-interested, dead,
//     new-roof — clear once the job LEAVES "Roof Started" (proof-guarded, same
//     as the no-sit reconcile, so a partial JN fetch can't wipe pins).
//   • Ownership (per Neal): clover doors belong to the SALES REP WHO SOLD the
//     install — pins are born claimed by the job's sales_rep and only THEY see
//     them on the map. If that rep is no longer active, this cron releases the
//     claim and the doors open up for the reps working that region. A job with
//     no sales rep creates unclaimed (open) pins.
//
// GET = dry-run report · ?commit=1 = write · scheduled runs auto-commit.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;

const TRIGGER_STATUS = "Roof Started";
const LIST_NAME = "Clover Leaf";
const RADIUS_M = 250;        // ~820 ft around the install
const MAX_DOORS = 30;        // nearest owner-occupied neighbors per install
const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";
const CADASTRAL =
  "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query";

const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

exports.handler = async (event) => {
  const scheduled = !event.httpMethod;
  const qp = (event.queryStringParameters) || {};
  const commit = scheduled || /^(1|true|yes)$/i.test(String(qp.commit || ""));
  if (!JN_KEY || !SB_URL || !SB_KEY) return json(500, { ok: false, error: "missing env" });

  // Toggle — default OFF until Neal flips it.
  const enabled = String((await readSetting("harvest_blitz_enabled")) || "false") === "true";
  if (!enabled) return json(200, { ok: true, enabled: false, note: "Clover Leaf is OFF (harvest_blitz_enabled). Nothing done." });

  // 1. Every job currently in "Roof Started".
  const jobs = await fetchJobsByStatus(TRIGGER_STATUS);
  const jnidOf = (j) => j.jnid || j.id;

  // 2. Which installs have we already clover-leafed? (any pin carrying that jnid)
  const cloveredJnids = new Set();
  const existingClover = await sbGetAll(`canvass_prospects?list_name=eq.${encodeURIComponent(LIST_NAME)}&select=id,status,extra`);
  for (const p of existingClover) { const j = p.extra && (p.extra.clover_jnid || p.extra.blitz_jnid); if (j) cloveredJnids.add(j); }

  const report = { ok: true, enabled: true, committed: commit, roof_started: jobs.length, new_installs: 0, pins_created: 0, skipped_existing_addr: 0, claims_released: 0, installs: [] };

  // 3. Clover-leaf each NEW install.
  for (const j of jobs) {
    const jnid = jnidOf(j);
    if (cloveredJnids.has(jnid)) continue;
    const addr = [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", ");
    if (!j.address_line1) continue;
    const geo = (Number(j.geo && j.geo.lat) && Number(j.geo && j.geo.lon))
      ? { lat: Number(j.geo.lat), lng: Number(j.geo.lon) }
      : await geocode(addr);
    if (!geo) { report.installs.push({ jnid, addr, error: "no geocode" }); continue; }

    const neighbors = await cadastralNeighbors(geo, j.address_line1);
    report.new_installs += 1;
    const entry = { jnid, addr, neighbors_found: neighbors.length, created: 0 };

    if (commit && neighbors.length) {
      const nowIso = new Date().toISOString();
      // The cloverleaf belongs to the rep who SOLD this roof — born claimed by them.
      const sellerName = String(j.sales_rep_name || "").trim() || null;
      const sellerId = j.sales_rep || null;
      const rows = [];
      for (const n of neighbors.slice(0, MAX_DOORS)) {
        const street = (n.address || "").split(",")[0].trim();
        if (!street) continue;
        // Skip doors that already have ANY pin at that address (don't stack pins).
        const dup = await sbGet(`canvass_prospects?address=ilike.${encodeURIComponent(street)}&select=id&limit=1`);
        if (dup.length) { report.skipped_existing_addr += 1; continue; }
        rows.push({
          name: n.owner || "Homeowner",
          address: street, city: n.city || j.city || null, state: "FL", zip: n.zip || null,
          latitude: n.lat, longitude: n.lng, geocode_status: "ok",
          status: "clover", status_by: "Clover leaf", status_updated_at: nowIso,
          list_name: LIST_NAME,
          extra: {
            clover_jnid: jnid, install_address: addr,
            owner: n.owner || null, homestead: true, occupancy: "owner_occupied",
            parcel_id: n.parcel_id || null, synced_at: nowIso,
            ...(sellerName ? { claimed_by: sellerName, claimed_by_jn: sellerId } : {}),
          },
        });
      }
      if (rows.length) {
        const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects`, {
          method: "POST", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(rows),
        });
        if (r.ok) { entry.created = rows.length; report.pins_created += rows.length; }
        else entry.error = `insert ${r.status}`;
      }
    }
    report.installs.push(entry);
  }

  // 4. Cleanup when an install WRAPS: the job left "Roof Started" (proof = we saw
  //    it in a recent any-status pull) → delete that install's clover pins EXCEPT
  //    the keepers: Damage observed stays forever; live deal states are left alone.
  if (commit) {
    const KEEP_STATUSES = new Set(["damage_observed", "appt", "insp_sold", "insp_callback", "insp_pending"]);
    try {
      const liveJnids = new Set(jobs.map(jnidOf));
      const recent = await fetchRecentJobs(Math.floor(Date.now() / 1000) - 45 * 86400);
      const seen = new Set([...jobs, ...recent].map(jnidOf));
      const stale = [];
      for (const p of existingClover) {
        if (KEEP_STATUSES.has(p.status)) continue;
        const bj = p.extra && (p.extra.clover_jnid || p.extra.blitz_jnid);
        if (!bj) continue;
        if (seen.has(bj) && !liveJnids.has(bj)) stale.push(p.id); // install moved on → clear the leftovers
      }
      for (let i = 0; i < stale.length; i += 100) {
        const chunk = stale.slice(i, i + 100);
        const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects?id=in.(${chunk.join(",")})`, {
          method: "DELETE", headers: { ...sbHeaders, Prefer: "return=minimal" },
        });
        if (r.ok) report.removed_after_install = (report.removed_after_install || 0) + chunk.length;
      }
    } catch { /* best-effort */ }
  }

  // 5. Release claims whose rep is NO LONGER ACTIVE — the door (e.g. Damage
  //    observed) opens back up for everyone. Guarded: if the active-rep feed
  //    fails or looks empty, release nothing.
  if (commit) {
    try {
      const rz = await fetch(REP_ZONES_URL);
      const zj = rz.ok ? await rz.json().catch(() => null) : null;
      const active = new Set(((zj && zj.reps) || []).map((r) => String(r.name || "").trim().toLowerCase()).filter(Boolean));
      if (active.size >= 10) { // sanity: a broken feed must not mass-release
        for (const p of existingClover) {
          const claimed = p.extra && p.extra.claimed_by;
          if (!claimed) continue;
          if (active.has(String(claimed).trim().toLowerCase())) continue;
          const nextExtra = { ...p.extra };
          delete nextExtra.claimed_by; delete nextExtra.claimed_by_jn;
          nextExtra.released_from = claimed; nextExtra.released_at = new Date().toISOString();
          const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${p.id}`, {
            method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" },
            body: JSON.stringify({ extra: nextExtra }),
          });
          if (r.ok) report.claims_released += 1;
        }
      }
    } catch { /* best-effort */ }
  }

  return json(200, report);
};

// ── Cadastral: owner-occupied parcels within RADIUS_M, nearest first ─────────
async function cadastralNeighbors(center, installLine1) {
  const qs = new URLSearchParams({
    f: "json",
    geometry: `${center.lng},${center.lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    distance: String(RADIUS_M),
    units: "esriSRUnit_Meter",
    outFields: "PARCEL_ID,OWN_NAME,PHY_ADDR1,PHY_CITY,PHY_ZIPCD,JV_HMSTD,AV_HMSTD",
    returnGeometry: "false",
    returnCentroid: "true",
    outSR: "4326",
    resultRecordCount: "200",
  });
  try {
    const r = await fetch(`${CADASTRAL}?${qs.toString()}`);
    if (!r.ok) return [];
    const d = await r.json().catch(() => ({}));
    const feats = d.features || [];
    const norm = (s) => String(s || "").toUpperCase().replace(/\s+/g, " ").trim();
    const installNorm = norm(installLine1);
    const out = [];
    for (const f of feats) {
      const a = f.attributes || {};
      const cen = f.centroid || {};
      if (!(Number(a.JV_HMSTD || 0) > 0 || Number(a.AV_HMSTD || 0) > 0)) continue; // owner-occupied only
      if (!a.PHY_ADDR1 || typeof cen.x !== "number") continue;
      if (norm(a.PHY_ADDR1) === installNorm) continue; // not the install house itself
      out.push({
        parcel_id: a.PARCEL_ID || null,
        owner: prettyOwner(a.OWN_NAME),
        address: a.PHY_ADDR1, city: a.PHY_CITY || null, zip: a.PHY_ZIPCD ? String(a.PHY_ZIPCD) : null,
        lat: cen.y, lng: cen.x,
        dist: Math.hypot(cen.y - center.lat, cen.x - center.lng),
      });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  } catch { return []; }
}

// FL DOR stores OWN_NAME last-first; flip simple two-token people, leave entities.
function prettyOwner(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/,/.test(s)) { const [last, rest] = s.split(",").map((x) => x.trim()); return title(`${rest} ${last}`); }
  const toks = s.split(/\s+/);
  if (toks.length === 2 && !/LLC|INC|TRUST|CORP|CO\b|&/i.test(s)) return title(`${toks[1]} ${toks[0]}`);
  return title(s);
}
function title(s) { return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()); }

// ── JN ───────────────────────────────────────────────────────────────────────
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

async function fetchRecentJobs(sinceSec) {
  const all = [];
  for (let page = 0; page < 15; page++) {
    const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated&date_updated_after=${sinceSec}`, { headers: jnHeaders });
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
    const loc = d.results && d.results[0] && d.results[0].geometry && d.results[0].geometry.location;
    return loc && typeof loc.lat === "number" ? { lat: loc.lat, lng: loc.lng } : null;
  } catch { return null; }
}

// ── Supabase ─────────────────────────────────────────────────────────────────
async function sbGet(path) {
  try { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders }); if (!r.ok) return []; return await r.json().catch(() => []); } catch { return []; }
}
async function sbGetAll(path) {
  const all = [];
  for (let from = 0; from < 100000; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { ...sbHeaders, Range: `${from}-${from + 999}` } });
    if (!r.ok) break;
    const rows = await r.json().catch(() => []);
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return all;
}
async function readSetting(key) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sbHeaders });
    if (!r.ok) return null;
    const rows = await r.json().catch(() => []);
    return rows?.[0]?.value ?? null;
  } catch { return null; }
}
function json(statusCode, obj) { return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) }; }

// Every 2 hours during knocking hours (7 AM–9 PM ET).
exports.config = { schedule: "45 11,13,15,17,19,21,23,1 * * *" };
