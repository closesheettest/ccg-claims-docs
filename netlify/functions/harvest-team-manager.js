// netlify/functions/harvest-team-manager.js
//
// Zone-scoped "team view" for the Harvesting Map — a REGIONAL MANAGER sees ONLY the
// reps in THEIR zone: where each is right now, a trailing breadcrumb, what they last
// did, and today's counts. Same shape as harvest-team.js but scoped by manager token
// (not the company-wide admin token).
//
//   GET ?manager=<token>[&mins=120]
//   → { ok, manager:{name,zone}, reps:[{ rep_id, name, live, pings, last_pos,
//        last_action, last_at, today:{knocks,sold,appts,notHome,ni} }], updated_at }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
// Rep → zone lives in TMS; same bridge manager-records-api uses. Keep in sync.
const TMS_REP_ZONES_URL = "https://trainingmanagementsys.netlify.app/.netlify/functions/rep-zones";
const ACTION_LABEL = { insp_sold: "Signed ✍️", insp_ni: "Not interested", insp_callback: "Pending", dead: "Dead", new_roof: "New roof", appt: "Booked appt", iq_ni: "IQ not int.", no_sit_reschedule: "No-sit", not_home: "Not home" };

export const handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  const p = event.queryStringParameters || {};
  const token = String(p.manager || "").trim();
  if (!token) return json(400, { ok: false, error: "manager token required" });
  const mins = Math.min(Math.max(parseInt(p.mins, 10) || 120, 10), 720);
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  // 1) Token → manager (+ zone).
  const manager = await fetchManager(token, sb);
  if (!manager) return json(401, { ok: false, error: "invalid manager token" });

  // 2) Manager's zone → the reps on their team (name + JN id).
  const teamReps = await fetchRepsInZoneBridged(manager.zone, sb);
  const base = { ok: true, manager: { name: manager.name, zone: manager.zone }, updated_at: new Date().toISOString() };
  if (!teamReps.length) return json(200, { ...base, reps: [] });
  const allow = new Set(teamReps.map((r) => normalizeName(r.name)).filter(Boolean));

  // 3) Recent pings (trails) + today's activity (counts + last action), team-filtered.
  const since = new Date(Date.now() - mins * 60000).toISOString();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const [pingsAll, actsAll] = await Promise.all([
    sbGet(`harvest_rep_pings?at=gte.${encodeURIComponent(since)}&select=rep_id,rep_name,lat,lng,at&order=at.asc&limit=20000`, sb).catch(() => []),
    sbGet(`canvass_activity?created_at=gte.${encodeURIComponent(todayStart.toISOString())}&select=rep_name,kind,to_status,created_at&order=created_at.desc&limit=10000`, sb).catch(() => []),
  ]);
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
    pingsByName.get(n).pings.push({ lat: pg.lat, lng: pg.lng, at: pg.at });
  }

  const IDLE_MS = 15 * 60 * 1000, now = Date.now();
  const reps = teamReps.map((tr) => {
    const n = normalizeName(tr.name);
    const g = pingsByName.get(n);
    const arr = g?.pings || [];
    const last = arr.length ? arr[arr.length - 1] : null;
    const live = !!(last && (now - Date.parse(last.at)) <= IDLE_MS);
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

  return json(200, { ...base, reps });
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
function json(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}
