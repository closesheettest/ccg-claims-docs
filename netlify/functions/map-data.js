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

    if (mode === "maildiag") {
      // Test Neal's hypothesis: are mailed-but-not-qualifying homes MISSING roof data
      // (nothing to compute qualifies from), or do they HAVE data and just don't qualify
      // now (already re-roofed / other criteria)?
      const base = `${DAVID_URL}/rest/v1/map_properties?last_mailed_date=not.is.null&qualifies=eq.false`;
      const noData = await countOf(`${base}&roof_age=is.null&select=akey`, dH, "estimated");
      const hasData = await countOf(`${base}&roof_age=not.is.null&select=akey`, dH, "estimated");
      const hasPermit = await countOf(`${base}&roof_permit_count=gt.0&select=akey`, dH, "estimated");
      const youngRoof = await countOf(`${base}&roof_age=lte.10&select=akey`, dH, "estimated"); // re-roofed since mail
      const sampRes = await fetch(`${base}&select=akey,roof_age,last_roof_year,last_mailed_date,roof_permit_count,roof_contractor,owner_occupied,roof_cover&limit=12`, { headers: dH });
      const sample = sampRes.ok ? await sampRes.json() : (await sampRes.text()).slice(0, 300);
      return json(200, { ok: true, mailed_not_qualifying: { no_roof_data: noData, has_roof_data: hasData, has_a_permit: hasPermit, roof_10yr_or_newer: youngRoof }, sample });
    }

    if (mode === "mailedpage") {
      // Bulk pull of David's EVER-MAILED homes via KEYSET pagination on akey (the PK,
      // indexed) — walk by ?after=<last akey>. Deep OFFSET times out his DB; keyset
      // is an index seek, fast at any depth.
      const after = String(p.after || "");
      const afterClause = after ? `&akey=gt.${encodeURIComponent(after)}` : "";
      const r = await fetch(`${DAVID_URL}/rest/v1/map_properties?last_mailed_date=not.is.null${afterClause}&select=akey,lat,long,address,city,zip5,roof_age,qualifies&order=akey.asc&limit=1000`, { headers: dH });
      if (!r.ok) return json(200, { ok: false, error: (await r.text()).slice(0, 200) });
      const pins = await r.json();
      return json(200, { ok: true, count: pins.length, done: pins.length < 1000, last: pins.length ? pins[pins.length - 1].akey : after, pins });
    }

    if (mode === "pins") {
      // Live map layer: David's EVER-MAILED homes inside the viewport. Only mailed
      // homes go on the map so the rep's "we mailed you about your roof" pitch always
      // holds. Returns lightweight pins; our worked-status overlay is applied client-side.
      const n = num(p.n), s = num(p.s), e = num(p.e), w = num(p.w);
      if ([n, s, e, w].some((v) => v == null) || !(n > s && e > w)) return json(400, { ok: false, error: "viewport bounds n>s, e>w required" });
      const box = `&lat=gte.${s}&lat=lte.${n}&long=gte.${w}&long=lte.${e}`;
      const cap = Math.min(4000, Math.max(200, parseInt(p.max || "3000", 10) || 3000));
      const r = await fetch(`${DAVID_URL}/rest/v1/map_properties?last_mailed_date=not.is.null${box}&select=akey,lat,long,address,city,zip5,roof_age,last_roof_year,roof_cover,qualifies&limit=${cap}`, { headers: dH });
      if (!r.ok) return json(200, { ok: false, error: (await r.text()).slice(0, 200) });
      const pins = await r.json();
      return json(200, { ok: true, count: pins.length, capped: pins.length >= cap, pins });
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

    // probe — connection + headline counts + a redacted sample
    const total = await countOf(`${DAVID_URL}/rest/v1/map_properties?select=akey`, dH);
    const qualifies = await countOf(`${DAVID_URL}/rest/v1/map_properties?qualifies=eq.true&select=akey`, dH, "estimated");
    const mailed = await countOf(`${DAVID_URL}/rest/v1/map_properties?last_mailed_date=not.is.null&select=akey`, dH, "estimated");
    const qualifiedAndMailed = await countOf(`${DAVID_URL}/rest/v1/map_properties?qualifies=eq.true&last_mailed_date=not.is.null&select=akey`, dH, "estimated");
    const sampRes = await fetch(`${DAVID_URL}/rest/v1/map_properties?select=akey,address,city,zip5,county,roof_age,last_roof_year,roof_cover,owner_occupied,qualifies&limit=4`, { headers: dH });
    const connected = sampRes.ok;
    const sample = sampRes.ok ? await sampRes.json() : (await sampRes.text()).slice(0, 400);
    return json(200, { ok: true, connected, http: sampRes.status, counts: { total, qualifies, mailed, qualified_and_mailed: qualifiedAndMailed }, sample });
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
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) };
}
