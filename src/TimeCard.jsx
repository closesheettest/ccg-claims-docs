// src/TimeCard.jsx
//
// EMPLOYEE TIME CARD  (/?mode=timecard)
//
// One screen for a W-2 employee's whole week: the days they worked, the days
// they were off (vacation, sick, doctor), arriving late or leaving early, the
// paid holidays coming up, what's left of their time-off allotment, and — for
// anyone who runs a department — the Monday-morning sign-off on their team's
// hours.
//
// Sign-in is their work email + a 4–8 digit passcode they set the first time.
// Everything is saved server-side (payroll-me.js) so it follows them to any
// phone; the session token is the only thing kept on the device.
//
// Tabs:  My Week  ·  Time Off  ·  Team (managers only)

import React, { useCallback, useEffect, useState } from "react";

const API = "/.netlify/functions/payroll-me";
const TOKEN_KEY = "uss_payroll_token";
const EMAIL_KEY = "uss_payroll_email";

const NAVY = "#0f2a4a", RED = "#c0392b", GREEN = "#15803d", AMBER = "#b45309";
const INK = "#16233b", MUTE = "#5b6b8c", LINE = "#e2e8f2", BG = "#f4f7fb";

// What each day type is called on screen, and the color it wears.
const DAY_TYPES = [
  { key: "worked", label: "Worked", emoji: "🔨", color: NAVY },
  { key: "pto", label: "Vacation (PTO)", emoji: "🏖️", color: "#0369a1" },
  { key: "sick", label: "Sick", emoji: "🤒", color: "#7c3aed" },
  { key: "doctor", label: "Doctor", emoji: "🩺", color: "#7c3aed" },
  { key: "comp_used", label: "Comp day", emoji: "🎟️", color: GREEN },
  { key: "bereavement", label: "Bereavement", emoji: "🕊️", color: MUTE },
  { key: "jury", label: "Jury duty", emoji: "⚖️", color: MUTE },
  { key: "unpaid", label: "Unpaid", emoji: "🚫", color: RED },
  { key: "other", label: "Other", emoji: "•", color: MUTE },
];
const DT = Object.fromEntries(DAY_TYPES.map((d) => [d.key, d]));
DT.holiday = { key: "holiday", label: "Holiday", emoji: "🎉", color: "#be185d" };
DT.no_show = { key: "no_show", label: "No show", emoji: "❗", color: RED };

// Partial-day absences you can put ON a worked day ("worked 6, doctor 2").
const PARTIAL_TYPES = [
  { key: "", label: "None" }, { key: "doctor", label: "Doctor" }, { key: "sick", label: "Sick" },
  { key: "pto", label: "Vacation" }, { key: "comp_used", label: "Comp" }, { key: "unpaid", label: "Unpaid" },
];
const REQUEST_TYPES = [
  { key: "pto", label: "Vacation (PTO)" }, { key: "sick", label: "Sick" }, { key: "doctor", label: "Doctor visit" },
  { key: "comp", label: "Comp day (from my bank)" }, { key: "unpaid", label: "Unpaid" },
  { key: "bereavement", label: "Bereavement" }, { key: "jury", label: "Jury duty" }, { key: "other", label: "Other" },
];

// ── date helpers (plain YYYY-MM-DD strings, UTC-noon anchored) ──────────
const asDate = (s) => new Date(`${s}T12:00:00Z`);
const addDays = (s, n) => { const d = asDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const todayET = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const mondayOf = (s) => { const dow = asDate(s).getUTCDay(); return addDays(s, dow === 0 ? -6 : 1 - dow); };
const pretty = (s) => { if (!s) return ""; const [, m, d] = s.split("-"); return `${+m}/${+d}`; };
const prettyLong = (s) => asDate(s).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const hhmm = (t) => { if (!t) return ""; const [h, m] = t.split(":").map(Number); const ap = h >= 12 ? "pm" : "am"; const hr = h % 12 || 12; return `${hr}:${String(m).padStart(2, "0")}${ap}`; };

// ── shared bits of chrome ───────────────────────────────────────────────
const card = { background: "#fff", border: `1px solid ${LINE}`, borderRadius: 14, padding: 14 };
const fld = { width: "100%", boxSizing: "border-box", borderRadius: 10, border: `1px solid #d1d5db`, padding: "11px 12px", fontSize: 16, background: "#fff", color: INK };
const btn = (bg, extra) => ({ background: bg, color: "#fff", border: "none", borderRadius: 10, padding: "12px 18px", fontWeight: 800, fontSize: 15, cursor: "pointer", ...extra });
const ghost = { background: "#fff", color: NAVY, border: `1.5px solid ${LINE}`, borderRadius: 10, padding: "10px 14px", fontWeight: 700, fontSize: 14, cursor: "pointer" };

function Pill({ children, color = MUTE, bg }) {
  return <span style={{ display: "inline-block", padding: "3px 9px", borderRadius: 999, fontSize: 11.5, fontWeight: 800, color, background: bg || `${color}18`, whiteSpace: "nowrap" }}>{children}</span>;
}
function Stat({ label, value, sub, color = INK }) {
  return (
    <div style={{ ...card, padding: 12, flex: "1 1 96px", minWidth: 96 }}>
      <div style={{ fontSize: 11, color: MUTE, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 900, color, lineHeight: 1.25 }}>{value}</div>
      {sub ? <div style={{ fontSize: 11.5, color: MUTE }}>{sub}</div> : null}
    </div>
  );
}
function Err({ children }) {
  if (!children) return null;
  return <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", borderRadius: 10, padding: "10px 12px", fontSize: 14, fontWeight: 600 }}>{children}</div>;
}

// ════════════════════════════════════════════════════════════════════════
export default function TimeCard() {
  const [token, setToken] = useState(() => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } });
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState("week");
  const [booting, setBooting] = useState(true);
  const [err, setErr] = useState("");

  const api = useCallback(async (action, extra) => {
    const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, token, ...extra }) });
    return r.json().catch(() => ({ ok: false, error: "Bad response" }));
  }, [token]);

  useEffect(() => {
    let dead = false;
    (async () => {
      if (!token) { setBooting(false); return; }
      const d = await api("me");
      if (dead) return;
      if (d.ok) setMe(d.me);
      else { try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } setToken(""); }
      setBooting(false);
    })();
    return () => { dead = true; };
  }, [token, api]);

  const signOut = async () => {
    try { await api("logout"); } catch { /* best effort */ }
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
    setToken(""); setMe(null);
  };

  if (booting) return <Shell><div style={{ textAlign: "center", color: MUTE, padding: 40 }}>Loading…</div></Shell>;
  if (!token || !me) return <SignIn onIn={(t, m) => { setToken(t); setMe(m); try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ } }} />;

  const isMgr = me.is_manager || me.is_admin;
  const tabs = [["week", "My Week"], ["off", "Time Off"]].concat(isMgr ? [["team", "Team"]] : []);

  return (
    <Shell>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 21, fontWeight: 900, color: NAVY, lineHeight: 1.15 }}>{me.first_name} {me.last_name}</div>
          <div style={{ fontSize: 12.5, color: MUTE }}>
            {[me.title, me.department?.name].filter(Boolean).join(" · ") || "Time card"}
            {me.pay_type === "salary" ? " · salaried" : ""}
          </div>
        </div>
        <button onClick={signOut} style={{ ...ghost, padding: "8px 12px", fontSize: 13 }}>Sign out</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            ...ghost, padding: "9px 16px",
            background: tab === k ? NAVY : "#fff", color: tab === k ? "#fff" : NAVY,
            borderColor: tab === k ? NAVY : LINE,
          }}>{label}</button>
        ))}
      </div>

      <Err>{err}</Err>
      {tab === "week" && <MyWeek me={me} api={api} onErr={setErr} onChanged={async () => { const d = await api("me"); if (d.ok) setMe(d.me); }} />}
      {tab === "off" && <TimeOff me={me} api={api} onErr={setErr} onChanged={async () => { const d = await api("me"); if (d.ok) setMe(d.me); }} />}
      {tab === "team" && <Team me={me} api={api} onErr={setErr} />}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: BG, padding: "16px 12px 60px", fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", color: INK }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>{children}</div>
    </div>
  );
}

// ── Sign in / first-time passcode ───────────────────────────────────────
function SignIn({ onIn }) {
  const [email, setEmail] = useState(() => { try { return localStorage.getItem(EMAIL_KEY) || ""; } catch { return ""; } });
  const [step, setStep] = useState("email");     // email → passcode | create
  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const call = async (action, extra) => {
    const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
    return r.json().catch(() => ({ ok: false, error: "Bad response" }));
  };

  const findMe = async () => {
    const e = email.trim().toLowerCase();
    if (!e) { setErr("Type your work email."); return; }
    setBusy(true); setErr("");
    const d = await call("who", { email: e });
    setBusy(false);
    if (!d.ok || !d.found) { setErr("That email isn't on the payroll roster yet — check with the office."); return; }
    setName(d.name || ""); setStep(d.passcode_set ? "passcode" : "create");
  };

  const go = async () => {
    if (step === "create" && pass !== confirm) { setErr("The two passcodes don't match."); return; }
    if (!/^\d{4,8}$/.test(pass)) { setErr("Your passcode is 4–8 digits."); return; }
    setBusy(true); setErr("");
    const d = await call("login", { email: email.trim().toLowerCase(), passcode: pass });
    setBusy(false);
    if (!d.ok) { setErr(d.error || "Sign-in failed."); return; }
    try { localStorage.setItem(EMAIL_KEY, email.trim().toLowerCase()); } catch { /* private mode */ }
    onIn(d.token, d.me);
  };

  return (
    <Shell>
      <div style={{ maxWidth: 420, margin: "8vh auto 0" }}>
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <div style={{ fontSize: 30 }}>🕒</div>
          <div style={{ fontSize: 23, fontWeight: 900, color: NAVY }}>My Time Card</div>
          <div style={{ fontSize: 13.5, color: MUTE }}>U.S. Shingle &amp; Metal</div>
        </div>
        <div style={{ ...card, display: "grid", gap: 12 }}>
          {step === "email" ? (
            <>
              <label style={{ fontSize: 13, fontWeight: 700, color: MUTE }}>Work email</label>
              <input style={fld} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && findMe()} placeholder="you@shingleusa.com" />
              <Err>{err}</Err>
              <button style={btn(NAVY)} disabled={busy} onClick={findMe}>{busy ? "Checking…" : "Continue"}</button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 15, fontWeight: 800 }}>
                {step === "create" ? `Hi ${name || "there"} — set your passcode` : `Welcome back, ${name || ""}`}
              </div>
              {step === "create" ? <div style={{ fontSize: 13, color: MUTE }}>Pick 4–8 digits you'll remember. You'll use it every time you open your time card.</div> : null}
              <input style={fld} type="password" inputMode="numeric" autoComplete={step === "create" ? "new-password" : "current-password"}
                value={pass} onChange={(e) => setPass(e.target.value.replace(/\D/g, "").slice(0, 8))}
                onKeyDown={(e) => e.key === "Enter" && step !== "create" && go()} placeholder="Passcode" />
              {step === "create" ? (
                <input style={fld} type="password" inputMode="numeric" value={confirm}
                  onChange={(e) => setConfirm(e.target.value.replace(/\D/g, "").slice(0, 8))}
                  onKeyDown={(e) => e.key === "Enter" && go()} placeholder="Confirm passcode" />
              ) : null}
              <Err>{err}</Err>
              <button style={btn(NAVY)} disabled={busy} onClick={go}>{busy ? "…" : step === "create" ? "Create & sign in" : "Sign in"}</button>
              <button style={{ ...ghost, border: "none", color: MUTE }} onClick={() => { setStep("email"); setPass(""); setConfirm(""); setErr(""); }}>Use a different email</button>
            </>
          )}
        </div>
        <div style={{ textAlign: "center", fontSize: 12, color: MUTE, marginTop: 14 }}>
          Forgot your passcode? The office can reset it for you.
        </div>
      </div>
    </Shell>
  );
}

// ── MY WEEK ─────────────────────────────────────────────────────────────
function MyWeek({ me, api, onErr, onChanged }) {
  const [ws, setWs] = useState(() => mondayOf(todayET()));
  const [data, setData] = useState(null);
  const [open, setOpen] = useState("");        // which day is expanded
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (week) => {
    setBusy(true);
    const d = await api("week", { week_start: week });
    setBusy(false);
    if (d.ok) setData(d); else onErr(d.error || "Couldn't load your week.");
  }, [api, onErr]);

  useEffect(() => { load(ws); }, [ws, load]);

  const save = async (payload) => {
    onErr("");
    const d = await api("save_day", payload);
    if (!d.ok) { onErr(d.error || "Couldn't save that day."); return false; }
    await load(ws);
    onChanged();
    return true;
  };

  const submitWeek = async () => {
    const d = await api("submit_week", { week_start: ws });
    if (!d.ok) { onErr(d.error || "Couldn't submit."); return; }
    load(ws);
  };

  const t = data?.totals;
  const thisWeek = mondayOf(todayET());
  const isLocked = !!data?.locked;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* week navigator */}
      <div style={{ ...card, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: 10 }}>
        <button style={{ ...ghost, padding: "8px 12px" }} onClick={() => setWs(addDays(ws, -7))}>←</button>
        <div style={{ textAlign: "center", lineHeight: 1.2 }}>
          <div style={{ fontWeight: 900, fontSize: 15 }}>{pretty(ws)} – {pretty(addDays(ws, 6))}</div>
          <div style={{ fontSize: 11.5, color: MUTE }}>
            {ws === thisWeek ? "This week" : ws === addDays(thisWeek, -7) ? "Last week" : asDate(ws).toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric" })}
          </div>
        </div>
        <button style={{ ...ghost, padding: "8px 12px" }} disabled={ws >= thisWeek} onClick={() => setWs(addDays(ws, 7))}>→</button>
      </div>

      {isLocked ? (
        <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", borderRadius: 12, padding: "10px 12px", fontSize: 13.5, fontWeight: 700 }}>
          🔒 Signed off{data.approval?.approved_by_name ? ` by ${data.approval.approved_by_name}` : ""} — this week is closed. Ask the office if something needs fixing.
        </div>
      ) : null}

      {/* totals */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Stat label="Worked" value={`${t?.worked ?? 0}h`} sub={t?.overtime ? `${t.overtime}h OT` : "hours"} />
        <Stat label="Paid time off" value={`${((t?.pto || 0) + (t?.sick || 0) + (t?.comp_used || 0)).toFixed(2).replace(/\.00$/, "")}h`} sub="PTO · sick · comp" color="#0369a1" />
        <Stat label="Holiday" value={`${t?.holiday ?? 0}h`} color="#be185d" />
        <Stat label="Late / early" value={`${(t?.late_minutes || 0) + (t?.left_early_minutes || 0)}m`} sub={t?.late_minutes ? `${t.late_minutes}m late` : "on time"} color={(t?.late_minutes || t?.left_early_minutes) ? AMBER : INK} />
      </div>

      {/* the seven days */}
      {(data?.days || []).map((d) => (
        <DayCard key={d.work_date} day={d} me={me} locked={isLocked} busy={busy}
          expanded={open === d.work_date} onToggle={() => setOpen(open === d.work_date ? "" : d.work_date)}
          onSave={save} />
      ))}

      {/* week done */}
      {!isLocked ? (
        <div style={{ ...card, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 13.5, color: MUTE, flex: "1 1 200px" }}>
            {data?.submitted_at
              ? <>✅ You marked this week done — your manager signs off Monday.</>
              : <>When your week is filled in, mark it done so your manager can sign off Monday morning.</>}
          </div>
          <button style={btn(data?.submitted_at ? MUTE : GREEN)} onClick={submitWeek}>
            {data?.submitted_at ? "Mark done again" : "My week is done"}
          </button>
        </div>
      ) : null}

      {/* holidays */}
      {me.holidays?.length ? (
        <div style={card}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>🎉 Company holidays</div>
          <div style={{ display: "grid", gap: 6 }}>
            {me.holidays.slice(0, 8).map((h) => (
              <div key={h.holiday_date} style={{ display: "flex", justifyContent: "space-between", fontSize: 13.5, color: h.holiday_date < todayET() ? MUTE : INK }}>
                <span>{h.name}</span>
                <span style={{ fontWeight: 700 }}>{prettyLong(h.holiday_date)}{h.paid ? "" : " (unpaid)"}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// One day: a summary line that expands into the editor.
function DayCard({ day, me, locked, expanded, onSave, onToggle }) {
  const e = day.entry;
  const hol = day.holiday;
  const isWeekend = day.weekday === "Saturday" || day.weekday === "Sunday";
  const [f, setF] = useState(() => fromEntry(e, hol, me));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setF(fromEntry(e, hol, me)); }, [e, hol, me]);

  const type = DT[e?.day_type] || null;
  const computed = f.day_type === "worked" && f.time_in && f.time_out
    ? Math.max(0, (mins(f.time_out) - mins(f.time_in) - (Number(f.lunch_minutes) || 0)) / 60)
    : null;

  const summary = !e
    ? (hol ? `${hol.name}` : isWeekend ? "—" : "Not filled in")
    : e.day_type === "worked"
      ? `${e.hours}h${e.time_in && e.time_out ? ` · ${hhmm(e.time_in)}–${hhmm(e.time_out)}` : ""}${e.off_type ? ` · ${e.off_hours}h ${DT[e.off_type]?.label || e.off_type}` : ""}`
      : `${type?.label || e.day_type}${e.off_hours ? ` · ${e.off_hours}h` : ""}`;

  const save = async () => {
    setSaving(true);
    await onSave({
      work_date: day.work_date, day_type: f.day_type,
      time_in: f.time_in, time_out: f.time_out, lunch_minutes: Number(f.lunch_minutes) || 0,
      hours: Number(f.hours) || 0, off_type: f.off_type || null, off_hours: Number(f.off_hours) || 0,
      late_minutes: Number(f.late_minutes) || 0, left_early_minutes: Number(f.left_early_minutes) || 0,
      note: f.note,
    });
    setSaving(false);
    onToggle();
  };
  const clear = async () => { setSaving(true); await onSave({ work_date: day.work_date, delete: true }); setSaving(false); onToggle(); };

  return (
    <div style={{ ...card, padding: 0, overflow: "hidden", opacity: isWeekend && !e ? 0.75 : 1 }}>
      <button onClick={onToggle} style={{ width: "100%", textAlign: "left", background: "none", border: "none", padding: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 46 }}>
          <div style={{ fontSize: 12, color: MUTE, fontWeight: 800 }}>{day.weekday.slice(0, 3).toUpperCase()}</div>
          <div style={{ fontSize: 17, fontWeight: 900, color: NAVY }}>{pretty(day.work_date)}</div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {hol ? <Pill color="#be185d">🎉 {hol.name}</Pill> : null}
            {e && e.day_type !== "worked" ? <Pill color={type?.color || MUTE}>{type?.emoji} {type?.label}</Pill> : null}
            {e?.late_minutes ? <Pill color={AMBER}>{e.late_minutes}m late</Pill> : null}
            {e?.left_early_minutes ? <Pill color={AMBER}>left {e.left_early_minutes}m early</Pill> : null}
            {e?.locked ? <Pill color={GREEN}>🔒</Pill> : null}
          </div>
          <div style={{ fontSize: 13.5, color: e ? INK : MUTE, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {summary}{e?.note ? ` · ${e.note}` : ""}
          </div>
        </div>
        <div style={{ color: MUTE, fontSize: 18 }}>{expanded ? "▴" : "▾"}</div>
      </button>

      {expanded ? (
        <div style={{ borderTop: `1px solid ${LINE}`, padding: 13, display: "grid", gap: 11, background: "#fbfcfe" }}>
          {locked ? (
            <div style={{ fontSize: 13, color: MUTE }}>🔒 This week is signed off — the office can still change it for you.</div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {DAY_TYPES.map((d) => (
                  <button key={d.key} onClick={() => setF((s) => ({ ...s, day_type: d.key }))} style={{
                    ...ghost, padding: "7px 11px", fontSize: 13,
                    background: f.day_type === d.key ? d.color : "#fff",
                    color: f.day_type === d.key ? "#fff" : INK,
                    borderColor: f.day_type === d.key ? d.color : LINE,
                  }}>{d.emoji} {d.label}</button>
                ))}
              </div>

              {f.day_type === "worked" ? (
                <>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Field label="In"><input style={fld} type="time" value={f.time_in} onChange={(v) => setF((s) => ({ ...s, time_in: v.target.value }))} /></Field>
                    <Field label="Out"><input style={fld} type="time" value={f.time_out} onChange={(v) => setF((s) => ({ ...s, time_out: v.target.value }))} /></Field>
                    <Field label="Lunch (min)"><input style={fld} type="number" min="0" max="240" value={f.lunch_minutes} onChange={(v) => setF((s) => ({ ...s, lunch_minutes: v.target.value }))} /></Field>
                  </div>
                  <div style={{ fontSize: 13, color: MUTE }}>
                    {computed != null
                      ? <>Hours worked: <b style={{ color: INK }}>{computed.toFixed(2).replace(/\.00$/, "")}</b> (from your in/out times)</>
                      : <>No clock times? Type the hours instead:</>}
                  </div>
                  {computed == null ? (
                    <Field label="Hours worked"><input style={fld} type="number" step="0.25" min="0" max="24" value={f.hours} onChange={(v) => setF((s) => ({ ...s, hours: v.target.value }))} /></Field>
                  ) : null}

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                    <Field label="Part of the day off?">
                      <select style={fld} value={f.off_type} onChange={(v) => setF((s) => ({ ...s, off_type: v.target.value, off_hours: v.target.value ? (s.off_hours || 2) : 0 }))}>
                        {PARTIAL_TYPES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                      </select>
                    </Field>
                    {f.off_type ? <Field label="Hours"><input style={fld} type="number" step="0.25" min="0" max="12" value={f.off_hours} onChange={(v) => setF((s) => ({ ...s, off_hours: v.target.value }))} /></Field> : null}
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Field label="Arrived late (min)"><input style={fld} type="number" min="0" max="600" value={f.late_minutes} onChange={(v) => setF((s) => ({ ...s, late_minutes: v.target.value }))} /></Field>
                    <Field label="Left early (min)"><input style={fld} type="number" min="0" max="600" value={f.left_early_minutes} onChange={(v) => setF((s) => ({ ...s, left_early_minutes: v.target.value }))} /></Field>
                  </div>
                </>
              ) : (
                <Field label="Hours off">
                  <input style={fld} type="number" step="0.25" min="0" max="24" value={f.off_hours}
                    onChange={(v) => setF((s) => ({ ...s, off_hours: v.target.value }))} />
                </Field>
              )}

              <Field label="Note (optional)">
                <input style={fld} value={f.note} maxLength={200} placeholder="Anything your manager should know"
                  onChange={(v) => setF((s) => ({ ...s, note: v.target.value }))} />
              </Field>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button style={btn(NAVY, { flex: 1 })} disabled={saving} onClick={save}>{saving ? "Saving…" : "Save this day"}</button>
                {e ? <button style={{ ...ghost, color: RED, borderColor: "#fecaca" }} disabled={saving} onClick={clear}>Clear</button> : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ flex: "1 1 130px", minWidth: 110, display: "block" }}>
      <div style={{ fontSize: 11.5, fontWeight: 800, color: MUTE, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      {children}
    </label>
  );
}
const mins = (t) => { const [h, m] = String(t || "").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
function fromEntry(e, hol, me) {
  if (e) return {
    day_type: e.day_type || "worked", time_in: e.time_in || "", time_out: e.time_out || "",
    lunch_minutes: e.lunch_minutes ?? 0, hours: e.hours ?? 0, off_type: e.off_type || "", off_hours: e.off_hours ?? 0,
    late_minutes: e.late_minutes ?? 0, left_early_minutes: e.left_early_minutes ?? 0, note: e.note || "",
  };
  return {
    day_type: "worked", time_in: "", time_out: "", lunch_minutes: 30, hours: "",
    off_type: "", off_hours: 0, late_minutes: 0, left_early_minutes: 0,
    note: hol ? hol.name : "", _dayHrs: me?.standard_day_hours || 8,
  };
}

// ── TIME OFF ────────────────────────────────────────────────────────────
function TimeOff({ me, api, onErr, onChanged }) {
  const [rows, setRows] = useState(null);
  const [f, setF] = useState({ request_type: "pto", start_date: todayET(), end_date: todayET(), partial: false, hours_per_day: 4, note: "" });
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState("");

  const load = useCallback(async () => {
    const d = await api("my_time_off");
    if (d.ok) setRows(d.requests); else onErr(d.error || "Couldn't load your requests.");
  }, [api, onErr]);
  useEffect(() => { load(); }, [load]);

  const b = me.balances || {};
  const submit = async () => {
    setBusy(true); onErr(""); setSent("");
    const d = await api("request_off", f);
    setBusy(false);
    if (!d.ok) { onErr(d.error || "Couldn't send that request."); return; }
    setSent(`Sent to ${me.department?.name ? "your manager" : "the office"} — ${d.request.total_days} day${d.request.total_days === 1 ? "" : "s"}.`);
    setF((s) => ({ ...s, note: "" }));
    load(); onChanged();
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Stat label="Vacation left" value={b.pto?.remaining ?? 0} sub={`of ${b.pto?.allotted ?? 0} days${b.pto?.pending ? ` · ${b.pto.pending} pending` : ""}`} color="#0369a1" />
        <Stat label="Sick days used" value={b.sick?.used ?? 0} sub={b.sick?.allotted ? `of ${b.sick.allotted}` : "no set limit"} color="#7c3aed" />
        {b.comp?.eligible ? <Stat label="Comp days banked" value={b.comp?.available ?? 0} sub="extra days worked" color={GREEN} /> : null}
      </div>

      <div style={{ ...card, display: "grid", gap: 11 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Request time off</div>
        <Field label="What for">
          <select style={fld} value={f.request_type} onChange={(e) => setF((s) => ({ ...s, request_type: e.target.value }))}>
            {REQUEST_TYPES.filter((r) => r.key !== "comp" || b.comp?.eligible).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </Field>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Field label="From"><input style={fld} type="date" value={f.start_date} onChange={(e) => setF((s) => ({ ...s, start_date: e.target.value, end_date: s.end_date < e.target.value ? e.target.value : s.end_date }))} /></Field>
          <Field label="Through"><input style={fld} type="date" value={f.end_date} min={f.start_date} onChange={(e) => setF((s) => ({ ...s, end_date: e.target.value }))} /></Field>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600 }}>
          <input type="checkbox" checked={f.partial} onChange={(e) => setF((s) => ({ ...s, partial: e.target.checked }))} style={{ width: 18, height: 18 }} />
          Part of the day only (a doctor visit, leaving early)
        </label>
        {f.partial ? <Field label="Hours off each day"><input style={fld} type="number" step="0.5" min="0.5" max="12" value={f.hours_per_day} onChange={(e) => setF((s) => ({ ...s, hours_per_day: e.target.value }))} /></Field> : null}
        <Field label="Note for your manager"><input style={fld} value={f.note} maxLength={200} onChange={(e) => setF((s) => ({ ...s, note: e.target.value }))} placeholder="Optional" /></Field>
        {sent ? <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", borderRadius: 10, padding: "9px 12px", fontSize: 13.5, fontWeight: 700 }}>{sent}</div> : null}
        <button style={btn(NAVY)} disabled={busy} onClick={submit}>{busy ? "Sending…" : "Send request"}</button>
        <div style={{ fontSize: 12, color: MUTE }}>Weekends and company holidays inside the range aren't counted against your days.</div>
      </div>

      <div style={card}>
        <div style={{ fontWeight: 900, marginBottom: 10 }}>My requests</div>
        {rows === null ? <div style={{ color: MUTE }}>Loading…</div>
          : !rows.length ? <div style={{ color: MUTE, fontSize: 14 }}>Nothing requested yet.</div>
            : (
              <div style={{ display: "grid", gap: 9 }}>
                {rows.map((r) => (
                  <div key={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", borderBottom: `1px solid ${LINE}`, paddingBottom: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: 14 }}>
                        {REQUEST_TYPES.find((t) => t.key === r.request_type)?.label || r.request_type}
                        <span style={{ color: MUTE, fontWeight: 600 }}> · {r.total_days} day{r.total_days === 1 ? "" : "s"}</span>
                      </div>
                      <div style={{ fontSize: 12.5, color: MUTE }}>
                        {pretty(r.start_date)}{r.end_date !== r.start_date ? `–${pretty(r.end_date)}` : ""}
                        {r.note ? ` · ${r.note}` : ""}
                        {r.decision_note ? ` · "${r.decision_note}"` : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <Pill color={r.status === "approved" ? GREEN : r.status === "denied" ? RED : r.status === "cancelled" ? MUTE : AMBER}>
                        {r.status}
                      </Pill>
                      {r.status === "pending" ? (
                        <button style={{ ...ghost, padding: "5px 9px", fontSize: 12 }} onClick={async () => { await api("cancel_off", { id: r.id }); load(); onChanged(); }}>Cancel</button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
      </div>
    </div>
  );
}

// ── TEAM (department manager sign-off) ──────────────────────────────────
function Team({ me, api, onErr }) {
  const [ws, setWs] = useState(() => addDays(mondayOf(todayET()), -7));   // default: the week that just closed
  const [data, setData] = useState(null);
  const [queue, setQueue] = useState([]);
  const [openEmp, setOpenEmp] = useState("");
  const [sign, setSign] = useState(`${me.first_name} ${me.last_name}`.trim());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (week) => {
    setBusy(true);
    const [d, q] = await Promise.all([api("team_week", { week_start: week }), api("off_queue")]);
    setBusy(false);
    if (d.ok) setData(d); else onErr(d.error || "Couldn't load your team.");
    if (q.ok) setQueue(q.requests || []);
  }, [api, onErr]);
  useEffect(() => { load(ws); }, [ws, load]);

  const approve = async () => {
    if (!sign.trim()) { onErr("Type your name to sign off."); return; }
    setBusy(true); onErr("");
    const d = await api("approve_week", { week_start: ws, sign_name: sign.trim(), note });
    setBusy(false);
    if (!d.ok) { onErr(d.error || "Sign-off failed."); return; }
    setNote(""); load(ws);
  };

  const decide = async (id, decision) => {
    const d = await api("decide_off", { id, decision });
    if (!d.ok) { onErr(d.error || "Couldn't record that."); return; }
    load(ws);
  };

  const thisWeek = mondayOf(todayET());
  const allSigned = (data?.departments || []).every((d) => d.approval?.status === "approved");

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: 10 }}>
        <button style={{ ...ghost, padding: "8px 12px" }} onClick={() => setWs(addDays(ws, -7))}>←</button>
        <div style={{ textAlign: "center", lineHeight: 1.2 }}>
          <div style={{ fontWeight: 900, fontSize: 15 }}>{pretty(ws)} – {pretty(addDays(ws, 6))}</div>
          <div style={{ fontSize: 11.5, color: MUTE }}>{ws === addDays(thisWeek, -7) ? "Last week — sign this off" : ws === thisWeek ? "This week (still running)" : "Past week"}</div>
        </div>
        <button style={{ ...ghost, padding: "8px 12px" }} disabled={ws >= thisWeek} onClick={() => setWs(addDays(ws, 7))}>→</button>
      </div>

      {queue.length ? (
        <div style={{ ...card, borderColor: "#fde68a", background: "#fffbeb" }}>
          <div style={{ fontWeight: 900, marginBottom: 9 }}>⏳ Time-off requests waiting on you ({queue.length})</div>
          <div style={{ display: "grid", gap: 9 }}>
            {queue.map((r) => (
              <div key={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ minWidth: 0, flex: "1 1 180px" }}>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>{r.employee?.name || "—"} · {REQUEST_TYPES.find((t) => t.key === r.request_type)?.label || r.request_type}</div>
                  <div style={{ fontSize: 12.5, color: MUTE }}>
                    {pretty(r.start_date)}{r.end_date !== r.start_date ? `–${pretty(r.end_date)}` : ""} · {r.total_days} day{r.total_days === 1 ? "" : "s"}{r.note ? ` · ${r.note}` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button style={btn(GREEN, { padding: "8px 14px", fontSize: 13 })} onClick={() => decide(r.id, "approved")}>Approve</button>
                  <button style={{ ...ghost, color: RED, borderColor: "#fecaca" }} onClick={() => decide(r.id, "denied")}>Deny</button>
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: MUTE, marginTop: 8 }}>Approving writes those days straight onto their time card.</div>
        </div>
      ) : null}

      {(data?.departments || []).map((dep) => (
        <div key={dep.department.id} style={{ display: "grid", gap: 10 }}>
          <div style={{ ...card, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 17, color: NAVY }}>{dep.department.name}</div>
              <div style={{ fontSize: 12.5, color: MUTE }}>
                {dep.members.length} on the team · {dep.members.filter((m) => m.submitted_at).length} marked done
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 21, fontWeight: 900 }}>{dep.totals.worked}h</div>
              <div style={{ fontSize: 12, color: dep.totals.overtime ? AMBER : MUTE }}>{dep.totals.overtime ? `${dep.totals.overtime}h OT` : "no OT"}</div>
            </div>
          </div>

          {dep.members.map((m) => (
            <TeamMember key={m.employee.id} m={m} open={openEmp === m.employee.id}
              onToggle={() => setOpenEmp(openEmp === m.employee.id ? "" : m.employee.id)}
              locked={dep.approval?.status === "approved"}
              onSave={async (payload) => {
                const d = await api("team_save_day", { employee_id: m.employee.id, ...payload });
                if (!d.ok) { onErr(d.error || "Couldn't save."); return false; }
                load(ws); return true;
              }} />
          ))}

          {dep.approval?.status === "approved" ? (
            <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", borderRadius: 12, padding: "12px 14px", fontWeight: 700, fontSize: 14 }}>
              ✅ Signed off by {dep.approval.approved_by_name} · {new Date(dep.approval.approved_at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              {dep.approval.note ? <div style={{ fontWeight: 500, marginTop: 4 }}>{dep.approval.note}</div> : null}
            </div>
          ) : (
            <div style={{ ...card, display: "grid", gap: 10, borderColor: "#bfdbfe", background: "#f8fbff" }}>
              <div style={{ fontWeight: 900, fontSize: 15 }}>Sign off {dep.department.name} — week of {pretty(ws)}</div>
              <div style={{ fontSize: 13, color: MUTE }}>
                Signing locks these hours so payroll can run them. Fix anything that looks wrong first — tap a name to edit their days.
                {dep.members.some((m) => m.flags.some((f) => f.kind === "missing")) ? " Some days are still blank." : ""}
              </div>
              <input style={fld} value={sign} onChange={(e) => setSign(e.target.value)} placeholder="Type your name to sign" />
              <input style={fld} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
              <button style={btn(GREEN)} disabled={busy} onClick={approve}>{busy ? "…" : `✍️ Sign off ${dep.members.length} employee${dep.members.length === 1 ? "" : "s"}`}</button>
            </div>
          )}
        </div>
      ))}

      {data && !data.departments.length ? (
        <div style={{ ...card, color: MUTE }}>You aren't set as the manager of a department yet — the office assigns that on the Payroll screen.</div>
      ) : null}
      {allSigned && data?.departments?.length ? <div style={{ textAlign: "center", color: MUTE, fontSize: 13 }}>Everything for this week is signed off. 👍</div> : null}
    </div>
  );
}

function TeamMember({ m, open, onToggle, onSave, locked }) {
  const [editing, setEditing] = useState("");
  return (
    <div style={{ ...card, padding: 0, overflow: "hidden" }}>
      <button onClick={onToggle} style={{ width: "100%", textAlign: "left", background: "none", border: "none", padding: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 900, fontSize: 15 }}>{m.employee.name}</div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 3 }}>
            {m.submitted_at ? <Pill color={GREEN}>done</Pill> : <Pill color={AMBER}>not marked done</Pill>}
            {m.flags.map((f, i) => <Pill key={i} color={f.kind === "ot" ? AMBER : f.kind === "missing" ? RED : MUTE}>{f.label}</Pill>)}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 18, fontWeight: 900 }}>{m.totals.worked}h</div>
          <div style={{ fontSize: 11.5, color: MUTE }}>{m.totals.pto || m.totals.sick || m.totals.holiday ? `+${(m.totals.pto + m.totals.sick + m.totals.holiday).toFixed(2).replace(/\.00$/, "")}h paid off` : "worked"}</div>
        </div>
        <div style={{ color: MUTE, fontSize: 18 }}>{open ? "▴" : "▾"}</div>
      </button>

      {open ? (
        <div style={{ borderTop: `1px solid ${LINE}`, background: "#fbfcfe" }}>
          {m.days.map((d) => {
            const e = d.entry;
            const t = DT[e?.day_type];
            return (
              <div key={d.work_date} style={{ borderBottom: `1px solid ${LINE}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 13px" }}>
                  <div style={{ width: 62, fontSize: 12.5, fontWeight: 800, color: MUTE }}>{d.weekday.slice(0, 3)} {pretty(d.work_date)}</div>
                  <div style={{ flex: 1, fontSize: 13.5, color: e ? INK : MUTE }}>
                    {!e ? "—" : e.day_type === "worked"
                      ? `${e.hours}h${e.time_in && e.time_out ? ` (${hhmm(e.time_in)}–${hhmm(e.time_out)})` : ""}${e.off_type ? ` +${e.off_hours}h ${DT[e.off_type]?.label || e.off_type}` : ""}`
                      : `${t?.emoji || ""} ${t?.label || e.day_type}`}
                    {e?.note ? <span style={{ color: MUTE }}> · {e.note}</span> : null}
                  </div>
                  {!locked ? (
                    <button style={{ ...ghost, padding: "5px 10px", fontSize: 12 }} onClick={() => setEditing(editing === d.work_date ? "" : d.work_date)}>
                      {editing === d.work_date ? "Close" : "Edit"}
                    </button>
                  ) : null}
                </div>
                {editing === d.work_date ? (
                  <QuickEdit day={d} onSave={async (p) => { const ok = await onSave(p); if (ok) setEditing(""); }} />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// The manager's compact editor — enough to fix a day without leaving the list.
function QuickEdit({ day, onSave }) {
  const e = day.entry;
  const [f, setF] = useState({
    day_type: e?.day_type || "worked", hours: e?.hours ?? "", time_in: e?.time_in || "", time_out: e?.time_out || "",
    lunch_minutes: e?.lunch_minutes ?? 30, note: e?.note || "",
  });
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ padding: "0 13px 13px", display: "grid", gap: 9 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {DAY_TYPES.concat([DT.holiday, DT.no_show]).map((d) => (
          <button key={d.key} onClick={() => setF((s) => ({ ...s, day_type: d.key }))} style={{
            ...ghost, padding: "6px 10px", fontSize: 12.5,
            background: f.day_type === d.key ? d.color : "#fff", color: f.day_type === d.key ? "#fff" : INK,
            borderColor: f.day_type === d.key ? d.color : LINE,
          }}>{d.label}</button>
        ))}
      </div>
      {f.day_type === "worked" ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Field label="In"><input style={fld} type="time" value={f.time_in} onChange={(v) => setF((s) => ({ ...s, time_in: v.target.value }))} /></Field>
          <Field label="Out"><input style={fld} type="time" value={f.time_out} onChange={(v) => setF((s) => ({ ...s, time_out: v.target.value }))} /></Field>
          <Field label="Or hours"><input style={fld} type="number" step="0.25" min="0" max="24" value={f.hours} onChange={(v) => setF((s) => ({ ...s, hours: v.target.value }))} /></Field>
        </div>
      ) : null}
      <Field label="Note"><input style={fld} value={f.note} maxLength={200} onChange={(v) => setF((s) => ({ ...s, note: v.target.value }))} /></Field>
      <div style={{ display: "flex", gap: 8 }}>
        <button style={btn(NAVY, { flex: 1, padding: "10px 14px", fontSize: 14 })} disabled={busy}
          onClick={async () => { setBusy(true); await onSave({ work_date: day.work_date, ...f }); setBusy(false); }}>
          {busy ? "Saving…" : "Save"}
        </button>
        {e ? <button style={{ ...ghost, color: RED, borderColor: "#fecaca" }} disabled={busy}
          onClick={async () => { setBusy(true); await onSave({ work_date: day.work_date, delete: true }); setBusy(false); }}>Clear</button> : null}
      </div>
    </div>
  );
}
