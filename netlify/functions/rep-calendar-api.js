// netlify/functions/rep-calendar-api.js
//
// Backs the rep CALENDAR on the free-roof landing (RepVisitHub). Shows the rep's
// LIVE JobNimbus appointments (Initial Appointment, Inspection Result go-backs,
// Retail Appointment, etc.) plus their availability blocks, and saves blocks.
//
//   POST { token, action: 'load', rep_jobnimbus_id, start, end }
//     → { ok, rep_id, events:[{ id, title, start, end, type, address }],
//          blocks:[{ weekday, start_min }] }
//        events = JN tasks owned by the rep with date_start in [start,end].
//   POST { token, action: 'save_blocks', rep_jobnimbus_id, blocks:[{weekday,start_min}] }
//     → { ok, saved }
//
// Token: app_settings dialer_token OR visit_token. Reps available by DEFAULT;
// blocks (rep_slot_blocks) are the slots they marked off.
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;
const jnH = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const repJnid = String(body.rep_jobnimbus_id || "").trim();
  if (!repJnid) return cors(400, JSON.stringify({ ok: false, error: "rep_jobnimbus_id required" }));
  const repRow = (await sbGet(`sales_reps?jobnimbus_id=eq.${encodeURIComponent(repJnid)}&select=id&limit=1`))[0];
  const repId = repRow?.id || null;

  try {
    if (body.action === "save_blocks") {
      if (!repId) return cors(404, JSON.stringify({ ok: false, error: "rep not found" }));
      const blocks = Array.isArray(body.blocks) ? body.blocks : [];
      await fetch(`${SB_URL}/rest/v1/rep_slot_blocks?rep_id=eq.${encodeURIComponent(repId)}`, { method: "DELETE", headers: { ...sb, Prefer: "return=minimal" } });
      if (blocks.length) {
        const rows = blocks.map((b) => ({ rep_id: repId, weekday: Number(b.weekday), start_min: Number(b.start_min) }))
          .filter((r) => Number.isInteger(r.weekday) && Number.isInteger(r.start_min));
        const ins = await fetch(`${SB_URL}/rest/v1/rep_slot_blocks`, { method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(rows) });
        if (!ins.ok) return cors(500, JSON.stringify({ ok: false, error: `save failed (${ins.status})` }));
      }
      return cors(200, JSON.stringify({ ok: true, saved: blocks.length }));
    }

    // Replace all DATE-SPECIFIC blocks for one date (e.g. block this Sat's 9 AM,
    // or the whole day). { date:'YYYY-MM-DD', start_mins:[int] } — empty clears the day.
    if (body.action === "save_date_blocks") {
      if (!repId) return cors(404, JSON.stringify({ ok: false, error: "rep not found" }));
      const date = String(body.date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return cors(400, JSON.stringify({ ok: false, error: "date YYYY-MM-DD required" }));
      const mins = (Array.isArray(body.start_mins) ? body.start_mins : []).map(Number).filter(Number.isInteger);
      await fetch(`${SB_URL}/rest/v1/rep_date_blocks?rep_id=eq.${encodeURIComponent(repId)}&date=eq.${date}`, { method: "DELETE", headers: { ...sb, Prefer: "return=minimal" } });
      if (mins.length) {
        const rows = mins.map((m) => ({ rep_id: repId, date, start_min: m }));
        const ins = await fetch(`${SB_URL}/rest/v1/rep_date_blocks`, { method: "POST", headers: { ...sb, Prefer: "return=minimal" }, body: JSON.stringify(rows) });
        if (!ins.ok) return cors(500, JSON.stringify({ ok: false, error: `save failed (${ins.status})` }));
      }
      return cors(200, JSON.stringify({ ok: true, saved: mins.length }));
    }

    // action: load
    const startSec = Math.floor(new Date(body.start || Date.now()).getTime() / 1000);
    const endSec = Math.floor(new Date(body.end || Date.now() + 7 * 864e5).getTime() / 1000);
    const events = await fetchRepEvents(repJnid, startSec, endSec);
    const blocks = repId ? await sbGet(`rep_slot_blocks?rep_id=eq.${encodeURIComponent(repId)}&select=weekday,start_min&limit=2000`) : [];
    const todayEt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const dateBlocks = repId ? await sbGet(`rep_date_blocks?rep_id=eq.${encodeURIComponent(repId)}&date=gte.${todayEt}&select=date,start_min&limit=5000`) : [];
    return cors(200, JSON.stringify({ ok: true, rep_id: repId, events, blocks, date_blocks: dateBlocks }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// The rep's JN tasks/appointments in the window (owned by them, dated).
// Date-range filter ONLY — JN silently ignores { term: { "owners.id" } }
// (returns nothing); the owner is matched in code instead.
async function fetchRepEvents(repJnid, startSec, endSec) {
  const filter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_start: { gte: startSec, lte: endSec } } }] }));
  const out = [];
  for (let page = 0; page < 10; page++) {
    const r = await fetch(`${JN_BASE}/tasks?size=100&from=${page * 100}&filter=${filter}`, { headers: jnH });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const rows = d.results || d.tasks || [];
    for (const t of rows) {
      if (!(t.owners || []).some((o) => String(o.id) === String(repJnid))) continue;
      const ds = Number(t.date_start); if (!ds) continue;
      const de = Number(t.date_end) || ds + 3600;
      const job = (t.related || []).find((x) => x.type === "job");
      out.push({
        id: t.jnid || t.id,
        title: t.title || t.record_type_name || "Appointment",
        start: new Date(ds * 1000).toISOString(),
        end: new Date(de * 1000).toISOString(),
        type: t.record_type_name || "",
        address: job ? job.name : (t.location && t.location.name) || "",
      });
    }
    if (rows.length < 100) break;
  }
  return out;
}

async function okToken(token) {
  token = String(token || "").trim();
  if (!token) return false;
  const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]);
  return (!!d && token === d) || (!!v && token === v);
}
async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0]?.value || null;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
