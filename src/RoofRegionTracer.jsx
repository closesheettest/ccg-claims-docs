// DoorDispatcher — ROOF REGION TRACER (production/admin). Phase 1 of the
// "reproduce the appraiser drawing" flow Neal designed:
//   1. Set the scale once (click a wall of known length, type the feet).
//   2. Draw each ROOFED region by its real corners — the 2-story core first,
//      then everything NOT under it (single-story extensions, garage, porch).
//   3. It stitches the regions into the exact footprint and returns EXACT
//      squares. The drawn region borders reproduce the sketch's interior lines.
//
// Slicing by story doesn't change the AREA (roof area = ground footprint however
// you cut it) — it's chosen so the region joins land where the real roof valleys
// / step-downs are, which is what the ridge/hip/valley geometry pass (next) needs.
//
// Phase 1 delivers footprint + squares (exact on any cut-up shape) + the
// reconstruction. Ridge/hip/valley come from the geometry pass and are NOT here.

import React, { useRef, useState, useEffect, useMemo } from "react";
import { roofSkeleton, dripOutline } from "./roofSkeleton";

const FONT = "'Oswald', system-ui, sans-serif";
const LINECOL = { ridge: "#dc2626", hip: "#2563eb", valley: "#059669", eave: "#0f172a" };
const sf = (x12) => Math.sqrt(1 + Math.pow((+x12 || 0) / 12, 2));
const shoelace = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i].x * pts[j].y - pts[j].x * pts[i].y; } return Math.abs(a) / 2; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const centroid = (pts) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });

// Read the roof's STRUCTURE from Google Solar's facets — the fusion sanity layer.
// count = facet total; shape from azimuth spread (4 directions ≈ hip, 2 opposite ≈
// gable → rakes); tiers from height gaps (2 = a story step, e.g. garage vs house).
function summarizeFacets(facets) {
  if (!facets || facets.length < 2) return null;
  const count = facets.length;
  const sloped = facets.filter((p) => p.pitch_x12 != null && p.pitch_x12 >= 2.5);
  const flat = count - sloped.length;
  const totalArea = sloped.reduce((s, p) => s + (p.area_m2 || 0), 0) || 1;
  const oct = {};
  for (const p of sloped) { if (p.azimuth_deg == null) continue; const k = ((Math.round(p.azimuth_deg / 45) % 8) + 8) % 8; oct[k] = (oct[k] || 0) + (p.area_m2 || 0); }
  const dirCount = Object.values(oct).filter((a) => a > totalArea * 0.1).length;   // significant slope directions
  const shape = dirCount >= 4 ? "hip" : dirCount <= 2 ? "gable" : "mixed";
  const hs = sloped.map((p) => p.height_m).filter((h) => h != null).sort((a, b) => a - b);
  let tiers = hs.length ? 1 : 0;
  for (let i = 1; i < hs.length; i++) if (hs[i] - hs[i - 1] > 2) tiers++;            // >2 m gap = a roof-height step
  return { count, flat, shape, tiers };
}

const pointInPoly = (x, y, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
};

// Roof area from the traced WALL regions + eave overhang. The appraiser draws the
// walls; the roof hangs past them to the drip edge, which is what Roofr measures.
// We rasterize the union of the regions and dilate outward by the overhang with a
// SQUARE kernel (roof corners are square, not rounded) — a robust polygon-offset
// that ignores trace slop and applies overhang only to the OUTER edge (interior
// height-change boundaries stay internal to the union, so they don't dilate).
function roofArea(regions, ftPerPx, overhangFt) {
  const wall = regions.reduce((s, r) => s + shoelace(r.pts) * ftPerPx * ftPerPx, 0);
  if (!regions.length || !ftPerPx) return { wall: 0, roof: 0 };
  if (overhangFt <= 0) return { wall, roof: wall };
  const pts = regions.flatMap((r) => r.pts);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  const ohPx = overhangFt / ftPerPx;
  const spanX = maxX - minX, spanY = maxY - minY;
  const cell = (Math.max(spanX, spanY) / 280) || 1;      // ~280 cells across the long side
  const pad = ohPx + cell * 2;
  const x0 = minX - pad, y0 = minY - pad;
  const cols = Math.ceil((spanX + 2 * pad) / cell), rows = Math.ceil((spanY + 2 * pad) / cell);
  const mask = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const y = y0 + (j + 0.5) * cell;
    for (let i = 0; i < cols; i++) {
      const x = x0 + (i + 0.5) * cell;
      for (const r of regions) { if (pointInPoly(x, y, r.pts)) { mask[j * cols + i] = 1; break; } }
    }
  }
  const rad = Math.max(1, Math.round(ohPx / cell));
  // separable square dilation (Minkowski sum with a square = offset all edges by overhang)
  const tmp = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    let v = 0; for (let k = -rad; k <= rad && !v; k++) { const ii = i + k; if (ii >= 0 && ii < cols && mask[j * cols + ii]) v = 1; } tmp[j * cols + i] = v;
  }
  let count = 0;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    let v = 0; for (let k = -rad; k <= rad && !v; k++) { const jj = j + k; if (jj >= 0 && jj < rows && tmp[jj * cols + i]) v = 1; } if (v) count++;
  }
  const cellFt = cell * ftPerPx;
  return { wall, roof: count * cellFt * cellFt };
}

export default function RoofRegionTracer({ pitch = 6, onPitchChange, facets }) {
  const facetInfo = useMemo(() => summarizeFacets(facets), [facets]);
  const [imgUrl, setImgUrl] = useState(null);
  const [nat, setNat] = useState({ w: 1, h: 1 });     // natural image px (resize-invariant)
  const [mode, setMode] = useState(null);              // 'scale' | 'draw' | null
  const [scalePts, setScalePts] = useState([]);        // clicks while setting scale
  const [feetInput, setFeetInput] = useState("");
  const [scale, setScale] = useState(null);            // { p1, p2, feet, ftPerPx }
  const [regions, setRegions] = useState([]);          // { id, label, pts:[{x,y}] }
  const [draft, setDraft] = useState([]);              // in-progress region corners
  const [hover, setHover] = useState(null);
  const [showLines, setShowLines] = useState(false);   // roof lines only after you say you're done tracing
  const [markRakes, setMarkRakes] = useState(false);   // tag perimeter edges as rakes
  const [rakeSet, setRakeSet] = useState(() => new Set()); // outline edge indices that are rakes
  useEffect(() => { setRakeSet(new Set()); }, [regions]);  // edge indices shift when the footprint changes
  const overhang = 2;   // STANDARD eave overhang, ft (wall → drip edge). Fixed, not editable — nobody judges it per house; 2ft is biased slightly high, the safe side for estimating.
  const wrapRef = useRef(null);

  // paste a screenshot of the sketch
  useEffect(() => {
    function onPaste(e) {
      for (const it of e.clipboardData?.items || []) {
        if (it.type.startsWith("image/")) { const b = it.getAsFile(); if (b) { setImgUrl((u) => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(b); }); e.preventDefault(); } return; }
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // Esc / Enter helpers for drawing
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") { if (draft.length) undoPoint(); else if (scalePts.length) { setScalePts([]); setMode(null); } }
      if (e.key === "Enter" && mode === "draw" && draft.length >= 3) closeRegion();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function onFile(e) { const f = e.target.files?.[0]; if (f) setImgUrl((u) => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(f); }); }
  function onImgLoad(e) { setNat({ w: e.target.naturalWidth || 1, h: e.target.naturalHeight || 1 }); }

  // click → natural-image px (invariant to display size, so resize never breaks it)
  const toNat = (e) => { const r = wrapRef.current.getBoundingClientRect(); return { x: (e.clientX - r.left) * (nat.w / r.width), y: (e.clientY - r.top) * (nat.h / r.height) }; };

  function onClick(e) {
    if (!imgUrl || !mode) return;
    const p = toNat(e);
    if (mode === "scale") {
      const next = [...scalePts, p].slice(-2);
      setScalePts(next);
      return;
    }
    if (mode === "draw") setDraft((d) => [...d, p]);
  }
  function onMove(e) { if (mode && (draft.length || scalePts.length === 1)) setHover(toNat(e)); }

  function startScale() { setMode("scale"); setScalePts([]); setScale(null); setFeetInput(""); }
  function commitScale() {
    const f = parseFloat(feetInput);
    if (scalePts.length === 2 && f > 0) {
      const px = dist(scalePts[0], scalePts[1]);
      if (px > 2) { setScale({ p1: scalePts[0], p2: scalePts[1], feet: f, ftPerPx: f / px }); setMode(null); setScalePts([]); }
    }
  }
  function startRegion() { if (!scale) return; setMode("draw"); setDraft([]); }
  function undoPoint() { setDraft((d) => d.slice(0, -1)); }
  function closeRegion() {
    if (draft.length < 3) return;
    setRegions((rs) => [...rs, { id: `${rs.length}_${draft.length}`, label: rs.length === 0 ? "core" : "ext", pts: draft }]);
    setDraft([]); setMode(null);
  }
  function undoLast() {
    if (draft.length) { undoPoint(); return; }
    setRegions((rs) => rs.slice(0, -1));
  }
  function removeRegion(id) { setRegions((rs) => rs.filter((r) => r.id !== id)); }
  function setLabel(id, label) { setRegions((rs) => rs.map((r) => (r.id === id ? { ...r, label } : r))); }

  // ── math (all in natural px, scaled to feet by ftPerPx)
  const ftPerPx = scale?.ftPerPx || 0;
  const areaFt = (pts) => shoelace(pts) * ftPerPx * ftPerPx;   // per-region wall area (for the list)
  const { wall, roof } = useMemo(() => roofArea(regions, ftPerPx, parseFloat(overhang) || 0), [regions, ftPerPx, overhang]);
  const footprint = Math.round(wall);
  const roofSqft = Math.round(roof);
  const squares = roof * sf(pitch) / 100;
  const r1 = (n) => Math.round(n * 10) / 10;
  // EAVES + RAKES from the appraiser footprint. The drip-edge outline is the
  // clickable perimeter; you tag the gable-end edges as rakes (the human DEFINES),
  // then geometry MEASURES: eaves = un-tagged edges (horizontal), rakes = tagged
  // edges × √(1+p²) (they run up the gable slope). Both from the printed dimensions.
  const outlineFt = useMemo(() => (regions.length && ftPerPx ? dripOutline(regions, ftPerPx, parseFloat(overhang) || 0) : []), [regions, ftPerPx, overhang]);
  const p12 = (parseFloat(pitch) || 0) / 12;
  const rakeF = Math.sqrt(1 + p12 * p12);
  const edgeLenFt = (i) => { const a = outlineFt[i], b = outlineFt[(i + 1) % outlineFt.length]; return Math.hypot(a.x - b.x, a.y - b.y); };
  let eaveLen = 0, rakeLen = 0;
  outlineFt.forEach((_, i) => { const L = edgeLenFt(i); if (rakeSet.has(i)) rakeLen += L; else eaveLen += L; });
  const eaves = Math.round(eaveLen * 10) / 10;
  const rakes = Math.round(rakeLen * rakeF * 10) / 10;
  // straight-skeleton line takeoff — skeletons each region's CLEAN traced polygon
  // (correct hip/valley/ridge classification; each region = one roof-height piece).
  const skel = useMemo(
    () => (showLines && regions.length && ftPerPx ? roofSkeleton(regions, ftPerPx, parseFloat(pitch) || 6) : null),
    [showLines, regions, ftPerPx, pitch]
  );
  const toPx = (p) => `${p.x / ftPerPx},${p.y / ftPerPx}`;   // feet → natural px for drawing

  const stroke = Math.max(nat.w, nat.h) / 400;   // scale line widths to image size
  const fontPx = Math.max(nat.w, nat.h) / 55;

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <b style={{ fontSize: 15 }}>🧩 Region trace</b>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#0369a1", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 999, padding: "2px 8px" }}>EXACT SQUARES · ANY SHAPE</span>
        <span style={{ fontSize: 11.5, color: "#64748b" }}>set scale → draw each roofed region → exact footprint</span>
      </div>

      {/* fusion sanity layer — what Google Solar sees, cross-checked against the trace */}
      {facetInfo && (() => {
        const traceTiers = new Set(regions.map((r) => r.label)).size;
        const agree = regions.length > 0 && traceTiers === facetInfo.tiers;
        return (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 12.5, color: "#4c1d95", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 10, padding: "8px 12px", margin: "6px 0 4px" }}>
            <b style={{ color: "#6d28d9" }}>🛰️ Satellite cross-check</b>
            <span><b>{facetInfo.count}</b> facets</span>
            <span>· <b>{facetInfo.shape}</b>-roof{facetInfo.shape === "gable" ? " (expect rakes)" : ""}</span>
            <span>· <b>{facetInfo.tiers}</b> roof-height tier{facetInfo.tiers > 1 ? "s" : ""}</span>
            {facetInfo.flat > 0 && <span>· {facetInfo.flat} flat</span>}
            {regions.length > 0 && (
              <span style={{ marginLeft: "auto", fontWeight: 700, color: agree ? "#16a34a" : "#b45309" }}>
                {agree ? `✓ your ${traceTiers} tier${traceTiers > 1 ? "s" : ""} match` : `⚠ you drew ${traceTiers} tier${traceTiers > 1 ? "s" : ""}, satellite sees ${facetInfo.tiers}`}
              </span>
            )}
          </div>
        );
      })()}

      {!imgUrl ? (
        <label style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, height: 190, border: "2px dashed #cbd5e1", borderRadius: 12, cursor: "pointer", color: "#64748b", background: "#f8fafc" }}>
          <span style={{ fontSize: 32 }}>📋</span>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Paste the sketch (⌘/Ctrl-V) or click to upload</span>
          <input type="file" accept="image/*" onChange={onFile} style={{ display: "none" }} />
        </label>
      ) : (
        <>
          {/* toolbar */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "8px 0" }}>
            <button onClick={startScale} style={seg(mode === "scale")}>📏 {scale ? "Redo scale" : "① Set scale"}</button>
            <button onClick={startRegion} disabled={!scale} style={seg(mode === "draw", !scale)}>✏️ ② Draw region</button>
            {mode === "draw" && draft.length >= 3 && <button onClick={closeRegion} style={btn("#16a34a")}>✓ Close region</button>}
            <button onClick={undoLast} disabled={!draft.length && !regions.length} style={btn((!draft.length && !regions.length) ? "#94a3b8" : "#dc2626", true)}>{draft.length ? "↶ Undo point" : "↶ Undo region"}</button>
            <label style={{ ...btn("#64748b", true), display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>↺ Replace<input type="file" accept="image/*" onChange={onFile} style={{ display: "none" }} /></label>
            <button onClick={() => setShowLines((v) => !v)} disabled={!regions.length} style={seg(showLines, !regions.length)}>📐 {showLines ? "Hide roof lines" : "Show roof lines (beta)"}</button>
            <button onClick={() => { setMarkRakes((v) => !v); setMode(null); }} disabled={!outlineFt.length} style={seg(markRakes, !outlineFt.length)}>◺ {markRakes ? "Done marking rakes" : "Mark rakes (gable ends)"}</button>
          </div>

          {/* status line */}
          <div style={{ fontSize: 12.5, color: "#334155", background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 12px", marginBottom: 10, lineHeight: 1.5 }}>
            {markRakes
              ? <><b>Mark rakes:</b> click each <b>gable-end</b> edge of the outline — it turns <b style={{ color: "#b45309" }}>amber</b> (a rake). Everything else stays an eave. Click again to un-mark.</>
              : !scale
              ? <><b>Step 1 — scale:</b> click the two ends of a wall whose length is printed on the sketch (e.g. the <b>44</b> edge), then type that number below.</>
              : mode === "draw"
                ? <><b>Drawing a region:</b> click each corner, then <b>Close region</b> (or Enter). Esc / Undo point fixes a mis-click.</>
                : <><b>Step 2 — group by roof height:</b> draw everything at the <b>same roof height</b> as one region — the 2-story core <b>includes any finished upstairs (FUS)</b>, even over the garage (same height = no valley between them). Then draw each <b>1-story</b> piece on its own — the line where it meets the 2-story is the real valley. Each region's printed area is your check.</>}
          </div>

          {/* scale feet entry */}
          {mode === "scale" && scalePts.length === 2 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#b45309" }}>That wall is</span>
              <input value={feetInput} onChange={(e) => setFeetInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commitScale(); }} inputMode="decimal" placeholder="44" autoFocus style={inp(70)} />
              <span style={{ fontSize: 13, color: "#64748b" }}>ft</span>
              <button onClick={commitScale} disabled={!(parseFloat(feetInput) > 0)} style={btn(parseFloat(feetInput) > 0 ? "#2563eb" : "#94a3b8")}>Set scale</button>
            </div>
          )}

          {/* sketch + overlay */}
          <div ref={wrapRef} onClick={onClick} onMouseMove={onMove} style={{ position: "relative", lineHeight: 0, borderRadius: 10, overflow: "hidden", border: "1px solid #e5e7eb", cursor: mode ? "crosshair" : "default", userSelect: "none" }}>
            <img src={imgUrl} onLoad={onImgLoad} alt="appraiser sketch" style={{ width: "100%", display: "block", pointerEvents: "none" }} />
            <svg viewBox={`0 0 ${nat.w} ${nat.h}`} width="100%" height="100%" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              {/* closed regions */}
              {regions.map((r, i) => {
                const c = r.label === "core" ? "#2563eb" : "#16a34a";
                const ce = centroid(r.pts);
                return (
                  <g key={r.id}>
                    <polygon points={r.pts.map((p) => `${p.x},${p.y}`).join(" ")} fill={c + "22"} stroke={c} strokeWidth={stroke * 1.4} />
                    <text x={ce.x} y={ce.y} fill={c} fontSize={fontPx} fontWeight={800} textAnchor="middle" dominantBaseline="middle" style={{ fontFamily: FONT }}>{Math.round(areaFt(r.pts))}</text>
                  </g>
                );
              })}
              {/* straight-skeleton roof lines (drip-edge outline + ridge/hip/valley) */}
              {skel && mode !== "draw" && <g>
                {skel.outlineFts.map((o, oi) => (
                  <polygon key={oi} points={o.map(toPx).join(" ")} fill="none" stroke={LINECOL.eave} strokeWidth={stroke * 1.2} opacity={0.75} />
                ))}
                {skel.segsFt.map((s, i) => (
                  <line key={i} x1={s.a.x / ftPerPx} y1={s.a.y / ftPerPx} x2={s.b.x / ftPerPx} y2={s.b.y / ftPerPx} stroke={LINECOL[s.type]} strokeWidth={stroke * (s.type === "ridge" ? 2 : 1.6)} strokeLinecap="round" />
                ))}
              </g>}
              {/* drip-edge perimeter — tag gable-end edges as rakes (eave=dark, rake=amber) */}
              {(markRakes || rakeSet.size > 0) && outlineFt.length > 2 && (
                <g>
                  {outlineFt.map((a, i) => {
                    const b = outlineFt[(i + 1) % outlineFt.length];
                    const isRake = rakeSet.has(i);
                    return (
                      <line key={i}
                        x1={a.x / ftPerPx} y1={a.y / ftPerPx} x2={b.x / ftPerPx} y2={b.y / ftPerPx}
                        stroke={isRake ? "#b45309" : "#0f172a"} strokeWidth={stroke * (markRakes ? 3.2 : 2)} strokeLinecap="round"
                        style={{ pointerEvents: markRakes ? "stroke" : "none", cursor: markRakes ? "pointer" : "default" }}
                        onClick={(e) => { e.stopPropagation(); setRakeSet((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; }); }}
                      />
                    );
                  })}
                </g>
              )}
              {/* in-progress region */}
              {draft.length > 0 && <>
                <polyline points={[...draft, ...(hover ? [hover] : [])].map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#f59e0b" strokeWidth={stroke * 1.4} strokeDasharray={`${stroke * 4},${stroke * 3}`} />
                {draft.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={stroke * 3} fill="#f59e0b" />)}
              </>}
              {/* scale line */}
              {(scale || scalePts.length) && (() => {
                const pa = scale ? scale.p1 : scalePts[0];
                const pb = scale ? scale.p2 : (scalePts[1] || hover);
                if (!pa || !pb) return <circle cx={pa.x} cy={pa.y} r={stroke * 3} fill="#dc2626" />;
                const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
                return <g>
                  <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="#dc2626" strokeWidth={stroke * 1.6} />
                  <circle cx={pa.x} cy={pa.y} r={stroke * 3} fill="#dc2626" /><circle cx={pb.x} cy={pb.y} r={stroke * 3} fill="#dc2626" />
                  {scale && <text x={mid.x} y={mid.y - fontPx * 0.4} fill="#dc2626" fontSize={fontPx} fontWeight={800} textAnchor="middle" style={{ fontFamily: FONT }}>{scale.feet}′</text>}
                </g>;
              })()}
            </svg>
          </div>

          {/* regions list */}
          {regions.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {regions.map((r, i) => (
                <div key={r.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 0", borderTop: "1px dashed #e5e7eb", fontSize: 13.5 }}>
                  <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: r.label === "core" ? "#2563eb" : "#16a34a" }} />
                  <select value={r.label} onChange={(e) => setLabel(r.id, e.target.value)} style={sel}><option value="core">2-story core</option><option value="ext">1-story piece</option></select>
                  <b>{Math.round(areaFt(r.pts))} sqft</b>
                  <span style={{ color: "#94a3b8", fontSize: 12 }}>{r.pts.length} corners</span>
                  <button onClick={() => removeRegion(r.id)} style={{ ...btn("#dc2626", true), marginLeft: "auto" }}>×</button>
                </div>
              ))}
            </div>
          )}

          {/* result — walls → +overhang → roof → squares */}
          {regions.length > 0 && scale && (
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginTop: 14, background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10, padding: 14 }}>
              <div>
                <div style={stat}>Walls</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{footprint.toLocaleString()} <span style={unit}>sqft</span></div>
              </div>
              <span style={{ fontSize: 18, color: "#94a3b8" }}>+</span>
              <div>
                <div style={stat}>Overhang</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>2 <span style={unit}>ft</span> <span style={{ fontSize: 9.5, fontWeight: 700, color: "#94a3b8", letterSpacing: ".06em" }}>STD</span></div>
              </div>
              <span style={{ fontSize: 18, color: "#94a3b8" }}>→</span>
              <div>
                <div style={stat}>Roof (drip edge)</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{roofSqft.toLocaleString()} <span style={unit}>sqft</span></div>
              </div>
              <div style={{ borderLeft: "2px solid #bae6fd", paddingLeft: 16 }}>
                <div style={stat}>Squares @ {pitch}/12</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: "#0369a1" }}>{r1(squares)} <span style={unit}>sq</span></div>
              </div>
              <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "#64748b" }}>Pitch
                <span><input value={pitch} onChange={(e) => onPitchChange && onPitchChange(e.target.value)} type="number" min={0} max={24} step={0.5} style={inp(58)} /> /12</span>
              </label>
              <div style={{ borderLeft: "2px solid #bae6fd", paddingLeft: 16 }}>
                <div style={stat}>Eaves</div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>{eaves} <span style={unit}>ft</span></div>
              </div>
              <div>
                <div style={{ ...stat, color: "#b45309" }}>Rakes</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#b45309" }}>{rakes} <span style={unit}>ft</span></div>
              </div>
              <div style={{ fontSize: 12, color: "#94a3b8", maxWidth: "26ch" }}>Area + eaves + rakes = survey-exact from the appraiser footprint. Use <b>◺ Mark rakes</b> to tag the gable ends. Ridge/hip/valley come from the satellite drawing below.</div>
            </div>
          )}

          {/* line takeoff — ridge / hip / valley / eave from the skeleton */}
          {skel && (
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", marginTop: 10, background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 10, padding: "10px 14px" }}>
              <span style={{ fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".05em", color: "#334155" }}>Lines (ft)</span>
              {[["Ridge", skel.ridge, "ridge"], ["Hips", skel.hip, "hip"], ["Valleys", skel.valley, "valley"], ["Eaves", skel.eave, "eave"]].map(([n, v, t]) => (
                <span key={n} style={{ fontSize: 13.5, color: "#334155" }}>
                  <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: LINECOL[t], marginRight: 6 }} />
                  {n} <b style={{ fontFamily: "ui-monospace,monospace" }}>{v}</b>
                </span>
              ))}
              <span style={{ fontSize: 11.5, color: "#b45309", marginLeft: "auto" }}>geometry estimate — compare to Roofr</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const stat = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "#64748b" };
const unit = { fontSize: 14, color: "#64748b" };
const inp = (w) => ({ width: w, fontFamily: FONT, fontSize: 15, padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 8 });
const sel = { fontFamily: FONT, fontSize: 13, padding: "5px 7px", border: "1px solid #cbd5e1", borderRadius: 8 };
function btn(color, outline) { return { fontFamily: FONT, fontSize: 13, fontWeight: 700, color: outline ? color : "#fff", background: outline ? "#fff" : color, border: `1px solid ${color}`, borderRadius: 8, padding: "7px 12px", cursor: "pointer" }; }
function seg(active, disabled) { return { fontFamily: FONT, fontSize: 13, fontWeight: 700, color: disabled ? "#cbd5e1" : active ? "#fff" : "#334155", background: active ? "#2563eb" : "#fff", border: `1px solid ${active ? "#2563eb" : "#cbd5e1"}`, borderRadius: 8, padding: "7px 12px", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 }; }
