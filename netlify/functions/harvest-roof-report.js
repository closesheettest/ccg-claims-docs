// netlify/functions/harvest-roof-report.js
//
// DIY roof measurement — "build it ourselves" instead of paying Roofr per report.
// Given an address (or a lat/lng from a dropped self-gen pin), ask Google's Solar
// API for the building's roof geometry and turn it into roofing numbers:
//   • total roof SURFACE area (slope-corrected) → squares
//   • ground FOOTPRINT area (flat projection)   → squares (for comparison)
//   • per-plane pitch (as degrees AND x/12) + azimuth + area
//   • average pitch, plane count, imagery date + quality
//
// This is NOT visible anywhere in the app yet — it's a test endpoint so we can
// compare its output against a known Roofr report before building any UI.
//
// The hard part (turning satellite pixels into 3D roof planes + pitch) is done by
// Google's already-trained model; we're only assembling the report on top of it.
//
//   POST { address } | { lat, lng }  →  {
//     ok, source:"google-solar",
//     input, location:{lat,lng},
//     imagery:{ date, quality },
//     roof:{
//       surface_squares, footprint_squares,
//       surface_area_m2, footprint_area_m2,
//       avg_pitch_deg, avg_pitch_x12, plane_count,
//       implied_slope_factor
//     },
//     planes:[ { area_m2, ground_m2, pitch_deg, pitch_x12, azimuth_deg, slope_factor } ],
//     raw_whole_roof
//   }
//
// Env: GOOGLE_MAPS_API_KEY (or VITE_GOOGLE_PLACES_API_KEY). The Solar API must be
// enabled on that Google Cloud project (Maps geocoding already is).

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_PLACES_API_KEY;
const GEOCODE = "https://maps.googleapis.com/maps/api/geocode/json";
const SOLAR = "https://solar.googleapis.com/v1/buildingInsights:findClosest";

const SQ_M_PER_SQUARE = 9.290304;   // 100 sq ft in m²
// Calibration: our satellite footprint runs ~4.5% under Roofr across 72 measured
// roofs (the effective wall→drip-edge gap). ×1.045 centers our numbers on Roofr.
const CAL = 1.045;
const R2D = 180 / Math.PI;

const json = (code, obj) => ({
  statusCode: code,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

const sq = (m2) => (m2 == null ? null : +(m2 / SQ_M_PER_SQUARE).toFixed(2));
const pitchToX12 = (deg) => (deg == null ? null : +(Math.tan(deg / R2D) * 12).toFixed(1));
const slopeFactor = (deg) => (deg == null ? null : +(1 / Math.cos(deg / R2D)).toFixed(4));

// Flat vs sloped boundary: a plane shallower than this (in x/12) is low-slope —
// it takes membrane or metal, not shingle — so it's priced separately. Roofr uses
// the same ~2/12 line (it buckets 0/12 and 2/12 as "flat", 3/12+ as "pitched").
const DEFAULT_FLAT_CUTOFF_X12 = 2.5;

// Waste rules. Metal is a flat 10% everywhere. Shingle floors at 10% and bumps
// with how cut-up the roof is — we have no valley/hip footage from Google, so we
// use plane count as a complexity proxy (a simple gable vs a chopped-up hip).
// Every value is overridable per request.
function shingleWastePct(planeCount) {
  if (planeCount >= 9) return 15;   // heavily cut up
  if (planeCount >= 5) return 12;   // moderate hip/valley
  return 10;                        // simple gable — the floor
}

// Statewide FL parcel lookup — pulls the county's building living area (heated
// sq ft) at a point, to pre-fill the appraiser-sqft override. Living area misses
// garage/porch, so it's a starting point the rep bumps up. FL only; null else.
async function fetchLivingArea(lat, lng) {
  try {
    const params = new URLSearchParams({
      geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
      geometryType: "esriGeometryPoint", inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "TOT_LVG_AR,LND_SQFOOT,ACT_YR_BLT,NO_BULDNG", returnGeometry: "false", f: "json",
    });
    const r = await fetch(`https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query?${params}`);
    const a = (await r.json())?.features?.[0]?.attributes;
    if (!a || !a.TOT_LVG_AR) return null;
    return { living_sqft: Math.round(a.TOT_LVG_AR), land_sqft: a.LND_SQFOOT || null, year_built: a.ACT_YR_BLT || null, buildings: a.NO_BULDNG || null };
  } catch { return null; }
}

// FEMA "USA Structures" — an independent, imagery-derived roof-outline footprint
// (nationwide). We use it only to CROSS-CHECK the satellite read: if the two
// footprints disagree a lot, the satellite likely grabbed the wrong/partial
// building. Returns footprint sq ft, or null.
async function fetchFemaFootprintSqft(lat, lng) {
  try {
    const params = new URLSearchParams({
      geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
      geometryType: "esriGeometryPoint", inSR: "4326", outSR: "4326",
      spatialRel: "esriSpatialRelIntersects", returnGeometry: "true", outFields: "", f: "json",
    });
    const r = await fetch(`https://services2.arcgis.com/FiaPA4ga0iQKduv3/ArcGIS/rest/services/USA_Structures_View/FeatureServer/0/query?${params}`);
    const ring = (await r.json())?.features?.[0]?.geometry?.rings?.[0];
    if (!ring || ring.length < 4) return null;
    const mLat = 110540, mLng = 111320 * Math.cos((lat * Math.PI) / 180);
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const x1 = ring[i][0] * mLng, y1 = ring[i][1] * mLat, x2 = ring[i + 1][0] * mLng, y2 = ring[i + 1][1] * mLat;
      a += x1 * y2 - x2 * y1;
    }
    return Math.round((Math.abs(a) / 2) * 10.7639);
  } catch { return null; }
}

async function geocode(address) {
  const url = `${GEOCODE}?address=${encodeURIComponent(address)}&region=us&key=${GOOGLE_KEY}`;
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (d.status !== "OK" || !d.results?.length) {
    throw new Error(`Geocode failed: ${d.status || r.status}${d.error_message ? ` — ${d.error_message}` : ""}`);
  }
  const loc = d.results[0].geometry.location;
  const comps = d.results[0].address_components || [];
  const cc = comps.find((c) => (c.types || []).includes("administrative_area_level_2"));
  const county = cc ? cc.long_name : null; // e.g. "Pasco County"
  return { lat: loc.lat, lng: loc.lng, formatted: d.results[0].formatted_address, county };
}

// Ask Solar for the closest building. requiredQuality is a MINIMUM — try HIGH
// first (most accurate), then relax so a house that only has MEDIUM/LOW coverage
// still returns something rather than a bare 404.
async function fetchSolar(lat, lng) {
  let lastErr = "";
  for (const q of ["HIGH", "MEDIUM", "LOW"]) {
    const url = `${SOLAR}?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=${q}&key=${GOOGLE_KEY}`;
    const r = await fetch(url);
    if (r.ok) return await r.json();
    const body = await r.text().catch(() => "");
    let reason = "";
    try { reason = JSON.parse(body)?.error?.details?.[0]?.reason || ""; } catch { /* not json */ }
    lastErr = `${r.status} @${q}${reason ? ` [${reason}]` : ""}: ${body.slice(0, 700)}`;
    // 404 = no building at that quality → try the next (lower) tier. Any other
    // status (403 not-enabled, 400 bad-arg) won't fix by relaxing quality — stop.
    if (r.status !== 404) break;
  }
  throw new Error(`Solar API: ${lastErr}`);
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!GOOGLE_KEY) return json(500, { ok: false, error: "GOOGLE_MAPS_API_KEY not set" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }

  let lat = body.lat != null ? +body.lat : null;
  let lng = body.lng != null ? +body.lng : null;
  const address = String(body.address || "").trim();
  let formatted = null;
  let county = null;

  try {
    if ((lat == null || lng == null) && address) {
      const g = await geocode(address);
      lat = g.lat; lng = g.lng; formatted = g.formatted; county = g.county;
    }
    if (lat == null || lng == null) return json(400, { ok: false, error: "address or lat/lng required" });

    const data = await fetchSolar(lat, lng);
    const sp = data.solarPotential || {};
    const whole = sp.wholeRoofStats || {};
    const segs = Array.isArray(sp.roofSegmentStats) ? sp.roofSegmentStats : [];

    // Per-plane: Solar gives areaMeters2 (true sloped surface) AND groundAreaMeters2
    // (flat footprint) per segment, plus pitchDegrees. Roofing squares should track
    // the SURFACE area; the footprint is there to sanity-check the slope factor.
    const planes = segs.map((s) => {
      const st = s.stats || {};
      return {
        area_m2: st.areaMeters2 != null ? +st.areaMeters2.toFixed(2) : null,
        ground_m2: st.groundAreaMeters2 != null ? +st.groundAreaMeters2.toFixed(2) : null,
        pitch_deg: s.pitchDegrees != null ? +s.pitchDegrees.toFixed(1) : null,
        pitch_x12: pitchToX12(s.pitchDegrees),
        azimuth_deg: s.azimuthDegrees != null ? Math.round(s.azimuthDegrees) : null,
        slope_factor: slopeFactor(s.pitchDegrees),
        // extra structure for the line engine: facet HEIGHT (pins the 2-story vs
        // 1-story step) and CENTER (which footprint region the facet sits over)
        height_m: s.planeHeightAtCenterMeters != null ? +s.planeHeightAtCenterMeters.toFixed(2) : null,
        center: s.center ? { lat: s.center.latitude, lng: s.center.longitude } : null,
      };
    });

    // PREDOMINANT pitch (matches Roofr): the pitch of the roof's DOMINANT SLOPE
    // CLUSTER, not a whole-roof average. A plain average folds a flat lanai and
    // steep-outlier misreads into the number — Cheval's blended avg is 7.29/12 (a
    // 71 m² flat porch drags it down) but the shingle is 8/12, which Roofr shows.
    // A pure "biggest integer bucket" is the opposite failure: Cheval's fine, but
    // a simple 5.5/12 gable whose two identical sides get read as 5.2 & 5.8 splits
    // into buckets 5 and 6 and mis-picks 5 (Hollybrook → Roofr says 6). So: bucket
    // the SLOPED planes (flat planes excluded — they're membrane/metal), take the
    // mode bucket, then area-weight-average the planes within ±1 of it. That merges
    // a noise-split main plane while still shedding flat + steep-outlier facets.
    const sloped = planes.filter((p) => p.pitch_x12 != null && p.area_m2 && p.pitch_x12 >= DEFAULT_FLAT_CUTOFF_X12);
    let pitchX12 = null;
    if (sloped.length) {
      const buckets = new Map(); // whole x/12 → sloped m²
      for (const p of sloped) { const k = Math.round(p.pitch_x12); buckets.set(k, (buckets.get(k) || 0) + p.area_m2); }
      let mode = null, best = -1;
      for (const [k, area] of buckets) if (area > best) { best = area; mode = k; }
      const cluster = sloped.filter((p) => Math.abs(Math.round(p.pitch_x12) - mode) <= 1);
      let wSum = 0, pSum = 0;
      for (const p of cluster) { wSum += p.area_m2; pSum += p.pitch_x12 * p.area_m2; }
      pitchX12 = wSum ? Math.round(pSum / wSum) : mode;
    } else {
      // whole roof is low-slope — report the flat predominant so the number isn't null
      let wSum = 0, pSum = 0;
      for (const p of planes) if (p.pitch_x12 != null && p.area_m2) { wSum += p.area_m2; pSum += p.pitch_x12 * p.area_m2; }
      pitchX12 = wSum ? Math.round(pSum / wSum) : null;
    }
    const avgPitchDeg = pitchX12 != null ? +(Math.atan(pitchX12 / 12) * R2D).toFixed(1) : null;

    const surfaceM2 = whole.areaMeters2 != null ? +(whole.areaMeters2 * CAL).toFixed(2) : null;
    const groundM2 = whole.groundAreaMeters2 != null ? +(whole.groundAreaMeters2 * CAL).toFixed(2) : null;

    // ── Material split + waste. Flat (low-slope) and sloped take different
    // materials at different prices, so bucket each plane by pitch, then apply
    // the waste rules. All knobs are optional request inputs:
    //   flat_cutoff_x12, flat_material ("membrane"|"metal"), sloped_material
    //   ("shingle"|"metal"), prices:{shingle,metal,membrane} ($/sq),
    //   waste_override:{flat,sloped} (percent).
    const flatCutoff = body.flat_cutoff_x12 != null ? +body.flat_cutoff_x12 : DEFAULT_FLAT_CUTOFF_X12;
    const flatMaterial = String(body.flat_material || "membrane").toLowerCase();
    const slopedMaterial = String(body.sloped_material || "shingle").toLowerCase();
    const prices = body.prices || {};
    const wasteOverride = body.waste_override || {};

    const isFlat = (p) => p.pitch_x12 != null && p.pitch_x12 < flatCutoff;
    const sumM2 = (arr) => arr.reduce((a, p) => a + (p.area_m2 || 0), 0);
    const flatM2 = +(sumM2(planes.filter(isFlat)) * CAL).toFixed(2);
    const slopedM2 = +(sumM2(planes.filter((p) => !isFlat(p))) * CAL).toFixed(2);

    // Metal → flat 10%. Shingle → max(10%, complexity bump). Override wins.
    const slopedWaste = wasteOverride.sloped != null ? +wasteOverride.sloped
      : (slopedMaterial === "metal" ? 10 : shingleWastePct(planes.length));
    const flatWaste = wasteOverride.flat != null ? +wasteOverride.flat : 10;

    const bucket = (m2, material, wastePct) => {
      const measured = sq(m2);
      const order = measured != null ? +(measured * (1 + wastePct / 100)).toFixed(2) : null;
      const price = prices[material] != null ? +prices[material] : null;
      return {
        material,
        measured_squares: measured,
        waste_pct: wastePct,
        order_squares: order,
        price_per_square: price,
        est_cost: (price != null && order != null) ? +(price * order).toFixed(2) : null,
      };
    };

    const slopedBucket = bucket(slopedM2, slopedMaterial, slopedWaste);
    const flatBucket = bucket(flatM2, flatMaterial, flatWaste);

    // Whole roof as a METAL build — an alternative to the shingle+membrane split.
    // Metal is a flat 10% waste over the entire surface (sloped + flat).
    const metalMeasured = sq(surfaceM2);
    const metalOrder = metalMeasured != null ? +(metalMeasured * 1.10).toFixed(2) : null;
    const metal = {
      material: "metal",
      measured_squares: metalMeasured,
      waste_pct: 10,
      order_squares: metalOrder,
      price_per_square: prices.metal != null ? +prices.metal : null,
      est_cost: (prices.metal != null && metalOrder != null) ? +(prices.metal * metalOrder).toFixed(2) : null,
    };
    const estTotal = (slopedBucket.est_cost != null || flatBucket.est_cost != null)
      ? +((slopedBucket.est_cost || 0) + (flatBucket.est_cost || 0)).toFixed(2) : null;

    const materials = {
      flat_cutoff_x12: flatCutoff,
      complexity: planes.length >= 9 ? "high" : planes.length >= 5 ? "moderate" : "simple",
      sloped: slopedBucket,
      flat: flatBucket,
      metal,
      est_total_cost: estTotal,
      note: "The flat/sloped split is an estimate — treat per-material numbers as a starting point, not a firm material takeoff.",
    };

    const [appraiser, femaSqft] = await Promise.all([fetchLivingArea(lat, lng), fetchFemaFootprintSqft(lat, lng)]);

    // Cross-source confidence: compare our (calibrated) footprint against FEMA's
    // independent roof outline, de-biased to Roofr. A big gap = probable wrong/
    // partial building — flag it so the rep verifies with the trace or appraiser.
    const FEMA_BIAS = 0.895;
    let confidence = null;
    if (femaSqft && groundM2) {
      const satSqft = groundM2 * 10.7639;          // already ×CAL
      const femaEst = femaSqft / FEMA_BIAS;
      const delta = Math.abs(satSqft - femaEst) / Math.max(satSqft, femaEst);
      confidence = { level: delta > 0.2 ? "low" : "high", delta_pct: Math.round(delta * 100), satellite_sqft: Math.round(satSqft), fema_sqft: femaSqft };
    }

    return json(200, {
      ok: true,
      source: "satellite",
      input: address || `${lat},${lng}`,
      geocoded_as: formatted,
      county,
      location: { lat, lng },
      appraiser,
      confidence,
      imagery: { date: data.imageryDate || null, quality: data.imageryQuality || null },
      roof: {
        surface_squares: sq(surfaceM2),
        footprint_squares: sq(groundM2),
        surface_area_m2: surfaceM2,
        footprint_area_m2: groundM2,
        avg_pitch_deg: avgPitchDeg,
        avg_pitch_x12: pitchX12,
        plane_count: planes.length,
        implied_slope_factor: (surfaceM2 && groundM2) ? +(surfaceM2 / groundM2).toFixed(4) : null,
      },
      materials,
      planes,
      raw_whole_roof: whole,
    });
  } catch (e) {
    return json(502, { ok: false, error: e.message || "roof report failed", input: address || `${lat},${lng}` });
  }
};
