// netlify/functions/harvest-sync-iq-background.js
//
// Sync inbound-lead JobNimbus contacts that have NO job onto the Harvesting Map,
// per the office's JN Sync filters (app_settings.harvest_jn_filters):
//   iq → "Instant Quote" → IQ pins   ·   fb → "Facebook" → FB pins
//   ai → "AI Bot"       → AI pins
// Each: { enabled, created_before }. Same rule for all three.
//
// Background (up to 15 min) — thousands of contacts. Uses the contact's own JN
// geo when present (free); Google-geocodes the rest (bounded + cached). Date-
// shards past JN's 10k pagination cap. Reconciles away pins whose contact got a
// job / fell outside the cutoff / whose source was turned off.
//
//   Trigger: POST/GET /.netlify/functions/harvest-sync-iq-background[?source=iq|fb|ai]
//            (no source → all three). Result per source → app_settings.harvest_leadsync_<key>
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//      GOOGLE_MAPS_API_KEY (or VITE_GOOGLE_PLACES_API_KEY)

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_PLACES_API_KEY;
const GOOGLE_GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";
const GEOCACHE_KEY = "iq_pin_geocache";   // shared contact-jnid -> {lat,lng} cache
const CAP = 9500, START = 1451606400;
const GEO_BUDGET = 400;

const SOURCES = {
  iq: { source: "Instant Quote", status: "iq", list: "JN Instant Quote" },
  fb: { source: "Facebook",      status: "fb", list: "JN Facebook" },
  ai: { source: "AI Bot",        status: "ai", list: "JN AI Bot" },
};

exports.handler = async (event) => {
  const H = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const NOW = Math.floor(Date.now() / 1000);
  const qp = (event && event.queryStringParameters) || {};
  const keys = qp.source && SOURCES[qp.source] ? [qp.source] : Object.keys(SOURCES);
  const filters = (await readSetting("harvest_jn_filters")) || {};

  const anyEnabled = keys.some((k) => (filters[k] || {}).enabled === true);
  // Which contacts already own a job (built once, shared) — only if we need it.
  const withJob = new Set();
  if (anyEnabled) {
    await sharded(`${JN_BASE}/jobs`, H, [], START, NOW, (job) => {
      if (job.primary && job.primary.id) withJob.add(job.primary.id);
      for (const r of job.related || []) if (r && r.id && (r.type === "contact" || !r.type)) withJob.add(r.id);
    });
  }
  const geocache = (await readSetting(GEOCACHE_KEY)) || {};
  let geocacheDirty = false;

  for (const key of keys) {
    const def = SOURCES[key];
    const cfg = filters[key] || {};
    const started = new Date().toISOString();
    try {
      const existing = {};
      for (const p of await sbGetAll(`canvass_prospects?list_name=eq.${encodeURIComponent(def.list)}&status=eq.${def.status}&select=id,extra`)) {
        const cid = p.extra && p.extra.jn_contact_id;
        if (cid) existing[cid] = p.id;
      }

      if (cfg.enabled !== true) {
        const ids = Object.values(existing);
        let removed = 0; if (ids.length) { if (await del(ids)) removed = ids.length; }
        await writeSetting(`harvest_leadsync_${key}`, { ok: true, enabled: false, source: def.source, inserted: 0, updated: 0, removed, candidates: 0, started, finished: new Date().toISOString() });
        continue;
      }

      // Filter is "created ON OR AFTER" — newer leads (older ones tend to have
      // already gone with a competitor / gotten a new roof).
      const afterSec = cfg.created_after ? Math.floor(Date.parse(`${cfg.created_after}T00:00:00-04:00`) / 1000) : START;
      const cands = [];
      await sharded(`${JN_BASE}/contacts`, H, [{ match_phrase: { source_name: def.source } }], afterSec, NOW, (c) => {
        const id = c.jnid || c.id;
        if (!id || withJob.has(id)) return;
        if (!(c.address_line1 || "").trim()) return;
        cands.push(c);
      });

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
        chunk.forEach((c, idx) => { const g = res[idx]; if (g) { geocache[c.jnid || c.id] = g; geocoded++; geocacheDirty = true; } });
      }

      const nowIso = new Date().toISOString();
      const shouldBe = new Set();
      const toInsert = []; const updates = []; let skipped = 0;
      for (const c of cands) {
        const id = c.jnid || c.id;
        const coord = coordOf(c);
        shouldBe.add(id);
        if (!coord) { skipped++; continue; }
        const street = (c.address_line1 || "").split(",")[0].trim();
        const row = {
          name: c.display_name || `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Homeowner",
          address: street, city: c.city || null, state: c.state_text || null, zip: c.zip || null,
          phone: (c.mobile_phone || c.home_phone || c.work_phone || "").trim() || null,
          email: (c.email || "").trim() || null,
          latitude: coord.lat, longitude: coord.lng, geocode_status: "ok",
          status: def.status, status_by: `JN ${def.source} sync`, status_updated_at: nowIso, list_name: def.list,
          extra: { jn_contact_id: id, jn_source: def.source, jn_created_sec: Number(c.date_created) || null, synced_at: nowIso },
        };
        if (existing[id]) {
          updates.push(fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${existing[id]}`, { method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(row) }).then((r) => r.ok));
        } else { toInsert.push(row); }
      }
      const updated = (await Promise.all(updates)).filter(Boolean).length;
      let inserted = 0;
      for (let i = 0; i < toInsert.length; i += 500) {
        const batch = toInsert.slice(i, i + 500);
        const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects`, { method: "POST", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(batch) });
        if (r.ok) inserted += batch.length;
      }
      const stale = Object.entries(existing).filter(([cid]) => !shouldBe.has(cid)).map(([, id]) => id);
      let removed = 0; if (stale.length) { if (await del(stale)) removed = stale.length; }

      await writeSetting(`harvest_leadsync_${key}`, {
        ok: true, enabled: true, source: def.source, created_on_or_after: cfg.created_after || null,
        candidates: cands.length, inserted, updated, removed, geocoded, skipped_ungeocoded: skipped,
        started, finished: new Date().toISOString(),
      });
    } catch (e) {
      await writeSetting(`harvest_leadsync_${key}`, { ok: false, source: def.source, error: String(e && e.message || e), started, finished: new Date().toISOString() });
    }
  }
  if (geocacheDirty) await writeSetting(GEOCACHE_KEY, geocache);
  return { statusCode: 202, body: "" };
};

// ── helpers ──────────────────────────────────────────────────────────────────
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && Math.abs(n) <= 180 ? n : null; };
async function del(ids) {
  try { let ok = true; for (let i = 0; i < ids.length; i += 200) { const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects?id=in.(${ids.slice(i, i + 200).join(",")})`, { method: "DELETE", headers: { ...sbHeaders, Prefer: "return=minimal" } }); ok = ok && r.ok; } return ok; } catch { return false; }
}
async function sbGetAll(path) {
  const out = [];
  for (let from = 0; from < 100000; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { ...sbHeaders, "Range-Unit": "items", Range: `${from}-${from + 999}` } });
    if (!r.ok) break; const b = await r.json().catch(() => []); if (!Array.isArray(b) || !b.length) break; out.push(...b); if (b.length < 1000) break;
  }
  return out;
}
async function sharded(base, headers, must, lo, hi, onRow) {
  const filterFor = (gte, lte) => encodeURIComponent(JSON.stringify({ must: [...must, { range: { date_created: { gte, lte } } }] }));
  const countOf = async (gte, lte) => { const r = await fetch(`${base}?size=1&filter=${filterFor(gte, lte)}`, { headers }); const d = await r.json().catch(() => ({})); return Number(d.count || 0); };
  const drain = async (gte, lte) => {
    for (let page = 0; page < 100; page++) { const r = await fetch(`${base}?size=100&from=${page * 100}&filter=${filterFor(gte, lte)}`, { headers }); if (!r.ok) break; const d = await r.json().catch(() => ({})); const rows = d.results || d.contacts || d.jobs || []; if (!rows.length) break; rows.forEach(onRow); if (rows.length < 100) break; }
  };
  const rec = async (gte, lte) => { const c = await countOf(gte, lte); if (!c) return; if (c <= CAP || (lte - gte) <= 86400) { await drain(gte, lte); return; } const mid = Math.floor((gte + lte) / 2); await rec(gte, mid); await rec(mid + 1, lte); };
  await rec(lo, hi);
}
async function geocode(addr) {
  if (!GOOGLE_KEY || !addr) return null;
  try { const r = await fetch(`${GOOGLE_GEOCODE}?address=${encodeURIComponent(addr)}&region=us&key=${GOOGLE_KEY}`); if (!r.ok) return null; const d = await r.json().catch(() => ({})); const loc = d.results && d.results[0] && d.results[0].geometry && d.results[0].geometry.location; return loc && typeof loc.lat === "number" ? { lat: loc.lat, lng: loc.lng } : null; } catch { return null; }
}
async function readSetting(key) {
  try { const r = await fetch(`${SB_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, { headers: sbHeaders }); if (!r.ok) return null; const rows = await r.json().catch(() => []); const v = rows?.[0]?.value; return v ? (typeof v === "string" ? JSON.parse(v) : v) : null; } catch { return null; }
}
async function writeSetting(key, obj) {
  try { await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, { method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }) }); } catch { /* ignore */ }
}
