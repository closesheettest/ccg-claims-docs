import { useState } from "react";

// Results-review availability for the New Inspection flow. Inspections often run
// behind, so we DON'T book a specific date — we just capture the homeowner's
// typical weekly availability (which days + what time) so the rep knows when to
// swing back once the inspection is done. Controlled: value = a readable string
// like "Mon, Wed · 5 PM"; onChange(string). Inline styles (no Tailwind).

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIMES = ["9 AM", "11 AM", "12 PM", "2 PM", "5 PM", "7 PM"];
const NAVY = "#1a2e5a";

const SCRIPT = "When the inspection is done, I'm going to come by to let you know what they found. When is typically best during the week to come by?";

export default function ReviewApptPicker({ value, onChange, invalid }) {
  // Parse the stored string back into selections so re-renders stay in sync.
  const [days, setDays] = useState(() => parseDays(value));
  const [time, setTime] = useState(() => parseTime(value));

  const emit = (d, t) => onChange(buildLabel(d, t));
  const toggleDay = (day) => {
    const next = days.includes(day) ? days.filter((x) => x !== day) : [...DAYS].filter((x) => days.includes(x) || x === day);
    setDays(next); emit(next, time);
  };
  const pickTime = (t) => { const next = t === time ? "" : t; setTime(next); emit(days, next); };

  const chip = (on, color) => ({
    border: `1px solid ${on ? color : "#d1d5db"}`, background: on ? color : "#fff", color: on ? "#fff" : "#374151",
    borderRadius: 999, padding: "9px 15px", fontSize: 14, fontWeight: 700, cursor: "pointer",
  });

  return (
    <div style={{ background: "#fff", border: `2px solid ${invalid ? "#dc2626" : NAVY}`, borderRadius: 14, padding: 16 }}>
      <p style={{ margin: "0 0 14px", fontSize: 15.5, fontWeight: 700, color: NAVY, lineHeight: 1.4 }}>{SCRIPT} <span style={{ color: "#dc2626" }}>*</span></p>
      {invalid && <div style={{ margin: "0 0 12px", fontSize: 13.5, fontWeight: 700, color: "#dc2626" }}>Please pick a day and a time to continue.</div>}

      <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".03em", color: "#9ca3af", marginBottom: 7 }}>Days that work</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        {DAYS.map((d) => <button key={d} type="button" onClick={() => toggleDay(d)} style={chip(days.includes(d), NAVY)}>{d}</button>)}
      </div>

      <div style={{ fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".03em", color: "#9ca3af", marginBottom: 7 }}>Best time</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {TIMES.map((t) => <button key={t} type="button" onClick={() => pickTime(t)} style={chip(t === time, "#16a34a")}>{t}</button>)}
      </div>

      {(days.length || time) && (
        <div style={{ marginTop: 14, fontSize: 14, fontWeight: 800, color: "#166534" }}>✓ {buildLabel(days, time)}</div>
      )}
    </div>
  );
}

function buildLabel(days, time) {
  const d = days.length === 6 ? "Any day" : days.join(", ");
  if (d && time) return `${d} · ${time}`;
  return d || time || "";
}
function parseDays(v) {
  if (!v) return [];
  const left = String(v).split("·")[0];
  if (/any day/i.test(left)) return [...DAYS];
  return DAYS.filter((d) => left.includes(d));
}
function parseTime(v) {
  if (!v) return "";
  return TIMES.find((t) => String(v).includes(t)) || "";
}
