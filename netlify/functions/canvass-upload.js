// netlify/functions/canvass-upload.js
//
// Bulk-add prospects to the canvassing map. The office pastes/uploads a list of
// addresses; we geocode each with Google and insert it as status 'iq'. Reads/
// status-updates happen client-side via the anon key — this function only
// handles the geocode-heavy ingest so it doesn't block the browser.
//
// POST { list_name?, rows: [{ address, name?, city?, state?, zip? }] }
//   (also accepts rows as plain strings, one full address each)
// → { ok, inserted, geocoded, failed, list_name }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, GOOGLE_MAPS_API_KEY
//      (or VITE_GOOGLE_PLACES_API_KEY)

import { randomUUID } from "crypto";

const GOOGLE_BASE = "https://maps.googleapis.com/maps/api/geocode/json";
const MAX_ROWS = 400;       // cap per call to stay under the function timeout
const CONCURRENCY = 8;      // parallel geocode requests

// Normalized street key so the same house dedups across sources/spelling despite
// geocode drift ("12735 NEWTON PL" == "12735 Newton Place"). Matches the JN sync.
const ADDR_SUF = { street: "st", st: "st", avenue: "ave", ave: "ave", av: "ave", place: "pl", pl: "pl", drive: "dr", dr: "dr", lane: "ln", ln: "ln", court: "ct", ct: "ct", terrace: "ter", terr: "ter", ter: "ter", boulevard: "blvd", blvd: "blvd", road: "rd", rd: "rd", circle: "cir", cir: "cir", trail: "trl", trl: "trl", parkway: "pkwy", pkwy: "pkwy", highway: "hwy", hwy: "hwy", cove: "cv", cv: "cv", point: "pt", pt: "pt", square: "sq", sq: "sq" };
const ADDR_DIR = { north: "n", n: "n", south: "s", s: "s", east: "e", e: "e", west: "w", w: "w", northeast: "ne", ne: "ne", northwest: "nw", nw: "nw", southeast: "se", se: "se", southwest: "sw", sw: "sw" };
function streetKey(address) {
  const s = String(address || "").split(",")[0].toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || !/^\d/.test(s)) return null;
  return s.split(" ").map((t) => ADDR_SUF[t] || ADDR_DIR[t] || t).join(" ");
}
function zip5(z) { return String(z || "").replace(/\D/g, "").slice(0, 5); }
function addrKey(address, zip) { const sk = streetKey(address); return sk ? sk + "|" + zip5(zip) : null; }

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
  const googleKey = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_PLACES_API_KEY;
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "Missing Supabase env" });
  if (!googleKey) return json(500, { ok: false, error: "Missing GOOGLE_MAPS_API_KEY" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Invalid JSON body" }); }

  const sbH = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

  // Chunked upload: the browser sends batches, each tagged with a shared upload_id,
  // then a final `finalize` call logs ONE harvest_uploads row for the whole thing.
  if (body.finalize) {
    await fetch(`${SB_URL}/rest/v1/harvest_uploads`, {
      method: "POST", headers: { ...sbH, Prefer: "return=minimal" },
      body: JSON.stringify({
        id: body.upload_id || randomUUID(),
        list_name: (body.list_name || "").toString().trim() || `List ${new Date().toISOString().slice(0, 10)}`,
        default_type: (body.default_type || "iq").toString().trim().toLowerCase(),
        inserted: body.inserted || 0, updated: body.updated || 0, skipped: body.skipped || 0,
        uploaded_by: (body.uploaded_by || "").toString().trim() || null,
        uploaded_at: new Date().toISOString(),
      }),
    }).catch(() => {});
    return json(200, { ok: true, finalized: true });
  }
  // Valid pin-type keys + which are terminal (protected from re-upload).
  const validKeys = new Set();
  const terminalKeys = new Set();
  try {
    for (const t of await sbGet(`${SB_URL}/rest/v1/harvest_pin_types?select=key,is_terminal`, sbH)) {
      validKeys.add(t.key);
      if (t.is_terminal) terminalKeys.add(t.key);
    }
  } catch { /* config unreachable — fall back to defaults below */ }
  if (!validKeys.size) ["iq", "appt", "iq_ni", "insp", "insp_sold", "dead"].forEach((k) => validKeys.add(k));
  if (!terminalKeys.size) ["appt", "insp_sold", "dead"].forEach((k) => terminalKeys.add(k));
  const cleanType = (t) => (validKeys.has(t) ? t : "iq");

  const listName = (body.list_name || "").toString().trim() || `List ${new Date().toISOString().slice(0, 10)}`;
  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  if (!rawRows.length) return json(400, { ok: false, error: "rows required" });

  const defaultType = (body.default_type || "iq").toString().trim().toLowerCase();
  // Normalize: a row can be a plain address string or an object. A per-row
  // `type` (pin-type key) lets one CSV carry mixed pin types; otherwise the
  // batch default_type is used.
  const rows = rawRows
    .map((r) => (typeof r === "string" ? { address: r } : r || {}))
    .map((r) => ({
      name: (r.name || "").toString().trim() || null,
      address: (r.address || "").toString().trim(),
      city: (r.city || "").toString().trim() || null,
      state: (r.state || "").toString().trim() || null,
      zip: (r.zip || "").toString().trim() || null,
      phone: (r.phone || "").toString().trim() || null,
      email: (r.email || "").toString().trim() || null,
      latitude: numOrNull(r.latitude),
      longitude: numOrNull(r.longitude),
      type: (r.type || r.status || "").toString().trim().toLowerCase() || defaultType,
      extra: (r.extra && typeof r.extra === "object") ? r.extra : null,
    }))
    .filter((r) => r.address || (r.latitude != null && r.longitude != null))
    .slice(0, MAX_ROWS);
  if (!rows.length) return json(400, { ok: false, error: "no usable addresses" });

  // Geocode with small concurrency so one big list doesn't hammer Google.
  let geocoded = 0, failed = 0;
  const out = new Array(rows.length);
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const i = cursor++;
      const r = rows[i];
      let lat = r.latitude, lng = r.longitude, gstatus;
      if (lat != null && lng != null) {
        geocoded++; gstatus = "provided"; // already geocoded in the file — no Google call
      } else {
        const query = [r.address, r.city, r.state, r.zip].filter(Boolean).join(", ");
        const g = await geocode(query, googleKey);
        if (g.ok) { lat = g.lat; lng = g.lng; geocoded++; } else { lat = null; lng = null; failed++; }
        gstatus = g.ok ? "ok" : "failed";
      }
      out[i] = {
        list_name: listName,
        name: r.name,
        address: r.address, city: r.city, state: r.state, zip: r.zip,
        latitude: lat, longitude: lng,
        geocode_status: gstatus,
        status: cleanType(r.type),
        phone: r.phone, email: r.email, extra: r.extra,
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));

  // Dedup by geocoded location so re-uploading an address updates the SAME pin
  // instead of dropping a duplicate. Precedence on a collision:
  //   • existing is TERMINAL (Appointment, Inspection Sold, Dead/DNK) → protected,
  //     never overwritten by an upload.
  //   • existing is IQ and the incoming type isn't → keep IQ ("IQ always wins").
  //   • otherwise → the incoming pin type replaces the existing one.
  const coordKey = (lat, lng) => `${(+lat).toFixed(4)},${(+lng).toFixed(4)}`; // ~11 m
  const existing = {};   // coordKey -> pin
  const byAddr = {};     // normalized addr -> pin (drift-proof, catches the ~90 m case)
  try {
    for (const p of await sbGet(`${SB_URL}/rest/v1/canvass_prospects?select=id,latitude,longitude,status,status_log,address,zip&latitude=not.is.null&limit=50000`, sbH)) {
      existing[coordKey(p.latitude, p.longitude)] = p;
      const ak = addrKey(p.address, p.zip); if (ak && !byAddr[ak]) byAddr[ak] = p;
    }
  } catch { /* if we can't read, just insert all below */ }

  const uploadId = (body.upload_id || "").toString().trim() || randomUUID(); // shared across a chunked upload; else per-call
  const toInsert = [];
  let updated = 0, skipped = 0;
  const nowIso = new Date().toISOString();
  const updates = [];
  const seenAddr = new Set();  // dedup the SAME address appearing twice within one upload
  for (const row of out) {
    const ak = addrKey(row.address, row.zip);
    if (ak && seenAddr.has(ak)) { skipped++; continue; } // already handled this house in this upload
    if (ak) seenAddr.add(ak);
    // Match an existing pin by coordinate OR normalized address (address catches the
    // ~90 m geocode drift the coordinate key misses).
    const hit = (row.latitude != null ? existing[coordKey(row.latitude, row.longitude)] : null) || (ak ? byAddr[ak] : null);
    if (!hit) { toInsert.push(row); continue; }
    const newType = row.status;
    const keep = terminalKeys.has(hit.status)              // protected win
      || hit.status === newType                             // no change
      || (hit.status === "iq" && newType !== "iq");         // IQ always wins
    if (keep) { skipped++; continue; }
    const log = Array.isArray(hit.status_log) ? [...hit.status_log] : [];
    log.push({ at: nowIso, from: hit.status, to: newType, by: "upload" });
    updates.push(fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${hit.id}`, {
      method: "PATCH", headers: { ...sbH, Prefer: "return=minimal" },
      body: JSON.stringify({ status: newType, status_updated_at: nowIso, status_by: "upload", status_log: log, list_name: listName }),
    }).then((r) => { if (r.ok) updated++; }));
  }
  await Promise.all(updates);

  if (toInsert.length) {
    const tagged = toInsert.map((r) => ({ ...r, upload_id: uploadId }));
    const ins = await fetch(`${SB_URL}/rest/v1/canvass_prospects`, {
      method: "POST", headers: { ...sbH, Prefer: "return=minimal" }, body: JSON.stringify(tagged),
    });
    if (!ins.ok) return json(500, { ok: false, error: `Insert failed: ${(await ins.text()).slice(0, 200)}` });
  }

  // Log the batch so the office can see it in the uploads list and delete it.
  // In chunked mode (client passed an upload_id) the client's finalize call logs
  // ONE row for the whole upload instead, so skip per-batch logging here.
  if (!body.upload_id) {
    await fetch(`${SB_URL}/rest/v1/harvest_uploads`, {
      method: "POST", headers: { ...sbH, Prefer: "return=minimal" },
      body: JSON.stringify({ id: uploadId, list_name: listName, default_type: defaultType, inserted: toInsert.length, updated, skipped, uploaded_by: (body.uploaded_by || "").toString().trim() || null, uploaded_at: nowIso }),
    }).catch(() => {});
  }

  return json(200, { ok: true, upload_id: uploadId, inserted: toInsert.length, updated, skipped, geocoded, failed, list_name: listName });
};

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) && Math.abs(n) <= 180 ? n : null;
}
async function sbGet(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function geocode(query, key) {
  try {
    const url = new URL(GOOGLE_BASE);
    url.searchParams.set("address", query);
    url.searchParams.set("region", "us");
    url.searchParams.set("key", key);
    const res = await fetch(url.toString());
    if (!res.ok) return { ok: false };
    const data = await res.json().catch(() => ({}));
    const loc = data.results?.[0]?.geometry?.location;
    if (data.status !== "OK" || !loc || typeof loc.lat !== "number") return { ok: false };
    return { ok: true, lat: loc.lat, lng: loc.lng };
  } catch { return { ok: false }; }
}

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
