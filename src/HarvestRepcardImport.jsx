// DoorDispatcher — RepCard status import (?mode=harvestrepcardimport). Office
// uploads RepCard status exports (Not Interested / Dead / No Sale / Not Qualified)
// and this scrubs the map: matching IQ/FB/AI pins get flipped to their terminal
// status so reps stop re-knocking closed doors. MAP-ONLY (no JobNimbus writes).
// Preview first (counts only), then Apply. Idempotent — re-running is safe.
import React, { useState } from "react";
import HarvestNav from "./HarvestNav";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const FN = "/.netlify/functions/harvest-repcard-import";
const TARGET_LABEL = { dead: "Dead / DNK", iq_ni: "IQ – Not Interested", lost: "Lost" };

export default function HarvestRepcardImport() {
  const [files, setFiles] = useState([]);       // [{name, text}]
  const [results, setResults] = useState(null);  // [{name, ...summary}]
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [err, setErr] = useState("");

  async function onPick(e) {
    setResults(null); setApplied(false); setErr("");
    const picked = Array.from(e.target.files || []);
    const read = await Promise.all(picked.map((f) => f.text().then((text) => ({ name: f.name, text }))));
    setFiles(read);
  }

  async function run(apply) {
    if (!files.length) return;
    if (apply && !window.confirm("Apply these status changes to the live map? This flips the matched pins now.")) return;
    setBusy(true); setErr("");
    try {
      const out = [];
      for (const f of files) {
        const r = await fetch(FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csv: f.text, apply }) });
        const j = await r.json();
        if (!j.ok) { out.push({ name: f.name, error: j.error || "failed" }); continue; }
        out.push({ name: f.name, ...j });
      }
      setResults(out);
      if (apply) setApplied(true);
    } catch (e) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  }

  const totals = (results || []).reduce((a, r) => {
    if (r.error) return a;
    a.leads += r.leads_in_file || 0; a.would += r.would_change || 0; a.applied += r.applied || 0;
    for (const [k, v] of Object.entries(r.by_target || {})) a.byTarget[k] = (a.byTarget[k] || 0) + v;
    for (const s of ["pending", "unknown_status", "no_coords", "already_worked", "no_match"]) a.skipped[s] += (r.skipped?.[s] || 0);
    return a;
  }, { leads: 0, would: 0, applied: 0, byTarget: {}, skipped: { pending: 0, unknown_status: 0, no_coords: 0, already_worked: 0, no_match: 0 } });

  return (
    <div style={{ fontFamily: FONT, background: "#f1f5f9", minHeight: "100vh" }}>
      <HarvestNav active="upload" />
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "18px 16px 60px" }}>
        <h1 style={{ fontFamily: OSWALD, fontSize: 24, fontWeight: 800, margin: "6px 0 2px" }}>🧹 RepCard Status Import</h1>
        <p style={{ color: "#475569", fontSize: 14.5, lineHeight: 1.5, marginTop: 4 }}>
          Upload RepCard status exports. Matching <b>IQ / Facebook / AI Bot</b> pins get flipped so reps stop re-knocking closed doors:
          <b> Not Interested → IQ NI</b>, <b> Dead → Dead</b>, <b> No Sale / Not Qualified → Lost</b>. <b>Pending</b> is left live.
          Nothing is written to JobNimbus, and re-running is safe (worked pins are never touched twice).
        </p>

        <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 16, marginTop: 12 }}>
          <input type="file" accept=".csv,text/csv" multiple onChange={onPick} style={{ fontSize: 14 }} />
          {files.length > 0 && <div style={{ fontSize: 13, color: "#334155", marginTop: 8 }}>{files.length} file{files.length === 1 ? "" : "s"}: {files.map((f) => f.name).join(", ")}</div>}
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button type="button" disabled={!files.length || busy} onClick={() => run(false)}
              style={btn(!files.length || busy, "#0f172a")}>{busy ? "Working…" : "🔍 Preview"}</button>
            <button type="button" disabled={!results || busy || applied} onClick={() => run(true)}
              style={btn(!results || busy || applied, "#b45309")}>{applied ? "✓ Applied" : "✅ Apply changes"}</button>
          </div>
          {err && <p style={{ color: "#dc2626", fontSize: 13.5, marginTop: 10 }}>{err}</p>}
        </div>

        {results && (
          <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 16, marginTop: 14 }}>
            <div style={{ fontFamily: OSWALD, fontWeight: 800, fontSize: 17, marginBottom: 8 }}>
              {applied ? "Applied" : "Preview"} — {totals.would} pin{totals.would === 1 ? "" : "s"} {applied ? `changed (${totals.applied} written)` : "would change"}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
              {Object.entries(totals.byTarget).map(([k, v]) => (
                <span key={k} style={pill("#e0edff", "#1e40af")}>{TARGET_LABEL[k] || k}: <b>{v}</b></span>
              ))}
              <span style={pill("#f1f5f9", "#475569")}>Already worked: {totals.skipped.already_worked}</span>
              <span style={pill("#f1f5f9", "#475569")}>Pending (left): {totals.skipped.pending}</span>
              <span style={pill("#f1f5f9", "#475569")}>No map match: {totals.skipped.no_match}</span>
              <span style={pill("#f1f5f9", "#475569")}>No coords: {totals.skipped.no_coords}</span>
              {totals.skipped.unknown_status > 0 && <span style={pill("#fef3c7", "#92400e")}>Unknown status: {totals.skipped.unknown_status}</span>}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#64748b", fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em" }}>
                  <th style={{ padding: "6px 4px" }}>File</th>
                  <th style={{ padding: "6px 4px", textAlign: "right" }}>Leads</th>
                  <th style={{ padding: "6px 4px", textAlign: "right" }}>{applied ? "Changed" : "Would change"}</th>
                  <th style={{ padding: "6px 4px", textAlign: "right" }}>Already worked</th>
                  <th style={{ padding: "6px 4px", textAlign: "right" }}>No match</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.name} style={{ borderTop: "1px solid #eef2f7" }}>
                    <td style={{ padding: "7px 4px", fontWeight: 700 }}>{r.name}</td>
                    {r.error ? <td colSpan={4} style={{ padding: "7px 4px", color: "#dc2626" }}>{r.error}</td> : <>
                      <td style={{ padding: "7px 4px", textAlign: "right", color: "#475569" }}>{r.leads_in_file}</td>
                      <td style={{ padding: "7px 4px", textAlign: "right", fontWeight: 800, color: "#b45309" }}>{applied ? r.applied : r.would_change}</td>
                      <td style={{ padding: "7px 4px", textAlign: "right", color: "#94a3b8" }}>{r.skipped?.already_worked ?? 0}</td>
                      <td style={{ padding: "7px 4px", textAlign: "right", color: "#94a3b8" }}>{r.skipped?.no_match ?? 0}</td>
                    </>}
                  </tr>
                ))}
              </tbody>
            </table>
            {!applied && totals.would > 0 && <p style={{ fontSize: 12.5, color: "#64748b", marginTop: 10 }}>Preview only — nothing changed yet. Click <b>Apply changes</b> to write them.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function btn(disabled, bg) {
  return { padding: "10px 16px", borderRadius: 10, border: "none", background: disabled ? "#cbd5e1" : bg, color: "#fff", fontWeight: 800, fontSize: 14, cursor: disabled ? "default" : "pointer", fontFamily: OSWALD, letterSpacing: ".02em" };
}
function pill(bg, color) {
  return { background: bg, color, fontSize: 12.5, fontWeight: 700, padding: "4px 10px", borderRadius: 999 };
}
