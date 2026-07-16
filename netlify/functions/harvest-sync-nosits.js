// netlify/functions/harvest-sync-nosits.js
//
// Pull real "No Sit- Need to Reschedule" deals from JobNimbus onto the
// Harvesting Map so a rep can drive to them and re-book on the spot.
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
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "GET") return cors(405, { ok: false, error: "GET only" });
  if (!JN_KEY) return cors(500, { ok: false, error: "Missing JOBNIMBUS_API_KEY" });
  if (!SB_URL || !SB_KEY) return cors(500, { ok: false, error: "Missing Supabase env" });

  const qp = event.queryStringParameters || {};
  const commit = /^(1|true|yes)$/i.test(String(qp.commit || ""));
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
  const withAddr = noSits.filter((j) => addrOf(j));

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
      no_sits_total: noSits.length,
      with_address: withAddr.length,
      no_address: noSits.length - withAddr.length,
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
  const existing = {};
  for (const p of await sbGet(`canvass_prospects?jn_job_id=not.is.null&status=eq.no_sit_reschedule&select=id,jn_job_id`)) {
    if (p.jn_job_id) existing[p.jn_job_id] = p.id;
  }

  const nowIso = new Date().toISOString();
  const liveIds = new Set();
  let inserted = 0, updated = 0, skipped = 0;
  const toInsert = [];
  const updates = [];

  for (const j of withAddr) {
    const jnid = jnidOf(j);
    const geo = geocache[jnid];
    if (!geo) { skipped++; continue; } // not geocoded yet — picks up on a later run
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

  // Reconcile: drop JN-sourced no-sit pins that are no longer no-sits in JN
  // (re-booked elsewhere). Only delete ones whose jnid we DID see in this pull's
  // full job set but that are no longer no-sit — i.e. we have proof they moved.
  const seenAnyStatus = new Set(jobs.map(jnidOf));
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
    const r = await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
      method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ key, value: JSON.stringify(obj), updated_at: new Date().toISOString() }),
    });
    return r.ok;
  } catch { return false; }
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: JSON.stringify(body) };
}
