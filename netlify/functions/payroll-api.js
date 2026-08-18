// netlify/functions/payroll-api.js
//
// The OFFICE side of payroll/timekeeping (?mode=payroll). This is the HR/admin
// screen: the roster, departments and who signs each one off, pay setup, the
// PTO allotments, the holiday calendar, the company-wide view of which
// departments have signed off last week, and the payroll export.
//
// Auth is the app's usual office token (visit_token / dialer_token from
// app_settings), fetched behind the manager PIN — same as the crew admin page.
// The employee-facing half lives in payroll-me.js.
//
//   POST { token, action, ... }
//
//   departments      →  { departments } (with manager name + headcount)
//   department_save  { id?, name, manager_employee_id?, active? }
//   department_delete{ id }
//   employees        { include_inactive? }  →  { employees }
//   employee_save    { id?, first_name, last_name, email, ...pay + PTO fields }
//   employee_delete  { id }                 →  deactivates (keeps history)
//   reset_passcode   { id }                 →  clears it; next login sets a new one
//   holidays         →  { holidays }
//   holiday_save     { id?, holiday_date, name, paid?, hours?, active? }
//   holiday_delete   { id }
//   config           →  { config }
//   config_save      { config }
//   overview         { week_start? }        →  every department's sign-off state
//   employee_week    { employee_id, week_start? }
//   save_day         { employee_id, work_date, ... }   →  office override (edits locked days)
//   export           { start, end }         →  { rows, csv } payroll-ready totals
//   balances         →  { rows } PTO / sick per person
//   time_off         { status? }            →  every request, newest first
//
// Env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const TZ = "America/New_York";

const EMP_COLS = [
  "first_name", "last_name", "email", "phone", "department_id", "title", "pay_type", "hourly_rate",
  "annual_salary", "standard_day_hours", "standard_week_hours", "hire_date", "pto_days_per_year",
  "pto_carryover_days", "sick_days_per_year", "paid_holidays", "is_manager",
  "is_admin", "active", "notes",
];
const NUMERIC = new Set(["hourly_rate", "annual_salary", "standard_day_hours", "standard_week_hours", "pto_days_per_year", "pto_carryover_days", "sick_days_per_year"]);
const BOOL = new Set(["paid_holidays", "is_manager", "is_admin", "active"]);
const PTO_TYPES = ["pto"], SICK_TYPES = ["sick", "doctor"];

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, j({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, j({ ok: false, error: "Supabase env missing" }));

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return cors(400, j({ ok: false, error: "bad JSON" })); }
  if (!(await okToken(b.token))) return cors(401, j({ ok: false, error: "Invalid link — unlock with the manager PIN again." }));

  const action = String(b.action || "").trim();
  try {
    // ── Departments ────────────────────────────────────────────────
    if (action === "departments") {
      const [depts, emps] = await Promise.all([
        get("payroll_departments?select=*&order=name.asc"),
        get("payroll_employees?active=is.true&select=id,first_name,last_name,department_id"),
      ]);
      const name = Object.fromEntries(emps.map((e) => [e.id, `${e.first_name} ${e.last_name}`.trim()]));
      return cors(200, j({
        ok: true,
        departments: depts.map((d) => ({
          ...d,
          manager_name: d.manager_employee_id ? name[d.manager_employee_id] || null : null,
          headcount: emps.filter((e) => e.department_id === d.id).length,
        })),
      }));
    }

    if (action === "department_save") {
      const name = str(b.name, 80);
      if (!name) return cors(400, j({ ok: false, error: "A department name is required." }));
      const row = { name, manager_employee_id: str(b.manager_employee_id, 64) || null, active: b.active !== false };
      if (b.id) await patch(`payroll_departments?id=eq.${str(b.id, 64)}`, row);
      else await post("payroll_departments", row);
      return cors(200, j({ ok: true }));
    }

    if (action === "department_delete") {
      const id = str(b.id, 64);
      const left = await get(`payroll_employees?department_id=eq.${id}&active=is.true&select=id&limit=1`);
      if (left.length) return cors(400, j({ ok: false, error: "Move that department's employees somewhere else first." }));
      await del(`payroll_departments?id=eq.${id}`);
      return cors(200, j({ ok: true }));
    }

    // ── Employees ──────────────────────────────────────────────────
    if (action === "employees") {
      const filter = b.include_inactive ? "" : "active=is.true&";
      const [emps, depts] = await Promise.all([
        get(`payroll_employees?${filter}select=id,first_name,last_name,email,phone,department_id,title,pay_type,hourly_rate,annual_salary,standard_day_hours,standard_week_hours,hire_date,pto_days_per_year,pto_carryover_days,sick_days_per_year,paid_holidays,is_manager,is_admin,active,notes,passcode_set_at&order=last_name.asc`),
        get("payroll_departments?select=id,name"),
      ]);
      const dn = Object.fromEntries(depts.map((d) => [d.id, d.name]));
      return cors(200, j({ ok: true, employees: emps.map((e) => ({ ...e, department_name: dn[e.department_id] || null })), departments: depts }));
    }

    if (action === "employee_save") {
      const row = {};
      for (const k of EMP_COLS) {
        if (!(k in b)) continue;
        let v = b[k];
        if (BOOL.has(k)) v = !!v;
        else if (NUMERIC.has(k)) v = v === "" || v == null ? null : Number(v);
        else if (k === "hire_date") v = dstr(v) || null;
        else if (k === "email") v = str(v, 160).toLowerCase() || null;
        else if (k === "department_id") v = str(v, 64) || null;
        else v = str(v, k === "notes" ? 2000 : 120) || null;
        row[k] = v;
      }
      if (!b.id) {
        if (!row.first_name || !row.last_name) return cors(400, j({ ok: false, error: "First and last name are required." }));
        if (!row.email) return cors(400, j({ ok: false, error: "An email is required — it's how they log in." }));
      }
      row.updated_at = nowIso();
      if (b.id) await patch(`payroll_employees?id=eq.${str(b.id, 64)}`, row);
      else {
        const dupe = await get(`payroll_employees?email=eq.${encodeURIComponent(row.email)}&select=id&limit=1`);
        if (dupe.length) return cors(400, j({ ok: false, error: "Someone on the roster already uses that email." }));
        await post("payroll_employees", row);
      }
      return cors(200, j({ ok: true }));
    }

    // Deactivate, never delete — the timecard history has to stay put.
    if (action === "employee_delete") {
      await patch(`payroll_employees?id=eq.${str(b.id, 64)}`, { active: false, updated_at: nowIso() });
      await del(`payroll_sessions?employee_id=eq.${str(b.id, 64)}`);
      return cors(200, j({ ok: true }));
    }

    if (action === "reset_passcode") {
      const id = str(b.id, 64);
      await patch(`payroll_employees?id=eq.${id}`, { passcode_hash: null, passcode_salt: null, passcode_set_at: null, updated_at: nowIso() });
      await del(`payroll_sessions?employee_id=eq.${id}`);
      return cors(200, j({ ok: true }));
    }

    // ── Holidays ───────────────────────────────────────────────────
    if (action === "holidays") {
      return cors(200, j({ ok: true, holidays: await get("payroll_holidays?select=*&order=holiday_date.asc") }));
    }
    if (action === "holiday_save") {
      const d = dstr(b.holiday_date);
      if (!d) return cors(400, j({ ok: false, error: "Pick a date." }));
      const row = { holiday_date: d, name: str(b.name, 80) || "Holiday", paid: b.paid !== false, hours: Number(b.hours || 8) || 8, active: b.active !== false };
      await upsert("payroll_holidays", row, "holiday_date");
      return cors(200, j({ ok: true }));
    }
    if (action === "holiday_delete") { await del(`payroll_holidays?id=eq.${str(b.id, 64)}`); return cors(200, j({ ok: true })); }

    // ── Config ─────────────────────────────────────────────────────
    if (action === "config") return cors(200, j({ ok: true, config: await config() }));
    if (action === "config_save") {
      const cfg = { ...(await config()), ...(b.config && typeof b.config === "object" ? b.config : {}) };
      await upsert("app_settings", { key: "payroll_config", value: JSON.stringify(cfg) }, "key");
      return cors(200, j({ ok: true, config: cfg }));
    }

    // ── Company-wide week: who has signed off, who hasn't ──────────
    if (action === "overview") {
      const ws = weekStart(b.week_start || lastWeekStart());
      const we = addDays(ws, 6);
      const [depts, emps, entries, approvals, submits] = await Promise.all([
        get("payroll_departments?active=is.true&select=id,name,manager_employee_id&order=name.asc"),
        get("payroll_employees?active=is.true&select=id,first_name,last_name,department_id,pay_type,hourly_rate,standard_day_hours,standard_week_hours"),
        get(`payroll_time_entries?work_date=gte.${ws}&work_date=lte.${we}&select=*`),
        get(`payroll_week_approvals?week_start=eq.${ws}&select=*`),
        get(`payroll_week_submits?week_start=eq.${ws}&select=employee_id`),
      ]);
      const name = Object.fromEntries(emps.map((e) => [e.id, `${e.first_name} ${e.last_name}`.trim()]));
      const submitted = new Set(submits.map((s) => s.employee_id));
      const rows = depts.map((d) => {
        const team = emps.filter((e) => e.department_id === d.id);
        const mine = entries.filter((x) => team.some((t) => t.id === x.employee_id));
        const appr = approvals.find((a) => a.department_id === d.id) || null;
        return {
          id: d.id, name: d.name,
          manager_name: d.manager_employee_id ? name[d.manager_employee_id] || null : null,
          manager_missing: !d.manager_employee_id,
          headcount: team.length,
          submitted: team.filter((t) => submitted.has(t.id)).length,
          totals: totalsFor(mine, team),
          status: appr?.status === "approved" ? "approved" : "open",
          approved_by_name: appr?.approved_by_name || null,
          approved_at: appr?.approved_at || null,
        };
      });
      const unassigned = emps.filter((e) => !e.department_id).map((e) => ({ id: e.id, name: name[e.id] }));
      return cors(200, j({
        ok: true, week_start: ws, week_end: we, departments: rows, unassigned,
        company: totalsFor(entries, emps),
        approved_count: rows.filter((r) => r.status === "approved").length,
      }));
    }

    // ── One employee's week + office override of any day ───────────
    if (action === "employee_week") {
      const id = str(b.employee_id, 64);
      const ws = weekStart(b.week_start || lastWeekStart());
      const emp = (await get(`payroll_employees?id=eq.${id}&select=*&limit=1`))[0];
      if (!emp) return cors(404, j({ ok: false, error: "Employee not found." }));
      const rows = await get(`payroll_time_entries?employee_id=eq.${id}&work_date=gte.${ws}&work_date=lte.${addDays(ws, 6)}&select=*&order=work_date.asc`);
      const days = [];
      for (let i = 0; i < 7; i++) {
        const d = addDays(ws, i);
        days.push({ work_date: d, weekday: weekdayName(d), entry: rows.find((r) => r.work_date === d) || null });
      }
      return cors(200, j({ ok: true, week_start: ws, week_end: addDays(ws, 6), days, totals: totalsFor(rows, [emp]), employee: { id: emp.id, name: `${emp.first_name} ${emp.last_name}`.trim() } }));
    }

    // Office can edit ANY day, including a locked (signed-off) one — that's
    // the whole point of the office override. It stamps source="office".
    if (action === "save_day") {
      const id = str(b.employee_id, 64);
      const date = dstr(b.work_date);
      if (!id || !date) return cors(400, j({ ok: false, error: "employee_id and work_date required" }));
      if (b.delete) { await del(`payroll_time_entries?employee_id=eq.${id}&work_date=eq.${date}`); return cors(200, j({ ok: true, deleted: true })); }
      const emp = (await get(`payroll_employees?id=eq.${id}&select=standard_day_hours&limit=1`))[0] || {};
      const dayHrs = Number(emp.standard_day_hours || 8) || 8;
      const dayType = str(b.day_type, 20) || "worked";
      const tin = tstr(b.time_in), tout = tstr(b.time_out), lunch = num(b.lunch_minutes, 0, 240);
      let hours = 0;
      if (dayType === "worked") hours = (tin && tout) ? round2(Math.max(0, (mins(tout) - mins(tin) - lunch) / 60)) : num(b.hours, 0, 24);
      let offHours = num(b.off_hours, 0, 24);
      if (dayType !== "worked" && !offHours) offHours = dayHrs;
      await upsert("payroll_time_entries", {
        employee_id: id, work_date: date, day_type: dayType, time_in: tin || null, time_out: tout || null,
        lunch_minutes: lunch, hours, off_type: dayType === "worked" ? (str(b.off_type, 20) || null) : null, off_hours: offHours,
        late_minutes: num(b.late_minutes, 0, 600), left_early_minutes: num(b.left_early_minutes, 0, 600),
        note: str(b.note, 500) || null, source: "office", updated_at: nowIso(),
      }, "employee_id,work_date");
      return cors(200, j({ ok: true }));
    }

    // ── Payroll export: one row per employee for the period ─────────
    if (action === "export") {
      const start = dstr(b.start) || weekStart(lastWeekStart());
      const end = dstr(b.end) || addDays(start, 6);
      const [emps, entries, depts] = await Promise.all([
        get("payroll_employees?active=is.true&select=*&order=last_name.asc"),
        get(`payroll_time_entries?work_date=gte.${start}&work_date=lte.${end}&select=*`),
        get("payroll_departments?select=id,name"),
      ]);
      const dn = Object.fromEntries(depts.map((d) => [d.id, d.name]));
      const weeks = Math.max(1, Math.round((asDate(end) - asDate(start)) / 604800000) || 1);
      const rows = emps.map((e) => {
        const mine = entries.filter((x) => x.employee_id === e.id);
        const t = totalsFor(mine, [e], weeks);
        const rate = Number(e.hourly_rate || 0);
        const gross = e.pay_type === "hourly"
          ? round2(rate * (t.regular + t.holiday + t.pto + t.sick) + rate * 1.5 * t.overtime)
          : round2(Number(e.annual_salary || 0) / 52 * weeks);
        return {
          employee: `${e.last_name}, ${e.first_name}`, department: dn[e.department_id] || "—",
          pay_type: e.pay_type, rate: e.pay_type === "hourly" ? rate : Number(e.annual_salary || 0),
          regular: t.regular, overtime: t.overtime, holiday: t.holiday, pto: t.pto, sick: t.sick,
          unpaid: t.unpaid, paid_total: t.paid_total,
          late_minutes: t.late_minutes, left_early_minutes: t.left_early_minutes,
          gross_estimate: gross,
        };
      });
      const cols = ["employee", "department", "pay_type", "rate", "regular", "overtime", "holiday", "pto", "sick", "unpaid", "paid_total", "late_minutes", "left_early_minutes", "gross_estimate"];
      const csv = [cols.join(",")].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))).join("\n");
      return cors(200, j({ ok: true, start, end, rows, csv, note: "gross_estimate is an unburdened check-figure — taxes, deductions and benefits are not applied." }));
    }

    // ── Balances (PTO / sick) for everyone ──────────────────────────
    if (action === "balances") {
      const y = todayET().slice(0, 4);
      const [emps, entries, pending] = await Promise.all([
        get("payroll_employees?active=is.true&select=id,first_name,last_name,department_id,standard_day_hours,pto_days_per_year,pto_carryover_days,sick_days_per_year&order=last_name.asc"),
        get(`payroll_time_entries?work_date=gte.${y}-01-01&work_date=lte.${y}-12-31&select=employee_id,day_type,off_type,off_hours`),
        get("payroll_time_off?status=eq.pending&select=employee_id,request_type,total_days"),
      ]);
      const rows = emps.map((e) => {
        const dayHrs = Number(e.standard_day_hours || 8) || 8;
        let pto = 0, sick = 0;
        for (const x of entries.filter((r) => r.employee_id === e.id)) {
          const off = Number(x.off_hours || 0) / dayHrs;
          const full = off || 1;   // a half-day off burns half a day
          if (PTO_TYPES.includes(x.day_type)) pto += full; else if (PTO_TYPES.includes(x.off_type || "")) pto += off;
          if (SICK_TYPES.includes(x.day_type)) sick += full; else if (SICK_TYPES.includes(x.off_type || "")) sick += off;
        }
        const allot = Number(e.pto_days_per_year || 0) + Number(e.pto_carryover_days || 0);
        const pend = pending.filter((p) => p.employee_id === e.id && p.request_type === "pto").reduce((s, p) => s + Number(p.total_days || 0), 0);
        return {
          id: e.id, name: `${e.first_name} ${e.last_name}`.trim(), department_id: e.department_id,
          pto_allotted: allot, pto_used: round2(pto), pto_pending: round2(pend), pto_remaining: round2(allot - pto - pend),
          sick_allotted: Number(e.sick_days_per_year || 0), sick_used: round2(sick),
        };
      });
      return cors(200, j({ ok: true, year: y, rows }));
    }

    if (action === "time_off") {
      const st = str(b.status, 20);
      const q = st ? `status=eq.${st}&` : "";
      const rows = await get(`payroll_time_off?${q}select=*&order=start_date.desc&limit=300`);
      const ids = [...new Set(rows.map((r) => r.employee_id))];
      const emps = ids.length ? await get(`payroll_employees?id=in.(${ids.join(",")})&select=id,first_name,last_name`) : [];
      const nm = Object.fromEntries(emps.map((e) => [e.id, `${e.first_name} ${e.last_name}`.trim()]));
      return cors(200, j({ ok: true, requests: rows.map((r) => ({ ...r, employee_name: nm[r.employee_id] || "—" })) }));
    }

    return cors(400, j({ ok: false, error: `unknown action "${action}"` }));
  } catch (e) {
    return cors(500, j({ ok: false, error: e.message || "error" }));
  }
};

// ══ helpers ══════════════════════════════════════════════════════════

// Totals across a set of entries. `weeks` scales the OT threshold when the
// period is longer than one week (the export can span a month).
function totalsFor(entries, emps, weeks = 1) {
  const byEmp = {};
  for (const e of emps) byEmp[e.id] = e;
  let worked = 0, holiday = 0, pto = 0, sick = 0, unpaid = 0, off = 0, late = 0, early = 0;
  const perEmp = {};
  for (const x of entries) {
    const emp = byEmp[x.employee_id];
    if (emps.length && !emp) continue;
    const dayHrs = Number(emp?.standard_day_hours || 8) || 8;
    const h = Number(x.hours || 0), oh = Number(x.off_hours || 0);
    worked += h; off += oh;
    late += Number(x.late_minutes || 0); early += Number(x.left_early_minutes || 0);
    perEmp[x.employee_id] = (perEmp[x.employee_id] || 0) + h;
    const t = x.day_type !== "worked" ? x.day_type : (x.off_type || "");
    const hrs = x.day_type !== "worked" ? (oh || dayHrs) : oh;
    if (t === "holiday") holiday += hrs;
    else if (PTO_TYPES.includes(t)) pto += hrs;
    else if (SICK_TYPES.includes(t)) sick += hrs;
    else if (t === "unpaid") unpaid += hrs;
  }
  // Overtime is per person per week, not on the pooled total.
  let regular = 0, overtime = 0;
  for (const [id, h] of Object.entries(perEmp)) {
    const cap = (Number(byEmp[id]?.standard_week_hours || 40) || 40) * weeks;
    regular += Math.min(h, cap);
    overtime += Math.max(0, h - cap);
  }
  return {
    worked: round2(worked), off: round2(off), holiday: round2(holiday), pto: round2(pto), sick: round2(sick),
    unpaid: round2(unpaid), regular: round2(regular), overtime: round2(overtime),
    late_minutes: late, left_early_minutes: early,
    paid_total: round2(worked + holiday + pto + sick),
  };
}

async function okToken(token) {
  const t = String(token || "").trim();
  if (!t) return false;
  const [d, v] = await Promise.all([setting("dialer_token"), setting("visit_token")]);
  return (!!d && t === d) || (!!v && t === v);
}
async function setting(key) {
  const rows = await get(`app_settings?key=eq.${encodeURIComponent(key)}&select=value&limit=1`);
  return rows[0]?.value || null;
}
async function config() {
  let cfg = {};
  try { cfg = JSON.parse((await setting("payroll_config")) || "{}"); } catch { cfg = {}; }
  return { standard_day_hours: 8, standard_week_hours: 40, ot_after_hours: 40, signoff_deadline_hour: 11, ...cfg };
}

function todayET() { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function asDate(s) { return new Date(`${s}T12:00:00Z`); }
function addDays(s, n) { const d = asDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dowOf(s) { return asDate(s).getUTCDay(); }
function weekStart(s) { const dow = dowOf(s); return addDays(s, dow === 0 ? -6 : 1 - dow); }
function lastWeekStart() { return addDays(weekStart(todayET()), -7); }
function weekdayName(s) { return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dowOf(s)]; }
function mins(hhmm) { const [h, m] = String(hhmm).split(":").map(Number); return (h || 0) * 60 + (m || 0); }

function nowIso() { return new Date().toISOString(); }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function num(v, lo, hi) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; }
function str(v, max) { return String(v == null ? "" : v).trim().slice(0, max || 200); }
function dstr(v) { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; }
function tstr(v) { const s = str(v, 5); return /^\d{2}:\d{2}$/.test(s) ? s : ""; }
function csvCell(v) { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

async function get(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) return [];
  return r.json().catch(() => []);
}
async function post(table, row) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, { method: "POST", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`${table} insert ${r.status}: ${(await r.text()).slice(0, 160)}`);
}
async function upsert(table, row, onConflict) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`, { method: "POST", headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
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
