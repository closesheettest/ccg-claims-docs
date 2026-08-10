// Admin CMS for the "auto-schedule the go-back after an inspection" text sequence.
// Full control: master on/off, and an ordered list of messages — each with its own
// wait (days after the inspection), send time, and body. Add/remove messages; the
// count IS how many texts go out. Reads/writes goback-autoschedule-config.
import React, { useEffect, useState } from "react";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const TOKENS = ["{name}", "{rep}", "{link}", "{address}", "{company}"];

export default function GobackSchedule() {
  const [config, setConfig] = useState(null); // null=loading | {enabled, messages}
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/.netlify/functions/goback-autoschedule-config")
      .then((r) => r.json())
      .then((d) => setConfig(d && d.ok ? d.config : { enabled: false, messages: [] }))
      .catch(() => setConfig({ enabled: false, messages: [] }));
  }, []);

  const setMsg = (i, patch) => setConfig((c) => ({ ...c, messages: c.messages.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  const addMsg = () => setConfig((c) => ({ ...c, messages: [...c.messages, { delay_days: (c.messages[c.messages.length - 1]?.delay_days || 0) + 2, send_time: "10:00", body: "" }] }));
  const removeMsg = (i) => setConfig((c) => ({ ...c, messages: c.messages.filter((_, j) => j !== i) }));

  const save = async () => {
    setBusy(true); setErr(""); setSaved(false);
    try {
      const r = await fetch("/.netlify/functions/goback-autoschedule-config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "Save failed");
      setConfig(d.config); setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) { setErr(e.message || "Save failed"); }
    setBusy(false);
  };

  if (!config) return <div style={{ fontFamily: FONT, padding: 40, color: "#64748b" }}>Loading…</div>;

  const card = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: "16px 18px", marginBottom: 14 };
  const label = { fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "#64748b", marginBottom: 4, display: "block" };
  const input = { fontFamily: FONT, fontSize: 14, padding: "8px 10px", borderRadius: 9, border: "1px solid #cbd5e1", width: "100%", boxSizing: "border-box" };

  return (
    <div style={{ fontFamily: FONT, maxWidth: 760, margin: "0 auto", padding: "24px 16px 80px", color: "#0f172a" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 28 }}>🗓️</span>
        <h1 style={{ fontSize: 25, fontWeight: 800, margin: 0, fontFamily: OSWALD }}>Auto-Schedule After Inspection</h1>
      </div>
      <p style={{ color: "#64748b", fontSize: 14, margin: "0 0 18px" }}>
        After an inspection, the homeowner automatically gets these texts to book their come-back review. Control the on/off, each message's wait &amp; send time, and the body of every text. The number of messages is how many texts go out.
      </p>

      {/* Master on/off */}
      <div style={{ ...card, display: "flex", alignItems: "center", gap: 12, background: config.enabled ? "#f0fdf4" : "#f8fafc", borderColor: config.enabled ? "#bbf7d0" : "#e5e7eb" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 800, fontFamily: OSWALD }}>Auto-schedule is {config.enabled ? "ON" : "OFF"}</div>
          <div style={{ fontSize: 12.5, color: "#64748b" }}>{config.enabled ? "Homeowners get the sequence below after their inspection." : "No texts go out until you switch this on."}</div>
        </div>
        <button type="button" onClick={() => setConfig((c) => ({ ...c, enabled: !c.enabled }))}
          style={{ position: "relative", width: 52, height: 30, borderRadius: 999, border: "none", cursor: "pointer", background: config.enabled ? "#16a34a" : "#cbd5e1" }}>
          <span style={{ position: "absolute", top: 3, left: config.enabled ? 25 : 3, width: 24, height: 24, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "left .15s" }} />
        </button>
      </div>

      {/* Merge tokens helper */}
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
        Drop these into any message — they fill in automatically:{" "}
        {TOKENS.map((t) => <code key={t} style={{ background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: 6, padding: "1px 6px", margin: "0 3px", fontSize: 12 }}>{t}</code>)}
      </div>

      {/* Messages */}
      {config.messages.map((m, i) => (
        <div key={i} style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 800, fontFamily: OSWALD }}>{i === 0 ? "Message 1 · first text" : `Message ${i + 1}`}</div>
            <button type="button" onClick={() => removeMsg(i)} style={{ fontSize: 12, fontWeight: 700, color: "#b91c1c", background: "#fff", border: "1px solid #fecaca", borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}>Remove</button>
          </div>
          <div style={{ display: "flex", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
            <div style={{ minWidth: 150 }}>
              <label style={label}>Wait (days after inspection)</label>
              <input type="number" min="0" max="60" value={m.delay_days}
                onChange={(e) => setMsg(i, { delay_days: Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0))) })} style={{ ...input, width: 90 }} />
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 3 }}>{m.delay_days === 0 ? "same day as the inspection" : `${m.delay_days} day${m.delay_days > 1 ? "s" : ""} later`}</div>
            </div>
            <div style={{ minWidth: 130 }}>
              <label style={label}>Send time</label>
              <input type="time" value={m.send_time} onChange={(e) => setMsg(i, { send_time: e.target.value })} style={{ ...input, width: 130 }} />
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 3 }}>Eastern time</div>
            </div>
          </div>
          <label style={label}>Message body</label>
          <textarea value={m.body} onChange={(e) => setMsg(i, { body: e.target.value })} rows={3}
            style={{ ...input, resize: "vertical", lineHeight: 1.45 }} placeholder="What the homeowner receives…" />
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>{(m.body || "").length} characters</div>
        </div>
      ))}

      <button type="button" onClick={addMsg} style={{ width: "100%", background: "#fff", border: "2px dashed #cbd5e1", color: "#475569", borderRadius: 12, padding: "12px", fontSize: 14, fontWeight: 800, cursor: "pointer", marginBottom: 18 }}>
        + Add another message
      </button>

      {err && <div style={{ color: "#b91c1c", fontSize: 13.5, marginBottom: 10 }}>{err}</div>}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button type="button" onClick={save} disabled={busy}
          style={{ background: busy ? "#94a3b8" : "#2563eb", color: "#fff", border: "none", borderRadius: 12, padding: "13px 28px", fontSize: 15, fontWeight: 800, fontFamily: OSWALD, letterSpacing: "0.02em", cursor: busy ? "default" : "pointer" }}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        {saved && <span style={{ color: "#16a34a", fontSize: 14, fontWeight: 800 }}>✓ Saved</span>}
      </div>

      <div style={{ marginTop: 24, padding: "12px 14px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, fontSize: 12.5, color: "#92400e" }}>
        ⏳ <b>Not sending yet.</b> This page sets the messages &amp; cadence. Two pieces still to wire before it goes live: the <b>sender</b> (fires each text on schedule after an inspection, and stops once the homeowner books) and the <b>homeowner booking page</b> the <code>{"{link}"}</code> points to. The link shows the <b>assigned rep's</b> availability — so a deal signed by someone who won't run the go-back (e.g. William) must be assigned to a field rep on the manager dashboard first.
      </div>
    </div>
  );
}
