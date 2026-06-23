import { useMemo, useState } from "react";

// Results-review appointment picker for the New Inspection flow: "we'll be done
// in 3–4 days — when are you home to go over the findings?" A button opens a
// full-screen popup of the fixed grid (same as retail), earliest 4 days out;
// tapping a time selects it and closes the popup. Mobile-friendly.
// Controlled: value = ISO string, onChange(iso). Inline styles (no Tailwind).

const HOURS = { 1: [11, 14, 17, 19], 2: [11, 14, 17, 19], 3: [11, 14, 17, 19], 4: [11, 14, 17, 19], 5: [9, 12, 15], 6: [9, 12] };
const MIN_LEAD_DAYS = 4;
const NAVY = "#1a2e5a";

export default function ReviewApptPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const days = useMemo(() => buildDays(21), []);
  const pick = (iso) => { onChange(iso); setOpen(false); };

  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 6 }}>
        Results review appointment <span style={{ fontWeight: 400, color: "#6b7280" }}>— when will they be home (~4 days out)?</span>
      </div>

      {value ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 12, padding: "11px 14px" }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: "#166534" }}>✓ {labelFor(value)}</span>
          <button type="button" onClick={() => setOpen(true)} style={{ marginLeft: "auto", background: "none", border: "none", color: NAVY, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Change</button>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)}
          style={{ width: "100%", background: NAVY, color: "#fff", border: "none", borderRadius: 12, padding: "13px 0", fontSize: 15, fontWeight: 800, cursor: "pointer" }}>
          📅 Pick a results-review time
        </button>
      )}

      {open && (
        <div onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", zIndex: 1000, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: "#fff", width: "100%", maxWidth: 480, maxHeight: "85vh", borderRadius: "16px 16px 0 0", display: "flex", flexDirection: "column", boxShadow: "0 -4px 24px rgba(0,0,0,0.2)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid #eee" }}>
              <span style={{ fontSize: 16, fontWeight: 800, color: NAVY, fontFamily: "'Oswald', sans-serif" }}>When are they home?</span>
              <button type="button" onClick={() => setOpen(false)} style={{ background: "none", border: "none", fontSize: 24, color: "#9ca3af", cursor: "pointer", lineHeight: 1, padding: 0 }}>×</button>
            </div>
            <div style={{ overflowY: "auto", padding: "12px 16px 24px" }}>
              {days.map((d) => (
                <div key={d.key} style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 800, textTransform: "uppercase", color: "#9ca3af", marginBottom: 8 }}>{d.label}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {d.slots.map((s) => (
                      <button key={s.iso} type="button" onClick={() => pick(s.iso)}
                        style={{ border: `1px solid ${NAVY}`, color: NAVY, background: "#fff", borderRadius: 12, padding: "12px 18px", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
                        {s.time}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function etParts(ms) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", weekday: "short" });
  const p = {}; for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const wmap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +p.year, mo: +p.month, day: +p.day, weekday: wmap[p.weekday], wname: p.weekday };
}
function etToISO(y, mo, day, hour) {
  const guess = Date.UTC(y, mo - 1, day, hour, 0);
  const asEt = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York" }));
  return new Date(guess + (guess - asEt.getTime())).toISOString();
}
const hh = (h) => `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`;
function buildDays(n) {
  const now = Date.now(), out = [];
  for (let d = MIN_LEAD_DAYS; d < n; d++) {
    const { y, mo, day, weekday, wname } = etParts(now + d * 864e5);
    const hours = HOURS[weekday] || [];
    if (!hours.length) continue;
    out.push({ key: `${y}-${mo}-${day}`, label: `${wname}, ${mo}/${day}`, slots: hours.map((h) => ({ iso: etToISO(y, mo, day, h), time: hh(h) })) });
  }
  return out;
}
function labelFor(iso) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric" }).format(new Date(iso));
}
