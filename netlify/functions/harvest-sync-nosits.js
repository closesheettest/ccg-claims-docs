// netlify/functions/harvest-sync-nosits.js
//
// Pull real "No Sit- Need to Reschedule" deals from JobNimbus onto the
// DoorDispatcher so a rep can drive to them and re-book on the spot.
//   • Fetches every job in JN status "No Sit- Need to Reschedule".
//   • Geocodes new addresses (bounded per run, cached by jnid so we never
//     pay to geocode the same one twice).
//   • Upserts each into canvass_prospects as status 'no_sit_reschedule' with
//     jn_job_id + extra.orig_appt_sec (the ORIGINAL appointment date/time) so
//     the map can show "original appt was for …".
//   • Reconcile: any JN-sourced no-sit pin whose JN job is NO LONGER a no-sit
//     (already re-booked) is dropped from the map.
//
//   GET                    → dry run: counts + a sample, writes NOTHING
//   GET ?statuses=1        → distinct JN status_name counts (diagnostic)
//   GET ?commit=1          → geocode + upsert + reconcile for real
//
// Self-contained CJS (no local imports) — mirrors all-no-sits.js.
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY,
//      GOOGLE_MAPS_API_KEY (or VITE_GOOGLE_PLACES_API_KEY)

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_PLACES_API_KEY;
const GOOGLE_GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";

const NOSIT_STATUS = "No Sit- Need to Reschedule";
const GEOCACHE_KEY = "nosit_pin_geocache"; // jnid -> { lat, lng }
const GEO_BUDGET = 60;                      // max NEW addresses geocoded per run

// A status is a live "no sit to re-book" if it starts with "no sit" but isn't
// the already-rescheduled variant.
function isNoSit(statusName) {
  const s = String(statusName || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return s.startsWith("no sit") && !s.includes("rescheduled");
}

exports.handler = async (event) => {
  const scheduled = !event.httpMethod; // Netlify scheduled invocation → auto-commit
  if (!scheduled) {
    if (event.httpMethod === "OPTIONS") return cors(200, "");
    if (event.httpMethod !== "GET") return cors(405, { ok: false, error: "GET only" });
  }
  if (!JN_KEY) return cors(500, { ok: false, error: "Missing JOBNIMBUS_API_KEY" });
  if (!SB_URL || !SB_KEY) return cors(500, { ok: false, error: "Missing Supabase env" });

  const qp = event.queryStringParameters || {};
  const commit = scheduled || /^(1|true|yes)$/i.test(String(qp.commit || ""));
  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

  if (qp.statuses) {
    // Diagnostic: distinct status names among recently-updated jobs.
    const sinceSec = Math.floor(Date.now() / 1000) - 120 * 86400;
    const jobs = await fetchRecentJobs(jnHeaders, sinceSec);
    const counts = {};
    for (const j of jobs) { const n = j.status_name || "(none)"; counts[n] = (counts[n] || 0) + 1; }
    return cors(200, { ok: true, total_jobs: jobs.length, statuses: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })) });
  }

  // Every no-sit-to-rebook job, straight from JN by status.
  const jobs = await fetchJobsByStatus(jnHeaders, NOSIT_STATUS);
  const noSits = jobs.filter((j) => isNoSit(j.status_name));
  const addrOf = (j) => (j.address_line1 || "").trim();
  const withAddrAll = noSits.filter((j) => addrOf(j));

  // Office filter (JN Sync page): enabled toggle + "appointment ON OR AFTER".
  // FORWARD from the date, same as the IQ sync's created_after — the office sets
  // one date and both syncs mean the same thing by it. (It used to run BACKWARD
  // off `appt_before`, which kept a 2024-2025 tail on the map and excluded the
  // recent no-sits worth re-knocking.) `appt_before` is still read as a fallback
  // so an un-migrated setting behaves as the same forward cutoff.
  const filters = (await readSetting("harvest_jn_filters")) || {};
  const nf = filters.nosit || {};
  const enabled = nf.enabled !== false; // default on
  const apptFrom = nf.appt_after || nf.appt_before || "";
  const apptFromSec = apptFrom ? Math.floor(Date.parse(`${apptFrom}T00:00:00-04:00`) / 1000) : null;
  const withAddr = !enabled ? [] : withAddrAll.filter((j) => !apptFromSec || Number(j.date_start) >= apptFromSec);

  const sample = withAddr.slice(0, 8).map((j) => ({
    jnid: j.jnid || j.id,
    customer: (j.primary && j.primary.name) || j.name || "—",
    address: [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", "),
    orig_appt: j.date_start ? new Date(Number(j.date_start) * 1000).toISOString() : null,
    rep: j.sales_rep_name || null,
  }));

  if (!commit) {
    return cors(200, {
      ok: true, dry_run: true,
      status_used: NOSIT_STATUS,
      enabled, appt_on_or_after: apptFrom || null,
      no_sits_total: noSits.length,
      matching_filter: withAddr.length,
      with_address: withAddrAll.length,
      no_address: noSits.length - withAddrAll.length,
      sample,
      note: "Nothing written. Re-call with ?commit=1 to geocode + upsert onto the map.",
    });
  }

  // ── COMMIT ────────────────────────────────────────────────────────────────
  const geocache = (await readSetting(GEOCACHE_KEY)) || {};
  const jnidOf = (j) => j.jnid || j.id;

  // Geocode any we haven't placed yet (bounded per run; the rest fill in next run).
  const need = withAddr.filter((j) => !geocache[jnidOf(j)]).slice(0, GOOGLE_KEY ? GEO_BUDGET : 0);
  let geocoded = 0;
  const CHUNK = 10;
  for (let i = 0; i < need.length; i += CHUNK) {
    const chunk = need.slice(i, i + CHUNK);
    const res = await Promise.all(chunk.map((j) => geocode([j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", "))));
    chunk.forEach((j, idx) => { const g = res[idx]; if (g) { geocache[jnidOf(j)] = g; geocoded++; } });
  }
  if (need.length) await writeSetting(GEOCACHE_KEY, geocache);

  // Existing JN-sourced no-sit pins (so we can update in place + reconcile away
  // the ones that got re-booked). Keyed by jn_job_id.
  // MUST be a complete, verified read — every jnid missing from here gets INSERTED
  // as a new pin below. A failed/partial read used to come back as {} and re-add the
  // entire no-sit list (the double-pin bug). Abort the run instead: a sync that can't
  // see what's already on the map must never write to it.
  const existing = {};
  try {
    for (const p of await sbGetAllStrict(`canvass_prospects?jn_job_id=not.is.null&status=eq.no_sit_reschedule&select=id,jn_job_id`)) {
      if (p.jn_job_id) existing[p.jn_job_id] = p.id;
    }
  } catch (e) {
    const msg = `Aborted before writing: could not read existing no-sit pins (${e.message}). Nothing was inserted or deleted.`;
    await writeSetting("harvest_nosit_sync", { ok: false, aborted: true, error: msg, finished: new Date().toISOString() });
    return cors(503, { ok: false, error: msg });
  }
  // Jobs whose door a REP already worked to a NON-no-sit outcome (dead / new roof / appt /
  // lost / …). Marking a no-sit on the map doesn't change the JN job's status, so the job
  // still reads "No Sit- Need to Reschedule" — which used to make this sync INSERT a second,
  // duplicate no-sit pin right next to the one the rep worked (Patrick Smith, Edward Ashley,
  // Sue Alagic). The rep's field status is the truth: collect those jnids and skip them
  // below (no duplicate, no reset). Bounded to the jobs we're syncing this run.
  const workedByRep = new Set();
  const wantJnids = [...new Set(withAddr.map(jnidOf).filter(Boolean))];
  for (let i = 0; i < wantJnids.length; i += 100) {
    const chunk = wantJnids.slice(i, i + 100).map(encodeURIComponent).join(",");
    for (const p of await sbGet(`canvass_prospects?jn_job_id=in.(${chunk})&status=neq.no_sit_reschedule&select=jn_job_id`)) {
      if (p.jn_job_id) workedByRep.add(p.jn_job_id);
    }
  }
  // ADDRESS-level worked guard. The jnid match above misses the common case where
  // the rep's pin has a DIFFERENT jnid (or none) — a same-house twin from another
  // source (Kia Joseph: rep marked it dead, but this no-sit came in on a different
  // JN job, so the jnid guard let it re-add every run). Index every pin a rep
  // statused to a real field outcome in the last 7 days by normalized street; skip
  // a no-sit whose house is in it, and let the reconcile below drop any stale twin.
  const REP_PROTECT_MS = 7 * 24 * 60 * 60 * 1000;
  // Also a fail-closed read: an incomplete worked-index silently re-adds no-sits on
  // doors reps already handled. `limit/offset` with no ORDER BY could skip rows, and
  // the old 40k cap truncated it outright once the table grew — keyset-paginate the
  // whole thing and abort if it can't be read.
  const workedIdx = new Map(); // streetKey -> [{ zip }]
  try {
    for (const p of await sbGetAllStrict(`canvass_prospects?status=in.(dead,appt,insp_callback,insp_sold,retail,new_roof,lost,no_response,iq_ni,insp_ni)&select=id,address,zip,status_by,status_updated_at`)) {
      const by = String(p.status_by || "");
      if (!by || /^JN\b/i.test(by)) continue;                 // sync-set → not a rep
      const t = Date.parse(p.status_updated_at || "");
      if (!(Number.isFinite(t) && (Date.now() - t) < REP_PROTECT_MS)) continue; // stale
      const k = streetKey(p.address); if (!k) continue;
      if (!workedIdx.has(k)) workedIdx.set(k, []);
      workedIdx.get(k).push({ zip: zip5(p.zip) });
    }
  } catch (e) {
    const msg = `Aborted before writing: could not read rep-worked pins (${e.message}). Nothing was inserted or deleted.`;
    await writeSetting("harvest_nosit_sync", { ok: false, aborted: true, error: msg, finished: new Date().toISOString() });
    return cors(503, { ok: false, error: msg });
  }
  const repWorkedAddr = (j) => {
    const k = streetKey(j.address_line1); if (!k) return false;
    const arr = workedIdx.get(k); if (!arr) return false;
    const jz = zip5(j.zip);
    return arr.some((s) => !s.zip || !jz || s.zip === jz);
  };

  const nowIso = new Date().toISOString();
  const liveIds = new Set();
  let inserted = 0, updated = 0, skipped = 0;
  const toInsert = [];
  const updates = [];

  for (const j of withAddr) {
    const jnid = jnidOf(j);
    const geo = geocache[jnid];
    if (!geo) { skipped++; continue; } // not geocoded yet — picks up on a later run
    if (workedByRep.has(jnid)) { skipped++; continue; } // rep already worked this door (same jnid) — leave their status
    if (repWorkedAddr(j)) { skipped++; continue; }       // rep worked this HOUSE (diff/no jnid) — skip; reconcile drops any stale twin
    liveIds.add(jnid);
    const street = (j.address_line1 || "").split(",")[0].trim();
    const row = {
      name: (j.primary && j.primary.name) || j.name || "Homeowner",
      address: street, city: j.city || null, state: j.state_text || null, zip: j.zip || null,
      latitude: geo.lat, longitude: geo.lng, geocode_status: "ok",
      status: "no_sit_reschedule", status_by: "JN no-sit sync", status_updated_at: nowIso,
      jn_job_id: jnid, list_name: "JN No-Sits",
      extra: {
        orig_appt_sec: Number(j.date_start) || null,
        jn_sales_rep: j.sales_rep_name || null,
        jn_status: j.status_name || null,
        synced_at: nowIso,
      },
    };
    if (existing[jnid]) {
      updates.push(fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${existing[jnid]}`, {
        method: "PATCH", headers: { ...sbHeaders, Prefer: "return=minimal" },
        body: JSON.stringify({ ...row }),
      }).then((r) => { if (r.ok) updated++; }));
    } else {
      toInsert.push(row);
    }
  }
  await Promise.all(updates);
  if (toInsert.length) {
    const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects`, {
      method: "POST", headers: { ...sbHeaders, Prefer: "return=minimal" }, body: JSON.stringify(toInsert),
    });
    if (r.ok) inserted = toInsert.length;
  }

  // Reconcile: drop map no-sit pins that are no longer a live no-sit in JN — the
  // homeowner got rescheduled / went No Response / was Lost, all IN JobNimbus (e.g.
  // Yehudah moving "No Sit- Need to Reschedule" → "No Sit - Rescheduled" → "No Response").
  // The no-sit pull CAN'T contain a job that moved OFF the status, so those pins used to
  // linger forever. Fix: also pull recently-updated jobs across ALL statuses — a job that
  // changed status shows up there, giving us PROOF it moved. Only delete pins whose jnid
  // we actually saw (in the no-sit pull OR the recent-any-status pull) but that isn't a
  // live no-sit now; a job the API never returned is left alone, so a partial/failed JN
  // fetch can never wipe the map.
  const recent = await fetchRecentJobs(jnHeaders, Math.floor(Date.now() / 1000) - 120 * 86400);
  const seenAnyStatus = new Set([...jobs, ...recent].map(jnidOf));
  const stale = Object.entries(existing)
    .filter(([jnid]) => seenAnyStatus.has(jnid) && !liveIds.has(jnid))
    .map(([, id]) => id);
  let removed = 0;
  if (stale.length) {
    const r = await fetch(`${SB_URL}/rest/v1/canvass_prospects?id=in.(${stale.join(",")})`, {
      method: "DELETE", headers: { ...sbHeaders, Prefer: "return=minimal" },
    });
    if (r.ok) removed = stale.length;
  }

  await bumpDailyNew("nosit", inserted); // rolling per-day new-pin tally for the JN Sync report
  return cors(200, { ok: true, committed: true, no_sits_total: noSits.length, with_address: withAddr.length, geocoded, inserted, updated, skipped_ungeocoded: skipped, removed_rebooked: removed });
};

// ── JN ──────────────────────────────────────────────────────────────────────
async function fetchJobsByStatus(jnHeaders, status) {
  const all = [];
  const filter = encodeURIComponent(JSON.stringify({ must: [{ match_phrase: { status_name: status } }] }));
  for (let page = 0; page < 40; page++) {
    const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&filter=${filter}`, { headers: jnHeaders });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const rows = d.results || d.jobs || [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}
async function fetchRecentJobs(jnHeaders, sinceSec) {
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
    const r = await fetch(`${GOOGLE_GEOCODE}?address=${encodeURIComponent(addr)}&region=us&key=${GOOGLE_KEY}`);
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    const loc = d.results && d.results[0] && d.results[0].geometry && d.results[0].geometry.location;
    if (!loc || typeof loc.lat !== "number") return null;
    return { lat: loc.lat, lng: loc.lng };
  } catch { return null; }
}

// ── Supabase ──────────────────────────────────────────────────────────────
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
async function sbGet(path) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders });
    if (!r.ok) return [];
    return await r.json().catch(() => []);
  } catch { return []; }
}
// FAIL-CLOSED, COMPLETE read — for anything this sync uses to decide "does a pin
// already exist?". sbGet() above returns [] on any error, which reads as "nothing
// exists" and made this sync re-insert the whole no-sit list as new pins every
// time a query timed out (the Aug-15 double-pin bug, once canvass_prospects hit
// 1.5M rows). This one THROWS instead, so the caller aborts rather than duplicating,
// and it keyset-paginates on id so it can't silently stop at PostgREST's 1000-row cap.
async function sbGetAllStrict(pathBase) {
  const out = [];
  let after = "";
  for (let guard = 0; guard < 5000; guard++) {
    const url = `${SB_URL}/rest/v1/${pathBase}&order=id.asc&limit=1000${after ? `&id=gt.${after}` : ""}`;
    const r = await fetch(url, { headers: sbHeaders });
    if (!r.ok) throw new Error(`Supabase read failed (${r.status}): ${(await r.text().catch(() => "")).slice(0, 180)}`);
    const rows = await r.json();
    if (!Array.isArray(rows)) throw new Error("Supabase read returned a non-array");
    out.push(...rows);
    if (rows.length < 1000) return out;
    after = rows[rows.length - 1].id;
  }
  throw new Error("Supabase read exceeded the page guard");
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
// Rolling per-day new-pin tally shared with the IQ sync → app_settings.harvest_sync_daily.
async function bumpDailyNew(source, count) {
  const n = Number(count) || 0; if (!n) return;
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const cur = (await readSetting("harvest_sync_daily")) || {};
    const day = cur[today] || {};
    day[source] = (day[source] || 0) + n;
    cur[today] = day;
    const keep = {}; for (const k of Object.keys(cur).sort().slice(-21)) keep[k] = cur[k];
    await writeSetting("harvest_sync_daily", keep);
  } catch { /* non-fatal */ }
}
async function writeSetting(key, obj) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
      method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }),
    });
    return r.ok;
  } catch { return false; }
}
// Normalized street key so the same house collapses across sources despite geocode
// drift + spelling ("7302 NW 57th Ave" == "7302 N.W. 57th Avenue"). Mirrors the IQ sync.
const ADDR_SUF = { street: "st", st: "st", avenue: "ave", ave: "ave", av: "ave", place: "pl", pl: "pl", drive: "dr", dr: "dr", lane: "ln", ln: "ln", court: "ct", ct: "ct", terrace: "ter", terr: "ter", ter: "ter", boulevard: "blvd", blvd: "blvd", road: "rd", rd: "rd", circle: "cir", cir: "cir", trail: "trl", trl: "trl", parkway: "pkwy", pkwy: "pkwy", highway: "hwy", hwy: "hwy", cove: "cv", cv: "cv", point: "pt", pt: "pt", square: "sq", sq: "sq" };
const ADDR_DIR = { north: "n", n: "n", south: "s", s: "s", east: "e", e: "e", west: "w", w: "w", northeast: "ne", ne: "ne", northwest: "nw", nw: "nw", southeast: "se", se: "se", southwest: "sw", sw: "sw" };
function streetKey(address) {
  if (!address) return null;
  const words = String(address).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const out = words.map((w) => ADDR_DIR[w] || ADDR_SUF[w] || w);
  const k = out.join(" ").trim();
  return k || null;
}
function zip5(z) { const m = String(z || "").match(/(\d{5})/); return m ? m[1] : ""; }
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: JSON.stringify(body) };
}

// NOTE: no schedule here on purpose. This worker is invoked over HTTP by the
// admin "Sync now" button (harvest-sync-nosits?commit=1). A Netlify SCHEDULED
// function can't also be called over HTTP — Netlify 403s the manual request —
// so the twice-daily schedule lives in the thin wrapper cron-harvest-nosits.js,
// which calls this worker. (Mirrors the IQ pattern: cron-harvest-leadsync →
// harvest-sync-iq-background.)
