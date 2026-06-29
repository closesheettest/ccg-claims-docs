// netlify/functions/setter-appointments-list.js
//
// Today's appointments booked by the setter portal — the setter's reference
// list so a booking doesn't just vanish after it's set (and survives a failed
// JobNimbus write). Returns everything booked since ET midnight today.
//
//   POST { token, setter_name?, all? }
//     → { ok, appointments:[{ homeowner_name, address, when, source, status,
//          jn_synced, rep_name, appt_at }] }
//        Filtered to setter_name unless all=true.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  try {
    let path = `setter_appointments?booked_at=gte.${encodeURIComponent(etMidnightUtcIso())}&order=appt_at.asc&limit=200`;
    if (!body.all && body.setter_name) path += `&setter_name=eq.${encodeURIComponent(body.setter_name)}`;
    const rows = await sbGet(path);
    const appointments = rows.map((r) => ({
      homeowner_name: r.homeowner_name || "Homeowner",
      address: r.address || "",
      appt_at: r.appt_at,
      when: r.appt_at ? whenEt(r.appt_at) : "",
      source: r.source || "",
      rep_name: r.rep_name || "",
      jn_synced: r.jn_synced !== false,
      out_of_range: !!r.out_of_range,
      status: r.out_of_range ? "Manager to assign a rep" : "Assigned to a rep",
    }));
    return cors(200, JSON.stringify({ ok: true, appointments }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

function whenEt(iso) {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}
// ET midnight today, as a UTC ISO string (timezone-safe, no machine-tz dependency).
function etMidnightUtcIso() {
  const now = new Date();
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now).split("-").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const p = {}; for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hour12: false }).formatToParts(new Date(utcGuess))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return new Date(utcGuess - (asUtc - utcGuess)).toISOString();
}
async function okToken(token) { token = String(token || "").trim(); if (!token) return false; const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]); return (!!d && token === d) || (!!v && token === v); }
async function getSetting(key) { const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`); return rows[0]?.value || null; }
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
