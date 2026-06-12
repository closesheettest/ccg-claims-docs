// Shared Florida territory model — county → Zone.
//
// Single source of truth for every CCG function that decides a deal's zone
// from WHERE THE PROPERTY IS (no-sits, back-to-retail, no-damage) instead of
// from the rep. Mirrors TMS lib/zones.js (the same map used to assign reps to
// zones in the territory switch). If the owner moves counties between zones,
// update this map (and TMS lib/zones.js) together.

const ZONE_COUNTIES = {
  "Zone 1": ["Nassau", "Duval", "Baker", "Union", "Bradford", "Clay", "St. Johns", "Putnam", "Flagler", "Alachua", "Levy", "Marion", "Sumter", "Lake", "Seminole", "Volusia"],
  "Zone 2": ["Pasco", "Hillsborough", "Polk", "Osceola", "Indian River", "Highlands", "Citrus", "Hernando"],
  "Zone 3": ["Pinellas", "Manatee", "Sarasota", "Charlotte", "Lee", "Collier", "Monroe", "Hardee", "DeSoto", "Glades", "Hendry", "St. Lucie", "Okeechobee"],
  "Zone 4": ["Martin", "Palm Beach", "Broward", "Miami-Dade"],
};

// Brevard & Orange straddle Rt 50: north → Zone 1, south → Zone 2.
const SPLIT_LAT = 28.55;
const ZONE_ORDER = ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];

function normCounty(s) {
  return String(s || "").toLowerCase().replace(/\bcounty\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

const COUNTY_ZONE = (() => {
  const m = {};
  for (const [z, cs] of Object.entries(ZONE_COUNTIES)) for (const c of cs) m[normCounty(c)] = z;
  return m;
})();

// county name (+ lat for the two split counties) → Zone string, or
// "Unassigned" when we can't place it.
function countyToZone(county, lat) {
  const n = normCounty(county);
  if (!n) return "Unassigned";
  if (n === "brevard" || n === "orange") return (lat != null && lat >= SPLIT_LAT) ? "Zone 1" : "Zone 2";
  return COUNTY_ZONE[n] || "Unassigned";
}

module.exports = { ZONE_COUNTIES, ZONE_ORDER, countyToZone, normCounty };
