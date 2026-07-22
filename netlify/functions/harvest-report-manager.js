// netlify/functions/harvest-report-manager.js
//
// Zone-scoped Harvesting activity report for a regional manager — the historical
// version of the Live Team Map. Per-rep: doors knocked, outcomes, not-home, off-spot
// (location-audit flags), last active. Scoped to the manager's zone reps only.
//
//   GET ?zone=Zone%201[&period=today|7d|30d|all]
//   → { ok, zone, period, reps:[{ name, knocks, pins, notHome, outcomes{}, offSpot,
//        farCount, lastActive }], newRoof:{ total, bySrc:[[src,n]] } }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";
const OUTCOMES = ["appt", "iq_ni", "insp_ni", "insp_sold", "no_sit_reschedule", "new_roof", "dead"];

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, { ok: false, error: "env missing" });
  const p = event.queryStringParameters || {};
  const period = ["today", "7d", "30d", "all"].includes(p.period) ? p.period : "7d";
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  let zone = String(p.zone || "").trim();
  if (!zone) {
    const token = String(p.manager || "").trim();
    if (!token) return cors(400, { ok: false, error: "zone or manager token required" });
    const m = (await sbGet(`regional_managers?token=eq.${encodeURIComponent(token)}&select=zone&limit=1`, sb).catch(() => []))[0];
    if (!m) return cors(401, { ok: false, error: "invalid manager token" });
    zone = m.zone;
  }

  const teamReps = await fetchRepsInZoneBridged(zone, sb);
  const base = { ok: true, zone, period };
  if (!teamReps.length) return cors(200, { ...base, reps: [], newRoof: { total: 0, bySrc: [] } });
  const allow = new Set(teamReps.map((r) => normalizeName(r.name)).filter(Boolean));

  const since = period === "all" ? null : new Date(Date.now() - (period === "today" ? sinceMidnightMs() : period === "7d" ? 7 * 864e5 : 30 * 864e5)).toISOString();
  // PAGE through all activity — a single `limit=` is capped at 1000 by the server,
  // which drops reps once a zone clears 1000 actions (≈ a busy day at scale).
  let path = "canvass_activity?select=rep_name,pin_id,kind,from_status,to_status,round,created_at,dist_ft,loc_flag&order=created_at.desc";
  if (since) path += `&created_at=gte.${encodeURIComponent(since)}`;
  let rows = await sbGetAll(path, sb).catch(() => null);
  // dist_ft/loc_flag not migrated yet → retry without them.
  if (rows === null) rows = await sbGetAll(path.replace(",dist_ft,loc_flag", ""), sb).catch(() => []);
  const rawActs = (rows || []).filter((a) => allow.has(normalizeName(a.rep_name)));

  // Collapse DUPLICATE rows before counting: the app was logging the same door + kind +
  // outcome several times (a double-tap, a status button that re-fires, GPS-driven
  // re-logs while approaching), which inflated every number. Keep ONE per rep+door+
  // kind+outcome+round — so a genuine round-2 re-knock (different round) still counts,
  // but 5 identical "Dead" rows become 1. Pinless rows (appt_done) keep each.
  const seenAct = new Set();
  const acts = rawActs.filter((a) => {
    if (!a.pin_id) return true;
    const k = `${normalizeName(a.rep_name)}|${a.pin_id}|${a.kind}|${a.to_status || ""}|${a.round ?? ""}`;
    if (seenAct.has(k)) return false;
    seenAct.add(k);
    return true;
  });

  // Appts and no-sit reschedules log as visit/appt_done/manual_here — NOT "status" —
  // so tallying outcomes only from kind==="status" silently dropped them (APPTS/NO-SITS
  // always read 0). Count THOSE two by distinct DOOR across any kind (a booking logs
  // more than one row), and keep every other outcome exactly as before (status-row
  // count) so the familiar IQ-NI / DEAD / etc. numbers don't shift.
  const NOSTATUS = new Set(["appt", "no_sit_reschedule"]);
  const byName = new Map();
  const newRoofSrc = {}; let newRoofTotal = 0;
  for (const a of acts) {
    const n = normalizeName(a.rep_name); if (!n) continue;
    const cur = byName.get(n) || { name: a.rep_name, knocks: 0, pins: new Set(), notHome: 0, outcomes: {}, outcomePins: {}, offSpot: 0, farCount: 0, lastActive: null };
    cur.name = a.rep_name;
    if (a.kind === "visit") { cur.knocks += 1; if (a.pin_id) cur.pins.add(a.pin_id); if (a.to_status === "not_home") cur.notHome += 1; }
    if (a.kind === "status" && a.to_status && !NOSTATUS.has(a.to_status)) {
      cur.outcomes[a.to_status] = (cur.outcomes[a.to_status] || 0) + 1;
      if (a.to_status === "new_roof") { const s = a.from_status || "(unknown)"; newRoofSrc[s] = (newRoofSrc[s] || 0) + 1; newRoofTotal += 1; }
    }
    if (a.to_status && NOSTATUS.has(a.to_status)) {
      (cur.outcomePins[a.to_status] = cur.outcomePins[a.to_status] || new Set()).add(a.pin_id || `${a.kind}:${a.created_at}`);
    }
    if (a.kind !== "arrival") { if (a.loc_flag === "far") { cur.farCount += 1; cur.offSpot += 1; } else if (a.loc_flag === "gps_off") cur.offSpot += 1; }
    if (!cur.lastActive || new Date(a.created_at) > new Date(cur.lastActive)) cur.lastActive = a.created_at;
    byName.set(n, cur);
  }

  const reps = [...byName.values()]
    .map((r) => ({ name: r.name, knocks: r.knocks, pins: r.pins.size, notHome: r.notHome, outcomes: { ...r.outcomes, ...Object.fromEntries(Object.entries(r.outcomePins).map(([k, s]) => [k, s.size])) }, offSpot: r.offSpot, farCount: r.farCount, lastActive: r.lastActive }))
    .sort((a, b) => new Date(b.lastActive || 0) - new Date(a.lastActive || 0));
  const newRoof = { total: newRoofTotal, bySrc: Object.entries(newRoofSrc).sort((a, b) => b[1] - a[1]) };
  return cors(200, { ...base, outcomes: OUTCOMES, reps, newRoof });
};

// ms elapsed since midnight Eastern (so Date.now() - this = ET midnight).
function sinceMidnightMs() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return et.getHours() * 3600e3 + et.getMinutes() * 60e3 + et.getSeconds() * 1e3 + et.getMilliseconds();
}
async function fetchRepsInZoneBridged(targetZone, sb) {
  let tmsReps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) { const j = await res.json(); tmsReps = j.reps || []; } } catch { /* ignore */ }
  const zoneByJnId = {}, zoneByName = {};
  for (const r of tmsReps) { if (r.jobnimbus_id) zoneByJnId[r.jobnimbus_id] = r.zone; if (r.name) zoneByName[normalizeName(r.name)] = r.zone; }
  const salesReps = await sbGet("sales_reps?select=name,jobnimbus_id&limit=1000", sb).catch(() => []);
  const out = [];
  for (const sr of salesReps || []) {
    if (!sr.name) continue;
    const zone = (sr.jobnimbus_id ? zoneByJnId[sr.jobnimbus_id] : null) || zoneByName[normalizeName(sr.name)];
    if (zone === targetZone) out.push({ name: sr.name, jobnimbus_id: sr.jobnimbus_id || null });
  }
  return out;
}
function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
async function sbGet(path, sb) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) throw new Error(await r.text().catch(() => "err"));
  return r.json();
}
// Range-paged fetch — gets EVERY row past the server's 1000-row cap.
async function sbGetAll(path, sb) {
  const out = [];
  for (let from = 0; from < 500000; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { ...sb, "Range-Unit": "items", Range: `${from}-${from + 999}` } });
    if (!r.ok) { if (from === 0) throw new Error(await r.text().catch(() => "err")); break; }
    const b = await r.json().catch(() => []);
    if (!Array.isArray(b) || !b.length) break;
    out.push(...b);
    if (b.length < 1000) break;
  }
  return out;
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}
