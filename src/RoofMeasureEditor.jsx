// Roof Measurement — map editor (the human-verification layer).
//
// The automated read sometimes clips part of a roof (usually on older/MEDIUM
// imagery). This lets a person SEE the roof on satellite and trace any section
// that got missed: tap the corners of the missing piece, "Finish section", and
// its footprint × the roof's pitch is added to the total — live. That recovers
// the Roofr-grade number without paying anyone, because a human is doing the
// same outline-verification a paid service's tracer would.
//
// v1: added sections are treated as sloped/shingle at the roof's predominant
// pitch (editable) — the common case is a clipped wing at the same pitch. It
// does not yet paint Google's own detected mask over the image; you eyeball
// completeness against the aerial and draw what's missing.

import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const SQ_M_PER_SQUARE = 9.290304;
const FONT = "'Oswald', system-ui, sans-serif";

// Planar area (m²) of a lat/lng polygon via a local equirectangular projection
// around its centroid — accurate to well under 1% at roof scale.
function polygonAreaM2(pts) {
  if (!pts || pts.length < 3) return 0;
  const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  const mPerLat = 110540;
  const mPerLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const xy = pts.map((p) => [p.lng * mPerLng, p.lat * mPerLat]);
  let a = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// x/12 pitch → slope factor (true sloped area ÷ flat footprint).
const slopeFactor = (x12) => Math.sqrt(1 + Math.pow((+x12 || 0) / 12, 2));
const sq = (m2) => m2 / SQ_M_PER_SQUARE;

export default function RoofMeasureEditor({ result, onClose }) {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const drawLayerRef = useRef(null);      // committed section polygons
  const activeLayerRef = useRef(null);    // in-progress polyline + markers
  const drawingRef = useRef(false);
  const ptsRef = useRef([]);

  const [drawing, setDrawing] = useState(false);
  const [sections, setSections] = useState([]);   // [{ pts, area_m2 }]
  const [pitch, setPitch] = useState(result?.roof?.avg_pitch_x12 || 6);
  const [ptCount, setPtCount] = useState(0);
  const [replaceMode, setReplaceMode] = useState(false);   // false = add to base, true = trace replaces base

  const lat = result?.location?.lat;
  const lng = result?.location?.lng;

  // ── init map
  useEffect(() => {
    if (!mapEl.current || mapRef.current || lat == null || lng == null) return;
    const m = L.map(mapEl.current, { zoomControl: true }).setView([lat, lng], 20);
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 21, maxNativeZoom: 19, attribution: "Imagery &copy; Esri" },
    ).addTo(m);
    // Drop a pin on the subject house so it's obvious which roof to trace.
    L.marker([lat, lng], {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: "rm-subject-pin",
        html: '<div style="font-size:34px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))">📍</div>',
        iconSize: [34, 34],
        iconAnchor: [17, 31],   // tip of the pin sits on the geocoded point
      }),
    }).addTo(m);
    drawLayerRef.current = L.layerGroup().addTo(m);
    activeLayerRef.current = L.layerGroup().addTo(m);
    m.on("click", onMapClick);
    // container size isn't final the instant L.map runs
    setTimeout(() => m.invalidateSize(), 60);
    setTimeout(() => m.invalidateSize(), 300);
    mapRef.current = m;
    return () => { m.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  // While drawing, show an arrow pointer (not Leaflet's grab hand) so it reads
  // as "click to place a point," not "drag to pan."
  useEffect(() => {
    const m = mapRef.current;
    if (m) m.getContainer().style.cursor = drawing ? "default" : "";
  }, [drawing]);

  function redrawActive() {
    const g = activeLayerRef.current; if (!g) return;
    g.clearLayers();
    const pts = ptsRef.current;
    pts.forEach((p) => L.circleMarker([p.lat, p.lng], { radius: 5, color: "#f59e0b", fillColor: "#f59e0b", fillOpacity: 1 }).addTo(g));
    if (pts.length >= 2) L.polyline(pts.map((p) => [p.lat, p.lng]), { color: "#f59e0b", weight: 2, dashArray: "5,5" }).addTo(g);
  }

  function onMapClick(e) {
    if (!drawingRef.current) return;
    ptsRef.current = [...ptsRef.current, { lat: e.latlng.lat, lng: e.latlng.lng }];
    setPtCount(ptsRef.current.length);
    redrawActive();
  }

  function startDraw() { drawingRef.current = true; setDrawing(true); ptsRef.current = []; setPtCount(0); redrawActive(); }
  function undoPoint() { ptsRef.current = ptsRef.current.slice(0, -1); setPtCount(ptsRef.current.length); redrawActive(); }
  function cancelDraw() { drawingRef.current = false; setDrawing(false); ptsRef.current = []; setPtCount(0); redrawActive(); }

  function finishSection() {
    const pts = ptsRef.current;
    if (pts.length < 3) return;
    const area_m2 = polygonAreaM2(pts);
    // commit a filled polygon
    L.polygon(pts.map((p) => [p.lat, p.lng]), { color: "#16a34a", weight: 2, fillColor: "#22c55e", fillOpacity: 0.35 }).addTo(drawLayerRef.current);
    setSections((prev) => [...prev, { pts, area_m2 }]);
    cancelDraw();
  }

  function removeSection(idx) {
    setSections((prev) => prev.filter((_, i) => i !== idx));
    // simplest reliable redraw: wipe committed layer and repaint remaining
    const g = drawLayerRef.current; if (!g) return;
    g.clearLayers();
    sections.filter((_, i) => i !== idx).forEach((s) =>
      L.polygon(s.pts.map((p) => [p.lat, p.lng]), { color: "#16a34a", weight: 2, fillColor: "#22c55e", fillOpacity: 0.35 }).addTo(g));
  }

  // ── live math
  const sf = slopeFactor(pitch);
  const addedFootprintM2 = sections.reduce((a, s) => a + s.area_m2, 0);
  const addedSlopedSq = sq(addedFootprintM2 * sf);
  const baseTotal = result?.roof?.surface_squares || 0;
  // Add mode: drawn area adds to Google's number (for a clipped-off wing).
  // Replace mode: your full trace IS the roof — Google's number is ignored
  // (so tracing the whole roof can't double-count).
  const adjustedTotal = replaceMode ? addedSlopedSq : baseTotal + addedSlopedSq;

  const slopedB = result?.materials?.sloped || {};
  const wastePct = slopedB.waste_pct ?? 10;
  const adjustedSlopedMeasured = replaceMode ? addedSlopedSq : (slopedB.measured_squares || 0) + addedSlopedSq;
  const adjustedSlopedOrder = adjustedSlopedMeasured * (1 + wastePct / 100);

  const r2 = (n) => Math.round(n * 100) / 100;

  return (
    <div style={{ marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 14, overflow: "hidden", fontFamily: FONT }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "#f8fafc", borderBottom: "1px solid #e5e7eb" }}>
        <b style={{ fontSize: 14 }}>🗺️ Verify / adjust outline</b>
        <button onClick={onClose} style={btn("#64748b", true)}>Close</button>
      </div>

      {/* map */}
      <div ref={mapEl} style={{ height: 380, width: "100%", background: "#e2e8f0" }} />

      {/* controls */}
      <div style={{ padding: 14 }}>
        {!drawing ? (
          <div>
            {/* mode: add a clipped-off piece, or retrace the whole roof (replaces) */}
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              <button onClick={() => setReplaceMode(false)} style={seg(!replaceMode)}>➕ Add missing area</button>
              <button onClick={() => setReplaceMode(true)} style={seg(replaceMode)}>⟳ Redraw whole roof</button>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={startDraw} style={btn("#2563eb")}>✏️ {replaceMode ? "Trace the whole roof" : "Draw a missing section"}</button>
            <label style={{ fontSize: 13, color: "#475569" }}>
              Pitch for {replaceMode ? "roof" : "added"} area:&nbsp;
              <input type="number" value={pitch} min={0} max={24} step={0.5}
                onChange={(e) => setPitch(e.target.value)}
                style={{ width: 54, fontFamily: FONT, fontSize: 14, padding: "4px 6px", border: "1px solid #cbd5e1", borderRadius: 6 }} />
              &nbsp;/12
            </label>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "#b45309", fontWeight: 700 }}>Tap the corners of the missing section on the map ({ptCount} point{ptCount === 1 ? "" : "s"})</span>
            <button onClick={finishSection} disabled={ptCount < 3} style={btn(ptCount < 3 ? "#94a3b8" : "#16a34a")}>Finish section</button>
            <button onClick={undoPoint} disabled={!ptCount} style={btn("#64748b", true)}>Undo point</button>
            <button onClick={cancelDraw} style={btn("#64748b", true)}>Cancel</button>
          </div>
        )}

        {/* sections list */}
        {sections.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {sections.map((s, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13.5, padding: "6px 0", borderBottom: "1px solid #f1f5f9" }}>
                <span>Section {i + 1}: <b>{r2(sq(s.area_m2 * sf))} sq</b> <span style={{ color: "#94a3b8" }}>({Math.round(s.area_m2 * 10.7639)} sqft footprint)</span></span>
                <button onClick={() => removeSection(i)} style={btn("#dc2626", true)}>Remove</button>
              </div>
            ))}
          </div>
        )}

        {/* live totals */}
        <div style={{ marginTop: 14, background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10, padding: 14 }}>
          <Row label="Automated read" value={`${r2(baseTotal)} sq`} muted={replaceMode} />
          <Row label={replaceMode ? "Your full trace (replaces it)" : "You added"} value={`${replaceMode ? "" : "+ "}${r2(addedSlopedSq)} sq`} accent="#16a34a" />
          <Row label="Adjusted total" value={`${r2(adjustedTotal)} sq`} big />
          <div style={{ borderTop: "1px dashed #bae6fd", marginTop: 8, paddingTop: 8 }}>
            <Row label={`Shingle order (w/ ${wastePct}% waste)`} value={`${r2(adjustedSlopedOrder)} sq`} accent="#2563eb" />
          </div>
        </div>
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>
          {replaceMode
            ? "Redraw mode: your trace IS the roof — the automated number is ignored. Trace the whole roof; treated as sloped/shingle at the pitch above. Nothing is saved."
            : "Add mode: only trace a section the read MISSED — it adds on top. Nothing is saved."}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, big, accent, muted }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "3px 0", opacity: muted ? 0.45 : 1 }}>
      <span style={{ fontSize: big ? 14 : 13, color: "#475569", fontWeight: big ? 700 : 400, textDecoration: muted ? "line-through" : "none" }}>{label}</span>
      <b style={{ fontSize: big ? 20 : 15, color: accent || "#0f172a", textDecoration: muted ? "line-through" : "none" }}>{value}</b>
    </div>
  );
}

// Segmented toggle button (Add vs Redraw mode).
function seg(active) {
  return {
    flex: 1, fontFamily: FONT, fontSize: 13, fontWeight: 700,
    color: active ? "#fff" : "#475569",
    background: active ? "#2563eb" : "#fff",
    border: `1px solid ${active ? "#2563eb" : "#cbd5e1"}`,
    borderRadius: 8, padding: "8px 10px", cursor: "pointer",
  };
}

function btn(color, outline) {
  return {
    fontFamily: FONT, fontSize: 13.5, fontWeight: 700,
    color: outline ? color : "#fff",
    background: outline ? "#fff" : color,
    border: `1px solid ${color}`, borderRadius: 8, padding: "7px 14px", cursor: "pointer",
  };
}
