// Homeowner come-back-review booking page (?mode=gobackbook&t=<token>). Opened from the
// Auto-Schedule-After-Inspection texts. Shows open times and books one — which stamps the
// review appointment (stopping the sequence), drops it on the rep's JN + map, and texts
// the rep. Scoped entirely by the private token.
import React, { useEffect, useMemo, useState } from "react";

const API = "/.netlify/functions/goback-book";
async function api(action, payload) {
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || "Something went wrong");
  return j;
}
const NAVY = "#0f2a4a", RED = "#c0392b", MUTE = "#5b6b8c", LINE = "#e2e8f2", BG = "#f4f7fb";
const dayKey = (iso) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" });
const timeLabel = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

export default function GobackBook() {
  const token = useMemo(() => { try { return new URLSearchParams(window.location.search).get("t") || ""; } catch { return ""; } }, []);
  const [insp, setInsp] = useState(null);
  const [slots, setSlots] = useState(null);
  const [err, setErr] = useState("");
  const [booking, setBooking] = useState("");
  const [done, setDone] = useState(null);

  useEffect(() => {
    if (!token) { setErr("This link is missing its code — please use the link from your text."); return; }
    (async () => {
      try { const j = await api("load", { t: token }); setInsp(j.insp); if (j.insp.booked_at) setDone({ start_at: j.insp.booked_at }); }
      catch (e) { setErr(e.message); return; }
      try { const j = await api("slots", { t: token }); setSlots(j.slots || []); }
      catch (e) { setSlots([]); }
    })();
  }, [token]);

  const book = async (s) => {
    setBooking(s.start_at); setErr("");
    try { const j = await api("book", { t: token, start_at: s.start_at }); setDone(j.booked || s); }
    catch (e) { setErr(e.message); }
    setBooking("");
  };

  const shell = (children) => (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: '-apple-system,"Segoe UI",Helvetica,Arial,sans-serif', color: "#16233b" }}>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "26px 18px 60px" }}>{children}</div>
    </div>
  );

  if (err && !insp) return shell(<div style={{ background: "#fff", border: `1px solid ${LINE}`, borderRadius: 14, padding: "24px 20px", textAlign: "center" }}><div style={{ fontSize: 34 }}>🔗</div><div style={{ fontWeight: 800, color: NAVY, marginTop: 8 }}>Link problem</div><div style={{ color: MUTE, marginTop: 6 }}>{err}</div></div>);
  if (!insp) return shell(<div style={{ textAlign: "center", color: MUTE, padding: "60px 0" }}>Loading…</div>);

  const header = (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".09em", textTransform: "uppercase", color: RED }}>U.S. Shingle &amp; Metal</div>
      <h1 style={{ fontSize: 24, margin: "4px 0 0", color: NAVY }}>Book your roof review</h1>
      <div style={{ height: 3, width: 60, background: RED, borderRadius: 2, margin: "11px 0" }} />
      <div style={{ fontSize: 15, color: "#33425c", lineHeight: 1.5 }}>
        Hi {insp.name}, pick a time for <b style={{ color: NAVY }}>{insp.rep}</b> to come by and walk you through your roof inspection{insp.address ? <> at <b>{insp.address}</b></> : null}.
      </div>
    </div>
  );

  if (done) {
    return shell(<>{header}
      <div style={{ background: "#f0f9f2", border: "1px solid #bfe0c4", borderRadius: 16, padding: "26px 20px", textAlign: "center" }}>
        <div style={{ fontSize: 40 }}>✅</div>
        <div style={{ fontSize: 18, fontWeight: 800, color: "#1c6b34", marginTop: 6 }}>You're booked!</div>
        <div style={{ fontSize: 15, color: "#33612f", marginTop: 6 }}>{dayKey(done.start_at)} at {timeLabel(done.start_at)}</div>
        <div style={{ fontSize: 13, color: MUTE, marginTop: 12 }}>{insp.rep} will see you then. If you need to change it, just call the office.</div>
      </div>
    </>);
  }

  const byDay = {};
  for (const s of (slots || [])) { const k = dayKey(s.start_at); (byDay[k] = byDay[k] || []).push(s); }
  const days = Object.keys(byDay);

  return shell(<>{header}
    {slots === null ? <div style={{ color: MUTE, padding: "20px 0" }}>Loading times…</div>
      : !days.length ? <div style={{ background: "#fff", border: `1px solid ${LINE}`, borderRadius: 14, padding: 20, color: MUTE }}>No open times right now — please call the office and we'll get you set up.</div>
      : days.map((d) => (
        <div key={d} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: MUTE, textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 8 }}>{d}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {byDay[d].map((s) => (
              <button key={s.start_at} onClick={() => book(s)} disabled={!!booking}
                style={{ background: booking === s.start_at ? NAVY : "#fff", color: booking === s.start_at ? "#fff" : NAVY, border: `1.5px solid ${LINE}`, borderRadius: 11, padding: "11px 16px", fontSize: 15, fontWeight: 800, cursor: booking ? "default" : "pointer", opacity: booking && booking !== s.start_at ? 0.5 : 1 }}>
                {booking === s.start_at ? "Booking…" : timeLabel(s.start_at)}
              </button>
            ))}
          </div>
        </div>
      ))}
    {err ? <div style={{ color: RED, fontSize: 13.5, marginTop: 8 }}>{err}</div> : null}
  </>);
}
