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
//   • Ownership (per Neal, final): clover doors are born OPEN — any rep sees and
//     can work them ("lets make it available to anyone") — but the FIRST rep to
//     status one owns it from then on ("who ever statuses it owns it"; the claim
//     is stamped by the map's setStatus, not here). extra.sold_by records whose
//     install seeded the cluster — info only. If a claiming rep goes inactive,
//     this cron releases their claims so the doors reopen.
//   • Each cluster also gets ONE 🚧 "install_home" pin at the install itself so
//     reps see exactly where the crew is working (pulsing marker, info-only).
//   • Concurrency: an app_settings lock (clover_sync_lock) stops the Sync-now
//     button and the cron from double-pinning the same install.
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
const MAX_INSTALLS_PER_RUN = 3; // stay inside the 10s function budget — the 2h cron (or another Sync-now tap) picks up the rest
const LOCK_MS = 2 * 60 * 1000;  // a run older than this is presumed dead — steal its lock
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

  // Lock: a Sync-now tap racing the cron (or a second tap) must not double-pin
  // the same install — that's exactly what happened on the first live run.
  if (commit && !(await acquireLock())) {
    return json(200, { ok: true, enabled: true, locked: true, note: "Another sync is already running — give it a minute, then tap again." });
  }

  // 1. Every job currently in "Roof Started".
  const jobs = await fetchJobsByStatus(TRIGGER_STATUS);
  const jnidOf = (j) => j.jnid || j.id;

  // 2. Which installs have we already clover-leafed? (any pin carrying that jnid)
  const cloveredJnids = new Set();
  const existingClover = await sbGetAll(`canvass_prospects?list_name=eq.${encodeURIComponent(LIST_NAME)}&select=id,status,extra`);
  for (const p of existingClover) { const j = p.extra && (p.extra.clover_jnid || p.extra.blitz_jnid); if (j) cloveredJnids.add(j); }

  const report = { ok: true, enabled: true, committed: commit, roof_started: jobs.length, new_installs: 0, pins_created: 0, existing_counted: 0, claims_released: 0, installs: [] };

  // 3. Clover-leaf each NEW install (a few per run — see MAX_INSTALLS_PER_RUN).
  for (const j of jobs) {
    if (report.new_installs >= MAX_INSTALLS_PER_RUN) { report.note = "More installs waiting — next sync picks them up."; break; }
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
      // Whose install seeded this cluster — INFO ONLY (pins are born open; the
      // first rep to status a door claims it via the map).
      const sellerName = String(j.sales_rep_name || "").trim() || null;
      const sellerId = j.sales_rep || null;
      // ONE batched query finds which of these addresses already have a pin
      // (30 sequential lookups was what threatened the 10s budget).
      const cand = neighbors.slice(0, MAX_DOORS)
        .map((n) => ({ n, street: (n.address || "").split(",")[0].trim() }))
        .filter((x) => x.street);
      const orExpr = cand.map((x) => `address.ilike."${x.street.replace(/"/g, "")}"`).join(",");
      const dups = cand.length
        ? await sbGet(`canvass_prospects?or=${encodeURIComponent(`(${orExpr})`)}&select=id,address,extra&limit=200`)
        : [];
      const taken = new Set(dups.map((d) => String(d.address || "").toUpperCase().trim()));
      // A door that ALREADY has a pin still COUNTS as part of the cloverleaf —
      // but keeps its own status + color (per Neal: an IQ door must stay IQ so a
      // Jr rep doesn't pitch inspection where they're already retail-interested).
      // Tag it clover_zone_jnid (NOT clover_jnid — that key would make cleanup
      // delete it when the install wraps).
      for (const d of dups.slice(0, 25)) {
        const ex = (d.extra && typeof d.extra === "object") ? d.extra : {};
        if (ex.clover_zone_jnid || ex.clover_jnid || ex.blitz_jnid) { report.existing_counted += 1; continue; }
        const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${d.id}`, {
          method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ extra: { ...ex, clover_zone_jnid: jnid, clover_zone_install: addr } }),
        });
        if (r.ok) report.existing_counted += 1;
      }
      const rows = [];
      for (const { n, street } of cand) {
        if (taken.has(street.toUpperCase().trim())) continue; // counted above, keeps its own pin
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
            ...(sellerName ? { sold_by: sellerName, sold_by_jn: sellerId } : {}),
          },
        });
      }
      // ONE 🚧 pin at the install itself — "the crew is on THAT roof right there"
      // (Neal: "it should highlight where the install is").
      rows.push({
        name: "🚧 Roof being installed",
        address: j.address_line1, city: j.city || null, state: "FL", zip: j.zip || null,
        latitude: geo.lat, longitude: geo.lng, geocode_status: "ok",
        status: "install_home", status_by: "Clover leaf", status_updated_at: nowIso,
        list_name: LIST_NAME,
        extra: { clover_jnid: jnid, install_home: true, install_address: addr, synced_at: nowIso, ...(sellerName ? { sold_by: sellerName, sold_by_jn: sellerId } : {}) },
      });
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

  // 3b. Backfill the 🚧 install-home marker for installs clovered BEFORE this
  //     feature existed. (New installs get theirs in the loop above; those jnids
  //     aren't in cloveredJnids yet, so this can't double-create them.)
  if (commit) {
    try {
      const haveHome = new Set();
      for (const p of existingClover) {
        if (p.status !== "install_home") continue;
        const bj = p.extra && (p.extra.clover_jnid || p.extra.blitz_jnid);
        if (bj) haveHome.add(bj);
      }
      const homeRows = [];
      const nowIso = new Date().toISOString();
      for (const j of jobs) {
        const jnid = jnidOf(j);
        if (!cloveredJnids.has(jnid) || haveHome.has(jnid) || !j.address_line1) continue;
        if (homeRows.length >= 10) break; // plenty per run; cron catches the rest
        const addr = [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", ");
        const geo = (Number(j.geo && j.geo.lat) && Number(j.geo && j.geo.lon))
          ? { lat: Number(j.geo.lat), lng: Number(j.geo.lon) }
          : await geocode(addr);
        if (!geo) continue;
        const sellerName = String(j.sales_rep_name || "").trim() || null;
        homeRows.push({
          name: "🚧 Roof being installed",
          address: j.address_line1, city: j.city || null, state: "FL", zip: j.zip || null,
          latitude: geo.lat, longitude: geo.lng, geocode_status: "ok",
          status: "install_home", status_by: "Clover leaf", status_updated_at: nowIso,
          list_name: LIST_NAME,
          extra: { clover_jnid: jnid, install_home: true, install_address: addr, synced_at: nowIso, ...(sellerName ? { sold_by: sellerName, sold_by_jn: j.sales_rep || null } : {}) },
        });
      }
      if (homeRows.length) {
        const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects`, {
          method: "POST", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(homeRows),
        });
        if (r.ok) report.install_homes_backfilled = homeRows.length;
      }
    } catch { /* best-effort */ }
  }

  // 4. Cleanup when an install WRAPS: the job left "Roof Started" (proof = we saw
  //    it in a recent any-status pull) → delete that install's clover pins EXCEPT
  //    the keepers: Damage observed stays forever; live deal states are left alone.
  if (commit) {
    const KEEP_STATUSES = new Set(["damage_observed", "appt", "insp_sold", "insp_callback", "insp_pending"]);
    try {
      const liveJnids = new Set(jobs.map(jnidOf));
      // Only fetch the (expensive) recent-jobs proof when there are actual
      // candidates: non-keeper clover pins whose install isn't Roof Started now.
      const candidates = existingClover.filter((p) => {
        if (KEEP_STATUSES.has(p.status)) return false;
        const bj = p.extra && (p.extra.clover_jnid || p.extra.blitz_jnid);
        return bj && !liveJnids.has(bj);
      });
      const recent = candidates.length ? await fetchRecentJobs(Math.floor(Date.now() / 1000) - 45 * 86400) : [];
      const seen = new Set([...jobs, ...recent].map(jnidOf));
      const stale = [];
      for (const p of candidates) {
        const bj = p.extra && (p.extra.clover_jnid || p.extra.blitz_jnid);
        if (seen.has(bj)) stale.push(p.id); // proof the install moved on → clear the leftovers
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
  if (commit && existingClover.some((p) => p.extra && p.extra.claimed_by)) {
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

  if (commit) await releaseLock();
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
// ── Sync lock (app_settings.clover_sync_lock = ISO timestamp of the running sync).
// ISO strings compare lexicographically, so PostgREST's value=lt.<cutoff> is an
// atomic "steal only if stale" — two racers can't both win the PATCH.
async function acquireLock() {
  const nowIso = new Date().toISOString();
  const cutoff = new Date(Date.now() - LOCK_MS).toISOString();
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.clover_sync_lock&value=lt.${encodeURIComponent(cutoff)}`, {
      method: "PATCH", headers: { ...sbHeaders, Prefer: "return=representation" }, body: JSON.stringify({ value: nowIso }),
    });
    const rows = r.ok ? await r.json().catch(() => []) : [];
    if (rows.length) return true;          // stale (or released) lock stolen — we own it
    const cur = await readSetting("clover_sync_lock");
    if (cur && cur >= cutoff) return false; // someone else is mid-run
    if (!cur) {                             // first ever run — create the row
      const c = await fetch(`${SB_URL}/rest/v1/app_settings`, {
        method: "POST", headers: { ...sbHeaders, Prefer: "return=minimal" },
        body: JSON.stringify({ key: "clover_sync_lock", value: nowIso }),
      });
      return c.ok;
    }
    return false;
  } catch { return true; } // never let a lock hiccup block the cron entirely
}
async function releaseLock() {
  try {
    await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.clover_sync_lock`, {
      method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ value: "1970-01-01T00:00:00.000Z" }),
    });
  } catch { /* it expires on its own in LOCK_MS anyway */ }
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
