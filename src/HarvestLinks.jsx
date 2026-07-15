// Harvesting Map — rep links & access (?mode=harvestlinks). Office-only.
// The office's own "view all" map link, plus every rep's personal link (with
// their level) to copy and hand out. A rep only sees the pins their level allows.
import React, { useEffect, useState } from "react";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";

export default function HarvestLinks() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/.netlify/functions/harvest-rep-links");
        const j = await r.json().catch(() => ({}));
        if (!j.ok) { setErr(j.error || "Couldn't load."); return; }
        setData(j);
      } catch (e) { setErr(e.message || "Network error"); }
    })();
  }, []);

  const copy = (text, id) => {
    try { navigator.clipboard.writeText(text); setCopied(id); setTimeout(() => setCopied(""), 1500); }
    catch { window.prompt("Copy this link:", text); }
  };

  const reps = (data?.reps || []).filter((r) => !q.trim() || (r.name || "").toLowerCase().includes(q.toLowerCase()));

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "20px 16px 60px", fontFamily: FONT }}>
      <HarvestNav active="links" />
      <div style={{ fontSize: 22, fontWeight: 800, fontFamily: OSWALD, marginBottom: 4 }}>🔗 Rep Links &amp; Access</div>
      <div style={{ fontSize: 13.5, color: "#64748b", marginBottom: 16 }}>Each rep opens their <b>personal link</b> to work the map — they only see the pin types their level (senior / junior) is allowed to see.</div>

      {err && <div style={{ color: "#b91c1c", fontSize: 13.5, marginBottom: 12 }}>{err}</div>}
      {!data && !err ? <div style={{ color: "#94a3b8", fontSize: 13 }}>Loading…</div> : null}

      {data?.admin_link && (
        <div style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 12, padding: 14, marginBottom: 20, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", background: "#7c3aed", color: "#fff", padding: "3px 10px", borderRadius: 10 }}>Office</span>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#4c1d95" }}>Your view — every pin</div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <a href={data.admin_link} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 700, color: "#fff", background: "#7c3aed", borderRadius: 8, padding: "7px 14px", textDecoration: "none" }}>Open map ↗</a>
            <button type="button" onClick={() => copy(data.admin_link, "admin")} style={btn}>{copied === "admin" ? "✓ Copied" : "Copy link"}</button>
          </div>
        </div>
      )}

      {data && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: OSWALD }}>Reps ({data.reps.length})</div>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reps…" style={{ fontSize: 13, padding: "7px 10px", borderRadius: 8, border: "1px solid #cbd5e1", minWidth: 180 }} />
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            {reps.map((r, i) => {
              const showRegion = i === 0 || r.region !== reps[i - 1].region;
              return (
              <React.Fragment key={r.link}>
                {showRegion && <div style={{ fontSize: 13, fontWeight: 800, fontFamily: OSWALD, color: "#0f172a", margin: i === 0 ? "0 0 2px" : "12px 0 2px" }}>📍 {r.region || "No region"}</div>}
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", border: "1px solid #e5e7eb", borderRadius: 10, padding: "9px 12px", background: "#fff" }}>
                <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", background: r.level === "senior" ? "#16a34a" : "#334155", color: "#fff", padding: "2px 8px", borderRadius: 10 }}>{r.level}</span>
                <span style={{ fontSize: 14, fontWeight: 700 }}>{r.name}</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <a href={r.link} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, fontWeight: 700, color: "#0e7490", textDecoration: "none" }}>Open ↗</a>
                  <button type="button" onClick={() => copy(r.link, r.link)} style={btn}>{copied === r.link ? "✓ Copied" : "Copy link"}</button>
                </div>
              </div>
              </React.Fragment>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const btn = { fontSize: 12.5, fontWeight: 700, color: "#334155", background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 12px", cursor: "pointer" };
