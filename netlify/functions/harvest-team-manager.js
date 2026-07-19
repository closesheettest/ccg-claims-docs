// netlify/functions/harvest-team-manager.js
//
// Zone-scoped "team view" for the Harvesting Map — a REGIONAL MANAGER sees ONLY the
// reps in THEIR zone: where each is right now, a trailing breadcrumb, what they last
// did, and today's counts. Same shape as harvest-team.js but scoped by manager token
// (not the company-wide admin token).
//
//   GET ?zone=Zone%201[&mins=120]         ← how the TMS manager page calls it
//   GET ?manager=<token>[&mins=120]        ← CCG regional_managers token (also fine)
//   → { ok, zone, reps:[{ rep_id, name, live, pings, last_pos,
//        last_action, last_at, today:{knocks,sold,appts,notHome,ni} }], updated_at }
//
// Zone-scoped, no secret — same posture as the sibling zone-* endpoints the TMS
// manager page already calls (zone-appt-conversion, zone-leaderboard, …). CORS open.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
// Rep → zone lives in TMS; same bridge manager-records-api uses. Keep in sync.
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";
const ACTION_LABEL = { insp_sold: "Signed ✍️", insp_ni: "Not interested", insp_callback: "Pending", dead: "Dead", new_roof: "New roof", appt: "Booked appt", iq_ni: "IQ not int.", no_sit_reschedule: "No-sit", not_home: "Not home" };

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, { ok: false, error: "env missing" });
  const p = event.queryStringParameters || {};
  const mins = Math.min(Math.max(parseInt(p.mins, 10) || 120, 10), 720);
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  // Company kill-switch: the office can turn the regional-manager map off on the
  // Pin Types admin page (app_settings.harvest_manager_map_enabled). Default ON.
  const setRow = await sbGet("app_settings?key=eq.harvest_manager_map_enabled&select=value&limit=1", sb).catch(() => []);
  const enabled = !(setRow[0] && String(setRow[0].value) === "false");
  if (!enabled) return cors(200, { ok: true, enabled: false, reps: [] });

  // Scope: a zone directly (how the TMS manager page calls it), OR a CCG
  // regional_managers token that resolves to a zone.
  let zone = String(p.zone || "").trim();
  if (!zone) {
    const token = String(p.manager || "").trim();
    if (!token) return cors(400, { ok: false, error: "zone or manager token required" });
    const manager = await fetchManager(token, sb);
    if (!manager) return cors(401, { ok: false, error: "invalid manager token" });
    zone = manager.zone;
  }

  // Zone → the reps on that team (name + JN id).
  const teamReps = await fetchRepsInZoneBridged(zone, sb);
  const base = { ok: true, enabled: true, zone, updated_at: new Date().toISOString() };
  if (!teamReps.length) return cors(200, { ...base, reps: [] });
  const allow = new Set(teamReps.map((r) => normalizeName(r.name)).filter(Boolean));

  // 3) Recent pings (trails) + today's activity (counts + last action), team-filtered.
  const since = new Date(Date.now() - mins * 60000).toISOString();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  // `ended` may not be migrated yet → fall back to the column-less ping select.
  const pingSel = (cols) => sbGet(`harvest_rep_pings?at=gte.${encodeURIComponent(since)}&select=${cols}&order=at.asc&limit=20000`, sb);
  const [pingsRaw, actsAll] = await Promise.all([
    pingSel("rep_id,rep_name,lat,lng,at,ended").catch(() => null),
    sbGet(`canvass_activity?created_at=gte.${encodeURIComponent(todayStart.toISOString())}&select=rep_name,kind,to_status,created_at&order=created_at.desc&limit=10000`, sb).catch(() => []),
  ]);
  const pingsAll = pingsRaw !== null ? pingsRaw : await pingSel("rep_id,rep_name,lat,lng,at").catch(() => []);
  const pings = pingsAll.filter((pg) => allow.has(normalizeName(pg.rep_name)));
  const acts = actsAll.filter((a) => allow.has(normalizeName(a.rep_name)));

  // Latest action + today's tallies, keyed by normalized rep name.
  const lastByName = {}, todayByName = {};
  for (const a of acts) {
    const n = normalizeName(a.rep_name); if (!n) continue;
    if (!lastByName[n]) lastByName[n] = a; // acts are newest-first
    const t = todayByName[n] || (todayByName[n] = { knocks: 0, sold: 0, appts: 0, notHome: 0, ni: 0 });
    if (a.kind === "visit") { t.knocks += 1; if (a.to_status === "not_home") t.notHome += 1; }
    else if (a.kind === "status") {
      if (a.to_status === "insp_sold") t.sold += 1;
      else if (a.to_status === "appt") t.appts += 1;
      else if (a.to_status === "iq_ni" || a.to_status === "insp_ni") t.ni += 1;
    }
  }

  // Pings grouped per rep (by name — CCG names are the join key here).
  const pingsByName = new Map();
  for (const pg of pings) {
    const n = normalizeName(pg.rep_name); if (!n) continue;
    if (!pingsByName.has(n)) pingsByName.set(n, { rep_id: pg.rep_id, pings: [] });
    pingsByName.get(n).pings.push({ lat: pg.lat, lng: pg.lng, at: pg.at, ended: pg.ended === true });
  }

  const IDLE_MS = 15 * 60 * 1000, now = Date.now();
  const reps = teamReps.map((tr) => {
    const n = normalizeName(tr.name);
    const g = pingsByName.get(n);
    const arr = g?.pings || [];
    const last = arr.length ? arr[arr.length - 1] : null;
    // Live only if the newest ping is recent AND wasn't an explicit "closed" beacon.
    const live = !!(last && !last.ended && (now - Date.parse(last.at)) <= IDLE_MS);
    const a = lastByName[n];
    const label = a ? (a.kind === "status" ? (ACTION_LABEL[a.to_status] || a.to_status) : a.to_status === "not_home" ? "Not home" : "Working a door") : null;
    return {
      rep_id: g?.rep_id || tr.jobnimbus_id || tr.name,
      name: tr.name,
      live,
      pings: live ? arr : [],        // only draw a trail for someone active right now
      last_pos: last,                // last known spot in the window (live or not)
      last_action: label,
      last_at: a?.created_at || (last?.at || null),
      today: todayByName[n] || { knocks: 0, sold: 0, appts: 0, notHome: 0, ni: 0 },
    };
  }).sort((x, y) => (Number(y.live) - Number(x.live)) || (y.today.knocks - x.today.knocks) || String(x.name).localeCompare(String(y.name)));

  return cors(200, { ...base, reps });
};

// ── Helpers (mirrors manager-records-api.js) ────────────────────────────────
async function fetchManager(token, sb) {
  const rows = await sbGet(`regional_managers?token=eq.${encodeURIComponent(token)}&select=id,zone,name,phone&limit=1`, sb).catch(() => []);
  return rows[0] || null;
}
async function fetchRepsInZoneBridged(targetZone, sb) {
  let tmsReps = [];
  try { const res = await fetch(TMS_REP_ZONES_URL); if (res.ok) { const j = await res.json(); tmsReps = j.reps || []; } }
  catch { /* TMS down → fall back to name-zone only (empty) */ }
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
  return String(s || "").toLowerCase()
    .replace(/["“”]([^"“”]*)["“”]/g, "").replace(/'([^']*)'/g, "").replace(/\(([^)]*)\)/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
async function sbGet(path, sb) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) throw new Error(await r.text().catch(() => "err"));
  return r.json();
}
function cors(status, body) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json", "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}
