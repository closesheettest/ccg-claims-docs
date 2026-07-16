// Canvassing map — "Sales Rabbit"-style door-knocking tool. Lives at ?mode=canvass.
//
// Baseline: the office uploads a list of addresses (geocoded server-side into
// canvass_prospects as status 'iq'); a rep opens this on their phone, sees the
// pins colored by status, taps one, and changes its status (e.g. IQ → Appt).
// v1 just records the status on the pin — no JobNimbus write yet.
import React, { useEffect, useRef, useState, useMemo } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import { supabase } from "./lib/supabase";

// Fallback used only if the harvest_pin_types config table can't be reached.
// The live pin types (label, color, allowed outcomes, who sees them) are loaded
// from that table so the office can edit them on the admin page.
const FALLBACK_TYPES = [
  { key: "iq", label: "IQ", color: "#2563eb", outcomes: ["iq_ni", "appt"] },
  { key: "appt", label: "Appointment", color: "#16a34a", outcomes: ["no_sit_reschedule"] },
  { key: "no_sit_reschedule", label: "No sit – need to reschedule", color: "#dc2626", outcomes: ["appt", "dead"] },
  { key: "iq_ni", label: "IQ – Not Interested", color: "#f59e0b", outcomes: ["insp_sold", "dead"] },
  { key: "insp", label: "Inspection Lead", color: "#0ea5e9", outcomes: ["insp_sold", "dead"] },
  { key: "insp_sold", label: "Inspection Sold", color: "#7c3aed", outcomes: [], is_terminal: true },
  { key: "dead", label: "Dead / DNK", color: "#111827", outcomes: [], is_terminal: true },
];
const UNKNOWN_TYPE = { color: "#64748b", label: "—", outcomes: [] };

// Gold star for installs (roofs we've already put on) — a read-only reference
// layer every rep (junior + senior) sees. Distinct shape so it never reads as a
// canvassing pin.
const INSTALL_COLOR = "#ca8a04";
const STAR_ICON = L.divIcon({
  className: "harvest-install-star",
  html: `<svg width="24" height="24" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45))"><path d="M12 1.8l3 6.1 6.7 1-4.8 4.7 1.1 6.7L12 17.9 6 21l1.1-6.7L2.3 8.9l6.7-1z" fill="${INSTALL_COLOR}" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

// Straight-line distance in FEET between two {lat,lng} points (haversine).
function feetBetween(a, b) {
  if (!a || !b) return Infinity;
  const R = 20902231; // earth radius, feet
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const ARRIVE_FT = 200; // must be within this many feet of the stop to advance
// "Start my day" routes the most efficient N stops. IQ canvassing is denser work
// (30 doors); inspection go-backs cover more ground per rep (100).
const ROUTE_CAP_IQ = 30, ROUTE_CAP_INSP = 100;
const routeCap = (pins) => {
  if (!pins || !pins.length) return ROUTE_CAP_INSP;
  const iq = pins.filter((p) => p.status === "iq").length;
  return iq >= pins.length / 2 ? ROUTE_CAP_IQ : ROUTE_CAP_INSP;
};

// Colored dot as an L.Marker (divIcon) so it clusters — markerClusterGroup only
// clusters L.Marker, not L.circleMarker.
function dotIcon(color) {
  return L.divIcon({
    className: "harvest-dot",
    html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,.4)"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}
const FONT = "'Nunito', system-ui, sans-serif";

export default function CanvassMap() {
  const mapEl = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const routeLayer = useRef(null);
  const navLayer = useRef(null);   // in-app driving route to the current stop
  const fitted = useRef(false);
  const [prospects, setProspects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("all");
  const [pinTypes, setPinTypes] = useState(FALLBACK_TYPES);
  const [me, setMe] = useState(null);          // { name, level } once signed in
  const [authError, setAuthError] = useState("");
  const [apptPin, setApptPin] = useState(null); // pin being scheduled → appointment
  const [installs, setInstalls] = useState([]);        // read-only star layer (jr + sr)
  const [showInstalls, setShowInstalls] = useState(true);
  const [selectedInstall, setSelectedInstall] = useState(null);
  // "Start my day" route planner.
  const [dayMode, setDayMode] = useState(null);        // null | 'choosing' | 'active'
  const [startPt, setStartPt] = useState(null);        // {lat,lng} the route starts from
  const [route, setRoute] = useState([]);              // ordered stops (nearest-first)
  const [stopIdx, setStopIdx] = useState(0);
  const [myLoc, setMyLoc] = useState(null);            // live GPS while a route is active
  const [round, setRound] = useState(1);               // 1st round, 2nd round, …
  const [resolvedIds, setResolvedIds] = useState(() => new Set()); // pins the rep has STATUSED this session (drop from later rounds)
  const workingRef = useRef(new Set());                // the ORIGINAL round-1 routed pin ids — later rounds only recycle these, minus statused
  const arrivedRef = useRef(null);                     // { key } — already logged arrival at this stop
  const [panelPos, setPanelPos] = useState(null);      // {left,top} px if dragged, else default bottom-right
  const [ignoreDist, setIgnoreDist] = useState(false); // admin test toggle: skip the 200 ft gate
  const [capped, setCapped] = useState(false);         // more pins in view than the cap → "zoom in"
  const [showAll, setShowAll] = useState(false);       // office overview: load every pin, ignore viewport
  const showAllRef = useRef(false);                    // moveend/load read this without a stale closure
  const loadRef = useRef(null);                        // latest load() for the map moveend handler
  const moveTimer = useRef(null);                      // debounce map moves
  const [signingStop, setSigningStop] = useState(null); // pin being signed in the intake tab
  const signingStopRef = useRef(null);                 // for the cross-tab 'signed' listener
  const completeSignRef = useRef(null);                // latest completeSign() for the listeners
  const panelDrag = useRef(null);
  const watchRef = useRef(null);
  const choosingRef = useRef(false);                   // map-click reads this (avoid stale closure)
  const shownRef = useRef([]);                         // current on-screen prospects, for routing
  const startFromRef = useRef(null);
  const S = useMemo(() => Object.fromEntries(pinTypes.map((t) => [t.key, t])), [pinTypes]);
  const repName = me?.name || "";

  // "View as" — the office can preview exactly what a junior/senior rep sees.
  // effLevel is the level we're rendering as (own level, or the previewed one).
  // visKeys = the pin-type keys that level may see (null = no restriction).
  const [viewAs, setViewAs] = useState(null);          // null → office's own full view
  const effLevel = viewAs || me?.level || null;
  const seesAll = !effLevel || effLevel === "admin";
  const visKeys = useMemo(() => {
    if (seesAll) return null;
    const canSee = (t) => !((t.visible_levels) || []).length || ((t.visible_levels) || []).includes(effLevel);
    return new Set(pinTypes.filter(canSee).map((t) => t.key));
  }, [seesAll, effLevel, pinTypes]);
  const visTypes = useMemo(() => (visKeys ? pinTypes.filter((t) => visKeys.has(t.key)) : pinTypes), [visKeys, pinTypes]);
  // If we switch to a level that can't see the current filter, fall back to All.
  useEffect(() => { if (visKeys && filter !== "all" && !visKeys.has(filter)) setFilter("all"); /* eslint-disable-next-line */ }, [visKeys]);

  // Server decides which pins this rep's level may see. Reads the personal link
  // token (?rt=) or the office view-all token (?admin=).
  const auth = (() => {
    try {
      const q = new URLSearchParams(window.location.search);
      return { rt: q.get("rt") || "", admin: q.get("admin") || "" };
    } catch { return { rt: "", admin: "" }; }
  })();

  // Load pins for a viewport (bounds). Without bounds → an initial global sample
  // so the map can fit to wherever the data is; after that, moves load by view.
  async function load(bounds) {
    setLoading(true);
    try {
      let qs = auth.admin ? `admin=${encodeURIComponent(auth.admin)}` : `rt=${encodeURIComponent(auth.rt)}`;
      if (showAllRef.current) qs += "&all=1";              // office overview — every pin, no viewport
      else if (bounds) qs += `&n=${bounds.getNorth()}&s=${bounds.getSouth()}&e=${bounds.getEast()}&w=${bounds.getWest()}`;
      const r = await fetch(`/.netlify/functions/harvest-pins?${qs}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setAuthError(j.error || "Couldn't load your Harvesting Map."); setLoading(false); return []; }
      setAuthError("");
      setMe(j.rep || null);
      if (Array.isArray(j.pin_types) && j.pin_types.length) setPinTypes(j.pin_types);
      setProspects(j.pins || []);
      setInstalls(Array.isArray(j.installs) ? j.installs : []);
      setCapped(!!j.capped);
      setLoading(false);
      return j.pins || [];
    } catch (e) { setAuthError(e.message || "Network error."); }
    setLoading(false);
    return [];
  }
  loadRef.current = load;
  useEffect(() => { load(); /* initial global sample; eslint-disable-next-line */ }, []);

  // Init the Leaflet map once.
  useEffect(() => {
    if (map.current || !mapEl.current) return;
    const m = L.map(mapEl.current, { zoomControl: true }).setView([27.95, -82.46], 10); // Tampa Bay default
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap",
    }).addTo(m);
    map.current = m;
    // "Start my day": while choosing a start point, a map tap starts the route there.
    m.on("click", (e) => {
      if (choosingRef.current && startFromRef.current) startFromRef.current({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
    // Viewport loading — reload the pins in view whenever the map settles (debounced).
    m.on("moveend", () => {
      if (showAllRef.current) return; // already holding every pin — panning needs no refetch
      clearTimeout(moveTimer.current);
      moveTimer.current = setTimeout(() => { if (loadRef.current) loadRef.current(m.getBounds()); }, 350);
    });
    // Cluster group so a zoomed-out map groups nearby pins into a numbered
    // bubble; zooming in splits them back into individual pins/stars.
    layer.current = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 55,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 17,
      chunkedLoading: true,
    }).addTo(m);
    // Separate layer for the "Start my day" route line + numbered stops (on top).
    routeLayer.current = L.layerGroup().addTo(m);
    navLayer.current = L.layerGroup().addTo(m); // in-app driving route to current stop
    // Leaflet computes its size at init; inside a flex layout the container
    // may not have its final size yet, leaving the tiles rendered for a tiny
    // box. Recalc on mount AND whenever the container resizes.
    const recalc = () => m.invalidateSize();
    setTimeout(recalc, 0); setTimeout(recalc, 300);
    const ro = new ResizeObserver(recalc);
    ro.observe(mapEl.current);
    return () => ro.disconnect();
  }, []);

  const mapped = useMemo(
    () => prospects.filter((p) => p.latitude != null && p.longitude != null),
    [prospects],
  );

  // (Re)draw pins whenever the data or the filter changes.
  useEffect(() => {
    const m = map.current, lyr = layer.current;
    if (!m || !lyr) return;
    lyr.clearLayers();
    const shown = mapped.filter((p) => (filter === "all" || p.status === filter) && (!visKeys || visKeys.has(p.status)));
    shownRef.current = shown; // for "Start my day" routing (already level-filtered)
    const markers = [];
    const pts = [];
    for (const p of shown) {
      const color = (S[p.status] || UNKNOWN_TYPE).color;
      const marker = L.marker([p.latitude, p.longitude], { icon: dotIcon(color) });
      marker.on("click", () => { setSelectedInstall(null); setSelected(p); });
      markers.push(marker);
      pts.push([p.latitude, p.longitude]);
    }
    // Installs — gold stars, shown to every rep as a reference layer.
    if (showInstalls) {
      for (const it of installs) {
        if (typeof it.latitude !== "number" || typeof it.longitude !== "number") continue;
        const marker = L.marker([it.latitude, it.longitude], { icon: STAR_ICON });
        marker.on("click", () => { setSelected(null); setSelectedInstall(it); });
        markers.push(marker);
      }
    }
    lyr.addLayers(markers); // bulk add → clustered
    if (pts.length && !fitted.current) {
      m.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
      fitted.current = true;
    }
  }, [mapped, filter, installs, showInstalls, visKeys]);

  async function setStatus(p, newStatus) {
    const nowIso = new Date().toISOString();
    const entry = { at: nowIso, from: p.status, to: newStatus, by: repName || "rep" };
    const log = Array.isArray(p.status_log) ? [...p.status_log, entry] : [entry];
    const patch = { status: newStatus, status_updated_at: nowIso, status_by: repName || null, status_log: log };
    const { error } = await supabase.from("canvass_prospects").update(patch).eq("id", p.id);
    if (error) { alert(error.message); return false; }
    logActivity({ pin_id: p.id, kind: "status", from_status: p.status, to_status: newStatus });
    setResolvedIds((s) => new Set(s).add(p.id)); // statused → drops out of later rounds
    setProspects((list) => list.map((x) => (x.id === p.id ? { ...x, ...patch } : x)));
    setSelected((s) => (s && s.id === p.id ? { ...s, ...patch } : s));
    return true;
  }

  // Log a rep action (visit / status change) for reporting. Non-blocking.
  function logActivity(row) {
    try {
      supabase.from("canvass_activity")
        .insert({ rep_name: repName || null, rep_token: auth.rt || null, round, ...row })
        .then(() => {}, () => {});
    } catch { /* ignore */ }
  }

  // ── Start my day ───────────────────────────────────────────────────────
  // Order the on-screen prospect pins nearest-first from a start point (the
  // rep's location or a tapped spot), then walk them one stop at a time.
  useEffect(() => { choosingRef.current = dayMode === "choosing"; }, [dayMode]);
  useEffect(() => { signingStopRef.current = signingStop; }, [signingStop]);
  // The intake tab writes localStorage 'harvest_signed' when a signing completes.
  // That 'storage' event fires in THIS tab (a different one) → advance instantly.
  // Fallback: when the rep switches back to the map, re-check the pin in the DB.
  useEffect(() => {
    const onSigned = (stop) => completeSignRef.current && completeSignRef.current(stop);
    const onStorage = (e) => {
      if (e.key !== "harvest_signed" || !e.newValue) return;
      let sig; try { sig = JSON.parse(e.newValue); } catch { return; }
      const st = signingStopRef.current;
      if (st && sig && String(sig.id) === String(st.id)) onSigned(st);
    };
    const onFocus = async () => {
      const st = signingStopRef.current;
      if (!st) return;
      try {
        const { data } = await supabase.from("canvass_prospects").select("status").eq("id", st.id).single();
        if (data?.status === "insp_sold") onSigned(st);
      } catch { /* ignore */ }
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  // While a route is active, watch the rep's live location so "Next" only
  // unlocks once they're within ARRIVE_FT of the current stop.
  useEffect(() => {
    if (dayMode !== "active" || !navigator.geolocation) { setMyLoc(null); return; }
    const id = navigator.geolocation.watchPosition(
      (pos) => setMyLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
      () => setMyLoc(null),
      { enableHighAccuracy: true, maximumAge: 4000, timeout: 20000 },
    );
    watchRef.current = id;
    return () => { try { navigator.geolocation.clearWatch(id); } catch { /* ignore */ } };
  }, [dayMode]);

  // Log an "arrival" the first time the rep gets within range of the current stop,
  // so the report can measure time-at-spot (arrival → the outcome tap).
  useEffect(() => {
    if (dayMode !== "active" || !myLoc) return;
    const stop = route[stopIdx];
    if (!stop || typeof stop.latitude !== "number") return;
    const key = `${round}:${stopIdx}:${stop.id}`;
    if (arrivedRef.current === key) return;
    if (feetBetween(myLoc, { lat: stop.latitude, lng: stop.longitude }) <= ARRIVE_FT) {
      arrivedRef.current = key;
      logActivity({ pin_id: stop.id, kind: "arrival" });
    }
  }, [myLoc, stopIdx, dayMode, route, round]);

  // Draw the route ON the map — a line through the stops in order + numbered
  // circles (current = green, visited = grey, upcoming = white). So the rep sees
  // their whole plan here, without leaving for another map.
  useEffect(() => {
    const lyr = routeLayer.current;
    if (!lyr) return;
    lyr.clearLayers();
    navLayer.current?.clearLayers(); // clear any in-app driving route when the stop/route changes
    if (dayMode !== "active" || route.length === 0) return;
    const stopPts = route.filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number").map((p) => [p.latitude, p.longitude]);
    // Line runs FROM the chosen start point, through every stop in order.
    const linePts = startPt ? [[startPt.lat, startPt.lng], ...stopPts] : stopPts;
    if (linePts.length > 1) L.polyline(linePts, { color: "#16a34a", weight: 4, opacity: 0.7, dashArray: "6 7" }).addTo(lyr);
    if (startPt) {
      const startIcon = L.divIcon({
        className: "harvest-route-start",
        html: `<div style="width:26px;height:26px;border-radius:50%;background:#0f172a;color:#fff;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,.5)">▶</div>`,
        iconSize: [26, 26], iconAnchor: [13, 13],
      });
      L.marker([startPt.lat, startPt.lng], { icon: startIcon, zIndexOffset: 1100 }).addTo(lyr);
    }
    route.forEach((p, i) => {
      if (typeof p.latitude !== "number") return;
      const current = i === stopIdx, done = i < stopIdx;
      const bg = current ? "#16a34a" : done ? "#cbd5e1" : "#fff";
      const fg = current ? "#fff" : done ? "#64748b" : "#16a34a";
      const icon = L.divIcon({
        className: "harvest-route-stop",
        html: `<div style="width:24px;height:24px;border-radius:50%;background:${bg};color:${fg};border:2px solid #16a34a;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;box-shadow:0 1px 3px rgba(0,0,0,.4)">${i + 1}</div>`,
        iconSize: [24, 24], iconAnchor: [12, 12],
      });
      L.marker([p.latitude, p.longitude], { icon, zIndexOffset: 1000 }).on("click", () => { setSelectedInstall(null); setSelected(p); }).addTo(lyr);
    });
  }, [dayMode, route, stopIdx, startPt]);

  function buildRoute(start, pins, cap) {
    const rem = pins.filter((p) => typeof p.latitude === "number" && typeof p.longitude === "number");
    const max = cap || routeCap(rem);
    const out = [];
    let cur = start;
    // Greedy nearest-neighbour, stopping at the route cap — the most efficient N
    // stops from the start point (the rest stay visible on the map, just not routed).
    while (rem.length && out.length < max) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < rem.length; i++) {
        const dx = cur.lat - rem[i].latitude, dy = cur.lng - rem[i].longitude;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bi = i; }
      }
      const nx = rem.splice(bi, 1)[0];
      out.push(nx);
      cur = { lat: nx.latitude, lng: nx.longitude };
    }
    return out;
  }
  async function startFrom(pt) {
    // Center on the start + load that area's pins first (viewport loading), so
    // the route sees the local leads even if they weren't on screen before.
    if (map.current) map.current.setView([pt.lat, pt.lng], 15);
    const loaded = await load(map.current ? map.current.getBounds() : null);
    const pool = (loaded.length ? loaded : (shownRef.current || [])).filter((p) => (filter === "all" || p.status === filter) && typeof p.latitude === "number" && (!visKeys || visKeys.has(p.status)));
    const r = buildRoute(pt, pool);
    if (!r.length) { alert("No stops near here to route. Zoom to your area or change the filter, then start your day."); setDayMode(null); return; }
    // Round 1's stops ARE the day's working set — later rounds only recycle these.
    workingRef.current = new Set(r.map((p) => p.id));
    setStartPt(pt); setRoute(r); setStopIdx(0); setRound(1); setResolvedIds(new Set()); setDayMode("active");
    if (map.current) map.current.setView([r[0].latitude, r[0].longitude], 15);
  }
  // Of the original routed pins, how many are still un-statused (i.e. left to work).
  function remainingCount() {
    return [...workingRef.current].filter((id) => !resolvedIds.has(id)).length;
  }
  // Next round: re-route the ORIGINAL routed pins that haven't been statused yet,
  // from where the rep is now. 30 → (minus statused) 25 → … until all are statused.
  function nextRound() {
    const left = (shownRef.current || []).filter((p) => workingRef.current.has(p.id) && !resolvedIds.has(p.id) && typeof p.latitude === "number");
    if (!left.length) return; // all statused — the done panel shows "all worked"
    const from = myLoc || (route.length ? { lat: route[route.length - 1].latitude, lng: route[route.length - 1].longitude } : startPt);
    const r = buildRoute(from, left, routeCap(left));
    setStartPt(from); setRoute(r); setStopIdx(0); setRound((n) => n + 1); setDayMode("active");
    if (map.current) map.current.setView([r[0].latitude, r[0].longitude], 15);
  }
  startFromRef.current = startFrom;
  function useMyLocation() {
    if (!navigator.geolocation) { alert("Location isn't available on this device — tap the map to pick a start point."); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => startFrom({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => alert("Couldn't get your location. Allow location access, or tap the map to pick a start point."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }
  function advanceStop() {
    setStopIdx((i) => {
      const ni = i + 1;
      if (ni < route.length && map.current) map.current.setView([route[ni].latitude, route[ni].longitude], 15);
      return ni;
    });
  }
  // Work the current stop right from the panel: log the visit, apply the outcome
  // (status / not-home / book appt), then move to the next stop — no window to close.
  async function workStop(outcome) {
    const stop = route[stopIdx];
    if (!stop) return;
    // Real leads: "Appt" opens the booking flow (creates the JobNimbus appt).
    // Test pins have no real homeowner/job, so their "Appt" just sets the status.
    if (outcome === "appt" && stop.status !== "test") { setApptPin(stop); return; }
    logActivity({ pin_id: stop.id, kind: "visit", to_status: outcome === "nothome" ? "not_home" : outcome });
    if (outcome !== "nothome") {
      const ok = await setStatus(stop, outcome);
      if (ok === false) return; // save failed — stay put
    }
    advanceStop();
  }
  // "Sign Inspection" — open the Free Roof Inspection intake prefilled with what we
  // know about this pin (name/phone/address/city/state/zip/email), tagged with the
  // pin id. When the rep finishes signing there, the intake marks this pin sold and
  // pings us to advance (see the storage/focus listeners below). City/State/ZIP are
  // passed too so the intake never re-runs the address lookup on a known address.
  function signInspection(stop) {
    if (!stop) return;
    const p = new URLSearchParams({ intake: "1", harvest_pin: String(stop.id) });
    if (stop.name) p.set("name", stop.name);
    if (stop.phone) p.set("phone", stop.phone);
    if (stop.address) p.set("address", stop.address);
    if (stop.city) p.set("city", stop.city);
    if (stop.state) p.set("state", stop.state);
    if (stop.zip) p.set("zip", stop.zip);
    if (stop.email) p.set("email", stop.email);
    // Carry the rep so the intake doesn't re-ask (only when signed in as a real rep).
    if (me?.jn_id || me?.email) {
      p.set("rep", me.jn_id || "");
      p.set("repName", me.name || "");
      p.set("repEmail", me.email || "");
    }
    setSigningStop(stop);
    window.open(`/?${p.toString()}`, "_blank", "noopener");
  }
  // The intake signed this pin (cross-tab signal or focus re-check): reflect it here
  // — mark sold locally, drop it from later rounds, and advance to the next stop.
  function completeSign(stop) {
    if (!stop) return;
    setResolvedIds((s) => new Set(s).add(stop.id));
    setProspects((list) => list.map((x) => (x.id === stop.id ? { ...x, status: "insp_sold" } : x)));
    setSigningStop(null);
    // Only advance the route if this pin is the stop we're currently on.
    if (route[stopIdx] && route[stopIdx].id === stop.id) advanceStop();
  }
  completeSignRef.current = completeSign;
  function startOver() { navLayer.current?.clearLayers(); setDayMode(null); setStartPt(null); setRoute([]); setStopIdx(0); setRound(1); setResolvedIds(new Set()); workingRef.current = new Set(); setPanelPos(null); setSigningStop(null); }
  // Drag the route panel so it never blocks the map (pointer events = mouse + touch).
  function panelPointerDown(e) {
    const el = e.currentTarget.closest("[data-daypanel]"); if (!el) return;
    const rect = el.getBoundingClientRect();
    const parent = (el.offsetParent || el.parentElement).getBoundingClientRect();
    panelDrag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, parent, w: rect.width, h: rect.height };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  }
  function panelPointerMove(e) {
    const d = panelDrag.current; if (!d) return;
    const left = Math.max(4, Math.min(d.parent.width - d.w - 4, e.clientX - d.parent.left - d.dx));
    const top = Math.max(4, Math.min(d.parent.height - d.h - 4, e.clientY - d.parent.top - d.dy));
    setPanelPos({ left, top });
  }
  function panelPointerUp(e) { panelDrag.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ } }
  const addrOf = (p) => encodeURIComponent([p.address, p.city, p.state, p.zip].filter(Boolean).join(", ") || `${p.latitude},${p.longitude}`);
  // In-app directions: draw the driving route from the rep's location to the stop
  // ON our map (road-following via OSRM, best-effort; straight line if it's slow/
  // down). Keeps the rep in the app for the short canvass hops.
  async function navRoute(stop) {
    const from = myLoc || startPt;
    const lyr = navLayer.current, m = map.current;
    if (lyr) lyr.clearLayers();
    if (!from || !m) { if (m) m.setView([stop.latitude, stop.longitude], 16); return; }
    const straight = [[from.lat, from.lng], [stop.latitude, stop.longitude]];
    if (lyr) L.polyline(straight, { color: "#1d4ed8", weight: 5, opacity: 0.85 }).addTo(lyr);
    m.fitBounds(straight, { padding: [55, 55], maxZoom: 17 });
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${stop.longitude},${stop.latitude}?overview=full&geometries=geojson`;
      const j = await (await fetch(url)).json();
      const g = j.routes?.[0]?.geometry?.coordinates;
      if (g && g.length && lyr) {
        const latlngs = g.map(([lng, lat]) => [lat, lng]);
        lyr.clearLayers();
        L.polyline(latlngs, { color: "#1d4ed8", weight: 5, opacity: 0.9 }).addTo(lyr);
        m.fitBounds(latlngs, { padding: [55, 55], maxZoom: 17 });
      }
    } catch { /* keep the straight line */ }
  }

  const counts = useMemo(() => {
    const c = {};
    for (const p of prospects) c[p.status] = (c[p.status] || 0) + 1;
    return c;
  }, [prospects]);
  const notMapped = prospects.length - mapped.length;

  // Bad/missing link → don't show any pins, just tell them what to do.
  if (authError) {
    return (
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT, background: "#f1f5f9", padding: 24 }}>
        <div style={{ maxWidth: 360, textAlign: "center", background: "#fff", borderRadius: 16, padding: "28px 24px", boxShadow: "0 2px 12px rgba(0,0,0,.1)" }}>
          <div style={{ fontSize: 40, marginBottom: 10 }}>🔒</div>
          <div style={{ fontSize: 17, fontWeight: 800, fontFamily: "'Oswald', sans-serif", marginBottom: 8 }}>Harvesting Map</div>
          <div style={{ fontSize: 14, color: "#475569", lineHeight: 1.5 }}>{authError}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column", fontFamily: FONT, background: "#f1f5f9" }}>
      {/* Header */}
      <div style={{ padding: "10px 14px", background: "#0f172a", color: "#fff", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 800, fontSize: 16, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.02em" }}>🌾 Harvesting Map</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>{mapped.length} pins</div>
        {me?.level === "admin" && (
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <a href="/?mode=harvestupload" style={{ color: "#cbd5e1", fontSize: 12.5, fontWeight: 700, textDecoration: "none" }}>📥 Load Leads</a>
            <a href="/?mode=harvestlinks" style={{ color: "#cbd5e1", fontSize: 12.5, fontWeight: 700, textDecoration: "none" }}>🔗 Rep Links</a>
            <a href="/?mode=harvestadmin" style={{ color: "#cbd5e1", fontSize: 12.5, fontWeight: 700, textDecoration: "none" }}>🎛️ Pin Types</a>
          </div>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {me?.level === "admin" && (
            <div style={{ display: "flex", alignItems: "center", gap: 4, background: "rgba(255,255,255,.08)", borderRadius: 999, padding: 2 }}
              title="Preview exactly what a rep at this level sees on the map">
              <span style={{ fontSize: 10, fontWeight: 800, color: "#94a3b8", padding: "0 4px", textTransform: "uppercase", letterSpacing: "0.04em" }}>View as</span>
              {[["admin", "Office"], ["senior", "Sr"], ["junior", "Jr"]].map(([lv, lbl]) => {
                const on = (viewAs || "admin") === lv;
                return (
                  <button key={lv} type="button" onClick={() => setViewAs(lv === "admin" ? null : lv)}
                    style={{ fontSize: 11, fontWeight: 800, cursor: "pointer", borderRadius: 999, padding: "3px 9px", border: "none", background: on ? "#7c3aed" : "transparent", color: on ? "#fff" : "#cbd5e1" }}>{lbl}</button>
                );
              })}
            </div>
          )}
          {me?.level === "admin" && (
            <button type="button"
              onClick={() => {
                const next = !showAll;
                setShowAll(next); showAllRef.current = next;
                fitted.current = false;                        // re-fit to whatever we load
                load(next ? null : (map.current ? map.current.getBounds() : null));
              }}
              title="Load every pin at once (whole-state overview). Off = load by map area for speed at scale."
              style={{ fontSize: 11, fontWeight: 800, cursor: "pointer", borderRadius: 999, padding: "3px 10px", border: "1px solid", borderColor: showAll ? "#16a34a" : "#475569", background: showAll ? "#16a34a" : "transparent", color: showAll ? "#fff" : "#cbd5e1" }}>
              🗺️ {showAll ? "Showing all" : "Show all"}
            </button>
          )}
          {me?.level === "admin" && (
            <button type="button" onClick={() => setIgnoreDist((v) => !v)}
              title="Test mode: let the outcome buttons work without being within 200 ft of the pin"
              style={{ fontSize: 11, fontWeight: 800, cursor: "pointer", borderRadius: 999, padding: "3px 10px", border: "1px solid", borderColor: ignoreDist ? "#f59e0b" : "#475569", background: ignoreDist ? "#f59e0b" : "transparent", color: ignoreDist ? "#111827" : "#cbd5e1" }}>
              🧪 Distance {ignoreDist ? "OFF" : "ON"}
            </button>
          )}
          {me ? (
            <span style={{ fontSize: 12.5, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
              {me.name}
              <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", background: me.level === "senior" ? "#16a34a" : me.level === "admin" ? "#7c3aed" : "#334155", padding: "2px 8px", borderRadius: 10 }}>{me.level}</span>
            </span>
          ) : null}
        </div>
      </div>

      {/* Status filter chips */}
      <div style={{ display: "flex", gap: 6, overflowX: "auto", padding: "8px 12px", background: "#fff", borderBottom: "1px solid #e5e7eb" }}>
        <Chip active={filter === "all"} onClick={() => setFilter("all")} color="#334155" label={`All (${visKeys ? prospects.filter((p) => visKeys.has(p.status)).length : prospects.length})`} />
        {visTypes.map((s) => (
          <Chip key={s.key} active={filter === s.key} onClick={() => setFilter(s.key)} color={s.color} label={`${s.label} (${counts[s.key] || 0})`} />
        ))}
        {installs.length > 0 && (
          <Chip active={showInstalls} onClick={() => setShowInstalls((v) => !v)} color={INSTALL_COLOR} label={`⭐ Installs (${installs.length})`} />
        )}
      </div>

      {/* Map */}
      <div style={{ position: "relative", flex: 1 }}>
        <div ref={mapEl} style={{ position: "absolute", inset: 0 }} />
        {loading && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", background: "#fff", padding: "6px 14px", borderRadius: 20, fontSize: 13, boxShadow: "0 2px 8px rgba(0,0,0,.15)", zIndex: 500 }}>Loading pins…</div>
        )}
        {!loading && prospects.length === 0 && (
          <div style={{ position: "absolute", top: 20, left: "50%", transform: "translateX(-50%)", background: "#fff", padding: "14px 18px", borderRadius: 12, fontSize: 13.5, color: "#475569", boxShadow: "0 2px 10px rgba(0,0,0,.12)", zIndex: 500, textAlign: "center", maxWidth: 320 }}>
            No pins in your area yet. The office loads leads from the admin section.
          </div>
        )}
        {!loading && capped && dayMode === null && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", background: "#fffbeb", border: "1px solid #fcd34d", color: "#92400e", padding: "6px 14px", borderRadius: 20, fontSize: 12.5, fontWeight: 700, boxShadow: "0 2px 8px rgba(0,0,0,.12)", zIndex: 500, whiteSpace: "nowrap" }}>Showing the densest area — zoom in to see every pin</div>
        )}

        {/* ── Start my day ── */}
        {dayMode === null && prospects.length > 0 && (
          <button type="button" onClick={() => setDayMode("choosing")}
            style={{ position: "absolute", left: 12, bottom: 16, zIndex: 600, background: "#16a34a", color: "#fff", border: "none", borderRadius: 999, padding: "13px 20px", fontSize: 15, fontWeight: 800, fontFamily: "'Oswald', sans-serif", boxShadow: "0 3px 12px rgba(0,0,0,.25)", cursor: "pointer" }}>
            ▶ Start my day
          </button>
        )}

        {dayMode === "choosing" && (
          <div style={{ position: "absolute", right: 10, bottom: 14, zIndex: 600, background: "#fff", borderRadius: 14, padding: "16px 18px", boxShadow: "0 4px 18px rgba(0,0,0,.2)", width: "min(340px, 88%)", textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Oswald', sans-serif", color: "#0f172a", marginBottom: 6 }}>Where are you starting?</div>
            <div style={{ fontSize: 13, color: "#64748b", marginBottom: 14 }}>Start from your location, or <b>tap anywhere on the map</b> to start there. We'll route your stops nearest-first.</div>
            <button type="button" onClick={useMyLocation}
              style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 12, padding: "13px", fontSize: 15, fontWeight: 800, cursor: "pointer", marginBottom: 8 }}>
              📍 Start from my location
            </button>
            <button type="button" onClick={() => setDayMode(null)}
              style={{ width: "100%", background: "#fff", color: "#64748b", border: "1px solid #e5e7eb", borderRadius: 12, padding: "11px", fontSize: 13.5, fontWeight: 700, cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        )}

        {dayMode === "active" && (() => {
          const done = stopIdx >= route.length;
          const stop = done ? null : route[stopIdx];
          const posStyle = panelPos
            ? { left: panelPos.left, top: panelPos.top }
            : { right: 10, bottom: 14 };
          const left = done ? remainingCount() : 0;
          const leftPins = done ? (shownRef.current || []).filter((p) => workingRef.current.has(p.id) && !resolvedIds.has(p.id)) : [];
          return (
            <div data-daypanel style={{ position: "absolute", ...posStyle, zIndex: 600, background: "#fff", borderRadius: 14, boxShadow: "0 4px 18px rgba(0,0,0,.2)", width: "min(340px, 88%)", overflow: "hidden" }}>
              {/* Drag handle so it never blocks the map */}
              <div onPointerDown={panelPointerDown} onPointerMove={panelPointerMove} onPointerUp={panelPointerUp}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "5px 0 3px", cursor: "grab", touchAction: "none", color: "#cbd5e1", fontSize: 13, letterSpacing: 2, userSelect: "none" }}>
                ⠿ <span style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.03em" }}>drag</span>
              </div>
              <div style={{ padding: "4px 16px 14px" }}>
              {done ? (
                <div style={{ textAlign: "center" }}>
                  {left > 0 ? (
                    <>
                      <div style={{ fontSize: 26 }}>✅</div>
                      <div style={{ fontSize: 15.5, fontWeight: 800, fontFamily: "'Oswald', sans-serif", margin: "4px 0 4px" }}>Round {round} done!</div>
                      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}><b>{left}</b> pin{left === 1 ? "" : "s"} left to work.</div>
                      <button type="button" onClick={nextRound} style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 12, padding: "12px", fontSize: 14.5, fontWeight: 800, cursor: "pointer", marginBottom: 8 }}>
                        ▶ Start round {round + 1} — next {Math.min(routeCap(leftPins), left)}
                      </button>
                      <button type="button" onClick={startOver} style={{ width: "100%", background: "#fff", color: "#64748b", border: "1px solid #e5e7eb", borderRadius: 12, padding: "10px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Finish for the day</button>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: 30 }}>🎉</div>
                      <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Oswald', sans-serif", margin: "4px 0 10px" }}>Every pin worked — nice work!</div>
                      <button type="button" onClick={startOver} style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 12, padding: "12px", fontSize: 14.5, fontWeight: 800, cursor: "pointer" }}>▶ Start a new route</button>
                    </>
                  )}
                </div>
              ) : (() => {
                const distFt = myLoc ? feetBetween(myLoc, { lat: stop.latitude, lng: stop.longitude }) : null;
                const near = ignoreDist || (distFt != null && distFt <= ARRIVE_FT);
                const outs = ((S[stop.status]?.outcomes) || []).map((k) => S[k]).filter(Boolean);
                const oBtn = (key, label, color) => (
                  <button key={key} type="button" disabled={!near} onClick={() => workStop(key)}
                    style={{ flex: "1 1 44%", minWidth: 92, padding: "11px 8px", borderRadius: 11, fontSize: 13.5, fontWeight: 800, cursor: near ? "pointer" : "not-allowed",
                      border: `1px solid ${near ? color : "#e5e7eb"}`, background: near ? color : "#fff", color: near ? "#fff" : "#cbd5e1" }}>
                    {label}
                  </button>
                );
                return (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.05em", color: "#16a34a" }}>{round > 1 ? `Round ${round} · ` : ""}Stop {stopIdx + 1} of {route.length}</span>
                    <button type="button" onClick={startOver} style={{ background: "none", border: "none", fontSize: 12.5, fontWeight: 700, color: "#94a3b8", cursor: "pointer" }}>↺ Start over</button>
                  </div>
                  {stop.name && <div style={{ fontSize: 15.5, fontWeight: 800 }}>{stop.name}</div>}
                  <div style={{ fontSize: 13.5, color: "#334155", fontWeight: 600 }}>{stop.address}</div>
                  <div style={{ fontSize: 12.5, color: "#64748b" }}>{[stop.city, stop.state, stop.zip].filter(Boolean).join(", ")}</div>
                  <button type="button" onClick={() => navRoute(stop)}
                    style={{ width: "100%", marginTop: 12, background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 12, padding: "12px", fontSize: 14.5, fontWeight: 800, cursor: "pointer" }}>
                    🧭 Directions to {stopIdx === 0 ? "first stop" : "this stop"}
                  </button>
                  <div style={{ textAlign: "center", marginTop: 5 }}>
                    <a href={`https://www.google.com/maps/dir/?api=1&destination=${addrOf(stop)}`} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, fontWeight: 700, color: "#94a3b8", textDecoration: "none" }}>open in Google Maps ↗</a>
                  </div>
                  {signingStop && signingStop.id === stop.id ? (
                    <div style={{ marginTop: 14, background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 12, padding: "12px 14px", textAlign: "center" }}>
                      <div style={{ fontSize: 13.5, fontWeight: 800, color: "#7c3aed" }}>🖊️ Signing {stop.name || "this homeowner"}…</div>
                      <div style={{ fontSize: 12, color: "#7c3aed", opacity: 0.85, margin: "4px 0 10px" }}>Finish in the intake tab. This stop marks <b>Inspection Sold</b> and moves to the next automatically once they sign.</div>
                      <button type="button" onClick={() => completeSign(stop)} style={{ width: "100%", background: "#16a34a", color: "#fff", border: "none", borderRadius: 11, padding: "11px", fontSize: 13.5, fontWeight: 800, cursor: "pointer", marginBottom: 6 }}>✅ They signed — next stop</button>
                      <button type="button" onClick={() => setSigningStop(null)} style={{ width: "100%", background: "#fff", color: "#64748b", border: "1px solid #e5e7eb", borderRadius: 11, padding: "9px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>← Back (didn't sign)</button>
                    </div>
                  ) : (<>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.04em", margin: "13px 0 6px" }}>How'd it go?</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                    {outs.map((o) => o.key === "insp_sold"
                      ? (
                        <button key={o.key} type="button" disabled={!near} onClick={() => signInspection(stop)}
                          style={{ flex: "1 1 44%", minWidth: 92, padding: "11px 8px", borderRadius: 11, fontSize: 13.5, fontWeight: 800, cursor: near ? "pointer" : "not-allowed",
                            border: `1px solid ${near ? "#7c3aed" : "#e5e7eb"}`, background: near ? "#7c3aed" : "#fff", color: near ? "#fff" : "#cbd5e1" }}>
                          🖊️ Sign Inspection
                        </button>
                      )
                      : oBtn(o.key, o.label, o.color))}
                    {oBtn("nothome", "🏠 Not home", "#475569")}
                  </div>
                  <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, textAlign: "center", color: near ? "#16a34a" : "#b45309" }}>
                    {ignoreDist
                      ? "🧪 Distance gate OFF (test) — pick what happened"
                      : distFt == null
                        ? "📍 Finding your location… (allow location access to log a stop)"
                        : near
                          ? "✓ You're here — pick what happened and it moves to the next stop"
                          : `~${Math.round(distFt).toLocaleString()} ft away — get within ${ARRIVE_FT} ft to log this stop`}
                  </div>
                  </>)}
                </>
                );
              })()}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Selected prospect sheet */}
      {selected && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, boxShadow: "0 -4px 20px rgba(0,0,0,.18)", padding: "16px 18px 22px", zIndex: 1000, maxHeight: "62vh", overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <div style={{ flex: 1 }}>
              {selected.name && <div style={{ fontWeight: 800, fontSize: 16 }}>{selected.name}</div>}
              <div style={{ fontSize: 14, color: "#334155", fontWeight: 600 }}>{selected.address}</div>
              <div style={{ fontSize: 13, color: "#64748b" }}>{[selected.city, selected.state, selected.zip].filter(Boolean).join(", ")}</div>
              <div style={{ marginTop: 6, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 700 }}>
                <span style={{ width: 10, height: 10, borderRadius: 5, background: (S[selected.status] || UNKNOWN_TYPE).color, display: "inline-block" }} />
                {(S[selected.status] || UNKNOWN_TYPE).label}
                {selected.status_by ? <span style={{ color: "#94a3b8", fontWeight: 600 }}> · by {selected.status_by}</span> : null}
              </div>
            </div>
            <button type="button" onClick={() => setSelected(null)} style={{ background: "none", border: "none", fontSize: 22, color: "#94a3b8", cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>

          {/* All the info we have on this pin */}
          {(() => {
            const rows = [];
            if (selected.phone) rows.push(["Phone", selected.phone]);
            if (selected.email) rows.push(["Email", selected.email]);
            if (selected.extra && typeof selected.extra === "object") {
              for (const [k, v] of Object.entries(selected.extra)) if (v != null && String(v).trim()) rows.push([k, String(v)]);
            }
            if (selected.list_name) rows.push(["List", selected.list_name]);
            if (selected.status_updated_at) rows.push(["Updated", new Date(selected.status_updated_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })]);
            if (selected.notes) rows.push(["Notes", selected.notes]);
            if (!rows.length) return null;
            return (
              <div style={{ marginTop: 12, borderTop: "1px solid #f1f5f9", paddingTop: 10, display: "grid", gap: 4 }}>
                {rows.map(([k, v], i) => (
                  <div key={k + i} style={{ display: "flex", gap: 8, fontSize: 12.5 }}>
                    <span style={{ color: "#94a3b8", fontWeight: 700, minWidth: 96, textTransform: "capitalize", flexShrink: 0 }}>{k}</span>
                    <span style={{ color: "#334155", fontWeight: 600, wordBreak: "break-word" }}>{v}</span>
                  </div>
                ))}
              </div>
            );
          })()}

          {(() => {
            // Behavior flow: offer only the outcomes this pin type allows. If the
            // type defines none (terminal, or unconfigured), fall back to every
            // type so a mis-set pin can still be corrected.
            const cur = S[selected.status];
            const allowed = (cur?.outcomes || []).map((k) => S[k]).filter(Boolean);
            const options = allowed.length ? allowed : pinTypes;
            return (
              <>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#64748b", margin: "14px 0 8px" }}>
                  {allowed.length ? "Outcome" : "Set status"}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {options.map((s) => {
                    const on = selected.status === s.key;
                    return (
                      <button key={s.key} type="button"
                        onClick={() => s.key === "appt" ? setApptPin(selected) : s.key === "insp_sold" ? signInspection(selected) : setStatus(selected, s.key)}
                        style={{ padding: "9px 14px", borderRadius: 10, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
                          border: on ? `2px solid ${s.color}` : "1px solid #e5e7eb",
                          background: on ? s.color : "#fff", color: on ? "#fff" : "#334155" }}>
                        {s.key === "insp_sold" && !on ? "🖊️ Sign Inspection" : s.label}
                      </button>
                    );
                  })}
                </div>
              </>
            );
          })()}

          <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([selected.address, selected.city, selected.state, selected.zip].filter(Boolean).join(", "))}`}
            target="_blank" rel="noreferrer"
            style={{ display: "block", textAlign: "center", marginTop: 16, padding: "12px", borderRadius: 12, background: "#1d4ed8", color: "#fff", fontWeight: 700, fontSize: 14, textDecoration: "none" }}>
            🧭 Navigate to this address
          </a>
        </div>
      )}

      {apptPin && (
        <AppointmentModal
          pin={apptPin} rt={auth.rt}
          onClose={() => setApptPin(null)}
          onBooked={(patch) => {
            setProspects((list) => list.map((x) => (x.id === apptPin.id ? { ...x, ...patch } : x)));
            setSelected((s) => (s && s.id === apptPin.id ? { ...s, ...patch } : s));
            setResolvedIds((s) => new Set(s).add(apptPin.id)); // booked → statused → drops from later rounds
            // If this was the current route stop, log the visit + move on.
            if (dayMode === "active" && route[stopIdx] && route[stopIdx].id === apptPin.id) {
              logActivity({ pin_id: apptPin.id, kind: "visit", to_status: "appt" });
              advanceStop();
            }
            setApptPin(null);
          }}
        />
      )}

      {/* Selected install sheet — read-only (installs aren't canvassing pins). */}
      {selectedInstall && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, background: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, boxShadow: "0 -4px 20px rgba(0,0,0,.18)", padding: "16px 18px 22px", zIndex: 1000, maxHeight: "50vh", overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", color: INSTALL_COLOR }}>⭐ Install</div>
              <div style={{ fontSize: 15, color: "#334155", fontWeight: 700, marginTop: 3 }}>{selectedInstall.address_line}</div>
              <div style={{ fontSize: 13, color: "#64748b" }}>{selectedInstall.city}</div>
              {(selectedInstall.product_type || selectedInstall.color) && (
                <div style={{ fontSize: 13, color: "#475569", marginTop: 6 }}>
                  {[selectedInstall.product_type, selectedInstall.color].filter(Boolean).join(" · ")}
                </div>
              )}
            </div>
            <button type="button" onClick={() => setSelectedInstall(null)} style={{ background: "none", border: "none", fontSize: 22, color: "#94a3b8", cursor: "pointer", lineHeight: 1 }}>×</button>
          </div>
          <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([selectedInstall.address_line, selectedInstall.city].filter(Boolean).join(", "))}`}
            target="_blank" rel="noreferrer"
            style={{ display: "block", textAlign: "center", marginTop: 14, padding: "12px", borderRadius: 12, background: "#1d4ed8", color: "#fff", fontWeight: 700, fontSize: 14, textDecoration: "none" }}>
            🧭 Navigate to this address
          </a>
        </div>
      )}
    </div>
  );
}

function Chip({ active, onClick, color, label }) {
  return (
    <button type="button" onClick={onClick}
      style={{ whiteSpace: "nowrap", padding: "6px 12px", borderRadius: 20, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
        border: active ? `2px solid ${color}` : "1px solid #e5e7eb",
        background: active ? color : "#fff", color: active ? "#fff" : "#475569" }}>
      {label}
    </button>
  );
}

// Fixed appointment windows: Mon–Thu 11/2/5/7, Fri 9/12/3, Sat 9/12 (day-of-week
// 1–4 / 5 / 6). Built in the rep's local time (reps are in ET).
const APPT_HOURS = { 1: [11, 14, 17, 19], 2: [11, 14, 17, 19], 3: [11, 14, 17, 19], 4: [11, 14, 17, 19], 5: [9, 12, 15], 6: [9, 12] };
function genSlots(days = 14) {
  const out = []; const b = new Date();
  // Start at d=1 (tomorrow) — no same-day appointments.
  for (let d = 1; d <= days; d++) {
    const day = new Date(b.getFullYear(), b.getMonth(), b.getDate() + d);
    for (const h of (APPT_HOURS[day.getDay()] || [])) {
      out.push({ iso: new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0).toISOString(), dt: new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0) });
    }
  }
  return out;
}
const dayKey = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const hourLabel = (d) => d.toLocaleTimeString("en-US", { hour: "numeric" });

const slotKey = (d) => `${d.toDateString()}-${d.getHours()}`;

// Pull a phone/email out of the pin's CSV "extra" columns if present.
const extraVal = (pin, names) => {
  const e = pin.extra || {};
  for (const k of Object.keys(e)) if (names.some((n) => k.toLowerCase().includes(n)) && e[k]) return String(e[k]);
  return "";
};

function AppointmentModal({ pin, rt, onClose, onBooked }) {
  const [phone, setPhone] = useState(pin.phone || extraVal(pin, ["phone", "mobile", "cell"]));
  const [email, setEmail] = useState(pin.email || extraVal(pin, ["email", "e-mail"]));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [booked, setBooked] = useState(null); // null = still checking JN

  // Pull the rep's already-booked appointments so we only offer free times.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch(`/.netlify/functions/harvest-availability?rt=${encodeURIComponent(rt)}`);
        const j = await r.json().catch(() => ({}));
        if (live) setBooked(Array.isArray(j.booked) ? j.booked : []);
      } catch { if (live) setBooked([]); }
    })();
    return () => { live = false; };
  }, [rt]);

  const bookedKeys = useMemo(() => new Set((booked || []).map((ms) => slotKey(new Date(ms)))), [booked]);
  const slots = useMemo(() => genSlots(14).filter((s) => !bookedKeys.has(slotKey(s.dt))), [bookedKeys]);
  const byDay = {};
  for (const s of slots) (byDay[dayKey(s.dt)] = byDay[dayKey(s.dt)] || []).push(s);

  async function book(slot) {
    if (phone.replace(/\D/g, "").length < 10) { setErr("Enter the homeowner's phone number first."); return; }
    setBusy(slot.iso); setErr("");
    try {
      const r = await fetch("/.netlify/functions/harvest-book-appt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rt, pin_id: pin.id, appt_iso: slot.iso, phone, email }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setErr(j.error || "Couldn't book — try again."); setBusy(false); return; }
      onBooked({ status: "appt", jn_job_id: j.job_id, status_updated_at: new Date().toISOString() });
    } catch (e) { setErr(e.message || "Network error"); setBusy(false); }
  }

  return (
    <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,.55)", zIndex: 3000, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={() => !busy && onClose()}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", width: "100%", maxWidth: 520, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: "16px 18px 22px", maxHeight: "88vh", overflowY: "auto", fontFamily: FONT }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontSize: 16, fontWeight: 800, fontFamily: "'Oswald', sans-serif", color: "#166534" }}>📅 Schedule appointment</div>
          <button type="button" onClick={() => !busy && onClose()} style={{ marginLeft: "auto", background: "none", border: "none", fontSize: 22, color: "#94a3b8", cursor: "pointer" }}>×</button>
        </div>
        <div style={{ fontSize: 13, color: "#475569", fontWeight: 600, marginBottom: 12 }}>{pin.address}{pin.city ? `, ${pin.city}` : ""}</div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (required)" inputMode="tel"
            style={{ flex: 1, minWidth: 150, fontSize: 14, padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1", boxSizing: "border-box" }} />
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" inputMode="email"
            style={{ flex: 1, minWidth: 150, fontSize: 14, padding: "10px 12px", borderRadius: 10, border: "1px solid #cbd5e1", boxSizing: "border-box" }} />
        </div>
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>Pick a time — it books the appointment into JobNimbus and turns this pin into an Appointment. Times you're already booked are hidden.</div>
        {err && <div style={{ color: "#b91c1c", fontSize: 13, marginBottom: 10 }}>{err}</div>}

        {booked === null ? <div style={{ fontSize: 13, color: "#6b7280", padding: "8px 0" }}>Checking your calendar…</div>
          : !slots.length ? <div style={{ fontSize: 13, color: "#6b7280", padding: "8px 0" }}>No open times in the next 2 weeks.</div>
          : (
        <div style={{ maxHeight: "48vh", overflowY: "auto" }}>
          {Object.keys(byDay).map((k) => (
            <div key={k} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, color: "#374151", marginBottom: 6 }}>{k}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {byDay[k].map((s) => (
                  <button key={s.iso} type="button" disabled={!!busy} onClick={() => book(s)}
                    style={{ border: "1px solid #16a34a", color: "#16a34a", background: "#fff", borderRadius: 12, padding: "9px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: busy ? 0.5 : 1 }}>
                    {busy === s.iso ? "…" : hourLabel(s.dt)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        )}
      </div>
    </div>
  );
}
