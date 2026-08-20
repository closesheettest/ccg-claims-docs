// src/GobackOutcome.jsx
//
// ?mode=gobackresult&rt=<rep token>&i=<inspection> — where the follow-up text
// lands. One question, four buttons, done in a thumb-tap at the kerb.
//
// This exists because nothing ever asked the rep how a come-back went, so the
// deal just sat there: the self-scheduler read 4 ran / 1 sold / 0 didn't sell,
// and the missing three were blanks rather than losses (Neal, 2026-08-20).
// Deliberately NOT part of the map — a rep gets a text an hour after the
// appointment and should be able to answer it without loading anything heavy.
import React, { useEffect, useState } from "react";

const OPTIONS = [
  { key: "sold", label: "Sold it", hint: "Signed the contract", color: "#16a34a" },
  { key: "no_sale", label: "Didn't sell", hint: "Sat with them, no deal today", color: "#b45309" },
  { key: "ni", label: "Not interested", hint: "They're out — don't chase it", color: "#64748b" },
  { key: "not_home", label: "Wasn't home", hint: "Nobody there — we'll try them again", color: "#475569" },
];

export default function GobackOutcome() {
  const q = new URLSearchParams(window.location.search);
  const rt = q.get("rt") || "";
  const i = q.get("i") || "";
  const [state, setState] = useState({ loading: true });
  const [busy, setBusy] = useState(null);
  const [done, setDone] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/.netlify/functions/goback-outcome?rt=${encodeURIComponent(rt)}&i=${encodeURIComponent(i)}`);
        const o = await r.json();
        if (!r.ok || !o.ok) { setState({ loading: false, error: o.error || "Couldn't open that." }); return; }
        setState({ loading: false, ...o });
      } catch { setState({ loading: false, error: "Couldn't reach the server." }); }
    })();
  }, [rt, i]);

  async function pick(outcome) {
    setBusy(outcome); setErr("");
    try {
      const r = await fetch("/.netlify/functions/goback-outcome", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rt, inspection_id: i, outcome }),
      });
      const o = await r.json();
      if (!r.ok || !o.ok) { setErr(o.error || "Couldn't record that."); setBusy(null); return; }
      setDone(outcome);
    } catch { setErr("Couldn't reach the server."); }
    setBusy(null);
  }

  const wrap = { minHeight: "100vh", background: "#f8fafc", padding: "26px 16px 60px", fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" };
  const card = { maxWidth: 460, margin: "0 auto", background: "#fff", borderRadius: 16, padding: "22px 20px", boxShadow: "0 1px 3px rgba(15,23,42,.1)" };

  if (state.loading) return <div style={wrap}><div style={{ ...card, textAlign: "center", color: "#64748b" }}>Loading…</div></div>;
  if (state.error) return <div style={wrap}><div style={{ ...card, textAlign: "center" }}><div style={{ fontSize: 30 }}>🔒</div><div style={{ fontWeight: 800, marginTop: 6, color: "#0f172a" }}>{state.error}</div></div></div>;

  const d = state.deal || {};
  const where = [d.address, d.city].filter(Boolean).join(", ");
  const when = d.appt_at ? new Date(d.appt_at).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;

  if (done) {
    const o = OPTIONS.find((x) => x.key === done);
    return (
      <div style={wrap}>
        <div style={{ ...card, textAlign: "center" }}>
          <div style={{ fontSize: 40 }}>✅</div>
          <div style={{ fontWeight: 900, fontSize: 20, color: "#0f172a", marginTop: 6 }}>Got it — {o ? o.label.toLowerCase() : done}</div>
          <div style={{ color: "#64748b", fontSize: 14, marginTop: 8, lineHeight: 1.5 }}>
            {done === "not_home"
              ? "We'll keep working on getting them home. Nothing else for you to do."
              : "JobNimbus is updated. Nothing else for you to do."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: "#7c3aed" }}>Come-back review</div>
        <h1 style={{ fontSize: 24, fontWeight: 900, color: "#0f172a", margin: "6px 0 2px", lineHeight: 1.2 }}>How did it go?</h1>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a", marginTop: 12 }}>{d.client_name || "Homeowner"}</div>
        {where && <div style={{ fontSize: 14, color: "#64748b", marginTop: 2 }}>{where}</div>}
        {when && <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 2 }}>Booked for {when} ET</div>}

        {d.already ? (
          <div style={{ marginTop: 18, background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 12, padding: "14px 16px" }}>
            <div style={{ fontWeight: 800, color: "#0f172a", fontSize: 14 }}>This one's already answered</div>
            <div style={{ color: "#64748b", fontSize: 13.5, marginTop: 4, lineHeight: 1.5 }}>
              It's recorded as <b>{d.already.outcome}</b>{d.already.by ? ` by ${d.already.by}` : ""}. If that's wrong, tell your manager rather than
              recording a second one on top of it.
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gap: 10, marginTop: 20 }}>
              {OPTIONS.map((o) => (
                <button key={o.key} type="button" disabled={!!busy} onClick={() => pick(o.key)}
                  style={{
                    textAlign: "left", padding: "14px 16px", borderRadius: 12, cursor: busy ? "wait" : "pointer",
                    border: `2px solid ${o.color}`, background: busy === o.key ? o.color : "#fff",
                    color: busy === o.key ? "#fff" : o.color, opacity: busy && busy !== o.key ? 0.45 : 1,
                  }}>
                  <div style={{ fontWeight: 900, fontSize: 16 }}>{busy === o.key ? "Saving…" : o.label}</div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, opacity: 0.8, marginTop: 1 }}>{o.hint}</div>
                </button>
              ))}
            </div>
            {err && <div style={{ marginTop: 14, background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: 10, padding: "10px 12px", fontSize: 13.5 }}>{err}</div>}
            <div style={{ marginTop: 16, fontSize: 12.5, color: "#94a3b8", lineHeight: 1.5 }}>
              Whichever you tap updates JobNimbus for you. It takes one tap so the office stops having to chase you for it.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
