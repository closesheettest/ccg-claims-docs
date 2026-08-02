// DoorDispatcher — DRAW ROOF LINES (production/admin). Neal's fix for the line
// takeoff: the machine can't reliably reconstruct ridges/hips/valleys from a flat
// footprint, but a person reads them off the satellite photo instantly. So the
// HUMAN identifies each line (draw it, tag its type) and the MATH measures it —
// length from the map's real-world scale (never the fuzzy pixels) + the pitch
// slope factor, with endpoint SNAPPING so a rough stroke still lands exact.
//   • Outline (eaves) → the roof perimeter (horizontal length).
//   • Ridge → horizontal top line (× 1).
//   • Hip / Valley → sloped crease (× √(1+p²/2), the pitch factor).
// Eaves/footprint stay the source of truth; you only rough-in the interior lines.

import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const FONT = "'Oswald', system-ui, sans-serif";
const COL = { outline: "#0f172a", ridge: "#dc2626", hip: "#2563eb", valley: "#059669" };
const M_TO_FT = 3.28084;

export default function RoofLineTracer({ lat, lng, pitch = 8 }) {
  const [mode, setMode] = useState(null);         // 'outline' | 'ridge' | 'hip' | 'valley'
  const [outline, setOutline] = useState([]);     // [{lat,lng}] roof perimeter
  const [closed, setClosed] = useState(false);
  const [lines, setLines] = useState([]);         // [{id,type,a:{lat,lng},b:{lat,lng}}]
  const [pending, setPending] = useState(null);   // first click of a line segment
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const drawRef = useRef(null);
  const stateRef = useRef({});
  stateRef.current = { mode, outline, closed, lines, pending };

  // ── map
  useEffect(() => {
    if (!mapEl.current || mapRef.current || lat == null || lng == null) return;
    const m = L.map(mapEl.current, { zoomControl: true }).setView([lat, lng], 20);
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 21, maxNativeZoom: 19, attribution: "Imagery &copy; Esri" }).addTo(m);
    L.marker([lat, lng], { interactive: false, keyboard: false,
      icon: L.divIcon({ className: "", html: '<div style="font-size:26px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))">📍</div>', iconSize: [26, 26], iconAnchor: [13, 24] }) }).addTo(m);
    drawRef.current = L.layerGroup().addTo(m);
    m.on("click", onMapClick);
    setTimeout(() => m.invalidateSize(), 60);
    setTimeout(() => m.invalidateSize(), 300);
    mapRef.current = m;
    return () => { m.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  // snap a click to a nearby existing vertex (outline corner or line endpoint) — so
  // the measured length comes from clean geometry, not exactly where the pixel was
  function snap(ll) {
    const { outline, lines } = stateRef.current;
    const verts = [...outline, ...lines.flatMap((s) => [s.a, s.b])];
    let best = null, bd = 1.4; // metres
    for (const v of verts) { const d = L.latLng(v.lat, v.lng).distanceTo(L.latLng(ll.lat, ll.lng)); if (d < bd) { bd = d; best = v; } }
    return best ? { lat: best.lat, lng: best.lng } : { lat: ll.lat, lng: ll.lng };
  }

  function onMapClick(e) {
    const st = stateRef.current;
    if (!st.mode) return;
    const p = snap(e.latlng);
    if (st.mode === "outline") { if (!st.closed) setOutline((o) => [...o, p]); return; }
    // line modes: two clicks = one segment
    if (!st.pending) { setPending(p); return; }
    setLines((ls) => [...ls, { id: `${ls.length}_${Date.now() % 1e6}`, type: st.mode, a: st.pending, b: p }]);
    setPending(null);
  }

  // ── redraw everything on state change
  useEffect(() => {
    const g = drawRef.current; if (!g) return;
    g.clearLayers();
    if (outline.length) {
      const pts = outline.map((p) => [p.lat, p.lng]);
      if (closed && outline.length >= 3) L.polygon(pts, { color: COL.outline, weight: 2, fillColor: "#3b82f6", fillOpacity: 0.06 }).addTo(g);
      else L.polyline(pts, { color: COL.outline, weight: 2, dashArray: "4,4" }).addTo(g);
      outline.forEach((p) => L.circleMarker([p.lat, p.lng], { radius: 3, color: COL.outline, fillColor: "#fff", fillOpacity: 1, weight: 2 }).addTo(g));
    }
    lines.forEach((s) => {
      L.polyline([[s.a.lat, s.a.lng], [s.b.lat, s.b.lng]], { color: COL[s.type], weight: 4 }).addTo(g);
    });
    if (pending) L.circleMarker([pending.lat, pending.lng], { radius: 5, color: "#f59e0b", fillColor: "#f59e0b", fillOpacity: 1 }).addTo(g);
  }, [outline, closed, lines, pending]);

  function pickMode(mo) { setMode(mo); setPending(null); }
  function undo() {
    if (pending) { setPending(null); return; }
    if (mode === "outline" && !closed && outline.length) { setOutline((o) => o.slice(0, -1)); return; }
    if (lines.length) setLines((ls) => ls.slice(0, -1));
  }
  function clearAll() { setOutline([]); setClosed(false); setLines([]); setPending(null); setMode(null); }

  // ── totals (ft). Eaves = outline perimeter; ridge horizontal; hip/valley × pitch factor
  const p = (parseFloat(pitch) || 0) / 12;
  const hipF = Math.sqrt(1 + (p * p) / 2);
  const segFt = (s) => L.latLng(s.a.lat, s.a.lng).distanceTo(L.latLng(s.b.lat, s.b.lng)) * M_TO_FT;
  let eaves = 0;
  for (let i = 0; i < outline.length - (closed ? 0 : 1); i++) { const a = outline[i], b = outline[(i + 1) % outline.length]; eaves += L.latLng(a.lat, a.lng).distanceTo(L.latLng(b.lat, b.lng)) * M_TO_FT; }
  const sum = (t, f) => lines.filter((s) => s.type === t).reduce((a, s) => a + segFt(s) * f, 0);
  const ridge = sum("ridge", 1), hip = sum("hip", hipF), valley = sum("valley", hipF);
  const r1 = (n) => Math.round(n * 10) / 10;

  if (lat == null || lng == null) {
    return <div style={{ ...card, color: "#64748b", fontSize: 13 }}>Look up an address above to load the satellite photo for line tracing.</div>;
  }

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <b style={{ fontSize: 15 }}>📐 Draw roof lines</b>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#0369a1", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 999, padding: "2px 8px" }}>HUMAN IDENTIFIES · MATH MEASURES</span>
        <span style={{ fontSize: 11.5, color: "#64748b" }}>draw each line on the photo, tagged by type — length is computed from the map scale + pitch</span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <button onClick={() => pickMode("outline")} style={seg(mode === "outline", false, COL.outline)}>⬛ Outline (eaves)</button>
        {mode === "outline" && outline.length >= 3 && !closed && <button onClick={() => { setClosed(true); setMode(null); }} style={btn("#16a34a")}>✓ Close outline</button>}
        <button onClick={() => pickMode("ridge")} style={seg(mode === "ridge", false, COL.ridge)}>▬ Ridge</button>
        <button onClick={() => pickMode("hip")} style={seg(mode === "hip", false, COL.hip)}>╱ Hip</button>
        <button onClick={() => pickMode("valley")} style={seg(mode === "valley", false, COL.valley)}>╲ Valley</button>
        <button onClick={undo} style={btn("#dc2626", true)}>↶ Undo</button>
        <button onClick={clearAll} style={btn("#64748b", true)}>Clear</button>
        {mode && mode !== "outline" && <span style={{ fontSize: 12.5, fontWeight: 700, color: "#b45309" }}>{pending ? "click the OTHER end of the line" : `click one end of a ${mode}`}</span>}
        {mode === "outline" && <span style={{ fontSize: 12.5, fontWeight: 700, color: "#b45309" }}>{closed ? "outline set" : "click each corner, then Close outline"}</span>}
      </div>

      <div ref={mapEl} style={{ width: "100%", height: 460, borderRadius: 10, overflow: "hidden", border: "1px solid #e5e7eb", cursor: mode ? "crosshair" : "grab" }} />

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", marginTop: 10, background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px" }}>
        <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: "#334155" }}>Takeoff (ft) @ {pitch}/12</span>
        {[["Ridge", ridge, "ridge"], ["Hips", hip, "hip"], ["Valleys", valley, "valley"], ["Eaves", eaves, "outline"]].map(([n, v, t]) => (
          <span key={n} style={{ fontSize: 14, color: "#334155" }}>
            <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: COL[t], marginRight: 6 }} />
            {n} <b style={{ fontFamily: "ui-monospace,monospace" }}>{r1(v)}</b>
          </span>
        ))}
        <span style={{ fontSize: 11.5, color: "#b45309", marginLeft: "auto" }}>compare to Roofr</span>
      </div>
      <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 6 }}>Hips/valleys use the √(1+p²/2) pitch factor (assumes ~45° hips). Endpoints snap to nearby corners so a rough click still measures clean. Test in real Chrome — the in-app browser renders the map at 0×0.</div>
    </div>
  );
}

const card = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 16, marginBottom: 16 };
function btn(color, outline) { return { fontFamily: FONT, fontSize: 13, fontWeight: 700, color: outline ? color : "#fff", background: outline ? "#fff" : color, border: `1px solid ${color}`, borderRadius: 8, padding: "7px 12px", cursor: "pointer" }; }
function seg(active, disabled, color) { return { fontFamily: FONT, fontSize: 13, fontWeight: 700, color: active ? "#fff" : (color || "#334155"), background: active ? (color || "#2563eb") : "#fff", border: `1px solid ${active ? (color || "#2563eb") : "#cbd5e1"}`, borderRadius: 8, padding: "7px 12px", cursor: "pointer" }; }
