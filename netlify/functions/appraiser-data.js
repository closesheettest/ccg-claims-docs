// Auto-fetch a property's UNDER-ROOF FOOTPRINT (and a sketch when available) from
// the county Property Appraiser, BY ADDRESS — so the measure tool can size a roof
// with zero typing: footprint × overhang × pitch = squares.
//
//   POST { address, county? } → { ok, county, capability, footprint_sqft,
//          subareas:[{desc,sqft}], sketch, parcel_id, matched_address } | { ok:false }
//
// footprint_sqft = the appraiser's total UNDER-ROOF area (living + garage + porches),
// i.e. the ground footprint the roof covers. sketch = a base64 data URL when the
// county serves one. Batch 1 counties: Sarasota, Palm Beach, Hillsborough, Pinellas,
// Manatee (all "raw" — no manual entry needed). Others fall back to sketch/trace.
//
// Env: none (public county GIS/records).

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// Some appraiser sites (pcpao.gov) sit behind a WAF that wants a full browser
// fingerprint, not just any UA — send Accept/Accept-Language too.
const BROWSER_HDRS = { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const address = String(body.address || "").trim();
  if (!address) return cors(400, JSON.stringify({ ok: false, error: "address required" }));
  const county = normCounty(body.county, address);
  const adapter = ADAPTERS[county];
  if (!adapter) return cors(200, JSON.stringify({ ok: false, unsupported: true, error: `Auto-measure isn't wired for ${body.county || "this county"} yet.`, county }));

  try {
    const out = await adapter(address);
    if (!out || !(out.footprint_sqft > 0)) return cors(200, JSON.stringify({ ok: false, error: "No under-roof area found for that address.", county }));
    return cors(200, JSON.stringify({ ok: true, county, capability: out.sketch ? "raw+sketch" : "raw", ...out }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error", county }));
  }
};

// ── county router ─────────────────────────────────────────────────────────
const ADAPTERS = {
  Sarasota: sarasota,
  "Palm Beach": palmBeach,
  Hillsborough: hillsborough,
  Pinellas: pinellas,
  Manatee: manatee,
};
function normCounty(c, address) {
  let s = String(c || "").toLowerCase().replace(/\s*county$/, "").trim();
  if (!s) {
    // sniff from the address text (city → county) for the Batch-1 set
    const a = address.toLowerCase();
    if (/sarasota|venice|osprey|nokomis|north port/.test(a)) s = "sarasota";
    else if (/west palm|palm beach|boca raton|delray|jupiter|boynton|wellington|lake worth|riviera beach|greenacres/.test(a)) s = "palm beach";
    else if (/tampa|brandon|riverview|valrico|lutz|plant city|ruskin|apollo beach/.test(a)) s = "hillsborough";
    else if (/pinellas|clearwater|st\.? petersburg|saint petersburg|largo|dunedin|palm harbor|seminole|pinellas park/.test(a)) s = "pinellas";
    else if (/manatee|bradenton|palmetto|parrish|lakewood ranch|ellenton/.test(a)) s = "manatee";
  }
  return s.replace(/\b\w/g, (m) => m.toUpperCase());
}

// ── helpers ───────────────────────────────────────────────────────────────
// County parcel DBs store USPS-abbreviated street types ("2046 49TH ST N"), but the
// Google geocoder spells them out ("2046 49th Street N") — so a LIKE on the raw
// geocoded string finds nothing. Abbreviate to match. (Idempotent: already-short
// forms like "AVE" aren't keys, so they pass through unchanged.)
const ST_ABBR = { STREET: "ST", AVENUE: "AVE", BOULEVARD: "BLVD", DRIVE: "DR", ROAD: "RD", LANE: "LN", COURT: "CT", PLACE: "PL", CIRCLE: "CIR", TERRACE: "TER", PARKWAY: "PKWY", PLAZA: "PLZ", HIGHWAY: "HWY", TRAIL: "TRL", SQUARE: "SQ", POINT: "PT", POINTE: "PT", CROSSING: "XING", COVE: "CV", HARBOR: "HBR", MANOR: "MNR", GARDENS: "GDNS", HOLLOW: "HOLW", BEND: "BND" };
const streetOf = (addr) => addr.split(",")[0].trim().toUpperCase().replace(/'/g, "").replace(/\./g, " ").split(/\s+/).map((w) => ST_ABBR[w] || w).filter(Boolean).join(" ");
async function j(url, opts) { const r = await fetch(url, { headers: { ...BROWSER_HDRS, ...(opts && opts.headers) }, ...opts }); if (!r.ok) throw new Error(`${url.slice(0, 60)} → ${r.status}`); return r.json(); }
async function t(url, opts) { const r = await fetch(url, { headers: { ...BROWSER_HDRS, ...(opts && opts.headers) }, redirect: "follow", ...opts }); if (!r.ok) throw new Error(`${url.slice(0, 60)} → ${r.status}`); return r.text(); }
async function imgB64(url, opts) {
  try {
    const r = await fetch(url, { headers: { ...BROWSER_HDRS, ...(opts && opts.headers) }, redirect: "follow" });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!/image\//.test(ct)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 800) return null; // empty/placeholder sketch
    return `data:${ct.split(";")[0]};base64,${buf.toString("base64")}`;
  } catch { return null; }
}

// ── SARASOTA — grnd_area IS the footprint (one ArcGIS call) + sketch GIF ─────
async function sarasota(address) {
  const street = streetOf(address);
  const where = encodeURIComponent(`fulladdress LIKE '%${street}%'`);
  const d = await j(`https://ags3.scgov.net/server/rest/services/Hosted/ParcelProperty/FeatureServer/0/query?where=${where}&outFields=account,id,fulladdress,grnd_area,living&returnGeometry=false&f=json`);
  const a = (d.features || [])[0]?.attributes; if (!a) return null;
  const account = String(a.account || a.id || "").trim();
  const footprint = Math.round(Number(a.grnd_area) || 0); if (!footprint) return null;
  let sketch = null;
  if (account.length >= 10) {
    const p = account.slice(0, 4), q = account.slice(4, 6), r = account.slice(6, 10);
    sketch = await imgB64(`https://www.sc-pa.com/sketches/${p}/${q}/${r}/_BLD/${account}_001-1.GIF`);
  }
  return { footprint_sqft: footprint, subareas: [{ desc: "Total under roof (ground)", sqft: footprint }, ...(a.living ? [{ desc: "Living", sqft: Math.round(a.living) }] : [])], sketch, parcel_id: account, matched_address: (a.fulladdress || "").trim() };
}

// ── PALM BEACH — autocomplete → sub-area table → sketch PNG ──────────────────
async function palmBeach(address) {
  const ac = await j(`https://pbcpao.gov/Property/AutoComplete?term=${encodeURIComponent(streetOf(address))}`);
  const list = (ac && Array.isArray(ac.result)) ? ac.result : (Array.isArray(ac) ? ac : []);
  const first = list.find((x) => /^P:/.test(x.value || ""));
  if (!first) return null;
  const pcn = first.value.replace(/^P:/, "").trim();
  const html = await t(`https://pbcpao.gov/Property/RenderPrintSum?parcelId=${encodeURIComponent(pcn)}&flag=ALL`);
  const subs = parseSubareaTable(html, /(BAS|FGR|FOP|FSP|FEP|FUS|SFB|UST|FCP|FGD|CAN)\b[^<]*<\/td>\s*<td[^>]*>\s*([\d,]+)/gi);
  const footprint = subs.reduce((s, x) => s + x.sqft, 0); if (!footprint) return null;
  const sketch = await imgB64(`https://pbcpao.gov/Property/GetBuildingSketch?parcelID=${encodeURIComponent(pcn)}&buildingNumber=1`);
  return { footprint_sqft: footprint, subareas: subs, sketch, parcel_id: pcn, matched_address: (first.label || "").trim() };
}

// ── HILLSBOROUGH — ArcGIS strap → ParcelData JSON → sketch PNG ───────────────
async function hillsborough(address) {
  const where = encodeURIComponent(`FullAddress LIKE '%${streetOf(address)}%'`);
  const d = await j(`https://gis.hcpafl.org/arcgis/rest/services/Webmaps/HillsboroughFL_WebParcels/MapServer/0/query?where=${where}&outFields=folio,strap,FullAddress&returnGeometry=false&f=json`, { headers: { Referer: "https://gis.hcpafl.org/PropertySearch/" } });
  const a = (d.features || [])[0]?.attributes; if (!a || !a.strap) return null;
  const strap = String(a.strap).trim();
  const pd = await j(`https://gis.hcpafl.org/CommonServices/property/search/ParcelData?pin=${encodeURIComponent(strap)}`, { headers: { Referer: "https://gis.hcpafl.org/PropertySearch/" } });
  const bld = (pd.buildings || [])[0]; if (!bld) return null;
  const subs = (bld.subAreaInfo || []).map((s) => ({ desc: s.areaType || "area", sqft: Math.round(Number(s.grossArea) || 0) })).filter((s) => s.sqft > 0);
  const footprint = subs.reduce((s, x) => s + x.sqft, 0) || Math.round(Number(bld.grossArea) || 0);
  if (!footprint) return null;
  let sketch = null;
  if (bld.sketch) sketch = await imgB64(`https://gis.hcpafl.org/CommonServices/property/sketch-image/?sketch=${encodeURIComponent(bld.sketch)}`, { headers: { Referer: "https://gis.hcpafl.org/PropertySearch/" } });
  return { footprint_sqft: footprint, subareas: subs, sketch, parcel_id: strap, matched_address: (a.FullAddress || "").trim() };
}

// ── PINELLAS — ArcGIS PIN → property-details HTML → sketch blob ──────────────
async function pinellas(address) {
  const where = encodeURIComponent(`FULLADDR LIKE '%${streetOf(address)}%'`);
  const d = await j(`https://egis.pinellas.gov/gis/rest/services/PublicWebGIS/Parcels/MapServer/0/query?where=${where}&outFields=FULLADDR,PIN_NUM&returnGeometry=false&f=json`);
  const a = (d.features || [])[0]?.attributes; if (!a || !a.PIN_NUM) return null;
  const pin = String(a.PIN_NUM).trim();
  const html = await t(`https://www.pcpao.gov/property-details?s=${encodeURIComponent(pin)}`);
  // The building-area table is server-rendered as one <tr> per sub-area:
  //   <td>Desc (CODE): </td><td>{heated}</td><td>{gross}</td>
  // then a bold "Total Area SF" row with the heated/gross totals. GROSS (the larger
  // of the two cells) is the under-roof number — a carport reads 0 heated / 240 gross.
  const cellsOf = (row) => [...row.matchAll(/<td[^>]*>\s*(?:<b>)?\s*([\d,]+)\s*(?:<\/b>)?\s*<\/td>/gi)].map((x) => num(x[1]));
  const subs = [];
  for (const row of html.split(/<\/tr>/i)) {
    const dm = row.match(/<td[^>]*>\s*([A-Za-z][^<(]*?)\s*\(([A-Z]{2,5})\)\s*:?\s*<\/td>/i);
    if (!dm) continue;
    const nums = cellsOf(row);
    if (nums.length >= 2) { const gross = Math.max(nums[nums.length - 1], nums[nums.length - 2]); if (gross > 0) subs.push({ desc: `${dm[1].trim()} (${dm[2]})`, sqft: gross }); }
  }
  // Footprint = the "Total Area SF" GROSS (larger of that row's two number cells).
  let footprint = 0;
  const totalRow = html.split(/<\/tr>/i).find((r) => /Total\s*Area\s*S\.?\s*F/i.test(r));
  if (totalRow) { const nums = cellsOf(totalRow); if (nums.length) footprint = Math.max(...nums); }
  if (!footprint && subs.length) footprint = subs.reduce((s, x) => s + x.sqft, 0);
  if (!footprint) return null;
  const sketch = await imgB64(`https://pcpao.gov/dal/blob/getBuilding/${encodeURIComponent(pin)}/1`);
  return { footprint_sqft: footprint, subareas: subs, sketch, parcel_id: pin, matched_address: (a.FULLADDR || "").trim() };
}

// ── MANATEE — one ArcGIS call (under-roof + porch sqft; sketch gated) ────────
async function manatee(address) {
  const where = encodeURIComponent(`UPPER(SITUS_ADDRESS) LIKE '%${streetOf(address)}%'`);
  const d = await j(`https://gis.manateepao.gov/arcgis/rest/services/Website/WebLayers/MapServer/0/query?where=${where}&outFields=PARID,SITUS_ADDRESS,BLDGS_SQFT_UNROOF,BLDGS_SQFT_LIVING,FEATS_SQFT_UNROOF&returnGeometry=false&f=json`);
  const a = (d.features || [])[0]?.attributes; if (!a) return null;
  const bld = Math.round(Number(a.BLDGS_SQFT_UNROOF) || 0), feat = Math.round(Number(a.FEATS_SQFT_UNROOF) || 0);
  const footprint = bld + feat; if (!footprint) return null;
  return { footprint_sqft: footprint, subareas: [{ desc: "Building under roof", sqft: bld }, ...(feat ? [{ desc: "Porch/feature under roof", sqft: feat }] : [])], sketch: null, parcel_id: String(a.PARID || ""), matched_address: (a.SITUS_ADDRESS || "").trim() };
}

// ── shared parsers ──────────────────────────────────────────────────────────
function num(s) { return Math.round(Number(String(s).replace(/[, ]/g, "")) || 0); }
// Pull {desc, sqft} rows from an HTML sub-area table. `codeFirst` = desc has a
// (CODE) suffix (Pinellas); otherwise the code leads (Palm Beach).
function parseSubareaTable(html, re, descFirst) {
  const out = []; let m;
  while ((m = re.exec(html)) !== null) {
    if (descFirst) out.push({ desc: `${m[1].trim()} (${m[2]})`, sqft: num(m[3]) });
    else out.push({ desc: m[1], sqft: num(m[2]) });
  }
  // de-dupe exact repeats the regex might catch twice
  return out.filter((x, i) => x.sqft > 0 && out.findIndex((y) => y.desc === x.desc && y.sqft === x.sqft) === i);
}

function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
