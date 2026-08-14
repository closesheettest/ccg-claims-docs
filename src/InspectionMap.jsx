// Door Dispatcher — INSPECTION MAP (?mode=inspectmap&it=<inspector map_token>).
// An inspector's map of every inspection that still needs inspecting. "Route my
// day" draws a box → routes the inspections inside (street-by-street) → ROUTE-LOCKS
// them so they vanish from every other inspector's map for 30 min. Live GPS trail;
// each stop logs a pin-by-pin visit (arrived/completed) with time + GPS for the
// inspector report. Office view: &admin=<harvest admin token>.
import React, { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { supabase } from "./lib/supabase";

const FONT = "'Nunito', system-ui, sans-serif";
const OSWALD = "'Oswald', sans-serif";
const CLAIM_BEAT_MS = 8 * 60 * 1000;

// ── pure routing helpers (same street-by-street engine as the harvest map) ──
function streetKey(p) { const raw = String(p.address || "").split(",")[0].trim().toLowerCase(); return raw.replace(/^\s*\d+[a-z]?\s+/, "").replace(/\s+(apt|unit|ste|suite|#|lot|bldg)\b.*$/, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim() || `~${(p.latitude || 0).toFixed(3)},${(p.longitude || 0).toFixed(3)}`; }
function houseNum(p) { const m = String(p.address || "").match(/\d+/); return m ? parseInt(m[0], 10) : 0; }
function feetBetween(a, b) { if (!a || !b) return Infinity; const R = 20902231, toRad = (d) => (d * Math.PI) / 180; const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng); const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))); }
function segsCross(p1, p2, p3, p4) { const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4); return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)); }
function pathCrossings(pts) { let c = 0; for (let i = 0; i < pts.length - 1; i++) for (let j = i + 2; j < pts.length - 1; j++) { if (i === 0 && j === pts.length - 2) continue; if (segsCross(pts[i], pts[i + 1], pts[j], pts[j + 1])) c++; } return c; }
function streetSegments(stops) { const GAP = 1200, g = new Map(); for (const p of stops) { const k = streetKey(p); if (!g.has(k)) g.set(k, []); g.get(k).push(p); } const segs = []; for (const grp of g.values()) { const s = grp.slice().sort((a, b) => houseNum(a) - houseNum(b) || a.latitude - b.latitude || a.longitude - b.longitude); let run = [s[0]]; for (let i = 1; i < s.length; i++) { if (feetBetween({ lat: s[i - 1].latitude, lng: s[i - 1].longitude }, { lat: s[i].latitude, lng: s[i].longitude }) > GAP) { segs.push(run); run = [s[i]]; } else run.push(s[i]); } segs.push(run); } return segs; }
function orderStops(start, stops) {
  const segs = streetSegments(stops); if (segs.length <= 1) return segs.flat();
  const co = (p) => ({ lat: p.latitude, lng: p.longitude }), sp = { lat: start.lat, lng: start.lng };
  const S = segs.map((seg) => ({ seg, a: co(seg[0]), b: co(seg[seg.length - 1]) }));
  const rem = S.slice(), order = []; let cur = sp;
  while (rem.length) { let bi = 0, bd = Infinity, rev = false; for (let i = 0; i < rem.length; i++) { const dA = feetBetween(cur, rem[i].a), dB = feetBetween(cur, rem[i].b); if (dA < bd) { bd = dA; bi = i; rev = false; } if (dB < bd) { bd = dB; bi = i; rev = true; } } const x = rem.splice(bi, 1)[0]; order.push({ ...x, rev }); cur = rev ? x.a : x.b; }
  const head = (e) => (e.rev ? e.b : e.a), tail = (e) => (e.rev ? e.a : e.b);
  const flat = (arr) => { const o = []; for (const e of arr) { const w = e.rev ? e.seg.slice().reverse() : e.seg; for (const p of w) o.push(p); } return o; };
  const dist = (arr) => { let t = feetBetween(sp, head(arr[0])); for (let i = 0; i < arr.length - 1; i++) t += feetBetween(tail(arr[i]), head(arr[i + 1])); return t; };
  const bigDay = stops.length > 90;
  const score = (arr) => ({ cx: bigDay ? 0 : pathCrossings(flat(arr).map((p) => ({ x: p.longitude, y: p.latitude }))), d: dist(arr) });
  const accept = (sc) => sc.cx < cur2.cx || (sc.cx === cur2.cx && sc.d + 1e-6 < cur2.d);
  let cur2 = score(order), imp = true, pass = 0;
  while (imp && pass < 12) { imp = false; pass++; for (let i = 0; i < order.length - 1; i++) for (let k = i + 1; k < order.length; k++) { const block = order.slice(i, k + 1).reverse().map((e) => ({ ...e, rev: !e.rev })); const cand = order.slice(0, i).concat(block, order.slice(k + 1)); const sc = score(cand); if (accept(sc)) { order.splice(0, order.length, ...cand); cur2 = sc; imp = true; } } }
  return flat(order);
}

export default function InspectionMap() {
  const { token, admin } = useMemo(() => { try { const q = new URLSearchParams(window.location.search); return { token: q.get("it") || "", admin: q.get("admin") || "" }; } catch { return { token: "", admin: "" }; } }, []);
  const [me, setMe] = useState(null);
  const [pins, setPins] = useState([]);
  const [err, setErr] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [route, setRoute] = useState([]);
  const [stopIdx, setStopIdx] = useState(0);
  const [dayMode, setDayMode] = useState(null); // null | "active"
  const [selected, setSelected] = useState(null);
  const [loc, setLoc] = useState(null);
  const [mapReady, setMapReady] = useState(false);
  const [showInspected, setShowInspected] = useState(false); // "Roofs Inspected" panel
  const [inspected, setInspected] = useState(null);          // completed inspections (lazy)
  // First-open how-to: play the 52-sec inspection video once, then straight to the
  // map on every open after (flag lives on the inspector's device). No test.
  const [howtoDone, setHowtoDone] = useState(() => { try { return localStorage.getItem("ccg_inspect_howto_v1") === "1"; } catch { return false; } });
  const restored = useRef(false);

  const mapEl = useRef(null), map = useRef(null);
  const markers = useRef(null), routeLine = useRef(null), trail = useRef(null), selectLayer = useRef(null);
  const meMarker = useRef(null), selectStart = useRef(null), fitted = useRef(false);
  const qs = admin ? `admin=${encodeURIComponent(admin)}` : `it=${encodeURIComponent(token)}`;

  // Auth
  useEffect(() => { (async () => {
    try { const r = await fetch(`/.netlify/functions/inspect-pins?${qs}&authonly=1`); const j = await r.json(); if (!j.ok) { setErr(j.error || "Invalid link"); return; } setMe(j.inspector); }
    catch (e) { setErr(e.message || "Network error"); }
  })(); }, [qs]);

  const loadPins = async () => { try { const r = await fetch(`/.netlify/functions/inspect-pins?${qs}`); const j = await r.json(); if (j.ok) setPins(j.pins || []); } catch { /* keep */ } };
  useEffect(() => { if (me) loadPins(); /* eslint-disable-next-line */ }, [me]);

  // Restore an in-progress route after returning from the inspector portal.
  // Starting an inspection navigates away (full page load), so the route is
  // persisted to localStorage; on the way back we rebuild it and — if the
  // inspector just finished a roof — advance to the next stop.
  useEffect(() => {
    if (!me || restored.current) return;
    restored.current = true;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem("ccg_inspect_route") || "null"); } catch { /* ignore */ }
    if (!saved || !Array.isArray(saved.stops) || !saved.stops.length) return;
    // A route older than 4h is yesterday's — start fresh.
    if (saved.ts && Date.now() - saved.ts > 4 * 3600 * 1000) { try { localStorage.removeItem("ccg_inspect_route"); } catch { /* ignore */ } return; }
    let idx = Number(saved.stopIdx) || 0;
    let completedId = null;
    try { completedId = localStorage.getItem("ccg_inspect_completed"); } catch { /* ignore */ }
    if (completedId) {
      try { localStorage.removeItem("ccg_inspect_completed"); } catch { /* ignore */ }
      const ci = saved.stops.findIndex((s) => String(s.id) === String(completedId));
      if (ci >= 0) idx = ci + 1; // advance past the finished roof
    }
    if (idx >= saved.stops.length) {
      // Whole route done — release the locks and clear it.
      release(saved.stops.map((s) => s.id));
      try { localStorage.removeItem("ccg_inspect_route"); } catch { /* ignore */ }
      return;
    }
    setRoute(saved.stops); setStopIdx(idx); setDayMode("active");
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the persisted route fresh while a route is active (survives the
  // navigate-away/return round-trip).
  useEffect(() => {
    if (dayMode !== "active" || !route.length) return;
    try { localStorage.setItem("ccg_inspect_route", JSON.stringify({ stops: route, stopIdx, ts: Date.now() })); } catch { /* ignore */ }
  }, [dayMode, route, stopIdx]);

  // Center on the current stop whenever it changes (incl. restored/advanced).
  useEffect(() => {
    if (!mapReady || dayMode !== "active") return;
    const n = route[stopIdx];
    if (n && n.latitude != null) { try { map.current.setView([n.latitude, n.longitude], 16); } catch { /* ignore */ } }
  }, [mapReady, dayMode, stopIdx, route]);

  // Map init — runs once `me` is resolved (before that the component shows the
  // loading splash and the map div isn't in the DOM yet, so a mount-only [] effect
  // would bail on a null ref and never re-run).
  useEffect(() => { if (map.current || !me || !mapEl.current) return;
    const m = L.map(mapEl.current, { zoomControl: true }).setView([27.7, -81.6], 7);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(m);
    map.current = m; markers.current = L.layerGroup().addTo(m); routeLine.current = L.layerGroup().addTo(m); trail.current = L.layerGroup().addTo(m); selectLayer.current = L.layerGroup().addTo(m); setMapReady(true);
    // The container's final size isn't ready the instant L.map() runs (React hasn't
    // painted yet) — without this the tiles never load and the map is blank.
    const kick = () => { try { m.invalidateSize(); } catch { /* ignore */ } };
    setTimeout(kick, 60); setTimeout(kick, 300); setTimeout(kick, 800);
    window.addEventListener("resize", kick); window.addEventListener("orientationchange", kick);
  }, [me]);

  // Render pins (all needing inspection when idle; the routed set when active)
  useEffect(() => { const m = map.current; if (!m || !markers.current) return;
    markers.current.clearLayers(); routeLine.current.clearLayers();
    const shown = dayMode === "active" ? route : pins;
    const pts = [];
    shown.forEach((p, i) => {
      if (p.latitude == null) return;
      const isRouted = dayMode === "active";
      const isCur = isRouted && i === stopIdx;
      const mk = L.circleMarker([p.latitude, p.longitude], { radius: isCur ? 12 : 9, color: "#fff", weight: 2, fillColor: isCur ? "#dc2626" : isRouted ? "#2563eb" : "#d97706", fillOpacity: 1 });
      if (isRouted) mk.bindTooltip(String(i + 1), { permanent: true, direction: "center", className: "insp-num" });
      mk.on("click", () => setSelected(p));
      mk.addTo(markers.current); pts.push([p.latitude, p.longitude]);
    });
    if (dayMode === "active" && route.length > 1) L.polyline(route.map((p) => [p.latitude, p.longitude]), { color: "#2563eb", weight: 3, opacity: 0.6 }).addTo(routeLine.current);
    if (pts.length && !fitted.current) { try { m.fitBounds(pts, { padding: [40, 40] }); fitted.current = true; } catch { /* ignore */ } }
  }, [pins, route, stopIdx, dayMode]);

  // Live GPS + trail
  useEffect(() => { if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition((pos) => setLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude }), () => {}, { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 });
    return () => navigator.geolocation.clearWatch(id);
  }, []);
  useEffect(() => { const m = map.current; if (!m || !loc) return;
    if (!meMarker.current) meMarker.current = L.circleMarker([loc.lat, loc.lng], { radius: 8, color: "#1d4ed8", weight: 3, fillColor: "#60a5fa", fillOpacity: 1 }).addTo(m);
    else meMarker.current.setLatLng([loc.lat, loc.lng]);
    if (dayMode === "active" && trail.current) L.circleMarker([loc.lat, loc.lng], { radius: 2.5, color: "#93c5fd", weight: 0, fillColor: "#93c5fd", fillOpacity: 0.7 }).addTo(trail.current);
  }, [loc, dayMode]);

  // Box draw → route
  useEffect(() => { const m = map.current, el = mapEl.current; if (!el || !m || !selecting) return;
    try { m.dragging.disable(); m.touchZoom.disable(); m.doubleClickZoom.disable(); m.boxZoom.disable(); } catch { /* ignore */ }
    const toLL = (x, y) => { const r = el.getBoundingClientRect(); return m.containerPointToLatLng([x - r.left, y - r.top]); };
    const draw = (b) => { selectLayer.current.clearLayers(); L.rectangle(b, { color: "#1d4ed8", weight: 2, dashArray: "6 5", fillColor: "#3b82f6", fillOpacity: 0.12, interactive: false }).addTo(selectLayer.current); };
    const begin = (x, y) => { selectStart.current = toLL(x, y); };
    const move = (x, y) => { if (!selectStart.current) return; draw(L.latLngBounds(selectStart.current, toLL(x, y))); };
    const finish = (x, y) => { if (!selectStart.current) return; const b = L.latLngBounds(selectStart.current, toLL(x, y)); selectStart.current = null; finalize(b); };
    const md = (e) => begin(e.clientX, e.clientY);
    const mm = (e) => { if (selectStart.current) { e.preventDefault(); move(e.clientX, e.clientY); } };
    const mu = (e) => finish(e.clientX, e.clientY);
    const ts = (e) => { const t = e.touches[0]; if (t) begin(t.clientX, t.clientY); };
    const tm = (e) => { const t = e.touches[0]; if (t && selectStart.current) { e.preventDefault(); move(t.clientX, t.clientY); } };
    const te = (e) => { const t = e.changedTouches[0]; if (t) finish(t.clientX, t.clientY); };
    el.addEventListener("mousedown", md); el.addEventListener("mousemove", mm); el.addEventListener("mouseup", mu);
    el.addEventListener("touchstart", ts, { passive: false }); el.addEventListener("touchmove", tm, { passive: false }); el.addEventListener("touchend", te);
    return () => {
      el.removeEventListener("mousedown", md); el.removeEventListener("mousemove", mm); el.removeEventListener("mouseup", mu);
      el.removeEventListener("touchstart", ts); el.removeEventListener("touchmove", tm); el.removeEventListener("touchend", te);
      try { m.dragging.enable(); m.touchZoom.enable(); m.doubleClickZoom.enable(); m.boxZoom.enable(); } catch { /* ignore */ }
    };
  }, [selecting]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancelSelect = () => { setSelecting(false); selectStart.current = null; selectLayer.current?.clearLayers(); };
  const finalize = (b) => {
    setSelecting(false); selectLayer.current?.clearLayers();
    const inBox = pins.filter((p) => p.latitude != null && b.contains([p.latitude, p.longitude]));
    if (!inBox.length) { window.alert("No inspections in that box — draw around some pins."); return; }
    const start = loc || (me?.latitude != null ? { lat: me.latitude, lng: me.longitude } : { lat: b.getCenter().lat, lng: b.getCenter().lng });
    const ordered = orderStops(start, inBox.slice(0, 300));
    setRoute(ordered); setStopIdx(0); setDayMode("active");
    if (ordered[0]) map.current.setView([ordered[0].latitude, ordered[0].longitude], 15);
  };

  // Route-lock heartbeat — claim the routed inspections so other inspectors don't see them.
  const claim = async (ids) => { if (!ids?.length || !me?.id) return; try { await supabase.from("inspections").update({ route_claim_by: me.name, route_claim_by_jn: me.jn_id ? String(me.jn_id) : null, route_claim_at: new Date().toISOString() }).in("id", ids); } catch { /* best-effort */ } };
  const release = async (ids) => { if (!ids?.length || !me?.id) return; try { await supabase.from("inspections").update({ route_claim_by: null, route_claim_by_jn: null, route_claim_at: null }).in("id", ids); } catch { /* best-effort */ } };
  useEffect(() => { if (dayMode !== "active" || !route.length) return; const ids = route.map((p) => p.id); claim(ids); const t = setInterval(() => claim(ids), CLAIM_BEAT_MS); return () => clearInterval(t); }, [dayMode, route]); // eslint-disable-line react-hooks/exhaustive-deps

  const logVisit = async (pin, event) => {
    let dist = null; if (loc && pin.latitude != null) dist = Math.round(feetBetween(loc, { lat: pin.latitude, lng: pin.longitude }));
    try { await supabase.from("inspection_visits").insert({ inspection_id: pin.id, inspector_id: me?.id || null, inspector_name: me?.name || null, event, latitude: loc?.lat ?? null, longitude: loc?.lng ?? null, dist_ft: dist }); } catch { /* best-effort */ }
  };

  const curStop = dayMode === "active" ? route[stopIdx] : null;
  const arrive = () => { if (curStop) { logVisit(curStop, "arrived"); setSelected(curStop); } };
  const completeStop = () => {
    if (curStop) logVisit(curStop, "completed");
    setSelected(null);
    if (stopIdx + 1 < route.length) { const n = route[stopIdx + 1]; setStopIdx(stopIdx + 1); if (n) map.current.setView([n.latitude, n.longitude], 16); }
    else endDay();
  };
  const endDay = () => { const ids = route.map((p) => p.id); release(ids); setDayMode(null); setRoute([]); setStopIdx(0); trail.current?.clearLayers(); setSelected(null); try { localStorage.removeItem("ccg_inspect_route"); } catch { /* ignore */ } loadPins(); };
  // Open the inspection portal FOR THIS ROOF: carry the inspector's identity into
  // the inspector app (so they land signed-in as themselves) and deep-link straight
  // to this inspection's flow.
  const startInspection = (p) => {
    logVisit(p, "started");
    try {
      if (me?.id) localStorage.setItem("ccg_inspector_id", me.id);
      // Stash where to come back to + the live route so the inspector portal
      // can return here and advance to the next stop after finishing.
      localStorage.setItem("ccg_inspect_return", window.location.href);
      if (dayMode === "active" && route.length) {
        localStorage.setItem("ccg_inspect_route", JSON.stringify({ stops: route, stopIdx, ts: Date.now() }));
      }
    } catch { /* ignore */ }
    window.location.href = `/?mode=inspector&job=${encodeURIComponent(p.id)}&from=map`;
  };

  // "Roofs Inspected" — lazy-load this inspector's completed inspections.
  const openInspected = async () => {
    setShowInspected(true);
    if (inspected) return;
    try {
      const r = await fetch(`/.netlify/functions/inspect-pins?${qs}&done=1`);
      const j = await r.json();
      setInspected(j.ok ? (j.inspected || []) : []);
    } catch { setInspected([]); }
  };

  if (err) return <Splash msg={err} />;
  if (!me) return <Splash msg="Loading your inspection map…" plain />;
  if (!howtoDone) return <HowToGate onDone={() => { try { localStorage.setItem("ccg_inspect_howto_v1", "1"); } catch { /* ignore */ } setHowtoDone(true); }} />;

  return (
    <div style={{ position: "fixed", inset: 0, fontFamily: FONT }}>
      <style>{`.insp-num{background:transparent;border:none;box-shadow:none;color:#fff;font-weight:800;font-size:11px}`}</style>
      <div ref={mapEl} style={{ position: "absolute", inset: 0 }} />

      {/* Header */}
      <div style={{ position: "absolute", top: 10, left: 10, right: 10, zIndex: 500, display: "flex", alignItems: "center", gap: 8, pointerEvents: "none" }}>
        <div style={{ background: "#0f172a", color: "#fff", borderRadius: 12, padding: "8px 14px", fontWeight: 800, fontFamily: OSWALD, boxShadow: "0 2px 8px rgba(0,0,0,.2)" }}>🔍 {me.name}</div>
        <div style={{ background: "#fff", color: "#334155", borderRadius: 12, padding: "8px 12px", fontSize: 12.5, fontWeight: 700, boxShadow: "0 2px 8px rgba(0,0,0,.15)" }}>{dayMode === "active" ? `${stopIdx + 1} / ${route.length}` : `${pins.length} to inspect`}</div>
        <div style={{ flex: 1 }} />
        <button onClick={openInspected} style={{ pointerEvents: "auto", background: "#fff", color: "#0f172a", border: "none", borderRadius: 12, padding: "8px 12px", fontSize: 12.5, fontWeight: 800, fontFamily: OSWALD, boxShadow: "0 2px 8px rgba(0,0,0,.15)", cursor: "pointer" }}>📋 Roofs inspected</button>
      </div>

      {/* Roofs Inspected report */}
      {showInspected && (
        <div style={{ position: "absolute", inset: 0, zIndex: 700, background: "rgba(15,23,42,.5)", display: "flex", justifyContent: "center", alignItems: "flex-end" }} onClick={() => setShowInspected(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", width: "100%", maxWidth: 520, maxHeight: "86vh", borderRadius: "18px 18px 0 0", display: "flex", flexDirection: "column", boxShadow: "0 -4px 24px rgba(0,0,0,.25)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px 10px" }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 900, fontFamily: OSWALD, color: "#0f172a" }}>📋 Roofs Inspected</div>
                <div style={{ fontSize: 12.5, color: "#64748b" }}>{inspected == null ? "Loading…" : `${inspected.length} completed${me.name && me.name !== "Office" ? " by you" : ""}`}</div>
              </div>
              <button onClick={() => setShowInspected(false)} style={{ background: "none", border: "none", fontSize: 24, color: "#cbd5e1", cursor: "pointer", lineHeight: 1 }}>×</button>
            </div>
            <div style={{ overflowY: "auto", padding: "0 12px 18px" }}>
              {inspected == null ? (
                <div style={{ padding: "30px 0", textAlign: "center", color: "#94a3b8", fontWeight: 700 }}>Loading your inspections…</div>
              ) : inspected.length === 0 ? (
                <div style={{ padding: "30px 16px", textAlign: "center", color: "#64748b" }}>No completed inspections yet. Finished roofs show up here.</div>
              ) : (
                inspected.map((r) => (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 8px", borderBottom: "1px solid #eef2f7" }}>
                    <span style={{ flex: "none", fontSize: 11, fontWeight: 800, fontFamily: OSWALD, color: "#fff", background: resultColor(r.result), borderRadius: 6, padding: "3px 7px", whiteSpace: "nowrap" }}>{resultLabel(r.result)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.client_name || "Homeowner"}</div>
                      <div style={{ fontSize: 12.5, color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[r.address, r.city].filter(Boolean).join(", ")}</div>
                    </div>
                    <span style={{ flex: "none", fontSize: 12, color: "#94a3b8", fontWeight: 700 }}>{fmtDay(r.result_at || r.signed_at)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Idle: Route my day */}
      {dayMode === null && !selecting && (
        <div style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 500 }}>
          <button onClick={() => setSelecting(true)} style={btn("#2563eb", 16)}>✏️ Route my day</button>
        </div>
      )}
      {selecting && (
        <div style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 500, background: "#fff", borderRadius: 14, padding: "12px 16px", boxShadow: "0 2px 12px rgba(0,0,0,.2)", textAlign: "center" }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: "#0f172a", marginBottom: 8 }}>Draw a box around the inspections to route</div>
          <button onClick={cancelSelect} style={btn("#64748b", 14)}>Cancel</button>
        </div>
      )}

      {/* Active route panel */}
      {dayMode === "active" && curStop && (
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 500, background: "#fff", borderRadius: "18px 18px 0 0", padding: "16px 18px 22px", boxShadow: "0 -2px 16px rgba(0,0,0,.15)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#2563eb", fontFamily: OSWALD }}>STOP {stopIdx + 1} OF {route.length}</div>
            <button onClick={endDay} style={{ background: "none", border: "none", color: "#94a3b8", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>End route</button>
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, fontFamily: OSWALD, color: "#0f172a" }}>{curStop.client_name || "Homeowner"}</div>
          <div style={{ fontSize: 13.5, color: "#64748b" }}>{[curStop.address, curStop.city].filter(Boolean).join(", ")}</div>
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <a href={`https://www.google.com/maps/dir/?api=1&destination=${curStop.latitude},${curStop.longitude}`} target="_blank" rel="noreferrer" style={{ ...btnStyle("#0f172a", 15), flex: "0 0 auto", textDecoration: "none", textAlign: "center" }}>🧭 Navigate</a>
            <button onClick={arrive} style={{ ...btnStyle("#16a34a", 15), flex: 1 }}>📍 I'm here</button>
            <button onClick={completeStop} style={{ ...btnStyle("#2563eb", 15), flex: 1 }}>Next ›</button>
          </div>
        </div>
      )}

      {/* Pin card */}
      {selected && (
        <div style={{ position: "absolute", left: 12, right: 12, bottom: dayMode === "active" ? 150 : 90, zIndex: 600, background: "#fff", borderRadius: 16, padding: "16px 18px", boxShadow: "0 4px 20px rgba(0,0,0,.22)", maxWidth: 440, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 900, fontFamily: OSWALD, color: "#0f172a" }}>{selected.client_name || "Homeowner"}</div>
              <div style={{ fontSize: 13.5, color: "#64748b" }}>{[selected.address, selected.city].filter(Boolean).join(", ")}</div>
              {selected.sales_rep_name && <div style={{ fontSize: 12.5, color: "#94a3b8", marginTop: 2 }}>Signed by {selected.sales_rep_name}</div>}
              {selected.inspector_notes && (
                <div style={{ fontSize: 13, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 11px", marginTop: 8, fontWeight: 600 }}>
                  📝 {selected.inspector_notes}
                </div>
              )}
            </div>
            <button onClick={() => setSelected(null)} style={{ background: "none", border: "none", fontSize: 22, color: "#cbd5e1", cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button onClick={() => startInspection(selected)} style={{ ...btnStyle("#16a34a", 15), flex: 1 }}>🏠 Start inspection</button>
          </div>
        </div>
      )}
    </div>
  );
}

function btnStyle(bg, size) { return { background: bg, color: "#fff", border: "none", borderRadius: 12, padding: "12px 16px", fontSize: size, fontWeight: 800, fontFamily: OSWALD, cursor: "pointer" }; }
function btn(bg, size) { return { ...btnStyle(bg, size), boxShadow: "0 3px 12px rgba(0,0,0,.25)" }; }
// Roofs-inspected report helpers.
function resultLabel(r) {
  const s = (r || "").toLowerCase();
  if (s.includes("no damage")) return "No Dmg";
  if (s.includes("damage")) return "Damage";
  if (s.includes("retail")) return "Retail";
  return r ? String(r).slice(0, 12) : "Done";
}
function resultColor(r) {
  const s = (r || "").toLowerCase();
  if (s.includes("no damage")) return "#64748b";
  if (s.includes("damage")) return "#dc2626";
  if (s.includes("retail")) return "#2563eb";
  return "#0f172a";
}
function fmtDay(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }); } catch { return ""; }
}
// First-open how-to gate: the 52-sec inspection video plays, then "Continue" lets
// them onto the map. Watched-flag is set by the caller so it only shows once per
// device. Fail-open: if the video is missing or errors, never trap the inspector.
function HowToGate({ onDone }) {
  const [ready, setReady] = useState(false); // video finished (or failed) → can continue
  const url = useMemo(() => {
    try { return supabase.storage.from("harvest-training").getPublicUrl("inspection-howto/inspection-map-howto.mp4").data.publicUrl; }
    catch { return ""; }
  }, []);
  useEffect(() => { if (!url) onDone(); }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div style={{ position: "fixed", inset: 0, background: "#0b1424", fontFamily: FONT, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 18, gap: 14 }}>
      <div style={{ textAlign: "center", color: "#fff" }}>
        <div style={{ fontSize: 22, fontWeight: 900, fontFamily: OSWALD, letterSpacing: ".01em" }}>Your Inspection Map</div>
        <div style={{ fontSize: 13.5, color: "#9fb0c4", fontWeight: 700, marginTop: 4 }}>Watch this quick how-to — then you're in.</div>
      </div>
      <div style={{ position: "relative", width: "100%", maxWidth: 380, aspectRatio: "9 / 16", maxHeight: "64vh", background: "#000", borderRadius: 16, overflow: "hidden", boxShadow: "0 12px 44px rgba(0,0,0,.5)" }}>
        <video src={url} controls playsInline
          onEnded={() => setReady(true)} onError={() => setReady(true)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#000" }} />
      </div>
      <button onClick={onDone} disabled={!ready}
        style={{ width: "100%", maxWidth: 380, padding: 16, borderRadius: 12, border: "none", fontFamily: OSWALD, fontSize: 18, fontWeight: 800, letterSpacing: ".02em",
          color: "#fff", background: ready ? "#4285F4" : "#33415a", boxShadow: ready ? "0 10px 26px rgba(66,133,244,.4)" : "none", cursor: ready ? "pointer" : "default", opacity: ready ? 1 : 0.75 }}>
        {ready ? "Continue to your map →" : "▶ Finish the how-to to continue"}
      </button>
    </div>
  );
}

function Splash({ msg, plain }) {
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, background: "#f1f5f9", padding: 24 }}>
      <div style={{ maxWidth: 360, textAlign: "center", background: plain ? "transparent" : "#fff", borderRadius: 16, padding: plain ? 0 : "28px 24px", boxShadow: plain ? "none" : "0 2px 12px rgba(0,0,0,.1)", color: "#475569", fontWeight: 700 }}>
        {!plain && <div style={{ fontSize: 40, marginBottom: 10 }}>🔍</div>}
        {msg}
      </div>
    </div>
  );
}
