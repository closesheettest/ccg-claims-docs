// netlify/functions/harvest-repcard-import.js
//
// Import a RepCard status export (CSV) and scrub the Harvesting Map: leads a rep
// already worked in RepCard (Not Interested / Dead / No Sale / Not Qualified) get
// their map pin flipped to the matching terminal status, so reps stop re-knocking
// doors that are already closed. MAP-ONLY — writes nothing to JobNimbus.
//
// Only touches IQ / Facebook / AI-Bot pins (the JN-contact-sourced ones). Matches a
// RepCard lead to a pin by location (<=60 m + same house number). It NEVER overrides
// a pin that's already worked (idempotent) and leaves Pending-180 leads alone. Pair
// with the harvest-sync-iq-background fix so the sync doesn't re-raise these.
//
//   POST { csv:"<raw csv text>", apply:false }   → dry-run preview (default)
//   POST { csv:"<raw csv text>", apply:true  }   → applies the status changes
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

// The pin lists this scrub is allowed to touch (JN contact–sourced leads).
const LISTS = ["JN Instant Quote", "JN Facebook", "JN AI Bot"];
const RAW_STATUSES = new Set(["iq", "fb", "ai"]); // only flip a still-raw pin
const MATCH_M = 60;

// RepCard "Contact Status" → map pin status. null = leave the pin alone.
function targetFor(repcardStatus) {
  const s = String(repcardStatus || "").trim().toLowerCase();
  if (s === "dead") return "dead";
  if (s === "not interested") return "iq_ni";
  if (s === "not qualified") return "lost";
  if (s === "no sale") return "lost";
  if (s.startsWith("pending")) return null; // come-back, keep it live
  return null; // unknown → skip
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, "");
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "POST only" });
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "bad JSON" }); }
  const apply = body.apply === true;
  const rows = parseCSV(String(body.csv || ""));
  if (rows.length < 2) return json(400, { ok: false, error: "no CSV rows" });

  // Parse RepCard leads (skip header). Col 6=status, 9=address, 11=city, 13=zip, 14=lat, 15=lng.
  const leads = [];
  const counts = { total: 0, pending: 0, unknown_status: 0, no_coords: 0 };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || r.length < 16) continue;
    counts.total++;
    const target = targetFor(r[6]);
    if (target === null) { if (String(r[6] || "").toLowerCase().startsWith("pending")) counts.pending++; else counts.unknown_status++; continue; }
    const lat = parseFloat(r[14]), lng = parseFloat(r[15]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { counts.no_coords++; continue; }
    leads.push({ target, rc: (r[6] || "").trim(), lat, lng, addr: (r[9] || "").trim(), city: (r[11] || "").trim(), zip: (r[13] || "").trim() });
  }

  // Load the candidate pins (small set) and build a spatial grid.
  const inList = LISTS.map((l) => `"${l}"`).join(",");
  const pins = await sbGetAll(`canvass_prospects?list_name=in.(${encodeURIComponent(inList)})&latitude=not.is.null&select=id,status,latitude,longitude,address`);
  const CELL = 0.002;
  const grid = new Map();
  const gk = (lat, lng) => `${Math.round(lat / CELL)},${Math.round(lng / CELL)}`;
  for (const p of pins) { const k = gk(p.latitude, p.longitude); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); }

  const changes = []; // {id, from, to}
  const summary = { matched: 0, already_worked: 0, no_match: 0, byTarget: {}, byBucket: {} };
  for (const l of leads) {
    const [gx, gy] = gk(l.lat, l.lng).split(",").map(Number);
    let best = null, bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const cell = grid.get(`${gx + dx},${gy + dy}`); if (!cell) continue;
      for (const p of cell) { const d = distM(l.lat, l.lng, p.latitude, p.longitude); if (d < bestD) { bestD = d; best = p; } }
    }
    const sameHouse = best && houseNum(l.addr) && houseNum(best.address) === houseNum(l.addr);
    if (!best || bestD > MATCH_M || !(sameHouse || bestD <= 20)) { summary.no_match++; continue; }
    summary.matched++;
    if (!RAW_STATUSES.has(best.status)) { summary.already_worked++; continue; } // idempotent: don't touch worked pins
    if (best.status === l.target) { summary.already_worked++; continue; }
    summary.byTarget[l.target] = (summary.byTarget[l.target] || 0) + 1;
    summary.byBucket[l.rc] = (summary.byBucket[l.rc] || 0) + 1;
    changes.push({ id: best.id, from: best.status, to: l.target });
  }

  let applied = 0;
  if (apply && changes.length) {
    const nowIso = new Date().toISOString();
    for (let i = 0; i < changes.length; i += 20) {
      const batch = changes.slice(i, i + 20);
      const res = await Promise.all(batch.map((c) =>
        fetch(`${SB_URL}/rest/v1/canvass_prospects?id=eq.${c.id}`, {
          method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
          body: JSON.stringify({ status: c.to, status_by: "RepCard import", status_updated_at: nowIso }),
        }).then((r) => r.ok).catch(() => false)));
      applied += res.filter(Boolean).length;
    }
  }

  return json(200, {
    ok: true, apply, leads_in_file: counts.total, candidates_scanned: pins.length,
    skipped: { pending: counts.pending, unknown_status: counts.unknown_status, no_coords: counts.no_coords, already_worked: summary.already_worked, no_match: summary.no_match },
    would_change: changes.length, applied,
    by_target: summary.byTarget, by_bucket: summary.byBucket,
    sample: changes.slice(0, 20),
  });
};

// ── helpers ─────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function houseNum(a) { return (String(a || "").trim().match(/^\d+/) || [""])[0]; }
function distM(aLat, aLng, bLat, bLng) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (bLat - aLat) * toR, dLng = (bLng - aLng) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * toR) * Math.cos(bLat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
async function sbGetAll(path) {
  const out = []; let from = 0; const page = 1000;
  for (;;) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}&order=id&offset=${from}&limit=${page}`, { headers: sb });
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    const b = await r.json(); out.push(...b);
    if (b.length < page) break; from += page;
  }
  return out;
}
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}
