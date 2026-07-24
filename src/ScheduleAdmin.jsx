// DoorDispatcher — Appointment Scheduler admin (?mode=scheduleadmin).
// The office sets the STANDARD appointment slot times per day + a LAST time.
// Reps/setters book from the standard slots up to the last time; AFTER the last
// time they can enter any custom time. Stored in app_settings.appt_schedule so
// it can be changed anytime with no deploy — the retail booking engine
// (setter-availability.js) reads it live.
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const DAYS = [
  { wd: 0, name: "Sunday" }, { wd: 1, name: "Monday" }, { wd: 2, name: "Tuesday" },
  { wd: 3, name: "Wednesday" }, { wd: 4, name: "Thursday" }, { wd: 5, name: "Friday" }, { wd: 6, name: "Saturday" },
];
// Current live defaults (mirror setter-availability.js SLOT_HOURS) — used until
// the office saves their own. Hours are 24h; last = last standard hour.
const DEFAULTS = {
  0: { slots: [], last: null },
  1: { slots: [11, 14, 17, 19], last: 19 }, 2: { slots: [11, 14, 17, 19], last: 19 },
  3: { slots: [11, 14, 17, 19], last: 19 }, 4: { slots: [11, 14, 17, 19], last: 19 },
  5: { slots: [9, 12, 15], last: 15 }, 6: { slots: [9, 12], last: 12 },
};
const HOUR_CHOICES = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
const hourLabel = (h) => (h == null ? "—" : `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`);

export default function ScheduleAdmin() {
  const [sched, setSched] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    supabase.from("app_settings").select("value").eq("key", "appt_schedule").maybeSingle()
      .then(({ data }) => {
        let s = null;
        try { s = data?.value ? (typeof data.value === "string" ? JSON.parse(data.value) : data.value) : null; } catch { s = null; }
        // Fill any missing day from defaults so the grid is always complete.
        const merged = {};
        for (const { wd } of DAYS) merged[wd] = (s && s[wd]) ? { slots: [...(s[wd].slots || [])].sort((a, b) => a - b), last: s[wd].last ?? null } : { ...DEFAULTS[wd], slots: [...DEFAULTS[wd].slots] };
        setSched(merged);
      });
  }, []);

  const addSlot = (wd, h) => setSched((s) => {
    if (!h && h !== 0) return s;
    const cur = s[wd].slots;
    if (cur.includes(h)) return s;
    const slots = [...cur, h].sort((a, b) => a - b);
    // keep "last" at least the max slot
    const last = s[wd].last == null ? h : Math.max(s[wd].last, ...slots);
    return { ...s, [wd]: { slots, last } };
  });
  const removeSlot = (wd, h) => setSched((s) => {
    const slots = s[wd].slots.filter((x) => x !== h);
    let last = s[wd].last;
    if (slots.length === 0) last = null;
    else if (last != null && last > Math.max(...slots) && !slots.includes(last)) last = Math.max(...slots);
    return { ...s, [wd]: { slots, last } };
  });
  const setLast = (wd, h) => setSched((s) => ({ ...s, [wd]: { ...s[wd], last: h } }));

  const save = async () => {
    setBusy(true); setMsg(null);
    const { error } = await supabase.from("app_settings").upsert({ key: "appt_schedule", value: JSON.stringify(sched) }, { onConflict: "key" });
    setBusy(false);
    setMsg(error ? { err: error.message } : { ok: "Saved — the booking pages use these times right away." });
  };
  const resetDefaults = () => { const m = {}; for (const { wd } of DAYS) m[wd] = { ...DEFAULTS[wd], slots: [...DEFAULTS[wd].slots] }; setSched(m); setMsg(null); };

  if (!sched) return <div style={{ fontFamily: FONT, padding: 40, color: "#64748b" }}>Loading…</div>;

  return (
    <div style={{ fontFamily: FONT, maxWidth: 860, margin: "0 auto", padding: "18px 16px 80px" }}>
      <HarvestNav active="schedule" />
      <h1 style={{ fontFamily: OSWALD, fontSize: 26, fontWeight: 800, margin: "18px 0 4px", color: "#0f172a" }}>📅 Appointment Scheduler</h1>
      <p style={{ fontSize: 14, color: "#64748b", margin: "0 0 20px", maxWidth: "62ch" }}>
        Set the standard appointment times for each day. Reps and setters book from these slots up to the <b>last time</b>; anything <b>after</b> the last time can be entered as a custom time. Change these whenever you want — the booking pages pick it up immediately.
      </p>

      <div style={{ display: "grid", gap: 12 }}>
        {DAYS.map(({ wd, name }) => {
          const d = sched[wd];
          const addable = HOUR_CHOICES.filter((h) => !d.slots.includes(h));
          return (
            <div key={wd} style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: "14px 16px", background: d.slots.length ? "#fff" : "#f8fafc" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <div style={{ fontFamily: OSWALD, fontWeight: 800, fontSize: 16, color: "#0f172a", minWidth: 110 }}>{name}{!d.slots.length && <span style={{ fontFamily: FONT, fontSize: 12, fontWeight: 600, color: "#94a3b8", marginLeft: 8 }}>no appointments</span>}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12.5, color: "#64748b", fontWeight: 700 }}>Last time:</span>
                  <select value={d.last ?? ""} onChange={(e) => setLast(wd, e.target.value === "" ? null : Number(e.target.value))}
                    style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, fontFamily: FONT }}>
                    <option value="">—</option>
                    {HOUR_CHOICES.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 12, alignItems: "center" }}>
                {d.slots.map((h) => (
                  <span key={h} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1e3a8a", borderRadius: 999, padding: "5px 6px 5px 12px", fontSize: 13, fontWeight: 700 }}>
                    {hourLabel(h)}
                    <button type="button" onClick={() => removeSlot(wd, h)} title="Remove" style={{ border: "none", background: "#dbeafe", color: "#1e40af", borderRadius: "50%", width: 20, height: 20, cursor: "pointer", fontWeight: 800, lineHeight: 1 }}>×</button>
                  </span>
                ))}
                {addable.length > 0 && (
                  <select value="" onChange={(e) => { if (e.target.value) addSlot(wd, Number(e.target.value)); }}
                    style={{ padding: "6px 10px", borderRadius: 999, border: "1px dashed #93c5fd", fontSize: 13, fontFamily: FONT, color: "#2563eb", fontWeight: 700, cursor: "pointer", background: "#fff" }}>
                    <option value="">+ Add time</option>
                    {addable.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                  </select>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 20, flexWrap: "wrap" }}>
        <button type="button" onClick={save} disabled={busy}
          style={{ border: "none", borderRadius: 11, padding: "12px 22px", fontFamily: OSWALD, fontWeight: 800, fontSize: 15, letterSpacing: "0.02em", background: "#15803d", color: "#fff", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 }}>
          {busy ? "Saving…" : "Save schedule"}
        </button>
        <button type="button" onClick={resetDefaults} style={{ border: "1px solid #e5e7eb", borderRadius: 11, padding: "12px 18px", fontFamily: FONT, fontWeight: 700, fontSize: 14, background: "#fff", color: "#374151", cursor: "pointer" }}>
          Reset to defaults
        </button>
        {msg && <span style={{ fontSize: 13.5, fontWeight: 700, color: msg.err ? "#b91c1c" : "#047857" }}>{msg.err || msg.ok}</span>}
      </div>
    </div>
  );
}
