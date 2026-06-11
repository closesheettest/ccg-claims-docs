// netlify/functions/list-stale-appts.js
//
// One-off report: every JobNimbus job still in "Appointment Scheduled"
// whose appointment date (date_start) is BEFORE today (America/New_York).
// These are past appointments the rep never updated the outcome on.
//
// GET /.netlify/functions/list-stale-appts[?status=Appointment%20Scheduled][&pages=40]
// → { ok, today, status, total, jobs:[{ customer, address, rep, appt, appt_label }] }
//
// Env: JOBNIMBUS_API_KEY.

const JN_BASE = "https://app.jobnimbus.com/api1";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (!JN_KEY) return cors(500, JSON.stringify({ ok: false, error: "Missing JOBNIMBUS_API_KEY" }));

  const qp = event.queryStringParameters || {};
  const wantStatus = norm(qp.status || "Appointment Scheduled");
  const maxPages = Math.min(Math.max(parseInt(qp.pages, 10) || 40, 1), 60);

  // Start of today in America/New_York, as an epoch (seconds).
  const todayStartSec = startOfTodayET();

  const jnHeaders = { Authorization: `bearer ${JN_KEY}`, "Content-Type": "application/json" };
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const r = await fetch(`${JN_BASE}/jobs?size=100&from=${page * 100}&sort=-date_updated`, { headers: jnHeaders });
    if (!r.ok) break;
    const d = await r.json().catch(() => ({}));
    const rows = d.results || d.jobs || [];
    all.push(...rows);
    if (rows.length < 100) break;
  }

  const jobs = [];
  for (const j of all) {
    if (norm(j.status_name) !== wantStatus) continue;
    const apptSec = Number(j.date_start);
    if (!Number.isFinite(apptSec) || apptSec <= 0) continue;
    if (apptSec >= todayStartSec) continue; // only appts BEFORE today
    const customer = j.primary && j.primary.name ? String(j.primary.name).replace(/\s+/g, " ").trim() : "—";
    const address = [j.address_line1, j.city, j.state_text, j.zip].filter(Boolean).join(", ");
    jobs.push({
      customer,
      address,
      rep: (j.sales_rep_name || "").trim() || "(no rep)",
      appt: apptSec,
      appt_label: apptLabel(new Date(apptSec * 1000)),
    });
  }
  jobs.sort((a, b) => a.appt - b.appt); // oldest appt first

  return cors(200, JSON.stringify({
    ok: true,
    today: new Date(todayStartSec * 1000).toISOString(),
    status: qp.status || "Appointment Scheduled",
    scanned: all.length,
    total: jobs.length,
    jobs,
  }));
};

function startOfTodayET() {
  const now = new Date();
  const p = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offset = asUTC - now.getTime();          // ms to shift UTC → ET wall clock
  const midnightUTCguess = Date.UTC(+p.year, +p.month - 1, +p.day, 0, 0, 0);
  return Math.floor((midnightUTCguess - offset) / 1000);
}
function apptLabel(date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(date);
}
function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function cors(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
    body,
  };
}
