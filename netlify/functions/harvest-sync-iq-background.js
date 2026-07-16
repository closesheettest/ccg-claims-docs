// netlify/functions/harvest-sync-iq-background.js
//
// Sync "Instant Quote" JobNimbus contacts that have NO job onto the Harvesting
// Map as IQ pins (senior-visible), per the office's JN Sync filters
// (app_settings.harvest_jn_filters.iq: { enabled, created_before }).
//
// Background (up to 15 min) because there are thousands. Uses the contact's own
// JN geo coordinates when present (free); only Google-geocodes the few without,
// bounded per run + cached. Date-shards past JN's 10k pagination cap. Reconciles
// away pins whose contact has since gotten a job / falls outside the cutoff.
//
//   Trigger: POST/GET /.netlify/functions/harvest-sync-iq-background → 202
//   Read:    supabase app_settings?key=eq.harvest_iq_sync
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//      GOOGLE_MAPS_API_KEY (or VITE_GOOGLE_PLACES_API_KEY)

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_PLACES_API_KEY;
const GOOGLE_GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";
const RESULT_KEY = "harvest_iq_sync";
const GEOCACHE_KEY = "iq_pin_geocache";  // contact jnid -> {lat,lng}
const LIST_NAME = "JN Instant Quote";
const SOURCE = "Instant Quote";
const CAP = 9500, START = 1451606400;    // 10k-cap split threshold / 2016-01-01
const GEO_BUDGET = 400;                   // max NEW Google geocodes per run

exports.handler = async () => {
  const started = new Date().toISOString();
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const NOW = Math.floor(Date.now() / 1000);
  try {
    const filters = (await readSetting("harvest_jn_filters")) || {};
    const iq = filters.iq || {};
    const enabled = iq.enabled === true;
    const beforeSec = iq.created_before ? Math.floor(Date.parse(`${iq.created_before}T23:59:59-04:00`) / 1000) : NOW;

    // Existing JN-sourced IQ pins, keyed by the contact id we stored in extra.
    const existing = {};
    for (const p of await sbGetAll(`canvass_prospects?list_name=eq.${encodeURIComponent(LIST_NAME)}&status=eq.iq&select=id,extra`)) {
      const cid = p.extra && p.extra.jn_contact_id;
      if (cid) existing[cid] = p.id;
    }

    if (!enabled) {
      // Turned off → clear the whole layer.
      const ids = Object.values(existing);
      let removed = 0;
      if (ids.length) { const r = await del(ids); if (r) removed = ids.length; }
      await writeSetting(RESULT_KEY, { ok: true, enabled: false, inserted: 0, updated: 0, removed, candidates: 0, started, finished: new Date().toISOString() });
      return { statusCode: 202, body: "" };
    }

    // Which contacts already own a job (so we can exclude them).
    const withJob = new Set();
    await sharded(`${JN_BASE}/jobs`, H, [], NOW, (job) => {
      if (job.primary && job.primary.id) withJob.add(job.primary.id);
      for (const r of job.related || []) if (r && r.id && (r.type === "contact" || !r.type)) withJob.add(r.id);
    });

    // Instant-Quote contacts, created on/before the cutoff, that have no job.
    const cands = [];
    await sharded(`${JN_BASE}/contacts`, H, [{ match_phrase: { source_name: SOURCE } }], beforeSec, (c) => {
      const id = c.jnid || c.id;
      if (!id || withJob.has(id)) return;
      const street = (c.address_line1 || "").split(",")[0].trim();
      if (!street) return; // no address → can't place it
      cands.push(c);
    });

    // Geocode: prefer the contact's own JN geo; Google-geocode the rest (bounded).
    const geocache = (await readSetting(GEOCACHE_KEY)) || {};
    const coordOf = (c) => {
      const g = c.geo || {};
      const lat = num(g.lat != null ? g.lat : g.latitude), lng = num(g.lon != null ? g.lon : (g.lng != null ? g.lng : g.longitude));
      if (lat != null && lng != null && (lat || lng)) return { lat, lng };
      return geocache[c.jnid || c.id] || null;
    };
    const need = cands.filter((c) => !coordOf(c)).slice(0, GOOGLE_KEY ? GEO_BUDGET : 0);
    let geocoded = 0;
    for (let i = 0; i < need.length; i += 10) {
      const chunk = need.slice(i, i + 10);
      const res = await Promise.all(chunk.map((c) => geocode([c.address_line1, c.city, c.state_text, c.zip].filter(Boolean).join(", "))));
      chunk.forEach((c, idx) => { const g = res[idx]; if (g) { geocache[c.jnid || c.id] = g; geocoded++; } });
    }
    if (need.length) await writeSetting(GEOCACHE_KEY, geocache);

    // Upsert.
    const nowIso = new Date().toISOString();
    const shouldBe = new Set();
    const toInsert = [];
    const updates = [];
    let skipped = 0;
    for (const c of cands) {
      const id = c.jnid || c.id;
      const coord = coordOf(c);
      shouldBe.add(id);
      if (!coord) { skipped++; continue; } // not geocoded yet — next run
      const street = (c.address_line1 || "").split(",")[0].trim();
      const row = {
        name: c.display_name || `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Homeowner",
        address: street, city: c.city || null, state: c.state_text || null, zip: c.zip || null,
        phone: (c.mobile_phone || c.home_phone || c.work_phone || "").trim() || null,
        email: (c.email || "").trim() || null,
        latitude: coord.lat, longitude: coord.lng, geocode_status: "ok",
        status: "iq", status_by: "JN IQ sync", status_updated_at: nowIso, list_name: LIST_NAME,
        extra: { jn_contact_id: id, jn_source: SOURCE, jn_created_sec: Number(c.date_created) || null, synced_at: nowIso },
      };
      if (existing[id]) {
        updates.push(fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${existing[id]}`, {
          method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(row),
        }).then((r) => r.ok));
      } else {
        toInsert.push(row);
      }
    }
    const updated = (await Promise.all(updates)).filter(Boolean).length;
    let inserted = 0;
    for (let i = 0; i < toInsert.length; i += 500) {
      const batch = toInsert.slice(i, i + 500);
      const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects`, { method: "POST", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(batch) });
      if (r.ok) inserted += batch.length;
    }

    // Reconcile: drop pins whose contact no longer qualifies (got a job / outside cutoff).
    const stale = Object.entries(existing).filter(([cid]) => !shouldBe.has(cid)).map(([, id]) => id);
    let removed = 0;
    if (stale.length) { const r = await del(stale); if (r) removed = stale.length; }

    await writeSetting(RESULT_KEY, {
      ok: true, enabled: true, created_on_or_before: iq.created_before || null,
      candidates: cands.length, inserted, updated, removed,
      geocoded, from_jn_geo: cands.length - Object.keys(geocache).length, skipped_ungeocoded: skipped,
      started, finished: new Date().toISOString(),
    });
  } catch (e) {
    await writeSetting(RESULT_KEY, { ok: false, error: String(e && e.message || e), started, finished: new Date().toISOString() });
  }
  return { statusCode: 202, body: "" };
};

// ── helpers ──────────────────────────────────────────────────────────────────
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && Math.abs(n) <= 180 ? n : null; };
async function del(ids) {
  try {
    let ok = true;
    for (let i = 0; i < ids.length; i += 200) {
      const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects?id=in.(${ids.slice(i, i + 200).join(",")})`, { method: "DELETE", headers: { ...sbHeaders, Prefer: "return=minimal" } });
      ok = ok && r.ok;
    }
    return ok;
  } catch { return false; }
}
async function sbGetAll(path) {
  const out = [];
  for (let from = 0; from < 100000; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { ...sbHeaders, "Range-Unit": "items", Range: `${from}-${from + 999}` } });
    if (!r.ok) break;
    const b = await r.json().catch(() => []);
    if (!Array.isArray(b) || !b.length) break;
    out.push(...b);
    if (b.length < 1000) break;
  }
  return out;
}
async function sharded(base, headers, must, upper, onRow) {
  const filterFor = (gte, lte) => encodeURIComponent(JSON.stringify({ must: [...must, { range: { date_created: { gte, lte } } }] }));
  const countOf = async (gte, lte) => { const r = await fetch(`${base}?size=1&filter=${filterFor(gte, lte)}`, { headers }); const d = await r.json().catch(() => ({})); return Number(d.count || 0); };
  const drain = async (gte, lte) => {
    for (let page = 0; page < 100; page++) {
      const r = await fetch(`${base}?size=100&from=${page * 100}&filter=${filterFor(gte, lte)}`, { headers });
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const rows = d.results || d.contacts || d.jobs || [];
      if (!rows.length) break;
      rows.forEach(onRow);
      if (rows.length < 100) break;
    }
  };
  const rec = async (gte, lte) => {
    const c = await countOf(gte, lte);
    if (!c) return;
    if (c <= CAP || (lte - gte) <= 86400) { await drain(gte, lte); return; }
    const mid = Math.floor((gte + lte) / 2);
    await rec(gte, mid); await rec(mid + 1, lte);
  };
  await rec(START, upper);
}
async function geocode(addr) {
  if (!GOOGLE_KEY || !addr) return null;
  try {
    const r = await fetch(`${GOOGLE_GEOCODE}?address=${encodeURIComponent(addr)}&region=us&key=${GOOGLE_KEY}`);
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    const loc = d.results && d.results[0] && d.results[0].geometry && d.results[0].geometry.location;
    return loc && typeof loc.lat === "number" ? { lat: loc.lat, lng: loc.lng } : null;
  } catch { return null; }
}
async function readSetting(key) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sbHeaders });
    if (!r.ok) return null;
    const rows = await r.json().catch(() => []);
    const v = rows?.[0]?.value;
    return v ? (typeof v === "string" ? JSON.parse(v) : v) : null;
  } catch { return null; }
}
async function writeSetting(key, obj) {
  try {
    await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
      method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }),
    });
  } catch { /* ignore */ }
}
