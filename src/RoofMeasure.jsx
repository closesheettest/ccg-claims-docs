// DoorDispatcher — ROOF MEASUREMENT spot-check (?mode=roofmeasure). Office-only.
//
// Type an address, get a satellite roof measurement from Google's Solar API via
// our harvest-roof-report function: total squares (sloped surface + footprint),
// predominant pitch, facet count, and the flat-vs-sloped material split with our
// waste rules already applied. Every lookup is appended to a table so you can
// spot-check a batch of addresses and eyeball how it'll look before we build it
// into the rep flow. Nothing here is saved or synced — it's a proving ground.

import React, { useState, useRef, useEffect } from "react";
import RoofMeasureEditor from "./RoofMeasureEditor";

const FONT = "'Oswald', system-ui, sans-serif";
const CARD = { border: "1px solid #e5e7eb", borderRadius: 14, background: "#fff", padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,.05)" };
const LABEL = { fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", color: "#64748b", fontWeight: 700 };
const BIG = { fontSize: 30, fontWeight: 800, lineHeight: 1.1, color: "#0f172a" };

const fmtDate = (d) => (d && d.year ? `${d.month}/${d.day}/${d.year}` : "—");
const qColor = (q) => (q === "HIGH" ? "#16a34a" : q === "MEDIUM" ? "#d97706" : "#dc2626");

export default function RoofMeasure() {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [rows, setRows] = useState([]);     // history, newest first
  const inputRef = useRef(null);

  async function measure() {
    const addr = address.trim();
    if (!addr || busy) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/.netlify/functions/harvest-roof-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: addr }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || `Request failed (${r.status})`);
      setRows((prev) => [{ ...d, _addr: addr, _id: `${addr}-${prev.length}` }, ...prev]);
      setAddress("");
      inputRef.current?.focus();
    } catch (e) {
      setErr(e.message || "Lookup failed");
    } finally {
      setBusy(false);
    }
  }

  const latest = rows[0];

  return (
    <div style={{ fontFamily: FONT, maxWidth: 940, margin: "0 auto", padding: "24px 16px 80px", color: "#0f172a" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 30 }}>📐</span>
        <h1 style={{ fontSize: 27, fontWeight: 800, margin: 0 }}>Roof Measurement</h1>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 999, padding: "3px 9px" }}>SPOT-CHECK</span>
      </div>
      <p style={{ color: "#64748b", fontSize: 14, margin: "0 0 18px" }}>
        Type an address to pull a satellite roof measurement. Nothing is saved — this is just to see how it looks.
      </p>

      {/* Address input */}
      <div style={{ ...CARD, display: "flex", gap: 10, alignItems: "center", marginBottom: 18 }}>
        <input
          ref={inputRef}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") measure(); }}
          placeholder="4365 Birch Street NE, St. Petersburg, FL 33703"
          style={{ flex: 1, fontFamily: FONT, fontSize: 16, padding: "12px 14px", border: "1px solid #cbd5e1", borderRadius: 10, outline: "none" }}
          autoFocus
        />
        <button
          onClick={measure}
          disabled={busy || !address.trim()}
          style={{ fontFamily: FONT, fontSize: 16, fontWeight: 700, color: "#fff", background: busy || !address.trim() ? "#94a3b8" : "#2563eb", border: "none", borderRadius: 10, padding: "12px 22px", cursor: busy || !address.trim() ? "default" : "pointer", whiteSpace: "nowrap" }}
        >
          {busy ? "Measuring…" : "Measure"}
        </button>
      </div>

      {err && (
        <div style={{ ...CARD, borderColor: "#fecaca", background: "#fef2f2", color: "#b91c1c", marginBottom: 18, fontSize: 14 }}>
          ⚠️ {err}
        </div>
      )}

      {/* Latest result — detailed card */}
      {latest && <ResultCard d={latest} />}

      {/* History table */}
      {rows.length > 1 && (
        <div style={{ marginTop: 26 }}>
          <div style={{ ...LABEL, marginBottom: 8 }}>Spot-checked this session ({rows.length})</div>
          <div style={{ ...CARD, padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5, minWidth: 720 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#64748b", background: "#f8fafc" }}>
                  {["Address", "Total sq", "Pitch", "Facets", "Sloped (order)", "Flat (order)", "Imagery"].map((h) => (
                    <th key={h} style={{ padding: "10px 12px", fontWeight: 700, borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => {
                  const m = d.materials || {};
                  return (
                    <tr key={d._id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "10px 12px", maxWidth: 240 }}>{d.geocoded_as || d._addr}</td>
                      <td style={{ padding: "10px 12px", fontWeight: 700 }}>{d.roof?.surface_squares ?? "—"}</td>
                      <td style={{ padding: "10px 12px" }}>{d.roof?.avg_pitch_x12 != null ? `${d.roof.avg_pitch_x12}/12` : "—"}</td>
                      <td style={{ padding: "10px 12px" }}>{d.roof?.plane_count ?? "—"}</td>
                      <td style={{ padding: "10px 12px" }}>{m.sloped ? `${m.sloped.order_squares} sq @ ${m.sloped.waste_pct}%` : "—"}</td>
                      <td style={{ padding: "10px 12px" }}>{m.flat ? `${m.flat.order_squares} sq @ ${m.flat.waste_pct}%` : "—"}</td>
                      <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
                        <span style={{ color: qColor(d.imagery?.quality) }}>●</span> {fmtDate(d.imagery?.date)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultCard({ d }) {
  const r = d.roof || {};
  const m = d.materials || {};
  const sloped = m.sloped || {};
  const flat = m.flat || {};
  const [showEditor, setShowEditor] = useState(false);
  const [adj, setAdj] = useState(null);   // corrected figures from the map editor / appraiser override
  const [apprSqft, setApprSqft] = useState("");
  const isAdj = !!adj;

  // Appraiser override: the county publishes each roofed section's exact sq ft
  // (BAS + garage + porches). Sum = under-roof FOOTPRINT; × slope factor = true
  // squares — imagery-independent, so it fixes MEDIUM / multi-building misses.
  function applyAppraiser(v) {
    setApprSqft(v);
    const n = parseFloat(String(v).replace(/[, ]/g, ""));
    if (!n || n <= 0) { setAdj(null); return; }
    const p = (r.avg_pitch_x12 ?? 6) / 12;
    const sf = Math.sqrt(1 + p * p);
    const total = Math.round((n * sf) / 100 * 100) / 100;      // squares (surface)
    const w = sloped.waste_pct ?? 12;
    setAdj({
      total,
      sloped: { measured_squares: total, waste_pct: w, order_squares: Math.round(total * (1 + w / 100) * 100) / 100 },
      flat: { measured_squares: 0, waste_pct: 10, order_squares: 0 },
      source: "appraiser",
    });
  }

  // Auto pre-fill from the county's living area on load (rep bumps for garage/porch).
  useEffect(() => {
    const liv = d.appraiser?.living_sqft;
    if (liv && !apprSqft) applyAppraiser(String(liv));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the outline is adjusted on the map, the corrected numbers drive the top.
  // The editor emits both buckets (classed by pitch), so a low-slope trace lands
  // in membrane and shingle stays 0.
  const totalSq = isAdj ? adj.total : r.surface_squares;
  const slopedShow = isAdj ? { material: sloped.material, ...adj.sloped } : sloped;
  const flatShow = isAdj ? { material: flat.material, ...adj.flat } : flat;
  const metalOrder = isAdj ? Math.round(adj.total * 110) / 100 : (m.metal ? m.metal.order_squares : null);
  const metalWaste = m.metal ? m.metal.waste_pct : 10;

  return (
    <div style={{ ...CARD, ...(isAdj ? { borderColor: "#86efac", boxShadow: "0 0 0 1px #86efac" } : {}) }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{d.geocoded_as || d._addr}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {isAdj && <span style={{ fontSize: 11, fontWeight: 800, color: "#16a34a", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 999, padding: "3px 9px" }}>✏️ ADJUSTED</span>}
          {d.confidence && (
            <span style={{ fontSize: 11, fontWeight: 800, padding: "3px 9px", borderRadius: 999, whiteSpace: "nowrap", ...(d.confidence.level === "low" ? { color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a" } : { color: "#15803d", background: "#f0fdf4", border: "1px solid #bbf7d0" }) }}>
              {d.confidence.level === "low" ? "⚠️ CHECK" : "✓ CROSS-CHECKED"}
            </span>
          )}
          <div style={{ fontSize: 12.5, color: "#64748b" }}>
            Imagery: <b style={{ color: qColor(d.imagery?.quality) }}>{d.imagery?.quality || "—"}</b> · {fmtDate(d.imagery?.date)}
          </div>
        </div>
      </div>

      {d.confidence?.level === "low" && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "9px 13px", marginBottom: 14, fontSize: 13, color: "#92400e" }}>
          ⚠️ <b>Low confidence</b> — the satellite footprint and the independent building outline disagree by {d.confidence.delta_pct}%. Google likely grabbed the wrong or partial building. Verify with the map (Buildings mode / trace) or the appraiser sq ft below.
        </div>
      )}

      {/* Top-line numbers */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 14, marginBottom: 18 }}>
        <Stat label="Total roof (sloped)" value={`${totalSq ?? "—"}`} unit={isAdj ? "squares · adjusted" : "squares"} accent={isAdj ? "#16a34a" : undefined} />
        <Stat label="Predominant pitch" value={r.avg_pitch_x12 != null ? `${r.avg_pitch_x12}/12` : "—"} unit={r.avg_pitch_deg != null ? `${r.avg_pitch_deg}°` : ""} />
        <Stat label="Roof facets" value={`${r.plane_count ?? "—"}`} unit="" />
      </div>

      {/* Material split */}
      <div style={{ ...LABEL, marginBottom: 8 }}>Material split &amp; waste</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginBottom: 6 }}>
        <Bucket title="Sloped → shingle" b={slopedShow} accent="#2563eb" />
        <Bucket title="Flat / low-slope → membrane" b={flatShow} accent="#0891b2" />
      </div>

      {/* Alternative: whole roof as metal at a flat 10% waste. */}
      {m.metal && (
        <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center", background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px" }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: "#475569" }}>
            🔩 As a metal roof <span style={{ fontWeight: 400, color: "#94a3b8" }}>(whole roof, {metalWaste}% waste)</span>
          </span>
          <b style={{ fontSize: 16, color: "#0f172a" }}>{metalOrder} sq</b>
        </div>
      )}

      {/* Appraiser sq ft override — exact, imagery-independent squares. */}
      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: adj?.source === "appraiser" ? "#f0fdf4" : "#f8fafc", border: `1px solid ${adj?.source === "appraiser" ? "#bbf7d0" : "#e5e7eb"}`, borderRadius: 10, padding: "10px 14px" }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "#475569" }}>🏛️ Appraiser sq ft</span>
        <input
          type="text" inputMode="numeric" value={apprSqft}
          onChange={(e) => applyAppraiser(e.target.value)}
          placeholder="under-roof sqft"
          style={{ width: 130, fontFamily: FONT, fontSize: 15, padding: "7px 10px", border: "1px solid #cbd5e1", borderRadius: 8 }}
        />
        <span style={{ fontSize: 12.5, color: "#94a3b8" }}>
          {adj?.source === "appraiser"
            ? (d.appraiser?.living_sqft && apprSqft === String(d.appraiser.living_sqft)
                ? `→ ${adj.total} sq · county living area — add garage/porch for the rest`
                : `→ ${adj.total} sq at ${r.avg_pitch_x12}/12 (overrides the read)`)
            : (d.appraiser?.living_sqft ? `county living area ${d.appraiser.living_sqft} sqft — add garage/porch` : "sum under-roof sqft → exact squares, any imagery")}
        </span>
      </div>

      <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 10 }}>{m.note}</div>

      {/* Human-verification: open the satellite map to trace any section the
          automated read clipped, and watch the total correct live. */}
      {d.location?.lat != null && (
        showEditor
          ? <RoofMeasureEditor result={d} onAdjust={setAdj} onClose={() => setShowEditor(false)} />
          : (
            <button
              onClick={() => setShowEditor(true)}
              style={{ marginTop: 14, fontFamily: FONT, fontSize: 14, fontWeight: 700, color: "#2563eb", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, padding: "11px 18px", cursor: "pointer", width: "100%" }}
            >
              🗺️ Verify / adjust outline on map
            </button>
          )
      )}
    </div>
  );
}

function Stat({ label, value, unit, accent }) {
  return (
    <div>
      <div style={LABEL}>{label}</div>
      <div style={{ ...BIG, ...(accent ? { color: accent } : {}) }}>{value}</div>
      {unit ? <div style={{ fontSize: 12.5, color: "#94a3b8", marginTop: 2 }}>{unit}</div> : null}
    </div>
  );
}

function Bucket({ title, b, accent }) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderLeft: `4px solid ${accent}`, borderRadius: 10, padding: 14, background: "#fafcff" }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 8, color: accent }}>{title}</div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "3px 0" }}>
        <span style={{ color: "#64748b" }}>Measured</span><b>{b.measured_squares ?? "—"} sq</b>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "3px 0" }}>
        <span style={{ color: "#64748b" }}>Waste</span><b>{b.waste_pct != null ? `${b.waste_pct}%` : "—"}</b>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, padding: "6px 0 0", marginTop: 6, borderTop: "1px dashed #e5e7eb" }}>
        <span style={{ color: "#0f172a", fontWeight: 700 }}>Order</span>
        <b style={{ color: accent, fontSize: 17 }}>{b.order_squares ?? "—"} sq</b>
      </div>
    </div>
  );
}
