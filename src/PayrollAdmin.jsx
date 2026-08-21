// src/PayrollAdmin.jsx
//
// EMPLOYEE PAYROLL — the office screen  (/?mode=payroll)
//
// The HR/office half of timekeeping. Employees check in at the start of their
// shift and file a recap of what they got done at the end (/?mode=timecard);
// their department manager reads those daily and signs the week off Monday
// morning. THIS page is where the office sets all of that up and takes the
// numbers out at the end:
//
//   Sign-off   which departments have signed last week, which haven't
//   Daily      every recap for one day, company-wide
//   Shifts     the named shifts (Day, Night) and their expected times
//   People     the roster — pay setup, PTO allotment, logins, bulk import
//   Teams      departments + who signs each one off
//   Time Off   every request, company-wide
//   Balances   vacation left and sick days used, per person
//   Holidays   the paid-holiday calendar everyone sees
//   Export     one row per employee for the pay period, CSV for whoever runs payroll
//
// ONE DOOR. Everybody signs in here with their mobile number + passcode, and
// the screen routes by who they are:
//   • office/HR  → the admin tool below
//   • anyone else → their own time card, in place
// So a warehouse hand who opens the Payroll box on the internal dashboard just
// lands in their portal instead of being told they lack access. The API still
// checks office/HR on every admin call — the routing is convenience, not the
// security boundary.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { EmployeeScreens } from "./TimeCard";

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
const fmtPhone = (v) => { const d = String(v || "").replace(/\D/g, ""); return d.length === 10 ? `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}` : (v || ""); };

const TABS = [
  ["myday", "My Day"], ["signoff", "Sign-off"], ["daily", "Daily"], ["viewas", "View as"],
  ["people", "People"], ["teams", "Teams"], ["shifts", "Shifts"],
  ["timeoff", "Time Off"], ["balances", "Balances"], ["holidays", "Holidays"], ["export", "Export"],
];

const STATE_LABEL = {
  working: { label: "on shift", color: "#0f2a4a" },
  done: { label: "recapped", color: "#15803d" },
  off: { label: "off", color: "#0369a1" },
  not_started: { label: "no check-in", color: "#b45309" },
};

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
const OFFICE_TOKEN_KEY = "uss_payroll_office_token";

export default function PayrollAdmin() {
  const [token, setToken] = useState(() => { try { return localStorage.getItem(OFFICE_TOKEN_KEY) || ""; } catch { return ""; } });
  const [me, setMe] = useState(null);          // the signed-in person, or null
  const [tab, setTab] = useState("myday");
  const [err, setErr] = useState("");
  const [booting, setBooting] = useState(true);

  const api = useCallback(async (action, extra) => {
    const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action, ...extra }) });
    return r.json().catch(() => ({ ok: false, error: "Bad response" }));
  }, [token]);

  // Who is this session? payroll-me answers for anybody, office or not.
  useEffect(() => {
    let dead = false;
    (async () => {
      if (!token) { setBooting(false); return; }
      const r = await fetch("/.netlify/functions/payroll-me", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "me", token }),
      });
      const d = await r.json().catch(() => ({}));
      if (dead) return;
      if (d.ok) setMe(d.me);
      else { try { localStorage.removeItem(OFFICE_TOKEN_KEY); } catch { /* private mode */ } setToken(""); }
      setBooting(false);
    })();
    return () => { dead = true; };
  }, [token]);

  const signOut = () => {
    try { localStorage.removeItem(OFFICE_TOKEN_KEY); } catch { /* private mode */ }
    setToken(""); setMe(null);
  };

  if (booting && token) {
    return <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", color: MUTE, fontFamily: "system-ui, sans-serif" }}>Loading…</div>;
  }
  if (!token || !me) {
    return <OfficeSignIn onIn={(t, who) => { setToken(t); setMe(who); try { localStorage.setItem(OFFICE_TOKEN_KEY, t); } catch { /* private mode */ } }} />;
  }

  // Not office/HR — this is their own time card, right here in the box.
  if (!me.is_admin) {
    return (
      <div style={{ minHeight: "100vh", background: BG, padding: "16px 12px 60px", fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", color: INK }}>
        <div style={{ maxWidth: 760, margin: "0 auto", display: "grid", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 20, fontWeight: 900, color: NAVY }}>🕒 My Time Card</div>
            <button style={ghost} onClick={signOut}>Sign out</button>
          </div>
          <EmployeeScreens token={token} />
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
            <div style={{ fontSize: 13, color: MUTE }}>Hours, time off and the weekly sign-off for W-2 staff. Subcontractor crews are paid in the crew portal.</div>
          </div>
          <button style={ghost} onClick={signOut}>Sign out</button>
        </div>

        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 14 }}>
          {TABS.map(([k, label]) => (
            <button key={k} onClick={() => { setTab(k); setErr(""); }} style={{
              ...ghost, background: tab === k ? NAVY : "#fff", color: tab === k ? "#fff" : NAVY, borderColor: tab === k ? NAVY : LINE,
            }}>{label}</button>
          ))}
        </div>

        <Err>{err}</Err>
        {/* Your own day, right here — the office login is a payroll session too,
            so you can check in and recap without leaving the admin screen. */}
        {tab === "myday" && <EmployeeScreens token={token} />}
        {tab === "viewas" && <ViewAs token={token} api={api} onErr={setErr} />}
        {tab === "signoff" && <SignOff api={api} onErr={setErr} />}
        {tab === "daily" && <Daily api={api} onErr={setErr} />}
        {tab === "shifts" && <Shifts api={api} onErr={setErr} />}
        {tab === "people" && <People api={api} onErr={setErr} />}
        {tab === "teams" && <Teams api={api} onErr={setErr} />}
        {tab === "timeoff" && <TimeOffAll api={api} token={token} onErr={setErr} />}
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
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>SIGNED OFF</div><div style={{ fontSize: 19, fontWeight: 900, color: d.approved_count === (d.departments || []).length ? GREEN : AMBER }}>{d.approved_count}/{(d.departments || []).length}</div></div>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>HOURS WORKED</div><div style={{ fontSize: 19, fontWeight: 900 }}>{d.company.worked}</div></div>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>OVERTIME</div><div style={{ fontSize: 19, fontWeight: 900, color: d.company.overtime ? AMBER : INK }}>{d.company.overtime}</div></div>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>PAID TIME OFF</div><div style={{ fontSize: 19, fontWeight: 900 }}>{(d.company.pto + d.company.sick + d.company.holiday).toFixed(2).replace(/\.00$/, "")}</div></div>
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
            <th style={th}>Worked</th><th style={th}>OT</th><th style={th}>Week signed</th>
          </tr></thead>
          <tbody>
            {(d?.departments || []).map((r) => (
              <tr key={r.id}>
                <td style={{ ...td, fontWeight: 800 }}>{r.name}</td>
                <td style={td}>{r.manager_name || <Pill color={RED}>no manager set</Pill>}</td>
                <td style={td}>{r.headcount}</td>
                <td style={{ ...td, fontWeight: 700 }}>{r.totals.worked}h</td>
                <td style={{ ...td, color: r.totals.overtime ? AMBER : MUTE }}>{r.totals.overtime}h</td>
                <td style={td}>
                  {r.status === "approved"
                    ? <Pill color={GREEN}>✓ {r.approved_by_name || "signed"}</Pill>
                    : <Pill color={AMBER}>waiting</Pill>}
                </td>
              </tr>
            ))}
            {d && !(d.departments || []).length ? <tr><td style={{ ...td, color: MUTE }} colSpan={6}>No departments yet — add them on the Teams tab.</td></tr> : null}
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
          {["worked", "pto", "sick", "doctor", "holiday", "unpaid", "bereavement", "jury", "no_show", "other"].map((k) => <option key={k} value={k}>{k}</option>)}
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
  shift_id: "", pay_type: "hourly", standard_day_hours: 8, standard_week_hours: 40,
  hire_date: "", pto_days_per_year: 0, pto_carryover_days: 0, sick_days_per_year: 0,
  paid_holidays: true, is_manager: false, is_admin: false, active: true, notes: "",
};

function People({ api, onErr }) {
  const [rows, setRows] = useState(null);
  const [depts, setDepts] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [showInactive, setShowInactive] = useState(false);
  const [edit, setEdit] = useState(null);
  const [importing, setImporting] = useState(false);
  const [invites, setInvites] = useState(null);   // result of the last invite send

  const load = useCallback(async () => {
    const d = await api("employees", { include_inactive: showInactive });
    if (d.ok) { setRows(d.employees); setDepts(d.departments); setShifts(d.shifts || []); } else onErr(d.error || "Couldn't load the roster.");
  }, [api, showInactive, onErr]);
  useEffect(() => { load(); }, [load]);

  const [inviting, setInviting] = useState(false);
  const notSignedIn = (rows || []).filter((e) => e.active && !e.passcode_set_at).length;

  const save = async () => {
    const d = await api("employee_save", edit);
    if (!d.ok) { onErr(d.error || "Save failed."); return; }
    setEdit(null); load();
  };

  const invite = async (e) => {
    setInviting(true); setInvites(null);
    const d = await api("invite", { id: e.id });
    setInviting(false);
    if (d.ok) setInvites(d.sent); else onErr(d.error || "Couldn't send.");
  };

  if (importing) return <ImportRoster api={api} onErr={onErr} onDone={() => { setImporting(false); load(); }} />;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ fontSize: 13.5, fontWeight: 600, display: "flex", gap: 7, alignItems: "center" }}>
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> show inactive
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          {notSignedIn > 0 ? (
            <button style={ghost} disabled={inviting} onClick={async () => {
              if (!window.confirm(`Text the sign-in link to the ${notSignedIn} ${notSignedIn === 1 ? "person" : "people"} who haven't signed in yet?`)) return;
              setInviting(true); setInvites(null);
              const d = await api("invite", { missing: true });
              setInviting(false);
              if (d.ok) { setInvites(d.sent); load(); } else onErr(d.error || "Couldn't send.");
            }}>{inviting ? "Sending…" : `✉️ Invite ${notSignedIn} not signed in`}</button>
          ) : null}
          <button style={ghost} onClick={() => setImporting(true)}>⬆ Import roster</button>
          <button style={btn(NAVY)} onClick={() => setEdit({ ...BLANK_EMP })}>+ Add employee</button>
        </div>
      </div>

      {edit ? (
        <div style={{ ...card, display: "grid", gap: 11, borderColor: "#bfdbfe", background: "#f8fbff" }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>{edit.id ? `Edit ${edit.first_name} ${edit.last_name}` : "New employee"}</div>
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            <Field label="First name"><input style={fld} value={edit.first_name} onChange={(e) => setEdit({ ...edit, first_name: e.target.value })} /></Field>
            <Field label="Last name"><input style={fld} value={edit.last_name} onChange={(e) => setEdit({ ...edit, last_name: e.target.value })} /></Field>
            <Field label="Mobile (their login)" w={170}><input style={fld} type="tel" value={edit.phone || ""} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} placeholder="(813) 555-0123" /><div style={{ fontSize: 11, color: MUTE, marginTop: 3 }}>Any format — it's stored as digits.</div></Field>
            <Field label="Email (optional)" w={200}><input style={fld} type="email" value={edit.email || ""} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
          </div>
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            <Field label="Department">
              <select style={fld} value={edit.department_id || ""} onChange={(e) => setEdit({ ...edit, department_id: e.target.value })}>
                <option value="">— none —</option>
                {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Shift">
              <select style={fld} value={edit.shift_id || ""} onChange={(e) => setEdit({ ...edit, shift_id: e.target.value })}>
                <option value="">— none —</option>
                {shifts.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.start_time}–{x.end_time})</option>)}
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
            <Field label="Day hours"><input style={fld} type="number" step="0.5" value={edit.standard_day_hours} onChange={(e) => setEdit({ ...edit, standard_day_hours: e.target.value })} /></Field>
            <Field label="Week hours (OT after)"><input style={fld} type="number" step="0.5" value={edit.standard_week_hours} onChange={(e) => setEdit({ ...edit, standard_week_hours: e.target.value })} /></Field>
          </div>
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            <Field label="Vacation days / yr"><input style={fld} type="number" step="0.5" value={edit.pto_days_per_year} onChange={(e) => setEdit({ ...edit, pto_days_per_year: e.target.value })} /></Field>
            <Field label="Carried over"><input style={fld} type="number" step="0.5" value={edit.pto_carryover_days} onChange={(e) => setEdit({ ...edit, pto_carryover_days: e.target.value })} /></Field>
            <Field label="Sick days / yr"><input style={fld} type="number" step="0.5" value={edit.sick_days_per_year} onChange={(e) => setEdit({ ...edit, sick_days_per_year: e.target.value })} /></Field>
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13.5, fontWeight: 600 }}>
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

      {invites ? (
        <div style={{ ...card, display: "grid", gap: 7 }}>
          <div style={{ fontWeight: 900 }}>Invites sent</div>
          {invites.map((r, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13.5, borderBottom: `1px solid ${LINE}`, paddingBottom: 5 }}>
              <span style={{ fontWeight: 700 }}>{r.name}</span>
              <span>
                {r.sms ? <Pill color={r.sms === "delivered" ? GREEN : RED}>text: {r.sms}</Pill> : null}
                {r.email ? <span style={{ marginLeft: 6 }}><Pill color={r.email === "sent" ? GREEN : RED}>email: {r.email}</Pill></span> : null}
              </span>
            </div>
          ))}
          <div style={{ fontSize: 12, color: MUTE }}>“delivered” is the carrier's own verdict, not just an accepted send. Anything else means they did not get it — call them.</div>
          <button style={{ ...ghost, justifySelf: "start" }} onClick={() => setInvites(null)}>Dismiss</button>
        </div>
      ) : null}

      <div style={{ ...card, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
          <thead><tr>
            <th style={th}>Name</th><th style={th}>Department</th><th style={th}>Shift</th><th style={th}>Paid as</th><th style={th}>Vac/yr</th>
            <th style={th}>Role</th><th style={th}>Login</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {(rows || []).map((e) => (
              <tr key={e.id} style={{ opacity: e.active ? 1 : 0.5 }}>
                <td style={{ ...td, fontWeight: 800 }}>{e.last_name}, {e.first_name}<div style={{ fontWeight: 500, fontSize: 12, color: MUTE }}>{e.title || e.email || ""}</div></td>
                <td style={td}>{e.department_name || <Pill color={AMBER}>none</Pill>}</td>
                <td style={td}>{e.shift_name || <Pill color={AMBER}>none</Pill>}</td>
                <td style={td}>{e.pay_type}</td>
                <td style={td}>{e.pto_days_per_year}{e.pto_carryover_days ? ` +${e.pto_carryover_days}` : ""}</td>
                <td style={td}>{e.is_admin ? <Pill color={NAVY}>office</Pill> : e.is_manager ? <Pill color="#0369a1">manager</Pill> : <span style={{ color: MUTE }}>employee</span>}</td>
                <td style={td}>
                  {!e.phone ? <Pill color={RED}>no mobile</Pill>
                    : e.passcode_set_at ? <Pill color={GREEN}>set</Pill> : <Pill color={MUTE}>not set up</Pill>}
                  <div style={{ fontSize: 11.5, color: MUTE, marginTop: 2 }}>{fmtPhone(e.phone)}</div>
                </td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  <button style={{ ...ghost, padding: "6px 10px" }} onClick={() => setEdit({ ...BLANK_EMP, ...e })}>Edit</button>
                  {!e.passcode_set_at && e.active ? (
                    <button style={{ ...ghost, padding: "6px 10px", marginLeft: 5 }} disabled={inviting}
                      title="Text them the sign-in link" onClick={() => invite(e)}>Invite</button>
                  ) : null}
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
  const [open, setOpen] = useState(() => new Set());

  const toggle = (id) =>
    setOpen((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // The roster is already loaded for the manager picker, so who's on each team
  // is a grouping, not another round trip.
  const byDept = useMemo(() => {
    const m = {};
    for (const e of emps) (m[e.department_id || "__none__"] ||= []).push(e);
    for (const k of Object.keys(m)) m[k].sort((a, b) => `${a.last_name}`.localeCompare(`${b.last_name}`));
    return m;
  }, [emps]);
  const unassigned = byDept.__none__ || [];

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
        A department is what gets signed off. Whoever you name as its manager sees a <b>Team</b> tab on their own time card, and gets a reminder text on <b>Friday</b> once the week is done. Click a department to see who's on it.
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
          <thead><tr><th style={th}></th><th style={th}>Department</th><th style={th}>Signs off</th><th style={th}>People</th><th style={th}></th></tr></thead>
          <tbody>
            {(rows || []).map((r) => {
              const team = byDept[r.id] || [];
              const isOpen = open.has(r.id);
              return (
              <React.Fragment key={r.id}>
              <tr style={isOpen ? { background: "#f8fbff" } : undefined}>
                <td style={{ ...td, width: 34, paddingRight: 0 }}>
                  <button onClick={() => toggle(r.id)} aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} who is on ${r.name}`}
                    style={{ background: "none", border: "none", cursor: "pointer", color: MUTE, fontSize: 12, padding: "4px 6px", lineHeight: 1 }}>
                    {isOpen ? "▾" : "▸"}
                  </button>
                </td>
                <td style={{ ...td, fontWeight: 800, cursor: "pointer" }} onClick={() => toggle(r.id)}>{r.name}</td>
                <td style={td}>{r.manager_name || <Pill color={RED}>nobody</Pill>}</td>
                <td style={{ ...td, cursor: "pointer" }} onClick={() => toggle(r.id)}>{r.headcount}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  <button style={{ ...ghost, padding: "6px 10px" }} onClick={() => setEdit({ id: r.id, name: r.name, manager_employee_id: r.manager_employee_id || "", active: r.active })}>Edit</button>
                  <button style={{ ...ghost, padding: "6px 10px", marginLeft: 5, color: RED, borderColor: "#fecaca" }}
                    onClick={async () => { if (!window.confirm(`Delete ${r.name}?`)) return; const d = await api("department_delete", { id: r.id }); if (!d.ok) onErr(d.error); load(); }}>Delete</button>
                </td>
              </tr>
              {isOpen ? (
                <tr>
                  <td colSpan={5} style={{ padding: "0 14px 14px 40px", background: "#f8fbff", borderBottom: "1px solid #e2e8f0" }}>
                    {team.length ? (
                      <div style={{ display: "grid", gap: 5 }}>
                        {team.map((e) => (
                          <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13.5 }}>
                            <span style={{ fontWeight: 700, minWidth: 170 }}>{e.first_name} {e.last_name}</span>
                            <span style={{ color: MUTE }}>{[e.title, e.shift_name].filter(Boolean).join(" · ") || "no shift set"}</span>
                            {e.id === r.manager_employee_id ? <Pill color={NAVY}>signs off</Pill> : null}
                            {!e.passcode_set_at ? <Pill color={AMBER}>never signed in</Pill> : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ fontSize: 13.5, color: MUTE }}>
                        Nobody is in {r.name} yet — set someone's department on their People record.
                      </div>
                    )}
                  </td>
                </tr>
              ) : null}
              </React.Fragment>
            );})}
            {rows && !rows.length ? <tr><td style={{ ...td, color: MUTE }} colSpan={5}>No departments yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
      {unassigned.length ? (
        <div style={{ ...card, borderColor: "#fde68a", background: "#fffbeb" }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>
            {unassigned.length} {unassigned.length === 1 ? "person is" : "people are"} in no department
          </div>
          <div style={{ fontSize: 13, color: MUTE, marginBottom: 8 }}>
            Nobody signs off their week, so their hours never get approved. Owners and office accounts are fine here — they don't clock in.
          </div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {unassigned.map((e) => (
              <span key={e.id} style={{ fontSize: 13, background: "#fff", border: "1px solid #fde68a", borderRadius: 999, padding: "3px 10px" }}>
                {e.first_name} {e.last_name}{e.is_admin ? " · office" : ""}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── TIME OFF (company-wide) ─────────────────────────────────────────────
function TimeOffAll({ api, token, onErr }) {
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState("pending");   // what you came here for
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const d = await api("time_off", { status });
    if (d.ok) setRows(d.requests); else onErr(d.error || "Couldn't load.");
  }, [api, status, onErr]);
  useEffect(() => { load(); }, [load]);

  // Approving lives in payroll-me — the same call a manager makes. The office
  // session IS a payroll session and is_admin counts as managing anyone, so the
  // office can clear a request without working out whose team they're on.
  const decide = async (r, decision) => {
    if (decision === "denied" && !window.confirm(`Deny ${r.employee_name}'s ${r.request_type} request?`)) return;
    setBusy(r.id); onErr("");
    const res = await fetch("/.netlify/functions/payroll-me", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "decide_off", token, id: r.id, decision }),
    }).then((x) => x.json()).catch(() => ({ ok: false, error: "Network error" }));
    setBusy("");
    if (!res.ok) { onErr(res.error || "Couldn't record that."); return; }
    load();
  };
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ fontSize: 13, color: MUTE }}>
        Approving writes the days straight onto their time card — weekends and company holidays inside the range aren't counted against their allotment.
      </div>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        {[["pending", "Pending"], ["approved", "Approved"], ["denied", "Denied"], ["", "All"]].map(([k, l]) => (
          <button key={k} onClick={() => setStatus(k)} style={{ ...ghost, background: status === k ? NAVY : "#fff", color: status === k ? "#fff" : NAVY }}>{l}</button>
        ))}
      </div>
      <div style={{ ...card, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
          <thead><tr><th style={th}>Employee</th><th style={th}>Type</th><th style={th}>Dates</th><th style={th}>Days</th><th style={th}>Status</th><th style={th}>Decided by</th><th style={th}>Note</th><th style={th}></th></tr></thead>
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
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  {r.status === "pending" ? (
                    <>
                      <button style={btn(GREEN, { padding: "7px 13px", fontSize: 13 })} disabled={busy === r.id}
                        onClick={() => decide(r, "approved")}>{busy === r.id ? "…" : "Approve"}</button>
                      <button style={{ ...ghost, marginLeft: 5, color: RED, borderColor: "#fecaca" }} disabled={busy === r.id}
                        onClick={() => decide(r, "denied")}>Deny</button>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
            {rows && !rows.length ? <tr><td style={{ ...td, color: MUTE }} colSpan={8}>Nothing here.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── BALANCES (vacation + sick) ──────────────────────────────────────────
function Balances({ api, onErr }) {
  const [d, setD] = useState(null);
  const load = useCallback(async () => { const r = await api("balances"); if (r.ok) setD(r); else onErr(r.error || "Couldn't load balances."); }, [api, onErr]);
  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
          <thead><tr>
            <th style={th}>Employee</th><th style={th}>Vacation allotted</th><th style={th}>Used</th><th style={th}>Pending</th>
            <th style={th}>Left</th><th style={th}>Sick used</th>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 12.5, color: MUTE }}>Days used are counted off the time cards for {d?.year || "this year"} — a day the office keyed in counts the same as one from an approved request, and a half day off burns half a day.</div>
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
    paid_total: s.paid_total + r.paid_total,
  }), { regular: 0, overtime: 0, paid_total: 0 });

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

          </div>
          <div style={{ ...card, padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
              <thead><tr>
                <th style={th}>Employee</th><th style={th}>Dept</th><th style={th}>Reg</th><th style={th}>OT</th>
                <th style={th}>Hol</th><th style={th}>PTO</th><th style={th}>Sick</th><th style={th}>Unpaid</th><th style={th}>Paid total</th>
              </tr></thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.employee}>
                    <td style={{ ...td, fontWeight: 700 }}>{r.employee}</td>
                    <td style={td}>{r.department}</td>
                    <td style={td}>{r.regular}</td>
                    <td style={{ ...td, color: r.overtime ? AMBER : INK }}>{r.overtime}</td>
                    <td style={td}>{r.holiday}</td><td style={td}>{r.pto}</td><td style={td}>{r.sick}</td>
                    <td style={td}>{r.unpaid}</td>
                    <td style={{ ...td, fontWeight: 800 }}>{r.paid_total}</td>
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

// ── SHIFTS ──────────────────────────────────────────────────────────────
function Shifts({ api, onErr }) {
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = useCallback(async () => {
    const d = await api("shifts");
    if (d.ok) setRows(d.shifts); else onErr(d.error || "Couldn't load shifts.");
  }, [api, onErr]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const d = await api("shift_save", edit);
    if (!d.ok) { onErr(d.error || "Save failed."); return; }
    setEdit(null); load();
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, fontSize: 13.5, color: MUTE }}>
        A shift sets when someone is expected and when the two nudge texts go out. If the end time is
        <b> earlier than</b> the start (6:00p → 6:00a), it's a night shift: the whole span is filed under the day it
        <b> started</b>, so one night is one day on the time card, and the 6am recap lands on the right date.
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button style={btn(NAVY)} onClick={() => setEdit({ name: "", start_time: "07:00", end_time: "15:30", grace_minutes: 15, active: true, sort_order: (rows?.length || 0) + 1 })}>+ Add shift</button>
      </div>
      {edit ? (
        <div style={{ ...card, display: "grid", gap: 10, borderColor: "#bfdbfe", background: "#f8fbff" }}>
          <div style={{ fontWeight: 900 }}>{edit.id ? "Edit shift" : "New shift"}</div>
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            <Field label="Name" w={160}><input style={fld} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Day, Night, Swing…" /></Field>
            <Field label="Starts" w={120}><input style={fld} type="time" value={edit.start_time} onChange={(e) => setEdit({ ...edit, start_time: e.target.value })} /></Field>
            <Field label="Ends" w={120}><input style={fld} type="time" value={edit.end_time} onChange={(e) => setEdit({ ...edit, end_time: e.target.value })} /></Field>
            <Field label="Grace (min late)" w={120}><input style={fld} type="number" min="0" max="120" value={edit.grace_minutes} onChange={(e) => setEdit({ ...edit, grace_minutes: e.target.value })} /></Field>
          </div>
          {edit.end_time <= edit.start_time ? <div style={{ fontSize: 13, color: "#0369a1", fontWeight: 700 }}>🌙 Crosses midnight — this is a night shift.</div> : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button style={btn(NAVY)} onClick={save}>Save</button>
            <button style={ghost} onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
      <div style={{ ...card, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
          <thead><tr><th style={th}>Shift</th><th style={th}>Hours</th><th style={th}>Grace</th><th style={th}>People</th><th style={th}></th></tr></thead>
          <tbody>
            {(rows || []).map((r) => (
              <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}>
                <td style={{ ...td, fontWeight: 800 }}>{r.name} {r.crosses_midnight ? <Pill color="#0369a1">🌙 overnight</Pill> : null}</td>
                <td style={td}>{r.start_time} – {r.end_time}</td>
                <td style={td}>{r.grace_minutes} min</td>
                <td style={td}>{r.headcount}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  <button style={{ ...ghost, padding: "6px 10px" }} onClick={() => setEdit({ id: r.id, name: r.name, start_time: r.start_time, end_time: r.end_time, grace_minutes: r.grace_minutes, active: r.active, sort_order: r.sort_order })}>Edit</button>
                  <button style={{ ...ghost, padding: "6px 10px", marginLeft: 5, color: RED, borderColor: "#fecaca" }}
                    onClick={async () => { if (!window.confirm(`Delete the ${r.name} shift?`)) return; const d = await api("shift_delete", { id: r.id }); if (!d.ok) onErr(d.error); load(); }}>Delete</button>
                </td>
              </tr>
            ))}
            {rows && !rows.length ? <tr><td style={{ ...td, color: MUTE }} colSpan={5}>No shifts yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── DAILY: every recap for one day, company-wide ────────────────────────
function Daily({ api, onErr }) {
  const [date, setDate] = useState(todayET());
  const [d, setD] = useState(null);
  const [only, setOnly] = useState("");     // "" | done | not_started | working | off

  const load = useCallback(async () => {
    const r = await api("day_review", { work_date: date });
    if (r.ok) setD(r); else onErr(r.error || "Couldn't load that day.");
  }, [api, onErr, date]);
  useEffect(() => { load(); }, [load]);

  const rows = (d?.rows || []).filter((r) => !only || r.state === only);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="Day" w={160}><input style={fld} type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <button style={ghost} onClick={() => setDate(addDays(date, -1))}>← previous</button>
        <button style={ghost} disabled={date >= todayET()} onClick={() => setDate(addDays(date, 1))}>next →</button>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginLeft: "auto" }}>
          {[["", "Everyone"], ["done", "Recapped"], ["working", "On shift"], ["not_started", "No check-in"], ["off", "Off"]].map(([k, l]) => (
            <button key={k} onClick={() => setOnly(k)} style={{ ...ghost, background: only === k ? NAVY : "#fff", color: only === k ? "#fff" : NAVY }}>
              {l}{k && d ? ` ${d.counts[k] ?? 0}` : ""}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {rows.map((r) => {
          const st = STATE_LABEL[r.state] || STATE_LABEL.not_started;
          return (
            <div key={r.id} style={{ ...card, display: "grid", gap: 7 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div>
                  <span style={{ fontWeight: 800 }}>{r.name}</span>
                  <span style={{ color: MUTE, fontSize: 13 }}> · {r.department} · {r.shift}</span>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {r.late_minutes ? <Pill color={AMBER}>{r.late_minutes} min late</Pill> : null}
                  <Pill color={st.color}>{r.state === "off" ? (r.day_type || "off") : st.label}</Pill>
                  <span style={{ fontWeight: 800, minWidth: 44, textAlign: "right" }}>{r.hours ? `${r.hours}h` : ""}</span>
                </div>
              </div>
              {r.note ? (
                <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "8px 10px", fontSize: 12.5, whiteSpace: "pre-wrap", lineHeight: 1.4 }}>
                  {r.day_type === "worked" && r.off_hours ? <b>{Math.round(Number(r.off_hours) * 60)} min away · </b> : null}{r.note}
                </div>
              ) : null}
              {r.recap ? <div style={{ background: "#f8fafc", border: `1px solid ${LINE}`, borderRadius: 10, padding: "9px 11px", fontSize: 13.5, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{r.recap}</div> : null}
            </div>
          );
        })}
        {d && !rows.length ? <div style={{ ...card, color: MUTE }}>Nobody matches that filter for {date}.</div> : null}
      </div>
    </div>
  );
}

// ── IMPORT ROSTER ───────────────────────────────────────────────────────
// Paste straight out of the spreadsheet. Always previews first — nothing is
// written until the office reads the warnings and presses the button.
function ImportRoster({ api, onErr, onDone }) {
  const [text, setText] = useState("");
  const [p, setP] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const preview = async () => {
    setBusy(true); onErr(""); setDone(null);
    const d = await api("import_roster", { text });
    setBusy(false);
    if (!d.ok) { onErr(d.error || "Couldn't read that."); return; }
    setP(d);
  };
  const commit = async () => {
    setBusy(true); onErr("");
    const d = await api("import_roster", { text, commit: true });
    setBusy(false);
    if (!d.ok) { onErr(d.error || "Import failed."); return; }
    setDone(d);
  };

  const STATUS = {
    new: { label: "will add", color: GREEN },
    exists: { label: "already on roster", color: MUTE },
    duplicate: { label: "duplicate number", color: RED },
  };

  if (done) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ ...card, display: "grid", gap: 8 }}>
          <div style={{ fontSize: 19, fontWeight: 900, color: GREEN }}>✅ Added {done.imported} {done.imported === 1 ? "person" : "people"}</div>
          {done.departments_linked?.length ? (
            <div style={{ fontSize: 13.5 }}>
              Departments now signed off by: {done.departments_linked.map((d) => `${d.department} → ${d.manager}`).join(" · ")}
            </div>
          ) : null}
          {done.warnings?.length ? (
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: AMBER }}>
              {done.warnings.map((w, i) => <li key={i} style={{ marginBottom: 3 }}>{w}</li>)}
            </ul>
          ) : null}
          <button style={btn(NAVY)} onClick={onDone}>Back to the roster</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 900, fontSize: 17 }}>Import a roster</div>
          <button style={ghost} onClick={onDone}>Cancel</button>
        </div>
        <div style={{ fontSize: 13.5, color: MUTE }}>
          Copy the rows out of your spreadsheet and paste them here — headers and all. It reads
          <b> name</b>, <b>dept</b>, <b>who to ask</b>, <b>mobile</b>, and optionally <b>email</b> and <b>title</b>,
          in any column order. Names can be “LAST, FIRST” or “First Last”. Nothing is saved until you've seen the preview.
        </div>
        <textarea style={{ ...fld, minHeight: 180, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5, resize: "vertical" }}
          value={text} onChange={(e) => setText(e.target.value)}
          placeholder={"NAME\tDEPT\tWho to ask\tMobile\nADAMS, ANGELA\tInside\tNikki\t813-555-0123"} />
        <div style={{ display: "flex", gap: 8 }}>
          <button style={btn(NAVY)} disabled={busy || !text.trim()} onClick={preview}>{busy ? "Reading…" : "Preview"}</button>
        </div>
      </div>

      {p ? (
        <>
          <div style={{ ...card, display: "flex", gap: 18, flexWrap: "wrap" }}>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>WILL ADD</div><div style={{ fontSize: 21, fontWeight: 900, color: GREEN }}>{p.counts.new}</div></div>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>ALREADY THERE</div><div style={{ fontSize: 21, fontWeight: 900 }}>{p.counts.exists}</div></div>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>NO MOBILE YET</div><div style={{ fontSize: 21, fontWeight: 900, color: p.counts.needs_phone ? AMBER : INK }}>{p.counts.needs_phone}</div></div>
            <div><div style={{ fontSize: 11, color: MUTE, fontWeight: 800 }}>NEW DEPARTMENTS</div><div style={{ fontSize: 21, fontWeight: 900 }}>{p.counts.departments_new}</div></div>
          </div>

          <div style={{ ...card, display: "grid", gap: 7 }}>
            <div style={{ fontWeight: 900 }}>Departments &amp; who signs each one off</div>
            <div style={{ fontSize: 12.5, color: MUTE }}>Whoever the most rows name in a department signs that whole department.</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
              {p.departments.map((d) => (
                <div key={d.name} style={{ border: `1px solid ${LINE}`, borderRadius: 10, padding: "8px 11px", fontSize: 13 }}>
                  <b>{d.name}</b> → {d.manager_name || <span style={{ color: RED }}>{d.manager_first} (not on the list)</span>}
                </div>
              ))}
            </div>
          </div>

          {p.warnings?.length ? (
            <div style={{ ...card, background: "#fffbeb", borderColor: "#fde68a" }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>⚠️ Read these first ({p.warnings.length})</div>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.5 }}>
                {p.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          ) : null}

          <div style={{ ...card, padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
              <thead><tr><th style={th}>Name</th><th style={th}>Department</th><th style={th}>Mobile</th><th style={th}>Signs their week</th><th style={th}></th></tr></thead>
              <tbody>
                {p.rows.map((r, i) => {
                  const st = STATUS[r.status] || STATUS.new;
                  return (
                    <tr key={i}>
                      <td style={{ ...td, fontWeight: 700 }}>{r.last_name}, {r.first_name}</td>
                      <td style={td}>{r.department || <span style={{ color: AMBER }}>none</span>}</td>
                      <td style={td}>{r.phone || <span style={{ color: AMBER }}>none — can't sign in yet</span>}</td>
                      <td style={td}>{r.signs_off || "—"}{r.manager_overridden ? <span style={{ color: MUTE }}> (sheet said {r.manager})</span> : ""}</td>
                      <td style={td}><Pill color={st.color}>{st.label}</Pill>{r.no_phone && r.status === "new" ? <span style={{ marginLeft: 5 }}><Pill color={AMBER}>no mobile</Pill></span> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button style={btn(GREEN)} disabled={busy || !p.counts.new} onClick={commit}>
              {busy ? "Importing…" : `Import ${p.counts.new} ${p.counts.new === 1 ? "person" : "people"}`}
            </button>
            <button style={ghost} onClick={() => setP(null)}>Back to the paste box</button>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── OFFICE SIGN-IN ──────────────────────────────────────────────────────
// Same credentials as the time card: your mobile number and your own passcode.
// The API then checks the session is flagged office/HR before it answers.
function OfficeSignIn({ onIn }) {
  const [login, setLogin] = useState("");
  const [pass, setPass] = useState("");
  const [step, setStep] = useState("who");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const call = async (action, extra) => {
    const r = await fetch("/.netlify/functions/payroll-me", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    return r.json().catch(() => ({ ok: false, error: "Bad response" }));
  };

  const find = async () => {
    const v = login.trim();
    if (v.replace(/\D/g, "").length < 10 && !v.includes("@")) { setErr("Type your 10-digit mobile number."); return; }
    setBusy(true); setErr("");
    const d = await call("who", { login: v });
    setBusy(false);
    if (!d.ok || !d.found) { setErr("That number isn't on the roster."); return; }
    setName(d.name || ""); setStep(d.passcode_set ? "pass" : "create");
  };

  const go = async () => {
    if (!/^\d{4,8}$/.test(pass)) { setErr("Your passcode is 4–8 digits."); return; }
    setBusy(true); setErr("");
    const d = await call("login", { login: login.trim(), passcode: pass });
    setBusy(false);
    if (!d.ok) { setErr(d.error || "Sign-in failed."); return; }
    // Anybody may sign in here. Office/HR gets the admin tool; everyone else
    // gets their own time card in this same box.
    onIn(d.token, d.me);
  };

  return (
    // Sits near the top rather than dead-centre: this screen is embedded in a
    // tall iframe on the USSM Internal Dashboard, and a vertically centred card
    // there reads as an empty box until you scroll to it.
    <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "8vh 20px 20px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ ...card, width: 350, display: "grid", gap: 12, textAlign: "center" }}>
        <div style={{ fontSize: 30 }}>🧾</div>
        <div style={{ fontSize: 20, fontWeight: 900, color: NAVY }}>U.S. Shingle Time Card</div>
        {step === "who" ? (
          <>
            <div style={{ fontSize: 13, color: MUTE }}>Sign in with your mobile number or work email — staff and office use the same login.</div>
            <input style={{ ...fld, textAlign: "center", fontSize: 16 }} autoComplete="username"
              value={login} onChange={(e) => setLogin(e.target.value)} onKeyDown={(e) => e.key === "Enter" && find()} placeholder="(813) 555-0123  or  you@shingleusa.com" />
            <Err>{err}</Err>
            <button style={btn(NAVY)} disabled={busy} onClick={find}>{busy ? "Checking…" : "Continue"}</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 14.5, fontWeight: 700 }}>{step === "create" ? `Hi ${name} — set your passcode` : `Welcome back, ${name}`}</div>
            <input style={{ ...fld, textAlign: "center", fontSize: 20, letterSpacing: 4 }} type="password" inputMode="numeric"
              value={pass} onChange={(e) => setPass(e.target.value.replace(/\D/g, "").slice(0, 8))}
              onKeyDown={(e) => e.key === "Enter" && go()} placeholder="••••" />
            <Err>{err}</Err>
            <button style={btn(NAVY)} disabled={busy} onClick={go}>{busy ? "…" : "Sign in"}</button>
            <button style={{ ...ghost, border: "none", color: MUTE }} onClick={() => { setStep("who"); setPass(""); setErr(""); }}>Use a different number</button>
          </>
        )}
        <div style={{ fontSize: 12, color: MUTE }}>Not office? You'll land straight on your own time card.</div>
      </div>
    </div>
  );
}

// ── VIEW AS ─────────────────────────────────────────────────────────────
// Pick anybody and see the app exactly as they see it — for checking a screen
// while building this out. Read-only: the API refuses every write while an
// admin is viewing as somebody else, so looking can't clock them in.
function ViewAs({ token, api, onErr }) {
  const [people, setPeople] = useState([]);
  const [pick, setPick] = useState("");

  useEffect(() => {
    (async () => {
      const d = await api("employees");
      if (d.ok) setPeople(d.employees); else onErr(d.error || "Couldn't load the roster.");
    })();
  }, [api, onErr]);

  const chosen = people.find((p) => p.id === pick);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="See the app as" w={280}>
          <select style={fld} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Pick a person…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.last_name}, {p.first_name}
                {p.department_name ? ` · ${p.department_name}` : ""}
                {p.is_admin ? " · office" : p.is_manager ? " · manager" : ""}
              </option>
            ))}
          </select>
        </Field>
        {chosen ? (
          <div style={{ fontSize: 12.5, color: MUTE, paddingBottom: 10 }}>
            {chosen.passcode_set_at ? "Has signed in." : "Hasn't signed in yet."}
            {chosen.phone ? "" : " No mobile on file, so they can't log in."}
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: MUTE, paddingBottom: 10 }}>
            Handy for checking what a warehouse hand or a foreman actually sees before you roll it out to them.
          </div>
        )}
      </div>

      {pick ? <EmployeeScreens token={token} asEmployeeId={pick} /> : null}
    </div>
  );
}
