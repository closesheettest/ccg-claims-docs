// netlify/functions/payroll-api.js
//
// The OFFICE side of payroll/timekeeping (?mode=payroll). This is the HR/admin
// screen: the roster, departments and who signs each one off, pay setup, the
// PTO allotments, the holiday calendar, the company-wide view of which
// departments have signed off last week, and the payroll export.
//
// AUTH: the caller must send a live payroll session token belonging to somebody
// flagged office/HR (is_admin). It is deliberately NOT the app's shared
// visit_token behind a PIN any more — that token lives in app_settings, which
// the public page key can read, so it guarded nothing. Now the office signs in
// with their own mobile + passcode, exactly like an employee, and the session is
// checked for is_admin on every call.
//
// The employee-facing half lives in payroll-me.js.
//
//   POST { token, action, ... }
//
//   shifts           →  { shifts }   the named shifts (Day, Night…)
//   shift_save       { id?, name, start_time, end_time, grace_minutes?, active? }
//   shift_delete     { id }
//   departments      →  { departments } (with manager name + headcount)
//   department_save  { id?, name, manager_employee_id?, active? }
//   department_delete{ id }
//   employees        { include_inactive? }  →  { employees }
//   employee_save    { id?, first_name, last_name, phone, ...pay + PTO fields }
//   import_roster    { text, commit? }  paste a roster → preview, then create
//   employee_delete  { id }                 →  deactivates (keeps history)
//   reset_passcode   { id }                 →  clears it; next login sets a new one
//   invite           { id } | { missing:true } → text/email the sign-in link, and
//                                              report what the carrier did with it
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
// SERVICE KEY, not the anon key. The anon key ships in the public page bundle,
// so anything it can reach is world-readable — and once RLS is on for the
// payroll tables it can reach nothing here at all. Falls back to anon so this
// deploy is safe BEFORE the service key is set and RLS is enabled.
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };
const TZ = "America/New_York";

// NOTE: hourly_rate / annual_salary are deliberately NOT here. This app's
// Supabase anon key ships in the public page bundle and these tables have RLS
// off, so anything stored here is world-readable. Pay rates live with FrankCrum;
// this tool reports HOURS, and FrankCrum turns hours into money.
const EMP_COLS = [
  "first_name", "last_name", "email", "phone", "department_id", "title", "pay_type",
  "standard_day_hours", "standard_week_hours", "hire_date", "pto_days_per_year",
  "pto_carryover_days", "sick_days_per_year", "paid_holidays", "shift_id", "is_manager",
  "is_admin", "active", "notes",
];
const NUMERIC = new Set(["standard_day_hours", "standard_week_hours", "pto_days_per_year", "pto_carryover_days", "sick_days_per_year"]);
const BOOL = new Set(["paid_holidays", "is_manager", "is_admin", "active"]);
const PTO_TYPES = ["pto"], SICK_TYPES = ["sick", "doctor"];

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return cors(200, "");
  if (event.httpMethod !== "POST") return cors(405, j({ ok: false, error: "POST only" }));
  if (!SB_URL || !SB_KEY) return cors(500, j({ ok: false, error: "Supabase env missing" }));

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch { return cors(400, j({ ok: false, error: "bad JSON" })); }
  const actor = await officeSession(b.token);
  if (!actor) return cors(401, j({ ok: false, error: "Your office session has expired — sign in again." }));

  const action = String(b.action || "").trim();
  try {
    // ── Bulk roster import ─────────────────────────────────────────
    // Paste the roster straight out of a spreadsheet. Always previews first;
    // nothing is written unless commit:true comes back.
    if (action === "import_roster") {
      const parsed = parseRoster(String(b.text || ""));
      if (!parsed.rows.length) return cors(400, j({ ok: false, error: parsed.error || "Nothing to import — paste rows with a name, and ideally a department, who signs off, and a mobile number." }));

      const [existing, depts] = await Promise.all([
        get("payroll_employees?select=id,first_name,last_name,phone,department_id,active"),
        get("payroll_departments?select=id,name"),
      ]);
      const byKey = Object.fromEntries(existing.filter((e) => phoneKey(e.phone)).map((e) => [phoneKey(e.phone), e]));
      const byName = {};
      for (const e of existing) byName[`${e.first_name} ${e.last_name}`.toLowerCase()] = e;
      const deptByName = Object.fromEntries(depts.map((d) => [d.name.toLowerCase(), d]));

      // Each department is signed off by ONE person: whoever the most rows in
      // that department name. Rows that name someone else are reported, not lost.
      const votes = {};
      for (const r of parsed.rows) {
        if (!r.department || !r.manager) continue;
        votes[r.department] = votes[r.department] || {};
        votes[r.department][r.manager] = (votes[r.department][r.manager] || 0) + 1;
      }
      const deptManager = {};
      for (const [d, v] of Object.entries(votes)) {
        deptManager[d] = Object.entries(v).sort((a, c) => c[1] - a[1])[0][0];
      }

      const warnings = [];
      const rows = parsed.rows.map((r) => {
        const key = phoneKey(r.phone);
        const dupeInSheet = parsed.rows.filter((x) => x !== r && key && phoneKey(x.phone) === key).length > 0;
        const already = (key && byKey[key]) || byName[`${r.first_name} ${r.last_name}`.toLowerCase()];
        const differs = r.manager && deptManager[r.department] && r.manager.toLowerCase() !== deptManager[r.department].toLowerCase();
        return {
          ...r,
          status: already ? "exists" : dupeInSheet ? "duplicate" : "new",
          no_phone: !key,
          existing_name: already ? `${already.first_name} ${already.last_name}` : null,
          signs_off: deptManager[r.department] || null,
          manager_overridden: differs ? deptManager[r.department] : null,
        };
      });

      // Resolve each department's manager to somebody who will actually exist.
      const deptPlan = Object.entries(deptManager).map(([name, mgr]) => {
        const inSheet = parsed.rows.find((r) => r.first_name.toLowerCase() === mgr.toLowerCase());
        const inRoster = Object.values(byName).find((e) => e.first_name.toLowerCase() === mgr.toLowerCase());
        const resolved = inSheet ? `${inSheet.first_name} ${inSheet.last_name}` : inRoster ? `${inRoster.first_name} ${inRoster.last_name}` : null;
        if (!resolved) warnings.push(`"${mgr}" signs off ${name} but isn't on this list — add them as an employee, then set ${name}'s manager on the Teams tab.`);
        return { name, manager_first: mgr, manager_name: resolved, exists: !!deptByName[name.toLowerCase()] };
      });
      const noPhone = rows.filter((r) => r.no_phone && r.status !== "exists").map((r) => `${r.first_name} ${r.last_name}`);
      if (noPhone.length) warnings.push(`${noPhone.length} ${noPhone.length === 1 ? "person has" : "people have"} no mobile number, so they'll be on the roster but can't sign in or be texted until one is added: ${noPhone.join(", ")}.`);
      for (const r of rows) {
        if (r.manager_overridden) warnings.push(`Your sheet says ${r.first_name} ${r.last_name} reports to ${r.manager}, but ${r.department} is signed off by ${r.manager_overridden} — that's who will sign their week.`);
      }

      const counts = {
        new: rows.filter((r) => r.status === "new").length,
        exists: rows.filter((r) => r.status === "exists").length,
        needs_phone: rows.filter((r) => r.no_phone && r.status !== "exists").length,
        duplicate: rows.filter((r) => r.status === "duplicate").length,
        departments_new: deptPlan.filter((d) => !d.exists).length,
      };

      if (!b.commit) return cors(200, j({ ok: true, preview: true, rows, departments: deptPlan, warnings, counts }));

      // ── commit ──
      const madeDept = {};
      for (const d of deptPlan) {
        if (deptByName[d.name.toLowerCase()]) { madeDept[d.name] = deptByName[d.name.toLowerCase()].id; continue; }
        const ins = await postRow("payroll_departments", { name: d.name, active: true });
        if (ins?.id) { madeDept[d.name] = ins.id; }
      }
      const created = [];
      for (const r of rows) {
        if (r.status !== "new") continue;
        const ins = await postRow("payroll_employees", {
          first_name: r.first_name, last_name: r.last_name,
          phone: phoneKey(r.phone) || null, email: r.email || null,
          department_id: madeDept[r.department] || null,
          title: r.title || null, pay_type: "hourly", active: true,
        }).catch(() => null);
        if (ins?.id) created.push({ id: ins.id, name: `${r.first_name} ${r.last_name}` });
      }
      // Now that everyone exists, point each department at its manager.
      const all = await get("payroll_employees?select=id,first_name,last_name");
      const linked = [];
      for (const d of deptPlan) {
        if (!d.manager_name || !madeDept[d.name]) continue;
        const m = all.find((e) => `${e.first_name} ${e.last_name}`.toLowerCase() === d.manager_name.toLowerCase());
        if (!m) continue;
        await patch(`payroll_departments?id=eq.${madeDept[d.name]}`, { manager_employee_id: m.id });
        await patch(`payroll_employees?id=eq.${m.id}`, { is_manager: true, updated_at: nowIso() });
        linked.push({ department: d.name, manager: d.manager_name });
      }
      return cors(200, j({ ok: true, imported: created.length, created, departments_linked: linked, warnings, counts }));
    }

    // ── Shifts ─────────────────────────────────────────────────────
    if (action === "shifts") {
      const [shifts, emps] = await Promise.all([
        get("payroll_shifts?select=*&order=sort_order.asc"),
        get("payroll_employees?active=is.true&select=id,shift_id"),
      ]);
      return cors(200, j({ ok: true, shifts: shifts.map((x) => ({ ...x, headcount: emps.filter((e) => e.shift_id === x.id).length, crosses_midnight: String(x.end_time) <= String(x.start_time) })) }));
    }

    if (action === "shift_save") {
      const name = str(b.name, 40);
      const start = tstr(b.start_time), end = tstr(b.end_time);
      if (!name) return cors(400, j({ ok: false, error: "Name the shift." }));
      if (!start || !end) return cors(400, j({ ok: false, error: "Both a start and an end time are required (24-hour, e.g. 18:00)." }));
      const row = { name, start_time: start, end_time: end, grace_minutes: num(b.grace_minutes, 0, 120) || 15, active: b.active !== false, sort_order: num(b.sort_order, 0, 99) || 0 };
      if (b.id) await patch(`payroll_shifts?id=eq.${str(b.id, 64)}`, row);
      else await upsert("payroll_shifts", row, "name");
      return cors(200, j({ ok: true }));
    }

    if (action === "shift_delete") {
      const id = str(b.id, 64);
      const on = await get(`payroll_shifts?id=eq.${id}&select=id`);
      if (!on.length) return cors(404, j({ ok: false, error: "Shift not found." }));
      const used = await get(`payroll_employees?shift_id=eq.${id}&active=is.true&select=id&limit=1`);
      if (used.length) return cors(400, j({ ok: false, error: "Move that shift's employees to another one first." }));
      await del(`payroll_shifts?id=eq.${id}`);
      return cors(200, j({ ok: true }));
    }

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
      const [emps, depts, shifts] = await Promise.all([
        get(`payroll_employees?${filter}select=id,first_name,last_name,email,phone,department_id,title,pay_type,standard_day_hours,standard_week_hours,hire_date,pto_days_per_year,pto_carryover_days,sick_days_per_year,paid_holidays,shift_id,is_manager,is_admin,active,notes,passcode_set_at&order=last_name.asc`),
        get("payroll_departments?select=id,name"),
        get("payroll_shifts?select=id,name,start_time,end_time&order=sort_order.asc"),
      ]);
      const dn = Object.fromEntries(depts.map((d) => [d.id, d.name]));
      const sn = Object.fromEntries(shifts.map((x) => [x.id, x.name]));
      return cors(200, j({
        ok: true,
        employees: emps.map((e) => ({ ...e, department_name: dn[e.department_id] || null, shift_name: sn[e.shift_id] || null })),
        departments: depts, shifts,
      }));
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
        else if (k === "phone") v = phoneKey(v) || null;   // stored bare — it's the login
        else v = str(v, k === "notes" ? 2000 : 120) || null;
        row[k] = v;
      }
      if (!b.id) {
        if (!row.first_name || !row.last_name) return cors(400, j({ ok: false, error: "First and last name are required." }));
        // A mobile is how they sign in, but a roster can be built before the
        // numbers are collected — the People tab flags anyone who can't log in yet.
        if (phoneKey(row.phone)) {
          const dupe = await get(`payroll_employees?phone=eq.${phoneKey(row.phone)}&select=id,first_name,last_name&limit=1`);
          if (dupe.length) return cors(400, j({ ok: false, error: `That number is already on the roster (${dupe[0].first_name} ${dupe[0].last_name}).` }));
        }
      }
      row.updated_at = nowIso();
      if (b.id) await patch(`payroll_employees?id=eq.${str(b.id, 64)}`, row);
      else await post("payroll_employees", row);
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

    // ── Invites ────────────────────────────────────────────────────
    // Texts the sign-in link (and emails it to anyone who has an address), then
    // reports the CARRIER'S verdict per person — an invite that silently fails
    // is how somebody ends up never onboarding and nobody noticing.
    if (action === "invite") {
      const rows = b.missing
        ? await get("payroll_employees?active=is.true&passcode_set_at=is.null&select=id,first_name,last_name,phone,email&order=last_name.asc")
        : await get(`payroll_employees?id=eq.${str(b.id, 64)}&select=id,first_name,last_name,phone,email&limit=1`);
      if (!rows.length) return cors(200, j({ ok: true, sent: [], note: "Everyone active has already signed in." }));

      const base = (process.env.URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
      const bare = `${base.replace(/^https?:\/\//, "")}/timecard`;
      const out = [];
      for (const e of rows) {
        const res = { name: `${e.first_name} ${e.last_name}`.trim(), sms: null, email: null };
        if (e.phone) {
          // Bare link on purpose — the https:// form gets blocked by carriers.
          // Link on its own line: easy to tap, and easy to select-and-copy if a
          // phone declines to linkify it.
          const msg = `Hi ${e.first_name} - this is your U.S. Shingle time card.\n\n${bare}\n\nSign in with THIS mobile number and pick a 4-8 digit passcode. Check in when your day starts, and at the end say what you got done.`;
          const r = await postJson("ghl-sms", { to: e.phone, name: res.name, message: msg, verify: true });
          res.sms = r?.delivered ? "delivered" : (r?.status || r?.error || r?.details?.message || "not delivered");
        }
        if (e.email) {
          const ok = await postJson("send-email", {
            to: e.email, subject: "Your U.S. Shingle time card", fromName: "U.S. Shingle Time Cards",
            html: `<p>Hi ${e.first_name},</p><p>This is your time card. Sign in with your <b>mobile number</b> — not an email — then pick your own 4–8 digit passcode.</p>` +
              `<p><a href="${base}/?mode=timecard" style="display:inline-block;padding:12px 22px;background:#0f2a4a;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Open my time card</a></p>` +
              `<p>Tap <b>Check in</b> when your day starts, and at the end write a quick recap of what you got done — that's what closes the day and sets your hours.</p>` +
              `<p style="color:#64748b;font-size:13px;">U.S. Shingle &amp; Metal</p>`,
          });
          res.email = ok?.success ? "sent" : "failed";
        }
        if (!e.phone && !e.email) res.sms = "no phone or email on file";
        out.push(res);
      }
      return cors(200, j({ ok: true, sent: out }));
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
      const [depts, emps, entries, approvals] = await Promise.all([
        get("payroll_departments?active=is.true&select=id,name,manager_employee_id&order=name.asc"),
        get("payroll_employees?active=is.true&select=id,first_name,last_name,department_id,pay_type,is_admin,standard_day_hours,standard_week_hours"),
        get(`payroll_time_entries?work_date=gte.${ws}&work_date=lte.${we}&select=*`),
        get(`payroll_week_approvals?week_start=eq.${ws}&select=*`),
      ]);
      const name = Object.fromEntries(emps.map((e) => [e.id, `${e.first_name} ${e.last_name}`.trim()]));
      const rows = depts.map((d) => {
        const team = emps.filter((e) => e.department_id === d.id);
        const mine = entries.filter((x) => team.some((t) => t.id === x.employee_id));
        const appr = approvals.find((a) => a.department_id === d.id && a.status === "approved") || null;
        return {
          id: d.id, name: d.name,
          manager_name: d.manager_employee_id ? name[d.manager_employee_id] || null : null,
          manager_missing: !d.manager_employee_id,
          headcount: team.length,
          totals: totalsFor(mine, team),
          status: appr ? "approved" : "open",
          approved_by_name: appr?.approved_by_name || null,
          approved_at: appr?.approved_at || null,
        };
      });
      // Owners and office/HR accounts don't sit in a department and don't clock
      // in — flagging them as "nobody signs their hours" is noise, not a problem.
      const unassigned = emps.filter((e) => !e.department_id && !e.is_admin).map((e) => ({ id: e.id, name: name[e.id] }));
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

    // ── One day, company-wide: who checked in and what they got done ─
    if (action === "day_review") {
      const d = dstr(b.work_date) || todayET();
      const [emps, depts, shifts, entries] = await Promise.all([
        get("payroll_employees?active=is.true&select=id,first_name,last_name,department_id,shift_id,title&order=last_name.asc"),
        get("payroll_departments?select=id,name"),
        get("payroll_shifts?select=id,name,start_time,end_time"),
        get(`payroll_time_entries?work_date=eq.${d}&select=*`),
      ]);
      const dayAppr = await get(`payroll_week_approvals?week_start=eq.${d}&select=department_id,status,approved_by_name,approved_at`);
      const dn = Object.fromEntries(depts.map((x) => [x.id, x.name]));
      const sn = Object.fromEntries(shifts.map((x) => [x.id, x.name]));
      const rows = emps.map((e) => {
        const en = entries.find((x) => x.employee_id === e.id) || null;
        const state = !en ? "not_started"
          : en.day_type !== "worked" ? "off"
            : en.recap_at ? "done"
              : en.checked_in_at ? "working" : "not_started";
        return {
          id: e.id, name: `${e.last_name}, ${e.first_name}`, title: e.title,
          department: dn[e.department_id] || "—", shift: sn[e.shift_id] || "—",
          state, day_type: en?.day_type || null, time_in: en?.time_in || null, time_out: en?.time_out || null,
          hours: en ? Number(en.hours || 0) : 0, late_minutes: en?.late_minutes || 0,
          off_hours: en ? Number(en.off_hours || 0) : 0, note: en?.note || null,
          recap: en?.recap || null, recap_at: en?.recap_at || null,
        };
      });
      return cors(200, j({
        ok: true, work_date: d, rows,
        signed_off: dayAppr.filter((a) => a.status === "approved").map((a) => ({ department: dn[a.department_id] || "—", by: a.approved_by_name, at: a.approved_at })),
        counts: {
          done: rows.filter((r) => r.state === "done").length,
          working: rows.filter((r) => r.state === "working").length,
          off: rows.filter((r) => r.state === "off").length,
          missing: rows.filter((r) => r.state === "not_started").length,
        },
      }));
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
        // Hours only — no rate, no gross. See the note on EMP_COLS.
        return {
          employee: `${e.last_name}, ${e.first_name}`, department: dn[e.department_id] || "—",
          pay_type: e.pay_type,
          regular: t.regular, overtime: t.overtime, holiday: t.holiday, pto: t.pto, sick: t.sick,
          unpaid: t.unpaid, paid_total: t.paid_total,
          late_minutes: t.late_minutes, left_early_minutes: t.left_early_minutes,
        };
      });
      const cols = ["employee", "department", "pay_type", "regular", "overtime", "holiday", "pto", "sick", "unpaid", "paid_total", "late_minutes", "left_early_minutes"];
      const csv = [cols.join(",")].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))).join("\n");
      return cors(200, j({ ok: true, start, end, rows, csv, note: "Hours only. Pay rates are not held in this system — hand these hours to FrankCrum, which holds the rates and runs the money." }));
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

// ── roster paste parsing ─────────────────────────────────────────────
// Takes whatever comes off a spreadsheet — tabs or commas, header row or not —
// and returns clean {first_name, last_name, department, manager, phone, email}.
function parseRoster(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], error: "Nothing pasted." };
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const split = (l) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, ""));

  let cols = { name: 0, department: 1, manager: 2, phone: 3, email: 4, title: -1 };
  let start = 0;
  const head = split(lines[0]).map((h) => h.toLowerCase());
  const looksLikeHeader = head.some((h) => /^name$/.test(h) || /(^|\b)(dept|department)\b/.test(h) || /who to ask/.test(h));
  if (looksLikeHeader) {
    start = 1;
    cols = { name: -1, department: -1, manager: -1, phone: -1, email: -1, title: -1 };
    head.forEach((h, i) => {
      if (/name/.test(h) && cols.name < 0) cols.name = i;
      else if (/dept|department/.test(h)) cols.department = i;
      else if (/who to ask|manager|signs|supervisor|reports/.test(h)) cols.manager = i;
      else if (/phone|mobile|cell/.test(h)) cols.phone = i;
      else if (/email|e-mail/.test(h)) cols.email = i;
      else if (/title|role|position/.test(h)) cols.title = i;
    });
    if (cols.name < 0) cols.name = 0;
  }

  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const c = split(lines[i]);
    const rawName = (cols.name >= 0 ? c[cols.name] : c[0]) || "";
    if (!rawName) continue;
    const { first, last } = splitName(rawName);
    if (!first && !last) continue;
    rows.push({
      first_name: first, last_name: last,
      department: titleCase(pick(c, cols.department)),
      manager: titleCase(pick(c, cols.manager)),
      phone: pick(c, cols.phone),
      email: (pick(c, cols.email) || "").toLowerCase() || null,
      title: pick(c, cols.title) || null,
    });
  }
  return { rows };
}
function pick(cells, i) { return i >= 0 && cells[i] != null ? String(cells[i]).trim() : ""; }
// "ADAMS, ANGELA" → Adams / Angela.  "VON GRAUPEN, JENNIFER S" → Von Graupen /
// Jennifer (a lone trailing initial is dropped). "Jonathan Bagley" also works.
function splitName(raw) {
  const v = String(raw || "").replace(/\s+/g, " ").trim();
  if (!v) return { first: "", last: "" };
  if (v.includes(",")) {
    const [l, r = ""] = v.split(",");
    return { last: titleCase(l), first: titleCase(dropInitial(r)) };
  }
  const parts = v.split(" ");
  if (parts.length === 1) return { first: titleCase(parts[0]), last: "—" };
  return { first: titleCase(parts[0]), last: titleCase(parts.slice(1).join(" ")) };
}
function dropInitial(s) {
  const parts = String(s).trim().split(/\s+/);
  if (parts.length > 1 && parts[parts.length - 1].replace(".", "").length === 1) parts.pop();
  return parts.join(" ");
}
// ALL-CAPS spreadsheets read badly on a phone; anything already mixed-case is left alone.
function titleCase(s) {
  const v = String(s || "").trim();
  if (!v) return "";
  if (v !== v.toUpperCase()) return v;
  return v.toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());
}
const phoneKey = (v) => { const d = String(v || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };

// A live session belonging to an ACTIVE employee flagged office/HR. Anything
// else — no token, an expired one, or an ordinary employee's — is refused.
async function officeSession(token) {
  const t = String(token || "").trim();
  if (!t) return null;
  const s = (await get(`payroll_sessions?token=eq.${encodeURIComponent(t)}&select=employee_id,expires_at&limit=1`))[0];
  if (!s || new Date(s.expires_at) < new Date()) return null;
  const emp = (await get(`payroll_employees?id=eq.${s.employee_id}&select=id,first_name,last_name,is_admin,active&limit=1`))[0];
  if (!emp || !emp.active || !emp.is_admin) return null;
  return emp;
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
async function postRow(table, row) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`${table} insert ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const out = await r.json().catch(() => []);
  return out[0] || null;
}
async function postJson(fn, body) {
  const base = (process.env.URL || "https://free-roof-inspections.netlify.app").replace(/\/$/, "");
  try {
    const r = await fetch(`${base}/.netlify/functions/${fn}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return await r.json().catch(() => null);
  } catch { return null; }
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
