// src/TimeCard.jsx
//
// EMPLOYEE TIME CARD  (/?mode=timecard)
//
// The day is two taps, not a punch clock:
//   • at the start of their shift they CHECK IN,
//   • at the end they file a RECAP of what they got done, which closes the day
//     out and sets the hours.
// Anyone who'd rather not do either can mark the day off (vacation, sick, the
// doctor) right from the same card.
//
// Shifts are named and office-defined — a night shift running 6pm–6am belongs
// to the date it STARTED, so someone checking in Monday evening and recapping
// at 6am Tuesday files one day, on Monday.
//
// Sign-in is their MOBILE NUMBER + a 4–8 digit passcode they set the first time
// (most of the field crew have no company email, so the phone is the identifier).
// Everything is saved server-side (payroll-me.js) so it follows them to any
// phone; the session token is the only thing kept on the device.
//
// Tabs:  Today  ·  My Week  ·  Time Off  ·  Team (managers only)

import React, { useCallback, useEffect, useRef, useState } from "react";

const API = "/.netlify/functions/payroll-me";
const TOKEN_KEY = "uss_payroll_token";
const LOGIN_KEY = "uss_payroll_login";

const NAVY = "#0f2a4a", RED = "#c0392b", GREEN = "#15803d", AMBER = "#b45309";
const INK = "#16233b", MUTE = "#5b6b8c", LINE = "#e2e8f2", BG = "#f4f7fb";

// What each day type is called on screen, and the color it wears.
const DAY_TYPES = [
  { key: "worked", label: "Worked", emoji: "🔨", color: NAVY },
  { key: "pto", label: "Vacation (PTO)", emoji: "🏖️", color: "#0369a1" },
  { key: "sick", label: "Sick", emoji: "🤒", color: "#7c3aed" },
  { key: "doctor", label: "Doctor", emoji: "🩺", color: "#7c3aed" },
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
  { key: "pto", label: "Vacation" }, { key: "unpaid", label: "Unpaid" },
];
const REQUEST_TYPES = [
  { key: "pto", label: "Vacation (PTO)" }, { key: "sick", label: "Sick" }, { key: "doctor", label: "Doctor visit" },
  { key: "unpaid", label: "Unpaid" },
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
// Minutes read as minutes up to an hour and a half, then as hours — "465 min late"
// is true but unreadable on a night shift.
// Formats as they type; the API only ever looks at the digits.
const formatPhone = (v) => {
  const d = String(v || "").replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
};
const fmtMins = (m) => { m = Math.round(Number(m) || 0); if (m < 90) return `${m} min`; const h = Math.floor(m / 60); return `${h}h ${m % 60}m`; };

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
  const [tab, setTab] = useState("today");
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
  const tabs = [["today", "Today"], ["week", "My Week"], ["off", "Time Off"]].concat(isMgr ? [["team", "Team"]] : []);

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
      {tab === "today" && <Today me={me} api={api} onErr={setErr} onChanged={async () => { const d = await api("me"); if (d.ok) setMe(d.me); }} />}
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
  const [login, setLogin] = useState(() => { try { return localStorage.getItem(LOGIN_KEY) || ""; } catch { return ""; } });
  const [step, setStep] = useState("who");       // who → passcode | create
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
    const v = login.trim();
    if (v.replace(/\D/g, "").length < 10 && !v.includes("@")) { setErr("Type your 10-digit mobile number, or your work email."); return; }
    setBusy(true); setErr("");
    const d = await call("who", { login: v });
    setBusy(false);
    if (!d.ok || !d.found) { setErr("We can't find that on the roster. Try the mobile number the office texts you on, or your work email. Still stuck? Ask the office to check your record."); return; }
    setName(d.name || ""); setStep(d.passcode_set ? "passcode" : "create");
  };

  const go = async () => {
    if (step === "create" && pass !== confirm) { setErr("The two passcodes don't match."); return; }
    if (!/^\d{4,8}$/.test(pass)) { setErr("Your passcode is 4–8 digits."); return; }
    setBusy(true); setErr("");
    const d = await call("login", { login: login.trim(), passcode: pass });
    setBusy(false);
    if (!d.ok) { setErr(d.error || "Sign-in failed."); return; }
    try { localStorage.setItem(LOGIN_KEY, login.trim()); } catch { /* private mode */ }
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
          {step === "who" ? (
            <>
              <label style={{ fontSize: 13, fontWeight: 700, color: MUTE }}>Mobile number or work email</label>
              <input style={{ ...fld, fontSize: 17 }} autoComplete="username"
                value={login}
                onChange={(e) => {
                  const v = e.target.value;
                  // Format as a phone only while it still looks like one; the
                  // moment it looks like an email, leave what they typed alone.
                  setLogin(/[a-zA-Z@]/.test(v) ? v : formatPhone(v));
                }}
                onKeyDown={(e) => e.key === "Enter" && findMe()} placeholder="(813) 555-0123  or  you@shingleusa.com" />
              <Err>{err}</Err>
              <button style={btn(NAVY)} disabled={busy} onClick={findMe}>{busy ? "Checking…" : "Continue"}</button>
              <div style={{ fontSize: 12, color: MUTE, textAlign: "center" }}>Whichever the office has for you — your mobile, or your work email.</div>
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
              <button style={{ ...ghost, border: "none", color: MUTE }} onClick={() => { setStep("who"); setPass(""); setConfirm(""); setErr(""); }}>Use something else</button>
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

// ── TODAY: check in, then recap ─────────────────────────────────────────
function Today({ me, api, onErr, onChanged }) {
  const [d, setD] = useState(null);
  // Arrived by scanning the door QR (/checkin). Check them in the moment the
  // page can — including right after a first-time sign-in, since the flag rides
  // along in the URL through that whole flow.
  const [scanned] = useState(() => {
    try { return new URLSearchParams(window.location.search).get("checkin") === "1"; } catch { return false; }
  });
  const [autoDone, setAutoDone] = useState(false);
  const autoRan = useRef(false);
  const [busy, setBusy] = useState(false);
  const [recap, setRecap] = useState("");
  const [lunch, setLunch] = useState(30);
  const [pickOff, setPickOff] = useState(null);        // null | { day_type, reason }
  const [breaking, setBreaking] = useState(null);      // null | { minutes, reason }
  const [editingRecap, setEditingRecap] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    const r = await api("today");
    if (r.ok) { setD(r); setRecap(r.entry?.recap || ""); if (r.entry?.lunch_minutes != null) setLunch(r.entry.lunch_minutes); }
    else onErr(r.error || "Couldn't load today.");
  }, [api, onErr]);
  useEffect(() => { load(); }, [load]);
  // keep the "on shift for 3h 20m" counter honest without re-fetching
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 60000); return () => clearInterval(t); }, []);

  // The scan-to-check-in handoff. Runs once, and only when there's genuinely
  // nothing on the day yet — scanning again later must never disturb a day
  // that's already under way, closed out, or marked off.
  useEffect(() => {
    if (!scanned || autoRan.current || !d) return;
    if (d.state !== "not_started" || d.locked) return;
    autoRan.current = true;
    (async () => {
      const r = await api("check_in");
      if (r.ok) { setD(r); setAutoDone(true); onChanged(); }
      else onErr(r.error || "Couldn't check you in.");
    })();
  }, [scanned, d, api, onErr, onChanged]);

  const call = async (action, extra) => {
    setBusy(true); onErr("");
    const r = await api(action, extra);
    setBusy(false);
    if (!r.ok) { onErr(r.error || "That didn't go through."); return false; }
    setD(r); setRecap(r.entry?.recap || ""); setPickOff(null); setBreaking(null); setEditingRecap(false);
    onChanged();
    return true;
  };

  if (!d) return <div style={{ ...card, color: MUTE, textAlign: "center" }}>Loading…</div>;

  const e = d.entry;
  const shift = d.shift;
  const elapsed = e?.checked_in_at && !e?.checked_out_at
    ? Math.max(0, Math.round((Date.now() - new Date(e.checked_in_at).getTime()) / 60000)) : null;
  const isNight = shift && shift.end_time <= shift.start_time;
  // A break can't be longer than the shift it happens in.
  const shiftMinutes = shift ? (((mins(shift.end_time) - mins(shift.start_time)) + 1440) % 1440) : 0;
  const offType = e && e.day_type !== "worked" ? (DT[e.day_type] || null) : null;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {/* which day this is — spelled out, because on nights it isn't today's date */}
      <div style={{ ...card, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, color: MUTE, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4 }}>
            {d.locked ? "Signed off" : "Your shift day"}
          </div>
          <div style={{ fontSize: 19, fontWeight: 900, color: NAVY }}>{prettyLong(d.work_date)}</div>
          {isNight && d.work_date !== d.now.date ? (
            <div style={{ fontSize: 12, color: MUTE }}>You're still on {prettyLong(d.work_date)}'s night shift.</div>
          ) : null}
        </div>
        {shift ? (
          <div style={{ textAlign: "right" }}>
            <Pill color={NAVY}>{shift.name} shift</Pill>
            <div style={{ fontSize: 12.5, color: MUTE, marginTop: 3 }}>{hhmm(shift.start_time)} – {hhmm(shift.end_time)}</div>
          </div>
        ) : <Pill color={AMBER}>no shift set</Pill>}
      </div>

      {autoDone ? (
        <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", borderRadius: 12, padding: "14px 16px", fontWeight: 800, fontSize: 16, textAlign: "center" }}>
          ✅ You're checked in at {hhmm(d.entry?.time_in)}. Have a good one.
        </div>
      ) : null}

      {d.holiday ? (
        <div style={{ background: "#fdf2f8", border: "1px solid #fbcfe8", color: "#9d174d", borderRadius: 12, padding: "10px 12px", fontWeight: 700, fontSize: 13.5 }}>
          🎉 {d.holiday.name}{d.holiday.paid ? " — paid holiday" : ""}
        </div>
      ) : null}

      {/* the state machine */}
      {d.state === "off" ? (
        <div style={{ ...card, display: "grid", gap: 10, textAlign: "center" }}>
          <div style={{ fontSize: 34 }}>{offType?.emoji || "—"}</div>
          <div style={{ fontSize: 19, fontWeight: 900 }}>{offType?.label || e.day_type}</div>
          <div style={{ fontSize: 13.5, color: MUTE }}>You're marked off for {prettyLong(d.work_date)}. Your manager sees it on their board.</div>
          {e.note ? <div style={{ background: "#f8fafc", border: `1px solid ${LINE}`, borderRadius: 10, padding: "9px 11px", fontSize: 13.5 }}>{e.note}</div> : null}
          {!d.locked ? <button style={ghost} disabled={busy} onClick={() => call("check_in")}>Actually, I'm working — check me in</button> : null}
        </div>
      ) : d.state === "done" ? (
        <div style={{ ...card, display: "grid", gap: 11 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ fontSize: 26 }}>✅</div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 900 }}>Day closed out — {e.hours}h</div>
              <div style={{ fontSize: 12.5, color: MUTE }}>
                {hhmm(e.time_in)} – {hhmm(e.time_out)}{e.lunch_minutes ? ` · ${e.lunch_minutes} min lunch` : ""}
                {e.late_minutes ? ` · ${fmtMins(e.late_minutes)} late` : ""}
                {e.left_early_minutes ? ` · left ${fmtMins(e.left_early_minutes)} early` : ""}
              </div>
            </div>
          </div>
          <div style={{ background: "#f8fafc", border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: MUTE, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 5 }}>What you got done</div>
            {editingRecap ? (
              <>
                <textarea style={{ ...fld, minHeight: 110, resize: "vertical", fontFamily: "inherit" }} value={recap} maxLength={2000} onChange={(ev) => setRecap(ev.target.value)} />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button style={btn(NAVY, { flex: 1 })} disabled={busy} onClick={async () => { const r = await api("save_recap", { work_date: d.work_date, recap }); if (r.ok) { setEditingRecap(false); load(); } else onErr(r.error); }}>Save</button>
                  <button style={ghost} onClick={() => { setRecap(e.recap || ""); setEditingRecap(false); }}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 14.5, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{e.recap}</div>
                {!d.locked ? <button style={{ ...ghost, marginTop: 9, padding: "6px 12px", fontSize: 13 }} onClick={() => setEditingRecap(true)}>Add to it</button> : null}
              </>
            )}
          </div>
          {d.locked
            ? <div style={{ fontSize: 12.5, color: MUTE }}>🔒 This week is signed off.</div>
            : <button style={{ ...ghost, border: "none", color: MUTE, justifySelf: "start" }} disabled={busy}
                onClick={() => { if (window.confirm("Put yourself back on the clock for this day?")) call("reopen_day"); }}>
                Ended too early? Reopen my day
              </button>}
        </div>
      ) : d.state === "working" ? (
        <div style={{ ...card, display: "grid", gap: 12 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 12, color: MUTE, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4 }}>Checked in at {hhmm(e.time_in)}</div>
            <div style={{ fontSize: 40, fontWeight: 900, color: NAVY, lineHeight: 1.15 }}>
              {elapsed != null ? `${Math.floor(elapsed / 60)}h ${elapsed % 60}m` : "—"}
            </div>
            <div style={{ fontSize: 12.5, color: MUTE }}>on shift{e.late_minutes ? ` · ${fmtMins(e.late_minutes)} late` : ""}</div>
          </div>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 6 }}>What did you get done today?</div>
            <textarea style={{ ...fld, minHeight: 120, resize: "vertical", fontFamily: "inherit" }} value={recap} maxLength={2000}
              onChange={(ev) => setRecap(ev.target.value)}
              placeholder={"Jobs, addresses, deliveries, what got finished, anything that held you up…"} />
          </div>
          <Field label="Lunch / breaks (min)"><input style={fld} type="number" min="0" max="240" value={lunch} onChange={(ev) => setLunch(ev.target.value)} /></Field>
          <button style={btn(GREEN)} disabled={busy || recap.trim().length < 3}
            onClick={() => call("check_out", { recap: recap.trim(), lunch_minutes: Number(lunch) || 0 })}>
            {busy ? "…" : "End shift & send recap"}
          </button>
          <div style={{ fontSize: 12, color: MUTE, textAlign: "center" }}>Your hours come from your check-in to right now, minus lunch and any breaks.</div>

          <div style={{ borderTop: `1px solid ${LINE}`, paddingTop: 11, display: "grid", gap: 9 }}>
            {breaking ? (
              <div style={{ display: "grid", gap: 9 }}>
                <div style={{ fontWeight: 800, fontSize: 14 }}>Stepping away</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                  {[15, 30, 45, 60].map((m) => (
                    <button key={m} onClick={() => setBreaking((b) => ({ ...b, minutes: m }))} style={{
                      ...ghost, padding: "8px 14px",
                      background: Number(breaking.minutes) === m ? NAVY : "#fff",
                      color: Number(breaking.minutes) === m ? "#fff" : NAVY,
                      borderColor: Number(breaking.minutes) === m ? NAVY : LINE,
                    }}>{m} min</button>
                  ))}
                  <Field label="or"><input style={fld} type="number" min="1" max={shiftMinutes || 720} value={breaking.minutes}
                    onChange={(ev) => setBreaking((b) => ({ ...b, minutes: ev.target.value }))} /></Field>
                </div>
                <Field label="Reason (your manager sees this)">
                  <input style={fld} value={breaking.reason} maxLength={200} placeholder="Doctor, school pickup, personal errand…"
                    onChange={(ev) => setBreaking((b) => ({ ...b, reason: ev.target.value }))} />
                </Field>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={btn(NAVY, { flex: 1 })} disabled={busy || !Number(breaking.minutes) || breaking.reason.trim().length < 2}
                    onClick={() => call("break", { minutes: Number(breaking.minutes), reason: breaking.reason.trim() })}>
                    {busy ? "…" : "Log the break"}
                  </button>
                  <button style={ghost} onClick={() => setBreaking(null)}>Cancel</button>
                </div>
              </div>
            ) : pickOff ? (
              <OffPicker value={pickOff} setValue={setPickOff} busy={busy}
                onSubmit={() => call("day_off", { day_type: pickOff.day_type, reason: pickOff.reason.trim() })} />
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                <button style={{ ...ghost, fontSize: 13 }} onClick={() => setBreaking({ minutes: 30, reason: "" })}>☕ Took a break</button>
                <button style={{ ...ghost, fontSize: 13 }} onClick={() => setPickOff({ day_type: "pto", reason: "" })}>I'm actually off today</button>
                <button style={{ ...ghost, fontSize: 13, color: RED, borderColor: "#fecaca" }} disabled={busy}
                  onClick={() => { if (window.confirm("Undo your check-in for today?")) call("undo_check_in"); }}>Checked in by mistake</button>
              </div>
            )}
            {Number(e.off_hours) ? (
              <div style={{ background: "#f8fafc", border: `1px solid ${LINE}`, borderRadius: 10, padding: "9px 11px", fontSize: 12.5, color: MUTE, whiteSpace: "pre-wrap" }}>
                <b style={{ color: INK }}>{Math.round(Number(e.off_hours) * 60)} min away so far</b>{e.note ? `\n${e.note}` : ""}
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div style={{ ...card, display: "grid", gap: 12, textAlign: "center" }}>
          <div style={{ fontSize: 15.5, fontWeight: 800 }}>Good {shift && Number(shift.start_time.slice(0, 2)) >= 17 ? "evening" : "morning"}, {me.first_name}</div>
          <div style={{ fontSize: 13.5, color: MUTE }}>
            {shift ? `Your ${shift.name.toLowerCase()} shift starts at ${hhmm(shift.start_time)}.` : "Tap below when you start."}
          </div>
          <button style={btn(NAVY, { fontSize: 18, padding: "18px 20px" })} disabled={busy || d.locked} onClick={() => call("check_in")}>
            {busy ? "…" : "✋ Check in"}
          </button>
          {!pickOff ? (
            <button style={{ ...ghost, border: "none", color: MUTE }} disabled={d.locked} onClick={() => setPickOff({ day_type: "pto", reason: "" })}>I'm off today</button>
          ) : (
            <OffPicker value={pickOff} setValue={setPickOff} busy={busy}
              onSubmit={() => call("day_off", { day_type: pickOff.day_type, reason: pickOff.reason.trim() })} />
          )}
        </div>
      )}
    </div>
  );
}

// Marking a day off: pick what kind, and say why — the reason is what the
// manager reads on their board, so it isn't optional.
function OffPicker({ value, setValue, onSubmit, busy }) {
  return (
    <div style={{ display: "grid", gap: 9, textAlign: "left" }}>
      <div style={{ fontSize: 12.5, color: MUTE, textAlign: "center" }}>What kind of day off?</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
        {DAY_TYPES.filter((t) => t.key !== "worked").map((t) => (
          <button key={t.key} onClick={() => setValue((v) => ({ ...v, day_type: t.key }))} style={{
            ...ghost, padding: "8px 12px", fontSize: 13,
            background: value.day_type === t.key ? t.color : "#fff",
            color: value.day_type === t.key ? "#fff" : INK,
            borderColor: value.day_type === t.key ? t.color : LINE,
          }}>{t.emoji} {t.label}</button>
        ))}
      </div>
      <Field label="Reason (required)">
        <input style={fld} value={value.reason} maxLength={200} placeholder="Your manager sees this"
          onChange={(e) => setValue((v) => ({ ...v, reason: e.target.value }))} />
      </Field>
      <div style={{ display: "flex", gap: 8 }}>
        <button style={btn(NAVY, { flex: 1 })} disabled={busy || value.reason.trim().length < 3} onClick={onSubmit}>
          {busy ? "…" : "Mark the day off"}
        </button>
        <button style={ghost} onClick={() => setValue(null)}>Never mind</button>
      </div>
    </div>
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
        <Stat label="Paid time off" value={`${((t?.pto || 0) + (t?.sick || 0)).toFixed(2).replace(/\.00$/, "")}h`} sub="vacation · sick" color="#0369a1" />
        <Stat label="Holiday" value={`${t?.holiday ?? 0}h`} color="#be185d" />
        <Stat label="Late / early" value={`${(t?.late_minutes || 0) + (t?.left_early_minutes || 0)}m`} sub={t?.late_minutes ? `${t.late_minutes}m late` : "on time"} color={(t?.late_minutes || t?.left_early_minutes) ? AMBER : INK} />
      </div>

      {/* the seven days */}
      {(data?.days || []).map((d) => (
        <DayCard key={d.work_date} day={d} me={me} locked={isLocked} busy={busy}
          expanded={open === d.work_date} onToggle={() => setOpen(open === d.work_date ? "" : d.work_date)}
          onSave={save} />
      ))}

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
      note: f.note, recap: f.recap,
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
          {e?.recap ? (
            <div style={{ fontSize: 12.5, color: MUTE, marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>📝 {e.recap}</div>
          ) : null}
        </div>
        <div style={{ color: MUTE, fontSize: 18 }}>{expanded ? "▴" : "▾"}</div>
      </button>

      {expanded ? (
        <div style={{ borderTop: `1px solid ${LINE}`, padding: 13, display: "grid", gap: 11, background: "#fbfcfe" }}>
          {locked ? (
            <div style={{ display: "grid", gap: 9 }}>
              {e?.recap ? (
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 800, color: MUTE, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.3 }}>What you got done</div>
                  <div style={{ background: "#f8fafc", border: `1px solid ${LINE}`, borderRadius: 10, padding: "10px 12px", fontSize: 14, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{e.recap}</div>
                </div>
              ) : null}
              <div style={{ fontSize: 13, color: MUTE }}>🔒 This week is signed off — the office can still change it for you.</div>
            </div>
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

              <Field label="What you got done">
                <textarea style={{ ...fld, minHeight: 110, resize: "vertical", fontFamily: "inherit", lineHeight: 1.45 }}
                  value={f.recap} maxLength={2000}
                  placeholder="Jobs, addresses, deliveries, what got finished, anything that held you up…"
                  onChange={(v) => setF((s) => ({ ...s, recap: v.target.value }))} />
              </Field>

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
    recap: e.recap || "",
  };
  return {
    day_type: "worked", time_in: "", time_out: "", lunch_minutes: 30, hours: "",
    off_type: "", off_hours: 0, late_minutes: 0, left_early_minutes: 0,
    note: hol ? hol.name : "", recap: "", _dayHrs: me?.standard_day_hours || 8,
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
      </div>

      <div style={{ ...card, display: "grid", gap: 11 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Request time off</div>
        <Field label="What for">
          <select style={fld} value={f.request_type} onChange={(e) => setF((s) => ({ ...s, request_type: e.target.value }))}>
            {REQUEST_TYPES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
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
                      {r.status === "pending" || r.status === "approved" ? (
                        <button style={{ ...ghost, padding: "5px 9px", fontSize: 12 }}
                          onClick={async () => {
                            const msg = r.status === "approved"
                              ? "Cancel this time off? Those days come off your time card and your manager is told."
                              : "Cancel this request? Your manager is told.";
                            if (!window.confirm(msg)) return;
                            const d = await api("cancel_off", { id: r.id });
                            if (!d.ok) { onErr(d.error || "Couldn't cancel that."); return; }
                            if (d.notice) onErr(d.notice);
                            load(); onChanged();
                          }}>
                          {r.status === "approved" ? "I'm not taking it" : "Cancel"}
                        </button>
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
  const [view, setView] = useState("today");     // today | week
  const [ws, setWs] = useState(() => mondayOf(todayET()));
  const [data, setData] = useState(null);
  const [queue, setQueue] = useState([]);
  const [openEmp, setOpenEmp] = useState("");
  const [busy, setBusy] = useState(false);
  const [sign, setSign] = useState(`${me.first_name} ${me.last_name}`.trim());
  const [note, setNote] = useState("");
  const [shifts, setShifts] = useState([]);
  const [adding, setAdding] = useState(null);
  const [contacts, setContacts] = useState([]);

  const load = useCallback(async (week) => {
    setBusy(true);
    const [d, q] = await Promise.all([api("team_week", { week_start: week }), api("off_queue")]);
    setBusy(false);
    if (d.ok) setData(d); else onErr(d.error || "Couldn't load your team.");
    if (q.ok) setQueue(q.requests || []);
  }, [api, onErr]);
  useEffect(() => { load(ws); }, [ws, load]);

  const decide = async (id, decision) => {
    const d = await api("decide_off", { id, decision });
    if (!d.ok) { onErr(d.error || "Couldn't record that."); return; }
    load(ws);
  };

  useEffect(() => { (async () => { const d = await api("shifts"); if (d.ok) setShifts(d.shifts || []); })(); }, [api]);
  useEffect(() => { (async () => { const d = await api("team_contacts"); if (d.ok) setContacts(d.departments || []); })(); }, [api, view]);

  // A manager staffs their own department: who's on which shift, who joins, who leaves.
  const setShift = async (employeeId, shiftId) => {
    const r = await api("set_shift", { employee_id: employeeId, shift_id: shiftId });
    if (!r.ok) { onErr(r.error || "Couldn't set that shift."); return; }
    load(ws);
  };
  const addTeammate = async (dep) => {
    const r = await api("add_teammate", { ...adding, department_id: dep.department.id });
    if (!r.ok) { onErr(r.error || "Couldn't add them."); return; }
    setAdding(null); load(ws);
  };
  const deactivate = async (m) => {
    if (!window.confirm(`Take ${m.employee.name} off the roster? Their hours and recaps stay.`)) return;
    const r = await api("deactivate_teammate", { employee_id: m.employee.id });
    if (!r.ok) { onErr(r.error || "Couldn't do that."); return; }
    load(ws);
  };

  // One sign-off for the whole week.
  const signOffWeek = async (dep) => {
    if (!sign.trim()) { onErr("Type your name to sign off."); return; }
    setBusy(true); onErr("");
    const r = await api("approve_week", { week_start: ws, department_id: dep.department.id, sign_name: sign.trim(), note });
    setBusy(false);
    if (!r.ok) { onErr(r.error || "Sign-off failed."); return; }
    setNote(""); load(ws);
  };

  const thisWeek = mondayOf(todayET());
  const allSigned = (data?.departments || []).every((d) => d.approval?.status === "approved");
  const needsSignoff = data && !allSigned;
  const unreachable = contacts.some((d) => (d.members || []).some((m) => !m.reachable));

  if (view === "contacts") {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <TeamViewToggle view={view} setView={setView} needsSignoff={needsSignoff} unreachable={unreachable} />
        <TeamContacts api={api} onErr={onErr} />
      </div>
    );
  }

  if (view === "today") {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <TeamViewToggle view={view} setView={setView} needsSignoff={needsSignoff} unreachable={unreachable} />
        <TeamToday me={me} api={api} onErr={onErr} />
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <TeamViewToggle view={view} setView={setView} needsSignoff={needsSignoff} unreachable={unreachable} />
      <div style={{ ...card, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: 10 }}>
        <button style={{ ...ghost, padding: "8px 12px" }} onClick={() => setWs(addDays(ws, -7))}>←</button>
        <div style={{ textAlign: "center", lineHeight: 1.2 }}>
          <div style={{ fontWeight: 900, fontSize: 15 }}>{pretty(ws)} – {pretty(addDays(ws, 6))}</div>
          <div style={{ fontSize: 11.5, color: MUTE }}>{ws === thisWeek ? "This week" : ws === addDays(thisWeek, -7) ? "Last week" : "Past week"}</div>
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
                {(dep.members || []).length} on the team · {dep.approval?.status === "approved" ? "week signed off" : "week not signed yet"}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 21, fontWeight: 900 }}>{dep.totals.worked}h</div>
              <div style={{ fontSize: 12, color: dep.totals.overtime ? AMBER : MUTE }}>{dep.totals.overtime ? `${dep.totals.overtime}h OT` : "no OT"}</div>
            </div>
          </div>

          {dep.members.map((m) => (
            <TeamMember key={m.employee.id} m={m} open={openEmp === m.employee.id}
              shifts={shifts} onSetShift={setShift} onDeactivate={deactivate}
              onToggle={() => setOpenEmp(openEmp === m.employee.id ? "" : m.employee.id)}
              locked={dep.approval?.status === "approved"}
              onSave={async (payload) => {
                const d = await api("team_save_day", { employee_id: m.employee.id, ...payload });
                if (!d.ok) { onErr(d.error || "Couldn't save."); return false; }
                load(ws); return true;
              }} />
          ))}

          {adding ? (
            <div style={{ ...card, display: "grid", gap: 9, borderColor: "#bfdbfe", background: "#f8fbff" }}>
              <div style={{ fontWeight: 900, fontSize: 15 }}>Add someone to {dep.department.name}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Field label="First name"><input style={fld} value={adding.first_name} onChange={(e) => setAdding({ ...adding, first_name: e.target.value })} /></Field>
                <Field label="Last name"><input style={fld} value={adding.last_name} onChange={(e) => setAdding({ ...adding, last_name: e.target.value })} /></Field>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Field label="Mobile"><input style={fld} value={adding.phone} onChange={(e) => setAdding({ ...adding, phone: e.target.value })} placeholder="(813) 555-0123" /></Field>
                <Field label="Email (optional)"><input style={fld} value={adding.email} onChange={(e) => setAdding({ ...adding, email: e.target.value })} /></Field>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Field label="Job title"><input style={fld} value={adding.title} onChange={(e) => setAdding({ ...adding, title: e.target.value })} /></Field>
                <Field label="Shift">
                  <select style={fld} value={adding.shift_id} onChange={(e) => setAdding({ ...adding, shift_id: e.target.value })}>
                    <option value="">— none yet —</option>
                    {shifts.map((x) => <option key={x.id} value={x.id}>{x.name} ({hhmm(x.start_time)}–{hhmm(x.end_time)})</option>)}
                  </select>
                </Field>
              </div>
              <div style={{ fontSize: 12, color: MUTE }}>They need a mobile or an email before they can sign in — you can add it later.</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={btn(NAVY, { flex: 1 })} disabled={busy} onClick={() => addTeammate(dep)}>Add to {dep.department.name}</button>
                <button style={ghost} onClick={() => setAdding(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button style={{ ...ghost, justifySelf: "start" }}
              onClick={() => setAdding({ first_name: "", last_name: "", phone: "", email: "", title: "", shift_id: "" })}>
              + Add someone to {dep.department.name}
            </button>
          )}

          {dep.approval?.status === "approved" ? (
            <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", borderRadius: 12, padding: "12px 14px", fontWeight: 700, fontSize: 14 }}>
              ✅ Week of {pretty(ws)} signed off by {dep.approval.approved_by_name}
              {dep.approval.approved_at ? ` · ${new Date(dep.approval.approved_at).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
              {dep.approval.note ? <div style={{ fontWeight: 500, marginTop: 4 }}>{dep.approval.note}</div> : null}
            </div>
          ) : (
            <div style={{ ...card, display: "grid", gap: 10, borderColor: "#bfdbfe", background: "#f8fbff" }}>
              <div style={{ fontWeight: 900, fontSize: 15 }}>Sign off {dep.department.name} — week of {pretty(ws)}–{pretty(addDays(ws, 6))}</div>
              <div style={{ fontSize: 13, color: MUTE }}>
                One sign-off covers the whole week. It locks these hours so payroll can run them, so fix anything wrong first — tap a name to edit their days.
                {dep.members.some((m) => m.flags.some((f) => f.kind === "missing")) ? " Some days are still blank." : ""}
              </div>
              <input style={fld} value={sign} onChange={(e) => setSign(e.target.value)} placeholder="Type your name to sign" />
              <input style={fld} value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
              <button style={btn(GREEN)} disabled={busy} onClick={() => signOffWeek(dep)}>
                {busy ? "…" : `✍️ Sign off ${dep.members.length} ${dep.members.length === 1 ? "person" : "people"} for the week`}
              </button>
            </div>
          )}
        </div>
      ))}

      {data && !(data.departments || []).length ? (
        <div style={{ ...card, color: MUTE }}>You aren't set as the manager of a department yet — the office assigns that on the Payroll screen.</div>
      ) : null}
      {allSigned && data?.departments?.length ? <div style={{ textAlign: "center", color: MUTE, fontSize: 13 }}>Everything for this week is signed off. 👍</div> : null}
    </div>
  );
}

function TeamMember({ m, open, onToggle, onSave, locked, shifts, onSetShift, onDeactivate }) {
  const [editing, setEditing] = useState("");
  return (
    <div style={{ ...card, padding: 0, overflow: "hidden" }}>
      <button onClick={onToggle} style={{ width: "100%", textAlign: "left", background: "none", border: "none", padding: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 900, fontSize: 15 }}>{m.employee.name}</div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 3 }}>
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
          {shifts ? (
            <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap", padding: "10px 13px", borderBottom: `1px solid ${LINE}` }}>
              <span style={{ fontSize: 12.5, fontWeight: 800, color: MUTE, textTransform: "uppercase", letterSpacing: 0.3 }}>Shift</span>
              <select style={{ ...fld, maxWidth: 250 }} value={m.employee.shift_id || ""}
                onChange={(e) => onSetShift(m.employee.id, e.target.value)}>
                <option value="">— none —</option>
                {shifts.map((x) => <option key={x.id} value={x.id}>{x.name} ({hhmm(x.start_time)}–{hhmm(x.end_time)})</option>)}
              </select>
              <button style={{ ...ghost, marginLeft: "auto", color: RED, borderColor: "#fecaca", padding: "7px 12px", fontSize: 12.5 }}
                onClick={() => onDeactivate(m)}>Remove from team</button>
            </div>
          ) : null}
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
                    {e?.recap ? <div style={{ color: MUTE, fontSize: 12.5, marginTop: 2, whiteSpace: "pre-wrap" }}>📝 {e.recap}</div> : null}
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

// The manager's daily read: who's on, who never checked in, and what each
// person got done. This is the thing they open every evening.
function TeamViewToggle({ view, setView, needsSignoff, unreachable }) {
  const b = (k, label, badge) => (
    <button onClick={() => setView(k)} style={{
      ...ghost, flex: 1, padding: "10px 8px",
      background: view === k ? NAVY : "#fff", color: view === k ? "#fff" : NAVY, borderColor: view === k ? NAVY : LINE,
    }}>{label}{badge ? <span style={{ marginLeft: 6, background: view === k ? "#fff" : RED, color: view === k ? RED : "#fff", borderRadius: 999, padding: "1px 7px", fontSize: 11, fontWeight: 900 }}>!</span> : null}</button>
  );
  return <div style={{ display: "flex", gap: 8 }}>{b("today", "Today")}{b("week", "Week sign-off", needsSignoff)}{b("contacts", "Contacts", unreachable)}</div>;
}

// A manager filling in their own team's number/email. Nobody else knows these,
// and without one the person can't be told to check in and can't sign in.
function TeamContacts({ api, onErr }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState("");
  const [saved, setSaved] = useState("");

  const load = useCallback(async () => {
    const r = await api("team_contacts");
    if (r.ok) setData(r.departments || []); else onErr(r.error || "Couldn't load your team.");
  }, [api, onErr]);
  useEffect(() => { load(); }, [load]);

  const of = (m) => draft[m.id] || { phone: m.phone, email: m.email };
  const set = (m, k, v) => setDraft((d) => ({ ...d, [m.id]: { ...of(m), [k]: v } }));
  const dirty = (m) => {
    const d = draft[m.id];
    return !!d && (d.phone !== m.phone || d.email !== m.email);
  };

  const save = async (m) => {
    const d = of(m);
    setBusy(m.id); onErr("");
    const r = await api("set_teammate_contact", { id: m.id, phone: d.phone, email: d.email });
    setBusy("");
    if (!r.ok) { onErr(r.error || "Couldn't save that."); return; }
    setDraft((x) => { const n = { ...x }; delete n[m.id]; return n; });
    setSaved(m.id); setTimeout(() => setSaved(""), 2200);
    load();
  };

  if (!data) return <div style={{ ...card, color: MUTE }}>Loading…</div>;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, fontSize: 13.5, color: MUTE }}>
        A mobile number or work email is how someone signs in <b>and</b> how the check-in reminder reaches them.
        Anyone with neither can't be reminded and can't get in. A mobile number is best — the reminder texts.
      </div>
      {data.map((d) => {
        const missing = d.members.filter((m) => !m.reachable);
        return (
          <div key={d.department.id} style={{ ...card, display: "grid", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
              <div style={{ fontWeight: 900, fontSize: 16 }}>{d.department.name}</div>
              {missing.length
                ? <Pill color={RED}>{missing.length} with no way to reach them</Pill>
                : <Pill color={GREEN}>everyone reachable</Pill>}
            </div>
            {d.members.map((m) => (
              <div key={m.id} style={{
                display: "grid", gap: 7, padding: "10px 0", borderTop: `1px solid ${LINE}`,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 800 }}>{m.name}</span>
                  {m.title ? <span style={{ fontSize: 12.5, color: MUTE }}>{m.title}</span> : null}
                  {!m.reachable ? <Pill color={RED}>no phone or email</Pill> : null}
                  {m.reachable && !m.signed_in ? <Pill color={AMBER}>never signed in</Pill> : null}
                  {saved === m.id ? <Pill color={GREEN}>saved</Pill> : null}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input style={{ ...fld, width: 170 }} inputMode="tel" placeholder="Mobile number"
                    value={of(m).phone} onChange={(e) => set(m, "phone", e.target.value)} />
                  <input style={{ ...fld, width: 250 }} inputMode="email" placeholder="Work email"
                    value={of(m).email} onChange={(e) => set(m, "email", e.target.value)} />
                  <button style={{ ...btn(NAVY), padding: "9px 16px", opacity: dirty(m) ? 1 : 0.4 }}
                    disabled={!dirty(m) || busy === m.id} onClick={() => save(m)}>
                    {busy === m.id ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
            ))}
            {!d.members.length ? <div style={{ fontSize: 13.5, color: MUTE }}>Nobody on this team yet.</div> : null}
          </div>
        );
      })}
      {!data.length ? <div style={{ ...card, color: MUTE }}>You don't run a department yet.</div> : null}
    </div>
  );
}

function TeamToday({ me, api, onErr }) {
  const [d, setD] = useState(null);
  const [date, setDate] = useState("");   // "" = each person's current shift day
  const load = useCallback(async () => {
    const r = await api("team_today", date ? { work_date: date } : {});
    if (r.ok) setD(r); else onErr(r.error || "Couldn't load your team's day.");
  }, [api, onErr, date]);
  useEffect(() => { load(); }, [load]);

  const STATE = {
    working: { label: "on shift", color: NAVY },
    done: { label: "recapped", color: GREEN },
    off: { label: "off", color: "#0369a1" },
    not_started: { label: "no check-in", color: AMBER },
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, display: "flex", gap: 9, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="Day">
          <input style={fld} type="date" value={date} max={todayET()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <button style={ghost} onClick={() => setDate(addDays(date || todayET(), -1))}>← previous day</button>
        {date ? <button style={ghost} onClick={() => setDate("")}>Back to now</button> : <div style={{ fontSize: 12.5, color: MUTE, paddingBottom: 10 }}>Showing each person's current shift day — night shifts included.</div>}
      </div>

      {(d?.departments || []).map((dep) => (
        <div key={dep.department.id} style={{ display: "grid", gap: 10 }}>
          <div style={{ ...card, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 900, fontSize: 17, color: NAVY }}>{dep.department.name}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {dep.counts.working ? <Pill color={NAVY}>{dep.counts.working} on shift</Pill> : null}
              {dep.counts.done ? <Pill color={GREEN}>{dep.counts.done} recapped</Pill> : null}
              {dep.counts.off ? <Pill color="#0369a1">{dep.counts.off} off</Pill> : null}
              {dep.counts.missing ? <Pill color={AMBER}>{dep.counts.missing} no check-in</Pill> : null}
            </div>
          </div>

          {dep.members.map((m) => {
            const e = m.entry;
            const st = STATE[m.state] || STATE.not_started;
            const offType = e && e.day_type !== "worked" ? (DT[e.day_type] || null) : null;
            return (
              <div key={m.employee.id} style={{ ...card, display: "grid", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 900, fontSize: 15 }}>{m.employee.name}</div>
                    <div style={{ fontSize: 12, color: MUTE }}>
                      {m.shift ? `${m.shift.name} · ${hhmm(m.shift.start_time)}–${hhmm(m.shift.end_time)}` : "no shift set"} · {prettyLong(m.work_date)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <Pill color={st.color}>{offType ? `${offType.emoji} ${offType.label}` : st.label}</Pill>
                    <div style={{ fontSize: 12.5, color: MUTE, marginTop: 3 }}>
                      {m.state === "working" && m.elapsed_minutes != null ? `in ${hhmm(e.time_in)} · ${Math.floor(m.elapsed_minutes / 60)}h ${m.elapsed_minutes % 60}m`
                        : m.state === "done" ? `${e.hours}h · ${hhmm(e.time_in)}–${hhmm(e.time_out)}`
                          : ""}
                      {e?.late_minutes ? ` · ${fmtMins(e.late_minutes)} late` : ""}
                    </div>
                  </div>
                </div>
                {e?.note ? (
                  <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "9px 11px", fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.4 }}>
                    {e.day_type === "worked" && Number(e.off_hours) ? <b>{Math.round(Number(e.off_hours) * 60)} min away · </b> : null}{e.note}
                  </div>
                ) : null}
                {e?.recap ? (
                  <div style={{ background: "#f8fafc", border: `1px solid ${LINE}`, borderRadius: 10, padding: "10px 12px", fontSize: 14, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>{e.recap}</div>
                ) : m.state === "working" ? (
                  <div style={{ fontSize: 13, color: MUTE }}>Recap comes in when they end their shift.</div>
                ) : m.state === "not_started" ? (
                  <div style={{ fontSize: 13, color: AMBER }}>Hasn't checked in. They get a text once their shift start passes.</div>
                ) : null}
              </div>
            );
          })}
          {!dep.members.length ? <div style={{ ...card, color: MUTE }}>Nobody on this team yet.</div> : null}

          {dep.members.length ? (
            <div style={{ fontSize: 12.5, color: MUTE }}>
              This is the day as it happens. Sign-off is once a week — use the <b>Week sign-off</b> tab when the week's done.
            </div>
          ) : null}
        </div>
      ))}
      {d && !(d.departments || []).length ? <div style={{ ...card, color: MUTE }}>You don't manage a department yet — the office sets that.</div> : null}
    </div>
  );
}

// ── EMBEDDABLE: the employee screens, for the office side ───────────────
// The payroll office screen signs in with the SAME credentials and gets the
// same kind of session token, so it can render these directly:
//   • no asEmployeeId  → your own day, fully interactive (clock in from admin)
//   • asEmployeeId set → that person's screens, READ-ONLY (the server refuses
//     writes while viewing as someone else)
export function EmployeeScreens({ token, asEmployeeId, tabs }) {
  const [me, setMe] = useState(null);
  const [tab, setTab] = useState("today");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const readOnly = !!asEmployeeId;

  const api = useCallback(async (action, extra) => {
    const r = await fetch(API, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, token, ...(asEmployeeId ? { as_employee_id: asEmployeeId } : {}), ...extra }),
    });
    return r.json().catch(() => ({ ok: false, error: "Bad response" }));
  }, [token, asEmployeeId]);

  const reload = useCallback(async () => {
    setLoading(true);
    const d = await api("me");
    setMe(d.ok ? d.me : null);
    if (!d.ok) setErr(d.error || "Couldn't load that person.");
    setLoading(false);
  }, [api]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setTab("today"); }, [asEmployeeId]);

  const saveTitle = async () => {
    const d = await api("set_title", { title: titleDraft.trim() });
    if (!d.ok) { setErr(d.error || "Couldn't save that."); return; }
    setEditingTitle(false); reload();
  };

  if (loading) return <div style={{ ...card, color: MUTE, textAlign: "center" }}>Loading…</div>;
  if (!me) return <div style={{ ...card }}><Err>{err || "Nothing to show."}</Err></div>;

  const isMgr = me.is_manager || me.is_admin;
  const available = (tabs || ["today", "week", "off"].concat(isMgr ? ["team"] : []));

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {readOnly ? (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 12, padding: "10px 13px", fontSize: 13.5, fontWeight: 600 }}>
          👀 Viewing as <b>{me.first_name} {me.last_name}</b> — this is exactly what they see. It's read-only: nothing here can check them in, book their time off, or sign their day.
        </div>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 900, color: NAVY }}>{me.first_name} {me.last_name}</div>
          <div style={{ fontSize: 12.5, color: MUTE, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {editingTitle && !readOnly ? (
              <>
                <input style={{ ...fld, padding: "5px 9px", fontSize: 13, width: 210 }} value={titleDraft} maxLength={80}
                  placeholder="What do you do here?" autoFocus
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") setEditingTitle(false); }} />
                <button style={{ ...ghost, padding: "5px 10px", fontSize: 12 }} onClick={saveTitle}>Save</button>
                <button style={{ ...ghost, padding: "5px 10px", fontSize: 12, border: "none", color: MUTE }} onClick={() => setEditingTitle(false)}>Cancel</button>
              </>
            ) : (
              <>
                <span>{[me.title, me.department?.name, me.shift?.name].filter(Boolean).join(" · ") || "no department or shift set"}</span>
                {!readOnly ? (
                  <button style={{ ...ghost, padding: "3px 8px", fontSize: 11.5, border: "none", color: NAVY }}
                    onClick={() => { setTitleDraft(me.title || ""); setEditingTitle(true); }}>
                    {me.title ? "edit job title" : "add your job title"}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          {available.map((k) => (
            <button key={k} onClick={() => setTab(k)} style={{
              ...ghost, padding: "8px 14px",
              background: tab === k ? NAVY : "#fff", color: tab === k ? "#fff" : NAVY, borderColor: tab === k ? NAVY : LINE,
            }}>{{ today: "Today", week: "My Week", off: "Time Off", team: "Team" }[k] || k}</button>
          ))}
        </div>
      </div>

      <Err>{err}</Err>
      {tab === "today" && <Today me={me} api={api} onErr={setErr} onChanged={reload} />}
      {tab === "week" && <MyWeek me={me} api={api} onErr={setErr} onChanged={reload} />}
      {tab === "off" && <TimeOff me={me} api={api} onErr={setErr} onChanged={reload} />}
      {tab === "team" && <Team me={me} api={api} onErr={setErr} />}
    </div>
  );
}
