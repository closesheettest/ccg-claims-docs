// Roof Measurement — map editor (the human-verification layer).
//
// Three tools, chosen with the mode toggle:
//   • Add missing area — trace a section the automated read clipped; it ADDS.
//   • Redraw whole roof — trace the whole roof; your trace REPLACES the number.
//   • Buildings — tap each building on the property to measure it precisely
//       (its own squares + pitch); tap-remove any you don't want. This is how a
//       multi-structure lot gets the right total when Google locked onto the
//       wrong/partial building, and mirrors Roofr's "all buildings" ordering.
//
// While tracing, every placed point is a DRAGGABLE handle — drop the corners
// roughly, then nudge any of them to line up with the roof edge.
//
// Traced/added area is classed by its pitch (≤2.5/12 → membrane 10%, steeper →
// shingle). Building measurements come from harvest-roof-report per tap. The
// corrected total flows up to the report card. Nothing is saved.

import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const SQ_M_PER_SQUARE = 9.290304;
const FONT = "'Oswald', system-ui, sans-serif";

function polygonAreaM2(pts) {
  if (!pts || pts.length < 3) return 0;
  const lat0 = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
  const mPerLat = 110540, mPerLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const xy = pts.map((p) => [p.lng * mPerLng, p.lat * mPerLat]);
  let a = 0;
  for (let i = 0; i < xy.length; i++) { const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}
const slopeFactor = (x12) => Math.sqrt(1 + Math.pow((+x12 || 0) / 12, 2));
const sq = (m2) => m2 / SQ_M_PER_SQUARE;
const r2 = (n) => Math.round(n * 100) / 100;

// Orthogonalize a traced polygon — nudge every corner toward a right angle so a
// roughly-drawn outline snaps square (roofs are rectilinear). Iterative method
// (à la iD editor): each vertex moves along the bisector of its two edges,
// scaled by how far off 90° it is; converges for near-rectangular shapes.
function squareUp(latlngs) {
  const n = latlngs.length;
  if (n < 4) return latlngs;
  const lat0 = latlngs.reduce((a, p) => a + p.lat, 0) / n;
  const mLat = 110540, mLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  let P = latlngs.map((p) => [p.lng * mLng, p.lat * mLat]);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const len = (v) => Math.hypot(v[0], v[1]);
  const norm = (v) => { const l = len(v) || 1; return [v[0] / l, v[1] / l]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const scaleV = (v, s) => [v[0] * s, v[1] * s];
  for (let iter = 0; iter < 1000; iter++) {
    let maxM = 0;
    const motions = P.map((b, i) => {
      const a = P[(i - 1 + n) % n], c = P[(i + 1) % n];
      let p = sub(a, b), q = sub(c, b);
      const s = Math.min(len(p), len(q));
      p = norm(p); q = norm(q);
      const dp = dot(p, q);
      const m = scaleV(norm(add(p, q)), dp * s * 0.5);
      maxM = Math.max(maxM, len(m));
      return m;
    });
    for (let i = 0; i < n; i++) P[i] = add(P[i], motions[i]);
    if (maxM < 1e-4) break;
  }
  return P.map(([x, y]) => ({ lng: x / mLng, lat: y / mLat }));
}
const vertexIcon = () => L.divIcon({ className: "", html: '<div style="width:13px;height:13px;border-radius:50%;background:#f59e0b;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.6)"></div>', iconSize: [13, 13], iconAnchor: [7, 7] });

export default function RoofMeasureEditor({ result, onClose, onAdjust }) {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const drawLayerRef = useRef(null);      // committed section polygons
  const activeLayerRef = useRef(null);    // in-progress vertex handles
  const activePolyRef = useRef(null);     // in-progress polyline
  const bLayerRef = useRef(null);         // building markers
  const bMarkersRef = useRef({});         // id -> marker
  const maskOverlayRef = useRef(null);
  const drawingRef = useRef(false);
  const modeRef = useRef("add");
  const ptsRef = useRef([]);

  const [mode, setMode] = useState("add");            // add | redraw | buildings
  const [drawing, setDrawing] = useState(false);
  const [sections, setSections] = useState([]);       // [{ pts, area_m2 }]
  const [pitch, setPitch] = useState(result?.roof?.avg_pitch_x12 ?? 6);
  const [ptCount, setPtCount] = useState(0);
  const [maskState, setMaskState] = useState("loading");
  const [showMask, setShowMask] = useState(false); // off by default — the read is just a reference; the salesman draws the roof
  const [buildings, setBuildings] = useState([]);     // measured buildings
  const [bLoading, setBLoading] = useState(false);

  const buildMode = mode === "buildings";
  modeRef.current = mode;

  const lat = result?.location?.lat;
  const lng = result?.location?.lng;

  // ── init map
  useEffect(() => {
    if (!mapEl.current || mapRef.current || lat == null || lng == null) return;
    const m = L.map(mapEl.current, { zoomControl: true }).setView([lat, lng], 20);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 21, maxNativeZoom: 19, attribution: "Imagery &copy; Esri" }).addTo(m);
    L.marker([lat, lng], {
      interactive: false, keyboard: false,
      icon: L.divIcon({ className: "", html: '<div style="font-size:34px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))">📍</div>', iconSize: [34, 34], iconAnchor: [17, 31] }),
    }).addTo(m);
    fetch("/.netlify/functions/harvest-roof-mask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lat, lng }) })
      .then((r) => r.json())
      .then((d) => {
        if (!d || !d.ok || !d.png || !d.bounds || !mapRef.current) { setMaskState("none"); return; }
        maskOverlayRef.current = L.imageOverlay(d.png, d.bounds, { opacity: 1, interactive: false });
        maskOverlayRef.current.addTo(mapRef.current);
        setMaskState("ready");
      })
      .catch(() => setMaskState("none"));
    drawLayerRef.current = L.layerGroup().addTo(m);
    activeLayerRef.current = L.layerGroup().addTo(m);
    bLayerRef.current = L.layerGroup().addTo(m);
    m.on("click", onMapClick);
    setTimeout(() => m.invalidateSize(), 60);
    setTimeout(() => m.invalidateSize(), 300);
    mapRef.current = m;
    return () => { m.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  // cursor: pointer to tap-select buildings, arrow while tracing, else default
  useEffect(() => {
    const m = mapRef.current;
    if (m) m.getContainer().style.cursor = buildMode ? "pointer" : (drawing ? "pointer" : "");
  }, [drawing, buildMode]);

  useEffect(() => {
    const ov = maskOverlayRef.current, m = mapRef.current;
    if (!ov || !m) return;
    if (showMask) ov.addTo(m); else ov.remove();
  }, [showMask, maskState]);

  // ── drawing with draggable vertices
  function redrawActive() {
    const g = activeLayerRef.current, m = mapRef.current; if (!g || !m) return;
    g.clearLayers();
    if (activePolyRef.current) { activePolyRef.current.remove(); activePolyRef.current = null; }
    const pts = ptsRef.current;
    if (pts.length >= 2) activePolyRef.current = L.polyline(pts.map((p) => [p.lat, p.lng]), { color: "#f59e0b", weight: 2, dashArray: "5,5" }).addTo(m);
    pts.forEach((p, i) => {
      const mk = L.marker([p.lat, p.lng], { draggable: true, icon: vertexIcon() }).addTo(g);
      mk.on("drag", (ev) => {
        ptsRef.current[i] = { lat: ev.latlng.lat, lng: ev.latlng.lng };
        if (activePolyRef.current) activePolyRef.current.setLatLngs(ptsRef.current.map((q) => [q.lat, q.lng]));
      });
    });
  }

  function onMapClick(e) {
    if (modeRef.current === "buildings") { measureBuilding(e.latlng); return; }
    if (!drawingRef.current) return;
    ptsRef.current = [...ptsRef.current, { lat: e.latlng.lat, lng: e.latlng.lng }];
    setPtCount(ptsRef.current.length);
    redrawActive();
  }

  function startDraw() { drawingRef.current = true; setDrawing(true); ptsRef.current = []; setPtCount(0); redrawActive(); }
  function undoPoint() { ptsRef.current = ptsRef.current.slice(0, -1); setPtCount(ptsRef.current.length); redrawActive(); }
  function squareTrace() { if (ptsRef.current.length < 4) return; ptsRef.current = squareUp(ptsRef.current); redrawActive(); }
  function cancelDraw() {
    drawingRef.current = false; setDrawing(false); ptsRef.current = []; setPtCount(0);
    if (activePolyRef.current) { activePolyRef.current.remove(); activePolyRef.current = null; }
    if (activeLayerRef.current) activeLayerRef.current.clearLayers();
  }
  function finishSection() {
    const pts = ptsRef.current.slice();
    if (pts.length < 3) return;
    const flat = (+pitch) < 2.5;
    // flat sections drawn in a blue tint so pitched vs flat reads at a glance
    L.polygon(pts.map((p) => [p.lat, p.lng]), { color: flat ? "#0284c7" : "#16a34a", weight: 2, fillColor: flat ? "#38bdf8" : "#22c55e", fillOpacity: 0.35 }).addTo(drawLayerRef.current);
    setSections((prev) => [...prev, { pts, area_m2: polygonAreaM2(pts), pitch: +pitch }]);
    cancelDraw();
  }
  function removeSection(idx) {
    const next = sections.filter((_, i) => i !== idx);
    setSections(next);
    const g = drawLayerRef.current; if (!g) return;
    g.clearLayers();
    next.forEach((s) => { const flat = (+s.pitch) < 2.5; L.polygon(s.pts.map((p) => [p.lat, p.lng]), { color: flat ? "#0284c7" : "#16a34a", weight: 2, fillColor: flat ? "#38bdf8" : "#22c55e", fillOpacity: 0.35 }).addTo(g); });
  }

  // ── buildings: tap to measure one precisely
  async function measureBuilding(latlng) {
    if (bLoading) return;
    setBLoading(true);
    try {
      const d = await fetch("/.netlify/functions/harvest-roof-report", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: latlng.lat, lng: latlng.lng }),
      }).then((r) => r.json());
      if (d && d.ok && d.roof) {
        const s = d.materials?.sloped || {}, f = d.materials?.flat || {};
        const id = `${Date.now()}_${Math.round(latlng.lat * 1e5)}`;
        const total = d.roof.surface_squares || 0;
        const b = { id, lat: latlng.lat, lng: latlng.lng, total, pitch: d.roof.avg_pitch_x12,
          sloped_m: s.measured_squares || 0, sloped_o: s.order_squares || 0, flat_m: f.measured_squares || 0, flat_o: f.order_squares || 0 };
        const mk = L.marker([latlng.lat, latlng.lng], {
          icon: L.divIcon({ className: "", html: `<div style="background:#16a34a;color:#fff;font:700 12px/1 ${FONT};padding:5px 8px;border-radius:9px;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5);white-space:nowrap">${total} sq ✕</div>`, iconSize: [0, 0], iconAnchor: [0, 12] }),
        }).addTo(bLayerRef.current);
        mk.on("click", (ev) => { L.DomEvent.stop(ev); removeBuilding(id); });
        bMarkersRef.current[id] = mk;
        setBuildings((prev) => [...prev, b]);
      }
    } catch { /* ignore */ }
    setBLoading(false);
  }
  function removeBuilding(id) {
    const mk = bMarkersRef.current[id];
    if (mk) { mk.remove(); delete bMarkersRef.current[id]; }
    setBuildings((prev) => prev.filter((b) => b.id !== id));
  }

  // ── live math — each traced section is bucketed by ITS OWN pitch, so a roof
  // with a pitched group AND a flat section is captured by drawing each part.
  const curIsFlat = (+pitch) < 2.5; // classification the NEXT trace will get (for the UI hint)
  const isFlatSec = (s) => (+s.pitch) < 2.5;
  const secSurfaceSq = (s) => sq(s.area_m2 * slopeFactor(+s.pitch)); // flat sf ≈ 1
  const addedSlopedSurfaceSq = sections.filter((s) => !isFlatSec(s)).reduce((a, s) => a + secSurfaceSq(s), 0);
  const addedFlatSurfaceSq = sections.filter(isFlatSec).reduce((a, s) => a + secSurfaceSq(s), 0);
  const baseSloped = result?.materials?.sloped || {};
  const baseFlat = result?.materials?.flat || {};
  const slopedWaste = baseSloped.waste_pct ?? 12;
  const flatWaste = baseFlat.waste_pct ?? 10;

  const hasBuildings = buildings.length > 0;
  const bTotal = buildings.reduce((a, b) => a + b.total, 0);
  const bSlopedM = buildings.reduce((a, b) => a + b.sloped_m, 0);
  const bSlopedO = buildings.reduce((a, b) => a + b.sloped_o, 0);
  const bFlatM = buildings.reduce((a, b) => a + b.flat_m, 0);
  const bFlatO = buildings.reduce((a, b) => a + b.flat_o, 0);

  // What the salesman TRACES is the measurement — we never add the automated read on
  // top of it. Adding double-counted: tracing the whole roof read ~2× the real squares
  // (drew 20 sq, matched Roofr's 19.8, but the card showed 40). Draw = the number.
  const adjSlopedMeasured = addedSlopedSurfaceSq;
  const adjFlatMeasured = addedFlatSurfaceSq;
  const adjSlopedOrder = adjSlopedMeasured * (1 + slopedWaste / 100);
  const adjFlatOrder = adjFlatMeasured * (1 + flatWaste / 100);
  const adjustedTotal = adjSlopedMeasured + adjFlatMeasured;

  // Push corrected numbers to the report card. Buildings mode wins when used.
  const everRef = useRef(false);
  useEffect(() => {
    if (!onAdjust) return;
    if (hasBuildings) {
      everRef.current = true;
      onAdjust({
        total: r2(bTotal),
        sloped: { measured_squares: r2(bSlopedM), waste_pct: bSlopedM > 0 ? Math.round((bSlopedO / bSlopedM - 1) * 100) : slopedWaste, order_squares: r2(bSlopedO) },
        flat: { measured_squares: r2(bFlatM), waste_pct: flatWaste, order_squares: r2(bFlatO) },
      });
    } else if (sections.length > 0) {
      everRef.current = true;
      onAdjust({
        total: r2(adjustedTotal),
        sloped: { measured_squares: r2(adjSlopedMeasured), waste_pct: slopedWaste, order_squares: r2(adjSlopedOrder) },
        flat: { measured_squares: r2(adjFlatMeasured), waste_pct: flatWaste, order_squares: r2(adjFlatOrder) },
      });
    } else if (everRef.current) {
      onAdjust(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, pitch, buildings]);

  return (
    <div style={{ marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 14, overflow: "hidden", fontFamily: FONT }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "#f8fafc", borderBottom: "1px solid #e5e7eb" }}>
        <b style={{ fontSize: 14 }}>🗺️ Verify / adjust outline</b>
        <button onClick={onClose} style={btn("#64748b", true)}>Close</button>
      </div>

      <div ref={mapEl} style={{ height: 380, width: "100%", background: "#e2e8f0" }} />

      <div style={{ padding: 14 }}>
        {/* mode toggle */}
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <button onClick={() => { cancelDraw(); setMode("add"); }} style={seg(mode === "add")}>➕ Add area</button>
          <button onClick={() => { cancelDraw(); setMode("buildings"); }} style={seg(mode === "buildings")}>🏠 Buildings</button>
        </div>

        {/* Show the Solar-API "captured" read (green) as a reference — handy for showing
            someone what was auto-detected so they can trace the missing areas. */}
        {!buildMode && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#475569", marginBottom: 12 }}>
            <input type="checkbox" checked={showMask} onChange={(e) => setShowMask(e.target.checked)} disabled={maskState !== "ready"} />
            <span>Show what the read captured (<span style={{ color: "#16a34a", fontWeight: 700 }}>green</span>) — {maskState === "loading" ? "loading…" : maskState === "none" ? "not available" : "reference only; trace the whole roof yourself"}</span>
          </label>
        )}

        {/* BUILDINGS MODE */}
        {buildMode ? (
          <div>
            <div style={{ fontSize: 13.5, color: "#b45309", fontWeight: 700, marginBottom: 8 }}>
              🏠 Tap each building you want to include{bLoading ? " — measuring…" : ""}. Tap a green tag to remove it.
            </div>
            {buildings.length === 0 && <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>No buildings selected yet — tap the roofs on the map.</div>}
            {buildings.map((b, i) => (
              <div key={b.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13.5, padding: "6px 0", borderBottom: "1px solid #f1f5f9" }}>
                <span>Building {i + 1}: <b>{r2(b.total)} sq</b> <span style={{ color: "#94a3b8" }}>{b.pitch != null ? `· ${b.pitch}/12` : ""}</span></span>
                <button onClick={() => removeBuilding(b.id)} style={btn("#dc2626", true)}>Remove</button>
              </div>
            ))}
          </div>
        ) : !drawing ? (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={startDraw} style={btn(curIsFlat ? "#0284c7" : "#2563eb")}>✏️ Draw a {curIsFlat ? "FLAT" : "PITCHED"} section</button>
            {/* pitched vs flat — pick before drawing; a flat section counts as membrane/metal, not shingle */}
            <button onClick={() => setPitch(result?.roof?.avg_pitch_x12 || 6)} style={seg(!curIsFlat)}>⌂ Pitched</button>
            <button onClick={() => setPitch(0)} style={seg(curIsFlat)}>▭ Flat</button>
            {!curIsFlat && (
              <label style={{ fontSize: 13, color: "#475569" }}>
                pitch&nbsp;
                <input type="number" value={pitch} min={0} max={24} step={0.5} onChange={(e) => setPitch(e.target.value)}
                  style={{ width: 54, fontFamily: FONT, fontSize: 14, padding: "4px 6px", border: "1px solid #cbd5e1", borderRadius: 6 }} />
                &nbsp;/12
              </label>
            )}
            <span style={{ fontSize: 12.5, fontWeight: 700, color: curIsFlat ? "#0284c7" : "#16a34a" }}>
              → counts as {curIsFlat ? "FLAT (membrane/metal)" : "SHINGLE"}
            </span>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "#b45309", fontWeight: 700 }}>Tap corners, drag to adjust, then square up ({ptCount})</span>
            <button onClick={squareTrace} disabled={ptCount < 4} style={btn(ptCount < 4 ? "#94a3b8" : "#7c3aed")}>◻ Square up</button>
            <button onClick={finishSection} disabled={ptCount < 3} style={btn(ptCount < 3 ? "#94a3b8" : "#16a34a")}>Finish section</button>
            <button onClick={undoPoint} disabled={!ptCount} style={btn("#64748b", true)}>Undo point</button>
            <button onClick={cancelDraw} style={btn("#64748b", true)}>Cancel</button>
          </div>
        )}

        {/* sections list (trace modes) */}
        {!buildMode && sections.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {sections.map((s, i) => {
              const flat = isFlatSec(s);
              return (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13.5, padding: "6px 0", borderBottom: "1px solid #f1f5f9" }}>
                <span>
                  <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: flat ? "#38bdf8" : "#22c55e", marginRight: 6 }} />
                  Section {i + 1}: <b>{r2(secSurfaceSq(s))} sq</b>{" "}
                  <span style={{ color: flat ? "#0284c7" : "#16a34a", fontWeight: 700 }}>{flat ? "flat" : `${s.pitch}/12`}</span>
                  <span style={{ color: "#94a3b8" }}> · {Math.round(s.area_m2 * 10.7639)} sqft footprint</span>
                </span>
                <button onClick={() => removeSection(i)} style={btn("#dc2626", true)}>Remove</button>
              </div>
              );
            })}
          </div>
        )}

        {/* live totals */}
        <div style={{ marginTop: 14, background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10, padding: 14 }}>
          {buildMode ? (
            <>
              <Row label={`Buildings selected`} value={`${buildings.length}`} />
              <Row label="Total (selected buildings)" value={`${r2(bTotal)} sq`} big />
              {bSlopedM > 0 && <Row label={`Shingle order`} value={`${r2(bSlopedO)} sq`} accent="#2563eb" />}
              {bFlatM > 0 && <Row label={`Membrane order`} value={`${r2(bFlatO)} sq`} accent="#0891b2" />}
            </>
          ) : (
            <>
              {addedSlopedSurfaceSq > 0 && <Row label="Traced · pitched → shingle" value={`${r2(addedSlopedSurfaceSq)} sq`} accent="#16a34a" />}
              {addedFlatSurfaceSq > 0 && <Row label="Traced · flat → membrane" value={`${r2(addedFlatSurfaceSq)} sq`} accent="#0284c7" />}
              {sections.length === 0 && <Row label="Draw the roof to measure" value="—" muted />}
              <Row label="Total" value={`${r2(adjustedTotal)} sq`} big />
              <div style={{ borderTop: "1px dashed #bae6fd", marginTop: 8, paddingTop: 8 }}>
                {adjSlopedMeasured > 0 && <Row label={`Shingle order (w/ ${slopedWaste}% waste)`} value={`${r2(adjSlopedOrder)} sq`} accent="#2563eb" />}
                {adjFlatMeasured > 0 && <Row label={`Membrane order (w/ ${flatWaste}% waste)`} value={`${r2(adjFlatOrder)} sq`} accent="#0891b2" />}
              </div>
            </>
          )}
        </div>
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>
          {buildMode
            ? "Each building is measured on its own (squares + pitch). Sum only the ones you want. Nothing is saved."
            : `Draw pitched and flat sections separately — each counts by its own pitch (flat → membrane/metal, sloped → shingle). What you trace is the measurement. Nothing is saved.`}
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
function seg(active) {
  return { flex: 1, fontFamily: FONT, fontSize: 12.5, fontWeight: 700, color: active ? "#fff" : "#475569",
    background: active ? "#2563eb" : "#fff", border: `1px solid ${active ? "#2563eb" : "#cbd5e1"}`, borderRadius: 8, padding: "8px 6px", cursor: "pointer" };
}
function btn(color, outline) {
  return { fontFamily: FONT, fontSize: 13.5, fontWeight: 700, color: outline ? color : "#fff",
    background: outline ? "#fff" : color, border: `1px solid ${color}`, borderRadius: 8, padding: "7px 14px", cursor: "pointer" };
}
