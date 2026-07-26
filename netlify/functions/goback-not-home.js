// netlify/functions/goback-not-home.js
//
// Rep arrives at a scheduled go-back REVIEW visit and nobody's home. Re-date the
// go-back to the homeowner's NEXT preferred day/time (review_availability) AND
// bump the not-home attempt counter — so it stays on the go-back list fresh
// (not stuck "overdue") and a door that's never home eventually flags for a
// call / different approach. (Neal: "both — re-date + count attempts.")
//
//   POST { token, inspection_id } → { ok, when, count, moved, label }
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, JOBNIMBUS_API_KEY

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const sb = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
import { jnFetch } from "./_jn.js";
const JN_KEY = process.env.JOBNIMBUS_API_KEY;

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, JSON.stringify({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, JSON.stringify({ ok: false, error: "env missing" }));
  let body; try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, JSON.stringify({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(body.token))) return cors(401, JSON.stringify({ ok: false, error: "Invalid link" }));
  const id = String(body.inspection_id || "").trim();
  if (!id) return cors(400, JSON.stringify({ ok: false, error: "inspection_id required" }));

  try {
    const insp = (await sbGet(`inspections?id=eq.${encodeURIComponent(id)}&select=id,review_availability,result_task_jnid,result_task_at,goback_not_home_count&limit=1`))[0];
    if (!insp) return cors(404, JSON.stringify({ ok: false, error: "inspection not found" }));

    // Next preferred day/time (from tomorrow). If availability is unparseable,
    // just push ~1 day off the current schedule so it still moves off "today".
    const when = nextGoBackMs(insp.review_availability) ||
      (insp.result_task_at ? Date.parse(insp.result_task_at) + 24 * 3600 * 1000 : Date.now() + 24 * 3600 * 1000);
    const startSec = Math.floor(when / 1000);
    const nextCount = (Number(insp.goback_not_home_count) || 0) + 1;

    // Move the existing JN go-back task to the new time (best-effort — never blocks).
    let moved = false;
    if (JN_KEY && insp.result_task_jnid) {
      try {
        const r = await jnFetch(JN_KEY, `tasks/${encodeURIComponent(insp.result_task_jnid)}`, {
          method: "PUT", body: JSON.stringify({ date_start: startSec, date_end: startSec + 3600 }),
        });
        moved = r.ok;
      } catch { /* leave the task; the map re-dates off result_task_at anyway */ }
    }
    // Re-date + count on the inspection — this is what the rep's map reads for the
    // go-back's due date and the never-home flag.
    await fetch(`${SB_URL}/rest/v1/inspections?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
      body: JSON.stringify({ result_task_at: new Date(when).toISOString(), goback_not_home_count: nextCount, goback_last_attempt_at: new Date().toISOString() }),
    });

    return cors(200, JSON.stringify({ ok: true, when: new Date(when).toISOString(), count: nextCount, moved, label: whenLabel(when) }));
  } catch (e) {
    return cors(500, JSON.stringify({ ok: false, error: e.message || "error" }));
  }
};

// "Mon, Wed · 2 PM" → ms of the soonest match (ET) STARTING TOMORROW, at that
// hour. Mirrors create-result-task's scheduler (never same-day). null if unparseable.
function nextGoBackMs(reviewAvail) {
  const s = String(reviewAvail || "");
  if (!s.includes(" · ")) return null;
  const [daysPart, timePart] = s.split(" · ").map((x) => x.trim());
  const tm = timePart.match(/(\d{1,2})\s*(AM|PM)/i);
  if (!tm) return null;
  let hour = parseInt(tm[1], 10) % 12;
  if (/pm/i.test(tm[2])) hour += 12;
  const WMAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  let days;
  if (/any\s*day/i.test(daysPart)) days = [0, 1, 2, 3, 4, 5, 6];
  else {
    days = daysPart.split(",").map((d) => WMAP[d.trim().slice(0, 3).toLowerCase()]).filter((x) => x != null);
    if (!days.length) days = [0, 1, 2, 3, 4, 5, 6];
  }
  const now = Date.now();
  for (let d = 1; d < 29; d++) { // start tomorrow — never re-date to the same day
    const { y, mo, day, weekday } = etParts(now + d * 864e5);
    if (!days.includes(weekday)) continue;
    return Date.parse(etToISO(y, mo, day, hour));
  }
  return null;
}
function etParts(ms) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", weekday: "short" });
  const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const wmap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +p.year, mo: +p.month, day: +p.day, weekday: wmap[p.weekday] };
}
function etToISO(y, mo, day, hour) {
  const guess = Date.UTC(y, mo - 1, day, hour, 0);
  const asEt = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York" }));
  return new Date(guess + (guess - asEt.getTime())).toISOString();
}
function whenLabel(ms) {
  return new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", hour12: true });
}
async function okToken(token) {
  token = String(token || "").trim();
  if (!token) return false;
  const [d, v] = await Promise.all([getSetting("dialer_token"), getSetting("visit_token")]);
  return token === d || token === v;
}
async function getSetting(key) {
  const rows = await sbGet(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0] ? rows[0].value : null;
}
async function sbGet(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sb });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
