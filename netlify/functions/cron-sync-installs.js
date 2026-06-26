// netlify/functions/cron-sync-installs.js
//
// Keeps the Install Finder (golden-banoffee-56e9ef.netlify.app) fresh from
// JobNimbus. Pulls every job that has a "Roof Install" date, classifies the
// product + color, and adds any that AREN'T already in the finder's `installs`
// table — without duplicating or touching the hand-imported rows.
//
// Dedup: skip if the job's jnid is already there, OR if a row with the same
// normalized street address already exists (the hand-imported ones have no
// jnid but came from JN originally).
//
// Runs nightly; also GET-triggerable for an on-demand sync.
//   GET /.netlify/functions/cron-sync-installs  → { ok, scanned, candidates,
//        added, skipped_existing, skipped_no_geo, product_types_in_table }
//
// Env: JOBNIMBUS_API_KEY (CCG). Writes to the Install Finder's own Supabase
// (separate project) via its publishable key — same one its client uses.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
// The Install Finder's Supabase (separate project; publishable key allows the
// same insert its import.html does).
const FINDER_URL = "https://qkhljgegxcburqldposx.supabase.co";
const FINDER_KEY = process.env.INSTALL_FINDER_KEY || "sb_publishable_9K1x5jFjhqK3_YXTjiSv6Q_i10wFSJg";
const fsb = { apikey: FINDER_KEY, Authorization: `Bearer ${FINDER_KEY}`, "Content-Type": "application/json" };

// Every job currently/previously installed sits in one of these statuses.
const STATUS_NAMES = [
  "Production Review", "Job Prep", "In Funding", "Waiting on PACE",
  "Upcoming Installs", "Install Set", "Roof Started", "New Roof",
  "Install Complete - Collect Payment", "Upcoming Commissions", "Commission",
  "Paid & Closed", "Holds", "Extras",
];
// Material flag → product_type label + the matching JN color field.
const MATERIALS = [
  { flag: "Shingle", type: "Shingle", color: "Shingle Color" },
  { flag: "Exposed Fastener", type: "Exposed Fastener Metal", color: "Exposed Fastener Color" },
  { flag: "Standing Seam", type: "Standing Seam Metal", color: "Standing Seam Color" },
  { flag: "Stone Coated Metal", type: "Stone Coated Metal", color: "Stone Coated Metal Color" },
  { flag: "Permalock", type: "Permalock Metal", color: "Permalock Colors" },
  { flag: "Tile", type: "Tile", color: "Tile Color" },
  { flag: "TPO", type: "TPO", color: null },
  { flag: "Modified Bitman", type: "Modified Bitumen", color: "Mod Bit Color" },
];

exports.handler = async (event) => {
  if (!JN_KEY) return json(500, { ok: false, error: "JN key missing" });
  const dryRun = !!(event && event.queryStringParameters && /^(1|true|yes)$/i.test(event.queryStringParameters.dry_run || ""));
  try {
    // 1. Pull install-stage jobs from JN.
    const headers = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
    const filter = encodeURIComponent(JSON.stringify({ must: [{ terms: { status_name: STATUS_NAMES } }] }));
    const jobs = [];
    for (let page = 0; page < 15; page++) {
      let r;
      try { r = await fetch(`${JN_BASE}/jobs?size=200&from=${page * 200}&filter=${filter}`, { headers }); }
      catch (e) { throw new Error(`JobNimbus fetch failed: ${e.message}`); }
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const rows = d.results || d.jobs || d.data || [];
      if (!rows.length) break;
      jobs.push(...rows);
      if (rows.length < 200) break;
    }

    // 2. Build candidate install rows (must have an install date + coordinates).
    let noGeo = 0;
    const candidates = [];
    for (const jraw of jobs) {
      if (!tsec(jraw["Roof Install"])) continue;
      const geo = jraw.geo || {};
      const lat = numOrNull(geo.lat != null ? geo.lat : jraw.lat);
      const lng = numOrNull(geo.lon != null ? geo.lon : (geo.lng != null ? geo.lng : jraw.lng));
      if (lat == null || lng == null) { noGeo++; continue; }
      const mat = MATERIALS.find((m) => isYes(jraw[m.flag]));
      candidates.push({
        jnid: jraw.jnid || jraw.id,
        address_line: (jraw.address_line1 || "").trim(),
        city: (jraw.city || "").trim(),
        product_type: mat ? mat.type : "Other",
        color: (mat && mat.color ? (jraw[mat.color] || "") : "").trim(),
        latitude: lat,
        longitude: lng,
      });
    }

    // 3. Existing rows in the finder (jnid + normalized address) to dedup against.
    const existing = await fGet(`installs?select=jnid,address_line,city&limit=20000`);
    const haveJnid = new Set();
    const haveAddr = new Set();
    const ptypes = {};
    for (const r of existing) {
      if (r.jnid) haveJnid.add(String(r.jnid));
      haveAddr.add(normAddr(r.address_line, r.city));
    }
    // Also tally product_types already present (for reconciliation in the response).
    for (const r of await fGet(`installs?select=product_type&limit=20000`)) {
      const p = r.product_type || "(none)"; ptypes[p] = (ptypes[p] || 0) + 1;
    }

    // 4. Insert the ones we don't already have (by jnid OR address).
    const toAdd = [];
    let skipped = 0;
    const seen = new Set();
    for (const c of candidates) {
      const a = normAddr(c.address_line, c.city);
      if (haveJnid.has(String(c.jnid)) || haveAddr.has(a) || seen.has(c.jnid) || seen.has(a)) { skipped++; continue; }
      seen.add(c.jnid); seen.add(a);
      toAdd.push(c);
    }
    if (dryRun) {
      return json(200, { ok: true, dry_run: true, scanned: jobs.length, candidates: candidates.length, would_add: toAdd.length, skipped_existing: skipped, skipped_no_geo: noGeo, existing_rows: existing.length, product_types_in_table: ptypes, sample_to_add: toAdd.slice(0, 5) });
    }
    let added = 0;
    for (let i = 0; i < toAdd.length; i += 200) {
      const chunk = toAdd.slice(i, i + 200);
      const r = await fetch(`${FINDER_URL}/rest/v1/installs`, { method: "POST", headers: { ...fsb, Prefer: "return=minimal" }, body: JSON.stringify(chunk) });
      if (r.ok) added += chunk.length;
      else return json(502, { ok: false, error: `finder insert ${r.status}: ${(await r.text()).slice(0, 200)}`, hint: "Make sure the installs table has a 'jnid text' column (see sql/install_finder_jnid.sql)." });
    }

    return json(200, { ok: true, scanned: jobs.length, candidates: candidates.length, added, skipped_existing: skipped, skipped_no_geo: noGeo, existing_rows: existing.length, product_types_in_table: ptypes });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

// Nightly at ~3:30 AM ET (07:30 UTC).
exports.config = { schedule: "30 7 * * *" };

function tsec(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; }
function isYes(v) { const s = String(v == null ? "" : v).trim().toLowerCase(); return s === "true" || s === "yes" || s === "1"; }
function normAddr(a, c) { return `${String(a || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${String(c || "").toLowerCase().trim()}`; }
async function fGet(path) {
  let r;
  try { r = await fetch(`${FINDER_URL}/rest/v1/${path}`, { headers: fsb }); }
  catch (e) { throw new Error(`Install Finder Supabase unreachable (is the project paused?): ${e.message}`); }
  if (!r.ok) { if (r.status === 401 || r.status === 404) throw new Error(`Install Finder Supabase ${r.status}: ${(await r.text()).slice(0, 120)}`); return []; }
  return r.json().catch(() => []);
}
function json(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) }; }
