// netlify/functions/payroll-me.js
//
// The EMPLOYEE side of payroll/timekeeping (?mode=timecard), plus the
// department manager's Monday-morning sign-off. One login serves both:
// a manager is just an employee with is_manager, and sees an extra Team tab.
//
// Login: email + a 4–8 digit passcode. The FIRST time a person logs in,
// whatever they type becomes their passcode (same idea as My Tools), and
// it's stored salted+hashed — never in the clear, because this app's
// Supabase key is public. A login returns an opaque session token
// (payroll_sessions, 30 days) that every other call carries.
//
//   POST { action, token, ... }
//
//   ── anyone ──────────────────────────────────────────────────────────
//   "who"           { email }                    → { found, passcode_set, name }
//   "login"         { email, passcode }          → { token, me }
//   "logout"        { token }
//   "set_passcode"  { token, passcode }
//   "me"            { token }                    → me + balances + holidays + config
//   "week"          { token, week_start? }       → my 7 days + totals + lock state
//   "save_day"      { token, work_date, ... }    → upsert one day of my timecard
//   "submit_week"   { token, week_start }        → "my week is done"
//   "request_off"   { token, request_type, start_date, end_date, ... }
//   "cancel_off"    { token, id }
//   "my_time_off"   { token }
//
//   ── department manager (is_manager) / office (is_admin) ─────────────
//   "team_week"     { token, week_start?, department_id? }  → every member's week
//   "team_save_day" { token, employee_id, work_date, ... }  → fix a member's day
//   "approve_week"  { token, week_start, sign_name, note? } → SIGN OFF + lock
//   "reopen_week"   { token, week_start, department_id? }   → admin only
//   "off_queue"     { token }                               → pending requests
//   "decide_off"    { token, id, decision, note? }          → approve / deny
//
// Approving a week does three things: it locks every entry in it so the
// numbers can't move after payroll sees them, it snapshots the totals onto
// the approval row, and it credits the comp-day bank for anyone who is
// comp-eligible and worked past the standard week.
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

import crypto from "node:crypto";

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const TZ = "America/New_York";
const SESSION_DAYS = 30;

const EMP_SEL =
  "id,first_name,last_name,email,phone,department_id,title,pay_type,hourly_rate,annual_salary," +
  "standard_day_hours,standard_week_hours,hire_date,pto_days_per_year,pto_carryover_days," +
  "sick_days_per_year,comp_time_eligible,paid_holidays,is_manager,is_admin,active,passcode_hash";

// Day types an employee can put on their own timecard. "holiday" is filled in
// automatically from the holiday calendar; "no_show" is manager/office only.
const SELF_DAY_TYPES = ["worked", "pto", "sick", "doctor", "unpaid", "comp_used", "bereavement", "jury", "other"];
const OFF_TYPES = ["", "pto", "sick", "doctor", "unpaid", "comp_used", "other"];
const OFF_REQUEST_TYPES = ["pto", "sick", "doctor", "unpaid", "comp", "bereavement", "jury", "other"];
// A time-off request type → the day_type it writes onto the timecard.
const REQ_TO_DAY = { pto: "pto", sick: "sick", doctor: "doctor", unpaid: "unpaid", comp: "comp_used", bereavement: "bereavement", jury: "jury", other: "other" };
// Which day types burn which balance.
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
      const emp = await empByEmail(body.email);
      if (!emp) return cors(200, j({ ok: true, found: false }));
      return cors(200, j({ ok: true, found: true, passcode_set: !!emp.passcode_hash, name: emp.first_name }));
    }

    if (action === "login") {
      const emp = await empByEmail(body.email);
      const pass = String(body.passcode || "").trim();
      if (!emp) return cors(404, j({ ok: false, error: "We don't have that email on the payroll roster. Check with the office." }));
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
    const me = await session(body.token);
    if (!me) return cors(401, j({ ok: false, error: "Your session expired — sign in again." }));

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

    if (action === "me") return cors(200, j({ ok: true, me: await meBundle(me) }));

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
      return cors(200, j({ ok: true, request: row }));
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
      const ws = weekStart(body.week_start || lastWeekStart());
      const signName = str(body.sign_name, 120);
      if (!signName) return cors(400, j({ ok: false, error: "Type your name to sign off." }));
      const depts = await myDepartments(me, body.department_id);
      if (!depts.length) return cors(400, j({ ok: false, error: "You don't manage a department yet — the office sets that." }));
      const done = [];
      for (const d of depts) done.push(await approveDepartmentWeek(me, d, ws, signName, str(body.note, 500)));
      return cors(200, j({ ok: true, approved: done }));
    }

    if (action === "reopen_week") {
      if (!me.is_admin) return cors(403, j({ ok: false, error: "Only the office can reopen a signed-off week." }));
      const ws = weekStart(body.week_start || lastWeekStart());
      const depts = await myDepartments(me, body.department_id);
      for (const d of depts) {
        const ids = (await get(`payroll_employees?department_id=eq.${d.id}&select=id`)).map((e) => e.id);
        if (ids.length) await patch(`payroll_time_entries?employee_id=in.(${ids.join(",")})&work_date=gte.${ws}&work_date=lte.${addDays(ws, 6)}`, { locked: false });
        await patch(`payroll_week_approvals?department_id=eq.${d.id}&week_start=eq.${ws}`, { status: "open", approved_at: null, approved_by: null, approved_by_name: null, updated_at: nowIso() });
      }
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
  const [dept, bal, hol, cfg] = await Promise.all([
    emp.department_id ? get(`payroll_departments?id=eq.${emp.department_id}&select=id,name,manager_employee_id&limit=1`).then((r) => r[0] || null) : null,
    balances(emp),
    get(`payroll_holidays?active=is.true&holiday_date=gte.${addDays(todayET(), -30)}&select=holiday_date,name,paid,hours&order=holiday_date.asc&limit=40`),
    config(),
  ]);
  const managed = (emp.is_manager || emp.is_admin) ? await myDepartments(emp) : [];
  return {
    id: emp.id, first_name: emp.first_name, last_name: emp.last_name, email: emp.email, phone: emp.phone,
    title: emp.title, pay_type: emp.pay_type, standard_day_hours: Number(emp.standard_day_hours || 8),
    standard_week_hours: Number(emp.standard_week_hours || 40), comp_time_eligible: !!emp.comp_time_eligible,
    is_manager: !!emp.is_manager, is_admin: !!emp.is_admin, passcode_set: !!emp.passcode_hash,
    department: dept, balances: bal, holidays: hol, config: cfg,
    manages: managed.map((d) => ({ id: d.id, name: d.name })),
    day_types: SELF_DAY_TYPES, off_types: OFF_TYPES, request_types: OFF_REQUEST_TYPES,
  };
}

// PTO / sick / comp balances. PTO + sick are counted off the TIMECARD (the
// single source of truth — approved requests write days onto it), so a day
// the office keyed in by hand counts the same as one from a request.
async function balances(emp) {
  const y = todayET().slice(0, 4);
  const dayHrs = Number(emp.standard_day_hours || 8) || 8;
  const [entries, ledger, pendingRows] = await Promise.all([
    get(`payroll_time_entries?employee_id=eq.${emp.id}&work_date=gte.${y}-01-01&work_date=lte.${y}-12-31&select=day_type,off_type,off_hours,hours`),
    get(`payroll_comp_ledger?employee_id=eq.${emp.id}&select=days`),
    get(`payroll_time_off?employee_id=eq.${emp.id}&status=eq.pending&select=request_type,total_days`),
  ]);
  let ptoUsed = 0, sickUsed = 0, compUsed = 0;
  for (const e of entries) {
    // A day off counts as the fraction of a standard day it actually took —
    // a half-day at the doctor burns half a day, not a whole one.
    const off = Number(e.off_hours || 0) / dayHrs;
    const full = off || 1;
    if (PTO_TYPES.includes(e.day_type)) ptoUsed += full;
    else if (PTO_TYPES.includes(e.off_type || "")) ptoUsed += off;
    if (SICK_TYPES.includes(e.day_type)) sickUsed += full;
    else if (SICK_TYPES.includes(e.off_type || "")) sickUsed += off;
    if (e.day_type === "comp_used") compUsed += full;
    else if (e.off_type === "comp_used") compUsed += off;
  }
  const compBank = ledger.reduce((s, r) => s + Number(r.days || 0), 0);
  const pendingPto = pendingRows.filter((r) => r.request_type === "pto").reduce((s, r) => s + Number(r.total_days || 0), 0);
  const allot = Number(emp.pto_days_per_year || 0) + Number(emp.pto_carryover_days || 0);
  return {
    year: y,
    pto: { allotted: allot, used: round2(ptoUsed), pending: round2(pendingPto), remaining: round2(allot - ptoUsed - pendingPto) },
    sick: { allotted: Number(emp.sick_days_per_year || 0), used: round2(sickUsed), remaining: round2(Number(emp.sick_days_per_year || 0) - sickUsed) },
    comp: { eligible: !!emp.comp_time_eligible, banked: round2(compBank), used_this_year: round2(compUsed), available: round2(compBank) },
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
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const hol = holByDate[d] || null;
    days.push({
      work_date: d, weekday: weekdayName(d), holiday: hol,
      entry: byDate[d] || null,
    });
  }
  return {
    week_start: ws, week_end: we, days,
    totals: weekTotals(days.map((d) => d.entry).filter(Boolean), emp),
    submitted_at: submit[0]?.submitted_at || null,
    approval: appr[0] || null,
    locked: rows.some((r) => r.locked) || appr[0]?.status === "approved",
  };
}

// Worked / off / OT for a set of entries.
function weekTotals(entries, emp) {
  const dayHrs = Number(emp?.standard_day_hours || 8) || 8;
  const weekHrs = Number(emp?.standard_week_hours || 40) || 40;
  let worked = 0, off = 0, holiday = 0, pto = 0, sick = 0, unpaid = 0, comp = 0, late = 0, early = 0;
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
      else if (t === "comp_used") comp += h;
    };
    if (e.day_type !== "worked") bucket(e.day_type, Number(e.hours || 0) > 0 ? oh : (oh || dayHrs));
    else if (e.off_type) bucket(e.off_type, oh);
  }
  const paidOther = holiday + pto + sick + comp;
  return {
    worked: round2(worked), off: round2(off), holiday: round2(holiday), pto: round2(pto),
    sick: round2(sick), unpaid: round2(unpaid), comp_used: round2(comp),
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
        id: e.id, name: fullName(e), title: e.title, pay_type: e.pay_type,
        hourly_rate: e.hourly_rate == null ? null : Number(e.hourly_rate),
        standard_day_hours: Number(e.standard_day_hours || 8), standard_week_hours: Number(e.standard_week_hours || 40),
        comp_time_eligible: !!e.comp_time_eligible,
      },
      days, totals: weekTotals(mine, e),
      submitted_at: subBy[e.id] || null,
      flags: flagsFor(mine, e, ws),
    };
  });
  return {
    department: { id: dept.id, name: dept.name }, week_start: ws, week_end: we,
    holidays: hols, approval: appr[0] || null, members,
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

// Sign off: snapshot the totals, lock every entry in the week so the numbers
// can't drift after payroll sees them, and credit the comp bank.
async function approveDepartmentWeek(actor, dept, ws, signName, note) {
  const we = addDays(ws, 6);
  const snap = await departmentWeek(dept, ws);
  const ids = snap.members.map((m) => m.employee.id);
  if (ids.length) await patch(`payroll_time_entries?employee_id=in.(${ids.join(",")})&work_date=gte.${ws}&work_date=lte.${we}`, { locked: true });

  const credited = [];
  for (const m of snap.members) {
    if (!m.employee.comp_time_eligible) continue;
    const extra = Number(m.totals.overtime || 0);
    const days = round2(extra / (m.employee.standard_day_hours || 8));
    if (days < 0.25) continue;
    const ok = await post("payroll_comp_ledger", {
      employee_id: m.employee.id, entry_date: we, days,
      reason: `Extra hours worked week of ${ws} (${extra} hrs)`,
      source: "week_approval", ref: ws, created_by: signName,
    }).catch(() => null);
    if (ok !== null) credited.push({ employee: m.employee.name, days });
  }

  await upsert("payroll_week_approvals", {
    department_id: dept.id, week_start: ws, status: "approved",
    approved_by: actor.id, approved_by_name: signName, approved_at: nowIso(),
    note: note || null, totals: snap.totals, updated_at: nowIso(),
  }, "department_id,week_start");

  return { department: dept.name, week_start: ws, employees: ids.length, totals: snap.totals, comp_credited: credited };
}

// An approved request becomes real days on the timecard (weekends + holidays
// skipped, locked days left alone). A comp day also draws down the bank.
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
  if (req.request_type === "comp" && placed) {
    await post("payroll_comp_ledger", {
      employee_id: emp.id, entry_date: req.start_date, days: -round2((perDay * placed) / dayHrs),
      reason: `Comp day${placed > 1 ? "s" : ""} taken ${req.start_date}${placed > 1 ? "–" + req.end_date : ""}`,
      source: "time_off", ref: String(req.id), created_by: req.decided_by_name || "manager",
    }).catch(() => null);
  }
  return placed;
}

// ══ small helpers ════════════════════════════════════════════════════

async function empByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  return (await get(`payroll_employees?email=eq.${encodeURIComponent(e)}&select=${EMP_SEL}&limit=1`))[0] || null;
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
  return { standard_day_hours: 8, standard_week_hours: 40, ot_after_hours: 40, signoff_deadline_hour: 11, comp_earn_threshold_hours: 40, ...cfg };
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
  const keys = ["worked", "off", "holiday", "pto", "sick", "unpaid", "comp_used", "regular", "overtime", "paid_total", "late_minutes", "left_early_minutes"];
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
