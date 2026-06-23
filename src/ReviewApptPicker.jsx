import { useMemo } from "react";

// Results-review appointment picker for the New Inspection flow: "we'll be done
// in 3–4 days — when are you home to go over the findings?" Fixed grid (same as
// the retail scheduler), earliest 4 days out. Controlled: value = ISO string,
// onChange(iso). Self-contained inline styles (CCG doesn't use Tailwind).

const HOURS = { 1: [11, 14, 17, 19], 2: [11, 14, 17, 19], 3: [11, 14, 17, 19], 4: [11, 14, 17, 19], 5: [9, 12, 15], 6: [9, 12] };
const MIN_LEAD_DAYS = 4;
const NAVY = "#1a2e5a";

export default function ReviewApptPicker({ value, onChange }) {
  const days = useMemo(() => buildDays(21), []);
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#374151", marginBottom: 4 }}>
        Results review appointment <span style={{ fontWeight: 400, color: "#6b7280" }}>— when will they be home (~4 days out)?</span>
      </div>
      {value && <div style={{ fontSize: 12.5, color: "#166534", fontWeight: 700, marginBottom: 8 }}>✓ {labelFor(value)} <button type="button" onClick={() => onChange("")} style={{ background: "none", border: "none", color: "#9ca3af", cursor: "pointer", fontSize: 13 }}>change</button></div>}
      {!value && (
        <div style={{ maxHeight: 240, overflowY: "auto", border: "1px solid #e5e7eb", borderRadius: 12, padding: 10 }}>
          {days.map((d) => (
            <div key={d.key} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", color: "#9ca3af", marginBottom: 5 }}>{d.label}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {d.slots.map((s) => (
                  <button key={s.iso} type="button" onClick={() => onChange(s.iso)}
                    style={{ border: `1px solid ${NAVY}`, color: NAVY, background: "#fff", borderRadius: 10, padding: "7px 13px", fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}>
                    {s.time}
                  </button>
                ))}
              </div>
            </div>
          ))}
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
  const d = new Date(iso);
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric" }).format(d);
}
