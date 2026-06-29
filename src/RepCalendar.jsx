import { useEffect, useMemo, useState, useCallback } from "react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import "react-big-calendar/lib/css/react-big-calendar.css";
import { format, parse, startOfWeek, getDay } from "date-fns";
import { enUS } from "date-fns/locale";

// Rep calendar: live JobNimbus appointments + the rep's availability. Reps are
// available by DEFAULT on these 2-hour slots; tap an open (green) slot to block
// it (turns red), tap again to reopen. Saved to rep_slot_blocks via
// rep-calendar-api. Mirrors the JobNimbus day/week/month/agenda look.
const FN = "/.netlify/functions";
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales: { "en-US": enUS } });

// weekday (0=Sun … 6=Sat) → available start HOURS (ET). Matches retail hours.
const SLOT_HOURS = { 1: [11, 14, 17, 19], 2: [11, 14, 17, 19], 3: [11, 14, 17, 19], 4: [11, 14, 17, 19], 5: [9, 12, 15], 6: [9, 12] };
const isSlot = (wd, hour) => (SLOT_HOURS[wd] || []).includes(hour);

// Event color by JN type (appointments are the loud ones).
function eventColor(type) {
  const t = (type || "").toLowerCase();
  if (t.includes("inspection result")) return "#0e7490"; // go-back (rep go-over-results)
  if (t.includes("retail")) return "#2563eb";
  if (t.includes("appointment")) return "#ca8a04"; // initial / generic appt
  return "#475569";
}

export default function RepCalendar({ rep, token, onClose }) {
  const [view, setView] = useState("day");
  const [date, setDate] = useState(new Date());
  const [events, setEvents] = useState([]);
  const [dateBlocks, setDateBlocks] = useState(new Set()); // "YYYY-MM-DD:startMin" — date-specific
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // 6-week window around the focus date covers day/week/month + navigation.
  const range = useMemo(() => {
    const s = new Date(date); s.setDate(s.getDate() - 21); s.setHours(0, 0, 0, 0);
    const e = new Date(date); e.setDate(e.getDate() + 21); e.setHours(23, 59, 59, 0);
    return { start: s.toISOString(), end: e.toISOString() };
  }, [date]);

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch(`${FN}/rep-calendar-api`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action: "load", rep_jobnimbus_id: rep.jobnimbus_id, start: range.start, end: range.end }) });
      const o = await r.json();
      if (!o.ok) { setErr(o.error || "Could not load calendar."); return; }
      setEvents((o.events || []).map((ev) => ({ ...ev, start: new Date(ev.start), end: new Date(ev.end) })));
      setDateBlocks(new Set((o.date_blocks || []).map((b) => `${b.date}:${b.start_min}`)));
    } catch { setErr("Network error."); }
  }, [rep.jobnimbus_id, token, range.start, range.end]);
  useEffect(() => { load(); }, [load]);

  // "YYYY-MM-DD" (ET) for a Date.
  const etDateStr = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const hourLabel = (h) => `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`;

  // Persist one DATE's blocked slots (date-specific) to rep_date_blocks.
  const saveDate = async (dateStr, set) => {
    setBusy(true);
    const start_mins = [...set].filter((k) => k.startsWith(dateStr + ":")).map((k) => Number(k.split(":")[1]));
    try {
      await fetch(`${FN}/rep-calendar-api`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action: "save_date_blocks", rep_jobnimbus_id: rep.jobnimbus_id, date: dateStr, start_mins }) });
    } catch { /* keep local */ }
    setBusy(false);
  };
  const toggleDateSlot = (dateStr, h) => {
    const key = `${dateStr}:${h * 60}`;
    setDateBlocks((prev) => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); saveDate(dateStr, next); return next; });
  };
  const setWholeDay = (dateStr, hours, block) => {
    setDateBlocks((prev) => {
      const next = new Set(prev);
      for (const h of hours) { const k = `${dateStr}:${h * 60}`; block ? next.add(k) : next.delete(k); }
      saveDate(dateStr, next);
      return next;
    });
  };

  // Tap a calendar slot toggles THAT date's slot too (the grid is the reliable path).
  const onSelectSlot = ({ start }) => {
    const wd = start.getDay(), hour = start.getHours();
    if (!isSlot(wd, hour)) return;
    toggleDateSlot(etDateStr(start), hour);
  };
  const slotPropGetter = (d) => {
    const wd = d.getDay(), hour = d.getHours();
    if (!isSlot(wd, hour)) return {};
    const blocked = dateBlocks.has(`${etDateStr(d)}:${hour * 60}`);
    return { style: { backgroundColor: blocked ? "#fee2e2" : "#dcfce7", cursor: "pointer" } };
  };
  const eventPropGetter = (ev) => ({ style: { backgroundColor: eventColor(ev.type), border: "none", fontSize: 11.5 } });

  // Upcoming dates (next 21, days with slots) for the date-specific editor.
  const upcomingDays = useMemo(() => {
    const out = []; const now = Date.now();
    for (let d = 0; d < 21; d++) {
      const dt = new Date(now + d * 864e5);
      const p = {}; for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric" }).formatToParts(dt)) p[x.type] = x.value;
      const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
      const hours = SLOT_HOURS[wd] || [];
      if (hours.length) out.push({ dateStr: etDateStr(dt), label: `${p.weekday} ${p.month}/${p.day}`, hours });
    }
    return out;
  }, []);

  return (
    <div style={{ background: "#fff", borderRadius: 12, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontWeight: 800, fontSize: 16, color: "#1a2e5a" }}>📅 {rep.name}'s calendar</div>
        {onClose && <button onClick={onClose} style={{ border: "1px solid #cbd5e1", background: "#fff", borderRadius: 8, padding: "6px 12px", fontWeight: 700, cursor: "pointer" }}>Done</button>}
      </div>

      {/* Date-specific availability editor — block a slot (or a whole day) for a
          SPECIFIC date only, e.g. "this Saturday's 9am" or "this whole Saturday". */}
      <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 12, marginBottom: 12 }}>
        <div style={{ fontWeight: 800, fontSize: 14, color: "#1a2e5a" }}>Set your availability{busy ? " · saving…" : ""}</div>
        <div style={{ fontSize: 12, color: "#64748b", margin: "2px 0 10px" }}>You're available by default. Tap a time to block it <b>for that day only</b>, or block a whole day. <span style={{ color: "#16a34a", fontWeight: 700 }}>green = open</span> · <span style={{ color: "#dc2626", fontWeight: 700 }}>red = blocked</span></div>
        <div style={{ maxHeight: "42vh", overflowY: "auto" }}>
          {upcomingDays.map((day) => {
            const allBlocked = day.hours.every((h) => dateBlocks.has(`${day.dateStr}:${h * 60}`));
            return (
              <div key={day.dateStr} style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <div style={{ minWidth: 72, fontWeight: 800, fontSize: 13, color: "#374151" }}>{day.label}</div>
                  <button type="button" onClick={() => setWholeDay(day.dateStr, day.hours, !allBlocked)}
                    style={{ border: `1px solid ${allBlocked ? "#16a34a" : "#dc2626"}`, color: allBlocked ? "#166534" : "#b91c1c", background: "#fff", borderRadius: 8, padding: "3px 9px", fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                    {allBlocked ? "Open whole day" : "Block whole day"}
                  </button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 4 }}>
                  {day.hours.map((h) => {
                    const blocked = dateBlocks.has(`${day.dateStr}:${h * 60}`);
                    return (
                      <button key={h} type="button" onClick={() => toggleDateSlot(day.dateStr, h)}
                        style={{ border: `1.5px solid ${blocked ? "#dc2626" : "#16a34a"}`, background: blocked ? "#fee2e2" : "#dcfce7", color: blocked ? "#b91c1c" : "#166534", borderRadius: 10, padding: "7px 12px", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
                        {hourLabel(h)}{blocked ? " ✕" : ""}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>Below is your live JobNimbus schedule (colored blocks = appointments).</div>
      {err && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 8 }}>{err}</div>}
      <Calendar
        localizer={localizer}
        events={events}
        view={view} onView={setView} views={["day", "week", "month", "agenda"]}
        date={date} onNavigate={setDate}
        selectable onSelectSlot={onSelectSlot}
        slotPropGetter={slotPropGetter} eventPropGetter={eventPropGetter}
        step={60} timeslots={1}
        min={new Date(1970, 0, 1, 8, 0)} max={new Date(1970, 0, 1, 21, 0)}
        popup
        style={{ height: 620 }}
      />
    </div>
  );
}
