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

// Trace-layer basemaps. Esri is the default; Mapbox (Maxar) is often sharper/newer —
// the rep flips between them to trace on whichever is clearest for THIS address.
const MAPBOX_TOKEN = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_MAPBOX_TOKEN) || "";
const BASEMAPS = {
  esri: { label: "Esri", url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", opts: { maxZoom: 21, maxNativeZoom: 19, attribution: "Imagery &copy; Esri" } },
  mapbox: { label: "Mapbox ✨", url: `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_TOKEN}`, opts: { maxZoom: 22, tileSize: 512, zoomOffset: -1, attribution: "Imagery &copy; Mapbox / Maxar" } },
};

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
  const [flatAll, setFlatAll] = useState(false);      // rep marks a mis-pitched flat commercial roof as all-membrane
  const [moveMode, setMoveMode] = useState(false);    // slide the whole green mask to line it up (registration shift)
  const [imagerySource, setImagerySource] = useState("esri"); // esri | mapbox — trace-layer picker
  const [remeasuring, setRemeasuring] = useState(false); // re-running the read after a pin drag
  const markerRef = useRef(null);
  const baseLayerRef = useRef(null);
  const imagerySourceRef = useRef("esri");
  const firstImgRef = useRef(true);
  const guideLayerRef = useRef(null);   // alignment guide lines + ghost dot while tracing
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
  imagerySourceRef.current = imagerySource;
  const cutMode = mode === "cut";
  const lat = result?.location?.lat;
  const lng = result?.location?.lng;

  // ── init map
  useEffect(() => {
    if (!mapEl.current || mapRef.current || lat == null || lng == null) return;
    const m = L.map(mapEl.current, { zoomControl: true }).setView([lat, lng], 20);
    const _b0 = BASEMAPS[imagerySourceRef.current] || BASEMAPS.esri;
    baseLayerRef.current = L.tileLayer(_b0.url, _b0.opts).addTo(m);
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
    guideLayerRef.current = L.layerGroup().addTo(m);
    m.on("click", onMapClick);
    m.on("mousemove", onMapMove);
    setTimeout(() => m.invalidateSize(), 60);
    setTimeout(() => m.invalidateSize(), 300);
    mapRef.current = m;
    return () => { m.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  useEffect(() => {
    const m = mapRef.current;
    if (m) m.getContainer().style.cursor = moveMode ? "move" : (drawing ? "crosshair" : "");
  }, [drawing, moveMode]);

  useEffect(() => {
    const ov = maskOverlayRef.current, m = mapRef.current;
    if (!ov || !m) return;
    if (showMask) ov.addTo(m); else ov.remove();
  }, [showMask, maskState]);

  // Imagery source picker — swap the trace basemap (Esri ↔ Mapbox) live, keeping it
  // under the green mask + drawings. Skips the mount run (map-init already added it).
  useEffect(() => {
    if (firstImgRef.current) { firstImgRef.current = false; return; }
    const m = mapRef.current; if (!m) return;
    const b = BASEMAPS[imagerySource] || BASEMAPS.esri;
    if (baseLayerRef.current) baseLayerRef.current.remove();
    baseLayerRef.current = L.tileLayer(b.url, b.opts).addTo(m);
    baseLayerRef.current.bringToBack();
  }, [imagerySource]);

  // ✋ Move overlay: slide the whole green mask to line it up with the photo when
  // Google's footprint sits nudged off Esri's imagery (a registration shift). Pure
  // alignment — one-finger map pan is disabled while active and the square count
  // never changes; it just lets the rep confirm the read sits on the real roof.
  useEffect(() => {
    const m = mapRef.current, ov = maskOverlayRef.current;
    if (!m) return;
    if (!moveMode || !ov) { if (m.dragging) m.dragging.enable(); return; }
    m.dragging.disable();
    let dragging = false, last = null;
    let sw = ov.getBounds().getSouthWest(), ne = ov.getBounds().getNorthEast();
    const onDown = (e) => { dragging = true; last = e.latlng; };
    const onMove = (e) => {
      if (!dragging || !last) return;
      const dLat = e.latlng.lat - last.lat, dLng = e.latlng.lng - last.lng;
      last = e.latlng;
      sw = L.latLng(sw.lat + dLat, sw.lng + dLng);
      ne = L.latLng(ne.lat + dLat, ne.lng + dLng);
      ov.setBounds(L.latLngBounds(sw, ne));
    };
    const onUp = () => { dragging = false; last = null; };
    m.on("mousedown", onDown); m.on("mousemove", onMove); m.on("mouseup", onUp);
    return () => {
      m.off("mousedown", onDown); m.off("mousemove", onMove); m.off("mouseup", onUp);
      if (mapRef.current && mapRef.current.dragging) mapRef.current.dragging.enable();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveMode]);

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
  // Snap a point to line up (same horizontal / vertical, in screen pixels) with a
  // corner you've already placed — so a tree-hidden corner squares off the visible
  // edges instead of a guess. Works on tap (touch) and click.
  function snapTo(latlng) {
    const m = mapRef.current; if (!m) return { lat: latlng.lat, lng: latlng.lng };
    const cur = m.latLngToContainerPoint(latlng);
    let sx = cur.x, sy = cur.y; const T = 9;
    for (const p of ptsRef.current) {
      const pp = m.latLngToContainerPoint(L.latLng(p.lat, p.lng));
      if (Math.abs(cur.x - pp.x) < T) sx = pp.x;
      if (Math.abs(cur.y - pp.y) < T) sy = pp.y;
    }
    const s = m.containerPointToLatLng([sx, sy]);
    return { lat: s.lat, lng: s.lng };
  }
  // Live guide lines + ghost dot as the cursor moves (desktop feedback for the snap).
  function onMapMove(e) {
    const g = guideLayerRef.current, m = mapRef.current;
    if (!g || !m) return;
    g.clearLayers();
    if (!drawingRef.current) return;
    const cur = m.latLngToContainerPoint(e.latlng);
    let sx = cur.x, sy = cur.y, vx = null, hy = null; const T = 9;
    for (const p of ptsRef.current) {
      const pp = m.latLngToContainerPoint(L.latLng(p.lat, p.lng));
      if (Math.abs(cur.x - pp.x) < T) { sx = pp.x; vx = pp.x; }
      if (Math.abs(cur.y - pp.y) < T) { sy = pp.y; hy = pp.y; }
    }
    const sz = m.getSize(), col = "#f59e0b";
    if (vx != null) g.addLayer(L.polyline([m.containerPointToLatLng([vx, 0]), m.containerPointToLatLng([vx, sz.y])], { color: col, weight: 1, dashArray: "4,5", interactive: false }));
    if (hy != null) g.addLayer(L.polyline([m.containerPointToLatLng([0, hy]), m.containerPointToLatLng([sz.x, hy])], { color: col, weight: 1, dashArray: "4,5", interactive: false }));
    g.addLayer(L.circleMarker(m.containerPointToLatLng([sx, sy]), { radius: 4, color: (vx != null || hy != null) ? col : "#22c55e", weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: false }));
  }
  function onMapClick(e) {
    if (!drawingRef.current) return;
    ptsRef.current = [...ptsRef.current, snapTo(e.latlng)];
    setPtCount(ptsRef.current.length);
    redrawActive();
  }
  function startDraw() { setMoveMode(false); drawingRef.current = true; setDrawing(true); ptsRef.current = []; setPtCount(0); redrawActive(); }
  function undoPoint() { ptsRef.current = ptsRef.current.slice(0, -1); setPtCount(ptsRef.current.length); redrawActive(); }
  function squareTrace() { if (ptsRef.current.length < 4) return; ptsRef.current = squareUp(ptsRef.current); redrawActive(); }
  function cancelDraw() {
    drawingRef.current = false; setDrawing(false); ptsRef.current = []; setPtCount(0);
    if (activePolyRef.current) { activePolyRef.current.remove(); activePolyRef.current = null; }
    if (activeLayerRef.current) activeLayerRef.current.clearLayers();
    if (guideLayerRef.current) guideLayerRef.current.clearLayers();
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
  const rawSlopedM = baseSloped.measured_squares || 0;
  const rawFlatM = baseFlat.measured_squares || 0;
  // "Whole roof is flat" — Solar mis-called a flat commercial roof as pitched
  // (parapets/HVAC fooled its pitch read). Fold the mis-classed sloped squares into
  // membrane, de-inflating them by the slope factor that was wrongly applied so the
  // area is the true footprint. Nothing gets ordered as shingle on a membrane roof.
  const pitchUsed = result?.roof?.avg_pitch_x12 ?? 6;
  const bSlopedM = flatAll ? 0 : rawSlopedM;
  const bFlatM = flatAll ? r2(rawFlatM + rawSlopedM / slopeFactor(pitchUsed)) : rawFlatM;
  const baseTotal = result?.roof?.surface_squares ?? r2(rawSlopedM + rawFlatM);
  const slopedWaste = baseSloped.waste_pct ?? 12;
  const flatWaste = baseFlat.waste_pct ?? 10;

  // In redraw (escape hatch), the trace REPLACES the read; otherwise it corrects it.
  const adjSloped = redraw ? addSloped : Math.max(0, bSlopedM + addSloped - cutSloped);
  const adjFlat = redraw ? addFlat : Math.max(0, bFlatM + addFlat - cutFlat);
  const total = r2(adjSloped + adjFlat);
  const touched = corrections.length > 0 || redraw || flatAll;

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
  }, [corrections, pitch, redraw, flatAll]);

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
        {MAPBOX_TOKEN && (
          <div style={{ position: "absolute", top: 8, right: 8, zIndex: 500, display: "flex", borderRadius: 8, overflow: "hidden", boxShadow: "0 1px 5px rgba(0,0,0,.35)", fontFamily: FONT }}>
            {["esri", "mapbox"].map((src) => (
              <button key={src} onClick={() => setImagerySource(src)}
                title={src === "mapbox" ? "Sharper / more recent imagery (Maxar)" : "Esri World Imagery"}
                style={{ fontSize: 11.5, fontWeight: 800, padding: "5px 11px", border: "none", cursor: "pointer", letterSpacing: ".02em",
                  color: imagerySource === src ? "#fff" : "#0f172a",
                  background: imagerySource === src ? "#2563eb" : "rgba(255,255,255,.92)" }}>
                {BASEMAPS[src].label}
              </button>
            ))}
          </div>
        )}
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

        {/* Whole-roof pitch fix: one tap re-classes a mis-pitched flat commercial
            roof to all-membrane (no shingle order, slope inflation removed). */}
        {!redraw && (
          <button
            onClick={() => { const nv = !flatAll; setFlatAll(nv); if (nv) setPitch(0); }}
            style={{
              width: "100%", fontFamily: FONT, fontSize: 13.5, fontWeight: 800, cursor: "pointer",
              marginBottom: 12, borderRadius: 9, padding: "10px 14px", letterSpacing: ".01em",
              color: flatAll ? "#fff" : "#0891b2",
              background: flatAll ? "#0891b2" : "#ecfeff",
              border: `1px solid ${flatAll ? "#0e7490" : "#a5f3fc"}`,
            }}
          >
            {flatAll ? "✓ Whole roof marked FLAT — all membrane (tap to undo)" : "🏢 Whole roof is flat? Tap to make it all membrane"}
          </button>
        )}

        {/* ✋ Move overlay — slide the mask to line it up when the photo is shifted. */}
        {!redraw && maskState === "ready" && (
          <button
            onClick={() => { const nv = !moveMode; if (nv) { cancelDraw(); setShowMask(true); } setMoveMode(nv); }}
            style={{
              width: "100%", fontFamily: FONT, fontSize: 13.5, fontWeight: 800, cursor: "pointer",
              marginBottom: 12, borderRadius: 9, padding: "10px 14px", letterSpacing: ".01em",
              color: moveMode ? "#fff" : "#7c3aed",
              background: moveMode ? "#7c3aed" : "#f5f3ff",
              border: `1px solid ${moveMode ? "#6d28d9" : "#ddd6fe"}`,
            }}
          >
            {moveMode ? "✋ Moving — drag the green to line it up, tap to lock (number won't change)" : "✋ Overlay shifted off the roof? Tap, then drag it to line up"}
          </button>
        )}

        {!redraw ? (
          <>
            {/* the two tools */}
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button onClick={() => { cancelDraw(); setMoveMode(false); setMode("add"); }} style={seg(mode === "add", "#16a34a")}>➕ Add missed</button>
              <button onClick={() => { cancelDraw(); setMoveMode(false); setMode("cut"); }} style={seg(mode === "cut", "#dc2626")}>✂️ Cut extra</button>
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
