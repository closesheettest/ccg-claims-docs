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

      <div style={{ marginTop: 24, padding: "12px 14px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, fontSize: 12.5, color: "#166534" }}>
        ✅ <b>Live.</b> When the toggle above is ON, the sequence fires automatically after each inspection and stops the moment the homeowner books. Texts only go out <b>8 AM–9 PM ET</b>, and only for inspections completed <b>after this went live</b> (it never blasts old ones). The <code>{"{link}"}</code> opens the homeowner's booking page (their rep's come-back times) — booking drops the appointment on the rep's JobNimbus + map and texts the rep.
      </div>

      <GobackReport />
    </div>
  );
}

// The funnel report — who got texted and who self-scheduled. For running numbers.
function GobackReport() {
  const [data, setData] = useState(null);
  useEffect(() => {
    fetch("/.netlify/functions/goback-report").then((r) => r.json()).then((d) => setData(d && d.ok ? d : { rows: [], summary: { texted: 0, booked: 0, rate: 0 } })).catch(() => setData({ rows: [], summary: { texted: 0, booked: 0, rate: 0 } }));
  }, []);
  const when = (iso) => { try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch { return ""; } };
  const S = data?.summary || { texted: 0, booked: 0, rate: 0 };
  return (
    <div style={{ marginTop: 30 }}>
      <h2 style={{ fontSize: 19, fontWeight: 800, fontFamily: OSWALD, margin: "0 0 4px", color: "#0f172a" }}>📊 Results — texted vs. self-scheduled</h2>
      <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 12px" }}>Every homeowner the sequence texted, and whether they booked their own come-back review.</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        {[["Texted", S.texted, "#0f2a4a"], ["Self-scheduled", S.booked, "#16a34a"], ["Book rate", `${S.rate}%`, "#c0392b"]].map(([l, v, c]) => (
          <div key={l} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px 16px", minWidth: 110 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: c }}>{v}</div>
            <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "#94a3b8" }}>{l}</div>
          </div>
        ))}
      </div>
      {!data ? <div style={{ color: "#94a3b8", fontSize: 13 }}>Loading…</div>
        : !data.rows.length ? <div style={{ background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, color: "#94a3b8", fontSize: 13.5 }}>No texts sent yet — rows appear here after the first inspection triggers the sequence.</div>
        : (
          <div style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead><tr style={{ background: "#f8fafc", textAlign: "left" }}>
                {["Homeowner", "Rep", "Texts", "First", "Last", "Booked?"].map((h) => <th key={h} style={{ padding: "9px 12px", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".04em", color: "#64748b", whiteSpace: "nowrap" }}>{h}</th>)}
              </tr></thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={i} style={{ borderTop: "1px solid #eef2f7", background: r.booked ? "#f0fdf4" : "#fff" }}>
                    <td style={{ padding: "9px 12px" }}><div style={{ fontWeight: 700, color: "#0f172a" }}>{r.name}</div><div style={{ fontSize: 11.5, color: "#94a3b8" }}>{r.phone}</div></td>
                    <td style={{ padding: "9px 12px", color: "#475569" }}>{r.rep}</td>
                    <td style={{ padding: "9px 12px", fontWeight: 700, textAlign: "center" }}>{r.texts}</td>
                    <td style={{ padding: "9px 12px", color: "#64748b", whiteSpace: "nowrap" }}>{when(r.first_sent)}</td>
                    <td style={{ padding: "9px 12px", color: "#64748b", whiteSpace: "nowrap" }}>{when(r.last_sent)}</td>
                    <td style={{ padding: "9px 12px", whiteSpace: "nowrap" }}>{r.booked ? <span style={{ color: "#16a34a", fontWeight: 800 }}>✓ {when(r.review_appt_at)}</span> : <span style={{ color: "#cbd5e1" }}>—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}
