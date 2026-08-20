// netlify/functions/payroll-me.js
//
// The EMPLOYEE side of payroll/timekeeping (?mode=timecard), plus the
// department manager's daily review and their ONE weekly sign-off. One login
// serves both: a manager is just an employee with is_manager, and sees an
// extra Team tab.
//
// The day is built from TWO taps, not a punch clock: they CHECK IN when their
// shift starts, and at the end they file a RECAP of what they got done, which
// closes the day out and sets the hours. Shifts are named and office-defined
// (Day 7:00a–3:30p, Night 6:00p–6:00a); a night shift's whole span is filed
// under the date it STARTED, so one night is one row on one work date.
//
// Login: THEIR PHONE NUMBER + a 4–8 digit passcode. Most of the field crew have
// no company email, so the phone is the identifier — any formatting works, it
// matches on the last 10 digits (an office person can still sign in with their
// email if they'd rather). The FIRST time a person logs in, whatever passcode
// they type becomes theirs (same idea as My Tools), stored salted+hashed — never
// in the clear, because this app's Supabase key is public. A login returns an
// opaque session token (payroll_sessions, 30 days) that every other call carries.
//
//   POST { action, token, ... }
//
//   ── anyone ──────────────────────────────────────────────────────────
//   Office/HR (is_admin) may add  as_employee_id  to any READ action to see the
//   app exactly as that person sees it — for checking a screen while building it
//   out. Writes are refused while viewing as somebody else, so looking at a
//   screen can never clock them in, book their time off or sign their day.
//
//   "who"           { login }                    → { found, passcode_set, name }
//   "login"         { login, passcode }          → { token, me }
//                   ("login" is a phone number, or an email for office staff)
//   "logout"        { token }
//   "set_passcode"  { token, passcode }
//   "me"            { token }                    → me + balances + holidays + shift
//   "today"         { token }                    → my current shift-day + its state
//   "check_in"      { token }                    → stamp the start of my shift
//   "undo_check_in" { token }                    → checked in by mistake, take it back
//   "break"         { token, minutes, reason }   → step away mid-shift, with a why
//   "check_out"     { token, recap, ... }        → recap + close the day out
//   "reopen_day"    { token }                    → ended the shift too early, carry on
//   "save_recap"    { token, work_date?, recap } → fix a recap afterwards
//   "day_off"       { token, day_type, reason }  → "I'm off today" (a reason is required)
//   "week"          { token, week_start? }       → my 7 days + totals + lock state
//   "save_day"      { token, work_date, ... }    → upsert one day of my timecard
//   "submit_week"   { token, week_start }        → "my week is done"
//   "request_off"   { token, request_type, start_date, end_date, ... }
//   "cancel_off"    { token, id }
//   "my_time_off"   { token }
//
//   ── department manager (is_manager) / office (is_admin) ─────────────
//   "team_today"    { token, work_date?, department_id? }    → who's in, and what
//                                                              everyone got done today
//   "team_week"     { token, week_start?, department_id? }  → every member's week
//   "team_save_day" { token, employee_id, work_date, ... }  → fix a member's day
//   "approve_week"  { token, week_start, sign_name, note? } → SIGN OFF the week + lock
//   "reopen_signoff"{ token, work_date, department_id? }     → admin only
//   "off_queue"     { token }                               → pending requests
//   "shifts"        { token }                               → the shift list
//   "set_shift"     { token, employee_id, shift_id }        → put one of MY team
//                                                             on a shift
//   "add_teammate"  { token, first_name, last_name, ... }   → add somebody to MY
//                                                             department
//   "deactivate_teammate" { token, employee_id }            → take one of MY team
//                                                             off the roster
//   "decide_off"    { token, id, decision, note? }          → approve / deny
//
// Sign-off is ONCE A WEEK: after the week finishes a manager reviews their
// department's whole week and signs it, which locks every entry in it so the
// numbers can't move after payroll sees them, and snapshots the totals. They
// still get the daily board (Team → Today) to watch the week as it happens —
// that's for reading, not signing.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

import crypto from "node:crypto";

const SB_URL = process.env.VITE_SUPABASE_URL;
// SERVICE KEY, not the anon key. The anon key ships in the public page bundle,
// so anything it can reach is world-readable — and once RLS is on for the
// payroll tables it can reach nothing here at all. Falls back to anon so this
// deploy is safe BEFORE the service key is set and RLS is enabled.
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const TZ = "America/New_York";
const SESSION_DAYS = 30;
const BASE = (process.env.URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
// Who these emails come FROM on screen. The address stays the domain verified
// with Resend; only the display name changes, so "Inspection For You" doesn't
// show up on an email asking somebody to sign off hours.
const MAIL_FROM_NAME = "U.S. Shingle Time Cards";

const EMP_SEL =
  "id,first_name,last_name,email,phone,department_id,title,pay_type," +
  "standard_day_hours,standard_week_hours,hire_date,pto_days_per_year,pto_carryover_days," +
  "sick_days_per_year,paid_holidays,shift_id,is_manager,is_admin,active,passcode_hash";

// Everything after the digits is noise: "813-955-5126", "(813) 955-5126" and
// "+1 813 955 5126" are one person. The office API stores this same bare form,
// so a login is an exact compare — no extra column, no migration.
const phoneKey = (v) => { const d = String(v || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };

// Day types an employee can put on their own timecard. "holiday" is filled in
// automatically from the holiday calendar; "no_show" is manager/office only.
const SELF_DAY_TYPES = ["worked", "pto", "sick", "doctor", "unpaid", "bereavement", "jury", "other"];
const OFF_TYPES = ["", "pto", "sick", "doctor", "unpaid", "other"];
// What a mid-shift break can be. "personal" is filed as an "other" absence so it
// never lands in the PTO or sick buckets.
const BREAK_TYPES = ["personal", "doctor", "unpaid"];
const OFF_REQUEST_TYPES = ["pto", "sick", "doctor", "unpaid", "bereavement", "jury", "other"];
// A time-off request type → the day_type it writes onto the timecard.
const REQ_TO_DAY = { pto: "pto", sick: "sick", doctor: "doctor", unpaid: "unpaid", bereavement: "bereavement", jury: "jury", other: "other" };
// Which day types burn which balance.
// Everything an admin may do while wearing somebody else's shoes. Deliberately
// short: reads only.
const VIEW_AS_READ_ONLY = ["me", "today", "week", "my_time_off", "team_today", "team_week", "off_queue"];
const PTO_TYPES = ["pto"];
const SICK_TYPES = ["sick", "doctor"];

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, j({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, j({ ok: false, error: "Supabase env missing" }));

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return cors(400, j({ ok: false, error: "bad JSON" })); }
  const action = String(body.action || "").trim();

  try {
    // ── Pre-auth: does this email have a passcode yet? ──────────────
    if (action === "who") {
      const emp = await empByLogin(body.login ?? body.phone ?? body.email);
      if (!emp) return cors(200, j({ ok: true, found: false }));
      return cors(200, j({ ok: true, found: true, passcode_set: !!emp.passcode_hash, name: emp.first_name }));
    }

    if (action === "login") {
      const emp = await empByLogin(body.login ?? body.phone ?? body.email);
      const pass = String(body.passcode || "").trim();
      if (!emp) return cors(404, j({ ok: false, error: "We don't have that number on the roster. Use the mobile number the office texts you on." }));
      if (!emp.active) return cors(403, j({ ok: false, error: "That employee record is inactive. Check with the office." }));
      if (!/^\d{4,8}$/.test(pass)) return cors(400, j({ ok: false, error: "Passcode must be 4–8 digits." }));
      if (!emp.passcode_hash) {
        const salt = crypto.randomBytes(8).toString("hex");
        await patch(`payroll_employees?id=eq.${emp.id}`, { passcode_salt: salt, passcode_hash: hash(salt, pass), passcode_set_at: nowIso() });
      } else {
        const full = (await get(`payroll_employees?id=eq.${emp.id}&select=passcode_salt,passcode_hash&limit=1`))[0] || {};
        if (hash(full.passcode_salt || "", pass) !== full.passcode_hash) return cors(401, j({ ok: false, error: "Wrong passcode." }));
      }
      const token = crypto.randomBytes(24).toString("hex");
      await post("payroll_sessions", {
        token, employee_id: emp.id,
        expires_at: new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString(),
        user_agent: (event.headers?.["user-agent"] || "").slice(0, 200),
      });
      return cors(200, j({ ok: true, token, me: await meBundle(emp) }));
    }

    // ── Everything below needs a live session ───────────────────────
    const signedIn = await session(body.token);
    if (!signedIn) return cors(401, j({ ok: false, error: "Your session expired — sign in again." }));

    // "View as" — office/HR only, and read-only. `me` becomes the person being
    // looked at, so every screen below renders exactly what THEY would see.
    let me = signedIn, viewingAs = null;
    const asId = str(body.as_employee_id, 64);
    if (asId && asId !== signedIn.id) {
      if (!signedIn.is_admin) return cors(403, j({ ok: false, error: "Only the office can view as someone else." }));
      if (!VIEW_AS_READ_ONLY.includes(action)) {
        return cors(403, j({ ok: false, error: "You're viewing as someone else — this is a look, not a change. Switch back to your own login to do that." }));
      }
      const target = (await get(`payroll_employees?id=eq.${asId}&select=${EMP_SEL}&limit=1`))[0];
      if (!target) return cors(404, j({ ok: false, error: "That employee isn't on the roster." }));
      me = target;
      viewingAs = { id: target.id, name: fullName(target) };
    }

    if (action === "logout") {
      await del(`payroll_sessions?token=eq.${encodeURIComponent(String(body.token))}`);
      return cors(200, j({ ok: true }));
    }

    if (action === "set_passcode") {
      const pass = String(body.passcode || "").trim();
      if (!/^\d{4,8}$/.test(pass)) return cors(400, j({ ok: false, error: "Passcode must be 4–8 digits." }));
      const salt = crypto.randomBytes(8).toString("hex");
      await patch(`payroll_employees?id=eq.${me.id}`, { passcode_salt: salt, passcode_hash: hash(salt, pass), passcode_set_at: nowIso() });
      return cors(200, j({ ok: true }));
    }

    if (action === "me") return cors(200, j({ ok: true, me: await meBundle(me), viewing_as: viewingAs }));

    // ── Today: the check-in / recap screen ──────────────────────────
    if (action === "today") return cors(200, j({ ok: true, ...(await todayFor(me)) }));

    if (action === "check_in") {
      const t = await todayFor(me);
      if (t.locked) return cors(400, j({ ok: false, error: "That day is already signed off." }));
      if (t.entry?.checked_in_at) return cors(200, j({ ok: true, already: true, ...(await todayFor(me)) }));
      const now = nowET();
      await upsert("payroll_time_entries", {
        employee_id: me.id, work_date: t.work_date, day_type: "worked",
        shift_id: t.shift?.id || null, checked_in_at: nowIso(), time_in: now.time,
        late_minutes: lateBy(t.shift, now.time),
        source: "employee", updated_at: nowIso(),
      }, "employee_id,work_date");
      return cors(200, j({ ok: true, ...(await todayFor(me)) }));
    }

    // Tapped check-in when they meant something else. Wipes the stamp; if that
    // leaves an otherwise empty day, the row goes too, so it reads as untouched.
    if (action === "undo_check_in") {
      const t = await todayFor(me);
      if (t.locked) return cors(400, j({ ok: false, error: "That day is already signed off." }));
      const e = t.entry;
      if (!e) return cors(200, j({ ok: true, ...(await todayFor(me)) }));
      if (e.recap_at) return cors(400, j({ ok: false, error: "You've already closed this day out — reopen it first." }));
      const bare = !e.recap && !Number(e.off_hours || 0) && !e.note;
      if (bare) await del(`payroll_time_entries?employee_id=eq.${me.id}&work_date=eq.${t.work_date}`);
      else {
        await patch(`payroll_time_entries?employee_id=eq.${me.id}&work_date=eq.${t.work_date}`, {
          checked_in_at: null, time_in: null, late_minutes: 0, hours: 0, updated_at: nowIso(),
        });
      }
      return cors(200, j({ ok: true, ...(await todayFor(me)) }));
    }

    // Stepping away mid-shift. Each break is minutes + a reason; they stack up on
    // the day, come off the hours worked, and the manager sees every one.
    if (action === "break") {
      const t = await todayFor(me);
      if (t.locked) return cors(400, j({ ok: false, error: "That day is already signed off." }));
      if (!t.entry?.checked_in_at) return cors(400, j({ ok: false, error: "Check in first." }));
      // A break can't be longer than the shift it happens in, and the day's
      // breaks together can't exceed it either. Without this a fat-fingered
      // "720" wiped a whole day's hours to 0 and looked like the tool was broken.
      const shiftMins = shiftLength(t.shift) || Math.round((Number(me.standard_day_hours || 8) || 8) * 60);
      const alreadyAway = Math.round(Number(t.entry.off_hours || 0) * 60);
      const remaining = Math.max(0, shiftMins - alreadyAway);
      const asked = Math.round(clampNum(body.minutes, 1, 1440));
      const minutes = Math.min(asked, remaining);
      const reason = str(body.reason, 200);
      if (!asked) return cors(400, j({ ok: false, error: "How long were you away?" }));
      if (reason.length < 2) return cors(400, j({ ok: false, error: "Add a quick reason for the break." }));
      if (!remaining) {
        return cors(400, j({ ok: false, error: `You've already logged ${Math.round(alreadyAway / 60 * 10) / 10}h of breaks — that's your whole ${Math.round(shiftMins / 60)}h shift. Fix the earlier one instead.` }));
      }
      const kind = BREAK_TYPES.includes(body.break_type) ? body.break_type : "personal";
      const now = nowET();
      const line = `🕑 ${now.time} · ${minutes} min ${kind} break — ${reason}`;
      const capped = minutes < asked;
      await upsert("payroll_time_entries", {
        employee_id: me.id, work_date: t.work_date,
        off_type: kind === "personal" ? "other" : kind,
        off_hours: round2(Number(t.entry.off_hours || 0) + minutes / 60),
        note: [t.entry.note, line].filter(Boolean).join("\n").slice(0, 2000),
        updated_at: nowIso(),
      }, "employee_id,work_date");
      return cors(200, j({
        ok: true, minutes, capped,
        ...(capped ? { notice: `Logged ${minutes} min — a break can't run longer than your ${Math.round(shiftMins / 60)}h shift.` } : {}),
        ...(await todayFor(me)),
      }));
    }

    // Ended the shift early by mistake — put them back on the clock. The recap
    // they already wrote is kept; ending again overwrites it.
    if (action === "reopen_day") {
      const t = await todayFor(me);
      if (t.locked) return cors(400, j({ ok: false, error: "That day is already signed off — ask the office." }));
      if (!t.entry?.recap_at) return cors(400, j({ ok: false, error: "That day isn't closed out." }));
      await patch(`payroll_time_entries?employee_id=eq.${me.id}&work_date=eq.${t.work_date}`, {
        checked_out_at: null, time_out: null, recap_at: null, left_early_minutes: 0, hours: 0, updated_at: nowIso(),
      });
      return cors(200, j({ ok: true, ...(await todayFor(me)) }));
    }

    // The recap IS the clock-out — you can't close a day without saying what
    // you got done, which is the whole point of the evening step.
    if (action === "check_out") {
      const t = await todayFor(me);
      if (t.locked) return cors(400, j({ ok: false, error: "That day is already signed off." }));
      const recap = str(body.recap, 2000);
      if (recap.length < 3) return cors(400, j({ ok: false, error: "Write a line about what you got done today." }));
      if (!t.entry?.checked_in_at) return cors(400, j({ ok: false, error: "You never checked in today — check in first, or mark the day off." }));
      const now = nowET();
      const lunch = clampNum(body.lunch_minutes, 0, 240) || Number(t.entry.lunch_minutes || 0);
      // Time away — lunch plus any breaks logged during the shift — isn't worked.
      const awayMinutes = lunch + Math.round(Number(t.entry.off_hours || 0) * 60);
      const hours = hoursBetween(t.entry.checked_in_at, new Date().toISOString(), awayMinutes);
      await upsert("payroll_time_entries", {
        employee_id: me.id, work_date: t.work_date, day_type: t.entry.day_type || "worked",
        checked_out_at: nowIso(), time_out: now.time, lunch_minutes: lunch, hours,
        recap, recap_at: nowIso(),
        left_early_minutes: earlyBy(t.shift, now.time),
        off_type: OFF_TYPES.includes(body.off_type || "") ? (body.off_type || null) : (t.entry.off_type || null),
        off_hours: clampNum(body.off_hours, 0, 24) || Number(t.entry.off_hours || 0),
        note: str(body.note, 500) || t.entry.note || null,
        source: "employee", updated_at: nowIso(),
      }, "employee_id,work_date");
      return cors(200, j({ ok: true, ...(await todayFor(me)) }));
    }

    if (action === "save_recap") {
      const wd = dstr(body.work_date) || (await todayFor(me)).work_date;
      const ex = (await get(`payroll_time_entries?employee_id=eq.${me.id}&work_date=eq.${wd}&select=id,locked&limit=1`))[0];
      if (!ex) return cors(404, j({ ok: false, error: "Nothing logged for that day yet." }));
      if (ex.locked) return cors(400, j({ ok: false, error: "That week is signed off." }));
      const recap = str(body.recap, 2000);
      if (recap.length < 3) return cors(400, j({ ok: false, error: "Write a line about what you got done." }));
      await patch(`payroll_time_entries?id=eq.${ex.id}`, { recap, recap_at: nowIso(), updated_at: nowIso() });
      return cors(200, j({ ok: true }));
    }

    // "I'm off today" — straight onto the card, no request/approval round-trip
    // (it still counts against their balance, and the manager sees it).
    if (action === "day_off") {
      const t = await todayFor(me);
      const wd = dstr(body.work_date) || t.work_date;
      const dayType = SELF_DAY_TYPES.includes(body.day_type) && body.day_type !== "worked" ? body.day_type : "pto";
      // A day off always carries a why — it's what the manager reads on their board.
      const reason = str(body.reason ?? body.note, 500);
      if (reason.length < 3) return cors(400, j({ ok: false, error: "Add a short reason for the day off." }));
      const ex = (await get(`payroll_time_entries?employee_id=eq.${me.id}&work_date=eq.${wd}&select=id,locked&limit=1`))[0];
      if (ex?.locked) return cors(400, j({ ok: false, error: "That week is signed off." }));
      await upsert("payroll_time_entries", {
        employee_id: me.id, work_date: wd, day_type: dayType, shift_id: t.shift?.id || null,
        hours: 0, off_type: null, off_hours: Number(me.standard_day_hours || 8) || 8,
        time_in: null, time_out: null, checked_in_at: null, checked_out_at: null,
        late_minutes: 0, left_early_minutes: 0,
        note: reason, source: "employee", updated_at: nowIso(),
      }, "employee_id,work_date");
      await notifyManager(me, {
        subject: `${fullName(me)} is off ${pretty(wd)}`,
        line: `${fullName(me)} marked ${pretty(wd)} as ${LABEL[dayType] || dayType}.`,
        detail: reason,
        cta: "See the day",
      });
      return cors(200, j({ ok: true, ...(await todayFor(me)) }));
    }

    // ── My week ─────────────────────────────────────────────────────
    if (action === "week") {
      const ws = weekStart(body.week_start || todayET());
      return cors(200, j({ ok: true, ...(await weekFor(me, ws)) }));
    }

    if (action === "save_day") {
      const out = await saveDay(me, me, body, "employee");
      return cors(out.ok ? 200 : 400, j(out));
    }

    if (action === "submit_week") {
      const ws = weekStart(body.week_start || todayET());
      await upsert("payroll_week_submits", { employee_id: me.id, week_start: ws, submitted_at: nowIso() }, "employee_id,week_start");
      return cors(200, j({ ok: true, submitted_at: nowIso() }));
    }

    // ── Time off ────────────────────────────────────────────────────
    if (action === "request_off") {
      const type = OFF_REQUEST_TYPES.includes(body.request_type) ? body.request_type : "pto";
      const start = dstr(body.start_date), end = dstr(body.end_date) || dstr(body.start_date);
      if (!start || !end) return cors(400, j({ ok: false, error: "Pick a start and end date." }));
      if (end < start) return cors(400, j({ ok: false, error: "The end date is before the start date." }));
      const partial = !!body.partial;
      const perDay = partial ? clampNum(body.hours_per_day, 0.5, 12) : Number(me.standard_day_hours || 8);
      const days = await workDaysBetween(start, end);
      if (!days.length) return cors(400, j({ ok: false, error: "That range is all weekend/holiday — nothing to request." }));
      const totalDays = partial ? round2((perDay * days.length) / Number(me.standard_day_hours || 8)) : days.length;
      const row = (await post("payroll_time_off", {
        employee_id: me.id, request_type: type, start_date: start, end_date: end,
        partial, hours_per_day: partial ? perDay : null,
        total_days: totalDays, total_hours: round2(perDay * days.length),
        note: str(body.note, 500) || null, status: "pending",
      }, true))[0];
      const when = start === end ? pretty(start) : `${pretty(start)}–${pretty(end)}`;
      const sent = await notifyManager(me, {
        subject: `Time off requested — ${fullName(me)}`,
        line: `${fullName(me)} requested ${totalDays} ${totalDays === 1 ? "day" : "days"} ${LABEL[type] || type} on ${when}.`,
        detail: str(body.note, 500),
        cta: "Approve or deny",
      });
      return cors(200, j({ ok: true, request: row, manager_notified: sent }));
    }

    if (action === "cancel_off") {
      const id = str(body.id, 64);
      const req = (await get(`payroll_time_off?id=eq.${id}&select=*&limit=1`))[0];
      if (!req) return cors(404, j({ ok: false, error: "Request not found." }));
      const mine = req.employee_id === me.id;
      if (!mine && !(await managesEmployee(me, req.employee_id))) return cors(403, j({ ok: false, error: "Not yours to cancel." }));
      if (req.status === "approved" && !mine) { /* manager pulling back an approval is fine */ }
      await patch(`payroll_time_off?id=eq.${id}`, { status: "cancelled" });
      return cors(200, j({ ok: true }));
    }

    if (action === "my_time_off") {
      const rows = await get(`payroll_time_off?employee_id=eq.${me.id}&select=*&order=start_date.desc&limit=100`);
      return cors(200, j({ ok: true, requests: rows }));
    }

    // ── Manager / office from here down ─────────────────────────────
    if (!me.is_manager && !me.is_admin) return cors(403, j({ ok: false, error: "That's a manager-only screen." }));

    // What everyone on the team got done today — the manager's daily read.
    if (action === "team_today") {
      const depts = await myDepartments(me, body.department_id);
      if (!depts.length) return cors(200, j({ ok: true, departments: [] }));
      const out = [];
      for (const d of depts) out.push(await departmentDay(d, dstr(body.work_date) || ""));
      return cors(200, j({ ok: true, departments: out }));
    }

    if (action === "team_week") {
      const ws = weekStart(body.week_start || lastWeekStart());
      const depts = await myDepartments(me, body.department_id);
      if (!depts.length) return cors(200, j({ ok: true, week_start: ws, departments: [] }));
      const out = [];
      for (const d of depts) out.push(await departmentWeek(d, ws));
      return cors(200, j({ ok: true, week_start: ws, week_end: addDays(ws, 6), departments: out, config: await config() }));
    }

    if (action === "team_save_day") {
      const empId = str(body.employee_id, 64);
      if (!(await managesEmployee(me, empId))) return cors(403, j({ ok: false, error: "That employee isn't on your team." }));
      const emp = (await get(`payroll_employees?id=eq.${empId}&select=${EMP_SEL}&limit=1`))[0];
      const out = await saveDay(me, emp, body, me.is_admin ? "office" : "manager");
      return cors(out.ok ? 200 : 400, j(out));
    }

    if (action === "approve_week") {
      const ws = weekStart(body.week_start || addDays(todayET(), -7));
      const signName = str(body.sign_name, 120);
      if (!signName) return cors(400, j({ ok: false, error: "Type your name to sign off." }));
      const depts = await myDepartments(me, body.department_id);
      if (!depts.length) return cors(400, j({ ok: false, error: "You don't manage a department yet — the office sets that." }));
      const done = [];
      for (const d of depts) done.push(await approveDepartmentWeek(me, d, ws, signName, str(body.note, 500)));
      return cors(200, j({ ok: true, approved: done }));
    }

    if (action === "reopen_signoff") {
      if (!me.is_admin) return cors(403, j({ ok: false, error: "Only the office can reopen a signed-off week." }));
      const ws = weekStart(dstr(body.week_start) || "");
      if (!dstr(body.week_start)) return cors(400, j({ ok: false, error: "Which week?" }));
      const depts = await myDepartments(me, body.department_id);
      for (const d of depts) {
        const ids = (await get(`payroll_employees?department_id=eq.${d.id}&select=id`)).map((e) => e.id);
        if (ids.length) await patch(`payroll_time_entries?employee_id=in.(${ids.join(",")})&work_date=gte.${ws}&work_date=lte.${addDays(ws, 6)}`, { locked: false });
        await patch(`payroll_week_approvals?department_id=eq.${d.id}&week_start=eq.${ws}`, { status: "open", approved_at: null, approved_by: null, approved_by_name: null, updated_at: nowIso() });
      }
      return cors(200, j({ ok: true }));
    }

    // A manager sets which shift their own people work. They can't create or
    // retime shifts — that stays with the office — only choose from the list.
    if (action === "shifts") {
      return cors(200, j({ ok: true, shifts: await allShifts() }));
    }

    if (action === "set_shift") {
      const empId = str(body.employee_id, 64);
      if (!(await managesEmployee(me, empId))) return cors(403, j({ ok: false, error: "That employee isn't on your team." }));
      const shiftId = str(body.shift_id, 64);
      if (shiftId) {
        const sh = (await get(`payroll_shifts?id=eq.${shiftId}&active=is.true&select=id&limit=1`))[0];
        if (!sh) return cors(404, j({ ok: false, error: "That shift doesn't exist." }));
      }
      await patch(`payroll_employees?id=eq.${empId}`, { shift_id: shiftId || null, updated_at: nowIso() });
      return cors(200, j({ ok: true }));
    }

    // A manager can staff their own department: add somebody, or take them off.
    // Scoped hard to the departments they run — never anyone else's people, and
    // they can't grant manager or office access.
    if (action === "add_teammate") {
      const depts = await myDepartments(me, body.department_id);
      if (!depts.length) return cors(400, j({ ok: false, error: "You don't run a department yet — the office sets that." }));
      if (depts.length > 1 && !body.department_id) return cors(400, j({ ok: false, error: "Which department should they go in?" }));
      const first = str(body.first_name, 60), last = str(body.last_name, 60);
      if (!first || !last) return cors(400, j({ ok: false, error: "First and last name, please." }));
      const phone = phoneKey(body.phone);
      const email = str(body.email, 160).toLowerCase() || null;
      if (phone) {
        const dupe = await get(`payroll_employees?phone=eq.${phone}&select=first_name,last_name&limit=1`);
        if (dupe.length) return cors(400, j({ ok: false, error: `That number is already on the roster (${dupe[0].first_name} ${dupe[0].last_name}).` }));
      }
      const shiftId = str(body.shift_id, 64) || null;
      const row = (await post("payroll_employees", {
        first_name: first, last_name: last, phone: phone || null, email,
        department_id: depts[0].id, shift_id: shiftId,
        title: str(body.title, 120) || null, pay_type: "hourly", active: true,
      }, true))[0];
      return cors(200, j({ ok: true, employee: { id: row?.id, name: `${first} ${last}` }, needs_login: !phone && !email }));
    }

    if (action === "deactivate_teammate") {
      const empId = str(body.employee_id, 64);
      if (empId === me.id) return cors(400, j({ ok: false, error: "You can't take yourself off the roster." }));
      if (!(await managesEmployee(me, empId))) return cors(403, j({ ok: false, error: "That employee isn't on your team." }));
      // Deactivate, never delete — their hours and recaps have to stay put.
      await patch(`payroll_employees?id=eq.${empId}`, { active: false, updated_at: nowIso() });
      await del(`payroll_sessions?employee_id=eq.${empId}`);
      return cors(200, j({ ok: true }));
    }

    if (action === "off_queue") {
      const depts = await myDepartments(me, body.department_id);
      const ids = await teamIds(depts);
      if (!ids.length) return cors(200, j({ ok: true, requests: [] }));
      const rows = await get(`payroll_time_off?employee_id=in.(${ids.join(",")})&status=eq.pending&select=*&order=start_date.asc&limit=200`);
      const emps = await empMap(ids);
      return cors(200, j({ ok: true, requests: rows.map((r) => ({ ...r, employee: emps[r.employee_id] || null })) }));
    }

    if (action === "decide_off") {
      const id = str(body.id, 64);
      const decision = body.decision === "approved" ? "approved" : "denied";
      const req = (await get(`payroll_time_off?id=eq.${id}&select=*&limit=1`))[0];
      if (!req) return cors(404, j({ ok: false, error: "Request not found." }));
      if (!(await managesEmployee(me, req.employee_id))) return cors(403, j({ ok: false, error: "Not your team." }));
      await patch(`payroll_time_off?id=eq.${id}`, {
        status: decision, decided_by: me.id, decided_by_name: fullName(me),
        decided_at: nowIso(), decision_note: str(body.note, 500) || null,
      });
      let placed = 0;
      if (decision === "approved") placed = await materializeTimeOff(req);
      const emp = (await get(`payroll_employees?id=eq.${req.employee_id}&select=first_name,last_name,phone,email&limit=1`))[0];
      if (emp) {
        const when = req.start_date === req.end_date ? pretty(req.start_date) : `${pretty(req.start_date)}–${pretty(req.end_date)}`;
        const verb = decision === "approved" ? "approved" : "not approved";
        const txt = `US Shingle: your time off for ${when} was ${verb} by ${fullName(me)}.` + (str(body.note, 300) ? ` ${str(body.note, 300)}` : "");
        if (emp.phone) await sendSms(emp.phone, fullName(emp), txt);
        if (emp.email) await sendEmail(emp.email, `Time off ${verb} — ${when}`, `<p>${txt}</p>`);
      }
      return cors(200, j({ ok: true, status: decision, days_placed: placed }));
    }

    return cors(400, j({ ok: false, error: `unknown action "${action}"` }));
  } catch (e) {
    return cors(500, j({ ok: false, error: e.message || "error" }));
  }
};

// ══ the pieces ═══════════════════════════════════════════════════════

// Everything the employee app needs on load: who I am, my department, my
// balances, the holiday list, and (for a manager) which teams I sign off.
async function meBundle(emp) {
  const [dept, bal, hol, cfg, shift] = await Promise.all([
    emp.department_id ? get(`payroll_departments?id=eq.${emp.department_id}&select=id,name,manager_employee_id&limit=1`).then((r) => r[0] || null) : null,
    balances(emp),
    get(`payroll_holidays?active=is.true&holiday_date=gte.${addDays(todayET(), -30)}&select=holiday_date,name,paid,hours&order=holiday_date.asc&limit=40`),
    config(),
    shiftOf(emp),
  ]);
  const managed = (emp.is_manager || emp.is_admin) ? await myDepartments(emp) : [];
  return {
    id: emp.id, first_name: emp.first_name, last_name: emp.last_name, email: emp.email, phone: emp.phone,
    title: emp.title, pay_type: emp.pay_type, standard_day_hours: Number(emp.standard_day_hours || 8),
    standard_week_hours: Number(emp.standard_week_hours || 40),
    is_manager: !!emp.is_manager, is_admin: !!emp.is_admin, passcode_set: !!emp.passcode_hash,
    department: dept, balances: bal, holidays: hol, config: cfg, shift,
    manages: managed.map((d) => ({ id: d.id, name: d.name })),
    day_types: SELF_DAY_TYPES, off_types: OFF_TYPES, request_types: OFF_REQUEST_TYPES,
  };
}

// PTO + sick balances, counted off the TIMECARD (the single source of truth —
// approved requests write days onto it), so a day the office keyed in by hand
// counts the same as one from a request.
async function balances(emp) {
  const y = todayET().slice(0, 4);
  const dayHrs = Number(emp.standard_day_hours || 8) || 8;
  const [entries, pendingRows] = await Promise.all([
    get(`payroll_time_entries?employee_id=eq.${emp.id}&work_date=gte.${y}-01-01&work_date=lte.${y}-12-31&select=day_type,off_type,off_hours,hours`),
    get(`payroll_time_off?employee_id=eq.${emp.id}&status=eq.pending&select=request_type,total_days`),
  ]);
  let ptoUsed = 0, sickUsed = 0;
  for (const e of entries) {
    // A day off counts as the fraction of a standard day it actually took —
    // a half-day at the doctor burns half a day, not a whole one.
    const off = Number(e.off_hours || 0) / dayHrs;
    const full = off || 1;
    if (PTO_TYPES.includes(e.day_type)) ptoUsed += full;
    else if (PTO_TYPES.includes(e.off_type || "")) ptoUsed += off;
    if (SICK_TYPES.includes(e.day_type)) sickUsed += full;
    else if (SICK_TYPES.includes(e.off_type || "")) sickUsed += off;
  }
  const pendingPto = pendingRows.filter((r) => r.request_type === "pto").reduce((s, r) => s + Number(r.total_days || 0), 0);
  const allot = Number(emp.pto_days_per_year || 0) + Number(emp.pto_carryover_days || 0);
  return {
    year: y,
    pto: { allotted: allot, used: round2(ptoUsed), pending: round2(pendingPto), remaining: round2(allot - ptoUsed - pendingPto) },
    sick: { allotted: Number(emp.sick_days_per_year || 0), used: round2(sickUsed), remaining: round2(Number(emp.sick_days_per_year || 0) - sickUsed) },
  };
}

// One employee's Monday–Sunday week: their 7 rows (blank days included),
// holiday auto-fill, running totals, and whether it's locked/submitted.
async function weekFor(emp, ws) {
  const we = addDays(ws, 6);
  const [rows, hols, submit, appr] = await Promise.all([
    get(`payroll_time_entries?employee_id=eq.${emp.id}&work_date=gte.${ws}&work_date=lte.${we}&select=*&order=work_date.asc`),
    get(`payroll_holidays?active=is.true&holiday_date=gte.${ws}&holiday_date=lte.${we}&select=holiday_date,name,paid,hours`),
    get(`payroll_week_submits?employee_id=eq.${emp.id}&week_start=eq.${ws}&select=submitted_at&limit=1`),
    emp.department_id ? get(`payroll_week_approvals?department_id=eq.${emp.department_id}&week_start=eq.${ws}&select=*&limit=1`) : [],
  ]);
  const byDate = Object.fromEntries(rows.map((r) => [r.work_date, r]));
  const holByDate = Object.fromEntries(hols.map((h) => [h.holiday_date, h]));
  const weekApproval = (appr || [])[0] || null;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    days.push({
      work_date: d, weekday: weekdayName(d), holiday: holByDate[d] || null,
      entry: byDate[d] || null,
    });
  }
  return {
    week_start: ws, week_end: we, days,
    totals: weekTotals(days.map((d) => d.entry).filter(Boolean), emp),
    submitted_at: submit[0]?.submitted_at || null,
    approval: weekApproval,
    locked: rows.some((r) => r.locked) || weekApproval?.status === "approved",
  };
}

// Worked / off / OT for a set of entries.
function weekTotals(entries, emp) {
  const dayHrs = Number(emp?.standard_day_hours || 8) || 8;
  const weekHrs = Number(emp?.standard_week_hours || 40) || 40;
  let worked = 0, off = 0, holiday = 0, pto = 0, sick = 0, unpaid = 0, late = 0, early = 0;
  for (const e of entries) {
    worked += Number(e.hours || 0);
    const oh = Number(e.off_hours || 0);
    off += oh;
    late += Number(e.late_minutes || 0);
    early += Number(e.left_early_minutes || 0);
    const bucket = (t, h) => {
      if (t === "holiday") holiday += h;
      else if (PTO_TYPES.includes(t)) pto += h;
      else if (SICK_TYPES.includes(t)) sick += h;
      else if (t === "unpaid") unpaid += h;
    };
    if (e.day_type !== "worked") bucket(e.day_type, Number(e.hours || 0) > 0 ? oh : (oh || dayHrs));
    else if (e.off_type) bucket(e.off_type, oh);
  }
  const paidOther = holiday + pto + sick;
  return {
    worked: round2(worked), off: round2(off), holiday: round2(holiday), pto: round2(pto),
    sick: round2(sick), unpaid: round2(unpaid),
    late_minutes: late, left_early_minutes: early,
    regular: round2(Math.min(worked, weekHrs)),
    overtime: round2(Math.max(0, worked - weekHrs)),
    paid_total: round2(worked + paidOther),
  };
}

// Upsert one day. `actor` is who is typing; `emp` is whose card it is.
async function saveDay(actor, emp, b, source) {
  if (!emp) return { ok: false, error: "Employee not found." };
  const date = dstr(b.work_date);
  if (!date) return { ok: false, error: "A date is required." };

  const existing = (await get(`payroll_time_entries?employee_id=eq.${emp.id}&work_date=eq.${date}&select=id,locked&limit=1`))[0];
  if (existing?.locked && !actor.is_admin) return { ok: false, error: "That week is already signed off. Ask the office to reopen it." };

  if (b.delete) {
    if (existing) await del(`payroll_time_entries?id=eq.${existing.id}`);
    return { ok: true, deleted: true };
  }

  const allowed = source === "employee" ? SELF_DAY_TYPES : SELF_DAY_TYPES.concat(["holiday", "no_show"]);
  const dayType = allowed.includes(b.day_type) ? b.day_type : "worked";
  const dayHrs = Number(emp.standard_day_hours || 8) || 8;
  const timeIn = tstr(b.time_in), timeOut = tstr(b.time_out);
  const lunch = clampNum(b.lunch_minutes, 0, 240) || 0;

  // Hours: use the clock times when both are given, otherwise take the typed
  // number. A non-worked day is 0 worked hours by definition.
  let hours = 0;
  if (dayType === "worked") {
    if (timeIn && timeOut) hours = round2(Math.max(0, (mins(timeOut) - mins(timeIn) - lunch) / 60));
    else hours = clampNum(b.hours, 0, 24) || 0;
  }
  const offType = OFF_TYPES.includes(b.off_type || "") ? (b.off_type || null) : null;
  let offHours = clampNum(b.off_hours, 0, 24) || 0;
  if (dayType !== "worked" && !offHours) offHours = dayHrs;      // a full day off
  if (dayType === "worked" && !offType) offHours = 0;

  const row = {
    employee_id: emp.id, work_date: date, day_type: dayType,
    time_in: timeIn || null, time_out: timeOut || null, lunch_minutes: lunch,
    hours, off_type: dayType === "worked" ? offType : null, off_hours: offHours,
    late_minutes: clampNum(b.late_minutes, 0, 600) || 0,
    left_early_minutes: clampNum(b.left_early_minutes, 0, 600) || 0,
    note: str(b.note, 500) || null, source, updated_at: nowIso(),
  };
  // The recap is only touched when the caller actually sends one — editing a
  // day's times must never wipe what somebody wrote about it.
  if (b.recap !== undefined) {
    const recap = str(b.recap, 2000);
    row.recap = recap || null;
    row.recap_at = recap ? nowIso() : null;
  }
  await upsert("payroll_time_entries", row, "employee_id,work_date");
  return { ok: true, entry: row };
}

// A department's whole week, one block per employee — what the manager signs.
async function departmentWeek(dept, ws) {
  const we = addDays(ws, 6);
  const emps = await get(`payroll_employees?department_id=eq.${dept.id}&active=is.true&select=${EMP_SEL}&order=last_name.asc`);
  const ids = emps.map((e) => e.id);
  const [entries, submits, appr, hols] = await Promise.all([
    ids.length ? get(`payroll_time_entries?employee_id=in.(${ids.join(",")})&work_date=gte.${ws}&work_date=lte.${we}&select=*`) : [],
    ids.length ? get(`payroll_week_submits?employee_id=in.(${ids.join(",")})&week_start=eq.${ws}&select=employee_id,submitted_at`) : [],
    get(`payroll_week_approvals?department_id=eq.${dept.id}&week_start=eq.${ws}&select=*&limit=1`),
    get(`payroll_holidays?active=is.true&holiday_date=gte.${ws}&holiday_date=lte.${we}&select=holiday_date,name,paid,hours`),
  ]);
  const subBy = Object.fromEntries(submits.map((s) => [s.employee_id, s.submitted_at]));
  const members = emps.map((e) => {
    const mine = entries.filter((x) => x.employee_id === e.id).sort((a, b) => a.work_date.localeCompare(b.work_date));
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      days.push({ work_date: d, weekday: weekdayName(d), entry: mine.find((x) => x.work_date === d) || null });
    }
    return {
      employee: {
        id: e.id, name: fullName(e), title: e.title, pay_type: e.pay_type, shift_id: e.shift_id,
        standard_day_hours: Number(e.standard_day_hours || 8), standard_week_hours: Number(e.standard_week_hours || 40),
      },
      days, totals: weekTotals(mine, e),
      submitted_at: subBy[e.id] || null,
      flags: flagsFor(mine, e, ws),
    };
  });
  return {
    department: { id: dept.id, name: dept.name }, week_start: ws, week_end: we,
    holidays: hols, approval: (appr || [])[0] || null, members,
    totals: rollup(members.map((m) => m.totals)),
  };
}

// The things a manager should look at before signing: missing days, late
// arrivals, overtime, nobody-marked-it-done.
function flagsFor(entries, emp, ws) {
  const out = [];
  const byDate = Object.fromEntries(entries.map((e) => [e.work_date, e]));
  let missing = 0;
  for (let i = 0; i < 5; i++) { if (!byDate[addDays(ws, i)]) missing++; }   // Mon–Fri
  if (missing) out.push({ kind: "missing", label: `${missing} weekday${missing > 1 ? "s" : ""} blank` });
  const t = weekTotals(entries, emp);
  if (t.overtime > 0) out.push({ kind: "ot", label: `${t.overtime} hrs OT` });
  if (t.late_minutes > 0) out.push({ kind: "late", label: `${t.late_minutes} min late` });
  if (t.left_early_minutes > 0) out.push({ kind: "early", label: `${t.left_early_minutes} min early out` });
  if (t.unpaid > 0) out.push({ kind: "unpaid", label: `${t.unpaid} unpaid hrs` });
  return out;
}

// Sign off a WHOLE WEEK: snapshot the totals and lock every entry in it so the
// numbers can't drift after payroll sees them.
async function approveDepartmentWeek(actor, dept, ws, signName, note) {
  const we = addDays(ws, 6);
  const snap = await departmentWeek(dept, ws);
  const ids = snap.members.map((m) => m.employee.id);
  if (ids.length) {
    await patch(`payroll_time_entries?employee_id=in.(${ids.join(",")})&work_date=gte.${ws}&work_date=lte.${we}`, { locked: true });
  }
  await upsert("payroll_week_approvals", {
    department_id: dept.id, week_start: ws, status: "approved",
    approved_by: actor.id, approved_by_name: signName, approved_at: nowIso(),
    note: note || null, totals: snap.totals, updated_at: nowIso(),
  }, "department_id,week_start");

  return { department: dept.name, week_start: ws, employees: ids.length, totals: snap.totals };
}

// An approved request becomes real days on the timecard (weekends + holidays
// skipped, locked days left alone).
async function materializeTimeOff(req) {
  const emp = (await get(`payroll_employees?id=eq.${req.employee_id}&select=${EMP_SEL}&limit=1`))[0];
  if (!emp) return 0;
  const dayHrs = Number(emp.standard_day_hours || 8) || 8;
  const dates = await workDaysBetween(req.start_date, req.end_date);
  const dayType = REQ_TO_DAY[req.request_type] || "other";
  const perDay = req.partial ? Number(req.hours_per_day || 0) : dayHrs;
  let placed = 0;
  for (const d of dates) {
    const ex = (await get(`payroll_time_entries?employee_id=eq.${emp.id}&work_date=eq.${d}&select=id,locked&limit=1`))[0];
    if (ex?.locked) continue;
    await upsert("payroll_time_entries", req.partial
      ? { employee_id: emp.id, work_date: d, day_type: "worked", hours: round2(Math.max(0, dayHrs - perDay)), off_type: dayType, off_hours: perDay, note: req.note || null, source: "auto", updated_at: nowIso() }
      : { employee_id: emp.id, work_date: d, day_type: dayType, hours: 0, off_type: null, off_hours: dayHrs, note: req.note || null, source: "auto", updated_at: nowIso() },
      "employee_id,work_date");
    placed++;
  }
  return placed;
}

// The state of the shift-day an employee is currently living in. For a night
// shift after midnight that is YESTERDAY's date — the night they're still working.
async function todayFor(emp) {
  const shift = await shiftOf(emp);
  const now = nowET();
  const wd = workDateFor(shift, now);
  const [rows, hols, appr] = await Promise.all([
    get(`payroll_time_entries?employee_id=eq.${emp.id}&work_date=eq.${wd}&select=*&limit=1`),
    get(`payroll_holidays?active=is.true&holiday_date=eq.${wd}&select=holiday_date,name,paid,hours&limit=1`),
    emp.department_id ? get(`payroll_week_approvals?department_id=eq.${emp.department_id}&week_start=eq.${weekStart(wd)}&select=status&limit=1`) : [],
  ]);
  const entry = rows[0] || null;
  const state = !entry ? "not_started"
    : entry.day_type !== "worked" ? "off"
      : entry.recap_at ? "done"
        : entry.checked_in_at ? "working" : "not_started";
  return {
    work_date: wd, weekday: weekdayName(wd), now, shift, entry,
    holiday: hols[0] || null, state,
    elapsed_minutes: entry?.checked_in_at && !entry.checked_out_at
      ? Math.max(0, Math.round((Date.now() - new Date(entry.checked_in_at).getTime()) / 60000)) : null,
    locked: !!entry?.locked || appr[0]?.status === "approved",
  };
}

// One department's day: who's in, who hasn't checked in, and every recap.
async function departmentDay(dept, wantDate) {
  const emps = await get(`payroll_employees?department_id=eq.${dept.id}&active=is.true&select=${EMP_SEL}&order=last_name.asc`);
  const shifts = await allShifts();
  const now = nowET();
  const members = [];
  for (const e of emps) {
    const shift = shifts.find((s) => s.id === e.shift_id) || null;
    const wd = wantDate || workDateFor(shift, now);
    const entry = (await get(`payroll_time_entries?employee_id=eq.${e.id}&work_date=eq.${wd}&select=*&limit=1`))[0] || null;
    const state = !entry ? "not_started"
      : entry.day_type !== "worked" ? "off"
        : entry.recap_at ? "done"
          : entry.checked_in_at ? "working" : "not_started";
    members.push({
      employee: { id: e.id, name: fullName(e), title: e.title },
      shift: shift ? { id: shift.id, name: shift.name, start_time: shift.start_time, end_time: shift.end_time } : null,
      work_date: wd, state, entry,
      elapsed_minutes: entry?.checked_in_at && !entry.checked_out_at
        ? Math.max(0, Math.round((Date.now() - new Date(entry.checked_in_at).getTime()) / 60000)) : null,
    });
  }
  const dates = [...new Set(members.map((m) => m.work_date))];
  return {
    department: { id: dept.id, name: dept.name },
    work_date: wantDate || dates[0] || null, members,
    counts: {
      working: members.filter((m) => m.state === "working").length,
      done: members.filter((m) => m.state === "done").length,
      off: members.filter((m) => m.state === "off").length,
      missing: members.filter((m) => m.state === "not_started").length,
    },
  };
}

// ── shifts ───────────────────────────────────────────────────────────
async function allShifts() { return get("payroll_shifts?active=is.true&select=*&order=sort_order.asc"); }
async function shiftOf(emp) {
  if (!emp?.shift_id) return null;
  return (await get(`payroll_shifts?id=eq.${emp.shift_id}&select=*&limit=1`))[0] || null;
}
// A shift whose end is at or before its start runs through midnight.
function crossesMidnight(sh) { return !!sh && String(sh.end_time) <= String(sh.start_time); }
// Which work date "right now" belongs to: on a night shift, the small hours
// before the shift ends still belong to the night before.
function workDateFor(shift, now) {
  if (!crossesMidnight(shift)) return now.date;
  return now.time < shift.end_time ? addDays(now.date, -1) : now.date;
}
// Minutes late past the shift start, past the grace period. Wrapped, so a
// night-shift check-in after midnight doesn't read as 20 hours early.
function lateBy(shift, t) {
  if (!shift) return 0;
  const raw = (mins(t) - mins(shift.start_time) + 1440) % 1440;
  if (raw > 720) return 0;                       // they're early, not late
  return Math.max(0, raw - Number(shift.grace_minutes ?? 15));
}
function earlyBy(shift, t) {
  if (!shift) return 0;
  const raw = (mins(shift.end_time) - mins(t) + 1440) % 1440;
  return raw > 720 ? 0 : raw;                    // stayed past the end
}
// Minutes from a shift's start to its end, wrapped for one that crosses midnight.
function shiftLength(sh) {
  if (!sh) return 0;
  return ((mins(sh.end_time) - mins(sh.start_time)) + 1440) % 1440;
}
function hoursBetween(startIso, endIso, lunchMinutes) {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return round2(Math.min(24, Math.max(0, ms / 3600000 - (Number(lunchMinutes) || 0) / 60)));
}
// Local date AND time in one read, so they can't straddle a minute boundary.
function nowET() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

// ── telling people things ────────────────────────────────────────────
// Everything an employee does that a manager needs to know about goes to the
// manager of that employee's DEPARTMENT — email if they have one, text either
// way, since a phone is the one thing everybody here has.
async function notifyManager(emp, { subject, line, detail, cta }) {
  const out = { email: false, sms: false, manager: null };
  if (!emp.department_id) return out;
  const dept = (await get(`payroll_departments?id=eq.${emp.department_id}&select=name,manager_employee_id&limit=1`))[0];
  if (!dept?.manager_employee_id || dept.manager_employee_id === emp.id) return out;
  const mgr = (await get(`payroll_employees?id=eq.${dept.manager_employee_id}&select=first_name,last_name,email,phone,active&limit=1`))[0];
  if (!mgr || !mgr.active) return out;
  out.manager = fullName(mgr);

  const link = `${BASE}/?mode=timecard`;
  // Bare link in the text — carriers block the https:// form on *.netlify.app.
  const body = [line, detail ? `"${detail}"` : "", `${cta}: ${BASE.replace(/^https?:\/\//, "")}/timecard`].filter(Boolean).join(" ");
  if (mgr.phone) out.sms = await sendSms(mgr.phone, fullName(mgr), body);
  if (mgr.email) {
    out.email = await sendEmail(mgr.email, subject,
      `<p>Hi ${mgr.first_name},</p><p>${line}</p>` +
      (detail ? `<blockquote style="margin:12px 0;padding:8px 14px;border-left:3px solid #cbd5e1;color:#475569;">${detail}</blockquote>` : "") +
      `<p><a href="${link}" style="display:inline-block;padding:11px 20px;background:#0f2a4a;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">${cta} →</a></p>` +
      `<p style="color:#64748b;font-size:13px;">${dept.name} · U.S. Shingle &amp; Metal time cards</p>`);
  }
  return out;
}
async function sendSms(to, name, message) {
  try {
    const r = await fetch(`${BASE}/.netlify/functions/ghl-sms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, name, message }) });
    return r.ok;
  } catch { return false; }
}
async function sendEmail(to, subject, html) {
  try {
    const r = await fetch(`${BASE}/.netlify/functions/send-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, subject, html, fromName: MAIL_FROM_NAME }) });
    return r.ok;
  } catch { return false; }
}
const LABEL = {
  pto: "vacation", sick: "sick", doctor: "a doctor visit", unpaid: "unpaid time",
  comp: "a comp day", bereavement: "bereavement", jury: "jury duty", other: "time off",
};
const pretty = (d) => { const [, m, day] = String(d || "").split("-"); return m ? `${+m}/${+day}` : d; };

// ══ small helpers ════════════════════════════════════════════════════

// Sign in with a phone number, or an email for whoever has one.
async function empByLogin(raw) {
  const v = String(raw || "").trim();
  if (!v) return null;
  const key = phoneKey(v);
  if (key) return (await get(`payroll_employees?phone=eq.${key}&select=${EMP_SEL}&limit=1`))[0] || null;
  if (v.includes("@")) return (await get(`payroll_employees?email=eq.${encodeURIComponent(v.toLowerCase())}&select=${EMP_SEL}&limit=1`))[0] || null;
  return null;
}
async function session(token) {
  const t = String(token || "").trim();
  if (!t) return null;
  const s = (await get(`payroll_sessions?token=eq.${encodeURIComponent(t)}&select=employee_id,expires_at&limit=1`))[0];
  if (!s || new Date(s.expires_at) < new Date()) return null;
  const emp = (await get(`payroll_employees?id=eq.${s.employee_id}&select=${EMP_SEL}&limit=1`))[0];
  return emp && emp.active ? emp : null;
}
// Which departments this person signs off: the ones they're the manager of.
// An admin with no department of their own signs off everything.
async function myDepartments(me, only) {
  let rows = await get(`payroll_departments?manager_employee_id=eq.${me.id}&active=is.true&select=id,name,manager_employee_id&order=name.asc`);
  if (me.is_admin) {
    const all = await get(`payroll_departments?active=is.true&select=id,name,manager_employee_id&order=name.asc`);
    rows = all;
  }
  if (only) rows = rows.filter((d) => d.id === only);
  return rows;
}
async function teamIds(depts) {
  if (!depts.length) return [];
  const rows = await get(`payroll_employees?department_id=in.(${depts.map((d) => d.id).join(",")})&active=is.true&select=id`);
  return rows.map((r) => r.id);
}
async function managesEmployee(me, empId) {
  if (me.is_admin) return true;
  const ids = await teamIds(await myDepartments(me));
  return ids.includes(String(empId));
}
async function empMap(ids) {
  const rows = await get(`payroll_employees?id=in.(${ids.join(",")})&select=id,first_name,last_name,title`);
  return Object.fromEntries(rows.map((r) => [r.id, { id: r.id, name: fullName(r), title: r.title }]));
}
async function config() {
  const rows = await get(`app_settings?key=eq.payroll_config&select=value&limit=1`);
  let cfg = {};
  try { cfg = rows[0]?.value ? JSON.parse(rows[0].value) : {}; } catch { cfg = {}; }
  return { standard_day_hours: 8, standard_week_hours: 40, ot_after_hours: 40, signoff_deadline_hour: 11, ...cfg };
}
// Weekdays in a range that aren't holidays — what a time-off request consumes.
async function workDaysBetween(start, end) {
  const hols = await get(`payroll_holidays?active=is.true&holiday_date=gte.${start}&holiday_date=lte.${end}&select=holiday_date`);
  const holSet = new Set(hols.map((h) => h.holiday_date));
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const dow = dowOf(d);
    if (dow === 0 || dow === 6) continue;
    if (holSet.has(d)) continue;
    out.push(d);
    if (out.length > 120) break;
  }
  return out;
}
function rollup(list) {
  const keys = ["worked", "off", "holiday", "pto", "sick", "unpaid", "regular", "overtime", "paid_total", "late_minutes", "left_early_minutes"];
  const out = {};
  for (const k of keys) out[k] = round2(list.reduce((s, t) => s + Number(t[k] || 0), 0));
  return out;
}

// ── dates: plain YYYY-MM-DD strings, anchored at UTC noon so DST can't
//    shift a day. "Today" is Eastern, which is where the company is.
function todayET() { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function asDate(s) { return new Date(`${s}T12:00:00Z`); }
function addDays(s, n) { const d = asDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dowOf(s) { return asDate(s).getUTCDay(); }                       // 0 Sun … 6 Sat
function weekStart(s) { const dow = dowOf(s); return addDays(s, dow === 0 ? -6 : 1 - dow); }   // Monday
function lastWeekStart() { return addDays(weekStart(todayET()), -7); }
function weekdayName(s) { return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dowOf(s)]; }
function mins(hhmm) { const [h, m] = String(hhmm).split(":").map(Number); return (h || 0) * 60 + (m || 0); }

function fullName(e) { return [e.first_name, e.last_name].filter(Boolean).join(" ").trim(); }
function hash(salt, pass) { return crypto.createHash("sha256").update(`${salt}:${pass}`).digest("hex"); }
function nowIso() { return new Date().toISOString(); }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function str(v, max) { return String(v == null ? "" : v).trim().slice(0, max || 200); }
function dstr(v) { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; }
function tstr(v) { const s = str(v, 5); return /^\d{2}:\d{2}$/.test(s) ? s : ""; }
function clampNum(v, lo, hi) { const n = Number(v); if (!Number.isFinite(n)) return 0; return Math.min(hi, Math.max(lo, n)); }

// ── Supabase REST
async function get(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function post(table, row, wantRow) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST", headers: { ...H, Prefer: wantRow ? "return=representation" : "return=minimal" }, body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`${table} insert ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return wantRow ? r.json().catch(() => []) : [];
}
async function upsert(table, row, onConflict) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`${table} upsert ${r.status}: ${(await r.text()).slice(0, 160)}`);
}
async function patch(path, row) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`patch ${r.status}: ${(await r.text()).slice(0, 160)}`);
}
async function del(path) { await fetch(`${SB_URL}/rest/v1/${path}`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } }); }

function j(o) { return JSON.stringify(o); }
function cors(status, body) {
  return { statusCode: status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }, body };
}
