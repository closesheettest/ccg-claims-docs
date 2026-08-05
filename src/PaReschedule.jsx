// Homeowner self-reschedule page (?mode=pareschedule&t=<token>). Opened from the
// text/email we send after a missed PA appointment. Loads the appointment by its
// private token, shows open times, and books the new one (cancelling the old).
import React, { useEffect, useMemo, useState } from "react";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const NAVY = "#0f2557";
const api = async (action, payload) => {
  const r = await fetch("/.netlify/functions/pa-reschedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload }) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.error || "Something went wrong");
  return j;
};
const dayKey = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const dayLabel = (iso) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" });
const timeLabel = (iso) => new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
// Light markdown so the office can emphasize the pitch. The composer's toolbar
// writes these markers; keep the two in sync.
//   **bold**   ~~bigger~~   __italic__   ==highlight==   !!red!!   (*legacy bigger*)
// Recursive + lazy so styles STACK (e.g. bold+bigger+red = **~~!!words!!~~**) and an
// internal "!" (e.g. "COST YOU LESS!") doesn't break the red marker. Bigger has its
// own ~~ delimiter so it never collides with ** bold; single *…* stays as a legacy
// alias so pitches saved before the toolbar still render bigger.
const RICH_RE = /(\*\*[\s\S]+?\*\*|__[\s\S]+?__|~~[\s\S]+?~~|==[\s\S]+?==|!![\s\S]+?!!|\*[\s\S]+?\*)/g;
const BIG = { fontSize: "1.18em", fontWeight: 800 };
function renderRich(text, depth = 0) {
  const s = String(text || "");
  if (depth > 5) return s; // safety net against pathological nesting
  return s.split(RICH_RE).map((p, i) => {
    const inner = (a, b) => renderRich(p.slice(a, b), depth + 1);
    if (/^\*\*[\s\S]+\*\*$/.test(p)) return <b key={i} style={{ fontWeight: 900 }}>{inner(2, -2)}</b>;
    if (/^__[\s\S]+__$/.test(p)) return <i key={i}>{inner(2, -2)}</i>;
    if (/^~~[\s\S]+~~$/.test(p)) return <span key={i} style={BIG}>{inner(2, -2)}</span>;
    if (/^==[\s\S]+==$/.test(p)) return <mark key={i} style={{ background: "#fde047", padding: "0 3px", borderRadius: 3 }}>{inner(2, -2)}</mark>;
    if (/^!![\s\S]+!!$/.test(p)) return <span key={i} style={{ color: "#dc2626", fontWeight: 800 }}>{inner(2, -2)}</span>;
    if (/^\*[\s\S]+\*$/.test(p)) return <span key={i} style={BIG}>{inner(1, -1)}</span>;
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}

export default function PaReschedule() {
  const token = useMemo(() => { try { return new URLSearchParams(window.location.search).get("t") || ""; } catch { return ""; } }, []);
  const preview = useMemo(() => { try { return new URLSearchParams(window.location.search).get("preview") === "1"; } catch { return false; } }, []);
  const [appt, setAppt] = useState(null);
  const [slots, setSlots] = useState(null);
  const [err, setErr] = useState("");
  const [booking, setBooking] = useState("");
  const [done, setDone] = useState(null);
  const [zoom, setZoom] = useState(null);   // enlarged damage photo (URL) or null

  useEffect(() => {
    if (preview) {
      (async () => { try { const j = await api("preview", {}); setAppt(j.appt); setSlots([]); } catch (e) { setErr(e.message); } })();
      return;
    }
    if (!token) { setErr("This link is missing its code — please use the link from your text or email."); return; }
    (async () => {
      try { const j = await api("load", { t: token }); setAppt(j.appt); } catch (e) { setErr(e.message); return; }
      try { const j = await api("slots", { t: token }); setSlots(j.slots || []); } catch (e) { setErr(e.message); setSlots([]); }
    })();
  }, [token, preview]);

  const book = async (s) => {
    setBooking(s.start_at + s.pa_id); setErr("");
    try { await api("book", { t: token, pa_id: s.pa_id, start_at: s.start_at }); setDone(s); }
    catch (e) { setErr(e.message); }
    setBooking("");
  };

  const byDay = useMemo(() => {
    const m = {};
    for (const s of (slots || [])) { const k = dayKey(s.start_at); (m[k] = m[k] || []).push(s); }
    // one time per hour per day (first PA available) to keep it simple for the homeowner
    for (const k of Object.keys(m)) {
      const seen = new Set(), out = [];
      for (const s of m[k].sort((a, b) => new Date(a.start_at) - new Date(b.start_at))) { const t = timeLabel(s.start_at); if (seen.has(t)) continue; seen.add(t); out.push(s); }
      m[k] = out;
    }
    return m;
  }, [slots]);

  if (done) return (
    <Wrap>
      <div style={{ textAlign: "center", padding: "20px 0" }}>
        <div style={{ fontSize: 46 }}>✅</div>
        <div style={{ fontSize: 21, fontWeight: 800, fontFamily: OSWALD, color: "#16a34a", marginTop: 6 }}>You're all set!</div>
        <div style={{ fontSize: 15, color: "#334155", marginTop: 8, lineHeight: 1.55 }}>Your roof adjuster appointment is booked for<br /><b>{dayLabel(done.start_at)} at {timeLabel(done.start_at)}</b>.</div>
        <div style={{ fontSize: 13.5, color: "#64748b", marginTop: 10 }}>We'll see you then. You can close this page.</div>
      </div>
    </Wrap>
  );

  if (err && !appt) return <Wrap><Msg text={err} /></Wrap>;
  if (!appt) return <Wrap><Msg text="Loading your appointment…" plain /></Wrap>;

  const dayKeys = Object.keys(byDay).sort();
  const firstName = (appt.name || "there").split(" ")[0];
  const photos = Array.isArray(appt.photos) ? appt.photos : [];
  const isDamage = appt.result === "damage";
  const pitch = appt.pitch || {};
  return (
    <Wrap>
      {preview && <div style={{ background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 10, padding: "8px 12px", marginBottom: 14, fontSize: 12.5, fontWeight: 800, color: "#4338ca" }}>👁 PREVIEW — sample homeowner &amp; photos. This is exactly what a homeowner sees.</div>}
      {/* 1) THE PROOF — why they need this appointment: their own roof, documented.
             Headline + body are an OFFICE-EDITABLE pitch (appt.pitch), tokens filled
             server-side. Falls back to the default copy if the feed is old. */}
      {isDamage && (pitch.headline || pitch.body) && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 14, padding: "12px 14px", marginBottom: 16 }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: "#b91c1c", textTransform: "uppercase", letterSpacing: ".04em" }}>⚠️ Inspection result</div>
          {pitch.headline && <div style={{ fontSize: 20, fontWeight: 900, fontFamily: OSWALD, color: "#991b1b", marginTop: 3 }}>{pitch.headline}</div>}
          {pitch.body && <div style={{ fontSize: 15.5, color: "#7f1d1d", marginTop: 8, lineHeight: 1.65, whiteSpace: "pre-wrap", fontWeight: 500 }}>{renderRich(pitch.body)}</div>}
        </div>
      )}

      {photos.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 800, fontFamily: OSWALD, color: NAVY, marginBottom: 8 }}>What our inspector found on your roof</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
            {photos.map((u, i) => (
              <button key={i} onClick={() => setZoom(u)} style={{ padding: 0, border: "none", borderRadius: 10, overflow: "hidden", aspectRatio: "1 / 1", cursor: "pointer", background: "#e2e8f0" }}>
                <img src={u} alt={`Roof photo ${i + 1}`} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 6 }}>Tap any photo to enlarge.</div>
        </div>
      )}

      {/* 2) THE ASK — schedule with the Public Adjuster (reschedule the missed appt). */}
      <style>{`@keyframes paCtaPulse{0%,100%{transform:scale(1);box-shadow:0 4px 14px rgba(22,163,74,.35),0 0 0 0 rgba(22,163,74,.5)}50%{transform:scale(1.035);box-shadow:0 4px 14px rgba(22,163,74,.35),0 0 0 12px rgba(22,163,74,0)}}@media(prefers-reduced-motion:reduce){.pa-cta-flash{animation:none!important}}`}</style>
      <div className="pa-cta-flash" style={{ textAlign: "center", background: "#16a34a", color: "#fff", fontFamily: OSWALD, fontWeight: 900, fontSize: 21, letterSpacing: ".03em", padding: "15px 16px", borderRadius: 14, marginBottom: 12, animation: "paCtaPulse 1.25s ease-in-out infinite" }}>
        📅 SCHEDULE YOUR APPOINTMENT
      </div>
      <div style={{ fontSize: 24, fontWeight: 900, fontFamily: OSWALD, color: NAVY }}>Schedule with your Public Adjuster</div>
      <div style={{ fontSize: 14.5, color: "#334155", marginTop: 6, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
        {isDamage ? renderRich(pitch.schedule || "We missed you last time — pick a new time and a Public Adjuster will meet you to get your claim started:")
                  : <>Hi {firstName} — we missed you for your roof adjuster appointment{appt.address ? <> at <b>{[appt.address, appt.city].filter(Boolean).join(", ")}</b></> : ""}. Pick a new time that works for you:</>}
      </div>
      {err && <div style={{ color: "#b91c1c", fontSize: 13.5, marginTop: 12, fontWeight: 700 }}>{err}</div>}
      {preview ? <div style={{ marginTop: 16, padding: 14, background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 12, color: "#64748b", fontSize: 13.5 }}>🗓️ The homeowner picks from their available Five Star appointment times here.</div>
        : slots === null ? <Msg text="Finding open times…" plain />
        : !dayKeys.length ? <div style={{ marginTop: 16, color: "#64748b", fontSize: 14 }}>No open times online right now — we'll call you to set one up.</div>
        : (
        <div style={{ marginTop: 18, display: "grid", gap: 16 }}>
          {dayKeys.map((k) => (
            <div key={k}>
              <div style={{ fontSize: 14, fontWeight: 800, fontFamily: OSWALD, color: NAVY, marginBottom: 8 }}>{dayLabel(byDay[k][0].start_at)}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {byDay[k].map((s) => (
                  <button key={s.start_at + s.pa_id} disabled={!!booking} onClick={() => book(s)}
                    style={{ fontSize: 14.5, fontWeight: 800, padding: "11px 16px", borderRadius: 12, border: "2px solid " + NAVY, background: booking === s.start_at + s.pa_id ? NAVY : "#fff", color: booking === s.start_at + s.pa_id ? "#fff" : NAVY, cursor: booking ? "default" : "pointer" }}>
                    {booking === s.start_at + s.pa_id ? "…" : timeLabel(s.start_at)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {zoom && (
        <div onClick={() => setZoom(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.88)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50, cursor: "zoom-out" }}>
          <img src={zoom} alt="Roof damage" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 10 }} />
        </div>
      )}
    </Wrap>
  );
}

function Wrap({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: "#f1f5f9", fontFamily: FONT, padding: "24px 16px" }}>
      <div style={{ maxWidth: 460, margin: "0 auto", background: "#fff", borderRadius: 18, padding: "24px 22px", boxShadow: "0 2px 14px rgba(0,0,0,.08)" }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 14 }}>U.S. Shingle &amp; Metal</div>
        {children}
      </div>
    </div>
  );
}
function Msg({ text, plain }) { return <div style={{ textAlign: "center", padding: "30px 0", color: plain ? "#94a3b8" : "#b91c1c", fontSize: 14.5, fontWeight: 700 }}>{text}</div>; }
