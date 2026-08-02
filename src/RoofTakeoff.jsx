// DoorDispatcher — ROOF TAKEOFF (production/admin, ?mode=rooftakeoff). Office-only.
//
// The precise counterpart to the sales measure tool. An admin reads the roofed
// sub-areas off the county appraiser sketch (base + garage + porch, as W×L
// rectangles) and the pitch; this composes the roof and returns the full linear
// takeoff — squares + ridge / hip / valley / eave / rake — and draws the roof so
// they can eyeball it. Survey-grade areas + geometry = a material-order takeoff,
// no per-county scraping and no imagery. Engine validated against Roofr.

import React, { useState } from "react";
import { appraiserFor } from "./flAppraisers";
import RoofSketchTracer from "./RoofSketchTracer";
import RoofRegionTracer from "./RoofRegionTracer";
import RoofLineTracer from "./RoofLineTracer";

const FONT = "'Oswald', system-ui, sans-serif";
const sf = (x12) => Math.sqrt(1 + Math.pow((+x12 || 0) / 12, 2));

// ── takeoff for one rectangle (feet). Ridge runs along the LONGER side.
function rectRoof(w, l, x12, style) {
  const W = Math.min(w, l), L = Math.max(w, l);
  const p = (+x12 || 0) / 12;
  if (style === "gable") {
    return { ridge: L, hips: 0, valleys: 0, eaves: 2 * L, rakes: 2 * W * sf(x12), area: L * W * sf(x12) };
  }
  return { ridge: L - W, hips: 4 * (W / 2) * Math.sqrt(2 + p * p), valleys: 0, eaves: 2 * (L + W), rakes: 0, area: L * W * sf(x12) };
}

// ── line geometry (top-down) for a rectangle placed at (x0,y0), size w×h.
function rectLines(x0, y0, w, h, style) {
  const lines = [];
  const eave = { type: "eave", pts: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]] };
  const horiz = w >= h;                          // ridge runs along the longer axis
  const half = Math.min(w, h) / 2;
  if (style === "gable") {
    if (horiz) lines.push({ type: "ridge", pts: [[x0, y0 + h / 2], [x0 + w, y0 + h / 2]] });
    else lines.push({ type: "ridge", pts: [[x0 + w / 2, y0], [x0 + w / 2, y0 + h]] });
  } else {                                        // hip
    let a, b;
    if (horiz) { a = [x0 + half, y0 + h / 2]; b = [x0 + w - half, y0 + h / 2]; }
    else { a = [x0 + w / 2, y0 + half]; b = [x0 + w / 2, y0 + h - half]; }
    lines.push({ type: "ridge", pts: [a, b] });
    lines.push({ type: "hip", pts: [[x0, y0], a] });
    lines.push({ type: "hip", pts: [[x0 + w, y0], horiz ? a : b] });
    lines.push({ type: "hip", pts: [[x0, y0 + h], horiz ? b : a] });
    lines.push({ type: "hip", pts: [[x0 + w, y0 + h], b] });
  }
  return { eave, lines };
}

const SIDES = { bottom: "Bottom", top: "Top", right: "Right", left: "Left" };

export default function RoofTakeoff() {
  const [pitch, setPitch] = useState(6);
  const [main, setMain] = useState({ w: 54, l: 40, style: "hip" });
  const [wings, setWings] = useState([{ span: 20, depth: 22, side: "bottom", offset: 30, style: "hip" }]);

  const [address, setAddress] = useState("");
  const [ref, setRef] = useState(null);       // independent reference numbers for cross-check
  const [looking, setLooking] = useState(false);

  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
  const setW = (i, k, v) => setWings((ws) => ws.map((w, j) => (j === i ? { ...w, [k]: v } : w)));

  // trace → fills the same fields the typed tool uses (side + offset from the trace)
  function applyTrace({ main: m, wings: wg }) {
    setMain({ w: m.w, l: m.l, style: m.style });
    setWings(wg.length ? wg : []);
  }

  async function lookup() {
    const a = address.trim(); if (!a || looking) return;
    setLooking(true);
    try {
      const d = await fetch("/.netlify/functions/harvest-roof-report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: a }) }).then((r) => r.json());
      if (d.ok) {
        setRef({ sat: d.roof?.surface_squares, pitch: d.roof?.avg_pitch_x12, living: d.appraiser?.living_sqft, fema: d.confidence?.fema_sqft, imagery: d.imagery?.quality, addr: d.geocoded_as, county: d.county, planes: d.planes, loc: d.location });
        if (d.roof?.avg_pitch_x12) setPitch(d.roof.avg_pitch_x12);   // pre-fill the pitch we trust
      } else setRef({ error: d.error || "no data" });
    } catch { setRef({ error: "lookup failed" }); }
    setLooking(false);
  }

  // ── place rectangles on a shared grid (main at origin) + collect lines
  const rects = [{ x: 0, y: 0, w: num(main.w), h: num(main.l), style: main.style }];
  wings.forEach((wg) => {
    const span = num(wg.span), depth = num(wg.depth), off = num(wg.offset);
    let r;
    if (wg.side === "bottom") r = { x: off, y: num(main.l), w: span, h: depth };
    else if (wg.side === "top") r = { x: off, y: -depth, w: span, h: depth };
    else if (wg.side === "right") r = { x: num(main.w), y: off, w: depth, h: span };
    else r = { x: -depth, y: off, w: depth, h: span };
    rects.push({ ...r, style: wg.style });
  });

  // ── totals: sum each rectangle, add 2 valleys per wing (its slopes dying into main)
  const t = { ridge: 0, hips: 0, valleys: 0, eaves: 0, rakes: 0, area: 0 };
  const mainRoof = rectRoof(num(main.w), num(main.l), pitch, main.style);
  for (const k in t) t[k] += mainRoof[k];
  wings.forEach((wg) => {
    const wr = rectRoof(num(wg.span), num(wg.depth), pitch, wg.style);
    for (const k in t) t[k] += wr[k];
    const p = (+pitch || 0) / 12;
    t.valleys += 2 * (num(wg.span) / 2) * Math.sqrt(2 + p * p);   // wing meets main → 2 valleys
    t.eaves -= num(wg.span);                                       // shared wall is not an eave
  });
  const squares = t.area / 100;
  const r1 = (n) => Math.round(n * 10) / 10;
  const footprint = t.area / sf(pitch);   // under-roof footprint (sqft)

  // ── guardrails: bounds, contradictions, and cross-checks vs the independent numbers
  const warnings = [];
  const nP = num(pitch);
  if (nP <= 0 || nP > 24) warnings.push("Pitch is outside 0–24/12 — check it.");
  if (num(main.w) < 4 || num(main.w) > 300 || num(main.l) < 4 || num(main.l) > 300) warnings.push("A main-body dimension is outside 4–300 ft.");
  wings.forEach((wg, i) => {
    const span = num(wg.span), depth = num(wg.depth), off = num(wg.offset);
    const edge = (wg.side === "bottom" || wg.side === "top") ? num(main.w) : num(main.l);
    if (span < 2 || span > 200 || depth < 2 || depth > 200) warnings.push(`Wing ${i + 1} dimensions look off.`);
    if (span > edge) warnings.push(`Wing ${i + 1} is wider (${span} ft) than the wall it attaches to (${edge} ft).`);
    if (off < 0) warnings.push(`Wing ${i + 1} offset can't be negative.`);
    else if (off + span > edge + 0.5) warnings.push(`Wing ${i + 1} hangs off the edge (offset ${off} + span ${span} > ${edge} ft wall).`);
  });
  if (squares < 5 || squares > 120) warnings.push(`Total ${r1(squares)} sq is outside a normal roof range (5–120).`);
  if (ref && !ref.error) {
    if (ref.living && footprint < ref.living * 0.95) warnings.push(`Under-roof (${Math.round(footprint)} sqft) is LESS than the county living area (${ref.living} sqft) — impossible on one story. Missing the garage/porch?`);
    if (ref.sat && Math.abs(squares - ref.sat) / ref.sat > 0.3) warnings.push(`Your ${r1(squares)} sq is ${Math.round((Math.abs(squares - ref.sat) / ref.sat) * 100)}% off the satellite read (${ref.sat} sq) — double-check for a fat-finger (stray digit?).`);
  }

  // ── SVG bounds
  const xs = rects.flatMap((r) => [r.x, r.x + r.w]);
  const ys = rects.flatMap((r) => [r.y, r.y + r.h]);
  const minX = Math.min(...xs) - 6, maxX = Math.max(...xs) + 6, minY = Math.min(...ys) - 6, maxY = Math.max(...ys) + 6;
  const geo = rects.map((r) => rectLines(r.x, r.y, r.w, r.h, r.style));
  const col = { eave: "#0f172a", ridge: "#dc2626", hip: "#2563eb", valley: "#059669" };

  return (
    <div style={{ fontFamily: FONT, maxWidth: 1000, margin: "0 auto", padding: "24px 16px 80px", color: "#0f172a" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <span style={{ fontSize: 30 }}>📐</span>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Roof Takeoff</h1>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#7c3aed", background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 999, padding: "3px 9px" }}>PRODUCTION</span>
      </div>
      <p style={{ color: "#64748b", fontSize: 14, margin: "0 0 20px", maxWidth: "70ch" }}>
        Paste the county sketch, tap each roofed box on top of it, and type the two edge lengths printed on the drawing — the side & offset are read from your trace. (Or type the sections by hand below.) This composes the roof and returns the full linear takeoff — exact, from the survey numbers.
      </p>

      {/* address lookup — pulls independent numbers to pre-fill the pitch and cross-check the entry */}
      <div style={{ ...card, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "#475569" }}>🔎 Address (optional — pre-fills pitch, cross-checks your entry):</span>
        <input value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") lookup(); }} placeholder="4333 Cheval Blvd, Lutz, FL" style={{ ...inp(280), flex: "1 1 220px" }} />
        <button onClick={lookup} disabled={looking || !address.trim()} style={btn(looking || !address.trim() ? "#94a3b8" : "#2563eb")}>{looking ? "…" : "Look up"}</button>
      </div>
      {ref && !ref.error && (() => {
        const appr = appraiserFor(ref.county); // [displayName, searchUrl] or null
        const href = appr ? appr[1] : `https://www.google.com/search?q=${encodeURIComponent((ref.addr || address) + " property appraiser building sketch")}`;
        const label = appr ? `🏛️ ${appr[0]} appraiser ↗` : "🏛️ Find appraiser sketch ↗";
        return (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", fontSize: 13, color: "#475569", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10, padding: "10px 14px", marginBottom: 16 }}>
          <span>Reference for <b>{ref.addr}</b>:</span>
          <span>satellite <b>{ref.sat} sq</b> ({ref.imagery})</span>
          {ref.living != null && <span>· county living <b>{ref.living} sqft</b></span>}
          {ref.fema != null && <span>· FEMA footprint <b>{ref.fema} sqft</b></span>}
          <span>· pitch pre-filled to <b>{ref.pitch}/12</b></span>
          <a href={href} target="_blank" rel="noreferrer" title={appr ? `Opens ${appr[0]}'s property search — search the address, then open Building Sketch` : "County not mapped — falls back to a web search"}
            style={{ marginLeft: "auto", fontFamily: FONT, fontSize: 13, fontWeight: 700, color: "#fff", background: "#7c3aed", border: "none", borderRadius: 8, padding: "8px 14px", cursor: "pointer", textDecoration: "none", whiteSpace: "nowrap" }}>
            {label}
          </a>
        </div>
        );
      })()}

      {/* PRIMARY: region trace → exact footprint + squares on any cut-up shape */}
      <RoofRegionTracer pitch={pitch} onPitchChange={setPitch} facets={ref && !ref.error ? ref.planes : null} />

      {/* LINE takeoff — human draws ridges/hips/valleys on the satellite, math measures */}
      <RoofLineTracer lat={ref && !ref.error ? ref.loc?.lat : null} lng={ref && !ref.error ? ref.loc?.lng : null} pitch={pitch} />

      {/* line takeoff (rectangles) — for ridge/hip/valley on simple houses until the geometry pass */}
      <details style={{ marginTop: 4 }}>
        <summary style={{ cursor: "pointer", fontSize: 12.5, fontWeight: 700, color: "#475569", padding: "6px 0" }}>➕ Line takeoff (ridge / hip / valley) — box + wings, for simple houses</summary>

        {/* trace the sketch → fills the fields below (side + offset inferred from the trace) */}
        <RoofSketchTracer onApply={applyTrace} />

      {/* inputs — the source of truth; the trace fills them, tweak here if needed */}
      <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "#64748b", margin: "4px 0 8px" }}>Sections (from your trace — edit if needed)</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 16 }}>
        <div style={card}>
          <div style={label}>Pitch</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input value={pitch} onChange={(e) => setPitch(e.target.value)} type="number" min={0} max={24} step={0.5} style={inp(80)} /> <span style={{ color: "#64748b" }}>/12</span>
          </div>
          <div style={{ ...label, marginTop: 16 }}>Main body (BAS)</div>
          <div style={row}>
            <L t="Width">{<input value={main.w} onChange={(e) => setMain({ ...main, w: e.target.value })} style={inp(70)} />}</L>
            <L t="Length">{<input value={main.l} onChange={(e) => setMain({ ...main, l: e.target.value })} style={inp(70)} />}</L>
            <L t="Style">{<select value={main.style} onChange={(e) => setMain({ ...main, style: e.target.value })} style={sel}><option value="hip">Hip</option><option value="gable">Gable</option></select>}</L>
          </div>
        </div>
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={label}>Wings (garage FGR, porch FOP…)</div>
            <button onClick={() => setWings([...wings, { span: 16, depth: 8, side: "bottom", offset: 0, style: "hip" }])} style={btn("#2563eb", true)}>+ Add</button>
          </div>
          {wings.map((wg, i) => (
            <div key={i} style={{ ...row, marginTop: 10, borderTop: "1px dashed #e5e7eb", paddingTop: 10 }}>
              <L t="Span">{<input value={wg.span} onChange={(e) => setW(i, "span", e.target.value)} style={inp(56)} />}</L>
              <L t="Depth">{<input value={wg.depth} onChange={(e) => setW(i, "depth", e.target.value)} style={inp(56)} />}</L>
              <L t="Side">{<select value={wg.side} onChange={(e) => setW(i, "side", e.target.value)} style={sel}>{Object.entries(SIDES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</L>
              <L t="Offset">{<input value={wg.offset} onChange={(e) => setW(i, "offset", e.target.value)} style={inp(56)} />}</L>
              <button onClick={() => setWings(wings.filter((_, j) => j !== i))} style={{ ...btn("#dc2626", true), alignSelf: "end" }}>×</button>
            </div>
          ))}
        </div>
      </div>

      {/* guardrails */}
      {warnings.length > 0 && (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, padding: "12px 16px", marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#b45309", marginBottom: 6 }}>⚠️ Check these before ordering</div>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13.5, color: "#92400e", lineHeight: 1.6 }}>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {/* result */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 18 }}>
        <div style={card}>
          <div style={label}>Takeoff</div>
          <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: "-.02em", margin: "4px 0 2px" }}>{r1(squares)} <span style={{ fontSize: 16, color: "#64748b", fontWeight: 600 }}>squares</span></div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, marginTop: 8 }}>
            <tbody>
              {[["Ridge", t.ridge, col.ridge], ["Hips", t.hips, col.hip], ["Valleys", t.valleys, col.valley], ["Eaves", t.eaves, col.eave], ["Rakes", t.rakes, "#b45309"]].map(([n, v, c]) => (
                <tr key={n} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "7px 0" }}><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: c, marginRight: 8 }} />{n}</td>
                  <td style={{ padding: "7px 0", textAlign: "right", fontFamily: "ui-monospace,monospace", fontWeight: 700 }}>{r1(v)} ft</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>Wings add 2 valleys each at the junction. Enter the drip-edge dimensions (add overhang) for order-ready numbers.</div>
        </div>
        <div style={card}>
          <div style={label}>Roof</div>
          <svg viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} style={{ width: "100%", height: 300, background: "#f8fafc", borderRadius: 8, marginTop: 6 }} preserveAspectRatio="xMidYMid meet">
            {geo.map((g, gi) => (
              <g key={gi}>
                <polyline points={g.eave.pts.map((p) => p.join(",")).join(" ")} fill="rgba(37,99,235,.05)" stroke={col.eave} strokeWidth={0.7} />
                {g.lines.map((ln, li) => (
                  <polyline key={li} points={ln.pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={col[ln.type]} strokeWidth={ln.type === "ridge" ? 1.1 : 0.9} />
                ))}
              </g>
            ))}
          </svg>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11.5, marginTop: 6, color: "#64748b" }}>
            <span><b style={{ color: col.ridge }}>—</b> ridge</span><span><b style={{ color: col.hip }}>—</b> hip</span><span><b style={{ color: col.valley }}>—</b> valley</span><span><b style={{ color: col.eave }}>—</b> eave</span>
          </div>
        </div>
      </div>
      </details>
    </div>
  );
}

function L({ t, children }) {
  return <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "#64748b" }}>{t}{children}</label>;
}
const card = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 16 };
const label = { fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "#64748b", marginBottom: 6 };
const row = { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" };
const inp = (w) => ({ width: w, fontFamily: FONT, fontSize: 15, padding: "7px 9px", border: "1px solid #cbd5e1", borderRadius: 8 });
const sel = { fontFamily: FONT, fontSize: 14, padding: "7px 8px", border: "1px solid #cbd5e1", borderRadius: 8 };
function btn(color, outline) {
  return { fontFamily: FONT, fontSize: 13, fontWeight: 700, color: outline ? color : "#fff", background: outline ? "#fff" : color, border: `1px solid ${color}`, borderRadius: 8, padding: "6px 12px", cursor: "pointer" };
}
