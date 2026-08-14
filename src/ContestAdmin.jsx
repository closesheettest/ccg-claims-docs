// Admin on/off for the Positive-Effort Contest leaderboard. Flip it live (or keep
// it off — e.g. for Week 1) with one switch; the rep dashboard board and the
// zone-contest-leaderboard feed both gate on app_settings.contest_enabled.
// Also shows the current standings (preview) so you can see it before going live.
import React, { useEffect, useState } from "react";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const TEAM_COLOR = { SQUAD: "#e11d48", SitSold: "#2563eb", SHARKS: "#16a34a", HURRICANE: "#f97316" };

export default function ContestAdmin() {
  const [enabled, setEnabled] = useState(null); // null=loading
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [board, setBoard] = useState(null); // { week, zones } | null
  const [boardErr, setBoardErr] = useState(false);

  useEffect(() => {
    fetch("/.netlify/functions/contest-settings").then((r) => r.json())
      .then((d) => setEnabled(d && d.ok ? !!d.enabled : false)).catch(() => setEnabled(false));
  }, []);

  // Show the standings. When it's off we preview (trailing 7 days); when live we show
  // the real contest window.
  const loadBoard = (isEnabled) => {
    const q = isEnabled ? "" : "?preview=1";
    fetch(`/.netlify/functions/zone-contest-leaderboard${q}`).then((r) => r.json())
      .then((d) => { if (d && d.ok) { setBoard(d); setBoardErr(false); } else setBoardErr(true); })
      .catch(() => setBoardErr(true));
  };
  useEffect(() => { if (enabled !== null) loadBoard(enabled); }, [enabled]);

  const toggle = async () => {
    const next = !enabled;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/.netlify/functions/contest-settings", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: next }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "Save failed");
      setEnabled(!!d.enabled);
    } catch (e) { setErr(e.message || "Save failed"); }
    setBusy(false);
  };

  if (enabled === null) return <div style={{ fontFamily: FONT, padding: 40, color: "#64748b" }}>Loading…</div>;

  const zones = (board && board.zones) || [];
  const maxAvg = Math.max(1, ...zones.map((z) => z.avg || 0));

  return (
    <div style={{ fontFamily: FONT, maxWidth: 640, margin: "0 auto", padding: "24px 16px 80px", color: "#0f172a" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 28 }}>🏁</span>
        <h1 style={{ fontSize: 25, fontWeight: 800, margin: 0, fontFamily: OSWALD }}>Positive-Effort Contest</h1>
      </div>
      <p style={{ color: "#64748b", fontSize: 14, margin: "0 0 18px" }}>
        This is your admin control. The switch below is what every rep sees — flip it on when you're
        ready (you can keep it off for Week 1). It saves instantly, no one else can change it.
      </p>

      {/* Master on/off */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, background: enabled ? "#f0fdf4" : "#f8fafc", border: `1px solid ${enabled ? "#bbf7d0" : "#e5e7eb"}`, borderRadius: 14, padding: "16px 18px", marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: OSWALD }}>The contest board is {enabled ? "LIVE" : "OFF"}</div>
          <div style={{ fontSize: 12.5, color: "#64748b" }}>{enabled ? "Reps see the 🏁 Contest board on their dashboard now." : "Hidden from reps. Nothing shows until you switch it on."}</div>
        </div>
        <button type="button" onClick={toggle} disabled={busy}
          style={{ position: "relative", width: 58, height: 32, borderRadius: 999, border: "none", cursor: busy ? "default" : "pointer", background: enabled ? "#16a34a" : "#cbd5e1", flexShrink: 0 }}>
          <span style={{ position: "absolute", top: 3, left: enabled ? 29 : 3, width: 26, height: 26, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "left .15s" }} />
        </button>
      </div>
      {err && <div style={{ color: "#b91c1c", fontSize: 13.5, marginBottom: 12 }}>{err}</div>}

      {/* Standings */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "#334155" }}>Standings · avg pts / rep</div>
        <div style={{ fontSize: 12, color: "#94a3b8" }}>{enabled ? (board ? board.week : "") : "Sample · last 7 days"}</div>
      </div>
      {boardErr && <div style={{ fontSize: 13, color: "#64748b" }}>Couldn't load the standings right now.</div>}
      {!boardErr && !zones.length && <div style={{ fontSize: 13, color: "#64748b" }}>No points yet.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {zones.map((z, i) => (
          <div key={z.zone} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 800, width: 22, color: "#94a3b8", fontFamily: OSWALD }}>{i + 1}</span>
              <span style={{ flex: 1, fontSize: 15, fontWeight: 800, fontFamily: OSWALD, color: TEAM_COLOR[z.team] || "#0f172a" }}>{z.team}</span>
              <span style={{ fontSize: 17, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{z.avg}</span>
              <span style={{ fontSize: 11, color: "#94a3b8" }}>pts/rep</span>
            </div>
            <div style={{ height: 7, background: "#f1f5f9", borderRadius: 999, marginTop: 8, overflow: "hidden" }}>
              <div style={{ width: `${Math.round(((z.avg || 0) / maxAvg) * 100)}%`, height: "100%", background: TEAM_COLOR[z.team] || "#0f172a", borderRadius: 999 }} />
            </div>
            <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 6 }}>{z.points} pts total · {z.activeReps} reps{z.sales ? ` · ${z.sales} sold` : ""}</div>
          </div>
        ))}
      </div>

      {!enabled && (
        <div style={{ marginTop: 20, padding: "12px 14px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, fontSize: 12.5, color: "#1e40af" }}>
          👀 The numbers above are just a <b>7-day sample of activity</b> so you can see the board's shape while it's off — <b>not</b> the contest score. Flip the switch on and it scores only the live Wed/Thu contest days.
        </div>
      )}
    </div>
  );
}
