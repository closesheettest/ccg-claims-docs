// netlify/functions/harvest-team.js
//
// Office "team view" for the Harvesting Map: where every rep is right now + a
// trailing breadcrumb of the last ~2 hours + what they last did. Admin only.
//
//   GET ?admin=<token>[&mins=120]
//   → { ok, reps:[{ rep_id, name, pings:[{lat,lng,at}], last_action, last_at }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const ACTION_LABEL = { insp_sold: "Signed ✍️", insp_ni: "Not interested", insp_callback: "Pending", dead: "Dead", new_roof: "New roof", appt: "Booked appt", iq_ni: "IQ not int.", no_sit_reschedule: "No-sit", not_home: "Not home" };

export const handler = async (event) => {
  if (!SB_URL || !SB_KEY) return json(500, { ok: false, error: "env missing" });
  const p = event.queryStringParameters || {};
  const adminTok = String(p.admin || "").trim();
  const mins = Math.min(Math.max(parseInt(p.mins, 10) || 120, 10), 720);
  const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

  // Admin only.
  const s = await sbGet(`app_settings?key=eq.harvest_admin_token&select=value&limit=1`, sb);
  if (!adminTok || s[0]?.value !== adminTok) return json(401, { ok: false, error: "admin only" });

  const since = new Date(Date.now() - mins * 60000).toISOString();
  // Recent pings, oldest→newest so the trail draws in order. Cap raised to 20000:
  // at a 10s ping rate a 2h window is ~720 pings/rep, and order=at.asc + a small
  // cap would drop the NEWEST rows (the reps' current spots), not the oldest.
  // `ended` may not be migrated yet → fall back to the column-less select so the
  // team view never breaks (a missing `ended` just reads as not-ended = still live).
  const pingSel = (cols) => sbGet(`harvest_rep_pings?at=gte.${encodeURIComponent(since)}&select=${cols}&order=at.asc&limit=20000`, sb);
  let pings = await pingSel("rep_id,rep_name,lat,lng,at,ended").catch(() => null);
  if (pings === null) pings = await pingSel("rep_id,rep_name,lat,lng,at").catch(() => []);
  // Latest canvass action per rep (what they're doing) — pull recent, keep newest per rep.
  const acts = await sbGet(`canvass_activity?created_at=gte.${encodeURIComponent(since)}&select=rep_name,kind,to_status,created_at&order=created_at.desc&limit=2000`, sb).catch(() => []);
  const lastByName = {};
  for (const a of acts) { const n = (a.rep_name || "").toLowerCase(); if (n && !lastByName[n]) lastByName[n] = a; }

  const byRep = new Map();
  for (const pg of pings) {
    const key = pg.rep_id || pg.rep_name;
    if (!byRep.has(key)) byRep.set(key, { rep_id: pg.rep_id, name: pg.rep_name || "Rep", pings: [] });
    byRep.get(key).pings.push({ lat: pg.lat, lng: pg.lng, at: pg.at, ended: pg.ended === true });
  }
  // A rep with no ping in the last 15 min has stopped (closed the map / done for
  // now) — drop them from the LIVE view so it reflects who's actually out working.
  // 15 min leaves room for a homeowner conversation / scheduling an appt while the
  // map's open (those still ping every 10s anyway). They reappear on the next ping.
  // A rep whose NEWEST ping is `ended` closed the map explicitly → drop immediately.
  const IDLE_MS = 15 * 60 * 1000, now = Date.now();
  const reps = [...byRep.values()]
    .filter((r) => { const last = r.pings[r.pings.length - 1]; return last && !last.ended && (now - Date.parse(last.at)) <= IDLE_MS; })
    .map((r) => {
      const a = lastByName[(r.name || "").toLowerCase()];
      const label = a ? (a.kind === "status" ? (ACTION_LABEL[a.to_status] || a.to_status) : a.to_status === "not_home" ? "Not home" : "Working a door") : null;
      return { ...r, last_action: label, last_at: a?.created_at || (r.pings[r.pings.length - 1]?.at || null) };
    }).sort((a, b) => new Date(b.last_at || 0) - new Date(a.last_at || 0));

  return json(200, { ok: true, reps });
};

async function sbGet(path, sb) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) throw new Error(await r.text().catch(() => "err"));
  return r.json().catch(() => []);
}
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) };
}
