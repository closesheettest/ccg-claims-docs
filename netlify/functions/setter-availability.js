// netlify/functions/setter-availability.js
//
// For the appointment-setter portal: given the homeowner's location (lat/lng +
// county), return the active sales reps in that ZONE who are within 50 MILES of
// the address, each with their OPEN appointment slots (default retail hours minus
// the rep's date-specific blocks minus what they're already booked on in JN).
//
//   POST { token, lat, lng, county, days? }
//     → { ok, reps:[{ jobnimbus_id, name, distance_mi, days:[{ date, label,
//          slots:[{ hour, min, label }] }] }], out_of_radius }
//        out_of_radius = true when NO rep in the zone is within 50 mi (the setter
//        can still book — it gets owned by the setter for a manager to assign).
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
const REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones?include_inactive=1";
const RADIUS_MI = 50;
const SLOT_HOURS = { 1: [11, 14, 17, 19], 2: [11, 14, 17, 19], 3: [11, 14, 17, 19], 4: [11, 14, 17, 19], 5: [9, 12, 15], 6: [9, 12] };

const ZONE_COUNTIES = {
  "Zone 1": ["Nassau", "Duval", "Baker", "Union", "Bradford", "Clay", "St. Johns", "Putnam", "Flagler", "Alachua", "Levy", "Marion", "Sumter", "Lake", "Seminole", "Volusia", "Brevard", "Orange"],
  "Zone 2": ["Orange", "Brevard", "Pasco", "Hillsborough", "Polk", "Osceola", "Indian River", "Highlands", "Citrus", "Hernando"],
  "Zone 3": ["Pinellas", "Manatee", "Sarasota", "Charlotte", "Lee", "Collier", "Monroe", "Hardee", "DeSoto", "Glades", "Hendry", "St. Lucie", "Okeechobee"],
  "Zone 4": ["Martin", "Palm Beach", "Broward", "Miami-Dade"],
};
const normCounty = (c) => String(c || "").toLowerCase().replace(/county/g, "").replace(/[^a-z]+/g, " ").trim();
const COUNTY_ZONES = (() => { const m = {}; for (const [z, l] of Object.entries(ZONE_COUNTIES)) for (const c of l) (m[normCounty(c)] = m[normCounty(c)] || []).push(z); return m; })();

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const lat = Number(body.lat), lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return cors(400, JSON.stringify({ ok: false, error: "lat/lng required" }));
  const zones = COUNTY_ZONES[normCounty(body.county)] || ["Zone 1", "Zone 2", "Zone 3", "Zone 4"];
  const days = Math.min(21, Math.max(1, Number(body.days) || 14));

  try {
    const all = await fetchReps();
    // Active reps in the zone with a home geocode, within the radius.
    const near = all.filter((r) => r.active && r.jobnimbus_id && zones.includes(r.zone) && r.latitude != null && r.longitude != null)
      .map((r) => ({ ...r, distance_mi: Math.round(haversineMi(lat, lng, r.latitude, r.longitude) * 10) / 10 }))
      .filter((r) => r.distance_mi <= RADIUS_MI)
      .sort((a, b) => a.distance_mi - b.distance_mi);

    if (!near.length) return cors(200, JSON.stringify({ ok: true, reps: [], out_of_radius: true }));

    // Map JN ids → sales_reps.id for date blocks.
    const jnids = near.map((r) => r.jobnimbus_id);
    const repRows = await sbGet(`sales_reps?jobnimbus_id=in.(${jnids.map((x) => `"${x}"`).join(",")})&select=id,jobnimbus_id`);
    const idByJn = {}; for (const r of repRows) idByJn[r.jobnimbus_id] = r.id;
    const repIds = Object.values(idByJn);
    const dateBlockRows = repIds.length ? await sbGet(`rep_date_blocks?rep_id=in.(${repIds.map((x) => `"${x}"`).join(",")})&select=rep_id,date,start_min&limit=10000`) : [];
    const blocksByRep = {}; for (const b of dateBlockRows) (blocksByRep[b.rep_id] = blocksByRep[b.rep_id] || new Set()).add(`${b.date}:${b.start_min}`);

    const now = Date.now();
    const reps = [];
    for (const r of near) {
      const blocked = blocksByRep[idByJn[r.jobnimbus_id]] || new Set();
      const booked = await repBookedSlots(r.jobnimbus_id, now, days);
      const out = [];
      for (let d = 0; d < days; d++) {
        const { y, mo, day, weekday, wname } = etParts(now + d * 864e5);
        const dateStr = `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const slots = (SLOT_HOURS[weekday] || []).filter((h) => {
          if (blocked.has(`${dateStr}:${h * 60}`)) return false;
          if (booked.has(`${dateStr}@${h}`)) return false;
          return Date.parse(etToISO(y, mo, day, h)) > now + 60 * 60 * 1000;
        }).map((h) => ({ hour: h, min: h * 60, label: hourLabel(h), iso: etToISO(y, mo, day, h) }));
        if (slots.length) out.push({ date: dateStr, label: `${wname} ${mo}/${day}`, slots });
      }
      reps.push({ jobnimbus_id: r.jobnimbus_id, name: r.name, distance_mi: r.distance_mi, days: out });
    }
    return cors(200, JSON.stringify({ ok: true, reps, out_of_radius: false }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// The day/hour slots a rep is already booked on (their future JN appointments).
async function repBookedSlots(repJnid, nowMs, days) {
  const booked = new Set();
  const startSec = Math.floor(nowMs / 1000), endSec = Math.floor((nowMs + (days + 1) * 864e5) / 1000);
  const filter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_start: { gte: startSec, lte: endSec } } }, { term: { "owners.id": repJnid } }] }));
  try {
    const r = await fetch(`${JN_BASE}/tasks?size=100&filter=${filter}`, { headers: jnH });
    if (r.ok) { const d = await r.json(); for (const t of (d.results || [])) { const ds = Number(t.date_start); if (ds) booked.add(etSlotKey(ds * 1000)); } }
  } catch { /* ignore */ }
  return booked;
}

function fetchReps() { return fetch(REP_ZONES_URL).then((r) => r.ok ? r.json().then((j) => j.reps || []) : []).catch(() => []); }
function haversineMi(la1, lo1, la2, lo2) { const R = 3958.8, t = (d) => d * Math.PI / 180; const dLa = t(la2 - la1), dLo = t(lo2 - lo1); const a = Math.sin(dLa / 2) ** 2 + Math.cos(t(la1)) * Math.cos(t(la2)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); }
function hourLabel(h) { return `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`; }
function etParts(ms) { const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", weekday: "short" }); const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value; const w = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }; return { y: +p.year, mo: +p.month, day: +p.day, weekday: w[p.weekday], wname: p.weekday }; }
function etSlotKey(ms) { const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", hour12: false }); const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value; return `${p.year}-${p.month}-${p.day}@${+p.hour}`; }
function etToISO(y, mo, day, hour) { const guess = Date.UTC(y, mo - 1, day, hour, 0); const asEt = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York" })); return new Date(guess + (guess - asEt.getTime())).toISOString(); }
async function okToken(token) { token = String(token || "").trim(); if (!token) return false; const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]); return (!!d && token === d) || (!!v && token === v); }
async function getSetting(key) { const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`); return rows[0]?.value || null; }
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
