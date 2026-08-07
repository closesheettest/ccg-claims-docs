// Roof Measurement — CORRECT THE READ (don't redraw it).
//
// The Team Measurement (Google Solar + LiDAR + records) hands the rep a roof read
// as the STARTING number, shown as the green overlay on the satellite. The rep does
// only two things to it — the exact two ways a read is ever wrong:
//   ➕ ADD a section it MISSED      (grows the number)
//   ✂️ CUT a section it OVER-GRABBED (the cage, a neighbor's edge — shrinks it)
// Corrected total = auto-read + added − cut, live. No full re-trace — that's a
// hidden escape hatch for the rare read the team flags as way-off.
//
// Added/cut area is classed by its pitch (≤2.5/12 → membrane, steeper → shingle).
// The corrected total flows up to the report card. Nothing is saved.

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

// Orthogonalize a traced polygon toward right angles (roofs are rectilinear).
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
const vertexIcon = (cut) => L.divIcon({ className: "", html: `<div style="width:13px;height:13px;border-radius:50%;background:${cut ? "#dc2626" : "#16a34a"};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.6)"></div>`, iconSize: [13, 13], iconAnchor: [7, 7] });

export default function RoofMeasureEditor({ result, onClose, onAdjust, onRemeasure }) {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const drawLayerRef = useRef(null);      // committed correction polygons
  const activeLayerRef = useRef(null);    // in-progress vertex handles
  const activePolyRef = useRef(null);     // in-progress polyline
  const maskOverlayRef = useRef(null);    // the team's green auto-read (the base you correct)
  const drawingRef = useRef(false);
  const modeRef = useRef("add");
  const ptsRef = useRef([]);

  const [mode, setMode] = useState("add");            // add | cut
  const [drawing, setDrawing] = useState(false);
  const [ptCount, setPtCount] = useState(0);
  const [pitch, setPitch] = useState(result?.roof?.avg_pitch_x12 ?? 6);
  const [corrections, setCorrections] = useState([]); // [{ kind:'add'|'cut', pts, area_m2, pitch }]
  const [maskState, setMaskState] = useState("loading");
  const [showMask, setShowMask] = useState(true);     // ON by default — it IS the base you're correcting
  const [redraw, setRedraw] = useState(false);        // hidden escape hatch for a way-off read
  const [remeasuring, setRemeasuring] = useState(false); // re-running the read after a pin drag
  const markerRef = useRef(null);
  const doRemeasureRef = useRef(null);

  // Pin dragged onto the correct house → re-run the read there. Kept in a ref so the
  // (mount-time) drag handler always calls the latest closure. onRemeasure updates the
  // parent read → result.location changes → the map re-inits at the new spot.
  doRemeasureRef.current = async (nlat, nlng) => {
    if (!onRemeasure) return;
    setRemeasuring(true);
    setCorrections([]);
    if (drawLayerRef.current) drawLayerRef.current.clearLayers();
    try { await onRemeasure(nlat, nlng); } finally { setRemeasuring(false); }
  };

  modeRef.current = mode;
  const cutMode = mode === "cut";
  const lat = result?.location?.lat;
  const lng = result?.location?.lng;

  // ── init map
  useEffect(() => {
    if (!mapEl.current || mapRef.current || lat == null || lng == null) return;
    const m = L.map(mapEl.current, { zoomControl: true }).setView([lat, lng], 20);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 21, maxNativeZoom: 19, attribution: "Imagery &copy; Esri" }).addTo(m);
    markerRef.current = L.marker([lat, lng], {
      draggable: !!onRemeasure, keyboard: false, autoPan: true,
      title: onRemeasure ? "Wrong house? Drag me onto the correct roof to re-measure." : undefined,
      icon: L.divIcon({ className: "", html: '<div style="font-size:34px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))">📍</div>', iconSize: [34, 34], iconAnchor: [17, 31] }),
    }).addTo(m);
    if (onRemeasure) markerRef.current.on("dragend", (ev) => { const p = ev.target.getLatLng(); doRemeasureRef.current && doRemeasureRef.current(p.lat, p.lng); });
    fetch("/.netlify/functions/harvest-roof-mask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lat, lng }) })
      .then((r) => r.json())
      .then((d) => {
        if (!d || !d.ok || !d.png || !d.bounds || !mapRef.current) { setMaskState("none"); return; }
        maskOverlayRef.current = L.imageOverlay(d.png, d.bounds, { opacity: 1, interactive: false });
        maskOverlayRef.current.addTo(mapRef.current);   // shown by default — it's the base
        setMaskState("ready");
      })
      .catch(() => setMaskState("none"));
    drawLayerRef.current = L.layerGroup().addTo(m);
    activeLayerRef.current = L.layerGroup().addTo(m);
    m.on("click", onMapClick);
    setTimeout(() => m.invalidateSize(), 60);
    setTimeout(() => m.invalidateSize(), 300);
    mapRef.current = m;
    return () => { m.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  useEffect(() => {
    const m = mapRef.current;
    if (m) m.getContainer().style.cursor = drawing ? "crosshair" : "";
  }, [drawing]);

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
    const col = cutMode ? "#dc2626" : "#16a34a";
    if (pts.length >= 2) activePolyRef.current = L.polyline(pts.map((p) => [p.lat, p.lng]), { color: col, weight: 2, dashArray: "5,5" }).addTo(m);
    pts.forEach((p, i) => {
      const mk = L.marker([p.lat, p.lng], { draggable: true, icon: vertexIcon(cutMode) }).addTo(g);
      mk.on("drag", (ev) => {
        ptsRef.current[i] = { lat: ev.latlng.lat, lng: ev.latlng.lng };
        if (activePolyRef.current) activePolyRef.current.setLatLngs(ptsRef.current.map((q) => [q.lat, q.lng]));
      });
    });
  }
  function onMapClick(e) {
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
  function drawCorrection(c) {
    const flat = (+c.pitch) < 2.5;
    const style = c.kind === "cut"
      ? { color: "#dc2626", weight: 2, fillColor: "#ef4444", fillOpacity: 0.35, dashArray: "6,4" }
      : { color: flat ? "#0284c7" : "#16a34a", weight: 2, fillColor: flat ? "#38bdf8" : "#22c55e", fillOpacity: 0.35 };
    L.polygon(c.pts.map((p) => [p.lat, p.lng]), style).addTo(drawLayerRef.current);
  }
  function finishSection() {
    const pts = ptsRef.current.slice();
    if (pts.length < 3) return;
    const c = { kind: modeRef.current, pts, area_m2: polygonAreaM2(pts), pitch: +pitch };
    drawCorrection(c);
    setCorrections((prev) => [...prev, c]);
    cancelDraw();
  }
  function removeCorrection(idx) {
    const next = corrections.filter((_, i) => i !== idx);
    setCorrections(next);
    const g = drawLayerRef.current; if (!g) return;
    g.clearLayers();
    next.forEach(drawCorrection);
  }

  // ── live math: corrected total = auto-read + added − cut (each classed by pitch)
  const isFlat = (c) => (+c.pitch) < 2.5;
  const secSurfaceSq = (c) => sq(c.area_m2 * slopeFactor(+c.pitch));
  const adds = corrections.filter((c) => c.kind === "add");
  const cuts = corrections.filter((c) => c.kind === "cut");
  const addSloped = adds.filter((c) => !isFlat(c)).reduce((a, c) => a + secSurfaceSq(c), 0);
  const addFlat = adds.filter(isFlat).reduce((a, c) => a + secSurfaceSq(c), 0);
  const cutSloped = cuts.filter((c) => !isFlat(c)).reduce((a, c) => a + secSurfaceSq(c), 0);
  const cutFlat = cuts.filter(isFlat).reduce((a, c) => a + secSurfaceSq(c), 0);

  const baseSloped = result?.materials?.sloped || {};
  const baseFlat = result?.materials?.flat || {};
  const bSlopedM = baseSloped.measured_squares || 0;
  const bFlatM = baseFlat.measured_squares || 0;
  const baseTotal = result?.roof?.surface_squares ?? r2(bSlopedM + bFlatM);
  const slopedWaste = baseSloped.waste_pct ?? 12;
  const flatWaste = baseFlat.waste_pct ?? 10;

  // In redraw (escape hatch), the trace REPLACES the read; otherwise it corrects it.
  const adjSloped = redraw ? addSloped : Math.max(0, bSlopedM + addSloped - cutSloped);
  const adjFlat = redraw ? addFlat : Math.max(0, bFlatM + addFlat - cutFlat);
  const total = r2(adjSloped + adjFlat);
  const touched = corrections.length > 0 || redraw;

  // push corrected numbers up to the report card
  const everRef = useRef(false);
  useEffect(() => {
    if (!onAdjust) return;
    if (touched) {
      everRef.current = true;
      onAdjust({
        total,
        sloped: { measured_squares: r2(adjSloped), waste_pct: slopedWaste, order_squares: r2(adjSloped * (1 + slopedWaste / 100)) },
        flat: { measured_squares: r2(adjFlat), waste_pct: flatWaste, order_squares: r2(adjFlat * (1 + flatWaste / 100)) },
      });
    } else if (everRef.current) {
      onAdjust(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corrections, pitch, redraw]);

  const curFlat = (+pitch) < 2.5;
  const delta = r2(total - baseTotal);

  return (
    <div style={{ marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 14, overflow: "hidden", fontFamily: FONT }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: "#f8fafc", borderBottom: "1px solid #e5e7eb" }}>
        <b style={{ fontSize: 14 }}>🗺️ Correct the read</b>
        <button onClick={onClose} style={btn("#64748b", true)}>Close</button>
      </div>

      <div style={{ position: "relative" }}>
        <div ref={mapEl} style={{ height: 380, width: "100%", background: "#e2e8f0" }} />
        {onRemeasure && (
          <div style={{ position: "absolute", top: 8, left: 8, zIndex: 500, background: "rgba(15,23,42,.85)", color: "#fff", fontSize: 12, fontWeight: 700, padding: "5px 10px", borderRadius: 8, pointerEvents: "none" }}>
            🏠 Wrong house? Drag the 📍 pin onto the correct roof — it re-measures.
          </div>
        )}
        {remeasuring && (
          <div style={{ position: "absolute", inset: 0, zIndex: 600, background: "rgba(255,255,255,.7)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, color: "#0f172a", fontSize: 16 }}>
            📐 Re-measuring the new spot…
          </div>
        )}
      </div>

      <div style={{ padding: 14 }}>
        {/* what you're looking at */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#475569", marginBottom: 12 }}>
          <span style={{ display: "inline-block", width: 11, height: 11, borderRadius: 3, background: "#22c55e", opacity: 0.7 }} />
          The <b>green overlay</b> is what the read captured — {maskState === "loading" ? "loading…" : maskState === "none" ? "(not available here — use the satellite)" : "grow it where it missed, trim it where it grabbed too much."}
          {maskState === "ready" && (
            <label style={{ marginLeft: "auto", display: "inline-flex", gap: 5, alignItems: "center" }}>
              <input type="checkbox" checked={showMask} onChange={(e) => setShowMask(e.target.checked)} /> show
            </label>
          )}
        </div>

        {!redraw ? (
          <>
            {/* the two tools */}
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button onClick={() => { cancelDraw(); setMode("add"); }} style={seg(mode === "add", "#16a34a")}>➕ Add missed</button>
              <button onClick={() => { cancelDraw(); setMode("cut"); }} style={seg(mode === "cut", "#dc2626")}>✂️ Cut extra</button>
            </div>

            {!drawing ? (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <button onClick={startDraw} style={btn(cutMode ? "#dc2626" : "#16a34a")}>
                  {cutMode ? "✂️ Draw the area to CUT" : "➕ Draw the area it MISSED"}
                </button>
                <label style={{ fontSize: 13, color: "#475569" }}>
                  pitch&nbsp;
                  <input type="number" value={pitch} min={0} max={24} step={0.5} onChange={(e) => setPitch(e.target.value)}
                    style={{ width: 54, fontFamily: FONT, fontSize: 14, padding: "4px 6px", border: "1px solid #cbd5e1", borderRadius: 6 }} />
                  &nbsp;/12
                </label>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>{curFlat ? "flat → membrane" : "sloped → shingle"}</span>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 13, color: cutMode ? "#b91c1c" : "#15803d", fontWeight: 700 }}>
                  Tap the corners of the section to {cutMode ? "CUT" : "ADD"}, drag to adjust ({ptCount})
                </span>
                <button onClick={squareTrace} disabled={ptCount < 4} style={btn(ptCount < 4 ? "#94a3b8" : "#7c3aed")}>◻ Square up</button>
                <button onClick={finishSection} disabled={ptCount < 3} style={btn(ptCount < 3 ? "#94a3b8" : (cutMode ? "#dc2626" : "#16a34a"))}>Done</button>
                <button onClick={undoPoint} disabled={!ptCount} style={btn("#64748b", true)}>Undo point</button>
                <button onClick={cancelDraw} style={btn("#64748b", true)}>Cancel</button>
              </div>
            )}
          </>
        ) : (
          // ── escape hatch: redraw the whole roof (rare — the read was way off)
          !drawing ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "#b45309", fontWeight: 700 }}>Redraw mode — your trace replaces the read.</span>
              <button onClick={startDraw} style={btn("#2563eb")}>✏️ Draw a roof section</button>
              <label style={{ fontSize: 13, color: "#475569" }}>pitch&nbsp;
                <input type="number" value={pitch} min={0} max={24} step={0.5} onChange={(e) => setPitch(e.target.value)} style={{ width: 54, fontFamily: FONT, fontSize: 14, padding: "4px 6px", border: "1px solid #cbd5e1", borderRadius: 6 }} />&nbsp;/12
              </label>
              <button onClick={() => { cancelDraw(); setCorrections([]); setRedraw(false); }} style={btn("#64748b", true)}>↩ Back to correcting</button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "#2563eb", fontWeight: 700 }}>Trace this section ({ptCount})</span>
              <button onClick={squareTrace} disabled={ptCount < 4} style={btn(ptCount < 4 ? "#94a3b8" : "#7c3aed")}>◻ Square up</button>
              <button onClick={finishSection} disabled={ptCount < 3} style={btn(ptCount < 3 ? "#94a3b8" : "#2563eb")}>Done</button>
              <button onClick={undoPoint} disabled={!ptCount} style={btn("#64748b", true)}>Undo point</button>
              <button onClick={cancelDraw} style={btn("#64748b", true)}>Cancel</button>
            </div>
          )
        )}

        {/* corrections list */}
        {corrections.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {corrections.map((c, i) => {
              const cut = c.kind === "cut";
              return (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13.5, padding: "6px 0", borderBottom: "1px solid #f1f5f9" }}>
                  <span>
                    <span style={{ fontWeight: 700, color: cut ? "#dc2626" : "#16a34a" }}>{cut ? "✂️ Cut" : "➕ Add"}</span>{" "}
                    <b>{cut ? "−" : "+"}{r2(secSurfaceSq(c))} sq</b>{" "}
                    <span style={{ color: "#94a3b8" }}>· {isFlat(c) ? "flat" : `${c.pitch}/12`} · {Math.round(c.area_m2 * 10.7639)} sqft</span>
                  </span>
                  <button onClick={() => removeCorrection(i)} style={btn("#64748b", true)}>Remove</button>
                </div>
              );
            })}
          </div>
        )}

        {/* live total */}
        <div style={{ marginTop: 14, background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10, padding: 14 }}>
          {!redraw && <Row label="Auto-read (the team)" value={`${r2(baseTotal)} sq`} muted={touched} />}
          {adds.length > 0 && <Row label="＋ Added (missed)" value={`+${r2(addSloped + addFlat)} sq`} accent="#16a34a" />}
          {cuts.length > 0 && <Row label="− Cut (over-grabbed)" value={`−${r2(cutSloped + cutFlat)} sq`} accent="#dc2626" />}
          <Row label={touched ? "Corrected total" : "Total"} value={`${total} sq`} big />
          {touched && !redraw && (
            <div style={{ fontSize: 12, color: delta >= 0 ? "#16a34a" : "#dc2626", marginTop: 2 }}>
              {delta >= 0 ? "▲" : "▼"} {delta >= 0 ? "+" : ""}{delta} sq vs the auto-read
            </div>
          )}
          <div style={{ borderTop: "1px dashed #bae6fd", marginTop: 8, paddingTop: 8 }}>
            {adjSloped > 0 && <Row label={`Shingle order (w/ ${slopedWaste}% waste)`} value={`${r2(adjSloped * (1 + slopedWaste / 100))} sq`} accent="#2563eb" />}
            {adjFlat > 0 && <Row label={`Membrane order (w/ ${flatWaste}% waste)`} value={`${r2(adjFlat * (1 + flatWaste / 100))} sq`} accent="#0891b2" />}
          </div>
        </div>

        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <span>Grow the green where it missed, trim it where it grabbed too much. Nothing is saved.</span>
          {!redraw && !drawing && (
            <button onClick={() => { cancelDraw(); setCorrections([]); setRedraw(true); }} style={{ ...btn("#94a3b8", true), fontSize: 12, padding: "4px 10px" }}>Read way off? ↻ Redraw</button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, big, accent, muted }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "3px 0", opacity: muted ? 0.5 : 1 }}>
      <span style={{ fontSize: big ? 14 : 13, color: "#475569", fontWeight: big ? 700 : 400, textDecoration: muted ? "line-through" : "none" }}>{label}</span>
      <b style={{ fontSize: big ? 20 : 15, color: accent || "#0f172a", textDecoration: muted ? "line-through" : "none" }}>{value}</b>
    </div>
  );
}
function seg(active, color) {
  return { flex: 1, fontFamily: FONT, fontSize: 13, fontWeight: 700, color: active ? "#fff" : color,
    background: active ? color : "#fff", border: `1px solid ${color}`, borderRadius: 8, padding: "9px 6px", cursor: "pointer" };
}
function btn(color, outline) {
  return { fontFamily: FONT, fontSize: 13.5, fontWeight: 700, color: outline ? color : "#fff",
    background: outline ? "#fff" : color, border: `1px solid ${color}`, borderRadius: 8, padding: "7px 14px", cursor: "pointer" };
}
