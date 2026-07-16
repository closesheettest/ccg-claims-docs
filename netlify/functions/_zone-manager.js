// netlify/functions/_zone-manager.js
//
// Shared: resolve a Florida zone's REGIONAL MANAGER (JobNimbus id) from a
// home's lat/lng + county, so a booking can be routed to the manager who runs
// that zone. Zone = the zone of the nearest active senior rep within 50 mi
// (the rep who'd have been auto-assigned), else the county's primary zone.
// Mirrors the zone/radius logic in setter-book-appointment.js.
//
//   resolveManager(lat, lng, county) → { id, name, zone, repInRange }
//     id = manager's jobnimbus_id (null if no manager maps to the zone)

const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
const ZONE_COUNTIES = {
  "Zone 1": ["Nassau", "Duval", "Baker", "Union", "Bradford", "Clay", "St. Johns", "Putnam", "Flagler", "Alachua", "Levy", "Marion", "Sumter", "Lake", "Seminole", "Volusia", "Brevard", "Orange"],
  "Zone 2": ["Orange", "Brevard", "Pasco", "Hillsborough", "Polk", "Osceola", "Indian River", "Highlands", "Citrus", "Hernando"],
  "Zone 3": ["Pinellas", "Manatee", "Sarasota", "Charlotte", "Lee", "Collier", "Monroe", "Hardee", "DeSoto", "Glades", "Hendry", "St. Lucie", "Okeechobee"],
  "Zone 4": ["Martin", "Palm Beach", "Broward", "Miami-Dade"],
};
const normCounty = (c) => String(c || "").toLowerCase().replace(/county/g, "").replace(/[^a-z]+/g, " ").trim();
const COUNTY_ZONES = (() => { const m = {}; for (const [z, l] of Object.entries(ZONE_COUNTIES)) for (const c of l) (m[normCounty(c)] = m[normCounty(c)] || []).push(z); return m; })();
function haversineMi(la1, lo1, la2, lo2) { const R = 3958.8, t = (d) => d * Math.PI / 180; const dLa = t(la2 - la1), dLo = t(lo2 - lo1); const a = Math.sin(dLa / 2) ** 2 + Math.cos(t(la1)) * Math.cos(t(la2)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); }

export function fetchReps() {
  return fetch(REP_ZONES_URL).then((r) => (r.ok ? r.json().then((j) => j.reps || []) : [])).catch(() => []);
}

export async function resolveManager(lat, lng, county, repsCache) {
  const reps = repsCache || (await fetchReps());
  const zonesForCounty = COUNTY_ZONES[normCounty(county)] || ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];
  let zone = null, repInRange = false;
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const near = reps
      .filter((r) => r.active && r.jobnimbus_id && String(r.rep_level || "").toLowerCase() === "senior" && zonesForCounty.includes(r.zone) && r.latitude != null && r.longitude != null)
      .map((r) => ({ zone: r.zone, d: haversineMi(lat, lng, r.latitude, r.longitude) }))
      .filter((r) => r.d <= 50)
      .sort((a, b) => a.d - b.d);
    if (near.length) { zone = near[0].zone; repInRange = true; }
  }
  if (!zone) zone = zonesForCounty[0];
  const m = reps.find((r) => r.managed_region === zone && r.jobnimbus_id);
  return { id: m ? m.jobnimbus_id : null, name: m ? m.name : "", zone, repInRange };
}
