// netlify/functions/harvest-owner-check.js
//
// "Owner occupied?" for a rep-dropped self-gen pin. Given a lat/lng (the roof the
// rep is standing in front of), look the parcel up in Florida's FREE statewide
// cadastral service (all 67 counties, no API key) and decide whether the OWNER
// LIVES THERE — the money question before you knock.
//
// Signals, best first:
//   1. Homestead exemption on file (JV_HMSTD > 0)  → owner's primary residence.
//   2. Owner's MAILING address == the PROPERTY address → they live there.
//   If neither → owner's mail goes elsewhere, so it's probably a rental.
//
// The same parcel record also carries the property's real street address, so this
// doubles as the reverse-geocoder for the dropped pin (no separate geocode call).
//
//   POST { lat, lng } → {
//     ok, found, owner_occupied, verdict, reason,
//     owner, address:{line1,city,state,zip}, mailing:{line1,city,state,zip},
//     homestead, parcel_id
//   }
//
// Data: FL Dept. of Revenue statewide cadastral (updated yearly from all county
// property appraisers). Public ArcGIS FeatureServer — no key, no cost.

const LAYER =
  "https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query";
const FIELDS =
  "PARCEL_ID,OWN_NAME,OWN_ADDR1,OWN_CITY,OWN_STATE,OWN_ZIPCD,PHY_ADDR1,PHY_CITY,PHY_ZIPCD,JV_HMSTD,AV_HMSTD";

const norm = (s) =>
  String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\b(STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|COURT|CT|PLACE|PL|BOULEVARD|BLVD|CIRCLE|CIR|TERRACE|TER|WAY|HIGHWAY|HWY|PARKWAY|PKWY|TRAIL|TRL|LOOP|NORTH|N|SOUTH|S|EAST|E|WEST|W|NE|NW|SE|SW)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

// Query the cadastral service at a point. First try the parcel the point sits IN;
// if the geocode landed just off the polygon, retry with a small radius.
async function lookupParcel(lat, lng) {
  const base = {
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: FIELDS,
    returnGeometry: "false",
    f: "json",
  };
  const run = async (extra) => {
    const qs = new URLSearchParams({ ...base, ...extra }).toString();
    const r = await fetch(`${LAYER}?${qs}`, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`arcgis ${r.status}`);
    const d = await r.json();
    return (d.features || [])[0]?.attributes || null;
  };
  // exact hit → then a small 18m buffer fallback for rooftop-vs-parcel drift
  // (kept tight so a near-miss doesn't grab the neighbor's parcel).
  let a = await run({});
  if (!a) a = await run({ distance: "18", units: "esriSRUnit_Meter" });
  return a;
}

// "MCCONNELL, JAMES H" → "James H Mcconnell"; leaves company names alone-ish.
function prettyOwner(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const title = (w) => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w;
  if (s.includes(",")) {
    const [last, rest] = s.split(",");
    return `${rest.trim().split(/\s+/).map(title).join(" ")} ${last.trim().split(/\s+/).map(title).join(" ")}`.trim();
  }
  return s.split(/\s+/).map(title).join(" ");
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!isFinite(lat) || !isFinite(lng)) return json(400, { ok: false, error: "lat/lng required" });

  let a;
  try {
    a = await lookupParcel(lat, lng);
  } catch (e) {
    return json(200, { ok: false, found: false, error: "lookup service unavailable", detail: String(e).slice(0, 120) });
  }
  if (!a) {
    return json(200, {
      ok: true, found: false,
      verdict: "no_parcel",
      reason: "Couldn't find a parcel here — drop the pin right on the rooftop and try again.",
    });
  }

  const homestead = Number(a.JV_HMSTD || 0) > 0 || Number(a.AV_HMSTD || 0) > 0;
  const mailLine = norm(a.OWN_ADDR1);
  const phyLine = norm(a.PHY_ADDR1);
  const mailMatch = !!mailLine && mailLine === phyLine;
  const owner_occupied = homestead || mailMatch;

  let verdict, reason;
  if (homestead) {
    verdict = "owner_occupied";
    reason = "Florida homestead exemption on file — this is the owner's primary residence.";
  } else if (mailMatch) {
    verdict = "owner_occupied";
    reason = "Owner's mailing address is this property — they live here (no homestead on file).";
  } else {
    verdict = "non_owner_occupied";
    reason = "No homestead and the owner's mail goes to a different address — likely a rental / non-owner-occupied.";
  }

  return json(200, {
    ok: true,
    found: true,
    owner_occupied,
    verdict,
    reason,
    homestead,
    owner: prettyOwner(a.OWN_NAME),
    owner_raw: a.OWN_NAME || "",
    parcel_id: a.PARCEL_ID || "",
    address: { line1: a.PHY_ADDR1 || "", city: a.PHY_CITY || "", state: "FL", zip: String(a.PHY_ZIPCD || "") },
    mailing: { line1: a.OWN_ADDR1 || "", city: a.OWN_CITY || "", state: a.OWN_STATE || "", zip: String(a.OWN_ZIPCD || "") },
  });
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) };
}
