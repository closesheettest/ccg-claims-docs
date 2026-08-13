// netlify/functions/map-data.js
//
// Backend bridge to David Macella's "Map Data" Supabase (public.map_properties,
// ~8.6M FL homes, weekly-refreshed roof data). That DB is RLS-locked PII, so the
// service_role key lives ONLY in Netlify env (MAP_DATA_KEY) and is used ONLY here,
// server-side — never the browser, never git. Gated behind our harvest_admin_token.
//
//   GET ?admin=<harvest_admin_token>&mode=probe
//        → connection check + row counts + a small redacted sample (no owner PII)
//   GET ?admin=...&mode=schema
//        → the column list on a sample row (to design matching)
//
// Env: MAP_DATA_KEY (David's key, Netlify only), VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const OUR_URL = process.env.VITE_SUPABASE_URL;
const OUR_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const DAVID_URL = "https://pbwyoziztkiyifgmxbcr.supabase.co";
const DAVID_KEY = process.env.MAP_DATA_KEY;

const PII = new Set(["owner_name", "owner_name_2", "mailing_address", "mailing_addr", "owner_mailing", "phone", "email"]);

export const handler = async (event) => {
  const p = event.queryStringParameters || {};
  if (!OUR_URL || !OUR_KEY) return json(500, { ok: false, error: "Our Supabase env missing" });
  if (!DAVID_KEY) return json(500, { ok: false, error: "MAP_DATA_KEY is not set in Netlify env — add David's key there first." });

  // Gate: must present our harvest_admin_token.
  const admin = String(p.admin || "").trim();
  let allowed = false;
  try {
    const rows = await ourGet(`app_settings?key=eq.harvest_admin_token&select=value&limit=1`);
    allowed = !!admin && rows[0] && rows[0].value === admin;
  } catch { /* fall through to 401 */ }
  if (!allowed) return json(401, { ok: false, error: "unauthorized" });

  const dH = { apikey: DAVID_KEY, Authorization: `Bearer ${DAVID_KEY}`, "Content-Type": "application/json" };
  const mode = String(p.mode || "probe").trim();

  try {
    if (mode === "schema") {
      const r = await fetch(`${DAVID_URL}/rest/v1/map_properties?select=*&limit=1`, { headers: dH });
      if (!r.ok) return json(200, { ok: false, connected: false, http: r.status, body: (await r.text()).slice(0, 400) });
      const rows = await r.json();
      const row = rows[0] || {};
      // redact PII values, keep the column NAMES + a couple safe sample values
      const cols = Object.keys(row).sort();
      const safe = {};
      for (const k of cols) safe[k] = PII.has(k) ? "‹redacted›" : row[k];
      return json(200, { ok: true, connected: true, columns: cols, sample_redacted: safe });
    }

    if (mode === "reconcile") {
      // One SLICE of our inspection-needed pins, matched against David's live prospects.
      // A pin SURVIVES if David still flags it (qualifies=true) OR we've visited it
      // (activity history worth keeping). Everything else is a removal candidate.
      const offset = Math.max(0, parseInt(p.offset || "0", 10) || 0);
      const limit = Math.min(8000, Math.max(1000, parseInt(p.limit || "6000", 10) || 6000));
      const pins = [];
      for (let f = offset; f < offset + limit; f += 1000) {
        const r = await fetch(`${OUR_URL}/rest/v1/canvass_prospects?status=eq.insp&select=id,address,zip&order=id.asc`, { headers: { apikey: OUR_KEY, Authorization: `Bearer ${OUR_KEY}`, Range: `${f}-${f + 999}` } });
        if (!r.ok) break;
        const d = await r.json().catch(() => []);
        pins.push(...d);
        if (d.length < 1000) break;
      }
      let noAkey = 0;
      const keyById = new Map();
      for (const pn of pins) { const k = akeyOf(pn.address, pn.zip); if (!k) noAkey++; else keyById.set(pn.id, k); }
      // David match: which akeys are still prospects?
      const uniq = [...new Set(keyById.values())];
      const prospect = new Set();
      for (let i = 0; i < uniq.length; i += 240) {
        const chunk = uniq.slice(i, i + 240).map((a) => `"${a.replace(/"/g, "")}"`).join(",");
        const r = await fetch(`${DAVID_URL}/rest/v1/map_properties?akey=in.(${encodeURIComponent(chunk)})&qualifies=eq.true&select=akey`, { headers: dH });
        if (r.ok) for (const x of await r.json()) prospect.add(x.akey);
      }
      // Of the pins that DON'T match David, which were visited (keep for history)?
      const removeCandidateIds = [];
      let matchKeep = 0;
      for (const [id, k] of keyById) { if (prospect.has(k)) matchKeep++; else removeCandidateIds.push(id); }
      let visitedKeep = 0;
      for (let i = 0; i < removeCandidateIds.length; i += 150) {
        const ids = removeCandidateIds.slice(i, i + 150).map((x) => `"${x}"`).join(",");
        const r = await fetch(`${OUR_URL}/rest/v1/canvass_activity?pin_id=in.(${encodeURIComponent(ids)})&select=pin_id`, { headers: { apikey: OUR_KEY, Authorization: `Bearer ${OUR_KEY}` } });
        if (r.ok) { const seen = new Set((await r.json()).map((x) => x.pin_id)); visitedKeep += seen.size; }
      }
      const remove = removeCandidateIds.length - visitedKeep + noAkey; // no-akey can't be matched → removal candidate too
      return json(200, { ok: true, offset, got: pins.length, match_keep: matchKeep, visited_keep: visitedKeep, no_akey: noAkey, remove, done: pins.length < limit });
    }

    if (mode === "analyze") {
      // OUR "new roof" homes (reps marked new_roof) — they carry address + zip in the
      // same UPPER/abbreviated style as David's akey, so we can match directly.
      const nr = await ourGetAll(`canvass_prospects?status=eq.new_roof&select=address,zip`);
      const set = new Map();
      for (const r of nr) { const k = akeyOf(r.address, r.zip); if (k) set.set(k, true); }
      const akeys = [...set.keys()];
      // Look each up in David's data (chunked by the PK akey — fast, indexed).
      let matched = 0, stillProspect = 0; const discrepancies = [];
      for (let i = 0; i < akeys.length; i += 100) {
        const chunk = akeys.slice(i, i + 100).map((a) => `"${a.replace(/"/g, "")}"`).join(",");
        const r = await fetch(`${DAVID_URL}/rest/v1/map_properties?akey=in.(${encodeURIComponent(chunk)})&select=akey,city,county,roof_age,last_roof_year,roof_cover,qualifies&limit=200`, { headers: dH });
        if (!r.ok) continue;
        const d = await r.json();
        for (const x of d) { matched++; if (x.qualifies) { stillProspect++; discrepancies.push({ akey: x.akey, city: x.city, county: x.county, roof_age: x.roof_age, last_roof_year: x.last_roof_year, roof_cover: x.roof_cover }); } }
      }
      const davidProspects = await countOf(`${DAVID_URL}/rest/v1/map_properties?qualifies=eq.true&select=akey`, dH, "estimated");
      return json(200, {
        ok: true,
        david_total_prospects_estimated: davidProspects,
        our_new_roof_homes: set.size,
        matched_in_davids_data: matched,
        match_rate_pct: set.size ? Math.round((matched / set.size) * 100) : 0,
        david_still_flags_these_as_prospect: stillProspect,
        note: "discrepancies = our new-roof homes David STILL lists as prospects (address + what his data says).",
        discrepancies,
      });
    }

    // probe — connection + the two headline counts + a redacted sample
    const total = await countOf(`${DAVID_URL}/rest/v1/map_properties?select=akey`, dH);
    const qualifies = await countOf(`${DAVID_URL}/rest/v1/map_properties?qualifies=eq.true&select=akey`, dH, "estimated");
    const sampRes = await fetch(`${DAVID_URL}/rest/v1/map_properties?select=akey,address,city,zip5,county,roof_age,last_roof_year,roof_cover,owner_occupied,qualifies&limit=4`, { headers: dH });
    const connected = sampRes.ok;
    const sample = sampRes.ok ? await sampRes.json() : (await sampRes.text()).slice(0, 400);
    return json(200, { ok: true, connected, http: sampRes.status, counts: { total, qualifies }, sample });
  } catch (e) {
    return json(500, { ok: false, error: e.message || "map-data error" });
  }
};

async function ourGet(path) {
  const r = await fetch(`${OUR_URL}/rest/v1/${path}`, { headers: { apikey: OUR_KEY, Authorization: `Bearer ${OUR_KEY}` } });
  return r.ok ? r.json() : [];
}
// Page through an OUR-side query (PostgREST caps a single read at 1000 rows).
async function ourGetAll(path) {
  const out = []; const PAGE = 1000;
  for (let from = 0; from < 200000; from += PAGE) {
    const r = await fetch(`${OUR_URL}/rest/v1/${path}`, { headers: { apikey: OUR_KEY, Authorization: `Bearer ${OUR_KEY}`, Range: `${from}-${from + PAGE - 1}` } });
    if (!r.ok) break;
    const d = await r.json().catch(() => []);
    out.push(...d);
    if (d.length < PAGE) break;
  }
  return out;
}
// Build David's akey: UPPER normalized street + "|" + ZIP5.
function akeyOf(addr, zip) {
  const s = String(addr || "").toUpperCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
  const z = String(zip || "").trim().slice(0, 5);
  return s && /^\d{5}$/.test(z) ? `${s}|${z}` : null;
}
async function countOf(url, headers, kind = "exact") {
  const r = await fetch(url + "&limit=1", { headers: { ...headers, Prefer: `count=${kind}` } });
  const cr = r.headers.get("content-range") || "";
  const n = cr.includes("/") ? parseInt(cr.split("/")[1], 10) : NaN;
  return Number.isFinite(n) ? n : null;
}
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) };
}
