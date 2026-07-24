// DoorDispatcher — Jobsite Foreman Links (?mode=foremanlinks). The install-side
// equivalent of Rep Links: the roster of jobsite foremen (pulled from the
// "Jobsite Foreman" field on current install jobs) with their live install
// count. Personal foreman links + day-planning + tracking (same as reps) come
// next — this is the roster foundation.
import React, { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";
import HarvestNav from "./HarvestNav";

const OSWALD = "'Oswald', sans-serif";
const FONT = "'Nunito', system-ui, sans-serif";
const PALETTE = ["#2563eb", "#16a34a", "#ea580c", "#7c3aed", "#dc2626", "#0891b2", "#ca8a04", "#db2777", "#4d7c0f", "#9333ea", "#0d9488", "#b45309", "#1d4ed8", "#be123c", "#15803d", "#c026d3"];
const colorFor = (f, i) => (f === "Unassigned" ? "#94a3b8" : PALETTE[i % PALETTE.length]);

export default function ForemanLinks() {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.from("app_settings").select("value").eq("key", "visit_token").maybeSingle();
        const token = data?.value;
        if (!token) { setState({ loading: false, error: "Map token not set." }); return; }
        const r = await fetch(`/.netlify/functions/installs-live?token=${encodeURIComponent(token)}`);
        const j = await r.json();
        if (!j.ok) { setState({ loading: false, error: j.error || "Couldn't load foremen." }); return; }
        const counts = {};
        (j.installs || []).forEach((it) => { counts[it.foreman] = (counts[it.foreman] || 0) + 1; });
        const foremen = (j.foremen || []).map((name) => ({ name, count: counts[name] || 0 }));
        setState({ loading: false, foremen, total: (j.installs || []).length });
      } catch (e) { setState({ loading: false, error: e.message || "Load failed" }); }
    })();
  }, []);

  return (
    <div style={{ fontFamily: FONT, maxWidth: 720, margin: "0 auto", padding: "18px 16px 80px" }}>
      <HarvestNav active="foremanlinks" />
      <h1 style={{ fontFamily: OSWALD, fontSize: 26, fontWeight: 800, margin: "18px 0 4px", color: "#0f172a" }}>🔗 Jobsite Foreman Links</h1>
      <p style={{ fontSize: 14, color: "#64748b", margin: "0 0 20px", maxWidth: "60ch" }}>
        Every jobsite foreman currently on an install, pulled live from JobNimbus. Personal links + day-planning + live tracking (same as reps) are coming next — this is the roster.
      </p>

      {state.loading && <div style={{ color: "#64748b" }}>Loading foremen…</div>}
      {state.error && <div style={{ color: "#b91c1c", fontWeight: 700 }}>{state.error}</div>}

      {!state.loading && !state.error && (
        <>
          <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 12 }}>{state.foremen.length} foremen · {state.total} current installs</div>
          <div style={{ display: "grid", gap: 8 }}>
            {state.foremen.map((f, i) => (
              <div key={f.name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: "1px solid #e5e7eb", borderRadius: 12, background: "#fff" }}>
                <span style={{ width: 16, height: 16, borderRadius: "50%", background: colorFor(f.name, i), flexShrink: 0, border: "2px solid #fff", boxShadow: "0 0 0 1px rgba(0,0,0,.1)" }} />
                <span style={{ fontFamily: OSWALD, fontWeight: 700, fontSize: 16, color: "#0f172a", flex: 1 }}>{f.name}</span>
                <span style={{ fontSize: 12.5, color: "#64748b", fontWeight: 700 }}>{f.count} install{f.count === 1 ? "" : "s"}</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: "#94a3b8", background: "#f1f5f9", borderRadius: 999, padding: "4px 10px" }}>link soon</span>
              </div>
            ))}
            {!state.foremen.length && <div style={{ color: "#94a3b8" }}>No foremen on current installs.</div>}
          </div>
        </>
      )}
    </div>
  );
}
