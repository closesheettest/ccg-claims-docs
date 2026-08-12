// DoorDispatcher — ROOF MEASUREMENT spot-check (?mode=roofmeasure). Office-only.
//
// Type an address, get a satellite roof measurement from Google's Solar API via
// our harvest-roof-report function: total squares (sloped surface + footprint),
// predominant pitch, facet count, and the flat-vs-sloped material split with our
// waste rules already applied. Every lookup is appended to a table so you can
// spot-check a batch of addresses and eyeball how it'll look before we build it
// into the rep flow. Nothing here is saved or synced — it's a proving ground.

import React, { useState, useRef, useEffect, useMemo } from "react";
import RoofMeasureEditor from "./RoofMeasureEditor";
import { AddressAutocomplete } from "./lib/AddressAutocomplete";

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

  async function measure(addrArg) {
    const addr = String(typeof addrArg === "string" ? addrArg : address).trim();
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

  // Deep-link from an appointment on the rep map: ?address=…&job=…&rep=… auto-loads
  // the read and remembers the job/rep so Save can attach it to the deal (Slice 2b).
  const prefill = useRef(null);
  useEffect(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      const a = (p.get("address") || "").trim();
      prefill.current = { job: p.get("job") || null, rep: p.get("rep") || null, address: a || null };
      if (a) { setAddress(a); measure(a); }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <div style={{ flex: 1, minWidth: 240 }}>
          <AddressAutocomplete
            value={address}
            onChange={(v) => setAddress(v)}
            onPlaceSelected={({ formatted, address: street, city, state, zip }) => {
              const full = formatted || [street, city, state, zip].filter(Boolean).join(", ");
              setAddress(full);
              measure(full);   // auto-measure on a confirmed pick
            }}
            placeholder="4365 Birch Street NE, St. Petersburg, FL 33703"
          />
        </div>
        <button
          onClick={() => measure()}
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
      {latest && <ResultCard key={latest._id} d={latest} />}

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

function ResultCard({ d: d0 }) {
  const [d, setD] = useState(d0);   // the read; drag-the-pin re-measures and replaces it
  // The ⚠️ CHECK flag means "we're not sure this is the right building — confirm it."
  // Dragging the pin onto the building IS that confirmation (a human just picked the
  // structure), so once they've dragged we retire the red flag to a calm ✓ CONFIRMED —
  // the parcel's living-sqft (which trips the flag) never changes within one lot, so
  // re-computing confidence would keep nagging even after the rep put the pin dead-on.
  const [confirmed, setConfirmed] = useState(false);
  // Re-run the read at a new spot (rep dragged the pin onto the correct house).
  async function remeasure(lat, lng) {
    try {
      const res = await fetch("/.netlify/functions/harvest-roof-report", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lat, lng }),
      });
      const nd = await res.json();
      if (nd.ok) { setD({ ...nd, _addr: d._addr, _id: d._id }); setAdj(null); setConfirmed(true); return true; }
    } catch { /* ignore */ }
    return false;
  }

  // 🛰️ LiDAR — the 3rd teammate. Fetched async (a cold EPT read is slow) so the fast
  // Solar+Records read never waits on it; when it lands we re-fuse the council with its
  // vote. Safe before the cloud service exists: {ok:false} → the duo simply stays.
  const [lidar, setLidar] = useState(null);
  const [lidarState, setLidarState] = useState("idle");
  useEffect(() => {
    if (d.location?.lat == null) return;
    let alive = true;
    setLidar(null); setLidarState("checking");
    fetch("/.netlify/functions/harvest-roof-lidar", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: d.location.lat, lng: d.location.lng, pitch: d.roof?.avg_pitch_x12 }),
    })
      .then((res) => res.json())
      .then((j) => { if (!alive) return; setLidar(j && j.ok ? j : null); setLidarState(j && j.ok ? "done" : "miss"); })
      .catch(() => { if (alive) setLidarState("miss"); });
    return () => { alive = false; };
  }, [d.location?.lat, d.location?.lng]);

  // Re-fuse the council client-side once LiDAR's vote lands (median + agreement).
  const team = useMemo(() => {
    const base = d.team;
    if (!base) return null;
    if (!lidar || !lidar.squares) return base;
    const votes = [...base.votes, { source: "lidar", label: "LiDAR", squares: +lidar.squares.toFixed(1) }];
    const vals = votes.map((v) => v.squares).slice().sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
    const spread = vals.length >= 2 ? Math.round(((vals[vals.length - 1] - vals[0]) / median) * 100) : null;
    const agreement = spread == null ? "single" : spread > 35 ? "flag" : spread > 15 ? "loose" : "tight";
    return { squares: +median.toFixed(1), votes, n: votes.length, spread_pct: spread, agreement };
  }, [d.team, lidar]);

  const r = d.roof || {};
  const m = d.materials || {};
  const sloped = m.sloped || {};
  const flat = m.flat || {};
  const [showEditor, setShowEditor] = useState(true);   // draw-first: open the trace map immediately — no auto-estimate to trust
  const [adj, setAdj] = useState(null);   // the rep's traced measurement (or appraiser-sqft override)
  const [apprSqft, setApprSqft] = useState("");
  const isAdj = !!adj;   // true once the rep has traced the roof (or entered appraiser sqft) — that trace IS the number we show
  const showAppraiser = false;   // hidden in the sales tool for now — bring back with the 3D-image work. Code kept intact.

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

  // Once the outline is traced on the map, the rep's numbers drive the top.
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
          {d.confidence?.level === "low" && !confirmed && (
            <>
              <style>{`@keyframes roofCheckPulse{0%,100%{transform:scale(1);box-shadow:0 0 0 0 rgba(220,38,38,.55)}50%{transform:scale(1.09);box-shadow:0 0 0 9px rgba(220,38,38,0)}}`}</style>
              <span style={{ fontSize: 15, fontWeight: 900, padding: "8px 18px", borderRadius: 999, whiteSpace: "nowrap", color: "#fff", background: "#dc2626", border: "2px solid #b91c1c", letterSpacing: ".04em", boxShadow: "0 1px 4px rgba(0,0,0,.2)", animation: "roofCheckPulse 1.1s ease-in-out infinite" }}>
                ⚠️ CHECK
              </span>
            </>
          )}
          {confirmed && (
            <span style={{ fontSize: 13, fontWeight: 900, padding: "6px 14px", borderRadius: 999, whiteSpace: "nowrap", color: "#fff", background: "#16a34a", border: "2px solid #15803d", letterSpacing: ".04em", boxShadow: "0 1px 4px rgba(0,0,0,.15)" }}>
              ✓ CONFIRMED
            </span>
          )}
          <div style={{ fontSize: 12.5, color: "#64748b" }}>
            Imagery: <b style={{ color: qColor(d.imagery?.quality) }}>{d.imagery?.quality || "—"}</b> · {fmtDate(d.imagery?.date)}
          </div>
        </div>
      </div>

      {d.confidence?.level === "low" && !confirmed && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "9px 13px", marginBottom: 14, fontSize: 13, color: "#92400e" }}>
          ⚠️ <b>Low confidence</b> — {d.confidence.message
            || `the satellite footprint and the independent building outline disagree by ${d.confidence.delta_pct}%. Google likely grabbed the wrong or partial building. Verify with the map (Buildings mode / trace) or the appraiser sq ft below.`}
        </div>
      )}

      {/* 🤝 TEAM READ — the fusion council. Every independent source votes on the
          squares; the team takes the median and shows how tightly they agree, so the
          rep sees the blended number (and its confidence) before touching anything. */}
      {team && team.n >= 1 && (() => {
        const t = team;
        const AG = {
          tight:  { c: "#0e7490", bg: "#ecfeff", bd: "#a5f3fc", txt: "sources agree — but trees can fool both; trace it to be sure" },
          loose:  { c: "#b45309", bg: "#fffbeb", bd: "#fde68a", txt: "sources a bit apart — glance at the map" },
          flag:   { c: "#dc2626", bg: "#fef2f2", bd: "#fecaca", txt: "sources disagree — likely wrong building, confirm the pin" },
          single: { c: "#64748b", bg: "#f8fafc", bd: "#e5e7eb", txt: "one source so far — LiDAR + records add votes" },
        }[t.agreement] || {};
        const hasLidar = t.votes.some((v) => v.source === "lidar");
        return (
          <div style={{ background: AG.bg, border: `1px solid ${AG.bd}`, borderRadius: 12, padding: "13px 15px", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#334155", letterSpacing: ".02em" }}>🤝 TEAM READ</span>
                <span style={{ fontSize: 26, fontWeight: 900, color: "#0f172a", lineHeight: 1 }}>{t.squares}<span style={{ fontSize: 14, fontWeight: 700, color: "#64748b" }}> sq</span></span>
              </div>
              <span style={{ fontSize: 11.5, fontWeight: 800, color: "#fff", background: AG.c, borderRadius: 999, padding: "4px 11px", letterSpacing: ".03em" }}>
                {t.agreement === "single" ? "1 SOURCE" : `${t.spread_pct}% SPREAD · ${t.agreement.toUpperCase()}`}
              </span>
            </div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 9, alignItems: "center" }}>
              {t.votes.map((v) => (
                <span key={v.source} style={{ fontSize: 13, color: "#475569" }}>
                  <b style={{ color: v.source === "lidar" ? "#7c3aed" : "#0f172a" }}>{v.label}</b> {v.squares} sq
                </span>
              ))}
              {!hasLidar && lidarState === "checking" && (
                <span style={{ fontSize: 12, color: "#7c3aed", fontWeight: 700 }}>🛰️ LiDAR checking…</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: AG.c, marginTop: 7, fontWeight: 600 }}>{AG.txt}</div>
          </div>
        );
      })()}

      {/* 📐 No-draw path: auto-load the county appraiser sketch, read the section
          dimensions off it, and the tool finishes the roof (footprint + overhang ×
          pitch → squares) — no tracing needed. Pasco only for now. */}
      <SketchMeasure d={d} pitch={r.avg_pitch_x12} onUse={applyAppraiser}
        active={adj?.source === "appraiser"} satSquares={r.surface_squares} />

      {/* Reference only — pitch & facet count from the satellite. NOT a measurement:
          the rep traces the roof below and that trace is the number they price off. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 14, marginBottom: 18 }}>
        {isAdj && <Stat label="Total roof (sloped)" value={`${totalSq ?? "—"}`} unit="squares · from your trace" accent="#16a34a" />}
        <Stat label="Predominant pitch" value={r.avg_pitch_x12 != null ? `${r.avg_pitch_x12}/12` : "—"} unit={r.avg_pitch_deg != null ? `${r.avg_pitch_deg}°` : ""} />
        <Stat label="Roof facets" value={`${r.plane_count ?? "—"}`} unit="" />
      </div>

      {/* Draw-first: no automated estimate. The rep traces the roof and THAT is the number. */}
      {!isAdj && (
        <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, padding: "11px 14px", marginBottom: 16, fontSize: 13.5, color: "#1e40af", fontWeight: 600 }}>
          ✏️ Trace the roof outline on the map below — what you draw is your measurement. Draw pitched and flat sections separately (different material).
        </div>
      )}

      {/* Material split + metal — only after the rep has TRACED the roof (their number). */}
      {isAdj && (
        <>
          <div style={{ ...LABEL, marginBottom: 8 }}>Material split &amp; waste</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginBottom: 6 }}>
            <Bucket title="Sloped → shingle" b={slopedShow} accent="#2563eb" />
            <Bucket title="Flat / low-slope → membrane" b={flatShow} accent="#0891b2" />
          </div>
          {m.metal && (
            <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center", background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px" }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: "#475569" }}>
                🔩 As a metal roof <span style={{ fontWeight: 400, color: "#94a3b8" }}>(whole roof, {metalWaste}% waste)</span>
              </span>
              <b style={{ fontSize: 16, color: "#0f172a" }}>{metalOrder} sq</b>
            </div>
          )}
        </>
      )}

      {/* Appraiser sq ft override + material-estimate note — HIDDEN in the sales tool
          for now (draw-first). Kept intact; re-enable via showAppraiser for the 3D work. */}
      {showAppraiser && (
        <>
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
        </>
      )}

      {/* Human-verification: open the satellite map to trace any section the
          automated read clipped, and watch the total correct live. */}
      {d.location?.lat != null && (
        showEditor
          ? <RoofMeasureEditor result={d} onAdjust={setAdj} onRemeasure={remeasure} onClose={() => setShowEditor(false)} />
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

// 📐 The no-draw workflow — AUTO-FIRST. Ask the county appraiser for this address's
// UNDER-ROOF FOOTPRINT (appraiser-data: Batch-1 counties give it with zero typing) and
// finish the roof for the rep: footprint + eave overhang × pitch = squares, with the
// building sketch shown for a visual gut-check. If the county has no raw data, fall
// back to the sketch-and-type path (appraiser-sketch). Feeds the card's applyAppraiser.
//
// Overhang from a sqft-only footprint: appraisers measure wall-to-wall, but the roof
// plane runs out to the drip edge. For a roughly square building the eave ring area is
// perimeter×oh + 4·oh²  ≈ 4·√A·oh + 4·oh²  (matches the +1.5 ft/side we calibrated on
// Hollybrook to Roofr). We add that to A, then apply the slope factor.
function ohArea(A, oh) { return A > 0 && oh > 0 ? 4 * Math.sqrt(A) * oh + 4 * oh * oh : 0; }

function SketchMeasure({ d, pitch, onUse, active, satSquares }) {
  const [state, setState] = useState("loading");  // loading | auto | manual | miss
  const [data, setData] = useState(null);          // appraiser-data raw result (auto)
  const [sketches, setSketches] = useState([]);    // appraiser-sketch fallback images
  const [missMsg, setMissMsg] = useState("");
  const [overhang, setOverhang] = useState("1.5");
  const [sections, setSections] = useState([{ l: "", w: "" }]);
  const [manualOpen, setManualOpen] = useState(false);  // auto mode: "measure it myself" escape hatch

  const address = d.geocoded_as || d._addr;
  const county = d.county || d.appraiser?.county || "";

  useEffect(() => {
    if (!address) { setState("miss"); return; }
    let alive = true;
    setState("loading"); setData(null); setSketches([]); setMissMsg(""); setManualOpen(false);
    // 1) Raw appraiser DATA — footprint by address, zero typing (Batch-1 counties).
    fetch("/.netlify/functions/appraiser-data", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, county }),
    })
      .then((r) => r.json())
      .then(async (j) => {
        if (!alive) return;
        if (j && j.ok && j.footprint_sqft > 0) { setData(j); setState("auto"); return; }
        // 2) No raw data → sketch + manual typing (appraiser-sketch: Pasco etc.).
        try {
          const sr = await fetch("/.netlify/functions/appraiser-sketch", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address, county }),
          });
          const sj = await sr.json();
          if (!alive) return;
          if (sj && sj.ok && (sj.sketches || []).length) { setSketches(sj.sketches); setState("manual"); return; }
          setMissMsg(sj?.error || j?.error || ""); setState("miss");
        } catch { if (alive) setState("miss"); }
      })
      .catch(() => { if (alive) setState("miss"); });
    return () => { alive = false; };
  }, [address, county]);

  const oh = Math.max(0, parseFloat(overhang) || 0);
  const p = (pitch ?? 6) / 12;
  const sf = Math.sqrt(1 + p * p);

  // Manual path: overhang on the MAIN outline only (section 0). Protrusions butt against
  // the house — +oh on every side balloons them and double-counts the shared seam.
  const footprint = sections.reduce((s, sec, i) => {
    const l = parseFloat(sec.l), w = parseFloat(sec.w);
    if (!(l > 0 && w > 0)) return s;
    return s + (i === 0 ? (l + 2 * oh) * (w + 2 * oh) : l * w);
  }, 0);
  const squares = footprint > 0 ? Math.round((footprint * sf) / 100 * 100) / 100 : 0;
  const setSec = (i, patch) => setSections((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const wrap = { border: "1px solid #e5e7eb", borderRadius: 12, padding: "13px 15px", marginBottom: 16, background: "#fafafa" };
  const head = (
    <div style={{ fontSize: 13, fontWeight: 800, color: "#334155", letterSpacing: ".02em", marginBottom: 8 }}>
      📐 AUTO-MEASURE FROM THE COUNTY APPRAISER
    </div>
  );
  const input = { width: 82, fontFamily: FONT, fontSize: 15, padding: "7px 9px", border: "1px solid #cbd5e1", borderRadius: 8, textAlign: "center" };

  if (state === "loading") return <div style={wrap}>{head}<div style={{ fontSize: 13, color: "#64748b" }}>Asking the county appraiser for this roof…</div></div>;

  if (state === "miss") return (
    <div style={{ ...wrap, background: "#f8fafc" }}>{head}
      <div style={{ fontSize: 12.5, color: "#94a3b8" }}>{missMsg || "No county appraiser data auto-loaded for this address."} <span style={{ color: "#cbd5e1" }}>(This county isn't wired for auto-measure yet — trace it on the map below.)</span></div>
    </div>
  );

  // ── AUTO: county returned the under-roof footprint. Finish the roof, no typing. ──
  if (state === "auto" && data) {
    const A = Math.round(Number(data.footprint_sqft) || 0);
    const withOh = A + ohArea(A, oh);
    const autoSquares = withOh > 0 ? Math.round((withOh * sf) / 100 * 100) / 100 : 0;
    const subs = data.subareas || [];
    return (
      <div style={{ ...wrap, background: active ? "#f0fdf4" : "#f8fdf9", borderColor: active ? "#86efac" : "#bbf7d0" }}>
        {head}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5, color: "#166534", marginBottom: 10 }}>
          <span style={{ fontWeight: 800, background: "#dcfce7", border: "1px solid #86efac", borderRadius: 999, padding: "3px 10px" }}>✓ {data.county} appraiser</span>
          <span style={{ color: "#64748b" }}>No typing needed — read straight from the county records.</span>
        </div>

        {/* The measurement */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
          <div>
            <div style={LABEL}>Under-roof footprint</div>
            <div style={{ fontSize: 26, fontWeight: 900, color: "#0f172a", lineHeight: 1.05 }}>{A.toLocaleString()}<span style={{ fontSize: 13, fontWeight: 700, color: "#64748b" }}> sqft</span></div>
          </div>
          <div style={{ fontSize: 22, color: "#cbd5e1" }}>→</div>
          <div>
            <div style={LABEL}>Roof at {pitch ?? 6}/12{oh > 0 ? ` + ${oh}ft eave` : ""}</div>
            <div style={{ fontSize: 30, fontWeight: 900, color: "#16a34a", lineHeight: 1.05 }}>{autoSquares}<span style={{ fontSize: 14, fontWeight: 700, color: "#64748b" }}> sq</span></div>
          </div>
          {satSquares != null && (
            <div style={{ fontSize: 12, color: "#94a3b8" }}>satellite saw {satSquares} sq</div>
          )}
        </div>

        {/* Section breakdown from the records (the "raw data" scan) */}
        {subs.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            {subs.map((s, i) => (
              <span key={i} style={{ fontSize: 11.5, color: "#475569", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 999, padding: "3px 9px" }}>
                {s.desc} <b style={{ color: "#0f172a" }}>{Number(s.sqft).toLocaleString()}</b>
              </span>
            ))}
          </div>
        )}

        {/* The sketch — visual gut-check that the county pulled the right building */}
        {data.sketch && (
          <div style={{ marginBottom: 10, textAlign: "center", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 8, overflow: "auto" }}>
            <img src={data.sketch} alt="Appraiser building sketch" style={{ maxWidth: "100%", height: "auto" }} />
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>County sketch — confirm this is the right building</div>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0 10px" }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "#475569" }}>Overhang per side (ft)</span>
          <input value={overhang} onChange={(e) => setOverhang(e.target.value)} inputMode="decimal" style={{ ...input, width: 64 }} />
          {data.matched_address && <span style={{ fontSize: 11.5, color: "#cbd5e1" }}>matched: {data.matched_address}</span>}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", paddingTop: 10, borderTop: "1px solid #e5e7eb" }}>
          <button type="button" onClick={() => setManualOpen((v) => !v)} style={{ fontSize: 12.5, fontWeight: 700, color: "#2563eb", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            {manualOpen ? "Hide manual entry" : "Not right? Measure it myself →"}
          </button>
          <button type="button" disabled={!(autoSquares > 0)} onClick={() => onUse(withOh)}
            style={{ fontFamily: FONT, fontSize: 14, fontWeight: 800, color: "#fff", background: autoSquares > 0 ? "#16a34a" : "#94a3b8", border: "none", borderRadius: 10, padding: "10px 18px", cursor: autoSquares > 0 ? "pointer" : "default" }}>
            {active ? "✓ Using this — update" : "Use this measurement"}
          </button>
        </div>

        {manualOpen && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed #cbd5e1" }}>
            <ManualSections sections={sections} setSections={setSections} setSec={setSec} oh={oh} input={input} pitch={pitch} footprint={footprint} squares={squares} satSquares={satSquares} onUse={onUse} active={active} />
          </div>
        )}
      </div>
    );
  }

  // ── MANUAL: no raw data, but the county served a sketch — read L×W off it. ──
  return (
    <div style={{ ...wrap, background: active ? "#f0fdf4" : "#fafafa", borderColor: active ? "#bbf7d0" : "#e5e7eb" }}>
      {head}
      <div style={{ fontSize: 12.5, color: "#64748b", marginBottom: 10 }}>
        This county doesn't publish the sqft, but here's its building sketch. Read each roofed section's <b>length × width</b> off it — the <b>Main</b> first, then each jog/garage/porch. Overhang is added to the main outline; pitch comes from the satellite ({pitch != null ? `${pitch}/12` : "—"}).
      </div>
      {sketches.map((s, i) => (
        <div key={(s.pid || "") + "-" + (s.bid || i)} style={{ marginBottom: 10, textAlign: "center", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 8, overflow: "auto" }}>
          <img src={s.image} alt={`Appraiser sketch ${i + 1}`} style={{ maxWidth: "100%", height: "auto" }} />
          {sketches.length > 1 && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>Building {i + 1} of {sketches.length}</div>}
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0 4px" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "#475569" }}>Overhang per side (ft)</span>
        <input value={overhang} onChange={(e) => setOverhang(e.target.value)} inputMode="decimal" style={{ ...input, width: 64 }} />
      </div>
      <ManualSections sections={sections} setSections={setSections} setSec={setSec} oh={oh} input={input} pitch={pitch} footprint={footprint} squares={squares} satSquares={satSquares} onUse={onUse} active={active} />
    </div>
  );
}

// The section-by-section typing UI (Main + protrusions) shared by the manual path and
// the auto path's "measure it myself" escape hatch.
function ManualSections({ sections, setSections, setSec, oh, input, pitch, footprint, squares, satSquares, onUse, active }) {
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, margin: "8px 0" }}>
        {sections.map((sec, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12.5, color: "#94a3b8", width: 64 }}>{i === 0 ? "Main" : `Section ${i + 1}`}</span>
            <input value={sec.l} onChange={(e) => setSec(i, { l: e.target.value })} inputMode="decimal" placeholder="length" style={input} />
            <span style={{ color: "#94a3b8" }}>×</span>
            <input value={sec.w} onChange={(e) => setSec(i, { w: e.target.value })} inputMode="decimal" placeholder="width" style={input} />
            <span style={{ fontSize: 11.5, color: "#94a3b8" }}>ft {parseFloat(sec.l) > 0 && parseFloat(sec.w) > 0 ? (i === 0 ? `→ +${oh}ft = ${Math.round((parseFloat(sec.l) + 2 * oh) * (parseFloat(sec.w) + 2 * oh))} sqft` : `= ${Math.round(parseFloat(sec.l) * parseFloat(sec.w))} sqft`) : ""}</span>
            {sections.length > 1 && <button type="button" onClick={() => setSections((ss) => ss.filter((_, j) => j !== i))} style={{ border: "none", background: "none", color: "#cbd5e1", cursor: "pointer", fontSize: 16 }}>✕</button>}
          </div>
        ))}
        <button type="button" onClick={() => setSections((ss) => [...ss, { l: "", w: "" }])} style={{ alignSelf: "flex-start", fontSize: 12.5, fontWeight: 700, color: "#2563eb", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}>+ Add a section (garage / porch)</button>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginTop: 10, paddingTop: 10, borderTop: "1px solid #e5e7eb" }}>
        <div style={{ fontSize: 12.5, color: "#64748b" }}>
          {footprint > 0
            ? <>Footprint <b style={{ color: "#0f172a" }}>{Math.round(footprint)} sqft</b> · <b style={{ color: "#0f172a" }}>{squares} sq</b> at {pitch ?? 6}/12{satSquares != null ? <> <span style={{ color: "#cbd5e1" }}>·</span> satellite saw {satSquares} sq</> : null}</>
            : "Enter at least one section's dimensions."}
        </div>
        <button type="button" disabled={!(squares > 0)} onClick={() => onUse(footprint)}
          style={{ fontFamily: FONT, fontSize: 14, fontWeight: 800, color: "#fff", background: squares > 0 ? "#16a34a" : "#94a3b8", border: "none", borderRadius: 10, padding: "10px 18px", cursor: squares > 0 ? "pointer" : "default" }}>
          {active ? "✓ Using this — update" : "Use this measurement"}
        </button>
      </div>
    </>
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
      {/* The number the rep actually prices/orders off — big, bold, unmissable so it's
          never confused with the raw Measured squares above it. */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "11px 13px", marginTop: 10, borderRadius: 9, background: accent }}>
        <span style={{ color: "#fff", fontWeight: 900, fontSize: 14.5, lineHeight: 1.15, letterSpacing: ".01em" }}>PRICE THE ROOF<br />OFF THIS NUMBER</span>
        <b style={{ color: "#fff", fontSize: 27, fontWeight: 900, whiteSpace: "nowrap", lineHeight: 1 }}>{b.order_squares ?? "—"} sq</b>
      </div>
    </div>
  );
}
