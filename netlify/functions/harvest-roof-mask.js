// netlify/functions/harvest-roof-mask.js
//
// Returns Google's DETECTED roof mask as a translucent PNG overlay + its lat/lng
// bounds, so the Roof Measurement editor can paint what the automated read
// already captured. The user then only traces what's OUTSIDE the green — or does
// nothing when the whole roof is already covered.
//
// Pulls the Solar API `dataLayers` mask GeoTIFF (single-band building mask),
// colorizes it green where mask>0, and hands back a data-URL PNG placed by
// lat/lng bounds. Called lazily only when the editor opens (dataLayers costs
// more than buildingInsights: 1,000/mo free, then $0.075 each).
//
//   POST { address } | { lat, lng } → { ok, bounds:[[s,w],[n,e]], png, imagery }
//
// Env: GOOGLE_MAPS_API_KEY (Solar API + Geocoding enabled on the key).

import sharp from "sharp";
import { fromArrayBuffer } from "geotiff";
import proj4 from "proj4";

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_PLACES_API_KEY;
const GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";
const DATALAYERS = "https://solar.googleapis.com/v1/dataLayers:get";

const json = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

// proj4 def string for the GeoTIFF's EPSG. Solar dataLayers come in UTM (e.g.
// 32617 = zone 17N); handle UTM north/south + web-mercator + plain geographic.
function projDef(epsg) {
  const e = String(epsg || "");
  if (e === "4326") return WGS84;
  if (e === "3857" || e === "900913") return "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs";
  const utmN = e.match(/^326(\d\d)$/);
  if (utmN) return `+proj=utm +zone=${+utmN[1]} +datum=WGS84 +units=m +no_defs`;
  const utmS = e.match(/^327(\d\d)$/);
  if (utmS) return `+proj=utm +zone=${+utmS[1]} +south +datum=WGS84 +units=m +no_defs`;
  return null;
}

async function geocode(address) {
  const r = await fetch(`${GEOCODE}?address=${encodeURIComponent(address)}&region=us&key=${GOOGLE_KEY}`);
  const d = await r.json().catch(() => ({}));
  if (d.status !== "OK" || !d.results?.length) throw new Error(`Geocode failed: ${d.status || r.status}`);
  const loc = d.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!GOOGLE_KEY) return json(500, { ok: false, error: "GOOGLE_MAPS_API_KEY not set" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }
  let lat = body.lat != null ? +body.lat : null;
  let lng = body.lng != null ? +body.lng : null;
  const address = String(body.address || "").trim();

  try {
    if ((lat == null || lng == null) && address) { const g = await geocode(address); lat = g.lat; lng = g.lng; }
    if (lat == null || lng == null) return json(400, { ok: false, error: "address or lat/lng required" });

    // 1. dataLayers → maskUrl (relax quality so we still get a mask on MEDIUM/LOW roofs)
    let dl = null, lastErr = "";
    for (const q of ["HIGH", "MEDIUM", "LOW"]) {
      const url = `${DATALAYERS}?location.latitude=${lat}&location.longitude=${lng}&radiusMeters=35&view=FULL_LAYERS&requiredQuality=${q}&key=${GOOGLE_KEY}`;
      const r = await fetch(url);
      if (r.ok) { dl = await r.json(); break; }
      lastErr = `${r.status} @${q}`;
      if (r.status !== 404) break;
    }
    if (!dl || !dl.maskUrl) return json(502, { ok: false, error: `dataLayers: ${lastErr || "no maskUrl"}` });

    // 2. fetch the mask GeoTIFF
    const mr = await fetch(`${dl.maskUrl}&key=${GOOGLE_KEY}`);
    if (!mr.ok) return json(502, { ok: false, error: `mask fetch ${mr.status}` });
    const buf = await mr.arrayBuffer();

    // 3. decode
    const tiff = await fromArrayBuffer(buf);
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    const rasters = await image.readRasters();
    const band = rasters[0];               // single-band building mask
    const bbox = image.getBoundingBox();   // [minX, minY, maxX, maxY] in file CRS
    const gk = image.getGeoKeys() || {};

    // 4. RGBA PNG — green + translucent where mask>0, transparent elsewhere
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      if (band[i] > 0) {
        rgba[i * 4] = 34; rgba[i * 4 + 1] = 197; rgba[i * 4 + 2] = 94; rgba[i * 4 + 3] = 130;
      }
    }
    const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();

    // 5. bounds → lat/lng via proj4 (the GeoTIFF is UTM, e.g. EPSG:32617).
    const epsg = gk.ProjectedCSTypeGeoKey || gk.ProjectedCRSGeoKey || gk.GeographicTypeGeoKey || null;
    const def = projDef(epsg);
    if (!def) return json(502, { ok: false, error: `Unsupported mask CRS EPSG:${epsg}` });
    const toLL = (x, y) => proj4(def, WGS84, [x, y]);   // → [lng, lat]
    const [wLng, sLat] = toLL(bbox[0], bbox[1]);         // SW corner (minX, minY)
    const [eLng, nLat] = toLL(bbox[2], bbox[3]);         // NE corner (maxX, maxY)
    const bounds = [[sLat, wLng], [nLat, eLng]];

    return json(200, {
      ok: true,
      bounds,
      png: `data:image/png;base64,${png.toString("base64")}`,
      epsg: epsg || "3857(assumed)",
      imagery: { date: dl.imageryDate || null, quality: dl.imageryQuality || null },
    });
  } catch (e) {
    return json(502, { ok: false, error: e.message || "mask failed", input: address || `${lat},${lng}` });
  }
};
