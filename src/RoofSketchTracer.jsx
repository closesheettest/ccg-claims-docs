// DoorDispatcher — ROOF SKETCH TRACER (production/admin). The guided front-end
// for Roof Takeoff: instead of decomposing the appraiser sketch into W×L numbers
// in your head, you PASTE the sketch, tap out each roofed rectangle on top of it,
// and type the two edge lengths printed right there on the drawing. The active
// edges highlight as you enter each number, so there's a direct line ↔ number tie.
//
// It doesn't measure the image — the human eye reads the sketch (works for every
// county). The trace only supplies POSITION: where each section sits relative to
// the main body tells us its side + offset, so the office never types those. The
// output feeds the same rect engine the typed tool uses (Roofr-validated).

import React, { useRef, useState, useEffect } from "react";

const FONT = "'Oswald', system-ui, sans-serif";

export default function RoofSketchTracer({ onApply }) {
  const [imgUrl, setImgUrl] = useState(null);
  const [rects, setRects] = useState([]);        // {x,y,w,h,a,b,style,role} in displayed px
  const [activeIdx, setActiveIdx] = useState(-1);
  const [armed, setArmed] = useState(null);      // 'main' | 'section' | null — awaiting taps
  const [firstPt, setFirstPt] = useState(null);  // first corner tapped
  const [hoverPt, setHoverPt] = useState(null);   // live cursor for the rubber-band
  const [hl, setHl] = useState(null);            // {idx, axis:'h'|'v'} — edge highlight
  const wrapRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // paste an image from the clipboard (screenshot of the sketch)
  useEffect(() => {
    function onPaste(e) {
      for (const it of e.clipboardData?.items || []) {
        if (it.type.startsWith("image/")) {
          const blob = it.getAsFile();
          if (blob) { setImgUrl((u) => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(blob); }); e.preventDefault(); }
          return;
        }
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  useEffect(() => {
    function sync() { const el = wrapRef.current; if (el) setSize({ w: el.clientWidth, h: el.clientHeight }); }
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [imgUrl]);

  function onFile(e) { const f = e.target.files?.[0]; if (f) setImgUrl((u) => { if (u) URL.revokeObjectURL(u); return URL.createObjectURL(f); }); }
  function onImgLoad() { const el = wrapRef.current; if (el) setSize({ w: el.clientWidth, h: el.clientHeight }); }

  const toLocal = (e) => { const r = wrapRef.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  function onClick(e) {
    if (!armed || !imgUrl) return;
    const p = toLocal(e);
    if (!firstPt) { setFirstPt(p); return; }
    // second corner → make the rectangle
    const x = Math.min(p.x, firstPt.x), y = Math.min(p.y, firstPt.y);
    const w = Math.abs(p.x - firstPt.x), h = Math.abs(p.y - firstPt.y);
    setFirstPt(null); setHoverPt(null);
    if (w < 10 || h < 10) { setArmed(null); return; }       // too tiny, ignore
    const role = armed === "main" ? "main" : "section";
    setRects((rs) => {
      let next = role === "main" ? rs.filter((r) => r.role !== "main") : rs.slice();
      next.push({ x, y, w, h, a: "", b: "", style: "hip", role });
      setActiveIdx(next.length - 1);
      return next;
    });
    setArmed(null);
  }
  function onMove(e) { if (armed && firstPt) setHoverPt(toLocal(e)); }

  function setDim(i, k, v) { setRects((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r))); }
  function setStyle(i, v) { setRects((rs) => rs.map((r, j) => (j === i ? { ...r, style: v } : r))); }
  function removeRect(i) { setRects((rs) => rs.filter((_, j) => j !== i)); setActiveIdx(-1); }

  const main = rects.find((r) => r.role === "main");
  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const ready = main && num(main.a) > 0 && num(main.b) > 0 && rects.every((r) => num(r.a) > 0 && num(r.b) > 0);
  const footprint = Math.round(rects.reduce((s, r) => s + num(r.a) * num(r.b), 0)); // Σ box areas (sqft) — cross-check vs the sketch's printed areas

  // ── turn the traced boxes into the engine's main + wings. Typed dims give the
  // SIZE; the pixel positions give side + offset (what the office used to guess).
  function apply() {
    if (!ready) return;
    const M = main;
    const ppfX = M.w / num(M.a);              // px per foot, each axis, from the main box
    const ppfY = M.h / num(M.b);
    const wings = rects.filter((r) => r.role !== "main").map((r) => {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      let side;
      if (cx < M.x) side = "left";
      else if (cx > M.x + M.w) side = "right";
      else if (cy < M.y) side = "top";
      else side = "bottom";
      const horizEdge = side === "bottom" || side === "top";
      const span = horizEdge ? num(r.a) : num(r.b);       // along the shared wall
      const depth = horizEdge ? num(r.b) : num(r.a);      // sticking out
      let offset = horizEdge ? (r.x - M.x) / ppfX : (r.y - M.y) / ppfY;
      offset = Math.max(0, Math.round(offset));
      return { span, depth, side, offset, style: r.style };
    });
    onApply({ main: { w: num(M.a), l: num(M.b), style: M.style }, wings });
  }

  // rubber-band preview rectangle while placing the second corner
  const band = armed && firstPt && hoverPt
    ? { x: Math.min(firstPt.x, hoverPt.x), y: Math.min(firstPt.y, hoverPt.y), w: Math.abs(hoverPt.x - firstPt.x), h: Math.abs(hoverPt.y - firstPt.y) }
    : null;

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <b style={{ fontSize: 15 }}>✏️ Trace the sketch</b>
        <span style={{ fontSize: 11.5, color: "#64748b" }}>paste or upload the county building sketch, then tap each roofed box</span>
      </div>

      {!imgUrl ? (
        <label style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, height: 200, border: "2px dashed #cbd5e1", borderRadius: 12, cursor: "pointer", color: "#64748b", background: "#f8fafc" }}>
          <span style={{ fontSize: 34 }}>📋</span>
          <span style={{ fontSize: 14, fontWeight: 700 }}>Paste the sketch (Ctrl/⌘-V) or click to upload</span>
          <span style={{ fontSize: 12 }}>Screenshot it from the county appraiser page, then paste here</span>
          <input type="file" accept="image/*" onChange={onFile} style={{ display: "none" }} />
        </label>
      ) : (
        <>
          {/* toolbar */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "8px 0 8px" }}>
            <button onClick={() => { setArmed("main"); setFirstPt(null); }} style={seg(armed === "main")}>① Trace the BIGGEST box</button>
            <button onClick={() => { setArmed("section"); setFirstPt(null); }} disabled={!main} style={seg(armed === "section", !main)}>② Add a section</button>
            <label style={{ ...btn("#64748b", true), display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              ↺ Replace image<input type="file" accept="image/*" onChange={onFile} style={{ display: "none" }} />
            </label>
            {armed && <span style={{ fontSize: 12.5, fontWeight: 700, color: "#b45309" }}>{firstPt ? "Now tap the OPPOSITE corner" : `Tap one corner of the ${armed === "main" ? "biggest box" : "section"}`}</span>}
          </div>

          {/* the model, spelled out so nobody boxes the whole house */}
          <div style={{ fontSize: 12.5, color: "#334155", background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 8, padding: "8px 12px", marginBottom: 10, lineHeight: 1.5 }}>
            Trace each <b>labeled box</b> on the sketch on its own — the biggest (BAS / TWO) is the main, each garage / porch (FGR / FOP) is a section. Copy the number printed on each edge. <b style={{ color: "#b45309" }}>Don't draw one box around the whole house.</b> Skip open balconies (BAL). Your traced footprint should roughly match the sum of the area numbers printed inside the boxes.
          </div>

          {/* the sketch + trace overlay */}
          <div ref={wrapRef} onClick={onClick} onMouseMove={onMove} style={{ position: "relative", lineHeight: 0, borderRadius: 10, overflow: "hidden", border: "1px solid #e5e7eb", cursor: armed ? "crosshair" : "default", userSelect: "none" }}>
            <img src={imgUrl} onLoad={onImgLoad} alt="appraiser sketch" style={{ width: "100%", display: "block", pointerEvents: "none" }} />
            <svg viewBox={`0 0 ${size.w || 1} ${size.h || 1}`} width={size.w} height={size.h} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              {rects.map((r, i) => {
                const isMain = r.role === "main";
                const c = isMain ? "#2563eb" : "#16a34a";
                const hlAxis = hl && hl.idx === i ? hl.axis : null;
                return (
                  <g key={i}>
                    <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={c + "22"} stroke={c} strokeWidth={i === activeIdx ? 2.5 : 1.5} />
                    {/* highlight the edges whose length is being typed */}
                    {hlAxis === "h" && <>
                      <line x1={r.x} y1={r.y} x2={r.x + r.w} y2={r.y} stroke="#f59e0b" strokeWidth={4} />
                      <line x1={r.x} y1={r.y + r.h} x2={r.x + r.w} y2={r.y + r.h} stroke="#f59e0b" strokeWidth={4} />
                    </>}
                    {hlAxis === "v" && <>
                      <line x1={r.x} y1={r.y} x2={r.x} y2={r.y + r.h} stroke="#f59e0b" strokeWidth={4} />
                      <line x1={r.x + r.w} y1={r.y} x2={r.x + r.w} y2={r.y + r.h} stroke="#f59e0b" strokeWidth={4} />
                    </>}
                    <text x={r.x + r.w / 2} y={r.y + r.h / 2} fill={c} fontSize={13} fontWeight={800} textAnchor="middle" dominantBaseline="middle" style={{ fontFamily: FONT }}>{isMain ? "MAIN" : i + 1}</text>
                  </g>
                );
              })}
              {band && <rect x={band.x} y={band.y} width={band.w} height={band.h} fill="#f59e0b22" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="5,4" />}
              {armed && firstPt && <circle cx={firstPt.x} cy={firstPt.y} r={4} fill="#f59e0b" />}
            </svg>
          </div>

          {/* dimension entry — one row per traced box, read the labels off the sketch */}
          {rects.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "#64748b", marginBottom: 6 }}>Type each box's two edge lengths (from the sketch)</div>
              {rects.map((r, i) => (
                <div key={i} onMouseEnter={() => setActiveIdx(i)} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", padding: "8px 0", borderTop: "1px dashed #e5e7eb" }}>
                  <span style={{ width: 54, fontSize: 13, fontWeight: 800, color: r.role === "main" ? "#2563eb" : "#16a34a" }}>{r.role === "main" ? "MAIN" : `#${i + 1}`}</span>
                  <label style={lab}>↔ across (ft)
                    <input value={r.a} onChange={(e) => setDim(i, "a", e.target.value)} onFocus={() => setHl({ idx: i, axis: "h" })} onBlur={() => setHl(null)} inputMode="decimal" style={inp(64)} />
                  </label>
                  <label style={lab}>↕ down (ft)
                    <input value={r.b} onChange={(e) => setDim(i, "b", e.target.value)} onFocus={() => setHl({ idx: i, axis: "v" })} onBlur={() => setHl(null)} inputMode="decimal" style={inp(64)} />
                  </label>
                  <label style={lab}>style
                    <select value={r.style} onChange={(e) => setStyle(i, e.target.value)} style={sel}><option value="hip">Hip</option><option value="gable">Gable</option></select>
                  </label>
                  <button onClick={() => removeRect(i)} style={{ ...btn("#dc2626", true), alignSelf: "end" }}>×</button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
            <button onClick={apply} disabled={!ready} style={btn(ready ? "#16a34a" : "#94a3b8")}>✓ Apply to takeoff</button>
            {footprint > 0 && (
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "#334155" }}>
                Traced footprint: {footprint.toLocaleString()} sqft
                <span style={{ fontWeight: 400, color: "#94a3b8" }}> — should ≈ the area numbers printed on the sketch</span>
              </span>
            )}
            {rects.length === 1 && footprint > 0 && (
              <span style={{ fontSize: 12, color: "#b45309" }}>Only one box traced — most homes have a garage/porch section too. Sure this isn't the whole outline?</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 6 }}>{ready ? "Fills the sections below — the side & offset are read from your trace." : "Trace the biggest box + type every box's two dimensions to apply."}</div>
        </>
      )}
    </div>
  );
}

const lab = { display: "flex", flexDirection: "column", gap: 3, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "#64748b" };
const inp = (w) => ({ width: w, fontFamily: FONT, fontSize: 15, padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 8 });
const sel = { fontFamily: FONT, fontSize: 14, padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 8 };
function btn(color, outline) {
  return { fontFamily: FONT, fontSize: 13, fontWeight: 700, color: outline ? color : "#fff", background: outline ? "#fff" : color, border: `1px solid ${color}`, borderRadius: 8, padding: "7px 13px", cursor: "pointer" };
}
function seg(active, disabled) {
  return { fontFamily: FONT, fontSize: 13, fontWeight: 700, color: disabled ? "#cbd5e1" : active ? "#fff" : "#334155", background: active ? "#2563eb" : "#fff", border: `1px solid ${active ? "#2563eb" : "#cbd5e1"}`, borderRadius: 8, padding: "7px 13px", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 };
}
