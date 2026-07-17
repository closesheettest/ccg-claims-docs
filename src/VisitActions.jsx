// src/VisitActions.jsx
//
// The three post-inspection go-back action panels — Damage (set PA appt),
// No-Damage (referrals + certificate), Retail (schedule / record outcome) —
// extracted so BOTH the Rep Visit Hub and the Harvesting Map render the exact
// same flows against the same backend endpoints. Self-contained: it takes a
// `deal`, a `rep` ({name, jobnimbus_id, email}), and an `api(fn, payload)` that
// POSTs {token, ...payload} to /.netlify/functions/<fn>.

import { useEffect, useMemo, useState } from "react";

const NAVY = "#1a2e5a";
const RETAIL_HOURS = { 1: [11, 14, 17, 19], 2: [11, 14, 17, 19], 3: [11, 14, 17, 19], 4: [11, 14, 17, 19], 5: [9, 12, 15], 6: [9, 12] };
const S = {
  input: { width: "100%", boxSizing: "border-box", height: 46, padding: "0 12px", borderRadius: 12, border: "1px solid #d1d5db", fontSize: 16, background: "#fff" },
  back: { background: "none", border: "none", color: "#6b7280", fontSize: 14, cursor: "pointer", padding: 0 },
  done: { background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", borderRadius: 14, padding: "20px 16px", textAlign: "center", fontSize: 15, fontWeight: 700 },
};

// Renders the right panel for a bucket ("damage" | "no_damage" | "retail").
export default function VisitActions({ type, deal, rep, api }) {
  if (type === "damage") return <DamagePanel deal={deal} rep={rep} api={api} />;
  if (type === "no_damage") return <NoDamagePanel deal={deal} rep={rep} api={api} />;
  if (type === "retail") return <RetailPanel deal={deal} rep={rep} api={api} />;
  return null;
}

export function DamagePanel({ deal, rep, api }) {
  const [slots, setSlots] = useState(null);
  const [err, setErr] = useState("");
  const [booking, setBooking] = useState("");
  const [done, setDone] = useState(null);
  const [ni, setNi] = useState(false);
  useEffect(() => {
    api("pa-schedule-api", { action: "slots", inspection_id: deal.inspection_id, lat: deal.latitude, lng: deal.longitude })
      .then((o) => setSlots(o.slots || [])).catch((e) => { setErr(e.message); setSlots([]); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const doBook = async (s, force) =>
    api("pa-schedule-api", { action: "book", pa_id: s.pa_id, start_at: s.start_at, inspection_id: deal.inspection_id, homeowner_name: deal.client_name, homeowner_phone: deal.mobile, address: deal.address, booked_by: rep.name, force });
  const book = async (s) => {
    setBooking(s.start_at + s.pa_id); setErr("");
    try {
      await doBook(s, false);
      setDone(`Booked with ${s.pa_name} — ${s.label}. The PA was notified.`);
    } catch (e) {
      if (e.body?.duplicate) {
        const ex = e.body.existing || {};
        const when = ex.start_at ? new Date(ex.start_at).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) : "another time";
        if (window.confirm(`⚠️ ${deal.client_name || "This homeowner"} already has a PA appointment scheduled for ${when}${ex.pa_name ? ` with ${ex.pa_name}` : ""}.\n\nBook a SECOND appointment anyway?\n\n• OK = book anyway\n• Cancel = go back and pick a different time`)) {
          try { await doBook(s, true); setDone(`Booked with ${s.pa_name} — ${s.label}. The PA was notified.`); }
          catch (e2) { setErr(e2.message); }
        } else {
          setErr("Didn't book — this homeowner already has a PA appointment. Pick a different time or leave the existing one.");
        }
      } else { setErr(e.message); }
    }
    setBooking("");
  };
  const markNotInterested = async () => {
    if (!window.confirm(`Mark ${deal.client_name || "this homeowner"} Not Interested?\n\nThey'll move to "BTR - NI" in JobNimbus and drop off your damage list.`)) return;
    setNi(true); setErr("");
    try {
      await api("retail-not-interested", { inspection_id: deal.inspection_id });
      setDone(`Marked Not Interested (BTR - NI). Removed from your list.`);
    } catch (e) { setErr(e.message); setNi(false); }
  };
  const [goRetail, setGoRetail] = useState(false);
  const [picking, setPicking] = useState("");
  const retailDays = useMemo(() => buildRetailDays(14), []);
  const pickRetail = async (slot) => {
    setPicking(slot.iso); setErr("");
    try {
      await api("damage-to-retail", { inspection_id: deal.inspection_id, start_at_iso: slot.iso, rep_jobnimbus_id: rep.jobnimbus_id, booked_by: rep.name });
      setDone(`Switched to Retail — appointment set for ${slot.label}. JobNimbus updated.`);
    } catch (e) { setErr(e.message); }
    setPicking("");
  };
  if (done) return <div style={S.done}>✓ {done}</div>;
  if (slots === null) return <p style={{ textAlign: "center", color: "#9ca3af", padding: "16px 0", fontSize: 14 }}>Loading availability…</p>;

  const todayKey = ymdET();
  const byDay = {};
  for (const s of slots) {
    const k = ymdET(new Date(s.start_at));
    if (k === todayKey) continue;
    (byDay[k] = byDay[k] || []).push(s);
  }
  const dayKeys = [...new Set([todayKey, ...Object.keys(byDay)])].sort();
  return (
    <div>
      {Array.isArray(deal.pa_notes_log) && deal.pa_notes_log.length > 0 && (
        <div style={{ marginBottom: 12, background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "8px 10px" }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "#92400e", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>📝 PA notes — what the adjuster found</div>
          <div style={{ maxHeight: 120, overflowY: "auto" }}>
            {deal.pa_notes_log.map((n, i) => <div key={i} style={{ fontSize: 13, color: "#374151", marginBottom: 3 }}>• {n.text}</div>)}
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button type="button" disabled={ni || !!booking} onClick={markNotInterested}
          style={{ flex: 1, border: "1px solid #dc2626", color: "#dc2626", background: "#fff", borderRadius: 12, padding: "11px 8px", fontSize: 13.5, fontWeight: 800, cursor: "pointer", opacity: ni ? 0.6 : 1 }}>
          {ni ? "Saving…" : "🚫 Not Interested"}
        </button>
        <button type="button" disabled={!!booking || !!picking} onClick={() => { setGoRetail((v) => !v); setErr(""); }}
          style={{ flex: 1, border: "1px solid #b45309", color: goRetail ? "#fff" : "#b45309", background: goRetail ? "#b45309" : "#fff", borderRadius: 12, padding: "11px 8px", fontSize: 13.5, fontWeight: 800, cursor: "pointer" }}>
          🏠 Going retail
        </button>
      </div>
      {err && <div style={{ color: "#b91c1c", fontSize: 14, marginBottom: 8 }}>{err}</div>}
      {goRetail ? (
        <div>
          <p style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 8px" }}>🏠 Going retail — pick a retail appointment time. This switches the deal to Retail in JobNimbus and books it.</p>
          <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
            {retailDays.map((day) => (
              <div key={day.key} style={{ marginBottom: 14 }}>
                <p style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", color: "#9ca3af", margin: "0 0 6px" }}>{day.label}</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {day.slots.map((s) => (
                    <button key={s.iso} disabled={!!picking} onClick={() => pickRetail(s)}
                      style={{ border: "1px solid #d97706", color: "#d97706", background: "#fff", borderRadius: 12, padding: "9px 14px", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: picking ? 0.6 : 1 }}>
                      {picking === s.iso ? "…" : s.time}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          <p style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 8px" }}>…or pick a day & time for the PA to come out:</p>
          <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
            {dayKeys.map((k) => {
              const isToday = k === todayKey;
              const seen = new Set(); const uniq = [];
              for (const s of (byDay[k] || [])) { const t = hourLabel(s.start_at); if (seen.has(t)) continue; seen.add(t); uniq.push(s); }
              return (
                <div key={k} style={{ marginBottom: 12 }}>
                  <p style={{ fontSize: 12.5, fontWeight: 800, margin: "0 0 6px", padding: isToday ? "3px 8px" : "0", borderRadius: 8, display: "inline-block", background: isToday ? "#fef3c7" : "transparent", color: isToday ? "#92400e" : "#374151" }}>
                    {dayLabel(k)}{isToday ? " · Today" : ""}
                  </p>
                  {isToday ? <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>(for reference — book a day below)</p>
                    : !uniq.length ? <p style={{ fontSize: 12, color: "#9ca3af", margin: 0 }}>No openings</p>
                      : <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {uniq.map((s) => (
                          <button key={s.start_at + s.pa_id} disabled={!!booking} onClick={() => book(s)}
                            style={{ border: "1px solid #16a34a", color: "#16a34a", background: "#fff", borderRadius: 12, padding: "9px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: booking ? 0.6 : 1 }}>
                            {booking === s.start_at + s.pa_id ? "…" : hourLabel(s.start_at)}
                          </button>
                        ))}
                      </div>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function NoDamagePanel({ deal, rep, api }) {
  const [rows, setRows] = useState([{ name: "", phone: "", address: "" }]);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(null);
  const [decl, setDecl] = useState(false);
  const set = (i, k, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const declineReferral = async () => {
    setDecl(true); setErr("");
    try {
      await api("referral-decline", { inspection_id: deal.inspection_id, rep_name: rep.name });
      setDone(`Logged — ${deal.client_name || "homeowner"} doesn't want to give a referral. (Not sent to JobNimbus.)`);
    } catch (e) { setErr(e.message); setDecl(false); }
  };
  const send = async () => {
    setSending(true); setErr("");
    try {
      const referrals = rows.filter((r) => r.name || r.phone);
      const o = await api("no-damage-send", { inspection_id: deal.inspection_id, referrals, rep_name: rep.name });
      setDone(`Sent to ${deal.client_name}.${o.emailed ? " ✉️" : ""}${o.texted ? " 💬" : ""}${o.hadCert ? " (certificate attached)" : ""}`);
    } catch (e) { setErr(e.message); }
    setSending(false);
  };
  if (done) return <div style={S.done}>✓ {done}</div>;
  const halfInput = { ...S.input, height: 42, fontSize: 15 };
  return (
    <div>
      <p style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 8px" }}>Ask for referrals</p>
      {rows.map((r, i) => (
        <div key={i} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 8, marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input value={r.name} onChange={(e) => set(i, "name", e.target.value)} placeholder="Name" style={{ ...halfInput, width: "55%" }} />
            <input value={r.phone} onChange={(e) => set(i, "phone", e.target.value)} placeholder="Phone" style={{ ...halfInput, width: "45%" }} inputMode="tel" />
          </div>
          <input value={r.address} onChange={(e) => set(i, "address", e.target.value)} placeholder="Address" style={{ ...halfInput, width: "100%" }} />
        </div>
      ))}
      <button onClick={() => setRows((rs) => [...rs, { name: "", phone: "", address: "" }])} style={{ ...S.back, color: NAVY, fontWeight: 700, fontSize: 13, marginBottom: 14 }}>+ add another</button>
      {err && <div style={{ color: "#b91c1c", fontSize: 14, marginBottom: 8 }}>{err}</div>}
      <button onClick={send} disabled={sending} style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 12, padding: "14px 0", fontSize: 15, fontWeight: 800, cursor: "pointer", opacity: sending ? 0.6 : 1 }}>
        {sending ? "Sending…" : "Send certificate + review link"}
      </button>
      <button onClick={declineReferral} disabled={sending || decl} style={{ width: "100%", marginTop: 10, border: "1px solid #b45309", color: "#b45309", background: "#fff", borderRadius: 12, padding: "11px 0", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: decl ? 0.6 : 1 }}>
        {decl ? "Saving…" : "🙅 Doesn't want to give a referral"}
      </button>
    </div>
  );
}

export function RetailPanel({ deal, rep, api }) {
  const [picking, setPicking] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(null);
  const [recording, setRecording] = useState("");
  const [blocked, setBlocked] = useState(() => new Set());
  const [booked, setBooked] = useState(() => new Set());
  const [dateBlocked, setDateBlocked] = useState(() => new Set());
  useEffect(() => {
    if (!rep || !rep.jobnimbus_id) return;
    const now = new Date(), end = new Date(now.getTime() + 15 * 864e5);
    api("rep-calendar-api", { action: "load", rep_jobnimbus_id: rep.jobnimbus_id, start: now.toISOString(), end: end.toISOString() })
      .then((o) => {
        setBlocked(new Set((o.blocks || []).map((b) => `${b.weekday}:${b.start_min}`)));
        setBooked(new Set((o.events || []).map((ev) => etApptKey(ev.start))));
        setDateBlocked(new Set((o.date_blocks || []).map((b) => `${b.date}:${b.start_min}`)));
      })
      .catch(() => {});
  }, [rep && rep.jobnimbus_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const days = useMemo(() => buildRetailDays(14, blocked, booked, dateBlocked), [blocked, booked, dateBlocked]);
  const pick = async (slot) => {
    setPicking(slot.iso); setErr("");
    try {
      await api("retail-task-create", { inspection_id: deal.inspection_id, start_at_iso: slot.iso, rep_jobnimbus_id: rep.jobnimbus_id, booked_by: rep.name });
      setDone(`Retail appointment set for ${slot.label}. Added to JobNimbus.`);
    } catch (e) { setErr(e.message); }
    setPicking("");
  };
  const recordOutcome = async (outcome, label) => {
    if (!window.confirm(`Record this deal as "${label}"? It drops off your retail list.`)) return;
    setRecording(outcome); setErr("");
    try {
      await api("retail-outcome-set", { inspection_id: deal.inspection_id, outcome, rep_name: rep.name });
      setDone(`Recorded: ${label}. Removed from your retail list.`);
    } catch (e) { setErr(e.message); setRecording(""); }
  };
  if (done) return <div style={S.done}>✓ {done}</div>;
  const oBtn = (color, off) => ({ flex: 1, minWidth: 96, border: `1px solid ${color}`, color, background: "#fff", borderRadius: 12, padding: "11px 6px", fontSize: 13.5, fontWeight: 800, cursor: off ? "default" : "pointer", opacity: off ? 0.6 : 1 });
  const off = !!recording || !!picking;
  return (
    <div>
      {err && <div style={{ color: "#b91c1c", fontSize: 14, marginBottom: 8 }}>{err}</div>}
      <p style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 6px" }}>Already sat with them? Record the outcome:</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <button type="button" disabled={off} onClick={() => recordOutcome("sold", "Sit Sold")} style={oBtn("#047857", off)}>{recording === "sold" ? "…" : "✅ Sit Sold"}</button>
        <button type="button" disabled={off} onClick={() => recordOutcome("no_sale", "Sit - No Sale")} style={oBtn("#6b7280", off)}>{recording === "no_sale" ? "…" : "➖ No Sale"}</button>
        <button type="button" disabled={off} onClick={() => recordOutcome("ni", "Not Interested")} style={oBtn("#dc2626", off)}>{recording === "ni" ? "…" : "🚫 Not Interested"}</button>
      </div>
      <p style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 8px" }}>…or schedule a retail appointment for later:</p>
      <div style={{ maxHeight: "55vh", overflowY: "auto" }}>
        {days.map((day) => (
          <div key={day.key} style={{ marginBottom: 14 }}>
            <p style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", color: "#9ca3af", margin: "0 0 6px" }}>{day.label}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {day.slots.map((s) => (
                <button key={s.iso} disabled={!!picking} onClick={() => pick(s)} style={{ border: "1px solid #d97706", color: "#d97706", background: "#fff", borderRadius: 12, padding: "9px 14px", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: picking ? 0.6 : 1 }}>
                  {picking === s.iso ? "…" : s.time}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── ET date helpers (shared by the panels) ──────────────────────────────────
function ymdET(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function dayLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
}
function hourLabel(iso) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric" }).format(new Date(iso));
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
function etApptKey(iso) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hour12: false });
  const p = {}; for (const x of f.formatToParts(new Date(iso))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}@${parseInt(p.hour, 10)}`;
}
function buildRetailDays(n, blocked = new Set(), booked = new Set(), dateBlocked = new Set()) {
  const now = Date.now(), out = [];
  for (let d = 0; d < n; d++) {
    const ms = now + d * 864e5;
    const { y, mo, day, weekday, wname } = etParts(ms);
    const dateStr = `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const hours = (RETAIL_HOURS[weekday] || []).filter((h) => !blocked.has(`${weekday}:${h * 60}`) && !dateBlocked.has(`${dateStr}:${h * 60}`) && !booked.has(`${y}-${mo}-${day}@${h}`));
    if (!hours.length) continue;
    const slots = hours.map((h) => ({ iso: etToISO(y, mo, day, h), time: `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`, label: `${wname} ${mo}/${day} ${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}` }))
      .filter((s) => Date.parse(s.iso) > now);
    if (slots.length) out.push({ key: `${y}-${mo}-${day}`, label: `${wname}, ${mo}/${day}`, slots });
  }
  return out;
}
