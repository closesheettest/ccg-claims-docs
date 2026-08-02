// DoorDispatcher — DRAW ROOF LINES (production/admin). The INTERIOR creases of
// the roof — ridge / hip / valley — read off the satellite photo (where you can
// see them) and measured by the math (map scale + pitch factor), with endpoint
// snapping so a rough click still lands exact.
//   • Ridge → horizontal top line (× 1)
//   • Hip / Valley → 45° crease (× √(1+p²/2), the pitch factor)
// EAVES and RAKES are NOT done here — they're tagged on the flat appraiser sketch
// (the region tracer), because the photo can't show which perimeter edges break
// into gable rakes but the sketch outline can. Each drawing does its best job.

import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

const FONT = "'Oswald', system-ui, sans-serif";
const COL = { ridge: "#dc2626", hip: "#2563eb", valley: "#059669" };
const M_TO_FT = 3.28084;

export default function RoofLineTracer({ lat, lng, pitch = 8, overhang, onOverhang }) {
  const [mode, setMode] = useState(null);         // 'ridge' | 'hip' | 'valley' | 'overhang'
  const [lines, setLines] = useState([]);         // [{id,type,a:{lat,lng},b:{lat,lng}}]
  const [pending, setPending] = useState(null);   // first click of a line segment
  const [ovLine, setOvLine] = useState(null);     // overhang measurement line (eave→eave)
  const [wallFt, setWallFt] = useState("");       // the matching wall length off the sketch
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const drawRef = useRef(null);
  const stateRef = useRef({});
  stateRef.current = { mode, lines, pending };

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

  // snap a click to a nearby existing line endpoint so lines connect cleanly
  function snap(ll) {
    const verts = stateRef.current.lines.flatMap((s) => [s.a, s.b]);
    let best = null, bd = 1.4; // metres
    for (const v of verts) { const d = L.latLng(v.lat, v.lng).distanceTo(L.latLng(ll.lat, ll.lng)); if (d < bd) { bd = d; best = v; } }
    return best ? { lat: best.lat, lng: best.lng } : { lat: ll.lat, lng: ll.lng };
  }

  function onMapClick(e) {
    const st = stateRef.current;
    if (!st.mode) return;
    const p = snap(e.latlng);
    if (!st.pending) { setPending(p); return; }   // first click
    if (st.mode === "overhang") { setOvLine({ a: st.pending, b: p }); setPending(null); setMode(null); return; }
    setLines((ls) => [...ls, { id: `${ls.length}_${Date.now() % 1e6}`, type: st.mode, a: st.pending, b: p }]);
    setPending(null);
  }

  // ── redraw on state change
  useEffect(() => {
    const g = drawRef.current; if (!g) return;
    g.clearLayers();
    lines.forEach((s) => { L.polyline([[s.a.lat, s.a.lng], [s.b.lat, s.b.lng]], { color: COL[s.type], weight: 4 }).addTo(g); });
    if (ovLine) L.polyline([[ovLine.a.lat, ovLine.a.lng], [ovLine.b.lat, ovLine.b.lng]], { color: "#7c3aed", weight: 3, dashArray: "6,5" }).addTo(g);
    if (pending) L.circleMarker([pending.lat, pending.lng], { radius: 5, color: "#f59e0b", fillColor: "#f59e0b", fillOpacity: 1 }).addTo(g);
  }, [lines, pending, ovLine]);

  function pickMode(mo) { setMode(mo); setPending(null); }
  function undo() { if (pending) { setPending(null); return; } if (lines.length) setLines((ls) => ls.slice(0, -1)); }
  function clearAll() { setLines([]); setPending(null); setMode(null); }

  // ── totals (ft). Interior lines only.
  const p = (parseFloat(pitch) || 0) / 12;
  const hipF = Math.sqrt(1 + (p * p) / 2);   // hip/valley run at 45° → √(1+p²/2)
  const segFt = (s) => L.latLng(s.a.lat, s.a.lng).distanceTo(L.latLng(s.b.lat, s.b.lng)) * M_TO_FT;
  const sum = (t, f) => lines.filter((s) => s.type === t).reduce((a, s) => a + segFt(s) * f, 0);
  const ridge = sum("ridge", 1), hip = sum("hip", hipF), valley = sum("valley", hipF);
  const r1 = (n) => Math.round(n * 10) / 10;
  // measured overhang = (roof width from the photo − wall length from the sketch) / 2
  const roofWidthFt = ovLine ? L.latLng(ovLine.a.lat, ovLine.a.lng).distanceTo(L.latLng(ovLine.b.lat, ovLine.b.lng)) * M_TO_FT : null;
  const measuredOh = (roofWidthFt != null && parseFloat(wallFt) > 0) ? (roofWidthFt - parseFloat(wallFt)) / 2 : null;

  if (lat == null || lng == null) {
    return <div style={{ ...card, color: "#64748b", fontSize: 13 }}>Look up an address above to load the satellite photo for line tracing.</div>;
  }

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <b style={{ fontSize: 15 }}>📐 Draw roof lines</b>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#0369a1", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 999, padding: "2px 8px" }}>RIDGE · HIP · VALLEY</span>
        <span style={{ fontSize: 11.5, color: "#64748b" }}>draw the interior creases on the photo — eaves &amp; rakes are tagged on the appraiser sketch above</span>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <button onClick={() => pickMode("ridge")} style={seg(mode === "ridge", COL.ridge)}>▬ Ridge</button>
        <button onClick={() => pickMode("hip")} style={seg(mode === "hip", COL.hip)}>╱ Hip</button>
        <button onClick={() => pickMode("valley")} style={seg(mode === "valley", COL.valley)}>╲ Valley</button>
        <button onClick={() => { setMode("overhang"); setPending(null); }} style={seg(mode === "overhang", "#7c3aed")}>◳ Measure overhang</button>
        <button onClick={undo} style={btn("#dc2626", true)}>↶ Undo</button>
        <button onClick={clearAll} style={btn("#64748b", true)}>Clear</button>
        {mode && mode !== "overhang" && <span style={{ fontSize: 12.5, fontWeight: 700, color: "#b45309" }}>{pending ? "click the OTHER end of the line" : `click one end of a ${mode}`}</span>}
      </div>

      {/* measured overhang: draw eave→eave across a wall you know, type its length, apply */}
      {(mode === "overhang" || ovLine) && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 8, background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
          <b style={{ color: "#6d28d9" }}>◳ Overhang</b>
          {!ovLine ? (
            <span style={{ color: "#b45309", fontWeight: 700 }}>{pending ? "click the OTHER eave" : "draw a line across the house — eave to eave, over a wall whose length is on the sketch"}</span>
          ) : (
            <>
              <span>roof width <b>{roofWidthFt.toFixed(1)} ft</b></span>
              <label style={{ color: "#475569" }}>− sketch wall <input value={wallFt} onChange={(e) => setWallFt(e.target.value)} inputMode="decimal" placeholder="44" style={{ width: 56, fontFamily: FONT, fontSize: 14, padding: "5px 7px", border: "1px solid #cbd5e1", borderRadius: 7 }} /> ft</label>
              {measuredOh != null && <span>= overhang <b style={{ color: measuredOh >= 0 && measuredOh < 4 ? "#16a34a" : "#dc2626" }}>{measuredOh.toFixed(2)} ft</b></span>}
              {measuredOh != null && measuredOh >= 0 && measuredOh < 4 && <button onClick={() => onOverhang && onOverhang(Math.round(measuredOh * 100) / 100)} style={btn("#16a34a")}>Use this overhang</button>}
              <button onClick={() => { setOvLine(null); setWallFt(""); }} style={btn("#64748b", true)}>redo</button>
            </>
          )}
        </div>
      )}

      <div ref={mapEl} style={{ width: "100%", height: 460, borderRadius: 10, overflow: "hidden", border: "1px solid #e5e7eb", cursor: mode ? "crosshair" : "grab" }} />

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", marginTop: 10, background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px" }}>
        <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: "#334155" }}>Interior lines (ft) @ {pitch}/12</span>
        {[["Ridge", ridge, "ridge"], ["Hips", hip, "hip"], ["Valleys", valley, "valley"]].map(([n, v, t]) => (
          <span key={n} style={{ fontSize: 14, color: "#334155" }}>
            <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: COL[t], marginRight: 6 }} />
            {n} <b style={{ fontFamily: "ui-monospace,monospace" }}>{r1(v)}</b>
          </span>
        ))}
        <span style={{ fontSize: 11.5, color: "#b45309", marginLeft: "auto" }}>compare to Roofr</span>
      </div>
      <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 6 }}>Hips/valleys use the √(1+p²/2) pitch factor (~45° hips). Endpoints snap so a rough click still measures clean. Eaves &amp; rakes come from the appraiser sketch above. Test in real Chrome — the in-app browser renders the map at 0×0.</div>
    </div>
  );
}

const card = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 16, marginBottom: 16 };
function btn(color, outline) { return { fontFamily: FONT, fontSize: 13, fontWeight: 700, color: outline ? color : "#fff", background: outline ? "#fff" : color, border: `1px solid ${color}`, borderRadius: 8, padding: "7px 12px", cursor: "pointer" }; }
function seg(active, color) { return { fontFamily: FONT, fontSize: 13, fontWeight: 700, color: active ? "#fff" : (color || "#334155"), background: active ? (color || "#2563eb") : "#fff", border: `1px solid ${active ? (color || "#2563eb") : "#cbd5e1"}`, borderRadius: 8, padding: "7px 12px", cursor: "pointer" }; }
