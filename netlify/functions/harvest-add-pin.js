// netlify/functions/harvest-add-pin.js
//
// A rep out in the field spots a damaged roof and drops their OWN pin on it. This
// creates a self-generated Inspection-Lead row in canvass_prospects at that
// lat/lng, owned by the rep, tagged extra.self_generated=true so:
//   • it shows as a distinct self-gen pin on the map (and persists),
//   • the three actions (Sign Inspection / Retail Appt / Pending) work on it like
//     any inspection pin, and
//   • when it reaches JobNimbus the lead source reads "Self Generated".
//
//   POST { rt, lat, lng, address, city, state, zip, owner, homestead, verdict, parcel_id }
//   → { ok, id, pin }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

import { findExistingPin } from "./_harvest-dupe.js";

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }

  const rt = String(body.rt || "").trim();
  const lat = Number(body.lat), lng = Number(body.lng);
  if (!UUID.test(rt)) return json(401, { ok: false, error: "Invalid link" });
  if (!isFinite(lat) || !isFinite(lng)) return json(400, { ok: false, error: "lat/lng required" });

  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
  const sbGet = (path) => fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }).then((r) => (r.ok ? r.json() : [])).catch(() => []);

  const rep = (await sbGet(`sales_reps?harvest_token=eq.${encodeURIComponent(rt)}&select=id,name,jobnimbus_id&limit=1`))[0];
  if (!rep) return json(401, { ok: false, error: "Invalid link" });

  // Fail-safe: never drop a second pin on a property that's already on the map.
  const dupe = await findExistingPin(lat, lng, String(body.address || "").trim());
  if (dupe) {
    return json(409, {
      ok: false, duplicate: true,
      error: "There's already a pin on this property.",
      existing: { id: dupe.id, name: dupe.name || "", address: dupe.address || "", status: dupe.status || "", rep: dupe.assigned_rep_name || "" },
    });
  }

  const row = {
    list_name: "Self-Generated",
    name: String(body.owner || "").trim() || null,
    address: String(body.address || "").trim() || null,
    city: String(body.city || "").trim() || null,
    state: String(body.state || "FL").trim() || "FL",
    zip: String(body.zip || "").trim() || null,
    latitude: lat, longitude: lng,
    geocode_status: "ok",
    status: "insp",                 // Inspection Lead → Sign / BTR / Pending all apply
    status_by: rep.name || null,
    assigned_rep_id: rep.id,
    assigned_rep_name: rep.name || null,
    extra: {
      self_generated: true,
      created_by: rep.name || null,
      created_by_jn: rep.jobnimbus_id || null,   // stable owner id for the "belongs to X" gate
      owner: String(body.owner || "").trim() || null,
      homestead: body.homestead === true,
      occupancy: String(body.verdict || "").trim() || null,
      parcel_id: String(body.parcel_id || "").trim() || null,
    },
  };

  const ins = await fetch(`${SB_URL}/rest/v1/canvass_prospects`, {
    method: "POST",
    headers: { ...sb, Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  if (!ins.ok) return json(500, { ok: false, error: (await ins.text().catch(() => "")).slice(0, 200) || "insert failed" });
  const pin = ((await ins.json().catch(() => []))[0]) || {};
  return json(200, { ok: true, id: pin.id, pin });
};

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) };
}
