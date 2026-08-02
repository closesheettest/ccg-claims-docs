// Straight-skeleton roof lines (ridge / hip / valley / eave) from the traced
// wall regions, computed on a raster edge-Voronoi. Partition the drip-edge
// footprint interior by NEAREST EDGE; the boundaries between edge-regions are the
// skeleton. Two edges meeting at a CONVEX vertex → HIP, at a REFLEX vertex →
// VALLEY, non-adjacent facing edges → RIDGE. Hip/valley are 45° creases, so their
// 3D length = plan × √(1 + p²/2); ridge/eave are horizontal (plan length as-is).
//
// Validated (node): a W×L rectangle reproduces the closed-form hip = 4·(W/2)·
// √(2+p²) and ridge = L−W; a reflex corner produces a valley; and the union of
// separate traced regions → one outline reproduces the single-polygon result.
//
// v1 assumes a single roof height (all-hip). A lower 1-story wing still shows its
// two side valleys correctly (they come from its reflex corners), but a true
// height-step (wing roof dying into a taller wall) is a later refinement, as are
// gable ends (rakes). Numbers are the geometry estimate — compare to Roofr.

const distToSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const signedArea = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const j = (i + 1) % pts.length; a += pts[i].x * pts[j].y - pts[j].x * pts[i].y; } return a / 2; };
// union-find clustering by proximity — separates disconnected skeleton pieces that share an edge-pair
const clusterPoints = (pts, thr) => {
  const n = pts.length, parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const th2 = thr * thr;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y; if (dx * dx + dy * dy <= th2) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; } }
  const m = {};
  for (let i = 0; i < n; i++) { const r = find(i); (m[r] = m[r] || []).push(pts[i]); }
  return Object.values(m);
};
const pinPoly = (x, y, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
};

// rasterize the union of regions, dilate outward by the overhang (square kernel)
function roofMask(regionsFt, overhangFt, cell) {
  const pts = regionsFt.flat();
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const p of pts) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  const pad = overhangFt + cell * 3;
  const x0 = minX - pad, y0 = minY - pad;
  const cols = Math.ceil((maxX - minX + 2 * pad) / cell), rows = Math.ceil((maxY - minY + 2 * pad) / cell);
  let mask = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) { const y = y0 + (r + 0.5) * cell; for (let c = 0; c < cols; c++) { const x = x0 + (c + 0.5) * cell; for (const poly of regionsFt) { if (pinPoly(x, y, poly)) { mask[r * cols + c] = 1; break; } } } }
  if (overhangFt > 0) {
    const rad = Math.max(1, Math.round(overhangFt / cell));
    const tmp = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { let v = 0; for (let k = -rad; k <= rad && !v; k++) { const cc = c + k; if (cc >= 0 && cc < cols && mask[r * cols + cc]) v = 1; } tmp[r * cols + c] = v; }
    const out = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { let v = 0; for (let k = -rad; k <= rad && !v; k++) { const rr = r + k; if (rr >= 0 && rr < rows && tmp[rr * cols + c]) v = 1; } out[r * cols + c] = v; }
    mask = out;
  }
  return { mask, cols, rows, x0, y0, cell };
}

// trace the outer boundary of the mask → rectilinear outline polygon (feet)
function outlineFromMask({ mask, cols, rows, x0, y0, cell }) {
  const F = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows && mask[r * cols + c];
  const em = new Map(); const K = (x, y) => x + "_" + y;
  const add = (x1, y1, x2, y2) => em.set(K(x1, y1), [x2, y2]);   // filled kept on the left → CCW outer loop
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!F(c, r)) continue;
    if (!F(c, r - 1)) add(c + 1, r, c, r);
    if (!F(c, r + 1)) add(c, r + 1, c + 1, r + 1);
    if (!F(c - 1, r)) add(c, r, c, r + 1);
    if (!F(c + 1, r)) add(c + 1, r + 1, c + 1, r);
  }
  let best = []; const seen = new Set();
  for (const start of em.keys()) {
    if (seen.has(start)) continue;
    const loop = []; let cur = start, guard = 0;
    while (cur && !loop.includes(cur) && guard++ < em.size + 5) { loop.push(cur); seen.add(cur); const nx = em.get(cur); cur = nx ? K(nx[0], nx[1]) : null; }
    if (loop.length > best.length) best = loop;
  }
  let poly = best.map((s) => { const [gx, gy] = s.split("_").map(Number); return { x: x0 + gx * cell, y: y0 + gy * cell }; });
  const merged = [];   // keep only direction-change vertices
  for (let i = 0; i < poly.length; i++) {
    const p = poly[(i - 1 + poly.length) % poly.length], v = poly[i], q = poly[(i + 1) % poly.length];
    if (Math.abs((v.x - p.x) * (q.y - v.y) - (v.y - p.y) * (q.x - v.x)) > 1e-6) merged.push(v);
  }
  return merged;
}

function skeletonOfOutline(polyIn, pitchX12, cell) {
  let poly = polyIn.slice();
  if (signedArea(poly) < 0) poly.reverse();          // force CCW
  const n = poly.length;
  if (n < 3) return { eave: 0, ridge: 0, hip: 0, valley: 0, segs: [] };
  const edges = poly.map((a, i) => ({ a, b: poly[(i + 1) % n], i }));
  const convex = poly.map((v, i) => {
    const p = poly[(i - 1 + n) % n], q = poly[(i + 1) % n];
    return ((v.x - p.x) * (q.y - v.y) - (v.y - p.y) * (q.x - v.x)) > 0;
  });
  const sharedVertex = (i, j) => (j === (i + 1) % n ? (i + 1) % n : i === (j + 1) % n ? (j + 1) % n : -1);

  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const cols = Math.ceil((maxX - minX) / cell), rows = Math.ceil((maxY - minY) / cell);
  const label = new Int16Array(cols * rows).fill(-1);
  for (let r = 0; r < rows; r++) {
    const y = minY + (r + 0.5) * cell;
    for (let c = 0; c < cols; c++) {
      const x = minX + (c + 0.5) * cell;
      if (!pinPoly(x, y, poly)) continue;
      let best = 1e9, bi = -1;
      for (const e of edges) { const d = distToSeg(x, y, e.a.x, e.a.y, e.b.x, e.b.y); if (d < best) { best = d; bi = e.i; } }
      label[r * cols + c] = bi;
    }
  }
  const groups = new Map(); const key = (i, j) => (i < j ? i + "," + j : j + "," + i);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const L = label[r * cols + c]; if (L < 0) continue;
    const x = minX + (c + 0.5) * cell, y = minY + (r + 0.5) * cell;
    for (const [dc, dr] of [[1, 0], [0, 1]]) {
      const c2 = c + dc, r2 = r + dr; if (c2 >= cols || r2 >= rows) continue;
      const L2 = label[r2 * cols + c2]; if (L2 < 0 || L2 === L) continue;
      const k = key(L, L2);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ x: x + dc * cell / 2, y: y + dr * cell / 2 });
    }
  }
  const p = (pitchX12 || 0) / 12;
  const hip3d = Math.sqrt(1 + (p * p) / 2);
  let ridge = 0, hip = 0, valley = 0; const segs = [];
  for (const [k, ptsAll] of groups) {
    if (ptsAll.length < 2) continue;
    const [i, j] = k.split(",").map(Number);
    const sv = sharedVertex(i, j);
    const type = sv >= 0 ? (convex[sv] ? "hip" : "valley") : "ridge";
    const V = sv >= 0 ? poly[sv] : null;
    // The SAME edge-pair can bisect in several separate spots on a complex roof;
    // measuring them as one segment spanned the whole roof and blew up ridges.
    // Split into connected pieces and measure each on its own.
    for (const pts of clusterPoints(ptsAll, cell * 2.5)) {
      if (pts.length < 2) continue;
      let len = 0, ep;
      const nearV = V && pts.some((q) => Math.hypot(q.x - V.x, q.y - V.y) < cell * 3);
      if (nearV) {
        let far = pts[0], fd = 0;
        for (const q of pts) { const d = Math.hypot(q.x - V.x, q.y - V.y); if (d > fd) { fd = d; far = q; } }
        len = fd + cell / 2; ep = [V, far];
      } else {
        let a0 = pts[0], b0 = pts[0];
        for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) { const d = Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y); if (d > len) { len = d; a0 = pts[a]; b0 = pts[b]; } }
        len += cell; ep = [a0, b0];
      }
      if (len < cell) continue;
      if (type === "ridge") ridge += len; else if (type === "hip") hip += len * hip3d; else valley += len * hip3d;
      segs.push({ type, a: ep[0], b: ep[1] });
    }
  }
  let eave = 0; for (const e of edges) eave += Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
  return { eave, ridge, hip, valley, segs };
}

// PUBLIC: regionsPx = [{pts:[{x,y}px]}], ftPerPx scales to feet. Skeletons EACH
// region's CLEAN traced polygon directly (its corners are exact), so hip/valley/
// ridge classification is reliable — re-rasterizing to an outline split corners
// into staircase steps and mislabeled hips as ridges. Lines are wall-based (no
// overhang here; ridge is overhang-invariant anyway, and the 2ft mostly lengthens
// eaves/hips — a small separate correction, TODO). roofMask/outlineFromMask are
// kept for a future union path. Returns totals (ft) + outlines & segments (ft).
export function roofSkeleton(regionsPx, ftPerPx, pitchX12) {
  if (!ftPerPx || !regionsPx || !regionsPx.length) return null;
  let eave = 0, ridge = 0, hip = 0, valley = 0;
  const segsFt = [], outlineFts = [];
  for (const r of regionsPx) {
    const poly = r.pts.map((p) => ({ x: p.x * ftPerPx, y: p.y * ftPerPx }));
    if (poly.length < 3) continue;
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const p of poly) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
    const cell = Math.max(0.2, Math.max(maxX - minX, maxY - minY) / 200);
    const sk = skeletonOfOutline(poly, pitchX12, cell);
    eave += sk.eave; ridge += sk.ridge; hip += sk.hip; valley += sk.valley;
    segsFt.push(...sk.segs);
    outlineFts.push(poly);
  }
  if (!outlineFts.length) return null;
  const r1 = (v) => Math.round(v * 10) / 10;
  return { eave: r1(eave), ridge: r1(ridge), hip: r1(hip), valley: r1(valley), outlineFt: outlineFts[0], outlineFts, segsFt };
}
