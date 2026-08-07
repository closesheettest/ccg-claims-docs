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
          tight:  { c: "#16a34a", bg: "#f0fdf4", bd: "#bbf7d0", txt: "sources agree — trust it" },
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
