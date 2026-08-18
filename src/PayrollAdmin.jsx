// src/PayrollAdmin.jsx
//
// EMPLOYEE PAYROLL — the office screen  (/?mode=payroll)
//
// The HR/office half of timekeeping. Employees keep their own time card at
// /?mode=timecard and their department manager signs the week off Monday
// morning; THIS page is where the office sets all of that up and takes the
// numbers out at the end:
//
//   Sign-off   which departments have signed last week, which haven't
//   People     the roster — pay setup, PTO allotment, comp eligibility, logins
//   Teams      departments + who signs each one off
//   Time Off   every request, company-wide
//   Balances   PTO left / sick used / comp days banked, per person
//   Holidays   the paid-holiday calendar everyone sees
//   Export     one row per employee for the pay period, CSV for whoever runs payroll
//
// PIN-gated like the other office tools: the manager PIN unlocks it, then the
// page pulls the office token out of app_settings and every call carries it.

import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "./lib/supabase";

const API = "/.netlify/functions/payroll-api";
const NAVY = "#0f2a4a", RED = "#c0392b", GREEN = "#15803d", AMBER = "#b45309";
const INK = "#16233b", MUTE = "#5b6b8c", LINE = "#e2e8f2", BG = "#f4f7fb";

const card = { background: "#fff", border: `1px solid ${LINE}`, borderRadius: 14, padding: 14 };
const fld = { width: "100%", boxSizing: "border-box", borderRadius: 10, border: "1px solid #d1d5db", padding: "9px 11px", fontSize: 14, background: "#fff", color: INK };
const btn = (bg, extra) => ({ background: bg, color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", fontWeight: 800, fontSize: 14, cursor: "pointer", ...extra });
const ghost = { background: "#fff", color: NAVY, border: `1.5px solid ${LINE}`, borderRadius: 10, padding: "8px 13px", fontWeight: 700, fontSize: 13.5, cursor: "pointer" };
const th = { textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: MUTE, fontWeight: 800, padding: "8px 10px", borderBottom: `1px solid ${LINE}`, whiteSpace: "nowrap" };
const td = { padding: "9px 10px", borderBottom: `1px solid ${LINE}`, fontSize: 13.5, verticalAlign: "middle" };

const asDate = (s) => new Date(`${s}T12:00:00Z`);
const addDays = (s, n) => { const d = asDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const todayET = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const mondayOf = (s) => { const dow = asDate(s).getUTCDay(); return addDays(s, dow === 0 ? -6 : 1 - dow); };
const pretty = (s) => { if (!s) return ""; const [, m, d] = s.split("-"); return `${+m}/${+d}`; };
const money = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TABS = [
  ["signoff", "Sign-off"], ["people", "People"], ["teams", "Teams"],
  ["timeoff", "Time Off"], ["balances", "Balances"], ["holidays", "Holidays"], ["export", "Export"],
];

function Pill({ children, color = MUTE }) {
  return <span style={{ display: "inline-block", padding: "3px 9px", borderRadius: 999, fontSize: 11.5, fontWeight: 800, color, background: `${color}18`, whiteSpace: "nowrap" }}>{children}</span>;
}
function Err({ children }) {
  if (!children) return null;
  return <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 10, padding: "10px 12px", fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{children}</div>;
}
function Field({ label, children, w }) {
  return (
    <label style={{ flex: `1 1 ${w || 150}px`, minWidth: 120, display: "block" }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: MUTE, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      {children}
    </label>
  );
}

// ════════════════════════════════════════════════════════════════════════
export default function PayrollAdmin() {
  const MGR_PIN = (() => { try { return localStorage.getItem("ccg_mgr_managerPin") || "1234"; } catch { return "1234"; } })();
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [token, setToken] = useState("");
  const [tab, setTab] = useState("signoff");
  const [err, setErr] = useState("");

  const api = useCallback(async (action, extra) => {
    const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action, ...extra }) });
    return r.json().catch(() => ({ ok: false, error: "Bad response" }));
  }, [token]);

  const unlock = async () => {
    if (pin !== MGR_PIN) { setErr("Wrong PIN."); return; }
    setErr("");
    const { data } = await supabase.from("app_settings").select("value").eq("key", "visit_token").maybeSingle();
    setToken(data?.value || "");
    setUnlocked(true);
  };

  if (!unlocked) {
    return (
      <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "system-ui, sans-serif" }}>
        <div style={{ ...card, width: 340, display: "grid", gap: 12, textAlign: "center" }}>
          <div style={{ fontSize: 30 }}>🧾</div>
          <div style={{ fontSize: 20, fontWeight: 900, color: NAVY }}>Employee Payroll</div>
          <div style={{ fontSize: 13, color: MUTE }}>Office screen — enter the manager PIN.</div>
          <input style={{ ...fld, textAlign: "center", fontSize: 20, letterSpacing: 4 }} type="password" inputMode="numeric"
            value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => e.key === "Enter" && unlock()} placeholder="••••" />
          <Err>{err}</Err>
          <button style={btn(NAVY)} onClick={unlock}>Unlock</button>
          <a href="/?mode=timecard" style={{ fontSize: 12.5, color: MUTE }}>Looking for your own time card?</a>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: BG, padding: "16px 12px 60px", fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", color: INK }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 24, fontWeight: 900, color: NAVY }}>🧾 Employee Payroll</div>
            <div style={{ fontSize: 13, color: MUTE }}>Hours, time off and the Monday sign-off for W-2 staff. Subcontractor crews are paid in the crew portal.</div>
          </div>
          <a href="/?mode=timecard" target="_blank" rel="noopener noreferrer" style={{ ...ghost, textDecoration: "none" }}>Open the employee time card ↗</a>
        </div>

        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 14 }}>
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => { setTab(k); setErr(""); }} style={{
              ...ghost, background: tab === k ? NAVY : "#fff", color: tab === k ? "#fff" : NAVY, borderColor: tab === k ? NAVY : LINE,
            }}>{label}</button>
          ))}
        </div>

        <Err>{err}</Err>
        {tab === "signoff" && <SignOff api={api} onErr={setErr} />}
        {tab === "people" && <People api={api} onErr={setErr} />}
        {tab === "teams" && <Teams api={api} onErr={setErr} />}
        {tab === "timeoff" && <TimeOffAll api={api} onErr={setErr} />}
        {tab === "balances" && <Balances api={api} onErr={setErr} />}
        {tab === "holidays" && <Holidays api={api} onErr={setErr} />}
        {tab === "export" && <Export api={api} onErr={setErr} />}
      </div>
    </div>
  );
}

// ── SIGN-OFF: the Monday board ──────────────────────────────────────────
function SignOff({ api, onErr }) {
  const [ws, setWs] = useState(() => addDays(mondayOf(todayET()), -7));
  const [d, setD] = useState(null);
  const [drill, setDrill] = useState(null);   // { employee_id, name }

  const load = useCallback(async (week) => {
    const r = await api("overview", { week_start: week });
    if (r.ok) setD(r); else onErr(r.error || "Couldn't load the week.");
  }, [api, onErr]);
  useEffect(() => { load(ws); }, [ws, load]);

  const thisWeek = mondayOf(todayET());
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button style={ghost} onClick={() => setWs(addDays(ws, -7))}>←</button>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontWeight: 900 }}>{pretty(ws)} – {pretty(addDays(ws, 6))}</div>
            <div style={{ fontSize: 11.5, color: MUTE }}>{ws === addDays(thisWeek, -7) ? "Last week" : ws === thisWeek ? "This week" : "Past week"}</div>
          </div>
          <button style={ghost} disabled={ws >= thisWeek} onClick={() => setWs(addDays(ws, 7))}>→</button>
        </div>
        {d ? (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>SIGNED OFF</div><div style={{ fontSize: 19, fontWeight: 900, color: d.approved_count === d.departments.length ? GREEN : AMBER }}>{d.approved_count}/{d.departments.length}</div></div>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>HOURS WORKED</div><div style={{ fontSize: 19, fontWeight: 900 }}>{d.company.worked}</div></div>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>OVERTIME</div><div style={{ fontSize: 19, fontWeight: 900, color: d.company.overtime ? AMBER : INK }}>{d.company.overtime}</div></div>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>PAID TIME OFF</div><div style={{ fontSize: 19, fontWeight: 900 }}>{(d.company.pto + d.company.sick + d.company.holiday + d.company.comp_used).toFixed(2).replace(/\.00$/, "")}</div></div>
          </div>
        ) : null}
      </div>

      {d?.unassigned?.length ? (
        <div style={{ ...card, background: "#fffbeb", borderColor: "#fde68a", fontSize: 13.5 }}>
          <b>{d.unassigned.length} employee{d.unassigned.length === 1 ? " has" : "s have"} no department</b> — nobody signs their hours off. Assign them on the People tab: {d.unassigned.map((u) => u.name).join(", ")}
        </div>
      ) : null}

      <div style={{ ...card, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
          <thead><tr>
            <th style={th}>Department</th><th style={th}>Signs off</th><th style={th}>Team</th>
            <th style={th}>Marked done</th><th style={th}>Worked</th><th style={th}>OT</th><th style={th}>Status</th>
          </tr></thead>
          <tbody>
            {(d?.departments || []).map((r) => (
              <tr key={r.id}>
                <td style={{ ...td, fontWeight: 800 }}>{r.name}</td>
                <td style={td}>{r.manager_name || <Pill color={RED}>no manager set</Pill>}</td>
                <td style={td}>{r.headcount}</td>
                <td style={td}>{r.submitted}/{r.headcount}</td>
                <td style={{ ...td, fontWeight: 700 }}>{r.totals.worked}h</td>
                <td style={{ ...td, color: r.totals.overtime ? AMBER : MUTE }}>{r.totals.overtime}h</td>
                <td style={td}>
                  {r.status === "approved"
                    ? <Pill color={GREEN}>✓ {r.approved_by_name || "signed"}</Pill>
                    : <Pill color={AMBER}>waiting</Pill>}
                </td>
              </tr>
            ))}
            {d && !d.departments.length ? <tr><td style={{ ...td, color: MUTE }} colSpan={7}>No departments yet — add them on the Teams tab.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <EmployeeDrill api={api} ws={ws} onErr={onErr} drill={drill} setDrill={setDrill} />
    </div>
  );
}

// Office override: pull up one person's week and fix any day, even a locked one.
function EmployeeDrill({ api, ws, onErr, drill, setDrill }) {
  const [emps, setEmps] = useState([]);
  const [week, setWeek] = useState(null);
  const [pick, setPick] = useState("");

  useEffect(() => { (async () => { const d = await api("employees"); if (d.ok) setEmps(d.employees); })(); }, [api]);
  const load = useCallback(async (id) => {
    if (!id) { setWeek(null); return; }
    const d = await api("employee_week", { employee_id: id, week_start: ws });
    if (d.ok) setWeek(d); else onErr(d.error || "Couldn't load that week.");
  }, [api, ws, onErr]);
  useEffect(() => { load(pick); }, [pick, load]);

  const save = async (payload) => {
    const d = await api("save_day", { employee_id: pick, ...payload });
    if (!d.ok) { onErr(d.error || "Couldn't save."); return; }
    load(pick);
  };

  return (
    <div style={{ ...card, display: "grid", gap: 11 }}>
      <div style={{ fontWeight: 900 }}>Fix one person's week</div>
      <div style={{ fontSize: 13, color: MUTE }}>The office can edit any day — including a week a manager already signed off.</div>
      <select style={{ ...fld, maxWidth: 340 }} value={pick} onChange={(e) => setPick(e.target.value)}>
        <option value="">Pick an employee…</option>
        {emps.map((e) => <option key={e.id} value={e.id}>{e.last_name}, {e.first_name}{e.department_name ? ` · ${e.department_name}` : ""}</option>)}
      </select>
      {week ? (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
            <thead><tr><th style={th}>Day</th><th style={th}>Type</th><th style={th}>In</th><th style={th}>Out</th><th style={th}>Hours</th><th style={th}>Note</th><th style={th}></th></tr></thead>
            <tbody>{week.days.map((d) => <DrillRow key={d.work_date} d={d} onSave={save} />)}</tbody>
            <tfoot><tr>
              <td style={{ ...td, fontWeight: 900 }} colSpan={4}>Week total</td>
              <td style={{ ...td, fontWeight: 900 }}>{week.totals.worked}h{week.totals.overtime ? ` (+${week.totals.overtime} OT)` : ""}</td>
              <td style={td} colSpan={2}>{week.totals.pto ? `${week.totals.pto}h PTO · ` : ""}{week.totals.sick ? `${week.totals.sick}h sick · ` : ""}{week.totals.holiday ? `${week.totals.holiday}h holiday` : ""}</td>
            </tr></tfoot>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function DrillRow({ d, onSave }) {
  const e = d.entry;
  const [f, setF] = useState({ day_type: e?.day_type || "worked", time_in: e?.time_in || "", time_out: e?.time_out || "", hours: e?.hours ?? "", note: e?.note || "" });
  useEffect(() => { setF({ day_type: e?.day_type || "worked", time_in: e?.time_in || "", time_out: e?.time_out || "", hours: e?.hours ?? "", note: e?.note || "" }); }, [e]);
  const [busy, setBusy] = useState(false);
  const dirty = f.day_type !== (e?.day_type || "worked") || f.time_in !== (e?.time_in || "") || f.time_out !== (e?.time_out || "") || String(f.hours) !== String(e?.hours ?? "") || f.note !== (e?.note || "");
  return (
    <tr style={{ background: e?.locked ? "#f8fafc" : "transparent" }}>
      <td style={{ ...td, whiteSpace: "nowrap", fontWeight: 700 }}>{d.weekday.slice(0, 3)} {pretty(d.work_date)}{e?.locked ? " 🔒" : ""}</td>
      <td style={td}>
        <select style={{ ...fld, minWidth: 120 }} value={f.day_type} onChange={(v) => setF((s) => ({ ...s, day_type: v.target.value }))}>
          {["worked", "pto", "sick", "doctor", "holiday", "comp_used", "unpaid", "bereavement", "jury", "no_show", "other"].map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </td>
      <td style={td}><input style={{ ...fld, width: 108 }} type="time" value={f.time_in} onChange={(v) => setF((s) => ({ ...s, time_in: v.target.value }))} /></td>
      <td style={td}><input style={{ ...fld, width: 108 }} type="time" value={f.time_out} onChange={(v) => setF((s) => ({ ...s, time_out: v.target.value }))} /></td>
      <td style={td}><input style={{ ...fld, width: 72 }} type="number" step="0.25" value={f.hours} onChange={(v) => setF((s) => ({ ...s, hours: v.target.value }))} /></td>
      <td style={td}><input style={fld} value={f.note} maxLength={200} onChange={(v) => setF((s) => ({ ...s, note: v.target.value }))} /></td>
      <td style={{ ...td, whiteSpace: "nowrap" }}>
        <button style={{ ...ghost, padding: "6px 10px", opacity: dirty ? 1 : 0.45 }} disabled={busy || !dirty}
          onClick={async () => { setBusy(true); await onSave({ work_date: d.work_date, ...f }); setBusy(false); }}>Save</button>
        {e ? <button style={{ ...ghost, padding: "6px 10px", marginLeft: 5, color: RED, borderColor: "#fecaca" }} disabled={busy}
          onClick={async () => { setBusy(true); await onSave({ work_date: d.work_date, delete: true }); setBusy(false); }}>×</button> : null}
      </td>
    </tr>
  );
}

// ── PEOPLE ──────────────────────────────────────────────────────────────
const BLANK_EMP = {
  first_name: "", last_name: "", email: "", phone: "", department_id: "", title: "",
  pay_type: "hourly", hourly_rate: "", annual_salary: "", standard_day_hours: 8, standard_week_hours: 40,
  hire_date: "", pto_days_per_year: 0, pto_carryover_days: 0, sick_days_per_year: 0,
  comp_time_eligible: false, paid_holidays: true, is_manager: false, is_admin: false, active: true, notes: "",
};

function People({ api, onErr }) {
  const [rows, setRows] = useState(null);
  const [depts, setDepts] = useState([]);
  const [showInactive, setShowInactive] = useState(false);
  const [edit, setEdit] = useState(null);

  const load = useCallback(async () => {
    const d = await api("employees", { include_inactive: showInactive });
    if (d.ok) { setRows(d.employees); setDepts(d.departments); } else onErr(d.error || "Couldn't load the roster.");
  }, [api, showInactive, onErr]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const d = await api("employee_save", edit);
    if (!d.ok) { onErr(d.error || "Save failed."); return; }
    setEdit(null); load();
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: 13.5, fontWeight: 600, display: "flex", gap: 7, alignItems: "center" }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> show inactive
        </label>
        <button style={btn(NAVY)} onClick={() => setEdit({ ...BLANK_EMP })}>+ Add employee</button>
      </div>

      {edit ? (
        <div style={{ ...card, display: "grid", gap: 11, borderColor: "#bfdbfe", background: "#f8fbff" }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>{edit.id ? `Edit ${edit.first_name} ${edit.last_name}` : "New employee"}</div>
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            <Field label="First name"><input style={fld} value={edit.first_name} onChange={(e) => setEdit({ ...edit, first_name: e.target.value })} /></Field>
            <Field label="Last name"><input style={fld} value={edit.last_name} onChange={(e) => setEdit({ ...edit, last_name: e.target.value })} /></Field>
            <Field label="Work email (their login)" w={220}><input style={fld} type="email" value={edit.email || ""} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="Phone"><input style={fld} value={edit.phone || ""} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
          </div>
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            <Field label="Department">
              <select style={fld} value={edit.department_id || ""} onChange={(e) => setEdit({ ...edit, department_id: e.target.value })}>
                <option value="">— none —</option>
                {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Title"><input style={fld} value={edit.title || ""} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label="Hire date"><input style={fld} type="date" value={edit.hire_date || ""} onChange={(e) => setEdit({ ...edit, hire_date: e.target.value })} /></Field>
          </div>
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            <Field label="Pay type">
              <select style={fld} value={edit.pay_type} onChange={(e) => setEdit({ ...edit, pay_type: e.target.value })}>
                <option value="hourly">Hourly</option><option value="salary">Salary</option>
              </select>
            </Field>
            {edit.pay_type === "hourly"
              ? <Field label="Hourly rate"><input style={fld} type="number" step="0.01" value={edit.hourly_rate ?? ""} onChange={(e) => setEdit({ ...edit, hourly_rate: e.target.value })} /></Field>
              : <Field label="Annual salary"><input style={fld} type="number" step="100" value={edit.annual_salary ?? ""} onChange={(e) => setEdit({ ...edit, annual_salary: e.target.value })} /></Field>}
            <Field label="Day hours"><input style={fld} type="number" step="0.5" value={edit.standard_day_hours} onChange={(e) => setEdit({ ...edit, standard_day_hours: e.target.value })} /></Field>
            <Field label="Week hours (OT after)"><input style={fld} type="number" step="0.5" value={edit.standard_week_hours} onChange={(e) => setEdit({ ...edit, standard_week_hours: e.target.value })} /></Field>
          </div>
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            <Field label="Vacation days / yr"><input style={fld} type="number" step="0.5" value={edit.pto_days_per_year} onChange={(e) => setEdit({ ...edit, pto_days_per_year: e.target.value })} /></Field>
            <Field label="Carried over"><input style={fld} type="number" step="0.5" value={edit.pto_carryover_days} onChange={(e) => setEdit({ ...edit, pto_carryover_days: e.target.value })} /></Field>
            <Field label="Sick days / yr"><input style={fld} type="number" step="0.5" value={edit.sick_days_per_year} onChange={(e) => setEdit({ ...edit, sick_days_per_year: e.target.value })} /></Field>
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13.5, fontWeight: 600 }}>
            <label style={{ display: "flex", gap: 7, alignItems: "center" }}><input type="checkbox" checked={!!edit.comp_time_eligible} onChange={(e) => setEdit({ ...edit, comp_time_eligible: e.target.checked })} /> banks comp days for extra days worked</label>
            <label style={{ display: "flex", gap: 7, alignItems: "center" }}><input type="checkbox" checked={!!edit.paid_holidays} onChange={(e) => setEdit({ ...edit, paid_holidays: e.target.checked })} /> paid holidays</label>
            <label style={{ display: "flex", gap: 7, alignItems: "center" }}><input type="checkbox" checked={!!edit.is_manager} onChange={(e) => setEdit({ ...edit, is_manager: e.target.checked })} /> can sign off a department</label>
            <label style={{ display: "flex", gap: 7, alignItems: "center" }}><input type="checkbox" checked={!!edit.is_admin} onChange={(e) => setEdit({ ...edit, is_admin: e.target.checked })} /> office/HR (sees everyone)</label>
            <label style={{ display: "flex", gap: 7, alignItems: "center" }}><input type="checkbox" checked={edit.active !== false} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> active</label>
          </div>
          <Field label="Notes"><input style={fld} value={edit.notes || ""} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></Field>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={btn(NAVY)} onClick={save}>Save</button>
            <button style={ghost} onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      ) : null}

      <div style={{ ...card, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
          <thead><tr>
            <th style={th}>Name</th><th style={th}>Department</th><th style={th}>Pay</th><th style={th}>Vac/yr</th>
            <th style={th}>Comp</th><th style={th}>Role</th><th style={th}>Login</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {(rows || []).map((e) => (
              <tr key={e.id} style={{ opacity: e.active ? 1 : 0.5 }}>
                <td style={{ ...td, fontWeight: 800 }}>{e.last_name}, {e.first_name}<div style={{ fontWeight: 500, fontSize: 12, color: MUTE }}>{e.title || e.email}</div></td>
                <td style={td}>{e.department_name || <Pill color={AMBER}>none</Pill>}</td>
                <td style={td}>{e.pay_type === "hourly" ? `${money(e.hourly_rate)}/hr` : `${money(e.annual_salary)}/yr`}</td>
                <td style={td}>{e.pto_days_per_year}{e.pto_carryover_days ? ` +${e.pto_carryover_days}` : ""}</td>
                <td style={td}>{e.comp_time_eligible ? <Pill color={GREEN}>yes</Pill> : <span style={{ color: MUTE }}>—</span>}</td>
                <td style={td}>{e.is_admin ? <Pill color={NAVY}>office</Pill> : e.is_manager ? <Pill color="#0369a1">manager</Pill> : <span style={{ color: MUTE }}>employee</span>}</td>
                <td style={td}>{e.passcode_set_at ? <Pill color={GREEN}>set</Pill> : <Pill color={MUTE}>not set up</Pill>}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  <button style={{ ...ghost, padding: "6px 10px" }} onClick={() => setEdit({ ...BLANK_EMP, ...e })}>Edit</button>
                  <button style={{ ...ghost, padding: "6px 10px", marginLeft: 5 }} title="Clear their passcode so they can set a new one"
                    onClick={async () => { if (!window.confirm(`Reset ${e.first_name}'s passcode? They'll set a new one next time they sign in.`)) return; const d = await api("reset_passcode", { id: e.id }); if (d.ok) load(); }}>Reset PIN</button>
                  {e.active ? (
                    <button style={{ ...ghost, padding: "6px 10px", marginLeft: 5, color: RED, borderColor: "#fecaca" }}
                      onClick={async () => { if (!window.confirm(`Deactivate ${e.first_name} ${e.last_name}? Their history stays.`)) return; const d = await api("employee_delete", { id: e.id }); if (d.ok) load(); }}>Deactivate</button>
                  ) : null}
                </td>
              </tr>
            ))}
            {rows && !rows.length ? <tr><td style={{ ...td, color: MUTE }} colSpan={8}>Nobody on the roster yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── TEAMS ───────────────────────────────────────────────────────────────
function Teams({ api, onErr }) {
  const [rows, setRows] = useState(null);
  const [emps, setEmps] = useState([]);
  const [edit, setEdit] = useState(null);

  const load = useCallback(async () => {
    const [d, e] = await Promise.all([api("departments"), api("employees")]);
    if (d.ok) setRows(d.departments); else onErr(d.error || "Couldn't load departments.");
    if (e.ok) setEmps(e.employees);
  }, [api, onErr]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const d = await api("department_save", edit);
    if (!d.ok) { onErr(d.error || "Save failed."); return; }
    setEdit(null); load();
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, fontSize: 13.5, color: MUTE }}>
        A department is what gets signed off. Whoever you name as its manager sees a <b>Team</b> tab on their own time card Monday morning, and gets the reminder text.
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button style={btn(NAVY)} onClick={() => setEdit({ name: "", manager_employee_id: "", active: true })}>+ Add department</button>
      </div>
      {edit ? (
        <div style={{ ...card, display: "grid", gap: 10, borderColor: "#bfdbfe", background: "#f8fbff" }}>
          <div style={{ fontWeight: 900 }}>{edit.id ? "Edit department" : "New department"}</div>
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            <Field label="Name" w={200}><input style={fld} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Warehouse, Office, Production…" /></Field>
            <Field label="Signs off the week" w={240}>
              <select style={fld} value={edit.manager_employee_id || ""} onChange={(e) => setEdit({ ...edit, manager_employee_id: e.target.value })}>
                <option value="">— nobody yet —</option>
                {emps.map((e) => <option key={e.id} value={e.id}>{e.last_name}, {e.first_name}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ fontSize: 12.5, color: MUTE }}>Tip: also tick “can sign off a department” on that person's People record.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={btn(NAVY)} onClick={save}>Save</button>
            <button style={ghost} onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
      <div style={{ ...card, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
          <thead><tr><th style={th}>Department</th><th style={th}>Signs off</th><th style={th}>People</th><th style={th}></th></tr></thead>
          <tbody>
            {(rows || []).map((r) => (
              <tr key={r.id}>
                <td style={{ ...td, fontWeight: 800 }}>{r.name}</td>
                <td style={td}>{r.manager_name || <Pill color={RED}>nobody</Pill>}</td>
                <td style={td}>{r.headcount}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  <button style={{ ...ghost, padding: "6px 10px" }} onClick={() => setEdit({ id: r.id, name: r.name, manager_employee_id: r.manager_employee_id || "", active: r.active })}>Edit</button>
                  <button style={{ ...ghost, padding: "6px 10px", marginLeft: 5, color: RED, borderColor: "#fecaca" }}
                    onClick={async () => { if (!window.confirm(`Delete ${r.name}?`)) return; const d = await api("department_delete", { id: r.id }); if (!d.ok) onErr(d.error); load(); }}>Delete</button>
                </td>
              </tr>
            ))}
            {rows && !rows.length ? <tr><td style={{ ...td, color: MUTE }} colSpan={4}>No departments yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── TIME OFF (company-wide) ─────────────────────────────────────────────
function TimeOffAll({ api, onErr }) {
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState("");
  useEffect(() => { (async () => { const d = await api("time_off", { status }); if (d.ok) setRows(d.requests); else onErr(d.error || "Couldn't load."); })(); }, [api, status, onErr]);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        {[["", "All"], ["pending", "Pending"], ["approved", "Approved"], ["denied", "Denied"]].map(([k, l]) => (
          <button key={k} onClick={() => setStatus(k)} style={{ ...ghost, background: status === k ? NAVY : "#fff", color: status === k ? "#fff" : NAVY }}>{l}</button>
        ))}
      </div>
      <div style={{ ...card, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
          <thead><tr><th style={th}>Employee</th><th style={th}>Type</th><th style={th}>Dates</th><th style={th}>Days</th><th style={th}>Status</th><th style={th}>Decided by</th><th style={th}>Note</th></tr></thead>
          <tbody>
            {(rows || []).map((r) => (
              <tr key={r.id}>
                <td style={{ ...td, fontWeight: 700 }}>{r.employee_name}</td>
                <td style={td}>{r.request_type}</td>
                <td style={td}>{pretty(r.start_date)}{r.end_date !== r.start_date ? `–${pretty(r.end_date)}` : ""}</td>
                <td style={td}>{r.total_days}</td>
                <td style={td}><Pill color={r.status === "approved" ? GREEN : r.status === "denied" ? RED : r.status === "cancelled" ? MUTE : AMBER}>{r.status}</Pill></td>
                <td style={td}>{r.decided_by_name || "—"}</td>
                <td style={{ ...td, color: MUTE }}>{r.note || r.decision_note || ""}</td>
              </tr>
            ))}
            {rows && !rows.length ? <tr><td style={{ ...td, color: MUTE }} colSpan={7}>Nothing here.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── BALANCES + the comp-day bank ────────────────────────────────────────
function Balances({ api, onErr }) {
  const [d, setD] = useState(null);
  const [adj, setAdj] = useState({ employee_id: "", days: 1, reason: "" });
  const load = useCallback(async () => { const r = await api("balances"); if (r.ok) setD(r); else onErr(r.error || "Couldn't load balances."); }, [api, onErr]);
  useEffect(() => { load(); }, [load]);

  const apply = async () => {
    if (!adj.employee_id || !Number(adj.days)) { onErr("Pick a person and a number of days."); return; }
    const r = await api("comp_adjust", adj);
    if (!r.ok) { onErr(r.error || "Couldn't post that adjustment."); return; }
    setAdj({ employee_id: "", days: 1, reason: "" }); load();
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, display: "grid", gap: 10 }}>
        <div style={{ fontWeight: 900 }}>Add or remove comp days by hand</div>
        <div style={{ fontSize: 13, color: MUTE }}>
          Comp days build up on their own when a comp-eligible employee's signed-off week runs past their standard hours. Use this for anything outside that — a Saturday you promised back, or a correction (use a negative number to take days away).
        </div>
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Employee" w={220}>
            <select style={fld} value={adj.employee_id} onChange={(e) => setAdj({ ...adj, employee_id: e.target.value })}>
              <option value="">Pick…</option>
              {(d?.rows || []).map((r) => <option key={r.id} value={r.id}>{r.name}{r.comp_eligible ? "" : " (not comp-eligible)"}</option>)}
            </select>
          </Field>
          <Field label="Days" w={90}><input style={fld} type="number" step="0.25" value={adj.days} onChange={(e) => setAdj({ ...adj, days: e.target.value })} /></Field>
          <Field label="Reason" w={240}><input style={fld} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} placeholder="Worked Saturday 8/15" /></Field>
          <button style={btn(NAVY)} onClick={apply}>Post</button>
        </div>
      </div>

      <div style={{ ...card, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
          <thead><tr>
            <th style={th}>Employee</th><th style={th}>Vacation allotted</th><th style={th}>Used</th><th style={th}>Pending</th>
            <th style={th}>Left</th><th style={th}>Sick used</th><th style={th}>Comp banked</th>
          </tr></thead>
          <tbody>
            {(d?.rows || []).map((r) => (
              <tr key={r.id}>
                <td style={{ ...td, fontWeight: 700 }}>{r.name}</td>
                <td style={td}>{r.pto_allotted}</td>
                <td style={td}>{r.pto_used}</td>
                <td style={td}>{r.pto_pending || "—"}</td>
                <td style={{ ...td, fontWeight: 800, color: r.pto_remaining < 0 ? RED : INK }}>{r.pto_remaining}</td>
                <td style={td}>{r.sick_used}{r.sick_allotted ? ` / ${r.sick_allotted}` : ""}</td>
                <td style={td}>{r.comp_eligible ? <b>{r.comp_banked}</b> : <span style={{ color: MUTE }}>—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 12.5, color: MUTE }}>Days used are counted off the time cards for {d?.year || "this year"} — a day the office keyed in counts the same as one from an approved request.</div>
    </div>
  );
}

// ── HOLIDAYS ────────────────────────────────────────────────────────────
function Holidays({ api, onErr }) {
  const [rows, setRows] = useState(null);
  const [f, setF] = useState({ holiday_date: "", name: "", paid: true, hours: 8 });
  const load = useCallback(async () => { const d = await api("holidays"); if (d.ok) setRows(d.holidays); else onErr(d.error || "Couldn't load holidays."); }, [api, onErr]);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    if (!f.holiday_date || !f.name.trim()) { onErr("A date and a name, please."); return; }
    const d = await api("holiday_save", f);
    if (!d.ok) { onErr(d.error || "Save failed."); return; }
    setF({ holiday_date: "", name: "", paid: true, hours: 8 }); load();
  };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, display: "grid", gap: 10 }}>
        <div style={{ fontWeight: 900 }}>Add a holiday</div>
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Date"><input style={fld} type="date" value={f.holiday_date} onChange={(e) => setF({ ...f, holiday_date: e.target.value })} /></Field>
          <Field label="Name" w={220}><input style={fld} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Christmas Day" /></Field>
          <Field label="Hours" w={90}><input style={fld} type="number" step="0.5" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></Field>
          <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 13.5, fontWeight: 600, paddingBottom: 9 }}>
            <input type="checkbox" checked={f.paid} onChange={(e) => setF({ ...f, paid: e.target.checked })} /> paid
          </label>
          <button style={btn(NAVY)} onClick={add}>Add</button>
        </div>
        <div style={{ fontSize: 12.5, color: MUTE }}>Holidays inside a time-off request aren't counted against anyone's vacation days.</div>
      </div>
      <div style={{ ...card, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
          <thead><tr><th style={th}>Date</th><th style={th}>Holiday</th><th style={th}>Paid</th><th style={th}>Hours</th><th style={th}></th></tr></thead>
          <tbody>
            {(rows || []).map((h) => (
              <tr key={h.id} style={{ opacity: h.holiday_date < todayET() ? 0.55 : 1 }}>
                <td style={{ ...td, fontWeight: 700 }}>{h.holiday_date}</td>
                <td style={td}>{h.name}</td>
                <td style={td}>{h.paid ? "yes" : "no"}</td>
                <td style={td}>{h.hours}</td>
                <td style={td}><button style={{ ...ghost, padding: "6px 10px", color: RED, borderColor: "#fecaca" }}
                  onClick={async () => { if (!window.confirm(`Remove ${h.name}?`)) return; const d = await api("holiday_delete", { id: h.id }); if (d.ok) load(); }}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── EXPORT ──────────────────────────────────────────────────────────────
function Export({ api, onErr }) {
  const lastMon = addDays(mondayOf(todayET()), -7);
  const [range, setRange] = useState({ start: lastMon, end: addDays(lastMon, 6) });
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true); onErr("");
    const r = await api("export", range);
    setBusy(false);
    if (r.ok) setD(r); else onErr(r.error || "Export failed.");
  };
  useEffect(() => { run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const download = () => {
    const blob = new Blob([d.csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `USSM_payroll_${d.start}_to_${d.end}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const totals = (d?.rows || []).reduce((s, r) => ({
    regular: s.regular + r.regular, overtime: s.overtime + r.overtime,
    paid_total: s.paid_total + r.paid_total, gross: s.gross + r.gross_estimate,
  }), { regular: 0, overtime: 0, paid_total: 0, gross: 0 });

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, display: "flex", gap: 9, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Field label="From"><input style={fld} type="date" value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} /></Field>
        <Field label="Through"><input style={fld} type="date" value={range.end} onChange={(e) => setRange({ ...range, end: e.target.value })} /></Field>
        <button style={btn(NAVY)} disabled={busy} onClick={run}>{busy ? "…" : "Run"}</button>
        {d ? <button style={ghost} onClick={download}>⬇ Download CSV</button> : null}
      </div>

      {d ? (
        <>
          <div style={{ ...card, display: "flex", gap: 18, flexWrap: "wrap" }}>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>REGULAR</div><div style={{ fontSize: 20, fontWeight: 900 }}>{totals.regular.toFixed(2)}h</div></div>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>OVERTIME</div><div style={{ fontSize: 20, fontWeight: 900, color: totals.overtime ? AMBER : INK }}>{totals.overtime.toFixed(2)}h</div></div>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>PAID HOURS</div><div style={{ fontSize: 20, fontWeight: 900 }}>{totals.paid_total.toFixed(2)}h</div></div>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>GROSS (ESTIMATE)</div><div style={{ fontSize: 20, fontWeight: 900 }}>{money(totals.gross)}</div></div>
          </div>
          <div style={{ ...card, padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
              <thead><tr>
                <th style={th}>Employee</th><th style={th}>Dept</th><th style={th}>Rate</th><th style={th}>Reg</th><th style={th}>OT</th>
                <th style={th}>Hol</th><th style={th}>PTO</th><th style={th}>Sick</th><th style={th}>Comp</th><th style={th}>Unpaid</th><th style={th}>Gross est.</th>
              </tr></thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.employee}>
                    <td style={{ ...td, fontWeight: 700 }}>{r.employee}</td>
                    <td style={td}>{r.department}</td>
                    <td style={td}>{r.pay_type === "hourly" ? `${money(r.rate)}/hr` : "salary"}</td>
                    <td style={td}>{r.regular}</td>
                    <td style={{ ...td, color: r.overtime ? AMBER : INK }}>{r.overtime}</td>
                    <td style={td}>{r.holiday}</td><td style={td}>{r.pto}</td><td style={td}>{r.sick}</td>
                    <td style={td}>{r.comp_used}</td><td style={td}>{r.unpaid}</td>
                    <td style={{ ...td, fontWeight: 800 }}>{money(r.gross_estimate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 12.5, color: MUTE }}>{d.note}</div>
        </>
      ) : null}
    </div>
  );
}
