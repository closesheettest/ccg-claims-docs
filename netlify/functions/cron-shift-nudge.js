// netlify/functions/cron-shift-nudge.js
//
// The two texts that make the daily rhythm work. Runs every 15 minutes and
// only ever messages someone who HASN'T already done the thing:
//
//   • Shift start + grace  →  "check in"   (skipped the moment they check in,
//                             or if the day is already marked off / a holiday)
//   • Shift end            →  "what did you get done today?"  (only to people
//                             who checked in and haven't filed their recap)
//
// Each nudge fires at most once per person per work date — the send is stamped
// on the timecard row (checkin_nudged_at / recap_nudged_at), so a restart or a
// double-run can't re-text anyone.
//
// Night shifts are handled by work DATE, not calendar date: a 6pm–6am shift
// belongs to the day it started, so the 6am recap text lands on the right row.
//
// Manual: ?dry=1 shows exactly who would be texted and why, sending nothing.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, URL.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const TZ = "America/New_York";
const BASE = (process.env.URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");

// How long after the moment we wait before nudging, and how long we keep trying.
const DEFAULT_CHECKIN_AFTER = 20;    // minutes past shift start (on top of grace)
const DEFAULT_RECAP_AFTER = 15;      // minutes past shift end
const WINDOW = 240;                  // stop nudging this many minutes later

export const handler = async (event) => {
  const dry = (event?.queryStringParameters || {}).dry === "1";
  if (!SB_URL || !SB_KEY) return out(500, { ok: false, error: "Supabase env missing" });

  const cfg = await payrollConfig();
  const now = nowET();
  const nowMin = mins(now.time);

  const [shifts, emps, holidays] = await Promise.all([
    get("payroll_shifts?active=is.true&select=*"),
    get("payroll_employees?active=is.true&select=id,first_name,last_name,phone,email,shift_id,standard_day_hours"),
    get("payroll_holidays?active=is.true&paid=is.true&select=holiday_date"),
  ]);
  const holSet = new Set(holidays.map((h) => h.holiday_date));
  const byShift = Object.fromEntries(shifts.map((s) => [s.id, s]));

  const sent = [], skipped = [];
  for (const e of emps) {
    const shift = byShift[e.shift_id];
    if (!shift) { skipped.push({ who: name(e), why: "no shift assigned" }); continue; }

    const wd = workDateFor(shift, now);
    // Minutes since this shift's start / end, wrapped so a night shift reads
    // sensibly on either side of midnight.
    const sinceStart = wrap(nowMin - mins(shift.start_time));
    const sinceEnd = wrap(nowMin - mins(shift.end_time));
    const checkinAfter = Number(shift.grace_minutes ?? 15) + (cfg.checkin_nudge_after_minutes ?? DEFAULT_CHECKIN_AFTER);
    const recapAfter = cfg.recap_nudge_after_minutes ?? DEFAULT_RECAP_AFTER;

    const wantCheckin = sinceStart >= checkinAfter && sinceStart <= checkinAfter + WINDOW;
    const wantRecap = sinceEnd >= recapAfter && sinceEnd <= recapAfter + WINDOW;
    if (!wantCheckin && !wantRecap) continue;

    const entry = (await get(`payroll_time_entries?employee_id=eq.${e.id}&work_date=eq.${wd}&select=*&limit=1`))[0] || null;

    // Never chase somebody who is off, or on a paid holiday.
    if (entry && entry.day_type !== "worked") { skipped.push({ who: name(e), why: `marked ${entry.day_type}` }); continue; }
    if (holSet.has(wd)) { skipped.push({ who: name(e), why: "paid holiday" }); continue; }

    let kind = null;
    if (wantRecap && entry?.checked_in_at && !entry.recap_at && !entry.recap_nudged_at) kind = "recap";
    else if (wantCheckin && !entry?.checked_in_at && !entry?.checkin_nudged_at) kind = "checkin";

    if (!kind) {
      if (wantCheckin && entry?.checked_in_at) skipped.push({ who: name(e), why: "already checked in" });
      else if (wantRecap && entry?.recap_at) skipped.push({ who: name(e), why: "recap already filed" });
      continue;
    }
    if (!e.phone) { skipped.push({ who: name(e), why: `${kind} due but no phone on file` }); continue; }

    const link = `${BASE}/?mode=timecard`;
    const msg = kind === "checkin"
      ? `Good ${greeting(shift)} ${e.first_name} — you're not checked in for your ${shift.name.toLowerCase()} shift yet. Tap to check in: ${link}`
      : `${e.first_name}, wrapping up? Take 30 seconds and tell us what you got done today: ${link}`;

    if (dry) { sent.push({ who: name(e), shift: shift.name, work_date: wd, kind, phone: e.phone, dry: true }); continue; }

    const ok = await postOk("ghl-sms", { to: e.phone, name: name(e), message: msg });
    // Stamp it even if the text failed, so a broken number doesn't get retried
    // every 15 minutes all shift long.
    await upsert({
      employee_id: e.id, work_date: wd,
      ...(kind === "checkin" ? { checkin_nudged_at: nowIso() } : { recap_nudged_at: nowIso() }),
      ...(entry ? {} : { day_type: "worked", shift_id: shift.id, source: "auto" }),
    });
    sent.push({ who: name(e), shift: shift.name, work_date: wd, kind, ok });
  }

  return out(200, { ok: true, now, dry, sent, skipped });
};

// Every 15 minutes; netlify.toml carries the same cadence (this project
// registers its crons from the toml). NOTE: `config` is Netlify's own reserved
// export — the settings reader lives under a different name on purpose.
export const config = { schedule: "*/15 * * * *" };

async function payrollConfig() {
  let cfg = {};
  try {
    const rows = await get("app_settings?key=eq.payroll_config&select=value&limit=1");
    cfg = rows[0]?.value ? JSON.parse(rows[0].value) : {};
  } catch { cfg = {}; }
  return { checkin_nudge_after_minutes: DEFAULT_CHECKIN_AFTER, recap_nudge_after_minutes: DEFAULT_RECAP_AFTER, ...cfg };
}

function name(e) { return `${e.first_name} ${e.last_name}`.trim(); }
function greeting(shift) { return mins(shift.start_time) < 720 ? "morning" : mins(shift.start_time) < 1020 ? "afternoon" : "evening"; }
function wrap(m) { return ((m % 1440) + 1440) % 1440; }
function mins(t) { const [h, m] = String(t || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); }
function crossesMidnight(sh) { return String(sh.end_time) <= String(sh.start_time); }
function workDateFor(shift, now) {
  if (!crossesMidnight(shift)) return now.date;
  return now.time < shift.end_time ? addDays(now.date, -1) : now.date;
}
function nowET() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function addDays(s, n) { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function nowIso() { return new Date().toISOString(); }

async function postOk(fn, body) {
  try {
    const r = await fetch(`${BASE}/.netlify/functions/${fn}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.ok;
  } catch { return false; }
}
async function get(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function upsert(row) {
  await fetch(`${SB_URL}/rest/v1/payroll_time_entries?on_conflict=employee_id,work_date`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row),
  }).catch(() => null);
}
function out(status, body) { return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) }; }
