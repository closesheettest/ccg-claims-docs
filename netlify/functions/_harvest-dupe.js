// netlify/functions/_harvest-dupe.js
//
// Shared "is there already a pin on this property?" check, so a rep can't drop a
// self-gen door on a house that's already on the map. Used by harvest-owner-check
// (to warn the instant a pin is dropped) and harvest-add-pin (the real gate that
// refuses the insert). A property is "already pinned" if an existing prospect has
// the SAME street address, or sits within ~20m of the drop point.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;

// Aggressive address normalize (drop street-type words + directionals) so
// "9123 Rockrose Drive" == "9123 ROCKROSE DR".
const normAddr = (s) => String(s || "")
  .toUpperCase().replace(/[^A-Z0-9 ]/g, " ")
  .replace(/\b(STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|COURT|CT|PLACE|PL|BOULEVARD|BLVD|CIRCLE|CIR|TERRACE|TER|WAY|HIGHWAY|HWY|PARKWAY|PKWY|TRAIL|TRL|LOOP|NORTH|N|SOUTH|S|EAST|E|WEST|W|NE|NW|SE|SW)\b/g, "")
  .replace(/\s+/g, " ").trim();

function meters(aLat, aLng, bLat, bLng) {
  const R = 6371000, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Returns the existing pin (id,name,address,status,assigned_rep_name) or null.
// `excludeId` skips a specific row (so a pin never dupe-blocks against itself).
export async function findExistingPin(lat, lng, address, excludeId) {
  if (!SB_URL || !SB_KEY || !isFinite(lat) || !isFinite(lng)) return null;
  const dLat = 0.00045, dLng = 0.00050; // ~50m candidate box
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const url = `${SB_URL}/rest/v1/canvass_prospects?select=id,name,address,status,assigned_rep_name,latitude,longitude`
    + `&latitude=gte.${lat - dLat}&latitude=lte.${lat + dLat}&longitude=gte.${lng - dLng}&longitude=lte.${lng + dLng}&limit=100`;
  const rows = (await fetch(url, { headers: sb }).then((r) => (r.ok ? r.json() : [])).catch(() => []))
    .filter((r) => !excludeId || String(r.id) !== String(excludeId));
  if (!rows.length) return null;

  // 1) same street address anywhere in the box → same property.
  const addrN = normAddr(address);
  let hit = addrN ? rows.find((r) => normAddr(r.address) === addrN) : null;
  // 2) else the closest pin within ~20m is the same property.
  if (!hit) {
    let best = null, bestD = Infinity;
    for (const r of rows) {
      if (r.latitude == null || r.longitude == null) continue;
      const d = meters(lat, lng, Number(r.latitude), Number(r.longitude));
      if (d < bestD) { bestD = d; best = r; }
    }
    if (best && bestD <= 20) hit = best;
  }
  return hit || null;
}
