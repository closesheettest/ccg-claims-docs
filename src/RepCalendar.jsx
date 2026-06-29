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
  const [blocks, setBlocks] = useState(new Set()); // "weekday:startMin"
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
      setBlocks(new Set((o.blocks || []).map((b) => `${b.weekday}:${b.start_min}`)));
    } catch { setErr("Network error."); }
  }, [rep.jobnimbus_id, token, range.start, range.end]);
  useEffect(() => { load(); }, [load]);

  const saveBlocks = async (next) => {
    setBusy(true);
    const rows = [...next].map((k) => { const [wd, sm] = k.split(":").map(Number); return { weekday: wd, start_min: sm }; });
    try {
      await fetch(`${FN}/rep-calendar-api`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, action: "save_blocks", rep_jobnimbus_id: rep.jobnimbus_id, blocks: rows }) });
    } catch { /* keep local */ }
    setBusy(false);
  };

  // Tap an availability slot to block / unblock it.
  const onSelectSlot = ({ start }) => {
    const wd = start.getDay(), hour = start.getHours();
    if (!isSlot(wd, hour)) return; // only the defined 2-hour slots are toggleable
    const key = `${wd}:${hour * 60}`;
    setBlocks((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      saveBlocks(next);
      return next;
    });
  };

  const slotPropGetter = (d) => {
    const wd = d.getDay(), hour = d.getHours();
    if (!isSlot(wd, hour)) return {};
    const blocked = blocks.has(`${wd}:${hour * 60}`);
    return { style: { backgroundColor: blocked ? "#fee2e2" : "#dcfce7", cursor: "pointer" } };
  };
  const eventPropGetter = (ev) => ({ style: { backgroundColor: eventColor(ev.type), border: "none", fontSize: 11.5 } });

  // Reliable tap-grid for setting availability (the calendar's slot-tap is
  // finicky on phones). Available by default; tap a time to block it.
  const toggleSlot = (wd, h) => {
    const key = `${wd}:${h * 60}`;
    setBlocks((prev) => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); saveBlocks(next); return next; });
  };
  const hourLabel = (h) => `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`;
  const WD = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"]];

  return (
    <div style={{ background: "#fff", borderRadius: 12, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontWeight: 800, fontSize: 16, color: "#1a2e5a" }}>📅 {rep.name}'s calendar</div>
        {onClose && <button onClick={onClose} style={{ border: "1px solid #cbd5e1", background: "#fff", borderRadius: 8, padding: "6px 12px", fontWeight: 700, cursor: "pointer" }}>Done</button>}
      </div>

      {/* Availability editor — the reliable way to set when you're available */}
      <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 12, marginBottom: 12 }}>
        <div style={{ fontWeight: 800, fontSize: 14, color: "#1a2e5a" }}>Set your availability{busy ? " · saving…" : ""}</div>
        <div style={{ fontSize: 12, color: "#64748b", margin: "2px 0 10px" }}>You're available by default. Tap a time to block it. <span style={{ color: "#16a34a", fontWeight: 700 }}>green = open</span> · <span style={{ color: "#dc2626", fontWeight: 700 }}>red = blocked</span></div>
        {WD.map(([wd, label]) => (
          <div key={wd} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <div style={{ width: 38, fontWeight: 800, fontSize: 13, color: "#374151" }}>{label}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(SLOT_HOURS[wd] || []).map((h) => {
                const blocked = blocks.has(`${wd}:${h * 60}`);
                return (
                  <button key={h} type="button" onClick={() => toggleSlot(wd, h)}
                    style={{ border: `1.5px solid ${blocked ? "#dc2626" : "#16a34a"}`, background: blocked ? "#fee2e2" : "#dcfce7", color: blocked ? "#b91c1c" : "#166534", borderRadius: 10, padding: "7px 12px", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
                    {hourLabel(h)}{blocked ? " ✕" : ""}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
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
