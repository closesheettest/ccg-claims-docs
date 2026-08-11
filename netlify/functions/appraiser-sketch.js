// Auto-fetch the county property-appraiser BUILDING SKETCH for an address so the
// measure tool can show it in-app (no trip to the county site, no copy-paste). The
// rep reads the wall dimensions off the sketch and types them; the tool does the rest.
//
// PASCO first (proven end-to-end): address → Pasco PA ArcGIS parcel query (PHYS_STREET)
// → parcel.aspx page → sketch.aspx?pid&bid → the sketch is an inline base64 PNG in the
// page (<img id="ContentPlaceHolder1_sketchimg" src="data:image/...">). Each county's
// mechanism differs, so this is county-by-county; unsupported counties return ok:false.
//
//   POST { address }  → { ok, county, parcel_id, address, sketches:[{ pid, bid, image }] }
//                       | { ok:false, error, unsupported? }
//
// Env: none (public county endpoints).

const PASCO_ARCGIS = "https://mapping.pascopa.com/arcgis/rest/services/Parcels/MapServer/3/query";

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  const address = String(body.address || "").trim();
  if (!address) return cors(400, JSON.stringify({ ok: false, error: "address required" }));

  // County gate — Pasco only for now. Accept an explicit county hint or sniff the text.
  const county = String(body.county || "").toLowerCase();
  const looksPasco = county.includes("pasco") || /wesley chapel|land o.?lakes|zephyrhills|dade city|new port richey|hudson|trinity|odessa|lutz/i.test(address);
  if (county && !county.includes("pasco")) {
    return cors(200, JSON.stringify({ ok: false, unsupported: true, error: `Auto-sketch isn't wired for ${body.county} yet — only Pasco so far.` }));
  }

  try {
    // 1) Street line + a LIKE key (number + first street word) for the parcel query.
    const street = address.split(",")[0].trim().toUpperCase();
    const num = (street.match(/^\d+/) || [""])[0];
    const word = (street.replace(/^\d+\s*/, "").match(/[A-Z0-9]+/) || [""])[0];
    if (!num || !word) return cors(200, JSON.stringify({ ok: false, error: "Couldn't parse a street number + name from the address." }));
    const where = `PHYS_STREET LIKE '%${num}%${word}%'`;
    const qUrl = `${PASCO_ARCGIS}?where=${encodeURIComponent(where)}&outFields=ParcelID,PHYS_STREET,PHYS_CITY,URL2&returnGeometry=false&f=json`;
    const qr = await fetch(qUrl);
    if (!qr.ok) return cors(200, JSON.stringify({ ok: false, error: `Pasco parcel lookup failed (${qr.status}).` }));
    const qd = await qr.json().catch(() => ({}));
    const feats = qd.features || [];
    if (!feats.length) return cors(200, JSON.stringify({ ok: false, error: looksPasco ? "No Pasco parcel matched that address." : "No matching parcel — is this a Pasco address?" }));
    const attr = feats[0].attributes || {};

    // 2) parcel.aspx URL lives in URL2 (an <a href=…>). Fall back to building it.
    let parcelPage = "";
    const m = String(attr.URL2 || "").match(/href=['"]([^'"]*parcel\.aspx[^'"]*)['"]/i);
    if (m) parcelPage = m[1].replace(/&amp;/g, "&");
    if (parcelPage.startsWith("http://")) parcelPage = parcelPage.replace(/^http:/, "https:");
    if (!parcelPage) return cors(200, JSON.stringify({ ok: false, error: "Found the parcel but no appraiser page link." }));

    // 3) Fetch the parcel page, find every sketch.aspx?pid=&bid= (one per building).
    const pr = await fetch(parcelPage, { headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await pr.text();
    const sketchRefs = [];
    const re = /sketch\.aspx\?pid=(\d+)&(?:amp;)?bid=(\d+)/gi;
    let sm;
    const seen = new Set();
    while ((sm = re.exec(html)) !== null) {
      const key = `${sm[1]}|${sm[2]}`;
      if (!seen.has(key)) { seen.add(key); sketchRefs.push({ pid: sm[1], bid: sm[2] }); }
    }
    if (!sketchRefs.length) return cors(200, JSON.stringify({ ok: false, error: "No building sketch on file for this parcel." }));

    // 4) Fetch each sketch page and pull the inline base64 image out of it.
    const base = parcelPage.split("/parcel.aspx")[0];
    const sketches = [];
    for (const ref of sketchRefs.slice(0, 6)) {
      try {
        const sr = await fetch(`${base}/sketch.aspx?pid=${ref.pid}&bid=${ref.bid}`, { headers: { "User-Agent": "Mozilla/5.0" } });
        const shtml = await sr.text();
        const im = shtml.match(/id=["']ContentPlaceHolder1_sketchimg["'][^>]*src=["'](data:image\/[a-z]+;base64,[^"']+)["']/i);
        if (im) sketches.push({ pid: ref.pid, bid: ref.bid, image: im[1] });
      } catch { /* skip a bad sketch */ }
    }
    if (!sketches.length) return cors(200, JSON.stringify({ ok: false, error: "Couldn't read the sketch image." }));

    return cors(200, JSON.stringify({
      ok: true, county: "Pasco", parcel_id: attr.ParcelID || null,
      address: `${(attr.PHYS_STREET || "").trim()}${attr.PHYS_CITY ? ", " + attr.PHYS_CITY : ""}`,
      sketches,
    }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
