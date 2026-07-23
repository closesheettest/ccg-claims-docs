// netlify/functions/cron-install-blitz.js
//
// INSTALL-RADIUS BLITZ — the highest-converting knock in door-to-door, automated:
// the moment a JobNimbus job hits "Roof Started", this pulls the OWNER-OCCUPIED
// neighbors around that address from the free FL statewide cadastral and drops
// them on the Harvesting Map as 🔥 blitz pins — so reps knock "we're doing your
// neighbor's roof RIGHT NOW" while the crew is visibly on the roof.
//
//   • Toggle: app_settings.harvest_blitz_enabled ("true"/"false", default OFF) —
//     the office flips it on the Pin Types admin page. OFF → this cron no-ops.
//   • Trigger: JN status_name "Roof Started" (exact match, same fetch pattern as
//     the no-sit sync).
//   • Neighbors: cadastral parcels within RADIUS_M of the install, homesteaded
//     (JV_HMSTD/AV_HMSTD > 0 = owner-occupied), nearest first, capped at MAX_DOORS.
//     The install's own parcel and any address that already has a pin are skipped.
//   • Pins: canvass_prospects status "blitz" (pin type seeded in harvest_pin_types,
//     visible to juniors + seniors, outcomes mirror inspection doors), list_name
//     "Install Blitz", extra { blitz_jnid, install_address, owner, … }.
//   • Cleanup: when a job LEAVES "Roof Started" (or after MAX_AGE_DAYS), its
//     UNWORKED blitz pins (still status=blitz) are removed — worked doors keep
//     their status. Same "only delete what we have proof moved" guard as the
//     no-sit sync, so a partial JN fetch can't wipe pins.
//
// GET = dry-run report · ?commit=1 = write · scheduled runs auto-commit.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY;

const BLITZ_STATUS = "Roof Started";
const RADIUS_M = 250;        // ~820 ft around the install
const MAX_DOORS = 30;        // nearest owner-occupied neighbors per install
const MAX_AGE_DAYS = 14;     // unworked blitz pins expire after this
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
  if (!enabled) return json(200, { ok: true, enabled: false, note: "Blitz is OFF (harvest_blitz_enabled). Nothing done." });

  // 1. Every job currently in "Roof Started".
  const jobs = await fetchJobsByStatus(BLITZ_STATUS);
  const jnidOf = (j) => j.jnid || j.id;
  const liveJnids = new Set(jobs.map(jnidOf));

  // 2. Which installs have we already blitzed? (any pin carrying that blitz_jnid)
  const blitzedJnids = new Set();
  const existingBlitz = await sbGetAll(`canvass_prospects?list_name=eq.${encodeURIComponent("Install Blitz")}&select=id,status,extra`);
  for (const p of existingBlitz) { const j = p.extra && p.extra.blitz_jnid; if (j) blitzedJnids.add(j); }

  const report = { ok: true, enabled: true, committed: commit, roof_started: jobs.length, new_installs: 0, pins_created: 0, skipped_existing_addr: 0, removed_stale: 0, installs: [] };

  // 3. Blitz each NEW install.
  for (const j of jobs) {
    const jnid = jnidOf(j);
    if (blitzedJnids.has(jnid)) continue;
    const addr = [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", ");
    if (!j.address_line1) continue;
    const geo = (Number(j.geo && j.geo.lat) && Number(j.geo && j.geo.lon))
      ? { lat: Number(j.geo.lat), lng: Number(j.geo.lon) }
      : await geocode(addr);
    if (!geo) { report.installs.push({ jnid, addr, error: "no geocode" }); continue; }

    // Owner-occupied neighbors from the cadastral, nearest-first.
    const neighbors = await cadastralNeighbors(geo, j.address_line1);
    report.new_installs += 1;
    const entry = { jnid, addr, neighbors_found: neighbors.length, created: 0 };

    if (commit && neighbors.length) {
      const nowIso = new Date().toISOString();
      const rows = [];
      for (const n of neighbors.slice(0, MAX_DOORS)) {
        // Skip doors that already have ANY pin at that address (don't stack pins).
        const street = (n.address || "").split(",")[0].trim();
        if (!street) continue;
        const dup = await sbGet(`canvass_prospects?address=ilike.${encodeURIComponent(street)}&select=id&limit=1`);
        if (dup.length) { report.skipped_existing_addr += 1; continue; }
        rows.push({
          name: n.owner || "Homeowner",
          address: street, city: n.city || j.city || null, state: "FL", zip: n.zip || null,
          latitude: n.lat, longitude: n.lng, geocode_status: "ok",
          status: "blitz", status_by: "Install blitz", status_updated_at: nowIso,
          list_name: "Install Blitz",
          extra: {
            blitz_jnid: jnid, install_address: addr,
            owner: n.owner || null, homestead: true, occupancy: "owner_occupied",
            parcel_id: n.parcel_id || null, synced_at: nowIso,
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

  // 4. Cleanup: unworked blitz pins whose install left "Roof Started" (with proof
  //    from a recent any-status pull) or that aged out.
  if (commit) {
    const recent = await fetchRecentJobs(Math.floor(Date.now() / 1000) - 45 * 86400);
    const seen = new Set([...jobs, ...recent].map(jnidOf));
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400 * 1000;
    const stale = [];
    for (const p of existingBlitz) {
      if (p.status !== "blitz") continue; // worked doors keep their outcome
      const bj = p.extra && p.extra.blitz_jnid;
      const born = Date.parse((p.extra && p.extra.synced_at) || "") || 0;
      const jobMoved = bj && seen.has(bj) && !liveJnids.has(bj);
      if (jobMoved || (born && born < cutoff)) stale.push(p.id);
    }
    for (let i = 0; i < stale.length; i += 100) {
      const chunk = stale.slice(i, i + 100);
      const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects?id=in.(${chunk.join(",")})`, {
        method: "DELETE", headers: { ...sbHeaders, Prefer: "return=minimal" },
      });
      if (r.ok) report.removed_stale += chunk.length;
    }
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
