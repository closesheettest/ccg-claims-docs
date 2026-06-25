// netlify/functions/post-job-installs.js
//
// "Post Job" pressure-washer route (Mark). Pulls roofing installs from
// JobNimbus, classifies shingle vs metal, reads the square count, and uses the
// start/end of PAST installs to estimate how long each CURRENT install takes —
// so Mark can plan to hit each one on its SECOND day. Returns the active list
// sorted by install start + estimated completion, with addresses/coords for
// Apple/Google Maps route optimization from his home base.
//
//   Install start  = JN "Roof Install"  (Roof Production category)
//   Install end    = JN "Roof Complete"
//   Type           = "Shingle" bool vs the metal bools (Standing Seam /
//                    Stone Coated Metal / Exposed Fastener / Permalock)
//   Squares        = "# of Squares (Pitch)" + "# of Squares (Flat)"
//
// GET /.netlify/functions/post-job-installs?token=<visit_token>[&days=21]
// → { ok, home, rates, installs:[{ jnid, homeowner, address, city, lat, lng,
//      type, squares, install_start, est_days, est_complete, day2 }] }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

const MARK_HOME = "3217 Taragrove Dr, Tampa, FL";
const METAL_FLAGS = ["Standing Seam", "Stone Coated Metal", "Exposed Fastener", "Permalock"];
// Fallback days-per-square when there's no historical data yet (metal slower).
const DEFAULT_RATE = { Shingle: 0.04, Metal: 0.08 };
const DAY = 86400;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "JN key missing" }));
  const qp = event.queryStringParameters || {};
  if (!(await okToken(qp.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));

  const nowSec = Math.floor(Date.now() / 1000);
  // Upcoming-window for Mark's active list (default 21 days out); look back a
  // bit so an install that started a few days ago still shows.
  const windowDays = Math.min(Math.max(parseInt(qp.days, 10) || 21, 7), 60);

  try {
    // Pull jobs touched in the last ~6 months — enough history for the average
    // AND every current install.
    const sinceSec = nowSec - 180 * DAY;
    const filter = encodeURIComponent(JSON.stringify({ must: [{ range: { date_updated: { gte: sinceSec } } }] }));
    const headers = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
    const jobs = [];
    for (let page = 0; page < 12; page++) {
      const r = await fetch(`${JN_BASE}/jobs?size=200&from=${page * 200}&filter=${filter}`, { headers });
      if (!r.ok) break;
      const d = await r.json().catch(() => ({}));
      const rows = d.results || d.jobs || d.data || [];
      if (!rows.length) break;
      jobs.push(...rows);
      if (rows.length < 200) break;
    }

    // Build install records (only jobs with a Roof Install date).
    const recs = [];
    for (const j of jobs) {
      const start = tsec(j["Roof Install"]);
      if (!start) continue;
      const complete = tsec(j["Roof Complete"]);
      const type = METAL_FLAGS.some((f) => isYes(j[f])) ? "Metal" : (isYes(j["Shingle"]) ? "Shingle" : "Other");
      const squares = num(j["# of Squares (Pitch)"]) + num(j["# of Squares (Flat)"]);
      const geo = j.geo || {};
      recs.push({
        jnid: j.jnid || j.id,
        homeowner: (j.primary && j.primary.name) || j.name || "—",
        address: [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", "),
        city: j.city || "",
        lat: numOrNull(geo.lat != null ? geo.lat : j.lat),
        lng: numOrNull(geo.lon != null ? geo.lon : (geo.lng != null ? geo.lng : j.lng)),
        type, squares, start, complete,
      });
    }

    // Historical days-per-square rate per type, from COMPLETED installs.
    const rates = {};
    for (const t of ["Shingle", "Metal"]) {
      let days = 0, sq = 0, n = 0;
      for (const r of recs) {
        if (r.type !== t || !r.complete || !(r.squares > 0)) continue;
        const dur = Math.max(0, (r.complete - r.start) / DAY);
        days += dur; sq += r.squares; n++;
      }
      rates[t] = { rate: sq > 0 ? days / sq : DEFAULT_RATE[t], samples: n, source: sq > 0 && n >= 3 ? "history" : "default" };
    }
    const rateFor = (t) => (rates[t] ? rates[t].rate : (DEFAULT_RATE[t] || 0.05));
    const estDays = (t, sq) => Math.max(1, Math.round((sq || 0) * rateFor(t)));

    // Active list: an install that's current/upcoming and not long-finished.
    const lo = nowSec - 14 * DAY, hi = nowSec + windowDays * DAY;
    const installs = recs
      .filter((r) => r.start >= lo && r.start <= hi && (!r.complete || r.complete >= nowSec - 2 * DAY))
      .map((r) => {
        const ed = estDays(r.type, r.squares);
        return {
          jnid: r.jnid, homeowner: r.homeowner, address: r.address, city: r.city, lat: r.lat, lng: r.lng,
          type: r.type, squares: Math.round(r.squares * 10) / 10,
          install_start: new Date(r.start * 1000).toISOString(),
          est_days: ed,
          est_complete: new Date((r.start + ed * DAY) * 1000).toISOString(),
          day2: new Date((r.start + DAY) * 1000).toISOString(),
        };
      })
      .sort((a, b) => Date.parse(a.install_start) - Date.parse(b.install_start) || Date.parse(a.est_complete) - Date.parse(b.est_complete));

    return cors(200, JSON.stringify({ ok: true, home: MARK_HOME, rates, count: installs.length, installs }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

function tsec(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
function num(v) { const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : 0; }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; }
function isYes(v) { const s = String(v == null ? "" : v).trim().toLowerCase(); return s === "true" || s === "yes" || s === "1"; }
async function getSetting(key) { const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`); return rows[0] ? rows[0].value : null; }
async function okToken(token) { token = String(token || "").trim(); if (!token) return false; const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]); return token === d || token === v; }
async function sbGet(path) { const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb }); if (!r.ok) return []; return r.json().catch(() => []); }
function cors(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body }; }
