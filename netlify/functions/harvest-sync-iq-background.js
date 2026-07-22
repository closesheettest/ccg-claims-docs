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
  // Which contacts already own a job (built once, shared). We ALSO capture the
  // job's status so a mapped lead that progressed (appt booked, sold, …) gets its
  // map pin RESTATUSED from the job — the reverse sync — instead of just dropping
  // off. jobStatusByContact keeps the "heaviest" status when a contact has several.
  const withJob = new Set();
  const jobStatusByContact = {};   // jn_contact_id -> mapped pin status (from its job)
  const jobByAddr = {};            // streetKey -> { st, zip } — heaviest job status at an ADDRESS
  const noteJob = (cid, name) => {
    if (!cid) return;
    withJob.add(cid);
    const st = jobPinStatus(name);
    if (!st) return;
    const cur = jobStatusByContact[cid];
    if (!cur || (PIN_RANK[st] || 0) > (PIN_RANK[cur] || 0)) jobStatusByContact[cid] = st;
  };
  if (anyEnabled) {
    await sharded(`${JN_BASE}/jobs`, H, [], START, NOW, (job) => {
      const name = job.status_name;
      if (job.primary && job.primary.id) noteJob(job.primary.id, name);
      for (const r of job.related || []) if (r && r.id && (r.type === "contact" || !r.type)) noteJob(r.id, name);
      // ADDRESS index: a JN job at an address (any contact/name) can restatus the
      // pin there — catches manually-created deals + contact/name mismatches that
      // the contact match above can't see (e.g. "Bart Natali" vs "Bartolomeo Natoli").
      const sk = streetKey(job.address_line1);
      if (sk) {
        const st = jobPinStatus(name);
        if (st) { const cur = jobByAddr[sk]; if (!cur || (PIN_RANK[st] || 0) > (PIN_RANK[cur.st] || 0)) jobByAddr[sk] = { st, zip: zip5(job.zip) }; }
      }
    });
  }
  const geocache = (await readSetting(GEOCACHE_KEY)) || {};
  let geocacheDirty = false;

  // Global address index — every pin on the map, keyed by normalized street, so no
  // source ever drops a SECOND pin on a house another source already pinned (the
  // RepCard-vs-JN-IQ duplicate bug). Per house we remember the heaviest occupant:
  //   workedId (appt/sold/NI/…) → a new lead is SKIPPED (worked owns the house)
  //   rawId (another raw JN lead) → SKIPPED (dedupe)
  //   inspId (an unworked RepCard "insp") → the incoming IQ CONVERTS it in place
  //                                          (your "IQ beats inspection-needed")
  const streetIdx = new Map();    // streetKey -> [{ id, status, zip, status_by, status_updated_at }]
  const claimedKeys = new Set();  // "street|zip" handled this run (converted or freshly inserted)
  try {
    for (const p of await sbGetAll(`canvass_prospects?latitude=not.is.null&select=id,address,status,zip,status_by,status_updated_at`)) {
      const sk = streetKey(p.address); if (!sk) continue;
      let arr = streetIdx.get(sk); if (!arr) { arr = []; streetIdx.set(sk, arr); }
      arr.push({ id: p.id, status: p.status, zip: zip5(p.zip), status_by: p.status_by, status_updated_at: p.status_updated_at });
    }
  } catch { /* if the index can't load, fall back to contact-only dedup (no crash) */ }

  for (const key of keys) {
    const def = SOURCES[key];
    const cfg = filters[key] || {};
    const started = new Date().toISOString();
    try {
      // Load EVERY pin for this list and split by status: RAW (still the
      // source's status, e.g. "iq") vs WORKED (a rep/RepCard set a terminal or
      // appt status). The map is the source of truth for worked pins — this sync
      // must never overwrite one back to raw, nor re-insert a duplicate for it.
      // Keying "existing" only on status=iq before was the duplicate bug.
      const existingRaw = {};             // jn_contact_id -> pin id (still raw source status)
      const workedContacts = new Set();   // jn_contact_id whose pin is already worked (leave alone)
      const pinByContact = {};            // jn_contact_id -> { id, status } (any status; for reverse sync)
      for (const p of await sbGetAll(`canvass_prospects?list_name=eq.${encodeURIComponent(def.list)}&select=id,extra,status`)) {
        const cid = p.extra && p.extra.jn_contact_id;
        if (!cid) continue;
        pinByContact[cid] = { id: p.id, status: p.status };
        if (p.status === def.status) existingRaw[cid] = p.id;
        else workedContacts.add(cid);
      }

      if (cfg.enabled !== true) {
        const ids = Object.values(existingRaw);
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
      const toInsert = []; const updates = []; let skipped = 0, preserved = 0, dupSkipped = 0, converted = 0;
      for (const c of cands) {
        const id = c.jnid || c.id;
        // Already worked on the map (rep/RepCard set a terminal/appt status) →
        // the map owns it. Don't re-add it as a fresh raw lead (the dup bug) and
        // don't let its raw twin, if any, survive reconcile below.
        if (workedContacts.has(id)) { preserved++; continue; }
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
        if (existingRaw[id]) {
          updates.push(fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${existingRaw[id]}`, { method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(row) }).then((r) => r.ok));
        } else {
          // ── Address dedup before creating a NEW pin ─────────────────────────
          const sk = streetKey(c.address_line1);
          if (sk) {
            const cz = zip5(c.zip);
            const ck = sk + "|" + cz;
            if (claimedKeys.has(ck)) { dupSkipped++; continue; }   // already handled this house this run
            // Same street; zips must agree when BOTH are present (so a missing zip
            // still matches — that's the ~90m-drift case — but different cities don't).
            const here = (streetIdx.get(sk) || []).filter((p) => !cz || !p.zip || p.zip === cz);
            const worked = here.find((p) => !RAW_SET.has(p.status));
            const rawTwin = here.find((p) => p.status !== "insp"); // another raw JN lead already here
            const insp = here.find((p) => p.status === "insp");
            if (worked || rawTwin) { dupSkipped++; continue; }     // a worked/raw pin already owns this house
            if (insp) {                                            // RepCard "insp" here → IQ takes over the pin (no dup)
              claimedKeys.add(ck);
              updates.push(fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${insp.id}`, { method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(row) }).then((r) => r.ok));
              converted++;
              continue;
            }
            claimedKeys.add(ck);   // claim the house for the pin we're about to insert
          }
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
      // REVERSE SYNC: a mapped lead that gained a job → set its pin to the job's
      // status (appt / insp_sold / new_roof / no_sit / lost / iq_ni). Overrides raw
      // AND worked pins — a real JobNimbus job is the heaviest authority.
      const rev = [];
      for (const [cid, target] of Object.entries(jobStatusByContact)) {
        const pin = pinByContact[cid];
        if (!pin || pin.status === target) continue;
        rev.push(fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${pin.id}`, {
          method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ status: target, status_by: "JN job status", status_updated_at: nowIso }),
        }).then((r) => r.ok));
      }
      const restatused = (await Promise.all(rev)).filter(Boolean).length;

      // Reconcile only RAW pins (worked pins are never auto-removed — the map owns
      // them). A raw pin whose contact gained a job is left to the reverse sync
      // above (restatused, not deleted), so exclude jobStatusByContact here.
      const stale = Object.entries(existingRaw).filter(([cid]) => !shouldBe.has(cid) && !jobStatusByContact[cid]).map(([, id]) => id);
      let removed = 0; if (stale.length) { if (await del(stale)) removed = stale.length; }

      await writeSetting(`harvest_leadsync_${key}`, {
        ok: true, enabled: true, source: def.source, created_on_or_after: cfg.created_after || null,
        candidates: cands.length, inserted, updated, removed, preserved_worked: preserved, restatused_from_job: restatused, geocoded, skipped_ungeocoded: skipped, dup_skipped: dupSkipped, converted_from_insp: converted,
        started, finished: new Date().toISOString(),
      });
    } catch (e) {
      await writeSetting(`harvest_leadsync_${key}`, { ok: false, source: def.source, error: String(e && e.message || e), started, finished: new Date().toISOString() });
    }
  }

  // ── ADDRESS-BASED REVERSE SYNC ─────────────────────────────────────────────
  // A JN job at a pin's ADDRESS overrides the pin's status when the job is heavier
  // (an appointment/sold beats a raw lead or a stale "not interested"). This is the
  // net that catches deals created manually in JobNimbus and same-house/different-
  // contact name mismatches — which the contact-based sync above cannot reach.
  try {
    const addrRev = [];
    let addrRestatused = 0;
    const nowIso = new Date().toISOString();
    // A REP's fresh field call wins over an address-match guess (Neal): if a human rep
    // statused this door in the last 7 days, leave it — don't let a (possibly stale or
    // same-street-different-house) JN job overwrite it (the Rayner Carballo case: Sam
    // marked it dead, the old no-sit appt at the address flipped it back to "appt").
    // Sync-set statuses (status_by "JN …") and anything older stay eligible for override.
    const REP_PROTECT_MS = 7 * 24 * 60 * 60 * 1000;
    const repProtected = (p) => {
      const by = String(p.status_by || "");
      if (!by || /^JN\b/i.test(by)) return false;             // sync-set or unknown → not a rep
      const t = Date.parse(p.status_updated_at || "");
      return Number.isFinite(t) && (Date.now() - t) < REP_PROTECT_MS;
    };
    for (const [sk, arr] of streetIdx) {
      const job = jobByAddr[sk]; if (!job) continue;
      const tgtRank = PIN_RANK[job.st] || 0;
      for (const p of arr) {
        if (p.status === job.st) continue;
        if (repProtected(p)) continue;                                // rep worked it recently → their call sticks
        if ((PIN_RANK[p.status] || 0) >= tgtRank) continue;           // don't downgrade a heavier pin
        if (job.zip && p.zip && job.zip !== p.zip) continue;          // same street, different city → skip
        addrRev.push(fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${p.id}`, {
          method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ status: job.st, status_by: "JN job (address match)", status_updated_at: nowIso }),
        }).then((r) => r.ok));
      }
    }
    addrRestatused = (await Promise.all(addrRev)).filter(Boolean).length;
    await writeSetting("harvest_addr_reverse_sync", { ok: true, restatused: addrRestatused, jobs_by_addr: Object.keys(jobByAddr).length, finished: nowIso });
  } catch (e) { console.warn("address reverse sync failed (non-fatal):", e.message); }

  if (geocacheDirty) await writeSetting(GEOCACHE_KEY, geocache);
  return { statusCode: 202, body: "" };
};

// ── helpers ──────────────────────────────────────────────────────────────────
// Map a JobNimbus JOB status_name → the map pin status (reverse sync). null = leave
// the pin alone (e.g. a bare "Lead" job with no meaningful stage yet).
const PIN_RANK = { insp_sold: 6, new_roof: 5, appt: 4, retail: 4, no_sit_reschedule: 3, dead: 2, lost: 2, iq_ni: 1, insp_ni: 1 };
function jobPinStatus(name) {
  const s = String(name || "").toLowerCase();
  if (!s) return null;
  // SOLD splits by path: a roof-INSPECTION sale (Sit Sold Insp / Sit Sold PA) →
  // insp_sold. A RETAIL sale (Sit - Sold, Signed Contract, …) → appt — it's an
  // active deal, and the install-pin sync converts it to an installed pin once
  // the roof is on, so we don't terminal-ize it as an inspection sold.
  if (s.includes("sold") || s.includes("signed")) return (s.includes("insp") || /\bpa\b/.test(s)) ? "insp_sold" : "appt";
  if (s.includes("new roof")) return "new_roof";
  if (s.includes("refused")) return "iq_ni";                                // "Refused Appointment" — before the appt check
  if (s.includes("no sit") || s.includes("no show") || s.includes("reschedul")) return "no_sit_reschedule";
  if (s.includes("appointment") || s.includes("pending")) return "appt";    // Appointment Scheduled, Sit - Pending
  if (s.includes("lost") || s.includes("no sale") || s === "dq" || s.includes("disqualif")) return "lost";
  if (s.includes("btr") || s.includes("stale") || s.includes("credit denial") || s.includes("no info") || s.includes("no response")) return "iq_ni";
  return null;
}
// Unworked "lead" statuses — a pin in one of these is still fair game. Anything
// else (appt / insp_sold / iq_ni / dead / lost / …) is WORKED and owns its house.
const RAW_SET = new Set(["iq", "fb", "ai", "insp", "no_sit_reschedule"]);
// Normalized street key so the same house collapses across sources despite
// geocode drift + spelling ("12735 NEWTON PL" == "12735 Newton Place").
const ADDR_SUF = { street: "st", st: "st", avenue: "ave", ave: "ave", av: "ave", place: "pl", pl: "pl", drive: "dr", dr: "dr", lane: "ln", ln: "ln", court: "ct", ct: "ct", terrace: "ter", terr: "ter", ter: "ter", boulevard: "blvd", blvd: "blvd", road: "rd", rd: "rd", circle: "cir", cir: "cir", trail: "trl", trl: "trl", parkway: "pkwy", pkwy: "pkwy", highway: "hwy", hwy: "hwy", cove: "cv", cv: "cv", point: "pt", pt: "pt", square: "sq", sq: "sq" };
const ADDR_DIR = { north: "n", n: "n", south: "s", s: "s", east: "e", e: "e", west: "w", w: "w", northeast: "ne", ne: "ne", northwest: "nw", nw: "nw", southeast: "se", se: "se", southwest: "sw", sw: "sw" };
function streetKey(address) {
  const s = String(address || "").split(",")[0].toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || !/^\d/.test(s)) return null;
  return s.split(" ").map((t) => ADDR_SUF[t] || ADDR_DIR[t] || t).join(" ");
}
function zip5(z) { return String(z || "").replace(/\D/g, "").slice(0, 5); }
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && Math.abs(n) <= 180 ? n : null; };
async function del(ids) {
  try { let ok = true; for (let i = 0; i < ids.length; i += 200) { const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects?id=in.(${ids.slice(i, i + 200).join(",")})`, { method: "DELETE", headers: { ...sbHeaders, Prefer: "return=minimal" } }); ok = ok && r.ok; } return ok; } catch { return false; }
}
async function sbGetAll(path) {
  const out = [];
  for (let from = 0; from < 400000; from += 1000) {
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
