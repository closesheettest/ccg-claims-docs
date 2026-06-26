// netlify/functions/cron-sync-installs.js
//
// Keeps the Install Finder map fresh from JobNimbus. Pulls every job with a
// "Roof Install" date, classifies product + color, and UPSERTS into the CCG
// `installs` table (keyed by jnid — no duplicates, always current). The Install
// Finder reads this table.
//
// Runs nightly; also GET-triggerable. ?dry_run=1 = preview counts, no writes.
//   GET /.netlify/functions/cron-sync-installs[?dry_run=1]
//
// Env: JOBNIMBUS_API_KEY, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (CCG).
// One-time: run sql/ccg_installs_table.sql in the CCG Supabase.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

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
  if (!JN_KEY || !SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
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

    // 2. Build install rows (need an install date + coordinates).
    let noGeo = 0;
    const seen = new Set();
    const candidates = [];
    for (const j of jobs) {
      if (!tsec(j["Roof Install"])) continue;
      const geo = j.geo || {};
      const lat = numOrNull(geo.lat != null ? geo.lat : j.lat);
      const lng = numOrNull(geo.lon != null ? geo.lon : (geo.lng != null ? geo.lng : j.lng));
      if (lat == null || lng == null) { noGeo++; continue; }
      const jnid = String(j.jnid || j.id);
      if (seen.has(jnid)) continue;
      seen.add(jnid);
      const mat = MATERIALS.find((m) => isYes(j[m.flag]));
      candidates.push({
        jnid,
        address_line: (j.address_line1 || "").trim(),
        city: (j.city || "").trim(),
        product_type: mat ? mat.type : "Other",
        color: (mat && mat.color ? (j[mat.color] || "") : "").trim(),
        latitude: lat,
        longitude: lng,
      });
    }

    if (dryRun) {
      const byType = {};
      for (const c of candidates) byType[c.product_type] = (byType[c.product_type] || 0) + 1;
      return json(200, { ok: true, dry_run: true, scanned: jobs.length, candidates: candidates.length, skipped_no_geo: noGeo, by_product_type: byType, sample: candidates.slice(0, 5) });
    }

    // 3. Upsert by jnid (insert new, update existing — no duplicates).
    let upserted = 0;
    for (let i = 0; i < candidates.length; i += 200) {
      const chunk = candidates.slice(i, i + 200);
      const r = await fetch(`${SB_URL}/rest/v1/installs?on_conflict=jnid`, {
        method: "POST", headers: { ...sb, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(chunk),
      });
      if (r.ok) upserted += chunk.length;
      else return json(502, { ok: false, error: `upsert ${r.status}: ${(await r.text()).slice(0, 200)}`, hint: "Run sql/ccg_installs_table.sql in the CCG Supabase first." });
    }

    return json(200, { ok: true, scanned: jobs.length, candidates: candidates.length, upserted, skipped_no_geo: noGeo });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "error" });
  }
};

// Nightly at ~3:30 AM ET (07:30 UTC).
exports.config = { schedule: "30 7 * * *" };

function tsec(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; }
function isYes(v) { const s = String(v == null ? "" : v).trim().toLowerCase(); return s === "true" || s === "yes" || s === "1"; }
function json(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) }; }
