// ─────────────────────────────────────────────────────────────────────────────
// MONDAY MORNING CHECK-IN CALL. 7:00 AM ET every Monday: one email AND one text
// to every active person, telling them to check in for the day.
//
// This is deliberately NOT the same thing as payroll-nudge. That one chases the
// stragglers — it fires per person, off their own shift start, and only for
// people who HAVEN'T checked in. This is the opposite: one call to everybody at
// a fixed hour to start the week, whether or not they have a shift on file
// (most of the roster doesn't, so the shift-based nudge never reaches them).
//
// Both channels on purpose: a text is what actually gets read on a Monday
// morning, and the email carries a real clickable link — carriers block
// netlify.app URLs with a scheme, so the SMS link has to go bare.
//
// HTTP-callable on purpose so the office can preview it. The schedule lives in
// the thin wrapper cron-payroll-monday — Netlify 403s manual calls to a
// scheduled function, which is the same trap payroll-nudge hit.
//   ?dry=1            who would be contacted, sends nothing
//   ?force=1          ignore the Monday/7am gate (for a dry run any day)
//
// Env: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or VITE_SUPABASE_ANON_KEY), URL.
// ─────────────────────────────────────────────────────────────────────────────

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const BASE = (process.env.URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
const SMS_LINK = `${BASE.replace(/^https?:\/\//, "")}/timecard`;

export const handler = async (event) => {
  const q = event?.queryStringParameters || {};
  const dry = q.dry === "1";
  const force = q.force === "1";
  if (!SB_URL || !SB_KEY) return out(500, { ok: false, error: "Supabase env missing" });

  const now = nowET();                       // { date, dow, hour, minute }
  // Monday, 7 AM ET. The wrapper runs hourly around then so daylight saving
  // can't shift it; this gate is what makes it fire exactly once.
  if (!force && (now.dow !== 1 || now.hour !== 7)) {
    return out(200, { ok: true, skipped: "not 7 AM ET Monday", now });
  }

  const [emps, holidays] = await Promise.all([
    get("payroll_employees?active=is.true&select=id,first_name,last_name,phone,email,is_admin,department_id&order=last_name.asc"),
    get("payroll_holidays?active=is.true&select=holiday_date"),
  ]);

  if (holidays.some((h) => h.holiday_date === now.date)) {
    return out(200, { ok: true, skipped: "company holiday", date: now.date });
  }

  // Fires once per Monday. Written BEFORE sending — Netlify has double-invoked
  // a schedule before and sent two texts 18 seconds apart.
  const stampKey = `payroll_monday_${now.date}`;
  if (!dry && !force) {
    const existing = await get(`app_settings?key=eq.${stampKey}&select=key&limit=1`);
    if (existing.length) return out(200, { ok: true, skipped: "already sent today", date: now.date });
    await upsertSetting(stampKey, nowIso());
  }

  // Anyone already checked in doesn't need telling.
  const entries = await get(`payroll_time_entries?work_date=eq.${now.date}&select=employee_id,checked_in_at,day_type`);
  const done = new Set(entries.filter((e) => e.checked_in_at || e.day_type !== "worked").map((e) => e.employee_id));

  const wdMap = await workDaysMap(emps.map((e) => e.id));

  const sent = [], skipped = [];
  for (const e of emps) {
    const who = `${e.first_name} ${e.last_name}`.trim();
    // Somebody whose week doesn't start on Monday shouldn't be told to check in.
    if (!(wdMap[e.id] || DEFAULT_WORK_DAYS).includes(1)) { skipped.push({ who, why: "doesn't work Mondays" }); continue; }
    if (done.has(e.id)) { skipped.push({ who, why: "already checked in or off today" }); continue; }
    if (!e.phone && !e.email) { skipped.push({ who, why: "no phone or email on file" }); continue; }

    if (dry) { sent.push({ who, phone: e.phone || null, email: e.email || null, dry: true }); continue; }

    const res = { who, sms: null, email: null };
    if (e.phone) {
      // Bare link — a scheme gets the whole message blocked by the carrier.
      const msg = `Good morning ${e.first_name} - new week. Check in for today:\n\n${SMS_LINK}\n\nAt the end of the day, say what you got done.`;
      const r = await postJson("ghl-sms", { to: e.phone, name: who, message: msg, verify: true });
      res.sms = r?.delivered ? "delivered" : (r?.status || r?.error || "not delivered");
    }
    if (e.email) {
      const ok = await postJson("send-email", {
        to: e.email, subject: "Check in for the day", fromName: "U.S. Shingle Time Cards",
        html: `<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;color:#0f2a4a">` +
          `<p>Good morning ${e.first_name},</p><p>New week — check in to start your day.</p>` +
          `<p><a href="${BASE}/?mode=timecard" style="display:inline-block;padding:12px 22px;background:#0f2a4a;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Check in</a></p>` +
          `<p>At the end of the day, write a quick recap of what you got done — that's what closes the day and sets your hours.</p>` +
          `<p style="color:#64748b;font-size:13px;">U.S. Shingle &amp; Metal</p></div>`,
      });
      res.email = ok?.success ? "sent" : "failed";
    }
    sent.push(res);
  }

  return out(200, { ok: true, date: now.date, dry, force, contacted: sent.length, sent, skipped });
};


// Which days each person works — app_settings row per person, see payroll-me.
// Absent = Mon–Fri, the assumption everything made before this existed.
const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5];
async function workDaysMap(ids) {
  const out = {};
  if (!ids.length) return out;
  const rows = await get(`app_settings?key=in.(${ids.map((i) => `payroll_workdays_${i}`).join(",")})&select=key,value`);
  for (const r of rows) {
    out[String(r.key).replace("payroll_workdays_", "")] = [...new Set(
      String(r.value ?? "").split(",").map((x) => String(x).trim()).filter((x) => x !== "")
        .map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    )];
  }
  return out;
}
function dowOfDate(s) { return new Date(`${s}T12:00:00Z`).getUTCDay(); }
function nowET() {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { date: `${p.year}-${p.month}-${p.day}`, dow, hour: Number(p.hour), minute: Number(p.minute) };
}
function nowIso() { return new Date().toISOString(); }

async function get(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}
async function upsertSetting(key, value) {
  await fetch(`${SB_URL}/rest/v1/app_settings?on_conflict=key`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, value }),
  });
}
async function postJson(fn, body) {
  try {
    const r = await fetch(`${BASE}/.netlify/functions/${fn}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return await r.json().catch(() => ({}));
  } catch (e) { return { error: e.message }; }
}
function out(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) };
}
